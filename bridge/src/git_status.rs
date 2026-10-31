//! Local, best-effort Git branch information; this module never fetches.
//!
//! Pass a server-provided worktree checkout path when one exists. Otherwise a
//! pane's server-provided cwd may be used, but Git then discovers its enclosing
//! repository: a pane may have changed directories, be in a nested repository,
//! or have no local cwd (for example an SSH session). A fallback is therefore
//! only a guess and must not be presented as authoritative for the workspace.
//! Never accept arbitrary browser-supplied paths: Git reads repository config and
//! metadata accessible to the bridge user. This is not an authorization check.
//!
//! Keep one shared `GitStatusCache` for the bridge lifetime. The asynchronous
//! method uses blocking workers, limits active probes, deduplicates concurrent
//! requests for the same literal path, and caches successes and failures briefly.
//! Counts describe locally available upstream refs and may be stale until the
//! user or another process fetches. Failures and overload return `None`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{watch, Semaphore};

const MAX_PROBES: usize = 4;
const MAX_ENTRIES: usize = 256;
const MAX_PATH_BYTES: usize = 4096;
const CACHE_TTL: Duration = Duration::from_secs(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct GitStatus {
    /// `None` means a detached HEAD. An unborn branch still has a name.
    pub(crate) branch: Option<String>,
    /// Both counts are present only when Git can resolve and compare upstream.
    pub(crate) ahead_behind: Option<(u64, u64)>,
}

type ProbeResult = Option<GitStatus>;
type Receiver = watch::Receiver<Option<ProbeResult>>;

enum Entry {
    Pending { receiver: Receiver, previous: Option<(ProbeResult, Instant)> },
    Ready { value: ProbeResult, expires: Instant },
}

#[derive(Clone)]
pub(crate) struct GitStatusCache {
    entries: Arc<Mutex<HashMap<PathBuf, Entry>>>,
    permits: Arc<Semaphore>,
}

impl Default for GitStatusCache {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(MAX_PROBES)),
        }
    }
}

impl GitStatusCache {
    /// Return a recent cached result immediately and schedule a refresh if needed.
    pub(crate) fn cached_or_refresh(&self, path: &Path) -> ProbeResult {
        let cached = self.entries.lock().ok().and_then(|entries| match entries.get(path) {
            Some(Entry::Ready { value, expires }) if *expires + Duration::from_secs(30) > Instant::now() => value.clone(),
            Some(Entry::Pending { previous: Some((value, stale_until)), .. }) if *stale_until > Instant::now() => value.clone(),
            _ => None,
        });
        let cache = self.clone();
        let path = path.to_owned();
        tokio::spawn(async move { let _ = cache.get(&path).await; });
        cached
    }

    /// Probe an absolute server-side directory, returning `None` on any failure.
    /// This function must be called from a Tokio runtime with timers enabled.
    pub(crate) async fn get(&self, path: &Path) -> ProbeResult {
        if !path.is_absolute() || path.as_os_str().as_encoded_bytes().len() > MAX_PATH_BYTES {
            return None;
        }
        let mut receiver = {
            let mut entries = self.entries.lock().ok()?;
            let now = Instant::now();
            entries.retain(|_, entry| !matches!(entry, Entry::Ready { expires, .. } if *expires + Duration::from_secs(30) <= now));
            match entries.get(path) {
                Some(Entry::Ready { value, expires }) if *expires > now => return value.clone(),
                Some(Entry::Pending { receiver, .. }) => receiver.clone(),
                existing => {
                    let previous = match existing {
                        Some(Entry::Ready { value, expires }) => Some((value.clone(), *expires + Duration::from_secs(30))),
                        _ => None,
                    };
                    if previous.is_none() && entries.len() >= MAX_ENTRIES {
                        return None;
                    }
                    let permit = self.permits.clone().try_acquire_owned().ok()?;
                    let (sender, receiver) = watch::channel(None);
                    entries.insert(path.to_owned(), Entry::Pending { receiver: receiver.clone(), previous });
                    let path = path.to_owned();
                    let cache = self.clone();
                    tokio::spawn(async move {
                        let probe_path = path.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            // Keep the permit until the blocking worker really exits.
                            let _permit = permit;
                            probe(&probe_path)
                        }).await.ok().flatten();
                        if let Ok(mut entries) = cache.entries.lock() {
                            // Do not retain a sender in the map: receivers must wake even
                            // if the task fails before publishing a result.
                            entries.insert(path, Entry::Ready {
                                value: result.clone(), expires: Instant::now() + CACHE_TTL,
                            });
                        }
                        let _ = sender.send(Some(result));
                    });
                    receiver
                }
            }
        };
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return result;
            }
            if receiver.changed().await.is_err() {
                return None;
            }
        }
    }
}

fn probe(path: &Path) -> ProbeResult {
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let (status, output) = git(path, &["rev-parse", "--is-inside-work-tree"], deadline)?;
    if !status.success() || output.trim() != "true" {
        return None;
    }
    let (status, output) = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"], deadline)?;
    let branch = if status.success() {
        let name = output.trim_end_matches('\n');
        if name.is_empty() { return None; }
        Some(name.to_owned())
    } else if status.code() == Some(1) {
        None
    } else {
        return None;
    }; 
    let ahead_behind = if branch.is_some() {
        git(path, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], deadline)
            .and_then(|(status, output)| {
                if !status.success() { return None; }
                let mut parts = output.split_whitespace();
                let ahead = parts.next()?.parse().ok()?;
                let behind = parts.next()?.parse().ok()?;
                if parts.next().is_some() { return None; }
                Some((ahead, behind))
            })
    } else { None };
    Some(GitStatus { branch, ahead_behind })
}

fn git(path: &Path, args: &[&str], deadline: Instant) -> Option<(std::process::ExitStatus, String)> {
    if Instant::now() >= deadline { return None; }
    let mut command = Command::new("git");
    command.args(args).current_dir(path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // Do not allow inherited GIT_DIR, GIT_WORK_TREE, config injection, etc. to
    // redirect this request away from its supplied directory.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") { command.env_remove(key); }
    }
    command.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").env("GIT_PAGER", "cat").env("LC_ALL", "C");
    let mut child = command.spawn().ok()?;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().ok()?;
                return Some((output.status, String::from_utf8(output.stdout).ok()?));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "herdr-git-status-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            std::fs::create_dir(&path).unwrap();
            let repo = Self(path);
            repo.git(&["init", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.invalid"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }
        fn git(&self, args: &[&str]) {
            let mut command = Command::new("git");
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("GIT_") { command.env_remove(key); }
            }
            let output = command.args(args).current_dir(&self.0)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", self.0.join("no-global-config"))
                .env("GIT_TERMINAL_PROMPT", "0")
                .output().unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        }
        fn commit(&self) { self.git(&["commit", "--allow-empty", "-m", "test"]); }
    }
    impl Drop for Repo {
        fn drop(&mut self) { std::fs::remove_dir_all(&self.0).unwrap(); }
    }

    #[tokio::test]
    async fn expired_entry_remains_visible_while_refresh_is_pending() {
        let cache = GitStatusCache::default();
        let path = PathBuf::from("/temporary-git-cache-test");
        let status = GitStatus { branch: Some("main".into()), ahead_behind: None };
        let (_sender, receiver) = watch::channel(None);
        cache.entries.lock().unwrap().insert(path.clone(), Entry::Pending {
            receiver,
            previous: Some((Some(status.clone()), Instant::now() + Duration::from_secs(10))),
        });
        assert_eq!(cache.cached_or_refresh(&path), Some(status));
    }

    #[tokio::test]
    async fn refreshing_another_path_does_not_evict_stale_status() {
        let cache = GitStatusCache::default();
        let path = PathBuf::from("/temporary-stale-git-status");
        let status = GitStatus { branch: Some("main".into()), ahead_behind: None };
        cache.entries.lock().unwrap().insert(path.clone(), Entry::Ready {
            value: Some(status.clone()), expires: Instant::now() - Duration::from_secs(1),
        });
        let _permits = cache.permits.clone().acquire_many_owned(MAX_PROBES as u32).await.unwrap();
        assert_eq!(cache.get(Path::new("/another-git-path")).await, None);
        assert_eq!(cache.cached_or_refresh(&path), Some(status));
    }

    #[tokio::test]
    async fn branch_upstream_detached_and_cache() {
        let repo = Repo::new();
        let cache = GitStatusCache::default();
        assert_eq!(cache.get(&repo.0).await, Some(GitStatus { branch: Some("main".into()), ahead_behind: None }));
        repo.commit();
        repo.git(&["branch", "upstream"]);
        repo.commit();
        repo.git(&["checkout", "upstream"]);
        repo.git(&["commit", "--allow-empty", "-m", "upstream change"]);
        repo.git(&["checkout", "main"]);
        repo.git(&["branch", "--set-upstream-to", "upstream"]);
        let fresh = GitStatusCache::default();
        let expected = Some(GitStatus { branch: Some("main".into()), ahead_behind: Some((1, 1)) });
        let (first, second) = tokio::join!(fresh.get(&repo.0), fresh.get(&repo.0));
        assert_eq!(first, expected);
        assert_eq!(second, expected);
        repo.git(&["checkout", "--detach"]);
        assert_eq!(fresh.get(&repo.0).await, expected);
        assert_eq!(GitStatusCache::default().get(&repo.0).await, Some(GitStatus { branch: None, ahead_behind: None }));
    }

    #[tokio::test]
    async fn directory_validation_and_nested_cwd() {
        let repo = Repo::new();
        let nested = repo.0.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let cache = GitStatusCache::default();
        assert_eq!(cache.get(Path::new("relative")).await, None);
        assert_eq!(cache.get(&repo.0.join("missing")).await, None);
        assert_eq!(cache.get(&nested).await, Some(GitStatus { branch: Some("main".into()), ahead_behind: None }));
        repo.git(&["init", "--bare", "bare.git"]);
        assert_eq!(cache.get(&repo.0.join("bare.git")).await, None);
    }

    #[tokio::test]
    async fn linked_worktree_uses_its_own_branch() {
        let repo = Repo::new();
        repo.commit();
        repo.git(&["worktree", "add", "-b", "linked", "linked"]);
        let cache = GitStatusCache::default();
        assert_eq!(cache.get(&repo.0).await, Some(GitStatus { branch: Some("main".into()), ahead_behind: None }));
        assert_eq!(cache.get(&repo.0.join("linked")).await, Some(GitStatus { branch: Some("linked".into()), ahead_behind: None }));
    }
}
