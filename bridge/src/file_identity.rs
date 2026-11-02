//! Persistent identities are diagnostics, not authentication or permission to replay drafts.
//! Every bind gets a new live identity. A caller must require explicit user confirmation
//! before associating an old draft with any new binding, including after a restart.

use std::io;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Binding {
    pub bridge_id: String,
    pub root_id: String,
    pub live_binding: String,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;
    use std::ffi::CString;
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    const MAX_STATE: u64 = 1024 * 1024;
    const MAX_ROOTS: usize = 1024;
    const MARKER: &[u8] = b"herdr-file-identity-v1\n";

    pub(super) trait RandomSource {
        fn fill(&mut self, bytes: &mut [u8]) -> io::Result<()>;
    }
    struct SystemRandom;
    impl RandomSource for SystemRandom {
        fn fill(&mut self, mut bytes: &mut [u8]) -> io::Result<()> {
            while !bytes.is_empty() {
                let result = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
                if result < 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(err);
                }
                if result == 0 {
                    return Err(io::Error::other("random source returned no bytes"));
                }
                bytes = &mut bytes[result as usize..];
            }
            Ok(())
        }
    }
    fn id(random: &mut impl RandomSource) -> io::Result<String> {
        let mut bytes = [0u8; 32];
        random.fill(&mut bytes)?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    fn valid_id(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    fn invalid(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, message)
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct State {
        version: u8,
        bridge_id: String,
        roots: BTreeMap<String, Root>,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Root {
        id: String,
        path: Vec<u8>,
        dev: u64,
        ino: u64,
    }
    impl State {
        fn validate(&self) -> io::Result<()> {
            if self.version != 1 || !valid_id(&self.bridge_id) || self.roots.len() > MAX_ROOTS {
                return Err(invalid("invalid identity store"));
            }
            for (slot, root) in &self.roots {
                if slot.is_empty()
                    || slot.len() > 256
                    || !valid_id(&root.id)
                    || root.path.is_empty()
                    || root.path.len() > 4096
                    || root.path[0] != b'/'
                    || root.path.contains(&0)
                {
                    return Err(invalid("invalid identity root"));
                }
            }
            Ok(())
        }
    }

    pub(crate) struct IdentityStore {
        dir: File,
    }
    impl IdentityStore {
        pub(crate) fn open(path: &Path) -> io::Result<Self> {
            Self::open_with_random(path, &mut SystemRandom)
        }
        pub(super) fn open_with_random(
            path: &Path,
            random: &mut impl RandomSource,
        ) -> io::Result<Self> {
            let dir = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)?;
            check_private(&dir, true)?;
            let store = Self { dir };
            let mut lock = store.lock()?;
            let mut marker = Vec::new();
            (&mut lock)
                .take((MARKER.len() + 1) as u64)
                .read_to_end(&mut marker)?;
            if !marker.is_empty() && marker != MARKER {
                return Err(invalid("invalid identity lock marker"));
            }
            match store.read_state() {
                Ok(_) => {
                    if marker.is_empty() {
                        return Err(invalid("identity state without initialization marker"));
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::NotFound && marker.is_empty() => {
                    // Record intent first: interruption cannot silently replace an existing identity.
                    let bridge_id = id(random)?;
                    lock.write_all(MARKER)?;
                    lock.sync_all()?;
                    store.dir.sync_all()?;
                    store.write_state(
                        &State {
                            version: 1,
                            bridge_id,
                            roots: BTreeMap::new(),
                        },
                        random,
                    )?;
                }
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    return Err(invalid("identity state is missing"))
                }
                Err(err) => return Err(err),
            }
            Ok(store)
        }
        pub(crate) fn bind(
            &self,
            slot: &str,
            path: &Path,
            dev: u64,
            ino: u64,
        ) -> io::Result<Binding> {
            self.bind_with_random(slot, path, dev, ino, &mut SystemRandom)
        }
        pub(super) fn bind_with_random(
            &self,
            slot: &str,
            path: &Path,
            dev: u64,
            ino: u64,
            random: &mut impl RandomSource,
        ) -> io::Result<Binding> {
            let path = path.as_os_str().as_bytes();
            if slot.is_empty()
                || slot.len() > 256
                || path.is_empty()
                || path.len() > 4096
                || path[0] != b'/'
                || path.contains(&0)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid root slot or absolute path",
                ));
            }
            let mut lock = self.lock()?;
            let mut marker = Vec::new();
            (&mut lock)
                .take((MARKER.len() + 1) as u64)
                .read_to_end(&mut marker)?;
            if marker != MARKER {
                return Err(invalid("invalid identity lock marker"));
            }
            let mut state = self.read_state()?;
            let changed = match state.roots.get(slot) {
                Some(root) => root.path != path || root.dev != dev || root.ino != ino,
                None => true,
            };
            let live_binding = id(random)?;
            if changed {
                if !state.roots.contains_key(slot) && state.roots.len() == MAX_ROOTS {
                    return Err(invalid("too many identity roots"));
                }
                let root_id = id(random)?;
                state.roots.insert(
                    slot.to_owned(),
                    Root {
                        id: root_id,
                        path: path.to_vec(),
                        dev,
                        ino,
                    },
                );
                self.write_state(&state, random)?;
            }
            Ok(Binding {
                bridge_id: state.bridge_id,
                root_id: state.roots[slot].id.clone(),
                live_binding,
            })
        }
        fn lock(&self) -> io::Result<File> {
            let file = self.open_file("identity.lock", libc::O_RDWR | libc::O_CREAT, 0o600)?;
            check_private(&file, false)?;
            loop {
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                    return Ok(file);
                }
                let err = io::Error::last_os_error();
                if err.kind() != io::ErrorKind::Interrupted {
                    return Err(err);
                }
            }
        }
        fn open_file(&self, name: &str, flags: i32, mode: libc::mode_t) -> io::Result<File> {
            let name = CString::new(name).map_err(|_| invalid("invalid identity filename"))?;
            let fd = unsafe {
                libc::openat(
                    self.dir.as_raw_fd(),
                    name.as_ptr(),
                    flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                    mode,
                )
            };
            if fd < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(unsafe { File::from_raw_fd(fd) })
            }
        }
        fn read_state(&self) -> io::Result<State> {
            let file = self.open_file("identity.json", libc::O_RDONLY, 0)?;
            check_private(&file, false)?;
            let mut bytes = Vec::new();
            file.take(MAX_STATE + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_STATE {
                return Err(invalid("identity store too large"));
            }
            let state: State =
                serde_json::from_slice(&bytes).map_err(|_| invalid("invalid identity store"))?;
            state.validate()?;
            Ok(state)
        }
        fn write_state(&self, state: &State, random: &mut impl RandomSource) -> io::Result<()> {
            let bytes = serde_json::to_vec(state)
                .map_err(|_| invalid("could not encode identity store"))?;
            if bytes.len() as u64 > MAX_STATE {
                return Err(invalid("identity store too large"));
            }
            let name = format!(".identity-{}.tmp", id(random)?);
            let mut file =
                self.open_file(&name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)?;
            let temp = CString::new(name).unwrap();
            let dest = CString::new("identity.json").unwrap();
            let result = (|| {
                check_private(&file, false)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                if unsafe {
                    libc::renameat(
                        self.dir.as_raw_fd(),
                        temp.as_ptr(),
                        self.dir.as_raw_fd(),
                        dest.as_ptr(),
                    )
                } != 0
                {
                    return Err(io::Error::last_os_error());
                }
                self.dir.sync_all()
            })();
            if result.is_err() {
                unsafe {
                    libc::unlinkat(self.dir.as_raw_fd(), temp.as_ptr(), 0);
                }
            }
            result
        }
    }
    fn check_private(file: &File, directory: bool) -> io::Result<()> {
        let meta = file.metadata()?;
        let correct_type = if directory {
            meta.is_dir()
        } else {
            meta.is_file() && meta.nlink() == 1
        };
        if !correct_type
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "identity storage is not private",
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub(crate) use linux::IdentityStore;
#[cfg(all(test, target_os = "linux"))]
use linux::RandomSource;

#[cfg(not(target_os = "linux"))]
pub(crate) struct IdentityStore;
#[cfg(not(target_os = "linux"))]
impl IdentityStore {
    pub(crate) fn open(_: &Path) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "file identity is only supported on Linux",
        ))
    }
    pub(crate) fn bind(&self, _: &str, _: &Path, _: u64, _: u64) -> io::Result<Binding> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "file identity is only supported on Linux",
        ))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{self, Read, Write};
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "herdr-identity-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn bind(dir: &Path, slot: &str, path: &str, dev: u64, ino: u64) -> io::Result<Binding> {
        IdentityStore::open(dir)?.bind(slot, Path::new(path), dev, ino)
    }

    #[test]
    fn persistence_rotation_and_fresh_bindings() {
        let dir = TempDir::new();
        let first = bind(&dir.0, "one", "/root", 1, 2).unwrap();
        let again = bind(&dir.0, "one", "/root", 1, 2).unwrap();
        assert_eq!(first.bridge_id, again.bridge_id);
        assert_eq!(first.root_id, again.root_id);
        assert_ne!(first.live_binding, again.live_binding);
        let other = bind(&dir.0, "two", "/root", 1, 2).unwrap();
        assert_eq!(first.bridge_id, other.bridge_id);
        assert_ne!(first.root_id, other.root_id);
        let moved = bind(&dir.0, "one", "/other", 1, 2).unwrap();
        assert_ne!(first.root_id, moved.root_id);
        let device = bind(&dir.0, "one", "/other", 3, 2).unwrap();
        assert_ne!(moved.root_id, device.root_id);
        let inode = bind(&dir.0, "one", "/other", 3, 4).unwrap();
        assert_ne!(device.root_id, inode.root_id);
        assert!(bind(&dir.0, "one", "relative", 1, 2).is_err());
    }

    #[test]
    fn corruption_missing_state_and_insecure_files_fail_closed() {
        let dir = TempDir::new();
        bind(&dir.0, "root", "/root", 1, 2).unwrap();
        let state = dir.0.join("identity.json");
        fs::write(&state, b"{broken").unwrap();
        assert!(bind(&dir.0, "root", "/root", 1, 2).is_err());
        assert_eq!(fs::read(&state).unwrap(), b"{broken");
        fs::remove_file(&state).unwrap();
        assert!(bind(&dir.0, "root", "/root", 1, 2).is_err());
    }

    #[test]
    fn oversized_and_insecure_state_are_rejected() {
        let dir = TempDir::new();
        bind(&dir.0, "root", "/root", 1, 2).unwrap();
        let state = dir.0.join("identity.json");
        fs::write(&state, vec![b'x'; 1024 * 1024 + 1]).unwrap();
        assert!(bind(&dir.0, "root", "/root", 1, 2).is_err());
        fs::set_permissions(&state, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(bind(&dir.0, "root", "/root", 1, 2).is_err());
    }

    #[test]
    fn symlink_and_storage_failures_are_rejected() {
        let dir = TempDir::new();
        let target = dir.0.join("target");
        fs::write(&target, b"untouched").unwrap();
        symlink(&target, dir.0.join("identity.json")).unwrap();
        assert!(bind(&dir.0, "root", "/root", 1, 2).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"untouched");
        assert!(IdentityStore::open(&dir.0.join("missing")).is_err());
        let insecure = TempDir::new();
        fs::set_permissions(&insecure.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(IdentityStore::open(&insecure.0).is_err());
        let link_dir = TempDir::new();
        symlink(&target, link_dir.0.join("identity.lock")).unwrap();
        assert!(IdentityStore::open(&link_dir.0).is_err());
    }

    #[test]
    fn concurrent_startup_serializes_updates() {
        let dir = TempDir::new();
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let path = dir.0.clone();
                thread::spawn(move || bind(&path, &format!("slot-{i}"), "/root", 1, i).unwrap())
            })
            .collect();
        let values: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        for (i, value) in values.iter().enumerate() {
            assert_eq!(value.bridge_id, values[0].bridge_id);
            let again = bind(&dir.0, &format!("slot-{i}"), "/root", 1, i as u64).unwrap();
            assert_eq!(value.root_id, again.root_id);
        }
    }

    struct BrokenRandom;
    impl RandomSource for BrokenRandom {
        fn fill(&mut self, _: &mut [u8]) -> io::Result<()> {
            Err(io::Error::other("random failed"))
        }
    }
    #[test]
    fn random_failures_are_propagated_without_creating_state() {
        let dir = TempDir::new();
        let err = IdentityStore::open_with_random(&dir.0, &mut BrokenRandom)
            .err()
            .unwrap();
        assert_eq!(err.to_string(), "random failed");
        assert!(!dir.0.join("identity.json").exists());
        let store = IdentityStore::open(&dir.0).unwrap();
        let before = fs::read(dir.0.join("identity.json")).unwrap();
        let err = store
            .bind_with_random("root", Path::new("/root"), 1, 2, &mut BrokenRandom)
            .unwrap_err();
        assert_eq!(err.to_string(), "random failed");
        assert_eq!(fs::read(dir.0.join("identity.json")).unwrap(), before);
    }

    #[test]
    #[ignore]
    fn process_worker() {
        let mut input = String::new();
        io::stdin().read_to_string(&mut input).unwrap();
        let mut parts = input.lines();
        let dir = Path::new(parts.next().unwrap());
        let slot = parts.next().unwrap();
        let value = bind(dir, slot, "/root", 7, 8).unwrap();
        eprintln!("identity-result:{}:{}", value.bridge_id, value.root_id);
    }

    #[test]
    fn separate_processes_serialize_startup() {
        let dir = TempDir::new();
        let mut children = Vec::new();
        for i in 0..8 {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "--nocapture",
                    "file_identity::tests::process_worker",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            write!(
                child.stdin.take().unwrap(),
                "{}\nslot-{i}\n",
                dir.0.display()
            )
            .unwrap();
            children.push(child);
        }
        let mut first = None;
        for (i, child) in children.into_iter().enumerate() {
            let output = child.wait_with_output().unwrap();
            let stderr = String::from_utf8(output.stderr).unwrap();
            assert!(output.status.success(), "{stderr}");
            let result = stderr
                .lines()
                .find_map(|line| line.strip_prefix("identity-result:"))
                .unwrap();
            let (bridge_id, root_id) = result.split_once(':').unwrap();
            let value = bind(&dir.0, &format!("slot-{i}"), "/root", 7, 8).unwrap();
            assert_eq!(value.bridge_id, bridge_id);
            assert_eq!(value.root_id, root_id);
            if let Some((ref first_bridge, ref first_root)) = first {
                assert_eq!(&value.bridge_id, first_bridge);
                assert_ne!(&value.root_id, first_root);
            } else {
                first = Some((value.bridge_id, value.root_id));
            }
        }
    }
}
