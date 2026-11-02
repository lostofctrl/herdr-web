//! Descriptor-confined conditional file saves; not an HTTP endpoint.
//!
//! Revisions are lowercase SHA-256 digests of bounded file contents. Hash collisions
//! are theoretically possible. Bridge saves serialize globally;
//! unrelated processes do not participate. This is not a compare-and-swap: local
//! writers can change content or substitute the destination between checks and rename.
//! A local writer can also replace the temporary name before rename or cleanup. The
//! parent directory is pinned; if moved after validation, the operation follows that
//! directory even if it is no longer reachable beneath the root. Rename replaces the
//! inode. Files with multiple links, special mode bits or visible extended attributes
//! are refused, and staged ownership, mode and visible attributes are checked. WARNING:
//! Linux can hide `trusted.*` attributes from callers without permission; atomic save
//! can silently discard them. The operator/UI must warn users before exposing saves.
//! Staged data is synced before rename, but the directory is not synced: successful
//! saves do not guarantee rename durability across a crash.

use super::FileRoot;
use sha2::{Digest, Sha256};
use std::{io, path::Path};

#[allow(dead_code)]
impl FileRoot {
    pub(crate) fn revision(data: &[u8]) -> String {
        Sha256::digest(data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub(crate) fn valid_revision(revision: &[u8]) -> bool {
        revision.len() == 64
            && revision
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    }

    /// Saves an existing file when its current content hashes to `revision`.
    /// Conflict is WouldBlock; a malformed revision is InvalidInput.
    pub(crate) fn save_file(&self, path: &Path, revision: &[u8], data: &[u8]) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            linux::save(self, path, revision, data)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (path, revision, data);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "confined file saves require Linux",
            ))
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::{
        openat2, read_pinned, reopen, trusted_proc_fd_dir, FileRoot, MAX_READ, RESOLVE_BENEATH,
        RESOLVE_NO_MAGICLINKS,
    };
    use std::{
        ffi::{CString, OsStr, OsString},
        fs::File,
        io::{self, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::{OsStrExt, OsStringExt},
                fs::MetadataExt,
            },
        },
        path::{Path, PathBuf},
        sync::Mutex,
    };

    static SAVES: Mutex<()> = Mutex::new(());
    const FLAGS: u64 = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Stage {
        Resolved,
        Staged,
        Checked,
    }

    fn invalid(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, message)
    }
    fn conflict() -> io::Error {
        io::Error::new(io::ErrorKind::WouldBlock, "file revision conflict")
    }

    // The procfs helper validates and pins the actual fd directory before any
    // readlink. These paths are only hints: no operation reopens them globally.
    fn fd_path(proc_fds: &File, file: &File) -> io::Result<PathBuf> {
        let name = CString::new(file.as_raw_fd().to_string()).unwrap();
        let mut bytes = vec![0u8; 65536];
        let n = unsafe {
            libc::readlinkat(
                proc_fds.as_raw_fd(),
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        if n as usize == bytes.len() {
            return Err(invalid("proc fd path too long"));
        }
        bytes.truncate(n as usize);
        if !bytes.starts_with(b"/") || bytes.ends_with(b" (deleted)") || bytes.contains(&0) {
            return Err(invalid("ambiguous proc fd path"));
        }
        Ok(PathBuf::from(OsString::from_vec(bytes)))
    }

    fn target_parent(root: &FileRoot, target: &File) -> io::Result<(File, OsString)> {
        let proc_fds = trusted_proc_fd_dir(Path::new("/proc"))?;
        let root_path = fd_path(&proc_fds, &root.root)?;
        let target_path = fd_path(&proc_fds, target)?;
        let relative = target_path
            .strip_prefix(&root_path)
            .map_err(|_| invalid("target outside root"))?;
        let (parent, name) = root.parent(relative)?;
        check_entry(&parent, &name, target)?;
        Ok((parent, name))
    }

    fn check_entry(parent: &File, name: &OsStr, target: &File) -> io::Result<()> {
        let entry = openat2(
            parent.as_raw_fd(),
            name,
            libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            FLAGS,
        )?;
        let expected = target.metadata()?;
        let actual = entry.metadata()?;
        if !actual.is_file()
            || !expected.is_file()
            || actual.dev() != expected.dev()
            || actual.ino() != expected.ino()
        {
            return Err(invalid("pinned descriptor mismatch"));
        }
        Ok(())
    }

    // Only a kernel-owned proc fd link is reopened, never an untrusted pathname.
    // The pinned descriptor is verified regular before opening, and the reopened
    // inode is checked again. O_WRONLY without O_TRUNC checks effective permission
    // without altering the source; O_NONBLOCK is defense in depth.
    fn check_writable(target: &File) -> io::Result<File> {
        let expected = target.metadata()?;
        if !expected.is_file() {
            return Err(invalid("unsafe file type"));
        }
        let proc_fds = trusted_proc_fd_dir(Path::new("/proc"))?;
        let name = target.as_raw_fd().to_string();
        let writable = openat2(
            proc_fds.as_raw_fd(),
            OsStr::new(&name),
            libc::O_WRONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0,
        )?;
        let actual = writable.metadata()?;
        if !actual.is_file() || expected.dev() != actual.dev() || expected.ino() != actual.ino() {
            return Err(invalid("pinned descriptor mismatch"));
        }
        Ok(writable)
    }

    fn metadata_without_xattrs(file: &File) -> io::Result<std::fs::Metadata> {
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.mode() & 0o7000 != 0 {
            return Err(invalid("unsupported file metadata"));
        }
        // A size-only query is sufficient to reject any visible attribute, including
        // POSIX ACLs; any inspection error also fails closed.
        let count = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count != 0 {
            return Err(invalid("unsupported file attributes"));
        }
        Ok(metadata)
    }

    fn same_metadata(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
        a.uid() == b.uid() && a.gid() == b.gid() && (a.mode() & 0o7777) == (b.mode() & 0o7777)
    }

    fn temp_file(parent: &File) -> io::Result<(File, CString)> {
        for _ in 0..32 {
            let mut random = [0u8; 16];
            let mut filled = 0;
            while filled < random.len() {
                let n = unsafe {
                    libc::getrandom(
                        random[filled..].as_mut_ptr().cast(),
                        random.len() - filled,
                        0,
                    )
                };
                if n < 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(err);
                }
                if n == 0 {
                    return Err(io::Error::other("random source returned no bytes"));
                }
                filled += n as usize;
            }
            let name = CString::new(format!(
                ".herdr-save-{}.tmp",
                random
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ))
            .unwrap();
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd >= 0 {
                return Ok((unsafe { File::from_raw_fd(fd) }, name));
            }
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::AlreadyExists {
                return Err(err);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "temporary name collisions",
        ))
    }

    fn save_with<F>(
        root: &FileRoot,
        path: &Path,
        revision: &[u8],
        data: &[u8],
        hook: F,
    ) -> io::Result<()>
    where
        F: FnMut(Stage) -> io::Result<()>,
    {
        save_with_inspection(root, path, revision, data, hook, metadata_without_xattrs)
    }

    #[cfg(test)]
    fn save_with_sync<F, S>(
        root: &FileRoot,
        path: &Path,
        revision: &[u8],
        data: &[u8],
        hook: F,
        sync: S,
    ) -> io::Result<()>
    where
        F: FnMut(Stage) -> io::Result<()>,
        S: FnMut(&File) -> io::Result<()>,
    {
        save_with_ops(
            root,
            path,
            revision,
            data,
            hook,
            metadata_without_xattrs,
            sync,
        )
    }

    fn save_with_inspection<F, I>(
        root: &FileRoot,
        path: &Path,
        revision: &[u8],
        data: &[u8],
        hook: F,
        inspect: I,
    ) -> io::Result<()>
    where
        F: FnMut(Stage) -> io::Result<()>,
        I: FnMut(&File) -> io::Result<std::fs::Metadata>,
    {
        save_with_ops(root, path, revision, data, hook, inspect, File::sync_all)
    }

    fn save_with_ops<F, I, S>(
        root: &FileRoot,
        path: &Path,
        revision: &[u8],
        data: &[u8],
        mut hook: F,
        mut inspect: I,
        mut sync: S,
    ) -> io::Result<()>
    where
        F: FnMut(Stage) -> io::Result<()>,
        I: FnMut(&File) -> io::Result<std::fs::Metadata>,
        S: FnMut(&File) -> io::Result<()>,
    {
        if data.len() > MAX_READ || !FileRoot::valid_revision(revision) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "file body too large or invalid revision",
            ));
        }
        let _guard = SAVES
            .lock()
            .map_err(|_| io::Error::other("save lock poisoned"))?;
        let target = root.resolve(path)?;
        if !target.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsafe file type",
            ));
        }
        hook(Stage::Resolved)?;
        let (parent, name) = target_parent(root, &target)?;
        let _writable = check_writable(&target)?;
        let source = reopen(&target, false)?;
        let original = inspect(&source)?;
        if FileRoot::revision(&read_pinned(&target, MAX_READ)?).as_bytes() != revision {
            return Err(conflict());
        }
        let (mut temp, temp_name) = temp_file(&parent)?;
        let result = (|| {
            let mode = original.mode() & 0o777;
            if unsafe { libc::fchmod(temp.as_raw_fd(), mode) } != 0 {
                return Err(io::Error::last_os_error());
            }
            temp.write_all(data)?;
            sync(&temp)?;
            hook(Stage::Staged)?;
            check_entry(&parent, &name, &target)?;
            if FileRoot::revision(&read_pinned(&target, MAX_READ)?).as_bytes() != revision {
                return Err(conflict());
            }
            let current = inspect(&source)?;
            let staged = inspect(&temp)?;
            if !same_metadata(&original, &current) || !same_metadata(&current, &staged) {
                return Err(invalid("file metadata mismatch"));
            }
            hook(Stage::Checked)?;
            let destination =
                CString::new(name.as_bytes()).map_err(|_| invalid("invalid basename"))?;
            if unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temp_name.as_ptr(),
                    parent.as_raw_fd(),
                    destination.as_ptr(),
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        if let Err(error) = result {
            if unsafe { libc::unlinkat(parent.as_raw_fd(), temp_name.as_ptr(), 0) } != 0 {
                let cleanup = io::Error::last_os_error();
                return Err(io::Error::new(
                    error.kind(),
                    format!("{error}; temporary cleanup failed: {cleanup}"),
                ));
            }
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn save(
        root: &FileRoot,
        path: &Path,
        revision: &[u8],
        data: &[u8],
    ) -> io::Result<()> {
        save_with(root, path, revision, data, |_| Ok(()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            os::unix::fs::symlink,
            path::PathBuf,
            sync::{
                atomic::{AtomicU64, Ordering},
                Arc, Barrier,
            },
            thread,
        };
        static NEXT: AtomicU64 = AtomicU64::new(0);
        struct TestRoot(FileRoot);
        impl std::ops::Deref for TestRoot {
            type Target = FileRoot;
            fn deref(&self) -> &FileRoot {
                &self.0
            }
        }
        impl TestRoot {
            // Legacy race/metadata fixtures specify the expected source bytes.
            fn save_file(&self, path: &Path, expected: &[u8], data: &[u8]) -> io::Result<()> {
                self.0
                    .save_file(path, FileRoot::revision(expected).as_bytes(), data)
            }
        }
        fn save_with<F>(
            root: &FileRoot,
            path: &Path,
            expected: &[u8],
            data: &[u8],
            hook: F,
        ) -> io::Result<()>
        where
            F: FnMut(Stage) -> io::Result<()>,
        {
            super::save_with(
                root,
                path,
                FileRoot::revision(expected).as_bytes(),
                data,
                hook,
            )
        }
        fn save_with_sync<F, S>(
            root: &FileRoot,
            path: &Path,
            expected: &[u8],
            data: &[u8],
            hook: F,
            sync: S,
        ) -> io::Result<()>
        where
            F: FnMut(Stage) -> io::Result<()>,
            S: FnMut(&File) -> io::Result<()>,
        {
            super::save_with_sync(
                root,
                path,
                FileRoot::revision(expected).as_bytes(),
                data,
                hook,
                sync,
            )
        }
        fn save_with_inspection<F, I>(
            root: &FileRoot,
            path: &Path,
            expected: &[u8],
            data: &[u8],
            hook: F,
            inspect: I,
        ) -> io::Result<()>
        where
            F: FnMut(Stage) -> io::Result<()>,
            I: FnMut(&File) -> io::Result<std::fs::Metadata>,
        {
            super::save_with_inspection(
                root,
                path,
                FileRoot::revision(expected).as_bytes(),
                data,
                hook,
                inspect,
            )
        }
        struct Fixture(PathBuf);
        impl Fixture {
            fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "herdr-save-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&path).unwrap();
                fs::create_dir(path.join("root")).unwrap();
                fs::create_dir(path.join("root/dir")).unwrap();
                fs::write(path.join("root/dir/file"), b"original").unwrap();
                fs::write(path.join("outside"), b"outside").unwrap();
                Self(path)
            }
            fn root(&self) -> TestRoot {
                TestRoot(FileRoot::open(&self.0.join("root")).unwrap())
            }
            fn file(&self) -> PathBuf {
                self.0.join("root/dir/file")
            }
            fn no_temps(&self) {
                assert_eq!(fs::read_dir(self.0.join("root/dir")).unwrap().count(), 1);
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }

        #[test]
        fn saves_and_detects_stale_and_external_changes() {
            let f = Fixture::new();
            let root = f.root();
            root.save_file(Path::new("dir/file"), b"original", b"first")
                .unwrap();
            assert_eq!(fs::read(f.file()).unwrap(), b"first");
            assert_eq!(
                root.save_file(Path::new("dir/file"), b"original", b"stale")
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::WouldBlock
            );
            assert_eq!(fs::read(f.file()).unwrap(), b"first");
            fs::write(f.file(), b"external").unwrap();
            assert_eq!(
                root.save_file(Path::new("dir/file"), b"first", b"stale")
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::WouldBlock
            );
            assert_eq!(fs::read(f.file()).unwrap(), b"external");
            f.no_temps();
        }
        #[test]
        fn digest_revision_handles_empty_binary_and_malformed_tokens() {
            let f = Fixture::new();
            let root = f.root();
            fs::write(f.file(), b"").unwrap();
            let empty = FileRoot::revision(b"");
            assert_eq!(
                empty,
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            );
            for revision in [
                b"".as_slice(),
                b"original",
                b"ABCDEF",
                b"000000000000000000000000000000000000000000000000000000000000000g",
            ] {
                assert_eq!(
                    root.0
                        .save_file(Path::new("dir/file"), revision, b"bad")
                        .unwrap_err()
                        .kind(),
                    io::ErrorKind::InvalidInput
                );
                assert_eq!(fs::read(f.file()).unwrap(), b"");
            }
            assert_eq!(
                root.0
                    .save_file(
                        Path::new("dir/file"),
                        b"0000000000000000000000000000000000000000000000000000000000000000",
                        b"bad"
                    )
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::WouldBlock
            );
            root.0
                .save_file(Path::new("dir/file"), empty.as_bytes(), b"\xff\0")
                .unwrap();
            let binary = FileRoot::revision(b"\xff\0");
            root.0
                .save_file(Path::new("dir/file"), binary.as_bytes(), b"ok")
                .unwrap();
            assert_eq!(fs::read(f.file()).unwrap(), b"ok");
            f.no_temps();
        }
        #[test]
        fn concurrent_saves_from_same_revision_have_one_winner() {
            let f = Fixture::new();
            let root = Arc::new(f.root());
            let barrier = Arc::new(Barrier::new(3));
            let workers: Vec<_> = [b"one".as_slice(), b"two".as_slice()]
                .into_iter()
                .map(|data| {
                    let root = Arc::clone(&root);
                    let barrier = Arc::clone(&barrier);
                    thread::spawn(move || {
                        barrier.wait();
                        root.save_file(Path::new("dir/file"), b"original", data)
                    })
                })
                .collect();
            barrier.wait();
            assert_eq!(
                workers
                    .into_iter()
                    .map(|t| t.join().unwrap())
                    .filter(|result| result.is_ok())
                    .count(),
                1
            );
            assert!([b"one".as_slice(), b"two".as_slice()]
                .contains(&fs::read(f.file()).unwrap().as_slice()));
            f.no_temps();
        }
        #[test]
        fn safe_symlinks_save_target_without_replacing_link() {
            let f = Fixture::new();
            let root = f.root();
            symlink("dir/file", f.0.join("root/link")).unwrap();
            symlink("../dir/file", f.0.join("root/dir/link")).unwrap();
            root.save_file(Path::new("link"), b"original", b"one")
                .unwrap();
            root.save_file(Path::new("dir/link"), b"one", b"two")
                .unwrap();
            assert_eq!(fs::read(f.file()).unwrap(), b"two");
            assert!(fs::symlink_metadata(f.0.join("root/link"))
                .unwrap()
                .is_symlink());
            assert!(fs::symlink_metadata(f.0.join("root/dir/link"))
                .unwrap()
                .is_symlink());
        }
        #[test]
        fn rejects_escape_magic_links_types_missing_and_oversized() {
            let f = Fixture::new();
            let root = f.root();
            symlink("../outside", f.0.join("root/escape")).unwrap();
            symlink("/proc/self/fd/0", f.0.join("root/magic")).unwrap();
            use std::os::unix::ffi::OsStrExt;
            let fifo =
                std::ffi::CString::new(f.0.join("root/fifo").as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            for path in ["escape", "magic", "../outside", "dir", "missing", "fifo"] {
                assert!(
                    root.save_file(Path::new(path), b"original", b"bad")
                        .is_err(),
                    "{path}"
                );
            }
            assert!(root
                .save_file(
                    Path::new("dir/file"),
                    b"original",
                    &vec![0; super::super::super::MAX_READ + 1]
                )
                .is_err());
            assert!(root
                .0
                .save_file(
                    Path::new("dir/file"),
                    &vec![0; super::super::super::MAX_READ + 1],
                    b"bad"
                )
                .is_err());
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
            f.no_temps();
            if let Ok(proc) = FileRoot::open(Path::new("/proc")) {
                assert!(proc.save_file(Path::new("self/fd/0"), b"", b"bad").is_err());
            }
        }
        #[test]
        fn rejects_readonly_target_without_staging() {
            use std::os::unix::fs::PermissionsExt;
            let f = Fixture::new();
            let root = f.root();
            fs::set_permissions(f.file(), fs::Permissions::from_mode(0o444)).unwrap();
            match fs::OpenOptions::new().write(true).open(f.file()) {
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied => (),
                Ok(_) => {
                    eprintln!("SKIP: effective credentials can write 0444 files");
                    return;
                }
                Err(e) => panic!("unexpected permission probe failure: {e}"),
            }
            let error = root
                .save_file(Path::new("dir/file"), b"original", b"new")
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            f.no_temps();
        }
        #[test]
        fn write_permission_check_reopens_the_pinned_inode_without_truncation() {
            use std::os::unix::fs::MetadataExt;
            let f = Fixture::new();
            let root = f.root();
            let pinned = root.resolve(Path::new("dir/file")).unwrap();
            let before = pinned.metadata().unwrap();
            fs::rename(f.file(), f.0.join("moved")).unwrap();
            symlink("../../outside", f.file()).unwrap();
            let writable = check_writable(&pinned).unwrap();
            let actual = writable.metadata().unwrap();
            assert_eq!((actual.dev(), actual.ino()), (before.dev(), before.ino()));
            assert_eq!(fs::read(f.0.join("moved")).unwrap(), b"original");
            assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
            f.no_temps();
        }
        #[test]
        fn sync_succeeds_before_destination_replacement() {
            let f = Fixture::new();
            let root = f.root();
            let mut synced = false;
            save_with_sync(
                &root,
                Path::new("dir/file"),
                b"original",
                b"new",
                |_| Ok(()),
                |file| {
                    assert_eq!(fs::read(f.file())?, b"original");
                    assert_eq!(file.metadata()?.len(), 3);
                    file.sync_all()?;
                    synced = true;
                    Ok(())
                },
            )
            .unwrap();
            assert!(synced);
            assert_eq!(fs::read(f.file()).unwrap(), b"new");
            f.no_temps();
        }
        #[test]
        fn sync_error_rejects_save_and_cleans_staging() {
            let f = Fixture::new();
            let root = f.root();
            let mut synced = false;
            let error = save_with_sync(
                &root,
                Path::new("dir/file"),
                b"original",
                b"new",
                |_| Ok(()),
                |file| {
                    assert_eq!(file.metadata()?.len(), 3);
                    synced = true;
                    Err(io::Error::from_raw_os_error(libc::EIO))
                },
            )
            .unwrap_err();
            assert!(synced);
            assert_eq!(error.raw_os_error(), Some(libc::EIO));
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            f.no_temps();
        }
        #[test]
        fn cleanup_on_staging_failure() {
            let f = Fixture::new();
            let root = f.root();
            let result = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    Err(io::Error::other("injected failure"))
                } else {
                    Ok(())
                }
            });
            assert_eq!(result.unwrap_err().to_string(), "injected failure");
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            f.no_temps();
        }
        #[test]
        fn reports_cleanup_failure_without_changing_destination() {
            let f = Fixture::new();
            let root = f.root();
            let error = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    let temp = fs::read_dir(f.0.join("root/dir"))?
                        .map(|e| e.unwrap().path())
                        .find(|p| {
                            p.file_name()
                                .unwrap()
                                .as_encoded_bytes()
                                .starts_with(b".herdr-save-")
                        })
                        .unwrap();
                    fs::rename(temp, f.0.join("displaced-temp"))?;
                    return Err(io::Error::other("injected failure"));
                }
                Ok(())
            })
            .unwrap_err();
            assert!(error
                .to_string()
                .contains("injected failure; temporary cleanup failed:"));
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            assert_eq!(fs::read(f.0.join("displaced-temp")).unwrap(), b"new");
            f.no_temps();
        }
        fn temp_path(f: &Fixture) -> PathBuf {
            fs::read_dir(f.0.join("root/dir"))
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| {
                    p.file_name()
                        .unwrap()
                        .as_encoded_bytes()
                        .starts_with(b".herdr-save-")
                })
                .unwrap()
        }
        fn set_xattr(path: &Path, name: &str, value: &[u8]) -> io::Result<()> {
            let path = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
            let name = CString::new(name).unwrap();
            if unsafe {
                libc::setxattr(
                    path.as_ptr(),
                    name.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            } == 0
            {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
        fn xattr_available(result: io::Result<()>) -> bool {
            match result {
                Ok(()) => true,
                Err(e)
                    if matches!(
                        e.raw_os_error(),
                        Some(libc::EOPNOTSUPP | libc::EPERM | libc::EACCES)
                    ) =>
                {
                    eprintln!("SKIP: xattr/ACL unavailable: {e}");
                    false
                }
                Err(e) => panic!("unexpected xattr setup failure: {e}"),
            }
        }
        #[test]
        fn rejects_source_setid_and_hardlinks() {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            for mode in [0o4640, 0o2640] {
                let f = Fixture::new();
                let root = f.root();
                fs::set_permissions(f.file(), fs::Permissions::from_mode(mode)).unwrap();
                assert_eq!(fs::metadata(f.file()).unwrap().mode() & 0o7777, mode);
                assert!(root
                    .save_file(Path::new("dir/file"), b"original", b"new")
                    .is_err());
                assert_eq!(fs::read(f.file()).unwrap(), b"original");
                assert_eq!(fs::metadata(f.file()).unwrap().mode() & 0o7777, mode);
                f.no_temps();
            }
            let f = Fixture::new();
            let root = f.root();
            fs::hard_link(f.file(), f.0.join("linked")).unwrap();
            assert!(root
                .save_file(Path::new("dir/file"), b"original", b"new")
                .is_err());
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            assert_eq!(fs::read(f.0.join("linked")).unwrap(), b"original");
            assert_eq!(
                fs::metadata(f.file()).unwrap().ino(),
                fs::metadata(f.0.join("linked")).unwrap().ino()
            );
            f.no_temps();
        }
        #[test]
        fn rejects_source_and_staged_xattrs() {
            let f = Fixture::new();
            let root = f.root();
            if !xattr_available(set_xattr(&f.file(), "user.herdr_test", b"important")) {
                return;
            }
            assert!(root
                .save_file(Path::new("dir/file"), b"original", b"new")
                .is_err());
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            f.no_temps();
            let g = Fixture::new();
            let root = g.root();
            let result = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    set_xattr(&temp_path(&g), "user.herdr_test", b"important")?;
                }
                Ok(())
            });
            assert!(result.is_err());
            assert_eq!(fs::read(g.file()).unwrap(), b"original");
            g.no_temps();
        }
        #[test]
        fn rejects_staged_mode_and_owner_mismatch() {
            use std::os::unix::fs::PermissionsExt;
            let f = Fixture::new();
            let root = f.root();
            let result = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    fs::set_permissions(temp_path(&f), fs::Permissions::from_mode(0o000))?;
                }
                Ok(())
            });
            assert!(result.is_err());
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            f.no_temps();
            if unsafe { libc::geteuid() } != 0 {
                eprintln!("SKIP: staged ownership mismatch requires root");
                return;
            }
            let g = Fixture::new();
            let root = g.root();
            let result = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    let path = CString::new(temp_path(&g).as_os_str().as_encoded_bytes()).unwrap();
                    if unsafe { libc::chown(path.as_ptr(), 65534, 65534) } != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
            assert!(result.is_err());
            assert_eq!(fs::read(g.file()).unwrap(), b"original");
            g.no_temps();
        }
        #[test]
        fn rejects_inherited_default_acl_on_staged_inode() {
            let f = Fixture::new();
            let root = f.root();
            // Linux POSIX ACL xattr: version 2, user/group/other plus named user and mask.
            let mut acl = 2u32.to_le_bytes().to_vec();
            for (tag, perm, id) in [
                (1u16, 7u16, u32::MAX),
                (2, 4, 65534),
                (4, 5, u32::MAX),
                (16, 5, u32::MAX),
                (32, 5, u32::MAX),
            ] {
                acl.extend_from_slice(&tag.to_le_bytes());
                acl.extend_from_slice(&perm.to_le_bytes());
                acl.extend_from_slice(&id.to_le_bytes());
            }
            if !xattr_available(set_xattr(
                &f.0.join("root/dir"),
                "system.posix_acl_default",
                &acl,
            )) {
                return;
            }
            assert!(root
                .save_file(Path::new("dir/file"), b"original", b"new")
                .is_err());
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            f.no_temps();
        }
        #[test]
        fn inspection_errors_abort_and_clean_staging() {
            let f = Fixture::new();
            let root = f.root();
            // O_PATH descriptors support fstat but flistxattr fails with EBADF.
            let pinned = root.resolve(Path::new("dir/file")).unwrap();
            assert_eq!(
                metadata_without_xattrs(&pinned).unwrap_err().raw_os_error(),
                Some(libc::EBADF)
            );
            // Inject failure at initial source, post-staging source, and staged inode checks.
            for fail_at in 1..=3 {
                let mut calls = 0;
                let error = save_with_inspection(
                    &root,
                    Path::new("dir/file"),
                    b"original",
                    b"new",
                    |_| Ok(()),
                    |file| {
                        calls += 1;
                        if calls == fail_at {
                            Err(io::Error::from_raw_os_error(libc::EIO))
                        } else {
                            metadata_without_xattrs(file)
                        }
                    },
                )
                .unwrap_err();
                assert_eq!(error.raw_os_error(), Some(libc::EIO));
                assert_eq!(fs::read(f.file()).unwrap(), b"original");
                f.no_temps();
            }
        }
        #[test]
        fn rejects_new_hardlink_during_staging() {
            let f = Fixture::new();
            let root = f.root();
            let result = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    fs::hard_link(f.file(), f.0.join("linked"))?;
                }
                Ok(())
            });
            assert!(result.is_err());
            assert_eq!(fs::read(f.file()).unwrap(), b"original");
            assert_eq!(fs::read(f.0.join("linked")).unwrap(), b"original");
            f.no_temps();
        }
        #[test]
        fn preserves_ordinary_permission_bits() {
            use std::os::unix::fs::PermissionsExt;
            let f = Fixture::new();
            let root = f.root();
            use std::os::unix::fs::MetadataExt;
            fs::set_permissions(f.file(), fs::Permissions::from_mode(0o640)).unwrap();
            let before = fs::metadata(f.file()).unwrap();
            root.save_file(Path::new("dir/file"), b"original", b"new")
                .unwrap();
            let after = fs::metadata(f.file()).unwrap();
            assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
            assert_eq!(after.permissions().mode() & 0o7777, 0o640);
            assert_eq!(fs::read(f.file()).unwrap(), b"new");
            f.no_temps();
        }
        #[test]
        fn replacement_after_pin_is_rejected_before_staging() {
            let f = Fixture::new();
            let root = f.root();
            let result = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Resolved {
                    fs::rename(f.file(), f.0.join("moved"))?;
                    symlink("../../outside", f.file())?;
                }
                Ok(())
            });
            assert!(result.is_err());
            assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
            assert_eq!(fs::read(f.0.join("moved")).unwrap(), b"original");
            f.no_temps();
        }
        #[test]
        fn external_content_change_during_staging_is_rejected_and_cleaned_up() {
            let f = Fixture::new();
            let root = f.root();
            let result = save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    fs::write(f.file(), b"external")?;
                }
                Ok(())
            });
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::WouldBlock);
            assert_eq!(fs::read(f.file()).unwrap(), b"external");
            f.no_temps();
        }
        #[test]
        fn destination_substitution_after_check_is_not_a_cas() {
            let f = Fixture::new();
            let root = f.root();
            save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Checked {
                    fs::rename(f.file(), f.0.join("moved"))?;
                    symlink("../../outside", f.file())?;
                }
                Ok(())
            })
            .unwrap();
            assert_eq!(fs::read(f.file()).unwrap(), b"new");
            assert_eq!(fs::read(f.0.join("moved")).unwrap(), b"original");
            assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
            f.no_temps();
        }
        #[test]
        fn temp_name_substitution_is_an_explicitly_accepted_race() {
            let f = Fixture::new();
            let root = f.root();
            save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Checked {
                    let temp = fs::read_dir(f.0.join("root/dir"))?
                        .map(|e| e.unwrap().path())
                        .find(|p| {
                            p.file_name()
                                .unwrap()
                                .as_encoded_bytes()
                                .starts_with(b".herdr-save-")
                        })
                        .unwrap();
                    fs::rename(&temp, f.0.join("stolen-temp"))?;
                    symlink("../../outside", temp)?;
                }
                Ok(())
            })
            .unwrap();
            assert!(fs::symlink_metadata(f.file()).unwrap().is_symlink());
            assert_eq!(fs::read(f.0.join("stolen-temp")).unwrap(), b"new");
            assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
            f.no_temps();
        }
        #[test]
        fn deleted_suffix_and_non_utf8_names() {
            use std::os::unix::ffi::OsStrExt;
            let f = Fixture::new();
            let root = f.root();
            let ambiguous = f.0.join("root/dir/file (deleted)");
            fs::write(&ambiguous, b"old").unwrap();
            assert!(root
                .save_file(Path::new("dir/file (deleted)"), b"old", b"bad")
                .is_err());
            assert_eq!(fs::read(ambiguous).unwrap(), b"old");
            let name = std::ffi::OsStr::from_bytes(b"dir/\xfffile");
            let absolute = f.0.join("root").join(name);
            fs::write(&absolute, b"old").unwrap();
            root.save_file(Path::new(name), b"old", b"new").unwrap();
            assert_eq!(fs::read(absolute).unwrap(), b"new");
        }
        #[test]
        fn renamed_parent_is_pinned_not_replaced_path() {
            let f = Fixture::new();
            let root = f.root();
            save_with(&root, Path::new("dir/file"), b"original", b"new", |stage| {
                if stage == Stage::Staged {
                    fs::rename(f.0.join("root/dir"), f.0.join("moved-dir"))?;
                    symlink("../", f.0.join("root/dir"))?;
                }
                Ok(())
            })
            .unwrap();
            assert_eq!(fs::read(f.0.join("moved-dir/file")).unwrap(), b"new");
            assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
        }
    }
}
