//! End-to-end checks for the file route and its advertised capability.

use super::*;
use crate::file_identity::{Binding, IdentityStore};
use crate::file_root::FileRoot;
use crate::file_service::FileService;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use axum::routing::get;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use tower::ServiceExt;

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    state_dir: PathBuf,
    identity_dir: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "herdr-file-route-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let root = base.join("root");
        let state_dir = base.join("state");
        let identity_dir = base.join("identity");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::create_dir_all(&identity_dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&identity_dir, std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        std::fs::write(root.join("note.txt"), "hello").unwrap();
        Self {
            root,
            state_dir,
            identity_dir,
        }
    }

    fn binding(&self) -> Binding {
        let file_root = FileRoot::open(&self.root).unwrap();
        let (dev, ino) = file_root.dev_ino().unwrap();
        IdentityStore::open(&self.identity_dir)
            .unwrap()
            .bind("file-root", &self.root, dev, ino)
            .unwrap()
    }

    fn service(&self, binding: &Binding) -> Arc<FileService> {
        Arc::new(FileService::new(
            FileRoot::open(&self.root).unwrap(),
            binding.clone(),
        ))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.root.parent().unwrap());
    }
}

fn state(fixture: &Fixture, binding: &Binding, service: Arc<FileService>) -> BridgeState {
    BridgeState {
        api: ApiClient::for_socket_path(fixture.state_dir.join("api.sock")),
        client_socket_path: fixture.state_dir.join("api.sock"),
        request_policy: RequestPolicy {
            bind_host: "127.0.0.1".into(),
            bind_port: 8787,
            allowed_hosts: vec![],
            allow_host_any_port: false,
            allowed_origins: vec![],
            allowed_connect_sources: vec![],
        },
        terminal_sessions: Arc::new(Mutex::new(TerminalSessions::default())),
        selected_pane_id: Arc::new(Mutex::new(None)),
        agent_activity: Arc::new(AgentActivityManager::new()),
        agent_pins: Arc::new(
            AgentPinsManager::for_test(fixture.state_dir.join("pins"), "test").unwrap(),
        ),
        launcher_presets: Arc::new(LauncherPresetStore::load(None).unwrap()),
        notes: Arc::new(NotesManager::for_test(fixture.state_dir.join("notes"), "test").unwrap()),
        ui_event_tx: tokio::sync::broadcast::channel(256).0,
        activity_tx: tokio::sync::broadcast::channel(512).0,
        upload_dir: fixture.state_dir.join("uploads"),
        file_service: Some(service),
        file_capability: Some(FileCapability {
            version: 1,
            bridge_id: binding.bridge_id.clone(),
            root_id: binding.root_id.clone(),
            binding_id: binding.live_binding.clone(),
        }),
    }
}

fn app(state: BridgeState) -> Router {
    Router::new()
        .route("/api/capabilities", get(capabilities_handler))
        .route("/api/files", post(file_handler))
        .with_state(state)
}

fn call(
    method: &str,
    path: &str,
    host: &str,
    origin: Option<&str>,
    body: Option<String>,
) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", host);
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    if let Some(body) = body {
        request = request.header("content-type", "application/json");
        return request.body(Body::from(body)).unwrap();
    }
    request.body(Body::empty()).unwrap()
}

async fn json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn operation(binding: &Binding, value: Value) -> String {
    serde_json::json!({
        "identity": {
            "bridge_id": binding.bridge_id,
            "root_id": binding.root_id,
            "binding_id": binding.live_binding,
        },
        "operation": value,
    })
    .to_string()
}

#[tokio::test]
async fn advertises_the_bound_root_and_serves_file_operations() {
    let fixture = Fixture::new();
    let binding = fixture.binding();
    let app = app(state(&fixture, &binding, fixture.service(&binding)));

    let capabilities = json(
        app.clone()
            .oneshot(call(
                "GET",
                "/api/capabilities",
                "127.0.0.1:8787",
                None,
                None,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(capabilities["files"]["version"], 1);
    assert_eq!(
        capabilities["files"]["binding_id"],
        binding.live_binding.as_str()
    );

    let listed = json(
        app.clone()
            .oneshot(call(
                "POST",
                "/api/files",
                "127.0.0.1:8787",
                None,
                Some(operation(
                    &binding,
                    serde_json::json!({"type": "list", "path": "."}),
                )),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        listed["identity"]["binding_id"],
        binding.live_binding.as_str()
    );
    assert_eq!(listed["result"]["entries"][0]["name"], "note.txt");

    let read = json(
        app.clone()
            .oneshot(call(
                "POST",
                "/api/files",
                "127.0.0.1:8787",
                None,
                Some(operation(
                    &binding,
                    serde_json::json!({"type": "read", "path": "note.txt"}),
                )),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(read["result"]["content"], "hello");
    let revision = read["result"]["revision"].as_str().unwrap().to_string();

    let saved = json(
        app.clone()
            .oneshot(call("POST", "/api/files", "127.0.0.1:8787", None, Some(operation(&binding, serde_json::json!({"type": "save", "path": "note.txt", "content": "changed", "revision": revision})))))
            .await
            .unwrap(),
    )
    .await;
    assert!(saved["result"]["revision"].is_string());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("note.txt")).unwrap(),
        "changed"
    );

    let created = json(
        app.clone()
            .oneshot(call(
                "POST",
                "/api/files",
                "127.0.0.1:8787",
                None,
                Some(operation(
                    &binding,
                    serde_json::json!({"type": "create_file", "path": "new.txt"}),
                )),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(created["result"], serde_json::json!({}));
    assert!(fixture.root.join("new.txt").is_file());
}

#[tokio::test]
async fn rejects_foreign_host_origin_stale_identity_and_traversal() {
    let fixture = Fixture::new();
    let binding = fixture.binding();
    let app = app(state(&fixture, &binding, fixture.service(&binding)));

    let foreign_host = app
        .clone()
        .oneshot(call(
            "POST",
            "/api/files",
            "evil.example:8787",
            None,
            Some(operation(
                &binding,
                serde_json::json!({"type": "list", "path": "."}),
            )),
        ))
        .await
        .unwrap();
    assert_eq!(foreign_host.status(), StatusCode::FORBIDDEN);

    let foreign_origin = app
        .clone()
        .oneshot(call(
            "POST",
            "/api/files",
            "127.0.0.1:8787",
            Some("https://evil.example"),
            Some(operation(
                &binding,
                serde_json::json!({"type": "list", "path": "."}),
            )),
        ))
        .await
        .unwrap();
    assert_eq!(foreign_origin.status(), StatusCode::FORBIDDEN);

    let mut stale = operation(&binding, serde_json::json!({"type": "list", "path": "."}));
    stale = stale.replace(&binding.live_binding, "stale");
    let stale = json(
        app.clone()
            .oneshot(call(
                "POST",
                "/api/files",
                "127.0.0.1:8787",
                None,
                Some(stale),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(stale["error"]["code"], "identity_mismatch");

    let traversal = json(
        app.clone()
            .oneshot(call(
                "POST",
                "/api/files",
                "127.0.0.1:8787",
                None,
                Some(operation(
                    &binding,
                    serde_json::json!({"type": "read", "path": "../outside"}),
                )),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(traversal["error"]["code"], "invalid_path");
}

#[tokio::test]
async fn disabled_service_answers_not_found_without_reading_the_body() {
    let fixture = Fixture::new();
    let binding = fixture.binding();
    let mut disabled = state(&fixture, &binding, fixture.service(&binding));
    disabled.file_service = None;
    disabled.file_capability = None;
    let app = app(disabled);
    let response = app
        .clone()
        .oneshot(call(
            "POST",
            "/api/files",
            "127.0.0.1:8787",
            None,
            Some("not json".into()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let capabilities = json(
        app.clone()
            .oneshot(call(
                "GET",
                "/api/capabilities",
                "127.0.0.1:8787",
                None,
                None,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert!(capabilities.get("files").is_none());
}
