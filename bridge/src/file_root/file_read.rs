//! Bounded read-only operations on descriptors pinned by `FileRoot`.
//!
//! Linux cannot directly turn an O_PATH fd into a readable fd. We pin a procfs
//! root, verify its filesystem and root inode, and resolve thread-self/fd with
//! NO_XDEV so a mounted-over component cannot substitute another fd directory.
//! The kernel-generated numeric magic link then refers to the still-owned fd in
//! this thread's fd table. No untrusted pathname is reopened. Missing or altered
//! procfs and unsupported openat2 flags are errors, never fallback paths.

mod file_save;

use super::FileRoot;
use std::io;
use std::path::{Path, PathBuf};

const MAX_READ: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;

/// Entry kind is captured from the pinned directory without following links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ListedEntry {
    pub(crate) path: PathBuf,
    pub(crate) kind: &'static str,
}

#[cfg(target_os = "linux")]
use super::linux::{
    openat2, RESOLVE_BENEATH, RESOLVE_NO_MAGICLINKS, RESOLVE_NO_SYMLINKS, RESOLVE_NO_XDEV,
};
#[cfg(target_os = "linux")]
use std::{
    ffi::{CStr, OsStr},
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd},
        unix::ffi::OsStrExt,
    },
};

#[cfg(target_os = "linux")]
fn trusted_proc_fd_dir(path: &Path) -> io::Result<File> {
    trusted_proc_fd_dir_with(path, openat2)
}

#[cfg(target_os = "linux")]
fn trusted_proc_fd_dir_with(
    path: &Path,
    opener: fn(RawFd, &OsStr, i32, u64) -> io::Result<File>,
) -> io::Result<File> {
    let proc = opener(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        RESOLVE_NO_SYMLINKS,
    )?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // fstatfs initializes the buffer on success.
    if unsafe { libc::fstatfs(proc.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    use std::os::unix::fs::MetadataExt;
    if stat.f_type as u64 != libc::PROC_SUPER_MAGIC as u64 || proc.metadata()?.ino() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "trusted procfs root unavailable",
        ));
    }
    opener(
        proc.as_raw_fd(),
        OsStr::new("thread-self/fd"),
        libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
    )
}

#[cfg(target_os = "linux")]
fn reopen(pinned: &File, directory: bool) -> io::Result<File> {
    let ty = pinned.metadata()?.file_type();
    if (directory && !ty.is_dir()) || (!directory && !ty.is_file()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsafe file type",
        ));
    }
    let proc_fds = trusted_proc_fd_dir(Path::new("/proc"))?;
    let name = pinned.as_raw_fd().to_string();
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let reopened = openat2(proc_fds.as_raw_fd(), OsStr::new(&name), flags, 0)?;
    // Defense in depth: the proc link must have reopened the same inode.
    use std::os::unix::fs::MetadataExt;
    let a = pinned.metadata()?;
    let b = reopened.metadata()?;
    if a.dev() != b.dev()
        || a.ino() != b.ino()
        || (directory && !b.is_dir())
        || (!directory && !b.is_file())
    {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "pinned descriptor mismatch",
        ));
    }
    Ok(reopened)
}

#[cfg(target_os = "linux")]
fn read_pinned(pinned: &File, limit: usize) -> io::Result<Vec<u8>> {
    if limit > MAX_READ {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "read limit too large",
        ));
    }
    let file = reopen(pinned, false)?;
    let mut data = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut data)?;
    if data.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds read limit",
        ));
    }
    Ok(data)
}

#[cfg(target_os = "linux")]
struct Directory(*mut libc::DIR);
#[cfg(target_os = "linux")]
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
impl FileRoot {
    /// Reopens a pinned directory for watching; the caller must drop it promptly.
    pub(crate) fn open_watch_directory(&self, path: &Path) -> io::Result<std::fs::File> {
        let pinned = if path.as_os_str().is_empty() {
            self.root.try_clone()?
        } else {
            self.resolve(path)?
        };
        reopen(&pinned, true)
    }

    pub(crate) fn read_file(&self, path: &Path, limit: usize) -> io::Result<Vec<u8>> {
        read_pinned(&self.resolve(path)?, limit)
    }

    /// Returns sorted root-relative paths for files, directories, and unfollowed symlinks.
    /// Entry classification uses the pinned directory. Names are not a snapshot: a later
    /// root-relative open must independently enforce confinement. Vanished entries (ENOENT)
    /// and special files are skipped; other errors are returned. The limit counts all entries,
    /// including skipped ones, and overflow is an error.
    pub(crate) fn list(&self, path: &Path, limit: usize) -> io::Result<Vec<PathBuf>> {
        self.list_with(path, limit, || {}, openat2)
    }

    pub(crate) fn list_typed(&self, path: &Path, limit: usize) -> io::Result<Vec<ListedEntry>> {
        self.list_typed_with(path, limit, || {}, openat2)
    }

    fn list_with<F, H>(
        &self,
        path: &Path,
        limit: usize,
        hook: H,
        opener: F,
    ) -> io::Result<Vec<PathBuf>>
    where
        F: FnMut(RawFd, &OsStr, i32, u64) -> io::Result<File>,
        H: FnOnce(),
    {
        Ok(self
            .list_typed_with(path, limit, hook, opener)?
            .into_iter()
            .map(|entry| entry.path)
            .collect())
    }

    fn list_typed_with<F, H>(
        &self,
        path: &Path,
        limit: usize,
        hook: H,
        mut opener: F,
    ) -> io::Result<Vec<ListedEntry>>
    where
        F: FnMut(RawFd, &OsStr, i32, u64) -> io::Result<File>,
        H: FnOnce(),
    {
        if limit > MAX_ENTRIES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "entry limit too large",
            ));
        }
        let pinned = if path.as_os_str().is_empty() {
            self.root.try_clone()?
        } else {
            self.resolve(path)?
        };
        let file = reopen(&pinned, true)?;
        let fd = file.into_raw_fd();
        let dir = unsafe { libc::fdopendir(fd) };
        if dir.is_null() {
            let error = io::Error::last_os_error();
            // fdopendir does not take ownership on failure.
            drop(unsafe { File::from_raw_fd(fd) });
            return Err(error);
        }
        let dir = Directory(dir);
        let dir_fd = unsafe { libc::dirfd(dir.0) };
        if dir_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        hook();
        let mut entries = Vec::new();
        let mut count = 0usize;
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(dir.0) };
            if entry.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(0) {
                    return Err(error);
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            count += 1;
            if count > limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "directory exceeds entry limit",
                ));
            }
            // O_NOFOLLOW with O_PATH pins the entry itself, including symlinks,
            // without opening a device or following a link out of the directory.
            let entry = match opener(
                dir_fd,
                OsStr::from_bytes(name),
                libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS,
            ) {
                Ok(entry) => entry,
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => continue,
                Err(error) => return Err(error),
            };
            let ty = entry.metadata()?.file_type();
            let kind = if ty.is_file() {
                "file"
            } else if ty.is_dir() {
                "directory"
            } else if ty.is_symlink() {
                "symlink"
            } else {
                continue;
            };
            entries.push(ListedEntry {
                path: path.join(OsStr::from_bytes(name)),
                kind,
            });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
impl FileRoot {
    pub(crate) fn open_watch_directory(&self, _path: &Path) -> io::Result<std::fs::File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file watching requires Linux",
        ))
    }

    pub(crate) fn read_file(&self, _path: &Path, _limit: usize) -> io::Result<Vec<u8>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file reads require Linux",
        ))
    }
    pub(crate) fn list(&self, _path: &Path, _limit: usize) -> io::Result<Vec<PathBuf>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file listing requires Linux",
        ))
    }
    pub(crate) fn list_typed(&self, _path: &Path, _limit: usize) -> io::Result<Vec<ListedEntry>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file listing requires Linux",
        ))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::super::FileRoot;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "herdr-file-read-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::create_dir(path.join("root")).unwrap();
            fs::create_dir(path.join("root/dir")).unwrap();
            fs::write(path.join("root/dir/file"), b"inside").unwrap();
            fs::write(path.join("outside"), b"outside").unwrap();
            Self(path)
        }
        fn root(&self) -> FileRoot {
            FileRoot::open(&self.0.join("root")).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn reads_confined_files_and_enforces_limit() {
        let f = Fixture::new();
        symlink("dir/file", f.0.join("root/link")).unwrap();
        symlink("../dir/file", f.0.join("root/dir/relative")).unwrap();
        symlink("../outside", f.0.join("root/escape")).unwrap();
        symlink(f.0.join("outside"), f.0.join("root/absolute")).unwrap();
        let root = f.root();
        assert_eq!(root.read_file(Path::new("link"), 6).unwrap(), b"inside");
        assert_eq!(
            root.read_file(Path::new("dir/relative"), 6).unwrap(),
            b"inside"
        );
        assert!(root.read_file(Path::new("link"), 5).is_err());
        assert!(root
            .read_file(Path::new("link"), super::MAX_READ + 1)
            .is_err());
        for path in ["escape", "absolute", "../outside", "dir", ""] {
            assert!(root.read_file(Path::new(path), 100).is_err(), "{path}");
        }
    }

    #[test]
    fn read_reopens_the_pinned_inode_not_a_replaced_path() {
        let f = Fixture::new();
        let root = f.root();
        let pinned = root.resolve(Path::new("dir/file")).unwrap();
        fs::rename(f.0.join("root/dir/file"), f.0.join("moved")).unwrap();
        symlink("../../outside", f.0.join("root/dir/file")).unwrap();
        assert_eq!(super::read_pinned(&pinned, 32).unwrap(), b"inside");
        assert!(root.read_file(Path::new("dir/file"), 32).is_err());
    }

    #[test]
    fn lists_relative_names_only_skipping_unsafe_entries_and_enforces_limit() {
        let f = Fixture::new();
        symlink("dir/file", f.0.join("root/link")).unwrap();
        symlink("../outside", f.0.join("root/escape")).unwrap();
        symlink("missing", f.0.join("root/dangling")).unwrap();
        let fifo = std::ffi::CString::new(f.0.join("root/fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let _socket = std::os::unix::net::UnixListener::bind(f.0.join("root/socket")).unwrap();
        let root = f.root();
        assert_eq!(
            root.list(Path::new(""), 10).unwrap(),
            vec![
                PathBuf::from("dangling"),
                PathBuf::from("dir"),
                PathBuf::from("escape"),
                PathBuf::from("link")
            ]
        );
        assert_eq!(
            root.list(Path::new("dir"), 10).unwrap(),
            vec![PathBuf::from("dir/file")]
        );
        assert!(root.list(Path::new(""), 1).is_err());
        assert!(root.list(Path::new(""), super::MAX_ENTRIES + 1).is_err());
        assert!(root.list(Path::new("link"), 10).is_err());
        assert!(root.read_file(Path::new("fifo"), 10).is_err());
        assert!(root.read_file(Path::new("socket"), 10).is_err());
    }

    #[test]
    fn root_remains_accessible_after_rename() {
        let f = Fixture::new();
        let root = f.root();
        fs::rename(f.0.join("root"), f.0.join("old")).unwrap();
        fs::create_dir(f.0.join("root")).unwrap();
        fs::write(f.0.join("root/decoy"), b"decoy").unwrap();
        assert_eq!(root.read_file(Path::new("dir/file"), 6).unwrap(), b"inside");
        assert_eq!(
            root.list(Path::new(""), 10).unwrap(),
            vec![PathBuf::from("dir")]
        );
    }

    #[test]
    fn listing_propagates_operational_errors_but_skips_disappeared_entry() {
        let f = Fixture::new();
        let root = f.root();
        for code in [libc::EMFILE, libc::EIO, libc::ENOSYS, libc::EAGAIN] {
            let error = root
                .list_with(
                    Path::new("dir"),
                    10,
                    || {},
                    |_, _, _, _| Err(std::io::Error::from_raw_os_error(code)),
                )
                .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(code));
        }
        let entries = root
            .list_with(
                Path::new("dir"),
                10,
                || {},
                |_, _, _, _| Err(std::io::Error::from_raw_os_error(libc::ENOENT)),
            )
            .unwrap();
        assert!(entries.is_empty());
        let error = root
            .list_with(
                Path::new("dir"),
                0,
                || {},
                |_, _, _, _| Err(std::io::Error::from_raw_os_error(libc::ENOENT)),
            )
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn listing_classifies_the_pinned_directory_after_parent_replacement() {
        let f = Fixture::new();
        let root = f.root();
        let entries = root
            .list_with(
                Path::new("dir"),
                10,
                || {
                    fs::rename(f.0.join("root/dir"), f.0.join("old-dir")).unwrap();
                    fs::create_dir(f.0.join("root/dir")).unwrap();
                    fs::write(f.0.join("root/dir/replacement"), b"replacement").unwrap();
                },
                |fd, name, flags, resolve| {
                    assert_eq!(flags, libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC);
                    assert_eq!(
                        resolve,
                        super::RESOLVE_BENEATH | super::RESOLVE_NO_MAGICLINKS
                    );
                    super::openat2(fd, name, flags, resolve)
                },
            )
            .unwrap();
        assert_eq!(entries, vec![PathBuf::from("dir/file")]);
    }

    #[test]
    fn typed_listing_uses_pinned_directory_and_never_follows_links() {
        let f = Fixture::new();
        symlink("file", f.0.join("root/dir/safe")).unwrap();
        symlink("missing", f.0.join("root/dir/dangling")).unwrap();
        symlink("../../outside", f.0.join("root/dir/escape")).unwrap();
        let root = f.root();
        let entries = root
            .list_typed_with(
                Path::new("dir"),
                10,
                || {
                    fs::rename(f.0.join("root/dir"), f.0.join("old-dir")).unwrap();
                    fs::create_dir(f.0.join("root/dir")).unwrap();
                },
                super::openat2,
            )
            .unwrap();
        let actual: Vec<_> = entries
            .into_iter()
            .map(|entry| (entry.path, entry.kind))
            .collect();
        assert_eq!(
            actual,
            vec![
                (PathBuf::from("dir/dangling"), "symlink"),
                (PathBuf::from("dir/escape"), "symlink"),
                (PathBuf::from("dir/file"), "file"),
                (PathBuf::from("dir/safe"), "symlink"),
            ]
        );
    }

    #[test]
    fn listing_includes_symlinks_without_following_them() {
        let f = Fixture::new();
        symlink("missing", f.0.join("root/dangling")).unwrap();
        symlink("../outside", f.0.join("root/escape")).unwrap();
        symlink(f.0.join("outside"), f.0.join("root/absolute")).unwrap();
        let root = f.root();
        assert_eq!(
            root.list(Path::new(""), 10).unwrap(),
            vec![
                PathBuf::from("absolute"),
                PathBuf::from("dangling"),
                PathBuf::from("dir"),
                PathBuf::from("escape"),
            ]
        );
        for path in ["absolute", "dangling", "escape"] {
            assert!(root.read_file(Path::new(path), 100).is_err());
        }
    }

    #[test]
    fn proc_probe_rejects_untrusted_filesystems_and_errors() {
        let f = Fixture::new();
        assert!(super::trusted_proc_fd_dir(&f.0).is_err());
        assert!(super::trusted_proc_fd_dir(&f.0.join("missing")).is_err());
        symlink("/proc", f.0.join("proc-link")).unwrap();
        assert!(super::trusted_proc_fd_dir(&f.0.join("proc-link")).is_err());
        assert!(super::trusted_proc_fd_dir(Path::new("/proc/self/fd")).is_err());
        assert!(super::trusted_proc_fd_dir(Path::new("/proc")).is_ok());
        fn fail_probe(
            dir: std::os::fd::RawFd,
            path: &std::ffi::OsStr,
            flags: i32,
            resolve: u64,
        ) -> std::io::Result<std::fs::File> {
            if path == "thread-self/fd" {
                assert_eq!(
                    resolve,
                    super::RESOLVE_BENEATH | super::RESOLVE_NO_MAGICLINKS | super::RESOLVE_NO_XDEV
                );
                Err(std::io::Error::from_raw_os_error(libc::ENOSYS))
            } else {
                super::openat2(dir, path, flags, resolve)
            }
        }
        let error = super::trusted_proc_fd_dir_with(Path::new("/proc"), fail_probe).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ENOSYS));
    }
}
