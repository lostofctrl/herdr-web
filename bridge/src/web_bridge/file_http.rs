//! File HTTP adapter. Not registered with the production router.

use super::{ensure_allowed_request, RequestPolicy};
use crate::file_service::{FileService, MAX_REQUEST_BYTES};
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

async fn bounded_body(body: Body) -> Result<Vec<u8>, BodyError> {
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BodyError::Disconnected)?;
        if chunk.len() > MAX_REQUEST_BYTES - bytes.len() {
            return Err(BodyError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Admission is acquired before body consumption and moved into the blocking
/// worker, which retains it even if the requesting client disconnects.
pub(super) async fn handle_request(
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
    let bytes = match tokio::time::timeout(
        Duration::from_secs(15),
        bounded_body(request.into_body()),
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
    match tokio::task::spawn_blocking(move || service.handle_admitted(permit, &bytes)).await {
        Ok(bytes) => json_response(StatusCode::OK, bytes),
        Err(_) => early_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "io_error",
            "File operation failed",
        ),
    }
}

#[allow(dead_code)]
pub(super) async fn file_request(State(state): State<FileHttpState>, request: Request) -> Response {
    handle_request(state.service, &state.policy, request).await
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
    fn app(service: Option<Arc<FileService>>) -> Router {
        Router::new()
            .route("/api/files", post(file_request))
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
