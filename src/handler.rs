//! Routing, and what every request goes through: the per-route method allowlist and body cap, the request
//! id, the request log and the metrics.

use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

/// Body ceiling for every route that takes one except `/sync`: clears every real settings, plugins and
/// inbox body with room to spare.
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// `/sync` carries the library backup: ciphertext up to `sync::MAX_CIPHERTEXT` plus a small envelope.
pub const SYNC_MAX_BODY_BYTES: usize = crate::sync::MAX_CIPHERTEXT + 4 * 1024;

/// The TV's kill-switch and update gate, unchanged from the Worker.
const CONFIG: &str = r#"{"minSupportedVersion":"0.1.0","recommendedVersion":"0.1.0","features":{"addonModule":true,"aiReco":false}}"#;

pub async fn handle(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let started = Instant::now();
    let method = req.method().clone();
    let route = route_label(req.uri().path());
    let mut resp = dispatch(&state, req, route).await;
    if method == Method::HEAD {
        *resp.body_mut() = Body::empty();
    }
    if let Ok(id) = HeaderValue::from_str(&crate::hex(&crate::random_bytes::<8>())) {
        resp.headers_mut().insert("x-request-id", id);
    }
    let status = resp.status().as_u16();
    state.metrics.record(route, status);
    if state.log_requests {
        eprintln!("{method} {route} {status} {}ms", started.elapsed().as_millis());
    }
    resp
}

async fn dispatch(state: &AppState, req: Request, route: &'static str) -> Response {
    if let Some(allowed) = allowed_methods(route) {
        let m = req.method();
        // A preflight or a HEAD probe never reaches a handler that changes anything.
        if m != Method::OPTIONS && m != Method::HEAD && !allowed.contains(m) {
            return bare_json(StatusCode::METHOD_NOT_ALLOWED, &error("method_not_allowed"));
        }
    }
    // Refused before a byte of the body is read; `read_json` holds the same cap for a body that declares
    // no length.
    if declared_length(&req).is_some_and(|n| n > body_cap(route) as u64) {
        return bare_json(StatusCode::PAYLOAD_TOO_LARGE, &error("payload_too_large"));
    }
    let path = req.uri().path().to_owned();
    if path.starts_with("/link") {
        return crate::link::handle(state, req).await;
    }
    if path.starts_with("/inbox") {
        return crate::inbox::handle(state, req).await;
    }
    if path.starts_with("/sync/") {
        return crate::sync::handle(state, req).await;
    }
    match path.as_str() {
        "/plugins" => crate::plugins::handle(state, req).await,
        "/settings" => crate::settings::handle(state, req).await,
        p if p == "/app" || p.starts_with("/app/") => crate::app::handle(p),
        "/health" => bare_json(StatusCode::OK, &json!({ "status": "ok" })),
        "/version" => bare_json(StatusCode::OK, &json!({ "version": env!("CARGO_PKG_VERSION") })),
        "/config" => raw_json(StatusCode::OK, Body::from(CONFIG), false),
        "/metrics" if metrics_authorized(state, &req) => {
            let mut resp = Response::new(Body::from(state.metrics.render()));
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
            );
            resp
        }
        _ => bare_json(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

/// A stable label per route, so a key in a path never becomes a metric label or a log field.
pub fn route_label(path: &str) -> &'static str {
    match path {
        "/health" => "/health",
        "/version" => "/version",
        "/config" => "/config",
        "/metrics" => "/metrics",
        "/plugins" => "/plugins",
        "/settings" => "/settings",
        "/link/new" => "/link/new",
        "/link/claim" => "/link/claim",
        "/link/poll" => "/link/poll",
        "/inbox/append" => "/inbox/append",
        "/inbox/drain" => "/inbox/drain",
        p if p == "/app" || p.starts_with("/app/") => "/app",
        p if p.starts_with("/sync/") => "/sync/:id",
        _ => "other",
    }
}

fn allowed_methods(route: &str) -> Option<&'static [Method]> {
    const GET: &[Method] = &[Method::GET];
    const GET_PUT: &[Method] = &[Method::GET, Method::PUT];
    const POST: &[Method] = &[Method::POST];
    match route {
        "/health" | "/version" | "/config" | "/metrics" | "/app" | "/link/poll" | "/inbox/drain" => Some(GET),
        "/plugins" | "/settings" | "/sync/:id" => Some(GET_PUT),
        "/link/new" | "/link/claim" | "/inbox/append" => Some(POST),
        _ => None,
    }
}

fn body_cap(route: &str) -> usize {
    if route == "/sync/:id" {
        SYNC_MAX_BODY_BYTES
    } else {
        MAX_BODY_BYTES
    }
}

fn declared_length(req: &Request) -> Option<u64> {
    req.headers().get(header::CONTENT_LENGTH)?.to_str().ok()?.trim().parse().ok()
}

fn metrics_authorized(state: &AppState, req: &Request) -> bool {
    let (Some(want), Some(given)) = (
        state.metrics_token.as_deref(),
        req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
    ) else {
        return false;
    };
    let Some(given) = given.strip_prefix("Bearer ") else { return false };
    constant_time_eq(given.trim().as_bytes(), want.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn error(msg: &str) -> Value {
    json!({ "error": msg })
}

/// A route handler's answer: JSON, never cached — link polls, drains and backups are real-time, and a
/// cached one replays stale state.
pub fn json_reply(status: StatusCode, body: &Value) -> Response {
    raw_json(status, Body::from(body.to_string()), true)
}

/// The router's own answers (health, version, the guards, 404), which the Worker sent without a
/// cache-control header.
fn bare_json(status: StatusCode, body: &Value) -> Response {
    raw_json(status, Body::from(body.to_string()), false)
}

pub fn raw_json(status: StatusCode, body: Body, no_store: bool) -> Response {
    let mut resp = Response::new(body);
    *resp.status_mut() = status;
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if no_store {
        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    resp
}

pub fn method_not_allowed() -> Response {
    json_reply(StatusCode::METHOD_NOT_ALLOWED, &error("method_not_allowed"))
}

/// A storage failure: logged with what failed, answered as a plain 500.
pub fn internal(what: &str, e: std::io::Error) -> Response {
    eprintln!("{what}: {e}");
    bare_json(StatusCode::INTERNAL_SERVER_ERROR, &error("internal_error"))
}

/// The request body as JSON, within `cap` bytes. A body over the cap is a 413; one that isn't JSON a 400.
pub async fn read_json(req: Request, cap: usize) -> Result<Value, Box<Response>> {
    let bytes: Bytes = axum::body::to_bytes(req.into_body(), cap)
        .await
        .map_err(|_| Box::new(bare_json(StatusCode::PAYLOAD_TOO_LARGE, &error("payload_too_large"))))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| Box::new(json_reply(StatusCode::BAD_REQUEST, &error("bad_request"))))
}

/// A query parameter's first value, percent-decoded — what `URLSearchParams.get` answers.
pub fn query_param(req: &Request, name: &str) -> Option<String> {
    url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// The link's inbox key from the `x-den-link` header. A header keeps the key out of URLs, which end up in
/// logs, proxies and history; the query and body forms older clients send still work (`link_key`, and each
/// body's `inboxKey`).
pub fn header_key(req: &Request) -> Option<String> {
    req.headers().get("x-den-link").and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// The link's inbox key on a GET: the header, else the `inboxKey` query parameter.
pub fn link_key(req: &Request) -> String {
    header_key(req).or_else(|| query_param(req, "inboxKey")).unwrap_or_default()
}

/// The connecting address. The server is reached directly on the LAN or through `tailscale serve`, and
/// neither is a proxy whose forwarded header could be trusted over the socket.
pub fn client_ip(req: &Request) -> String {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or_else(|| "unknown".to_owned(), |c| c.0.ip().to_string())
}

/// A string's length as JavaScript counts it, in UTF-16 units — the unit every bound the Worker checked was
/// written in.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// An inbox key as `/link` hands them out: hex, at least 16 characters.
pub fn valid_inbox_key(key: &str) -> bool {
    key.len() >= 16 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    pub fn temp_dir() -> std::path::PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "den-edge-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    pub struct Harness {
        pub state: Arc<AppState>,
        pub clock: Arc<AtomicU64>,
        pub dir: std::path::PathBuf,
    }

    impl Harness {
        pub fn new() -> Self {
            Self::in_dir(temp_dir())
        }

        pub fn in_dir(dir: std::path::PathBuf) -> Self {
            let clock = Arc::new(AtomicU64::new(1_000_000));
            let mut state = AppState::new(crate::store::Store::open(&dir).unwrap(), None, false);
            let c = Arc::clone(&clock);
            state.clock = Box::new(move || c.load(Ordering::Relaxed));
            Harness { state: Arc::new(state), clock, dir }
        }

        /// With the link generators replaced: codes and keys handed out in order, the last one repeating.
        pub fn with_generators(codes: &[&str], keys: &[&str]) -> Self {
            let mut h = Self::new();
            let state = Arc::get_mut(&mut h.state).unwrap();
            state.gen_code = sequence(codes);
            state.gen_inbox_key = sequence(keys);
            h
        }

        pub fn advance(&self, ms: u64) {
            self.clock.fetch_add(ms, Ordering::Relaxed);
        }

        pub async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
            let resp = self.send(method, uri, body.map(|b| b.to_string()), &[]).await;
            let status = resp.status();
            (status, body_json(resp).await)
        }

        pub async fn send(
            &self,
            method: &str,
            uri: &str,
            body: Option<String>,
            headers: &[(&str, &str)],
        ) -> Response {
            let mut builder = axum::http::Request::builder().method(method).uri(uri);
            for (k, v) in headers {
                builder = builder.header(*k, *v);
            }
            let mut req = builder.body(body.map_or_else(Body::empty, Body::from)).unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([192, 168, 1, 9], 5000))));
            handle(State(Arc::clone(&self.state)), req).await
        }
    }

    fn sequence(values: &[&str]) -> Box<dyn Fn() -> String + Send + Sync> {
        let values: Vec<String> = values.iter().map(|v| v.to_string()).collect();
        let next = AtomicUsize::new(0);
        Box::new(move || values[next.fetch_add(1, Ordering::Relaxed).min(values.len() - 1)].clone())
    }

    pub async fn body_text(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    pub async fn body_json(resp: Response) -> Value {
        serde_json::from_str(&body_text(resp).await).unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn health_version_config_and_an_unknown_route() {
        let h = Harness::new();
        assert_eq!(h.call("GET", "/health", None).await, (StatusCode::OK, json!({ "status": "ok" })));
        let (_, version) = h.call("GET", "/version", None).await;
        assert_eq!(version["version"], env!("CARGO_PKG_VERSION"));
        let (status, config) = h.call("GET", "/config", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(config["minSupportedVersion"], "0.1.0");
        assert_eq!(config["features"]["aiReco"], false);
        assert_eq!(h.call("GET", "/nope", None).await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn every_response_carries_a_request_id() {
        let resp = Harness::new().send("GET", "/health", None, &[]).await;
        assert_eq!(resp.headers()["x-request-id"].len(), 16);
    }

    #[tokio::test]
    async fn the_method_allowlist_and_body_caps_answer_before_any_handler() {
        let h = Harness::new();
        assert_eq!(
            h.call("DELETE", "/health", None).await,
            (StatusCode::METHOD_NOT_ALLOWED, error("method_not_allowed"))
        );
        assert_eq!(h.call("GET", "/link/new", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(h.call("DELETE", "/settings", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
        // An unknown route is the router's 404, whatever the method.
        assert_eq!(h.call("DELETE", "/nope", None).await.0, StatusCode::NOT_FOUND);
        // A preflight and a HEAD probe pass the allowlist; HEAD carries no body.
        assert_eq!(h.call("OPTIONS", "/health", None).await.0, StatusCode::OK);
        let head = h.send("HEAD", "/health", None, &[]).await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(body_text(head).await, "");

        let declared = |n: usize| n.to_string();
        let too_big = declared(SYNC_MAX_BODY_BYTES + 1);
        let r = h.send("PUT", "/sync/deadbeefcafe1234", None, &[("content-length", &too_big)]).await;
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        // /sync carries a library-sized body while every other route keeps the small cap.
        let over_small = declared(MAX_BODY_BYTES + 1);
        let r = h.send("PUT", "/plugins", None, &[("content-length", &over_small)]).await;
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        // ...and a body that declares no length is held to the same cap as it is read.
        let big = format!(
            r#"{{"inboxKey":"abcdef0123456789","addons":[],"pad":"{}"}}"#,
            "x".repeat(MAX_BODY_BYTES)
        );
        assert_eq!(h.send("PUT", "/plugins", Some(big), &[]).await.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn metrics_are_off_without_a_token_and_count_by_route() {
        let h = Harness::new();
        assert_eq!(h.call("GET", "/metrics", None).await.0, StatusCode::NOT_FOUND);

        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().metrics_token = Some("s3cret".into());
        h.call("GET", "/health", None).await;
        h.call("GET", "/sync/0123456789abcdef", None).await;
        assert_eq!(
            h.send("GET", "/metrics", None, &[("authorization", "Bearer nope")]).await.status(),
            StatusCode::NOT_FOUND
        );
        let text =
            body_text(h.send("GET", "/metrics", None, &[("authorization", "Bearer s3cret")]).await).await;
        assert!(text.contains(r#"den_edge_requests_total{route="/health",status="200"} 1"#), "{text}");
        // A key in a path never becomes a label.
        assert!(
            text.contains(r#"route="/sync/:id",status="404""#) && !text.contains("0123456789abcdef"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn the_companion_page_is_served_whole() {
        let h = Harness::new();
        let page = h.send("GET", "/app", None, &[]).await;
        assert!(page.headers()[header::CONTENT_TYPE].to_str().unwrap().contains("text/html"));
        let html = body_text(page).await;
        assert!(html.contains("Link your phone") && html.contains(r#"<script src="/app/app.js">"#));
        let js = body_text(h.send("GET", "/app/app.js", None, &[]).await).await;
        assert!(
            js.contains("/link/claim") && js.contains("/inbox/append") && js.contains("api.themoviedb.org")
        );
        let manifest = h.send("GET", "/app/manifest.webmanifest", None, &[]).await;
        assert_eq!(manifest.headers()[header::CONTENT_TYPE], "application/manifest+json");
        assert_eq!(body_json(manifest).await["start_url"], "/app/");
        assert_eq!(h.send("GET", "/app/nope.png", None, &[]).await.status(), StatusCode::NOT_FOUND);
    }
}
