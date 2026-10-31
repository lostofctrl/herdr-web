use super::*;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::net::{UnixListener, UnixStream};

struct FakeDaemon {
    listener: UnixListener,
    path: PathBuf,
}

impl FakeDaemon {
    fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "herdr-recovery-{}-{}.sock",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        Self { listener, path }
    }

    fn accept(&self, method: &str) -> (UnixStream, serde_json::Value) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let socket = loop {
            match self.listener.accept() {
                Ok((socket, _)) => break socket,
                Err(err) if err.kind() == ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "missing {method}");
                    thread::sleep(Duration::from_millis(5));
                }
                Err(err) => panic!("accept failed: {err}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut line = String::new();
        BufReader::new(socket.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], method);
        (socket, request)
    }

    fn subscribe(&self) -> UnixStream {
        let (mut socket, request) = self.accept("events.subscribe");
        respond(
            &mut socket,
            &request,
            serde_json::json!({"type": "subscription_started"}),
        );
        socket
    }

    fn panes(&self, panes: Vec<PaneInfo>) {
        let (mut socket, request) = self.accept("pane.list");
        respond(
            &mut socket,
            &request,
            serde_json::to_value(ResponseResult::PaneList { panes }).unwrap(),
        );
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(self.path.with_extension("pins"));
        let _ = std::fs::remove_dir(self.path.with_extension("notes"));
    }
}

fn respond(socket: &mut UnixStream, request: &serde_json::Value, result: serde_json::Value) {
    writeln!(
        socket,
        "{}",
        serde_json::json!({"id": request["id"], "result": result})
    )
    .unwrap();
}

fn lost_events(socket: &mut UnixStream) {
    writeln!(socket, "{}", serde_json::json!({
        "id": "subscription", "error": {"code": "events_lost", "message": "events lost; resubscribe"}
    })).unwrap();
}

fn test_state(api_path: PathBuf) -> BridgeState {
    BridgeState {
        api: ApiClient::for_socket_path(api_path.clone()),
        client_socket_path: api_path.clone(),
        request_policy: RequestPolicy {
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            allowed_hosts: vec![],
            allow_host_any_port: false,
            allowed_origins: vec![],
            allowed_connect_sources: vec![],
        },
        terminal_sessions: Arc::new(Mutex::new(TerminalSessions::default())),
        selected_pane_id: Arc::new(Mutex::new(None)),
        agent_activity: Arc::new(AgentActivityManager::new()),
        agent_pins: Arc::new(
            AgentPinsManager::for_test(api_path.with_extension("pins"), "test").unwrap(),
        ),
        launcher_presets: Arc::new(LauncherPresetStore::load(None).unwrap()),
        pi_sidepanel_buttons: None,
        notes: Arc::new(NotesManager::for_test(api_path.with_extension("notes"), "test").unwrap()),
        ui_event_tx: tokio::sync::broadcast::channel(256).0,
        activity_tx: tokio::sync::broadcast::channel(512).0,
        upload_dir: api_path.with_extension("uploads"),
    }
}

async fn test_events_handler(ws: WebSocketUpgrade, State(state): State<BridgeState>) -> Response {
    ws.on_upgrade(move |socket| handle_events_socket(socket, state))
        .into_response()
}

#[tokio::test]
async fn events_socket_closes_on_eof_error_or_invalid_json_and_reconnects() {
    for failure in ["eof", "events_lost", "invalid_json"] {
        let daemon = FakeDaemon::new();
        let state = test_state(daemon.path.clone());
        let app = Router::new()
            .route("/ws", get(test_events_handler))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (release_tx, release_rx) = mpsc::channel();
        let daemon_thread = thread::spawn(move || {
            let mut stream = daemon.subscribe();
            match failure {
                "eof" => drop(stream),
                "events_lost" => {
                    lost_events(&mut stream);
                    // Keep the socket open to prove the error itself causes recovery.
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                }
                _ => {
                    writeln!(stream, "invalid JSON").unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            }
            let mut stream = daemon.subscribe();
            writeln!(
                stream,
                "{}",
                serde_json::json!({
                    "event": "workspace.created", "data": {"workspace_id": "recovered"}
                })
            )
            .unwrap();
        });

        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(3), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert_eq!(ready["type"], "resync_required");
        let closed = tokio::time::timeout(Duration::from_secs(3), client.next())
            .await
            .expect("events WebSocket remained open after upstream failure");
        assert!(
            matches!(
                closed,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            ),
            "{failure}: {closed:?}"
        );
        if failure != "eof" {
            release_tx.send(()).unwrap();
        }
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(3), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert_eq!(ready["type"], "resync_required");
        let event = tokio::time::timeout(Duration::from_secs(3), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event: serde_json::Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
        assert_eq!(event["data"]["workspace_id"], "recovered");
        daemon_thread.join().unwrap();
        server.abort();
    }
}

#[test]
fn pi_sidepanel_buttons_store_option_is_accepted() {
    let args = vec![
        "--pi-sidepanel-buttons".to_string(),
        "/tmp/buttons.json".to_string(),
    ];
    let options = parse_options(&args).unwrap().unwrap();
    assert_eq!(
        options.pi_sidepanel_buttons_path,
        Some(PathBuf::from("/tmp/buttons.json"))
    );
    let unchanged = parse_options(&["--port".into(), "8788".into()])
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.port, 8788);
}

struct ButtonsTemp(PathBuf);
impl ButtonsTemp {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "pi-buttons-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        crate::store_util::set_private_dir_permissions(&path).unwrap();
        Self(path)
    }
}
impl Drop for ButtonsTemp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

async fn buttons_request(
    app: Router,
    method: &str,
    host: &str,
    origin: Option<&str>,
    body: &str,
) -> (StatusCode, HeaderMap, serde_json::Value) {
    use tower::ServiceExt;
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri("/api/pi-sidepanel-buttons")
        .header("host", host)
        .header("content-type", "application/json");
    if let Some(origin) = origin {
        builder = builder.header("origin", origin);
    }
    let response = app
        .oneshot(
            builder
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn pi_sidepanel_buttons_http_policy_validation_conflicts_and_restart() {
    let root = ButtonsTemp::new();
    let path = root.0.join("buttons.json");
    let mut state = test_state(root.0.join("daemon.sock"));
    state.request_policy.bind_port = 8787;
    state.pi_sidepanel_buttons = ButtonsStore::configured("127.0.0.1", 8787, Some(path.clone()));
    let app = pi_sidepanel_buttons_routes()
        .layer(middleware::from_fn_with_state(
            state.request_policy.clone(),
            add_security_headers,
        ))
        .with_state(state.clone());
    let (status, _, default) =
        buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        default,
        serde_json::json!({"schema_version":1,"revision":0,"buttons":[],"pinned":["abort","compact","new-session","resume","chat-log"]})
    );
    assert!(!path.exists());
    assert_eq!(
        buttons_request(app.clone(), "GET", "evil.example", None, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            Some("http://evil.example"),
            &default.to_string()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, headers, _) = buttons_request(
        app.clone(),
        "OPTIONS",
        "127.0.0.1:8787",
        Some("http://127.0.0.1:8787"),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers[ACCESS_CONTROL_ALLOW_METHODS], "GET, PUT, OPTIONS");
    let mut proposed = default.clone();
    proposed["buttons"] = serde_json::json!([{"id":"custom-one","title":"Hello","icon":{"type":"glyph","text":"★"},"action":{"type":"prompt","text":"hello\nworld","delivery":"insert"}}]);
    proposed["pinned"] = serde_json::json!(["custom-one", "abort"]);
    let (status, _, saved) = buttons_request(
        app.clone(),
        "PUT",
        "127.0.0.1:8787",
        None,
        &proposed.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["revision"], 1);
    assert_eq!(
        buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            None,
            &proposed.to_string()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut invalid = saved.clone();
    invalid["buttons"][0]["action"]["text"] = serde_json::json!("bad\u{001b}[31m");
    assert_eq!(
        buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            None,
            &invalid.to_string()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    invalid = saved.clone();
    invalid["pinned"] = serde_json::json!(["custom-one", "custom-one"]);
    assert_eq!(
        buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            None,
            &invalid.to_string()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    invalid = saved.clone();
    invalid["extra"] = serde_json::json!(true);
    assert_eq!(
        buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            None,
            &invalid.to_string()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let restarted = pi_sidepanel_buttons_routes().with_state(state);
    assert_eq!(
        buttons_request(restarted.clone(), "GET", "127.0.0.1:8787", None, "")
            .await
            .2,
        saved
    );
    std::fs::write(&path, b"{broken").unwrap();
    assert_eq!(
        buttons_request(restarted.clone(), "GET", "127.0.0.1:8787", None, "")
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        buttons_request(restarted, "PUT", "127.0.0.1:8787", None, &saved.to_string())
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
}

#[tokio::test]
async fn pi_sidepanel_buttons_invalid_inputs_preserve_state_and_capability() {
    let root = ButtonsTemp::new();
    let path = root.0.join("buttons.json");
    let mut state = test_state(root.0.join("daemon.sock"));
    state.request_policy.bind_port = 8787;
    state.pi_sidepanel_buttons = ButtonsStore::configured("127.0.0.1", 8787, Some(path.clone()));
    let capabilities = capabilities_handler(
        State(state.clone()),
        HeaderMap::from_iter([(HOST, HeaderValue::from_static("127.0.0.1:8787"))]),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(capabilities.pi_sidepanel_buttons_version, Some(1));
    let app = pi_sidepanel_buttons_routes().with_state(state);
    let original = serde_json::json!({"schema_version":1,"revision":0,"buttons":[{"id":"custom-x","title":"Title","icon":{"type":"lucide","name":"star"},"action":{"type":"builtin","id":"abort"}}],"pinned":["custom-x"]});
    let (status, _, saved) = buttons_request(
        app.clone(),
        "PUT",
        "127.0.0.1:8787",
        None,
        &original.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut cases = Vec::new();
    let mut value = saved.clone();
    value["schema_version"] = serde_json::json!(2);
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["id"] = serde_json::json!("abort");
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["title"] = serde_json::json!("a".repeat(81));
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["icon"] = serde_json::json!({"type":"glyph","text":"a".repeat(17)});
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["icon"] = serde_json::json!({"type":"lucide","name":"unknown"});
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["icon"]["extra"] = serde_json::json!(true);
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["action"] = serde_json::json!({"type":"builtin","id":"unknown"});
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["action"] =
        serde_json::json!({"type":"prompt","text":"x".repeat(8193),"delivery":"send"});
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"][0]["action"] =
        serde_json::json!({"type":"prompt","text":"ok","delivery":"execute"});
    cases.push(value);
    let mut value = saved.clone();
    value["pinned"] = serde_json::json!(["custom-missing"]);
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"]
        .as_array_mut()
        .unwrap()
        .push(saved["buttons"][0].clone());
    cases.push(value);
    let mut value = saved.clone();
    value["pinned"] = serde_json::json!(vec!["abort"; 70]);
    cases.push(value);
    let mut value = saved.clone();
    value["buttons"] = serde_json::json!(vec![saved["buttons"][0].clone(); 65]);
    cases.push(value);
    for invalid in cases {
        let (status, _, body) = buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            None,
            &invalid.to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid}");
        assert!(body["error"].is_string());
        assert_eq!(
            buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "")
                .await
                .2,
            saved
        );
    }
    assert_eq!(
        buttons_request(app.clone(), "PUT", "127.0.0.1:8787", None, "{")
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            None,
            &"x".repeat(MAX_BUTTONS_BYTES + 1)
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(root.0.join("buttons.json.lock"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "")
                .await
                .0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "")
                .await
                .2,
            saved
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn pi_sidepanel_buttons_rejects_leaf_and_lock_symlinks_without_modification() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = ButtonsTemp::new();
    let target = root.0.join("target.json");
    let leaf = root.0.join("buttons.json");
    let target_contents = serde_json::to_vec(&ButtonsState::default()).unwrap();
    std::fs::write(&target, &target_contents).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, &leaf).unwrap();
    let mut state = test_state(root.0.join("daemon.sock"));
    state.request_policy.bind_port = 8787;
    state.pi_sidepanel_buttons = ButtonsStore::configured("127.0.0.1", 8787, Some(leaf.clone()));
    let app = pi_sidepanel_buttons_routes().with_state(state);
    let proposed = serde_json::to_string(&ButtonsState::default()).unwrap();
    assert_eq!(
        buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "")
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        buttons_request(app.clone(), "PUT", "127.0.0.1:8787", None, &proposed)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(std::fs::symlink_metadata(&leaf)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(&target).unwrap(), target_contents);
    std::fs::remove_file(&leaf).unwrap();
    symlink(root.0.join("missing"), &leaf).unwrap();
    assert_eq!(
        buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "")
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        buttons_request(app.clone(), "PUT", "127.0.0.1:8787", None, &proposed)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(std::fs::symlink_metadata(&leaf)
        .unwrap()
        .file_type()
        .is_symlink());
    std::fs::remove_file(&leaf).unwrap();
    let lock = root.0.join("buttons.json.lock");
    std::fs::remove_file(&lock).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
    symlink(&target, &lock).unwrap();
    assert_eq!(
        buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "")
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        buttons_request(app, "PUT", "127.0.0.1:8787", None, &proposed)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o644
    );
    assert_eq!(std::fs::read(&target).unwrap(), target_contents);
    assert!(!leaf.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn pi_sidepanel_buttons_rejects_hardlinked_store_and_sidecar() {
    use std::os::unix::fs::PermissionsExt;
    let root = ButtonsTemp::new();
    let target = root.0.join("target");
    let path = root.0.join("buttons.json");
    let initial = serde_json::to_vec(&ButtonsState::default()).unwrap();
    std::fs::write(&target, &initial).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::hard_link(&target, &path).unwrap();
    let mut state = test_state(root.0.join("daemon.sock"));
    state.request_policy.bind_port = 8787;
    state.pi_sidepanel_buttons = ButtonsStore::configured("127.0.0.1", 8787, Some(path.clone()));
    let app = pi_sidepanel_buttons_routes().with_state(state);
    assert_eq!(
        buttons_request(app.clone(), "GET", "127.0.0.1:8787", None, "")
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        buttons_request(
            app.clone(),
            "PUT",
            "127.0.0.1:8787",
            None,
            std::str::from_utf8(&initial).unwrap()
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read(&target).unwrap(), initial);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(root.0.join("buttons.json.lock")).unwrap();
    std::fs::hard_link(&target, root.0.join("buttons.json.lock")).unwrap();
    assert_eq!(
        buttons_request(app, "GET", "127.0.0.1:8787", None, "")
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read(&target).unwrap(), initial);
}

#[cfg(unix)]
#[tokio::test]
async fn pi_sidepanel_buttons_missing_parent_read_does_not_write_defaults() {
    use std::os::unix::fs::PermissionsExt;
    let root = ButtonsTemp::new();
    let dir = root.0.join("new-store");
    let path = dir.join("buttons.json");
    let mut state = test_state(root.0.join("daemon.sock"));
    state.request_policy.bind_port = 8787;
    state.pi_sidepanel_buttons = ButtonsStore::configured("127.0.0.1", 8787, Some(path.clone()));
    let app = pi_sidepanel_buttons_routes().with_state(state);
    let (status, _, value) = buttons_request(app, "GET", "127.0.0.1:8787", None, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        value,
        serde_json::to_value(ButtonsState::default()).unwrap()
    );
    assert!(!path.exists());
    assert_eq!(
        std::fs::metadata(dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[cfg(unix)]
#[tokio::test]
async fn pi_sidepanel_buttons_rejects_sidecar_symlink_without_chmod() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = ButtonsTemp::new();
    let target = root.0.join("target");
    std::fs::write(&target, b"untouched").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
    symlink(&target, root.0.join("buttons.json.lock")).unwrap();
    let mut state = test_state(root.0.join("daemon.sock"));
    state.request_policy.bind_port = 8787;
    state.pi_sidepanel_buttons =
        ButtonsStore::configured("127.0.0.1", 8787, Some(root.0.join("buttons.json")));
    let app = pi_sidepanel_buttons_routes().with_state(state);
    assert_eq!(
        buttons_request(app, "GET", "127.0.0.1:8787", None, "")
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o644
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
    assert!(!root.0.join("buttons.json").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn pi_sidepanel_buttons_parent_aliases_share_state_and_revision() {
    use std::os::unix::fs::symlink;
    let root = ButtonsTemp::new();
    let dir = root.0.join("store");
    let alias = root.0.join("alias");
    std::fs::create_dir(&dir).unwrap();
    crate::store_util::set_private_dir_permissions(&dir).unwrap();
    symlink(&dir, &alias).unwrap();
    let mut state = test_state(root.0.join("daemon.sock"));
    state.request_policy.bind_port = 8787;
    state.pi_sidepanel_buttons =
        ButtonsStore::configured("127.0.0.1", 8787, Some(dir.join("buttons.json")));
    let first = pi_sidepanel_buttons_routes().with_state(state.clone());
    state.pi_sidepanel_buttons = ButtonsStore::configured(
        "127.0.0.1",
        8787,
        Some(alias.join(".").join("buttons.json")),
    );
    let second = pi_sidepanel_buttons_routes().with_state(state);
    let (status, _, default) =
        buttons_request(second.clone(), "GET", "127.0.0.1:8787", None, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!(!dir.join("buttons.json").exists());
    let (status, _, saved) = buttons_request(
        first.clone(),
        "PUT",
        "127.0.0.1:8787",
        None,
        &default.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        buttons_request(second.clone(), "GET", "127.0.0.1:8787", None, "")
            .await
            .2,
        saved
    );
    assert_eq!(
        buttons_request(second, "PUT", "127.0.0.1:8787", None, &default.to_string())
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        buttons_request(first, "GET", "127.0.0.1:8787", None, "")
            .await
            .2,
        saved
    );
}

#[test]
fn pi_sidepanel_buttons_cross_process_child() {
    let Some(path) = std::env::var_os("PI_BUTTONS_TEST_CHILD") else {
        return;
    };
    let store = ButtonsStore::configured("127.0.0.1", 0, Some(PathBuf::from(path))).unwrap();
    println!("CHILD_READY");
    std::io::stdout().flush().unwrap();
    match store.update(ButtonsState::default()) {
        Ok(_) => println!("CHILD_SAVED"),
        Err(StoreError::Conflict) => println!("CHILD_CONFLICT"),
        other => panic!("unexpected child result: {other:?}"),
    }
}

#[test]
fn pi_sidepanel_buttons_child_waits_for_held_sidecar_lock() {
    use std::os::unix::fs::symlink;
    use std::process::{Command, Stdio};
    let root = ButtonsTemp::new();
    let path = root.0.join("buttons.json");
    let alias = root.0.join("alias");
    symlink(&root.0, &alias).unwrap();
    let lock = crate::store_util::LockFile::exclusive(&root.0.join("buttons.json.lock")).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "web_bridge::subscription_tests::pi_sidepanel_buttons_cross_process_child",
            "--nocapture",
        ])
        .env("PI_BUTTONS_TEST_CHILD", alias.join("buttons.json"))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert_ne!(
            output.read_line(&mut line).unwrap(),
            0,
            "child exited before lock attempt"
        );
        if line.contains("CHILD_READY") {
            break;
        }
    }
    thread::sleep(Duration::from_millis(100));
    assert!(
        child.try_wait().unwrap().is_none(),
        "child did not wait for the sidecar lock"
    );
    assert!(!path.exists());
    drop(lock);
    assert!(child.wait().unwrap().success());
    assert_eq!(
        ButtonsStore::configured("127.0.0.1", 0, Some(path))
            .unwrap()
            .read()
            .unwrap()
            .revision,
        1
    );
}

#[test]
fn pi_sidepanel_buttons_cross_process_lock_and_isolation() {
    use std::process::{Command, Stdio};
    let root = ButtonsTemp::new();
    let path = root.0.join("buttons.json");
    let mut children = Vec::new();
    for _ in 0..2 {
        children.push(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "web_bridge::subscription_tests::pi_sidepanel_buttons_cross_process_child",
                    "--nocapture",
                ])
                .env("PI_BUTTONS_TEST_CHILD", &path)
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    let output: String = children
        .into_iter()
        .map(|child| {
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap()
        })
        .collect();
    assert_eq!(output.matches("CHILD_SAVED").count(), 1);
    assert_eq!(output.matches("CHILD_CONFLICT").count(), 1);
    let store = ButtonsStore::configured("127.0.0.1", 0, Some(path)).unwrap();
    assert_eq!(store.read().unwrap().revision, 1);
    assert!(ButtonsStore::configured("127.0.0.1", 0, None).is_none());
}

#[test]
fn structural_reconnect_requests_membership_refresh_without_new_events() {
    let daemon = FakeDaemon::new();
    let state = test_state(daemon.path.clone());
    let (signal_tx, signal_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let daemon_thread = thread::spawn(move || {
        for _ in 0..2 {
            let mut socket = daemon.subscribe();
            lost_events(&mut socket);
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    });
    let mut backoff = ACTIVITY_WATCHER_MAX_BACKOFF;
    let mut disconnected_state = state.clone();
    disconnected_state.api =
        ApiClient::for_socket_path(state.api.socket_path().with_extension("absent"));
    assert!(run_agent_activity_structural_subscription(
        &disconnected_state,
        &signal_tx,
        &mut backoff
    )
    .is_err());
    assert_eq!(
        backoff, ACTIVITY_WATCHER_MAX_BACKOFF,
        "setup failures must retain the retry delay"
    );
    for _ in 0..2 {
        let err = run_agent_activity_structural_subscription(&state, &signal_tx, &mut backoff)
            .unwrap_err();
        assert_eq!(backoff, ACTIVITY_WATCHER_INITIAL_BACKOFF);
        // The watcher increases the next delay after sleeping. The next healthy
        // subscription must reset it even though its eventual termination is Err.
        backoff *= 2;
        assert!(
            matches!(err, BridgeError::Api(ApiClientError::ErrorResponse(response)) if response.error.code == "events_lost")
        );
        signal_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("subscription ack must refresh membership");
        release_tx.send(()).unwrap();
    }
    daemon_thread.join().unwrap();
}

#[test]
fn activity_reconnect_rebuilds_baseline_and_requests_browser_resync() {
    let daemon = FakeDaemon::new();
    let state = test_state(daemon.path.clone());
    let mut activity_rx = state.activity_tx.subscribe();
    let (_signal_tx, signal_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let daemon_thread = thread::spawn(move || {
        for pane_id in ["before-disconnect", "created-during-disconnect"] {
            let mut pane = super::tests::test_pane(pane_id);
            pane.agent = Some("codex".into());
            daemon.panes(vec![pane.clone()]);
            let (mut socket, request) = daemon.accept("events.subscribe");
            assert_eq!(request["params"]["subscriptions"][0]["pane_id"], pane_id);
            respond(
                &mut socket,
                &request,
                serde_json::json!({"type": "subscription_started"}),
            );
            pane.agent_status = AgentStatus::Working;
            daemon.panes(vec![pane]);
            lost_events(&mut socket);
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    });
    let mut backoff = ACTIVITY_WATCHER_MAX_BACKOFF;
    let mut disconnected_state = state.clone();
    disconnected_state.api =
        ApiClient::for_socket_path(state.api.socket_path().with_extension("absent"));
    assert!(
        run_agent_activity_subscription(&disconnected_state, &signal_rx, &mut backoff).is_err()
    );
    assert_eq!(
        backoff, ACTIVITY_WATCHER_MAX_BACKOFF,
        "setup failures must retain the retry delay"
    );
    for pane_id in ["before-disconnect", "created-during-disconnect"] {
        let err = run_agent_activity_subscription(&state, &signal_rx, &mut backoff).unwrap_err();
        assert_eq!(backoff, ACTIVITY_WATCHER_INITIAL_BACKOFF);
        backoff *= 2;
        assert!(
            matches!(err, BridgeError::Api(ApiClientError::ErrorResponse(response)) if response.error.code == "events_lost")
        );
        assert!(matches!(
            activity_rx.try_recv(),
            Ok(ActivityMessage::ResyncRequired { .. })
        ));
        let mut pane = super::tests::test_pane(pane_id);
        pane.agent = Some("codex".into());
        pane.agent_status = AgentStatus::Working;
        let list = state.agent_activity.list(&[pane]);
        assert_eq!(list.records.len(), 1);
        assert_eq!(list.records[0].pane_id, pane_id);
        assert_eq!(list.records[0].agent_status, AgentStatus::Working);
        release_tx.send(()).unwrap();
    }
    daemon_thread.join().unwrap();
}

#[tokio::test]
async fn idle_browser_disconnect_releases_upstream_subscription() {
    for graceful_close in [false, true] {
        let daemon = FakeDaemon::new();
        let state = test_state(daemon.path.clone());
        let app = Router::new()
            .route("/ws", get(test_events_handler))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let daemon_task = tokio::task::spawn_blocking(move || {
            let mut stream = daemon.subscribe();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut byte = [0];
            // Send no events: the bridge must release this reader on its own.
            assert_eq!(
                stream
                    .read(&mut byte)
                    .expect("upstream subscription leaked after idle browser disconnect"),
                0
            );
        });
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(3), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert_eq!(ready["type"], "resync_required");
        if graceful_close {
            client.close(None).await.unwrap();
        }
        drop(client);
        tokio::time::timeout(Duration::from_secs(5), daemon_task)
            .await
            .unwrap()
            .unwrap();
        server.abort();
    }
}
