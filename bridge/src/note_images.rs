use std::io;
use std::path::Path;

pub(crate) const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_STORAGE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_STORAGE_FILES: u64 = 1024;

#[derive(Debug)]
pub(crate) enum SaveError {
    QuotaExceeded,
    Io(io::Error),
}

impl From<io::Error> for SaveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub(crate) fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn extension(bytes: &[u8]) -> Option<&'static str> {
    match image_type(bytes)? {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn valid_id(id: &str) -> bool {
    let Some((token, extension)) = id.split_once('.') else {
        return false;
    };
    token.len() == 32
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(extension, "png" | "jpg" | "gif" | "webp")
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    fn directory(path: &Path, create: bool) -> io::Result<File> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing notes directory")
        })?;
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)?;
        let name = CString::new("note-images").unwrap();
        if create {
            let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
            if result != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
        }
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let directory = unsafe { File::from_raw_fd(fd) };
        let metadata = directory.metadata()?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "note image directory has a different owner",
            ));
        }
        if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(directory)
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn errno_location() -> io::Result<*mut libc::c_int> {
        Ok(unsafe { libc::__errno_location() })
    }

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    fn errno_location() -> io::Result<*mut libc::c_int> {
        Ok(unsafe { libc::__error() })
    }

    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd"
    )))]
    fn errno_location() -> io::Result<*mut libc::c_int> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "note image quota is unavailable on this platform",
        ))
    }

    struct DirectoryStream(*mut libc::DIR);
    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }

    fn usage(directory: &File) -> io::Result<(u64, u64)> {
        let errno = errno_location()?;
        let dot = CString::new(".").unwrap();
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error);
        }
        let stream = DirectoryStream(stream);
        let mut total_bytes = 0u64;
        let mut total_files = 0u64;
        loop {
            unsafe {
                *errno = 0;
            }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                let error = unsafe { *errno };
                if error != 0 {
                    return Err(io::Error::from_raw_os_error(error));
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            let metadata = unsafe { metadata.assume_init() };
            if metadata.st_mode & libc::S_IFMT == libc::S_IFREG {
                total_files = total_files.saturating_add(1);
                total_bytes = total_bytes.saturating_add(metadata.st_size.max(0) as u64);
            }
        }
        Ok((total_bytes, total_files))
    }

    pub(crate) fn save(path: &Path, bytes: &[u8]) -> Result<String, SaveError> {
        let extension = extension(bytes).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "unsupported image format")
        })?;
        let dir = directory(path, true)?;
        // Lock the directory inode itself so every bridge process shares the same lock.
        crate::store_util::lock_file(&dir)?;
        let (used_bytes, used_files) = usage(&dir)?;
        if used_files >= MAX_STORAGE_FILES
            || used_bytes.saturating_add(bytes.len() as u64) > MAX_STORAGE_BYTES
        {
            return Err(SaveError::QuotaExceeded);
        }
        let mut random = File::open("/dev/urandom")?;
        for _ in 0..16 {
            let mut token = [0u8; 16];
            random.read_exact(&mut token)?;
            let id = format!(
                "{}.{extension}",
                token.iter().map(|b| format!("{b:02x}")).collect::<String>()
            );
            let name = CString::new(id.as_str()).unwrap();
            let fd = unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::AlreadyExists {
                    continue;
                }
                return Err(error.into());
            }
            let mut file = unsafe { File::from_raw_fd(fd) };
            if let Err(error) = file
                .write_all(bytes)
                .and_then(|()| file.sync_all())
                .and_then(|()| dir.sync_all())
            {
                if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::Other,
                        format!(
                            "failed to remove incomplete note image: {} (write error: {error})",
                            io::Error::last_os_error()
                        ),
                    )
                    .into());
                }
                return Err(error.into());
            }
            return Ok(id);
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate note image id",
        )
        .into())
    }

    pub(crate) fn load(path: &Path, id: &str) -> io::Result<Vec<u8>> {
        if !valid_id(id) {
            return Err(io::ErrorKind::NotFound.into());
        }
        let dir = directory(path, false)?;
        let name = CString::new(id).unwrap();
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_BYTES as u64 {
            return Err(io::ErrorKind::NotFound.into());
        }
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_BYTES || extension(&bytes) != id.split_once('.').map(|(_, ext)| ext) {
            return Err(io::ErrorKind::NotFound.into());
        }
        Ok(bytes)
    }
}

#[cfg(unix)]
pub(crate) use unix::{load, save};

#[cfg(not(unix))]
pub(crate) fn save(_path: &Path, _bytes: &[u8]) -> Result<String, SaveError> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "note images require secure directory-relative file access",
    )
    .into())
}

#[cfg(not(unix))]
pub(crate) fn load(_path: &Path, _id: &str) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "note images require secure directory-relative file access",
    ))
}
