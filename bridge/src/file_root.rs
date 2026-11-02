//! Linux descriptor-based confinement primitive; no filesystem operations are exposed yet.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::path::Path;

mod file_read;

#[allow(dead_code)]
pub(crate) struct FileRoot {
    #[cfg(target_os = "linux")]
    root: File,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::ffi::{CString, OsStr};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;

    pub(super) const RESOLVE_NO_XDEV: u64 = 0x01;
    pub(super) const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    pub(super) const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    pub(super) const RESOLVE_BENEATH: u64 = 0x08;
    const CONFINED: u64 = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;

    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }

    pub(super) fn openat2(dir: RawFd, path: &OsStr, flags: i32, resolve: u64) -> io::Result<File> {
        let path = CString::new(path.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
        let how = OpenHow {
            flags: flags as u64,
            mode: 0,
            resolve,
        };
        // RESOLVE_BENEATH can report EAGAIN during concurrent renames when the
        // kernel cannot prove confinement. Retry finitely, never downgrade flags.
        for attempt in 0..32 {
            // The kernel reads an initialized open_how and NUL-terminated path.
            let fd = unsafe {
                libc::syscall(
                    libc::SYS_openat2,
                    dir,
                    path.as_ptr(),
                    &how,
                    std::mem::size_of::<OpenHow>(),
                )
            };
            if fd >= 0 {
                // A successful openat2 returns a newly owned descriptor.
                return Ok(unsafe { File::from_raw_fd(fd as RawFd) });
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EAGAIN) || attempt == 31 {
                return Err(error);
            }
        }
        unreachable!()
    }

    fn components(path: &Path) -> io::Result<Vec<&[u8]>> {
        let bytes = path.as_os_str().as_bytes();
        let parts: Vec<_> = bytes.split(|byte| *byte == b'/').collect();
        if bytes.contains(&0)
            || parts
                .iter()
                .any(|part| part.is_empty() || *part == b"." || *part == b"..")
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid relative path",
            ));
        }
        Ok(parts)
    }

    type Opener = fn(RawFd, &OsStr, i32, u64) -> io::Result<File>;

    fn check_filesystem(fd: RawFd) -> io::Result<()> {
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // fstatfs operates on the pinned O_PATH descriptor, not a replaceable path.
        if unsafe { libc::fstatfs(fd, stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let magic = unsafe { stat.assume_init() }.f_type as u32;
        // These kernel control/inspection filesystems can present dynamic data as
        // regular files, including process secrets or privileged kernel state. Deny
        // them even under /, but do not forbid mount crossings: ordinary disk,
        // network and tmpfs mounts remain usable. This list cannot identify arbitrary
        // FUSE filesystems or secrets in ordinary files; it is not a content sandbox.
        if matches!(
            magic,
            0x0000_9fa0 // procfs
            | 0x6265_6572 // sysfs
            | 0x6462_6720 // debugfs
            | 0x7472_6163 // tracefs
            | 0x7363_6673 // securityfs
            | 0xcafe_4a11 // bpf filesystem
            | 0x0027_e0eb // cgroup v1
            | 0x6367_7270 // cgroup v2
            | 0x6265_6570 // configfs
            | 0x6e73_6673 // nsfs
            | 0xf97c_ff8c // selinuxfs
            | 0x4341_5d53 // smackfs
            | 0xde5e_81e4 // efivarfs
        ) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unsafe filesystem",
            ));
        }
        Ok(())
    }

    impl FileRoot {
        pub(crate) fn open(root: &Path) -> io::Result<Self> {
            Self::open_with(root, openat2)
        }

        fn open_with(root: &Path, opener: Opener) -> io::Result<Self> {
            Self::open_with_check(root, opener, check_filesystem)
        }

        fn open_with_check(
            root: &Path,
            opener: Opener,
            check: fn(RawFd) -> io::Result<()>,
        ) -> io::Result<Self> {
            // NO_SYMLINKS applies to every path component, including the root itself.
            let directory = opener(
                libc::AT_FDCWD,
                root.as_os_str(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
                RESOLVE_NO_SYMLINKS,
            )?;
            check(directory.as_raw_fd())?;
            // Probe the actual required confinement flags, never downgrade on failure.
            opener(
                directory.as_raw_fd(),
                OsStr::new("."),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
                CONFINED,
            )?;
            Ok(Self { root: directory })
        }

        /// Identity of the pinned root directory itself, for durable slot binding.
        pub(crate) fn dev_ino(&self) -> io::Result<(u64, u64)> {
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            // fstat reads the pinned O_PATH descriptor, never a replaceable path.
            if unsafe { libc::fstat(self.root.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            let stat = unsafe { stat.assume_init() };
            Ok((stat.st_dev as u64, stat.st_ino as u64))
        }

        /// Returns an O_PATH descriptor only for a regular file or directory. It cannot
        /// itself read data or trigger device/FIFO opens before type validation.
        pub(crate) fn resolve(&self, path: &Path) -> io::Result<File> {
            self.resolve_with_check(path, check_filesystem)
        }

        fn resolve_with_check(
            &self,
            path: &Path,
            check: fn(RawFd) -> io::Result<()>,
        ) -> io::Result<File> {
            components(path)?;
            let file = openat2(
                self.root.as_raw_fd(),
                path.as_os_str(),
                libc::O_PATH | libc::O_CLOEXEC,
                CONFINED,
            )?;
            check(file.as_raw_fd())?;
            let ty = file.metadata()?.file_type();
            if !ty.is_file() && !ty.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "unsafe file type",
                ));
            }
            Ok(file)
        }

        /// Validates and pins only the parent, not the final basename. In particular,
        /// checking a basename before rename or unlink does not make mutation race-safe.
        pub(crate) fn parent(&self, path: &Path) -> io::Result<(File, OsString)> {
            self.parent_with_check(path, check_filesystem)
        }

        fn parent_with_check(
            &self,
            path: &Path,
            check: fn(RawFd) -> io::Result<()>,
        ) -> io::Result<(File, OsString)> {
            let parts = components(path)?;
            let name = OsStr::from_bytes(parts[parts.len() - 1]).to_os_string();
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let directory = openat2(
                self.root.as_raw_fd(),
                parent.as_os_str(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
                CONFINED,
            )?;
            check(directory.as_raw_fd())?;
            Ok((directory, name))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn initialization_fails_closed_when_filesystem_check_is_unavailable() {
            fn unavailable(_: RawFd) -> io::Result<()> {
                check_filesystem(-1)
            }
            let error = match FileRoot::open_with_check(Path::new("."), openat2, unavailable) {
                Ok(_) => panic!("missing filesystem check was accepted"),
                Err(error) => error,
            };
            assert_eq!(error.raw_os_error(), Some(libc::EBADF));
            let root = FileRoot::open(Path::new(".")).unwrap();
            assert_eq!(
                root.resolve_with_check(Path::new("."), unavailable)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
            assert_eq!(
                root.resolve_with_check(Path::new("src"), unavailable)
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::EBADF)
            );
            assert_eq!(
                root.parent_with_check(Path::new("new"), unavailable)
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::EBADF)
            );
        }

        #[test]
        fn initialization_fails_closed_when_probe_is_unavailable() {
            fn fail_probe(dir: RawFd, path: &OsStr, flags: i32, resolve: u64) -> io::Result<File> {
                if resolve == CONFINED {
                    Err(io::Error::from_raw_os_error(libc::ENOSYS))
                } else {
                    openat2(dir, path, flags, resolve)
                }
            }
            let error = match FileRoot::open_with(Path::new("."), fail_probe) {
                Ok(_) => panic!("missing openat2 support was accepted"),
                Err(error) => error,
            };
            assert_eq!(error.raw_os_error(), Some(libc::ENOSYS));
        }
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
impl FileRoot {
    pub(crate) fn open(_root: &Path) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file roots require Linux openat2",
        ))
    }
    pub(crate) fn dev_ino(&self) -> io::Result<(u64, u64)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "file roots are supported only on Linux",
        ))
    }

    pub(crate) fn resolve(&self, _path: &Path) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file roots require Linux openat2",
        ))
    }
    pub(crate) fn parent(&self, _path: &Path) -> io::Result<(File, OsString)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file roots require Linux openat2",
        ))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{symlink, MetadataExt};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "herdr-file-root-{}-{}",
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
    fn resolves_safe_paths_and_relative_symlinks() {
        let f = Fixture::new();
        symlink("dir/file", f.0.join("root/link")).unwrap();
        symlink("../dir/file", f.0.join("root/dir/relative")).unwrap();
        let root = f.root();
        for path in ["dir", "dir/file", "link", "dir/relative"] {
            assert!(root.resolve(Path::new(path)).is_ok(), "{path}");
        }
        let (parent, name) = root.parent(Path::new("dir/new")).unwrap();
        assert!(parent.metadata().unwrap().is_dir());
        assert_eq!(name, "new");
        assert_eq!(root.parent(Path::new("new")).unwrap().1, "new");
    }

    #[test]
    fn rejects_escape_invalid_paths_and_replaced_symlink() {
        let f = Fixture::new();
        symlink("../outside", f.0.join("root/escape")).unwrap();
        symlink(f.0.join("root/dir/file"), f.0.join("root/absolute")).unwrap();
        symlink("dir/file", f.0.join("root/replace")).unwrap();
        let root = f.root();
        assert!(root.resolve(Path::new("replace")).is_ok());
        fs::remove_file(f.0.join("root/replace")).unwrap();
        symlink("../outside", f.0.join("root/replace")).unwrap();
        for path in [
            "escape",
            "absolute",
            "replace",
            "../outside",
            "/etc/passwd",
            "dir/../dir/file",
            "",
            ".",
            "dir//file",
            "dir/",
            "dir/./file",
        ] {
            assert!(root.resolve(Path::new(path)).is_err(), "{path}");
        }
        let nul = std::ffi::OsStr::from_bytes(b"dir/fi\0le");
        assert!(root.resolve(Path::new(nul)).is_err());
        for path in [
            "../outside",
            "dir/../x",
            "escape/x",
            "absolute/x",
            "",
            "dir/",
            "dir//x",
        ] {
            assert!(root.parent(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn rejects_symlinks_anywhere_in_configured_root() {
        let f = Fixture::new();
        symlink("root", f.0.join("root-link")).unwrap();
        assert!(FileRoot::open(&f.0.join("root-link")).is_err());
        assert!(FileRoot::open(&f.0.join("root-link/dir")).is_err());
    }

    #[test]
    fn rejects_special_files_and_magic_links() {
        let f = Fixture::new();
        let fifo = std::ffi::CString::new(f.0.join("root/fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        symlink("/proc/self/fd/0", f.0.join("root/magic")).unwrap();
        let socket = std::os::unix::net::UnixListener::bind(f.0.join("root/socket")).unwrap();
        let root = f.root();
        assert!(root.resolve(Path::new("fifo")).is_err());
        assert!(root.resolve(Path::new("socket")).is_err());
        assert!(root.resolve(Path::new("magic")).is_err());
        assert!(root.parent(Path::new("fifo/child")).is_err());
        drop(socket);
    }

    #[test]
    fn rejects_kernel_pseudofilesystem_roots_and_targets() {
        // A container may not mount procfs or sysfs at their conventional paths.
        for (path, magic, target) in [
            ("/proc", 0x9fa0, "proc/self/environ"),
            ("/sys", 0x62656572, "sys/kernel"),
        ] {
            let Ok(mount) = File::open(path) else {
                continue;
            };
            let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
            use std::os::fd::AsRawFd;
            assert_eq!(unsafe { libc::fstatfs(mount.as_raw_fd(), &mut stat) }, 0);
            if stat.f_type as u64 != magic {
                continue;
            }
            assert_eq!(
                FileRoot::open(Path::new(path)).err().unwrap().kind(),
                io::ErrorKind::PermissionDenied,
                "root {path}"
            );
            let root = FileRoot::open(Path::new("/")).unwrap();
            if Path::new(&format!("/{target}")).exists() {
                assert_eq!(
                    root.resolve(Path::new(target)).unwrap_err().kind(),
                    io::ErrorKind::PermissionDenied,
                    "target {target}"
                );
                if path == "/proc" {
                    assert_eq!(
                        root.read_file(Path::new(target), 1024).unwrap_err().kind(),
                        io::ErrorKind::PermissionDenied
                    );
                }
            }
            assert_eq!(
                root.list(Path::new(&path[1..]), 100).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
            assert_eq!(
                root.parent(Path::new(&format!("{path}/x")[1..]))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::PermissionDenied,
                "parent {path}"
            );
        }
    }

    #[test]
    fn concurrent_replacement_cannot_return_an_outside_descriptor() {
        let f = Fixture::new();
        let inside = fs::metadata(f.0.join("root/dir/file")).unwrap();
        let root_dir = fs::metadata(f.0.join("root")).unwrap();
        let outside = fs::metadata(f.0.join("outside")).unwrap();
        let inside_id = (inside.dev(), inside.ino());
        let root_id = (root_dir.dev(), root_dir.ino());
        let outside_id = (outside.dev(), outside.ino());
        assert_ne!(outside_id, inside_id);
        assert_ne!(outside_id, root_id);
        symlink("dir/file", f.0.join("root/race")).unwrap();
        let root = std::sync::Arc::new(f.root());
        let worker = std::sync::Arc::clone(&root);
        let reader = std::thread::spawn(move || {
            for _ in 0..1000 {
                if let Ok(file) = worker.resolve(Path::new("race")) {
                    let metadata = file.metadata().unwrap();
                    let id = (metadata.dev(), metadata.ino());
                    // A raced symlink lookup may resolve to the in-root parent directory.
                    // Only that directory or the inside file is an acceptable result.
                    assert!(id == root_id || id == inside_id, "unexpected inode: {id:?}");
                }
            }
        });
        for i in 0..1000 {
            let replacement = f.0.join("root/replacement");
            symlink(
                if i % 2 == 0 { "../outside" } else { "dir/file" },
                &replacement,
            )
            .unwrap();
            fs::rename(replacement, f.0.join("root/race")).unwrap();
        }
        reader.join().unwrap();
    }

    #[test]
    fn pins_root_and_parent_after_rename() {
        let f = Fixture::new();
        let root = f.root();
        let (parent, name) = root.parent(Path::new("dir/new")).unwrap();
        let original_inode = parent.metadata().unwrap().ino();
        fs::rename(f.0.join("root/dir"), f.0.join("moved")).unwrap();
        symlink("../", f.0.join("root/dir")).unwrap();
        assert_eq!(parent.metadata().unwrap().ino(), original_inode);
        assert!(root.parent(Path::new("dir/new")).is_err());
        assert_eq!(name, "new");
        fs::rename(f.0.join("root"), f.0.join("old-root")).unwrap();
        fs::create_dir(f.0.join("root")).unwrap();
        fs::write(f.0.join("root/decoy"), b"decoy").unwrap();
        assert!(root.resolve(Path::new("decoy")).is_err());
    }
}
