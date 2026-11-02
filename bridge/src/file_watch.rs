//! Bounded inotify watching for one directory inside the configured root.
//!
//! The watch target is a pinned directory descriptor, addressed through the
//! trusted procfs descriptor directory, so the inode that is watched is the one
//! this bridge opened rather than a path a local writer could swap underneath us.
//! Events are hints only: every consumer must resynchronize content, because
//! events can be dropped, coalesced or overflow the kernel queue.

use crate::file_root::FileRoot;
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;

/// Cap on how long one watch stream may stay open.
pub(crate) const MAX_WATCH_SECONDS: u64 = 600;
const MAX_NAMES: usize = 16;

pub(crate) struct WatchBatch {
    /// The kernel queue overflowed; the consumer must perform a full resync.
    pub(crate) overflow: bool,
    pub(crate) names: Vec<String>,
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) struct Watcher {
    inotify: OwnedFd,
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
impl Watcher {
    /// Watches the directory that contains `path`, which is what inotify reports
    /// changes for; `.` watches the root itself.
    pub(crate) fn open(root: &FileRoot, path: &Path) -> io::Result<Self> {
        let directory = match path.parent() {
            Some(parent) if parent.as_os_str().is_empty() => Path::new(""),
            Some(parent) => parent,
            None => Path::new(""),
        };
        let pinned = root.open_watch_directory(directory)?;
        let inotify = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        if inotify < 0 {
            return Err(io::Error::last_os_error());
        }
        let inotify = unsafe { OwnedFd::from_raw_fd(inotify) };
        // The descriptor is ours and already pinned; procfs only supplies a
        // pathname that resolves to exactly this inode.
        let target = CString::new(format!("/proc/self/fd/{}", pinned.as_raw_fd()))
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid descriptor path"))?;
        let mask = libc::IN_MODIFY
            | libc::IN_ATTRIB
            | libc::IN_CLOSE_WRITE
            | libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_MOVED_FROM
            | libc::IN_MOVED_TO
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF;
        if unsafe { libc::inotify_add_watch(inotify.as_raw_fd(), target.as_ptr(), mask) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { inotify })
    }

    /// Blocks for at most `timeout` milliseconds and reports one bounded batch.
    pub(crate) fn poll(&self, timeout_ms: i32) -> io::Result<Option<WatchBatch>> {
        let mut poll_fd = libc::pollfd {
            fd: self.inotify.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                return Ok(None);
            }
            return Err(error);
        }
        if ready == 0 {
            return Ok(None);
        }
        let mut buffer = [0u8; 8192];
        let read = unsafe {
            libc::read(
                self.inotify.as_raw_fd(),
                buffer.as_mut_ptr().cast::<libc::c_void>(),
                buffer.len(),
            )
        };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(error);
        }
        let mut batch = WatchBatch {
            overflow: false,
            names: Vec::new(),
        };
        let mut offset = 0usize;
        while offset + std::mem::size_of::<libc::inotify_event>() <= read as usize {
            let event = unsafe {
                std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast::<libc::inotify_event>())
            };
            offset += std::mem::size_of::<libc::inotify_event>() + event.len as usize;
            if event.mask & libc::IN_Q_OVERFLOW != 0 {
                batch.overflow = true;
                continue;
            }
            if event.len == 0 || batch.names.len() >= MAX_NAMES {
                continue;
            }
            let start = offset - event.len as usize;
            let raw = &buffer[start..start + event.len as usize];
            let end = raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
            if let Ok(name) = std::str::from_utf8(&raw[..end]) {
                if !name.is_empty() && !batch.names.iter().any(|seen| seen == name) {
                    batch.names.push(name.to_owned());
                }
            }
        }
        Ok(Some(batch))
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
pub(crate) struct Watcher;

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
impl Watcher {
    pub(crate) fn open(_root: &FileRoot, _path: &Path) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file watching requires Linux",
        ))
    }

    pub(crate) fn poll(&self, _timeout_ms: i32) -> io::Result<Option<WatchBatch>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file watching requires Linux",
        ))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "herdr-watch-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(path.join("root/dir")).unwrap();
            fs::write(path.join("root/dir/file.txt"), b"one").unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn wait_for(watcher: &Watcher, needle: &str) -> Option<WatchBatch> {
        for _ in 0..50 {
            if let Ok(Some(batch)) = watcher.poll(100) {
                if batch.overflow || batch.names.iter().any(|name| name == needle) {
                    return Some(batch);
                }
            }
        }
        None
    }

    #[test]
    fn reports_changes_for_the_watched_directory_only() {
        let f = Fixture::new();
        let root = FileRoot::open(&f.0.join("root")).unwrap();
        let watcher = Watcher::open(&root, Path::new("dir/file.txt")).unwrap();
        fs::write(f.0.join("root/dir/file.txt"), b"two").unwrap();
        let batch = wait_for(&watcher, "file.txt").expect("modify event for the watched file");
        assert!(batch.names.iter().any(|name| name == "file.txt"));
        fs::write(f.0.join("root/outside.txt"), b"elsewhere").unwrap();
        let unrelated = watcher.poll(200).unwrap();
        assert!(unrelated.map_or(true, |batch| !batch
            .names
            .iter()
            .any(|name| name == "outside.txt")));
    }

    #[test]
    fn watches_the_root_when_the_path_is_root_relative() {
        let f = Fixture::new();
        let root = FileRoot::open(&f.0.join("root")).unwrap();
        let watcher = Watcher::open(&root, Path::new("top.txt")).unwrap();
        fs::write(f.0.join("root/top.txt"), b"created").unwrap();
        let batch = wait_for(&watcher, "top.txt").expect("create event in the root");
        assert!(batch.names.iter().any(|name| name == "top.txt"));
    }

    #[test]
    fn rejects_unusable_paths() {
        let f = Fixture::new();
        let root = FileRoot::open(&f.0.join("root")).unwrap();
        assert!(Watcher::open(&root, Path::new("../escape.txt")).is_err());
        assert!(Watcher::open(&root, Path::new("missing/file.txt")).is_err());
    }
}
