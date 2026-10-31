use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

use crate::store_util::{default_store_dir, ensure_private_dir, lock_file};

pub const MAX_BYTES: usize = 1024 * 1024;
const BUILTINS: [&str; 5] = ["abort", "compact", "new-session", "resume", "chat-log"];
const ICONS: [&str; 12] = [
    "circle-stop",
    "archive",
    "plus",
    "history",
    "message-square-text",
    "star",
    "zap",
    "terminal",
    "code",
    "bookmark",
    "play",
    "send",
];
static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn default_filename(host: &str, port: u16) -> String {
    let encoded: String = host.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
    format!("{encoded}-{port}.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ButtonsState {
    pub schema_version: u32,
    pub revision: u64,
    pub buttons: Vec<Button>,
    pub pinned: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Button {
    pub id: String,
    pub title: String,
    pub icon: Icon,
    pub action: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Icon {
    Lucide { name: String },
    Glyph { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Action {
    Builtin { id: String },
    Prompt { text: String, delivery: Delivery },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    Insert,
    Send,
}

impl Default for ButtonsState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            buttons: vec![],
            pinned: BUILTINS.iter().map(|id| (*id).to_string()).collect(),
        }
    }
}

fn safe_text(text: &str, max: usize, newline: bool) -> bool {
    !text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').is_empty()
        && text.chars().count() <= max && text.chars().all(|c| {
        (!c.is_control() || (newline && c == '\n'))
            && !matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    })
}

impl ButtonsState {
    fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != 1 || self.buttons.len() > 64 || self.pinned.len() > 69 {
            return Err("invalid state version or size");
        }
        let mut ids: HashSet<&str> = BUILTINS.into_iter().collect();
        for button in &self.buttons {
            let suffix = button
                .id
                .strip_prefix("custom-")
                .ok_or("invalid button id")?;
            if suffix.is_empty()
                || button.id.len() > 128
                || !suffix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                || !ids.insert(&button.id)
            {
                return Err("invalid or duplicate button id");
            }
            if !safe_text(&button.title, 80, false) {
                return Err("invalid title");
            }
            match &button.icon {
                Icon::Lucide { name } if ICONS.contains(&name.as_str()) => {}
                Icon::Glyph { text } if safe_text(text, 16, false) => {}
                _ => return Err("invalid icon"),
            }
            match &button.action {
                Action::Builtin { id } if BUILTINS.contains(&id.as_str()) => {}
                Action::Prompt { text, .. }
                    if text.len() <= 8192 && safe_text(text, 8192, true) => {}
                _ => return Err("invalid action"),
            }
        }
        let mut pinned = HashSet::new();
        if self
            .pinned
            .iter()
            .any(|id| !ids.contains(id.as_str()) || !pinned.insert(id))
        {
            return Err("invalid or duplicate pin");
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum StoreError {
    Invalid(String),
    Corrupt(String),
    Conflict,
    Io(io::Error),
}
impl From<io::Error> for StoreError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Clone)]
pub struct ButtonsStore {
    path: PathBuf,
}

impl ButtonsStore {
    pub fn configured(host: &str, port: u16, explicit: Option<PathBuf>) -> Option<Self> {
        if !cfg!(unix) {
            return None;
        }
        let path = explicit
            .or_else(|| crate::store_util::non_empty_env_path("HERDR_WEB_PI_SIDEPANEL_BUTTONS"));
        if path.is_none() && port == 0 {
            return None;
        }
        let path = path.unwrap_or_else(|| {
            default_store_dir(
                "HERDR_WEB_PI_SIDEPANEL_BUTTONS_DIR",
                "pi-sidepanel-buttons",
                "herdr-web-pi-sidepanel-buttons",
            )
            .join(default_filename(host, port))
        });
        Some(Self { path })
    }

    fn lock(&self) -> Result<(File, PathBuf), StoreError> {
        let parent = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if !parent.exists() {
            ensure_private_dir(parent)?;
        }
        let parent = fs::canonicalize(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(&parent)?.permissions().mode() & 0o077 != 0 {
                return Err(StoreError::Io(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "store directory must be private",
                )));
            }
        }
        let name = self.path.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "store filename is required")
        })?;
        let path = parent.join(name);
        let mut lock_name = name.to_os_string();
        lock_name.push(".lock");
        let lock_path = parent.join(lock_name);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
        }
        let file = options.open(lock_path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(
                io::Error::new(io::ErrorKind::InvalidData, "lock must be a regular file").into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.nlink() != 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "lock must not have multiple links",
                )
                .into());
            }
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        lock_file(&file)?;
        Ok((file, path))
    }

    fn read_locked(&self, path: &Path) -> Result<ButtonsState, StoreError> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
        }
        let file = match options.open(path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(ButtonsState::default()),
            Err(err) => return Err(err.into()),
        };
        if !file.metadata()?.is_file() {
            return Err(
                io::Error::new(io::ErrorKind::InvalidData, "store must be a regular file").into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let metadata = file.metadata()?;
            if metadata.nlink() != 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "store must not have multiple links",
                )
                .into());
            }
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(StoreError::Io(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "store file must be private",
                )));
            }
        }
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_BYTES {
            return Err(StoreError::Corrupt("store exceeds size limit".into()));
        }
        let state: ButtonsState = serde_json::from_slice(&bytes)
            .map_err(|err| StoreError::Corrupt(format!("invalid store: {err}")))?;
        state
            .validate()
            .map_err(|err| StoreError::Corrupt(err.into()))?;
        Ok(state)
    }

    pub fn read(&self) -> Result<ButtonsState, StoreError> {
        let (_lock, path) = self.lock()?;
        self.read_locked(&path)
    }

    pub fn update(&self, mut proposed: ButtonsState) -> Result<ButtonsState, StoreError> {
        let (_lock, path) = self.lock()?;
        let current = self.read_locked(&path)?;
        proposed
            .validate()
            .map_err(|err| StoreError::Invalid(err.into()))?;
        if proposed.revision != current.revision {
            return Err(StoreError::Conflict);
        }
        proposed.revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| StoreError::Invalid("revision overflow".into()))?;
        let bytes =
            serde_json::to_vec(&proposed).map_err(|err| StoreError::Invalid(err.to_string()))?;
        if bytes.len() > MAX_BYTES {
            return Err(StoreError::Invalid("store exceeds size limit".into()));
        }
        let parent = path.parent().expect("canonical store path has a parent");
        let temp = parent.join(format!(
            ".pi-sidepanel-{}-{}.tmp",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let mut created = false;
        let result = (|| -> io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            created = true;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "store must not be a symlink",
                    ))
                }
                #[cfg(unix)]
                Ok(metadata)
                    if {
                        use std::os::unix::fs::MetadataExt;
                        metadata.nlink() != 1
                    } =>
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "store must not have multiple links",
                    ))
                }
                Ok(_) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
            fs::rename(&temp, &path)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() && created {
            let _ = fs::remove_file(&temp);
        }
        result?;
        Ok(proposed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_validation_matches_client_for_byte_order_mark_whitespace() {
        for newline in [false, true] {
            assert!(!safe_text("\u{feff}", 80, newline));
            assert!(!safe_text(" \u{feff} ", 80, newline));
            assert!(safe_text("\u{feff}visible", 80, newline));
        }
    }

    #[test]
    fn default_store_identity_encodes_host_and_port_without_collisions() {
        assert_eq!(
            default_filename("127.0.0.1", 8787),
            "3132372e302e302e31-8787.json"
        );
        assert_ne!(
            default_filename("127.0.0.1", 8787),
            default_filename("127.0.0.1", 8788)
        );
        assert_ne!(
            default_filename("127.0.0.1", 8787),
            default_filename("localhost", 8787)
        );
        assert_ne!(default_filename("a-1", 2), default_filename("a", 12));
    }
}
