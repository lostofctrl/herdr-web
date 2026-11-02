//! File HTTP adapter: JSON operations, raw downloads, framed uploads and a
//! bounded change stream. Every route enforces the bridge host/origin policy
//! before the body is read.

use super::{ensure_allowed_request, RequestPolicy};
use crate::file_service::{FileService, Reply, MAX_REQUEST_BYTES, MAX_UPLOAD_REQUEST_BYTES};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub(super) struct FileHttpState {
    service: Option<Arc<FileService>>,
    policy: RequestPolicy,
}

fn json_response(status: StatusCode, bytes: Vec<u8>) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response()
}

fn early_error(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::json!({"identity": null, "error": {"code": code, "message": message}});
    json_response(
        status,
        serde_json::to_vec(&body).expect("JSON error is serializable"),
    )
}

enum BodyError {
    TooLarge,
    Disconnected,
}

async fn bounded_body(body: Body, limit: usize) -> Result<Vec<u8>, BodyError> {
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BodyError::Disconnected)?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(BodyError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Which protocol a request uses. Uploads allow a larger body; downloads return
/// raw bytes instead of the JSON protocol reply.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Route {
    Json,
    Download,
    Upload,
    Watch,
}

/// Percent-encodes a download filename for the RFC 5987 `filename*` parameter so
/// arbitrary bytes never reach the header verbatim.
fn encode_file_name(name: &str) -> String {
    let mut encoded = String::new();
    for byte in name.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b' ') {
            encoded.push(if *byte == b' ' { '%' } else { *byte as char });
            if *byte == b' ' {
                encoded.pop();
                encoded.push_str("%20");
            }
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn content_response(bytes: Vec<u8>, file_name: &str) -> Response {
    let ascii: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
                    encode_file_name(file_name)
                ),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        bytes,
    )
        .into_response()
}

/// Admission is acquired before body consumption and moved into the blocking
/// worker, which retains it even if the requesting client disconnects.
pub(super) async fn handle(
    route: Route,
    service: Option<Arc<FileService>>,
    policy: &RequestPolicy,
    request: Request,
) -> Response {
    if let Err(error) = ensure_allowed_request(request.headers(), policy) {
        return error.into_response();
    }
    let Some(service) = service else {
        return early_error(
            StatusCode::NOT_FOUND,
            "unsupported",
            "File access is disabled",
        );
    };
    let Some(permit) = service.try_acquire() else {
        return early_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "File service is busy",
        );
    };
    let limit = if route == Route::Upload {
        MAX_UPLOAD_REQUEST_BYTES
    } else {
        MAX_REQUEST_BYTES
    };
    let bytes = match tokio::time::timeout(
        Duration::from_secs(if route == Route::Upload { 60 } else { 15 }),
        bounded_body(request.into_body(), limit),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(BodyError::TooLarge)) => {
            return early_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "limit_exceeded",
                "File request limit exceeded",
            )
        }
        Ok(Err(BodyError::Disconnected)) => {
            return early_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "File request body could not be read",
            )
        }
        Err(_) => {
            return early_error(
                StatusCode::REQUEST_TIMEOUT,
                "invalid_request",
                "File request body timed out",
            )
        }
    };
    let result = match route {
        Route::Json => tokio::task::spawn_blocking(move || service.handle_admitted(permit, &bytes))
            .await
            .map(|bytes| json_response(StatusCode::OK, bytes)),
        Route::Upload => {
            tokio::task::spawn_blocking(move || service.upload_admitted(permit, &bytes))
                .await
                .map(|bytes| json_response(StatusCode::OK, bytes))
        }
        Route::Watch => return watch_stream(service, permit, bytes).await,
        Route::Download => {
            tokio::task::spawn_blocking(move || service.download_admitted(permit, &bytes))
                .await
                .map(|reply| match reply {
                    Reply::Json(bytes) => json_response(StatusCode::OK, bytes),
                    Reply::Content { bytes, file_name } => content_response(bytes, &file_name),
                })
        }
    };
    result.unwrap_or_else(|_| {
        early_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "io_error",
            "File operation failed",
        )
    })
}

/// Streams bounded change hints as server-sent events. Every event is only a
/// hint: the client must resynchronize, and an `overflow` event demands a full
/// reload because the kernel queue dropped entries.
async fn watch_stream(
    service: Arc<FileService>,
    permit: crate::file_service::Permit,
    bytes: Vec<u8>,
) -> Response {
    let (watcher, permit) = match service.watch_admitted(permit, &bytes) {
        Ok(opened) => opened,
        Err(Reply::Json(bytes)) => return json_response(StatusCode::OK, bytes),
        Err(Reply::Content { .. }) => {
            return early_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "io_error",
                "File watch failed",
            )
        }
    };
    let (sender, receiver) = tokio::sync::mpsc::channel::<String>(16);
    tokio::task::spawn_blocking(move || {
        let deadline =
            std::time::Instant::now() + Duration::from_secs(crate::file_watch::MAX_WATCH_SECONDS);
        while std::time::Instant::now() < deadline {
            match watcher.poll(5_000) {
                Ok(Some(batch)) => {
                    let mut lines = String::new();
                    if batch.overflow {
                        lines.push_str("event: overflow\ndata: {}\n\n");
                    }
                    for name in batch.names {
                        let Ok(payload) =
                            serde_json::to_string(&serde_json::json!({ "name": name }))
                        else {
                            continue;
                        };
                        lines.push_str(&format!("event: change\ndata: {payload}\n\n"));
                    }
                    if !lines.is_empty() && sender.blocking_send(lines).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    if sender.blocking_send(": keepalive\n\n".to_owned()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        drop(permit);
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|chunk| {
            (
                Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(chunk)),
                receiver,
            )
        })
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| {
            early_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "io_error",
                "File watch failed",
            )
        })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::file_identity::Binding;
    use crate::file_root::FileRoot;
    use axum::body::{to_bytes, Body, Bytes};
    use axum::http::Request;
    use axum::routing::post;
    use axum::Router;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tower::ServiceExt;

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "herdr-file-http-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn service(&self) -> Arc<FileService> {
            Arc::new(FileService::new(
                FileRoot::open(&self.0).unwrap(),
                Binding {
                    bridge_id: "bridge".into(),
                    root_id: "root".into(),
                    live_binding: "binding".into(),
                },
            ))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    /// Mirrors the route table in `web_bridge.rs`; the binary calls `handle`
    /// through its own handlers, so the test routes are declared here.
    macro_rules! file_route {
        ($route:expr) => {
            post(
                |State(state): State<FileHttpState>, request: axum::extract::Request| async move {
                    handle($route, state.service, &state.policy, request).await
                },
            )
        };
    }

    fn app(service: Option<Arc<FileService>>) -> Router {
        Router::new()
            .route("/api/files", file_route!(Route::Json))
            .route("/api/files/download", file_route!(Route::Download))
            .route("/api/files/upload", file_route!(Route::Upload))
            .with_state(FileHttpState {
                service,
                policy: RequestPolicy {
                    bind_host: "127.0.0.1".into(),
                    bind_port: 8787,
                    allowed_hosts: vec![],
                    allow_host_any_port: false,
                    allowed_origins: vec![],
                    allowed_connect_sources: vec![],
                },
            })
    }
    fn body() -> String {
        json!({"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"list","path":"."}}).to_string()
    }
    async fn call(
        app: Router,
        host: &str,
        origin: Option<&str>,
        body: Body,
    ) -> axum::response::Response {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/files")
            .header("host", host)
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        app.oneshot(request.body(body).unwrap()).await.unwrap()
    }
    async fn result(response: axum::response::Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }
    #[tokio::test]
    async fn enforces_host_origin_and_disabled_policy_before_body() {
        let f = Fixture::new();
        let service = f.service();
        for (host, origin) in [
            ("evil.test", None),
            ("127.0.0.1:8787", Some("null")),
            ("127.0.0.1:8787", Some("https://evil.test")),
        ] {
            let unreadable = Body::from_stream(futures_util::stream::once(async {
                panic!("denied request body must not be read");
                #[allow(unreachable_code)]
                Ok::<Bytes, std::io::Error>(Bytes::new())
            }));
            let response = call(app(Some(service.clone())), host, origin, unreadable).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let response = call(app(None), "127.0.0.1:8787", None, Body::from(body())).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    #[tokio::test]
    async fn accepts_allowed_requests_and_returns_non_cacheable_json() {
        let f = Fixture::new();
        std::fs::write(f.0.join("%2e%2e"), b"literal").unwrap();
        for origin in [None, Some("http://127.0.0.1:8787")] {
            let response = call(
                app(Some(f.service())),
                "127.0.0.1:8787",
                origin,
                Body::from(body()),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(response.headers()["cache-control"], "no-store");
            let response = result(response).await;
            assert_eq!(
                response["result"]["entries"],
                json!([{"name":"%2e%2e","kind":"file"}])
            );
        }
    }
    #[tokio::test]
    async fn json_paths_remain_literal_and_traversal_is_rejected() {
        let f = Fixture::new();
        for name in ["%2e%2e", "%2f", "%5c", "%00", "%252e%252e", "%", "a\\b"] {
            std::fs::write(f.0.join(name), name.as_bytes()).unwrap();
        }
        let service = f.service();
        for name in ["%2e%2e", "%2f", "%5c", "%00", "%252e%252e", "%", "a\\b"] {
            let request = json!({"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"read","path":name}}).to_string();
            let response = call(
                app(Some(service.clone())),
                "127.0.0.1:8787",
                None,
                Body::from(request),
            )
            .await;
            assert_eq!(result(response).await["result"]["content"], name);
        }
        let request = r#"{"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"read","path":"..\u002foutside"}}"#;
        let response = call(
            app(Some(service)),
            "127.0.0.1:8787",
            None,
            Body::from(request),
        )
        .await;
        assert_eq!(result(response).await["error"]["code"], "invalid_path");
    }

    fn upload_body(path: &str, payload: &[u8]) -> Vec<u8> {
        let metadata = json!({"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"path":path}).to_string();
        let mut body = b"herdr-file-upload-1\n".to_vec();
        body.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        body.extend_from_slice(metadata.as_bytes());
        body.extend_from_slice(payload);
        body
    }

    async fn post_to(
        path: &'static str,
        service: Arc<FileService>,
        body: Body,
    ) -> axum::response::Response {
        let router = app(Some(service));
        router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("host", "127.0.0.1:8787")
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn downloads_raw_bytes_with_attachment_headers_and_confined_errors() {
        let f = Fixture::new();
        std::fs::write(f.0.join("bin"), [0u8, 1, 2, 255]).unwrap();
        let service = f.service();
        let request = json!({"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"download","path":"bin"}}).to_string();
        let response = post_to("/api/files/download", service.clone(), Body::from(request)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "application/octet-stream"
        );
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["cache-control"], "no-store");
        let disposition = response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .to_string();
        assert!(disposition.starts_with("attachment; filename=\"bin\""));
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            &[0u8, 1, 2, 255]
        );
        let missing = json!({"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"download","path":"absent"}}).to_string();
        let response = post_to("/api/files/download", service.clone(), Body::from(missing)).await;
        assert_eq!(result(response).await["error"]["code"], "not_found");
        let traversal = json!({"identity":{"bridge_id":"bridge","root_id":"root","binding_id":"binding"},"operation":{"type":"download","path":"../escape"}}).to_string();
        let response = post_to("/api/files/download", service, Body::from(traversal)).await;
        assert_eq!(result(response).await["error"]["code"], "invalid_path");
    }

    #[tokio::test]
    async fn uploads_create_new_files_without_overwriting_or_exceeding_limits() {
        let f = Fixture::new();
        let service = f.service();
        let response = post_to(
            "/api/files/upload",
            service.clone(),
            Body::from(upload_body("uploaded", b"payload")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(result(response).await["result"], json!({}));
        assert_eq!(std::fs::read(f.0.join("uploaded")).unwrap(), b"payload");
        let response = post_to(
            "/api/files/upload",
            service.clone(),
            Body::from(upload_body("uploaded", b"replacement")),
        )
        .await;
        assert_eq!(result(response).await["error"]["code"], "already_exists");
        assert_eq!(std::fs::read(f.0.join("uploaded")).unwrap(), b"payload");
        let oversized = oversized_upload_body(MAX_UPLOAD_REQUEST_BYTES + 1);
        let response = post_to("/api/files/upload", service.clone(), Body::from(oversized)).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let mut unframed = b"not a framed upload".to_vec();
        unframed.extend_from_slice(b"payload");
        let response = post_to("/api/files/upload", service, Body::from(unframed)).await;
        assert_eq!(result(response).await["error"]["code"], "invalid_request");
    }

    fn oversized_upload_body(size: usize) -> Vec<u8> {
        let mut bytes = b"herdr-file-upload-1\n".to_vec();
        bytes.resize(size, b' ');
        bytes
    }

    #[tokio::test]
    async fn interrupted_request_never_starts_the_save_and_releases_admission() {
        let f = Fixture::new();
        std::fs::write(f.0.join("file"), b"original").unwrap();
        let service = f.service();
        let chunks = futures_util::stream::iter(vec![
            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"{\"identity\":")),
            Err(std::io::Error::other("connection interrupted")),
        ]);
        let response = call(
            app(Some(service.clone())),
            "127.0.0.1:8787",
            None,
            Body::from_stream(chunks),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read(f.0.join("file")).unwrap(), b"original");
        let permits: Vec<_> = (0..8).map(|_| service.try_acquire().unwrap()).collect();
        assert!(service.try_acquire().is_none());
        drop(permits);
    }

    #[tokio::test]
    async fn rejects_over_limit_body_and_busy_before_reading() {
        let f = Fixture::new();
        let service = f.service();
        let permits: Vec<_> = (0..8).map(|_| service.try_acquire().unwrap()).collect();
        let unreadable = Body::from_stream(futures_util::stream::once(async {
            panic!("busy body must not be read");
            #[allow(unreachable_code)]
            Ok::<Bytes, std::io::Error>(Bytes::new())
        }));
        let response = call(
            app(Some(service.clone())),
            "127.0.0.1:8787",
            None,
            unreadable,
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(result(response).await["error"]["code"], "busy");
        drop(permits);
        let response = call(
            app(Some(service)),
            "127.0.0.1:8787",
            None,
            Body::from(vec![b' '; crate::file_service::MAX_REQUEST_BYTES + 1]),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(result(response).await["error"]["code"], "limit_exceeded");
    }
}
