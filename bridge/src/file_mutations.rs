//! Confined descriptor-relative file mutations.
//!
//! Recursive copy and deletion walk pinned directories entry by entry, never
//! following symbolic links, with bounded depth, entry count and copied bytes.
//! A copy that exhausts a budget reports an error and leaves the entries copied
//! so far in place; it never removes them or the source.
//! Creation may leave a partial new file if writing fails; it never removes a
//! name that could have been replaced concurrently. Unlink and rename operate on the entry at
//! the validated name when the syscall executes, not a previously selected
//! inode. A concurrent replacement can also invalidate the type check.

use crate::file_root::FileRoot;
use std::io;
use std::path::Path;

const MAX_CREATE_BODY: usize = 8 * 1024 * 1024;
const MAX_DIR_ENTRIES: usize = 10_000;
const MAX_TREE_DEPTH: usize = 64;
const MAX_TREE_ENTRIES: usize = 50_000;
const MAX_TREE_BYTES: u64 = 100 * 1024 * 1024;

/// Shared limits for one recursive walk so a single request cannot traverse an
/// unbounded tree or copy an unbounded amount of data.
#[cfg(target_os = "linux")]
struct TreeBudget {
    entries: usize,
    bytes: u64,
}

#[cfg(target_os = "linux")]
impl Default for TreeBudget {
    fn default() -> Self {
        Self {
            entries: MAX_TREE_ENTRIES,
            bytes: 0,
        }
    }
}

#[cfg(target_os = "linux")]
impl TreeBudget {
    fn spend(&mut self, count: usize) -> io::Result<()> {
        if count > self.entries {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "tree exceeds entry limit",
            ));
        }
        self.entries -= count;
        Ok(())
    }

    fn spend_bytes(&mut self, bytes: u64) -> io::Result<()> {
        if bytes > MAX_TREE_BYTES - self.bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "tree exceeds byte limit",
            ));
        }
        self.bytes += bytes;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn depth_error() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "tree exceeds depth limit")
}

#[cfg(target_os = "linux")]
fn entry_mode(parent: &std::fs::File, name: &std::ffi::CStr) -> io::Result<libc::mode_t> {
    use std::os::fd::AsRawFd;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() }.st_mode & 0o7777)
}

#[cfg(target_os = "linux")]
fn read_link(parent: &std::fs::File, name: &std::ffi::CStr) -> io::Result<Vec<u8>> {
    use std::os::fd::AsRawFd;
    let mut buffer = vec![0u8; 4096];
    let read = unsafe {
        libc::readlinkat(
            parent.as_raw_fd(),
            name.as_ptr(),
            buffer.as_mut_ptr().cast::<libc::c_char>(),
            buffer.len(),
        )
    };
    if read < 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(read as usize);
    Ok(buffer)
}

#[cfg(target_os = "linux")]
fn entry_type(parent: &std::fs::File, name: &std::ffi::CStr) -> io::Result<libc::mode_t> {
    use std::os::fd::AsRawFd;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let kind = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
    if kind != libc::S_IFREG && kind != libc::S_IFDIR && kind != libc::S_IFLNK {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsafe file type",
        ));
    }
    Ok(kind)
}

#[cfg(target_os = "linux")]
fn entry_name(name: &std::ffi::OsStr) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
impl FileRoot {
    pub(crate) fn create_file(&self, path: &Path, body: &[u8]) -> io::Result<()> {
        use std::ffi::CString;
        use std::fs::File;
        use std::io::Write;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;

        if body.len() > MAX_CREATE_BODY {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "file body too large",
            ));
        }
        let (parent, name) = self.parent(path)?;
        let name = CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
        // O_EXCL makes collision detection atomic, including symlink collisions. The
        // mode is filtered by the process umask, matching files created by a shell.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o666,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(body)
    }

    pub(crate) fn create_directory(&self, path: &Path) -> io::Result<()> {
        use std::ffi::CString;
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;

        let (parent, name) = self.parent(path)?;
        let name = CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
        // 0o777 is filtered by the process umask, matching directories created by a shell.
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o777) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn remove_entry(&self, path: &Path) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let (parent, name) = self.parent(path)?;
        let name = entry_name(&name)?;
        let kind = entry_type(&parent, &name)?;
        let flags = if kind == libc::S_IFDIR {
            libc::AT_REMOVEDIR
        } else {
            0
        };
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn remove_tree(&self, path: &Path) -> io::Result<()> {
        if path.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "refusing to remove the root",
            ));
        }
        self.remove_tree_at(path, 0, &mut TreeBudget::default())
    }

    fn remove_tree_at(&self, path: &Path, depth: usize, budget: &mut TreeBudget) -> io::Result<()> {
        if depth > MAX_TREE_DEPTH {
            return Err(depth_error());
        }
        let (parent, name) = self.parent(path)?;
        let name = entry_name(&name)?;
        let kind = entry_type(&parent, &name)?;
        drop(parent);
        budget.spend(1)?;
        if kind != libc::S_IFDIR {
            return self.remove_entry(path);
        }
        for entry in self.list_typed(path, MAX_DIR_ENTRIES)? {
            self.remove_tree_at(&entry.path, depth + 1, budget)?;
        }
        self.remove_entry(path)
    }

    pub(crate) fn copy_tree(&self, source: &Path, destination: &Path) -> io::Result<()> {
        if source.as_os_str().is_empty() || destination.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "copy requires a source and destination path",
            ));
        }
        let inside = destination
            .strip_prefix(source)
            .is_ok_and(|rest| !rest.as_os_str().is_empty());
        if inside {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot copy a directory into itself",
            ));
        }
        self.copy_tree_at(source, destination, 0, &mut TreeBudget::default())
    }

    fn copy_tree_at(
        &self,
        source: &Path,
        destination: &Path,
        depth: usize,
        budget: &mut TreeBudget,
    ) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        if depth > MAX_TREE_DEPTH {
            return Err(depth_error());
        }
        let (parent, name) = self.parent(source)?;
        let name = entry_name(&name)?;
        let kind = entry_type(&parent, &name)?;
        let mode = entry_mode(&parent, &name)?;
        budget.spend(1)?;
        match kind {
            libc::S_IFREG => {
                let body = self.read_file(source, MAX_CREATE_BODY)?;
                budget.spend_bytes(body.len() as u64)?;
                self.create_file(destination, &body)?;
                let (dest_parent, dest_name) = self.parent(destination)?;
                let dest_name = entry_name(&dest_name)?;
                if unsafe { libc::fchmodat(dest_parent.as_raw_fd(), dest_name.as_ptr(), mode, 0) }
                    != 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }
            libc::S_IFDIR => {
                self.create_directory(destination)?;
                let (dest_parent, dest_name) = self.parent(destination)?;
                let dest_name = entry_name(&dest_name)?;
                if unsafe { libc::fchmodat(dest_parent.as_raw_fd(), dest_name.as_ptr(), mode, 0) }
                    != 0
                {
                    return Err(io::Error::last_os_error());
                }
                for entry in self.list_typed(source, MAX_DIR_ENTRIES)? {
                    let child = entry.path.file_name().ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidInput, "invalid entry name")
                    })?;
                    self.copy_tree_at(&entry.path, &destination.join(child), depth + 1, budget)?;
                }
                Ok(())
            }
            libc::S_IFLNK => {
                let target = read_link(&parent, &name)?;
                if target.first() == Some(&b'/') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "absolute symlink target is not supported",
                    ));
                }
                let (dest_parent, dest_name) = self.parent(destination)?;
                let dest_name = entry_name(&dest_name)?;
                if unsafe {
                    libc::symlinkat(
                        target.as_ptr().cast::<libc::c_char>(),
                        dest_parent.as_raw_fd(),
                        dest_name.as_ptr(),
                    )
                } != 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsafe file type",
            )),
        }
    }

    pub(crate) fn rename_entry(&self, source: &Path, destination: &Path) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let (source_parent, source_name) = self.parent(source)?;
        let source_name = entry_name(&source_name)?;
        let (destination_parent, destination_name) = self.parent(destination)?;
        let destination_name = entry_name(&destination_name)?;
        entry_type(&source_parent, &source_name)?;
        // RENAME_NOREPLACE is the only operation attempted, including on ENOSYS.
        if unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                source_parent.as_raw_fd(),
                source_name.as_ptr(),
                destination_parent.as_raw_fd(),
                destination_name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
impl FileRoot {
    pub(crate) fn create_file(&self, _path: &Path, _body: &[u8]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file mutations require Linux",
        ))
    }

    pub(crate) fn create_directory(&self, _path: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file mutations require Linux",
        ))
    }

    pub(crate) fn remove_entry(&self, _path: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file mutations require Linux",
        ))
    }

    pub(crate) fn rename_entry(&self, _source: &Path, _destination: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file mutations require Linux",
        ))
    }

    pub(crate) fn remove_tree(&self, _path: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file mutations require Linux",
        ))
    }

    pub(crate) fn copy_tree(&self, _source: &Path, _destination: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file mutations require Linux",
        ))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use crate::file_root::FileRoot;
    use std::ffi::{CString, OsStr};
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
                "herdr-mutations-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::create_dir(path.join("root")).unwrap();
            fs::create_dir(path.join("root/dir")).unwrap();
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
    fn creates_regular_files_and_single_directories_without_overwrite() {
        let f = Fixture::new();
        let root = f.root();
        root.create_file(Path::new("dir/file"), b"contents")
            .unwrap();
        assert_eq!(fs::read(f.0.join("root/dir/file")).unwrap(), b"contents");
        root.create_directory(Path::new("dir/subdir")).unwrap();
        assert!(f.0.join("root/dir/subdir").is_dir());
        assert!(root
            .create_file(Path::new("dir/file"), b"replacement")
            .is_err());
        assert_eq!(fs::read(f.0.join("root/dir/file")).unwrap(), b"contents");
        assert!(root.create_directory(Path::new("dir/subdir")).is_err());
        assert!(root.create_directory(Path::new("missing/child")).is_err());
        assert!(!f.0.join("root/missing").exists());
    }

    #[test]
    fn created_entries_follow_the_process_umask() {
        use std::os::unix::fs::PermissionsExt;
        static UMASK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = UMASK.lock().unwrap_or_else(|error| error.into_inner());
        let previous = unsafe { libc::umask(0o022) };
        let created = std::panic::catch_unwind(|| {
            let f = Fixture::new();
            let root = f.root();
            root.create_file(Path::new("dir/file"), b"contents")
                .unwrap();
            root.create_directory(Path::new("dir/subdir")).unwrap();
            let file = fs::metadata(f.0.join("root/dir/file"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let dir = fs::metadata(f.0.join("root/dir/subdir"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            (file, dir)
        });
        unsafe { libc::umask(previous) };
        assert_eq!(created.unwrap(), (0o644, 0o755));
    }

    #[test]
    fn removes_directory_trees_without_following_links() {
        let f = Fixture::new();
        let root = f.root();
        fs::create_dir_all(f.0.join("root/dir/nested/deeper")).unwrap();
        fs::write(f.0.join("root/dir/nested/deeper/file"), b"data").unwrap();
        symlink("../../../outside", f.0.join("root/dir/nested/link")).unwrap();
        root.remove_tree(Path::new("dir")).unwrap();
        assert!(!f.0.join("root/dir").exists());
        assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
        assert!(root.remove_tree(Path::new("")).is_err());
        assert!(root.remove_tree(Path::new("dir")).is_err());
    }

    #[test]
    fn copies_trees_without_following_links_or_overwriting() {
        let f = Fixture::new();
        let root = f.root();
        fs::create_dir_all(f.0.join("root/src/nested")).unwrap();
        fs::write(f.0.join("root/src/nested/file"), b"payload").unwrap();
        symlink("nested/file", f.0.join("root/src/relative-link")).unwrap();
        root.copy_tree(Path::new("src"), Path::new("dir/copied"))
            .unwrap();
        assert_eq!(
            fs::read(f.0.join("root/dir/copied/nested/file")).unwrap(),
            b"payload"
        );
        assert_eq!(
            fs::read_link(f.0.join("root/dir/copied/relative-link")).unwrap(),
            PathBuf::from("nested/file")
        );
        assert!(root
            .copy_tree(Path::new("src"), Path::new("dir/copied"))
            .is_err());
        assert!(root
            .copy_tree(Path::new("src"), Path::new("dir/../escaped"))
            .is_err());
        assert!(root
            .copy_tree(Path::new(""), Path::new("dir/empty"))
            .is_err());
        symlink("/proc/self/environ", f.0.join("root/src/absolute")).unwrap();
        assert!(root
            .copy_tree(Path::new("src"), Path::new("dir/second"))
            .is_err());
        assert!(!f.0.join("root/dir/second/absolute").exists());
    }

    #[test]
    fn rejects_copying_a_directory_into_itself_and_keeps_escaping_links_inert() {
        let f = Fixture::new();
        let root = f.root();
        fs::create_dir_all(f.0.join("root/src/nested")).unwrap();
        fs::write(f.0.join("root/src/nested/file"), b"payload").unwrap();
        assert!(root
            .copy_tree(Path::new("src"), Path::new("src/nested/into"))
            .is_err());
        assert!(!f.0.join("root/src/nested/into").exists());
        symlink("../outside", f.0.join("root/src/escaping")).unwrap();
        root.copy_tree(Path::new("src"), Path::new("dir/copied"))
            .unwrap();
        assert_eq!(
            fs::read_link(f.0.join("root/dir/copied/escaping")).unwrap(),
            PathBuf::from("../outside")
        );
        assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
    }

    #[test]
    fn reports_budget_exhaustion_after_copying_part_of_a_tree() {
        use std::io::Write;
        let f = Fixture::new();
        let root = f.root();
        fs::create_dir(f.0.join("root/large")).unwrap();
        for index in 0..13 {
            let mut file = fs::File::create(f.0.join(format!("root/large/{index}"))).unwrap();
            file.write_all(&vec![b'x'; 8 * 1024 * 1024]).unwrap();
        }
        let error = root
            .copy_tree(Path::new("large"), Path::new("dir/large"))
            .unwrap_err();
        assert_eq!(error.to_string(), "tree exceeds byte limit");
        assert!(f.0.join("root/dir/large/0").exists());
        assert!(f.0.join("root/large/12").exists());
    }

    #[test]
    fn bounds_recursive_walks_by_depth() {
        let f = Fixture::new();
        let root = f.root();
        let mut path = PathBuf::from("root/dir");
        for _ in 0..70 {
            path.push("d");
            fs::create_dir(f.0.join(&path)).unwrap();
        }
        assert!(root.remove_tree(Path::new("dir")).is_err());
        assert!(f.0.join("root/dir/d").is_dir());
    }

    #[test]
    fn rejects_invalid_names_parent_escapes_and_symlink_collisions() {
        let f = Fixture::new();
        symlink("../outside", f.0.join("root/link")).unwrap();
        symlink("../..", f.0.join("root/escape")).unwrap();
        symlink("dir", f.0.join("root/internal")).unwrap();
        symlink("/proc/self/fd", f.0.join("root/magic")).unwrap();
        let root = f.root();
        for path in [
            "",
            ".",
            "..",
            "../outside",
            "/tmp/escape",
            "dir/../x",
            "dir//x",
            "dir/./x",
            "dir/",
            "escape/x",
            "magic/0/x",
        ] {
            assert!(
                root.create_file(Path::new(path), b"bad").is_err(),
                "{path:?}"
            );
            assert!(root.create_directory(Path::new(path)).is_err(), "{path:?}");
        }
        let nul = Path::new(OsStr::from_bytes(b"dir/nu\0l"));
        assert!(root.create_file(nul, b"bad").is_err());
        assert!(root.create_directory(nul).is_err());
        assert!(root.create_file(Path::new("link"), b"bad").is_err());
        assert!(root.create_directory(Path::new("link")).is_err());
        root.create_file(Path::new("internal/good"), b"inside")
            .unwrap();
        assert_eq!(fs::read(f.0.join("root/dir/good")).unwrap(), b"inside");
        assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
        assert!(fs::symlink_metadata(f.0.join("root/link"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn unlinks_files_links_and_empty_directories_without_following_links() {
        let f = Fixture::new();
        let root = f.root();
        fs::write(f.0.join("root/file"), b"content").unwrap();
        fs::create_dir(f.0.join("root/empty")).unwrap();
        fs::write(f.0.join("root/dir/child"), b"keep").unwrap();
        for (name, target) in [
            ("external", "../outside"),
            ("absolute", "/etc/passwd"),
            ("magic", "/proc/self/fd/0"),
            ("dangling", "missing"),
        ] {
            symlink(target, f.0.join("root").join(name)).unwrap();
            root.remove_entry(Path::new(name)).unwrap();
            assert!(fs::symlink_metadata(f.0.join("root").join(name)).is_err());
        }
        root.remove_entry(Path::new("file")).unwrap();
        root.remove_entry(Path::new("empty")).unwrap();
        assert!(!f.0.join("root/file").exists());
        assert!(!f.0.join("root/empty").exists());
        assert!(root.remove_entry(Path::new("dir")).is_err());
        assert_eq!(fs::read(f.0.join("root/dir/child")).unwrap(), b"keep");
        assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
    }

    #[test]
    fn renames_entries_without_overwrite_or_following_final_symlinks() {
        let f = Fixture::new();
        let root = f.root();
        fs::write(f.0.join("root/source"), b"source").unwrap();
        fs::write(f.0.join("root/target"), b"target").unwrap();
        symlink("../outside", f.0.join("root/link")).unwrap();
        symlink("missing", f.0.join("root/link-target")).unwrap();
        assert!(root
            .rename_entry(Path::new("source"), Path::new("target"))
            .is_err());
        assert!(root
            .rename_entry(Path::new("source"), Path::new("link-target"))
            .is_err());
        assert_eq!(fs::read(f.0.join("root/source")).unwrap(), b"source");
        assert_eq!(fs::read(f.0.join("root/target")).unwrap(), b"target");
        root.rename_entry(Path::new("link"), Path::new("dir/moved-link"))
            .unwrap();
        assert_eq!(
            fs::read_link(f.0.join("root/dir/moved-link")).unwrap(),
            Path::new("../outside")
        );
        root.rename_entry(Path::new("source"), Path::new("dir/moved"))
            .unwrap();
        assert_eq!(fs::read(f.0.join("root/dir/moved")).unwrap(), b"source");
        root.rename_entry(Path::new("dir"), Path::new("moved-dir"))
            .unwrap();
        assert!(f.0.join("root/moved-dir/moved").exists());
        assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
    }

    #[test]
    fn mutations_reject_unsafe_names_parent_escapes_and_special_files() {
        let f = Fixture::new();
        let root = f.root();
        fs::write(f.0.join("root/file"), b"keep").unwrap();
        symlink("../..", f.0.join("root/escape")).unwrap();
        symlink("/proc/self/fd", f.0.join("root/magic")).unwrap();
        let fifo = CString::new(f.0.join("root/fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let _socket = std::os::unix::net::UnixListener::bind(f.0.join("root/socket")).unwrap();
        for name in [
            "",
            ".",
            "..",
            "../outside",
            "/tmp/escape",
            "dir/../file",
            "dir//file",
            "dir/./file",
            "dir/",
            "escape/outside",
            "magic/0/x",
            "fifo",
            "socket",
        ] {
            assert!(root.remove_entry(Path::new(name)).is_err(), "{name:?}");
            assert!(
                root.rename_entry(Path::new(name), Path::new("new"))
                    .is_err(),
                "{name:?}"
            );
        }
        for name in [
            "",
            ".",
            "..",
            "../outside",
            "/tmp/escape",
            "dir/../file",
            "dir//file",
            "dir/./file",
            "dir/",
            "escape/outside",
            "magic/0/x",
            "fifo",
            "socket",
        ] {
            assert!(
                root.rename_entry(Path::new("file"), Path::new(name))
                    .is_err(),
                "{name:?}"
            );
        }
        let nul = Path::new(OsStr::from_bytes(b"dir/nu\0l"));
        assert!(root.remove_entry(nul).is_err());
        assert!(root.rename_entry(nul, Path::new("new")).is_err());
        assert!(root.rename_entry(Path::new("file"), nul).is_err());
        assert_eq!(fs::read(f.0.join("root/file")).unwrap(), b"keep");
        assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"outside");
        assert!(fs::symlink_metadata(f.0.join("root/fifo")).is_ok());
        assert!(fs::symlink_metadata(f.0.join("root/socket")).is_ok());
        assert!(!f.0.join("root/new").exists());
    }

    #[test]
    fn bounds_body_before_creating_and_never_opens_special_collisions() {
        let f = Fixture::new();
        let root = f.root();
        let fifo = CString::new(f.0.join("root/fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let _socket = std::os::unix::net::UnixListener::bind(f.0.join("root/socket")).unwrap();
        for name in ["fifo", "socket"] {
            assert!(root.create_file(Path::new(name), b"bad").is_err());
            assert!(root.create_directory(Path::new(name)).is_err());
            assert!(fs::symlink_metadata(f.0.join("root").join(name)).is_ok());
        }
        let body = vec![b'x'; super::MAX_CREATE_BODY];
        root.create_file(Path::new("max"), &body).unwrap();
        assert_eq!(
            fs::metadata(f.0.join("root/max")).unwrap().len(),
            body.len() as u64
        );
        let oversized = vec![b'x'; super::MAX_CREATE_BODY + 1];
        assert!(root.create_file(Path::new("too-big"), &oversized).is_err());
        assert!(!f.0.join("root/too-big").exists());
    }
}
