//! Unexposed request handling for the provisional file service.
//!
//! This module is not an HTTP endpoint. Its limits and response contract must be
//! integrated with request-body and origin controls before exposing it.

use crate::file_identity::Binding;
use crate::file_root::FileRoot;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
// Content and metadata bytes can require six JSON bytes (e.g. \u0001).
// The eventual HTTP route must enforce this limit and concurrency before buffering.
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL: u64 = 100 * 1024 * 1024;
const UPLOAD_MAGIC: &[u8] = b"herdr-file-upload-1\n";
pub(crate) const MAX_REQUEST_BYTES: usize = 6 * (MAX_FILE_BYTES + MAX_METADATA_BYTES) + 1024;
pub(crate) const MAX_UPLOAD_REQUEST_BYTES: usize =
    MAX_UPLOAD_BYTES + MAX_METADATA_BYTES + UPLOAD_MAGIC.len() + 4;
const MAX_ENTRIES: usize = 10_000;
const MAX_CONCURRENT: usize = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    bridge_id: String,
    root_id: String,
    binding_id: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Operation {
    List {
        path: String,
    },
    Read {
        path: String,
    },
    Save {
        path: String,
        content: String,
        revision: String,
    },
    CreateFile {
        path: String,
    },
    CreateDirectory {
        path: String,
    },
    Rename {
        path: String,
        destination: String,
    },
    Remove {
        path: String,
        #[serde(default)]
        recursive: bool,
    },
    Copy {
        path: String,
        destination: String,
    },
    Download {
        path: String,
    },
    Search {
        query: String,
        #[serde(default)]
        content: bool,
        #[serde(default = "default_search_limit")]
        limit: usize,
    },
}

fn default_search_limit() -> usize {
    crate::file_search::DEFAULT_LIMIT
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    identity: Identity,
    operation: Operation,
}

/// A watch request names one root-relative file; the parent directory is watched.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WatchRequest {
    identity: Identity,
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadRequest {
    identity: Identity,
    path: String,
}

/// Either a JSON protocol reply or raw file content for the download route.
pub(crate) enum Reply {
    Json(Vec<u8>),
    Content { bytes: Vec<u8>, file_name: String },
}

/// Holds reserved upload bytes so concurrent uploads cannot exceed the aggregate
/// limit even while their writes are still in flight.
pub(crate) struct UploadReservation {
    total: Arc<AtomicU64>,
    size: u64,
}

impl Drop for UploadReservation {
    fn drop(&mut self) {
        self.total.fetch_sub(self.size, Ordering::AcqRel);
    }
}

#[allow(dead_code)]
pub(crate) struct FileService {
    root: FileRoot,
    binding: Binding,
    active: Arc<AtomicUsize>,
    uploaded: Arc<AtomicU64>,
}

pub(crate) struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

#[allow(dead_code)]
impl FileService {
    pub(crate) fn new(root: FileRoot, binding: Binding) -> Self {
        Self {
            root,
            binding,
            active: Arc::new(AtomicUsize::new(0)),
            uploaded: Arc::new(AtomicU64::new(0)),
        }
    }

    fn identity_ok(&self, identity: &Identity) -> bool {
        [&identity.bridge_id, &identity.root_id, &identity.binding_id]
            .iter()
            .all(|part| !part.trim().is_empty())
            && identity.bridge_id == self.binding.bridge_id
            && identity.root_id == self.binding.root_id
            && identity.binding_id == self.binding.live_binding
    }

    /// Reserves upload bytes against the aggregate limit for the lifetime of the
    /// guard, so parallel uploads cannot collectively exceed it.
    fn reserve_upload(&self, size: usize) -> Option<UploadReservation> {
        let size = size as u64;
        if size > MAX_UPLOAD_BYTES as u64 {
            return None;
        }
        let mut total = self.uploaded.load(Ordering::Acquire);
        loop {
            if total + size > MAX_UPLOAD_TOTAL {
                return None;
            }
            match self.uploaded.compare_exchange_weak(
                total,
                total + size,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(UploadReservation {
                        total: Arc::clone(&self.uploaded),
                        size,
                    })
                }
                Err(actual) => total = actual,
            }
        }
    }

    /// Reserve capacity before buffering a request; keep it until blocking work ends.
    pub(crate) fn try_acquire(&self) -> Option<Permit> {
        let mut active = self.active.load(Ordering::Acquire);
        loop {
            if active >= MAX_CONCURRENT {
                return None;
            }
            match self.active.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Permit(Arc::clone(&self.active))),
                Err(actual) => active = actual,
            }
        }
    }

    /// Accepts JSON bytes, not a URL. HTTP callers must acquire admission before
    /// buffering and enforce the request limit while streaming.
    pub(crate) fn handle(&self, bytes: &[u8]) -> Vec<u8> {
        match self.try_acquire() {
            Some(permit) => self.handle_admitted(permit, bytes),
            None => serde_json::to_vec(&failure(Value::Null, "busy"))
                .expect("JSON response is serializable"),
        }
    }

    /// Consumes admission and keeps it alive through parsing and execution.
    pub(crate) fn handle_admitted(&self, permit: Permit, bytes: &[u8]) -> Vec<u8> {
        let response = if Arc::ptr_eq(&permit.0, &self.active) {
            self.respond(bytes)
        } else {
            failure(Value::Null, "invalid_request")
        };
        serde_json::to_vec(&response).expect("JSON response is serializable")
    }

    /// Download route: returns raw bytes for one file, or a JSON error.
    /// Opens a bounded watcher on the parent directory of one file. The caller
    /// keeps the permit for the stream lifetime so a watch cannot outlive its slot.
    pub(crate) fn watch_admitted(
        &self,
        permit: Permit,
        bytes: &[u8],
    ) -> Result<(crate::file_watch::Watcher, Permit), Reply> {
        let Ok(request) = serde_json::from_slice::<WatchRequest>(bytes) else {
            return Err(Reply::Json(json_bytes(failure(
                Value::Null,
                "invalid_request",
            ))));
        };
        let identity = identity_json(&request.identity);
        if !self.identity_ok(&request.identity) {
            return Err(Reply::Json(json_bytes(failure(
                identity,
                "identity_mismatch",
            ))));
        }
        if !valid_path(&request.path, false) {
            return Err(Reply::Json(json_bytes(failure(identity, "invalid_path"))));
        }
        match crate::file_watch::Watcher::open(&self.root, Path::new(&request.path)) {
            Ok(watcher) => Ok((watcher, permit)),
            Err(error) => Err(Reply::Json(json_bytes(failure(
                identity,
                error_code(&error),
            )))),
        }
    }

    pub(crate) fn download_admitted(&self, permit: Permit, bytes: &[u8]) -> Reply {
        if !Arc::ptr_eq(&permit.0, &self.active) {
            return Reply::Json(json_bytes(failure(Value::Null, "invalid_request")));
        }
        let request: Request = match serde_json::from_slice(bytes) {
            Ok(request) => request,
            Err(_) => return Reply::Json(json_bytes(failure(Value::Null, "invalid_request"))),
        };
        let identity = identity_json(&request.identity);
        if !self.identity_ok(&request.identity) {
            return Reply::Json(json_bytes(failure(identity, "identity_mismatch")));
        }
        let Operation::Download { path } = &request.operation else {
            return Reply::Json(json_bytes(failure(identity, "invalid_request")));
        };
        if !valid_path(path, false) {
            return Reply::Json(json_bytes(failure(identity, "invalid_path")));
        }
        match self.root.read_file(Path::new(path), MAX_FILE_BYTES) {
            Ok(bytes) => Reply::Content {
                bytes,
                file_name: Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("download")
                    .to_string(),
            },
            Err(error) => Reply::Json(json_bytes(failure(identity, error_code(&error)))),
        }
    }

    /// Upload route: the body is a framed metadata header followed by raw bytes.
    pub(crate) fn upload_admitted(&self, permit: Permit, bytes: &[u8]) -> Vec<u8> {
        if !Arc::ptr_eq(&permit.0, &self.active) {
            return json_bytes(failure(Value::Null, "invalid_request"));
        }
        if bytes.len() > MAX_UPLOAD_REQUEST_BYTES {
            return json_bytes(failure(Value::Null, "limit_exceeded"));
        }
        let Some((metadata, payload)) = split_upload(bytes) else {
            return json_bytes(failure(Value::Null, "invalid_request"));
        };
        let request: UploadRequest = match serde_json::from_slice(metadata) {
            Ok(request) => request,
            Err(_) => return json_bytes(failure(Value::Null, "invalid_request")),
        };
        let identity = identity_json(&request.identity);
        if !self.identity_ok(&request.identity) {
            return json_bytes(failure(identity, "identity_mismatch"));
        }
        if !valid_path(&request.path, false) {
            return json_bytes(failure(identity, "invalid_path"));
        }
        if payload.len() > MAX_UPLOAD_BYTES {
            return json_bytes(failure(identity, "limit_exceeded"));
        }
        let Some(_reservation) = self.reserve_upload(payload.len()) else {
            return json_bytes(failure(identity, "limit_exceeded"));
        };
        match self.root.create_file(Path::new(&request.path), payload) {
            Ok(()) => json_bytes(json!({"identity": identity, "result": {}})),
            Err(error) => json_bytes(failure(identity, error_code(&error))),
        }
    }

    fn respond(&self, bytes: &[u8]) -> Value {
        if bytes.len() > MAX_REQUEST_BYTES {
            return failure(Value::Null, "limit_exceeded");
        }
        let request: Request = match serde_json::from_slice(bytes) {
            Ok(request) => request,
            Err(_) => return failure(Value::Null, "invalid_request"),
        };
        let identity = json!({"bridge_id": request.identity.bridge_id, "root_id": request.identity.root_id, "binding_id": request.identity.binding_id});
        if !self.identity_ok(&request.identity) {
            return failure(identity, "identity_mismatch");
        }
        let (path, list) = match &request.operation {
            Operation::List { path } => (path.as_str(), true),
            Operation::Read { path }
            | Operation::Save { path, .. }
            | Operation::CreateFile { path }
            | Operation::CreateDirectory { path }
            | Operation::Rename { path, .. }
            | Operation::Copy { path, .. }
            | Operation::Download { path }
            | Operation::Remove { path, .. } => (path.as_str(), false),
            Operation::Search { .. } => ("", true),
        };
        let destination = match &request.operation {
            Operation::Rename { destination, .. } | Operation::Copy { destination, .. } => {
                Some(destination.as_str())
            }
            _ => None,
        };
        let search_bytes = match &request.operation {
            Operation::Search { query, .. } => query.len(),
            _ => 0,
        };
        if request.identity.bridge_id.len()
            + request.identity.root_id.len()
            + request.identity.binding_id.len()
            + path.len()
            + destination.map_or(0, str::len)
            + search_bytes
            > MAX_METADATA_BYTES
        {
            return failure(identity, "limit_exceeded");
        }
        if !valid_path(path, list) || destination.is_some_and(|value| !valid_path(value, false)) {
            return failure(identity, "invalid_path");
        }
        let result = match &request.operation {
            Operation::List { .. } => {
                let path = if path == "." { "" } else { path };
                self.root.list_typed(Path::new(path), MAX_ENTRIES).and_then(|entries| {
                    entries.into_iter().map(|entry| {
                        let name = entry.path.file_name().and_then(|name| name.to_str())
                            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 entry"))?;
                        let mut value = json!({"name": name, "kind": entry.kind});
                        if entry.kind == "symlink" {
                            // This separate confined lookup is a UI hint only: entries
                            // can change before any operation independently resolves them.
                            if let Ok(target) = self.root.resolve(&entry.path) {
                                if let Ok(metadata) = target.metadata() {
                                    let kind = if metadata.is_dir() { Some("directory") } else if metadata.is_file() { Some("file") } else { None };
                                    if let Some(kind) = kind { value["resolved_kind"] = json!(kind); }
                                }
                            }
                        }
                        Ok(value)
                    }).collect::<io::Result<Vec<_>>>()
                }).map(|entries| json!({"entries": entries}))
            }
            Operation::Read { .. } => self.root.read_file(Path::new(path), MAX_FILE_BYTES).and_then(|data| {
                if data.contains(&0) { return Err(io::Error::new(io::ErrorKind::InvalidData, "binary file")); }
                String::from_utf8(data).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "binary file"))
            }).map(|content| json!({"revision": FileRoot::revision(content.as_bytes()), "content": content})),
            Operation::Save { content, revision, .. } => {
                if !FileRoot::valid_revision(revision.as_bytes()) {
                    return failure(identity, "invalid_request");
                }
                if content.len() > MAX_FILE_BYTES {
                    return failure(identity, "limit_exceeded");
                }
                if content.as_bytes().contains(&0) {
                    return failure(identity, "unsupported_data");
                }
                self.root.save_file(Path::new(path), revision.as_bytes(), content.as_bytes())
                    .map(|()| json!({"revision": FileRoot::revision(content.as_bytes())}))
            }
            Operation::CreateFile { .. } => self.root.create_file(Path::new(path), b"").map(|()| json!({})),
            Operation::CreateDirectory { .. } => self.root.create_directory(Path::new(path)).map(|()| json!({})),
            Operation::Rename { destination, .. } => self.root.rename_entry(Path::new(path), Path::new(destination)).map(|()| json!({})),
            // Downloads are served by the dedicated streaming route.
            Operation::Download { .. } => return failure(identity, "invalid_request"),
            Operation::Remove { recursive, .. } => {
                let target = Path::new(path);
                if *recursive {
                    self.root.remove_tree(target).map(|()| json!({}))
                } else {
                    self.root.remove_entry(target).map(|()| json!({}))
                }
            }
            Operation::Copy { destination, .. } => self
                .root
                .copy_tree(Path::new(path), Path::new(destination))
                .map(|()| json!({})),
            Operation::Search {
                query,
                content,
                limit,
            } => self.root.search(query, *content, *limit).map(|hits| {
                json!({
                    "results": hits
                        .into_iter()
                        .map(|hit| match hit.line {
                            Some(line) => json!({"path": hit.path, "line": line}),
                            None => json!({"path": hit.path}),
                        })
                        .collect::<Vec<_>>(),
                })
            }),
        };
        match result {
            Ok(result) => json!({"identity": identity, "result": result}),
            Err(error) => failure(identity, error_code(&error)),
        }
    }
}

fn valid_path(path: &str, allow_root: bool) -> bool {
    if path.is_empty() || path == "." {
        return allow_root;
    }
    !path.as_bytes().contains(&0)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn json_bytes(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value).expect("JSON response is serializable")
}

fn identity_json(identity: &Identity) -> Value {
    json!({
        "bridge_id": identity.bridge_id,
        "root_id": identity.root_id,
        "binding_id": identity.binding_id,
    })
}

/// Upload bodies are a fixed magic, a u32 big-endian metadata length, the JSON
/// metadata, then the raw file bytes. Framing keeps path strings literal instead
/// of URL-decoding them in a query or header.
fn split_upload(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let rest = bytes.strip_prefix(UPLOAD_MAGIC)?;
    let length = u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as usize;
    if length > MAX_METADATA_BYTES {
        return None;
    }
    let metadata = rest.get(4..4usize.checked_add(length)?)?;
    let payload = rest.get(4 + length..)?;
    Some((metadata, payload))
}

fn error_code(error: &io::Error) -> &'static str {
    if error.raw_os_error() == Some(libc::ENOTEMPTY) {
        return "not_empty";
    }
    match error.kind() {
        io::ErrorKind::WouldBlock => "conflict",
        io::ErrorKind::AlreadyExists => "already_exists",
        io::ErrorKind::NotFound => "not_found",
        io::ErrorKind::PermissionDenied => "permission_denied",
        io::ErrorKind::InvalidInput => "unsupported_data",
        io::ErrorKind::InvalidData
            if error.to_string() == "file exceeds read limit"
                || error.to_string() == "directory exceeds entry limit" =>
        {
            "limit_exceeded"
        }
        io::ErrorKind::InvalidData => "unsupported_data",
        io::ErrorKind::Unsupported => "unsupported",
        _ => "io_error",
    }
}

fn failure(identity: Value, code: &str) -> Value {
    json!({"identity": identity, "error": {"code": code, "message": match code {
        "invalid_request" => "Invalid file request",
        "invalid_path" => "Invalid root-relative file path",
        "identity_mismatch" => "File identity does not match",
        "limit_exceeded" => "File request limit exceeded",
        "busy" => "File service is busy",
        "conflict" => "File changed",
        "already_exists" => "File or directory already exists",
        "not_empty" => "Directory is not empty",
        "not_found" => "File not found",
        "permission_denied" => "Permission denied",
        "unsupported_data" => "Unsupported file data",
        "unsupported" => "File operation is unsupported",
        _ => "File operation failed",
    }}})
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "herdr-file-service-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn service(&self) -> FileService {
            FileService::new(
                crate::file_root::FileRoot::open(&self.0).unwrap(),
                crate::file_identity::Binding {
                    bridge_id: "bridge".into(),
                    root_id: "root".into(),
                    live_binding: "binding".into(),
                },
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn request(operation: &str, path: &str) -> Value {
        json!({"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":operation,"path":path}})
    }
    fn call(service: &FileService, value: Value) -> Value {
        serde_json::from_slice(&service.handle(&serde_json::to_vec(&value).unwrap())).unwrap()
    }
    fn error(response: &Value, code: &str) {
        assert_eq!(response["error"]["code"], code, "{response}");
        assert!(response.get("result").is_none());
    }

    #[test]
    fn contract_lists_pinned_types_and_reports_unresolvable_links() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        fs::write(f.0.join("%2e%2e"), "text").unwrap();
        fs::create_dir(f.0.join("dir")).unwrap();
        symlink("%2e%2e", f.0.join("safe-file")).unwrap();
        symlink("dir", f.0.join("safe-dir")).unwrap();
        symlink("missing", f.0.join("dangling")).unwrap();
        symlink("../outside", f.0.join("escape")).unwrap();
        let r = call(&f.service(), request("list", "."));
        assert_eq!(r["identity"], request("list", ".")["identity"]);
        assert_eq!(
            r["result"]["entries"],
            json!([
                {"name":"%2e%2e","kind":"file"}, {"name":"dangling","kind":"symlink"},
                {"name":"dir","kind":"directory"}, {"name":"escape","kind":"symlink"},
                {"name":"safe-dir","kind":"symlink","resolved_kind":"directory"},
                {"name":"safe-file","kind":"symlink","resolved_kind":"file"}
            ])
        );
        assert_eq!(
            call(&f.service(), request("read", "safe-file"))["result"]["content"],
            "text"
        );
        for path in ["dangling", "escape"] {
            let response = call(&f.service(), request("read", path));
            assert!(response.get("result").is_none());
            assert!(response["error"]["message"]
                .as_str()
                .is_some_and(|s| !s.is_empty()));
        }
    }

    #[test]
    fn contract_reads_and_conditionally_saves_literal_json_paths() {
        let f = Fixture::new();
        fs::write(f.0.join("%2e%2e"), "old\n\"text").unwrap();
        let service = f.service();
        let read = call(&service, request("read", "%2e%2e"));
        assert_eq!(read["result"]["content"], "old\n\"text");
        let revision = read["result"]["revision"].as_str().unwrap();
        assert_eq!(revision.len(), 64);
        assert_ne!(revision, "old\n\"text");
        let save = json!({"identity":request("read", "")["identity"],"operation":{"type":"save","path":"%2e%2e","content":"new\t\"text","revision":revision}});
        let saved = call(&service, save.clone());
        assert_eq!(saved["result"]["revision"].as_str().unwrap().len(), 64);
        assert_eq!(
            saved["result"]["revision"],
            call(&service, request("read", "%2e%2e"))["result"]["revision"]
        );
        let stale = call(&service, save);
        assert_eq!(stale["error"]["code"], "conflict");
        assert!(stale["error"]["message"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
        assert_eq!(fs::read(f.0.join("%2e%2e")).unwrap(), b"new\t\"text");
        let raw = br#"{"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"read","path":"\u00252e\u00252e"}}"#;
        let response: Value = serde_json::from_slice(&service.handle(raw)).unwrap();
        assert_eq!(response["result"]["content"], "new\t\"text");
        let raw = br#"{"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"read","path":"\u002e\u002e/x"}}"#;
        let response: Value = serde_json::from_slice(&service.handle(raw)).unwrap();
        error(&response, "invalid_path");
    }

    #[test]
    fn percent_paths_are_literals_and_nested_names_are_relative_to_listing() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("dir")).unwrap();
        for path in ["%2f", "%252e%252e", "bad%zz", "quote\"\\name"] {
            fs::write(f.0.join("dir").join(path), path).unwrap();
            let read = call(&f.service(), request("read", &format!("dir/{path}")));
            assert_eq!(read["result"]["content"], path);
        }
        let list = call(&f.service(), request("list", "dir"));
        for entry in list["result"]["entries"].as_array().unwrap() {
            assert!(!entry["name"].as_str().unwrap().contains('/'));
            assert_eq!(entry["kind"], "file");
        }
        assert_eq!(list["result"]["entries"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn full_size_escaped_save_and_limits_preserve_file_on_rejection() {
        let f = Fixture::new();
        let old = "\u{1}".repeat(MAX_FILE_BYTES);
        let new = "\u{2}".repeat(MAX_FILE_BYTES);
        fs::write(f.0.join("file"), &old).unwrap();
        let service = f.service();
        let revision = call(&service, request("read", "file"))["result"]["revision"].clone();
        let mut save = json!({"identity":request("read", "")["identity"],"operation":{"type":"save","path":"file","content":new,"revision":revision}});
        let bytes = serde_json::to_vec(&save).unwrap();
        assert!(bytes.len() > MAX_FILE_BYTES * 5 && bytes.len() <= MAX_REQUEST_BYTES);
        assert!(MAX_REQUEST_BYTES < 7 * (MAX_FILE_BYTES + MAX_METADATA_BYTES));
        let response: Value = serde_json::from_slice(&service.handle(&bytes)).unwrap();
        assert_eq!(response["result"]["revision"].as_str().unwrap().len(), 64);
        assert_eq!(fs::read(f.0.join("file")).unwrap(), vec![2; MAX_FILE_BYTES]);
        save["operation"]["content"] = json!("x".repeat(MAX_FILE_BYTES + 1));
        error(&call(&service, save.clone()), "limit_exceeded");
        save["operation"]["content"] = json!("changed");
        save["identity"]["binding_id"] = json!("stale");
        error(&call(&service, save.clone()), "identity_mismatch");
        save["identity"]["binding_id"] = json!("binding");
        save["operation"]["path"] = json!("../file");
        error(&call(&service, save), "invalid_path");
        assert_eq!(fs::read(f.0.join("file")).unwrap(), vec![2; MAX_FILE_BYTES]);
    }

    #[test]
    fn read_revision_matches_content_during_replacement() {
        let f = Fixture::new();
        fs::write(f.0.join("file"), "first").unwrap();
        let service = f.service();
        let dir = f.0.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..200 {
                fs::write(
                    dir.join("swap"),
                    if i % 2 == 0 { "second" } else { "first" },
                )
                .unwrap();
                fs::rename(dir.join("swap"), dir.join("file")).unwrap();
            }
        });
        let results: Vec<_> = (0..200)
            .map(|_| call(&service, request("read", "file")))
            .collect();
        writer.join().unwrap();
        for result in results {
            assert!(result["result"]["content"].is_string());
            let expected = match result["result"]["content"].as_str().unwrap() {
                "first" => "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
                "second" => "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4",
                other => panic!("unexpected content: {other}"),
            };
            assert_eq!(result["result"]["revision"], expected);
        }
    }

    #[test]
    fn lists_and_reads_literal_percent_names_and_echoes_identity() {
        let f = Fixture::new();
        fs::write(f.0.join("%2e%2e"), "literal").unwrap();
        let service = f.service();
        let r = call(&service, request("read", "%2e%2e"));
        assert_eq!(r["identity"], request("read", "")["identity"]);
        assert_eq!(r["result"]["content"], "literal");
        let r = call(&service, request("list", ""));
        assert_eq!(
            r["result"]["entries"],
            json!([{"name":"%2e%2e","kind":"file"}])
        );
    }

    #[test]
    fn rejects_every_identity_mismatch() {
        let f = Fixture::new();
        fs::write(f.0.join("file"), "data").unwrap();
        let service = f.service();
        for key in ["bridge_id", "root_id", "binding_id"] {
            let mut req = request("read", "file");
            req["identity"][key] = json!("wrong");
            let response = call(&service, req.clone());
            assert_eq!(response["identity"], req["identity"]);
            error(&response, "identity_mismatch");
        }
    }

    #[test]
    fn rejects_bad_paths_operations_and_json() {
        let f = Fixture::new();
        let service = f.service();
        for path in [
            "..",
            "../x",
            "/absolute",
            "a/../b",
            "a//b",
            "a/",
            "a/./b",
            "a\0b",
        ] {
            error(&call(&service, request("read", path)), "invalid_path");
            error(&call(&service, request("list", path)), "invalid_path");
        }
        error(&call(&service, request("read", ".")), "invalid_path");
        error(&call(&service, request("read", "")), "invalid_path");
        error(&call(&service, request("save", "x")), "invalid_request");
        let mut extra = request("list", "");
        extra["unexpected"] = json!(true);
        error(&call(&service, extra), "invalid_request");
        let response: Value = serde_json::from_slice(&service.handle(b"{broken")).unwrap();
        error(&response, "invalid_request");
        error(&call(&service, request("read", "missing")), "not_found");
    }

    #[test]
    fn rejects_binary_oversized_content_and_non_utf8_entries() {
        use std::os::unix::ffi::OsStrExt;
        let f = Fixture::new();
        fs::write(f.0.join("binary"), [0xff]).unwrap();
        fs::write(f.0.join("nul"), b"text\0binary").unwrap();
        fs::write(f.0.join("maximum"), vec![b'x'; MAX_FILE_BYTES]).unwrap();
        fs::write(f.0.join("large"), vec![b'x'; MAX_FILE_BYTES + 1]).unwrap();
        let service = f.service();
        error(
            &call(&service, request("read", "binary")),
            "unsupported_data",
        );
        error(&call(&service, request("read", "nul")), "unsupported_data");
        assert_eq!(
            call(&service, request("read", "maximum"))["result"]["content"]
                .as_str()
                .unwrap()
                .len(),
            MAX_FILE_BYTES
        );
        error(&call(&service, request("read", "large")), "limit_exceeded");
        fs::write(f.0.join(std::ffi::OsStr::from_bytes(b"\xff")), "x").unwrap();
        error(&call(&service, request("list", "")), "unsupported_data");
    }

    #[test]
    fn listing_rejects_more_than_the_entry_limit() {
        let f = Fixture::new();
        for i in 0..MAX_ENTRIES {
            fs::write(f.0.join(i.to_string()), b"").unwrap();
        }
        let service = f.service();
        assert_eq!(
            call(&service, request("list", ""))["result"]["entries"]
                .as_array()
                .unwrap()
                .len(),
            MAX_ENTRIES
        );
        fs::write(f.0.join("overflow"), b"").unwrap();
        error(&call(&service, request("list", "")), "limit_exceeded");
    }

    #[test]
    fn revision_validation_empty_binary_and_conflicting_editors() {
        let f = Fixture::new();
        fs::write(f.0.join("file"), b"").unwrap();
        let service = f.service();
        let read = call(&service, request("read", "file"));
        assert_eq!(
            read["result"],
            json!({"content":"", "revision":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"})
        );
        let mut save = json!({"identity":request("read", "")["identity"],"operation":{"type":"save","path":"file","content":"abc","revision":read["result"]["revision"]}});
        for invalid in ["", "abc", &"A".repeat(64), &"g".repeat(64), &"a".repeat(65)] {
            save["operation"]["revision"] = json!(invalid);
            error(&call(&service, save.clone()), "invalid_request");
            assert_eq!(fs::read(f.0.join("file")).unwrap(), b"");
        }
        save["operation"]["revision"] = json!("0".repeat(64));
        error(&call(&service, save.clone()), "conflict");
        assert_eq!(fs::read(f.0.join("file")).unwrap(), b"");
        save["operation"]["revision"] = read["result"]["revision"].clone();
        save["operation"]["content"] = json!("binary\0data");
        error(&call(&service, save.clone()), "unsupported_data");
        assert_eq!(fs::read(f.0.join("file")).unwrap(), b"");
        save["operation"]["content"] = json!("abc");
        let result = call(&service, save.clone());
        assert_eq!(
            result["result"]["revision"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        error(&call(&service, save), "conflict");
        assert_eq!(fs::read(f.0.join("file")).unwrap(), b"abc");
    }

    fn framed_upload(identity: Value, path: &str, payload: &[u8]) -> Vec<u8> {
        let metadata = json!({"identity": identity, "path": path}).to_string();
        let mut body = UPLOAD_MAGIC.to_vec();
        body.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        body.extend_from_slice(metadata.as_bytes());
        body.extend_from_slice(payload);
        body
    }

    #[test]
    fn contract_uploads_new_files_and_bounds_aggregate_bytes() {
        let f = Fixture::new();
        let service = f.service();
        let identity = request("list", "")["identity"].clone();
        let upload = |identity: Value, path: &str, payload: &[u8]| {
            let permit = service.try_acquire().expect("admission");
            let reply: Value = serde_json::from_slice(
                &service.upload_admitted(permit, &framed_upload(identity, path, payload)),
            )
            .expect("JSON reply");
            reply
        };
        assert_eq!(
            upload(identity.clone(), "new", b"content")["result"],
            json!({})
        );
        assert_eq!(fs::read(f.0.join("new")).unwrap(), b"content");
        error(&upload(identity.clone(), "new", b"other"), "already_exists");
        error(&upload(identity.clone(), "../escape", b"x"), "invalid_path");
        let mut stale = identity.clone();
        stale["binding_id"] = json!("stale");
        error(&upload(stale, "another", b"x"), "identity_mismatch");
        error(
            &upload(identity.clone(), "big", &vec![b'x'; MAX_UPLOAD_BYTES + 1]),
            "limit_exceeded",
        );

        let reservations: Vec<_> = (0..4)
            .map(|_| {
                service
                    .reserve_upload(MAX_UPLOAD_BYTES)
                    .expect("within total")
            })
            .collect();
        assert!(service.reserve_upload(1).is_none());
        drop(reservations);
        assert!(service.reserve_upload(MAX_UPLOAD_BYTES).is_some());
        assert!(service.reserve_upload(MAX_UPLOAD_BYTES + 1).is_none());
    }

    #[test]
    fn contract_downloads_bytes_through_the_dedicated_route() {
        let f = Fixture::new();
        fs::write(f.0.join("binary.dat"), [0u8, 7, 255]).unwrap();
        let service = f.service();
        let identity = request("list", "")["identity"].clone();
        let download = |path: &str| {
            let permit = service.try_acquire().expect("admission");
            let body =
                json!({"identity": identity, "operation": {"type": "download", "path": path}})
                    .to_string();
            service.download_admitted(permit, body.as_bytes())
        };
        match download("binary.dat") {
            Reply::Content { bytes, file_name } => {
                assert_eq!(bytes, vec![0u8, 7, 255]);
                assert_eq!(file_name, "binary.dat");
            }
            Reply::Json(_) => panic!("expected content"),
        }
        let error_body = |reply: Reply| match reply {
            Reply::Json(bytes) => serde_json::from_slice::<Value>(&bytes).expect("JSON"),
            Reply::Content { .. } => panic!("expected JSON error"),
        };
        assert_eq!(error_body(download("absent"))["error"]["code"], "not_found");
        assert_eq!(error_body(download(""))["error"]["code"], "invalid_path");
    }

    #[test]
    fn contract_searches_names_and_contents_with_bounded_results() {
        let f = Fixture::new();
        let service = f.service();
        let identity = request("list", "")["identity"].clone();
        let op =
            |operation: Value| call(&service, json!({"identity":identity,"operation":operation}));
        fs::create_dir_all(f.0.join("dir/nested")).unwrap();
        fs::write(
            f.0.join("dir/nested/notes.md"),
            b"first line\nsecond Needle line\n",
        )
        .unwrap();
        fs::write(f.0.join("dir/other.txt"), b"nothing here\n").unwrap();
        fs::create_dir_all(f.0.join(".git")).unwrap();
        fs::write(f.0.join(".git/hidden-needle"), b"needle\n").unwrap();
        assert_eq!(
            op(json!({"type":"search","query":"notes"}))["result"],
            json!({"results":[{"path":"dir/nested/notes.md"}]})
        );
        assert_eq!(
            op(json!({"type":"search","query":"needle","content":true}))["result"],
            json!({"results":[{"path":"dir/nested/notes.md","line":2}]})
        );
        assert_eq!(
            op(json!({"type":"search","query":"needle"}))["result"],
            json!({"results":[]})
        );
        error(&op(json!({"type":"search","query":""})), "unsupported_data");
        error(
            &op(json!({"type":"search","query":"x","limit":0})),
            "unsupported_data",
        );
        error(
            &op(json!({"type":"search","query":"x","limit":201})),
            "unsupported_data",
        );
    }

    #[test]
    fn contract_copies_trees_and_removes_them_recursively() {
        let f = Fixture::new();
        let service = f.service();
        let identity = request("list", "")["identity"].clone();
        let op =
            |operation: Value| call(&service, json!({"identity":identity,"operation":operation}));
        fs::create_dir_all(f.0.join("tree/nested")).unwrap();
        fs::write(f.0.join("tree/nested/file"), b"payload").unwrap();
        assert_eq!(
            op(json!({"type":"copy","path":"tree","destination":"copy"}))["result"],
            json!({})
        );
        assert_eq!(fs::read(f.0.join("copy/nested/file")).unwrap(), b"payload");
        error(
            &op(json!({"type":"copy","path":"tree","destination":"copy"})),
            "already_exists",
        );
        error(&op(json!({"type":"remove","path":"copy"})), "not_empty");
        assert_eq!(
            op(json!({"type":"remove","path":"tree","recursive":true}))["result"],
            json!({})
        );
        assert!(!f.0.join("tree").exists());
        assert_eq!(fs::read(f.0.join("copy/nested/file")).unwrap(), b"payload");
    }

    #[test]
    fn contract_creates_renames_and_deletes_without_overwrite() {
        let f = Fixture::new();
        let service = f.service();
        let identity = request("list", "")["identity"].clone();
        let op =
            |operation: Value| call(&service, json!({"identity":identity,"operation":operation}));
        assert_eq!(
            op(json!({"type":"create_directory","path":"dir"}))["result"],
            json!({})
        );
        assert_eq!(
            op(json!({"type":"create_file","path":"dir/new"}))["result"],
            json!({})
        );
        fs::write(f.0.join("dir/existing"), b"keep").unwrap();
        error(
            &op(json!({"type":"create_file","path":"dir/existing"})),
            "already_exists",
        );
        error(
            &op(json!({"type":"rename","path":"dir/new","destination":"dir/existing"})),
            "already_exists",
        );
        assert_eq!(fs::read(f.0.join("dir/existing")).unwrap(), b"keep");
        assert_eq!(
            op(json!({"type":"rename","path":"dir/new","destination":"dir/moved"}))["result"],
            json!({})
        );
        assert_eq!(
            op(json!({"type":"remove","path":"dir/moved"}))["result"],
            json!({})
        );
        error(
            &op(json!({"type":"create_file","path":"../escape"})),
            "invalid_path",
        );
        error(
            &op(json!({"type":"rename","path":"dir/existing","destination":"../escape"})),
            "invalid_path",
        );
        let mut stale =
            json!({"identity": identity, "operation":{"type":"remove","path":"dir/existing"}});
        stale["identity"]["binding_id"] = json!("stale");
        error(&call(&service, stale), "identity_mismatch");
        assert_eq!(fs::read(f.0.join("dir/existing")).unwrap(), b"keep");
    }

    #[test]
    fn admission_precedes_parsing_and_cannot_cross_services() {
        let f = Fixture::new();
        let service = f.service();
        let other = f.service();
        let permits: Vec<_> = (0..MAX_CONCURRENT)
            .map(|_| service.try_acquire().unwrap())
            .collect();
        let response: Value = serde_json::from_slice(&service.handle(b"not json")).unwrap();
        error(&response, "busy");
        let other_permit = other.try_acquire().unwrap();
        let response: Value =
            serde_json::from_slice(&service.handle_admitted(other_permit, b"{}")).unwrap();
        error(&response, "invalid_request");
        drop(permits);
        let permit = service.try_acquire().unwrap();
        let bytes = serde_json::to_vec(&request("list", "")).unwrap();
        let response: Value =
            serde_json::from_slice(&service.handle_admitted(permit, &bytes)).unwrap();
        assert_eq!(response["result"]["entries"], json!([]));
        assert!(service.try_acquire().is_some());
    }

    #[test]
    fn enforces_request_size_and_concurrency_limits() {
        let f = Fixture::new();
        let service = f.service();
        let mut bytes = serde_json::to_vec(&request("list", "")).unwrap();
        bytes.resize(MAX_REQUEST_BYTES, b' ');
        let response: Value = serde_json::from_slice(&service.handle(&bytes)).unwrap();
        assert_eq!(response["result"]["entries"], json!([]));
        bytes.push(b' ');
        let response: Value = serde_json::from_slice(&service.handle(&bytes)).unwrap();
        error(&response, "limit_exceeded");
        let permits: Vec<_> = (0..MAX_CONCURRENT)
            .map(|_| service.try_acquire().unwrap())
            .collect();
        error(&call(&service, request("list", "")), "busy");
        drop(permits);
        assert_eq!(
            call(&service, request("list", ""))["result"]["entries"],
            json!([])
        );
    }
}
