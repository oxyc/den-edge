//! Routing, and what every request goes through: the per-route method allowlist and body cap, the request
//! id, the request log and the metrics.

use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

/// Body ceiling for every route that takes one except a library batch: clears every real inbox and pairing body
/// with room to spare.
pub const MAX_BODY_BYTES: usize = 256 * 1024;

/// The TV's kill-switch and update gate, unchanged from the Worker.
const CONFIG: &str = r#"{"minSupportedVersion":"0.1.0","recommendedVersion":"0.1.0","features":{"addonModule":true,"aiReco":false}}"#;

pub async fn handle(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let started = Instant::now();
    // In the answer and in the log line, so a device's report can be matched to this request.
    let rid = crate::hex(&crate::random_bytes::<8>());
    let method = req.method().clone();
    let route = route_label(req.uri().path());
    let origin = allowed_origin(&state, &req);
    let mut resp = match &origin {
        Some(_)
            if method == Method::OPTIONS
                && req.headers().contains_key(header::ACCESS_CONTROL_REQUEST_METHOD) =>
        {
            preflight()
        }
        _ => dispatch(&state, req, route).await,
    };
    if method == Method::HEAD {
        *resp.body_mut() = Body::empty();
    }
    if let Some(origin) = origin {
        resp.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    if !state.web_origins.is_empty() {
        resp.headers_mut().append(header::VARY, HeaderValue::from_static("origin"));
    }
    harden(resp.headers_mut());
    if let Ok(id) = HeaderValue::from_str(&rid) {
        resp.headers_mut().insert("x-request-id", id);
    }
    let status = resp.status().as_u16();
    state.metrics.record(route, status);
    if state.log_requests {
        eprintln!("{method} {route} {status} {}ms rid={rid}", started.elapsed().as_millis());
    }
    resp
}

/// What every answer carries, for the day one is opened as a page or embedded elsewhere: no type sniffing, no
/// referrer (a TMDB image request would otherwise carry this host's name), this origin only, and none of the
/// powerful browser features. An API answer is data, so it also gets a policy under which, rendered, it can do
/// nothing. A page's own policy (the web app's) is left as it is.
fn harden(headers: &mut HeaderMap) {
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::STRICT_TRANSPORT_SECURITY, "max-age=31536000"),
        (HeaderName::from_static("cross-origin-opener-policy"), "same-origin"),
        (HeaderName::from_static("cross-origin-resource-policy"), "same-origin"),
        (
            HeaderName::from_static("permissions-policy"),
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ),
    ] {
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    let is_json =
        headers.get(header::CONTENT_TYPE).is_some_and(|v| v.as_bytes().starts_with(b"application/json"));
    if is_json && !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'; sandbox"),
        );
    }
}

/// The request's `Origin` when it is one of `WEB_ORIGINS` — the Den web app, which the browser serves from
/// another origin than den-edge's. No credentials are involved: the keys travel in headers the app sets.
fn allowed_origin(state: &AppState, req: &Request) -> Option<HeaderValue> {
    let origin = req.headers().get(header::ORIGIN)?;
    let value = origin.to_str().ok()?;
    state.web_origins.iter().any(|o| o == value).then(|| origin.clone())
}

/// The answer to an allowed origin's CORS preflight: the methods the routes take and the headers that carry
/// the keys, remembered for a day.
fn preflight() -> Response {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    let headers = resp.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, PUT, POST, DELETE"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, x-den-link, x-den-library-token"),
    );
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
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
    let face = Face::of(state, &req);
    if !face.serves(&path) {
        return bare_json(StatusCode::NOT_FOUND, &error("not_found"));
    }
    let path_and_query = req.uri().path_and_query().map_or_else(|| path.clone(), |pq| pq.as_str().to_owned());
    if let Some(target) = crate::relay::target(&state.relays, &path_and_query) {
        return crate::relay::relay(state, req, target).await;
    }
    if path.starts_with("/link") {
        return crate::link::handle(state, req).await;
    }
    if path.starts_with("/inbox") {
        return crate::inbox::handle(state, req).await;
    }
    if path.starts_with("/pair/") {
        return crate::pair::handle(state, req).await;
    }
    if path.starts_with("/sync/") {
        return crate::sync::handle(state, req).await;
    }
    if path.starts_with("/lib/") {
        return crate::library::handle(state, req).await;
    }
    match path.as_str() {
        "/health" => bare_json(StatusCode::OK, &json!({ "status": "ok" })),
        "/version" => bare_json(StatusCode::OK, &json!({ "version": env!("CARGO_PKG_VERSION") })),
        "/config" => raw_json(StatusCode::OK, Body::from(CONFIG), false),
        "/routes" => bare_json(StatusCode::OK, &crate::routes::to_json(&state.routes)),
        "/metrics" if metrics_authorized(state, &req) => {
            let mut resp = Response::new(Body::from(state.metrics.render()));
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
            );
            resp
        }
        "/metrics" => bare_json(StatusCode::NOT_FOUND, &error("not_found")),
        p => match &state.web_dir {
            Some(dir) if matches!(*req.method(), Method::GET | Method::HEAD) => {
                crate::web::serve(dir, p, &state.remux_origins).await
            }
            _ => bare_json(StatusCode::NOT_FOUND, &error("not_found")),
        },
    }
}

/// Which half of den-edge a request's `Host` names (oxyc/den#15). The web app's public name sits behind
/// Cloudflare Access and the device API's bypasses it, so each serves only its own half: without this the
/// bypassed name would hand out the web app past Access, and the split would be decorative. Any other name —
/// the LAN address, the tailnet's — serves both, as it always has.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Face {
    Web,
    Api,
    Both,
}

impl Face {
    fn of(state: &AppState, req: &Request) -> Face {
        let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).or_else(|| req.uri().host());
        let named = |names: &[String]| host.is_some_and(|h| names.iter().any(|n| n.eq_ignore_ascii_case(h)));
        if named(&state.web_hosts) {
            Face::Web
        } else if named(&state.api_hosts) {
            Face::Api
        } else {
            Face::Both
        }
    }

    /// `/health` and `/version` answer on every name; the device routes, `/config` and `/metrics` only where
    /// devices call; the web app's files only where browsers load it. The web app is a device too: the routes it
    /// calls on its own origin — pairing, the library log, sending to the TV — answer on its name as well, where
    /// they sit behind Access. What only a TV does (draining its inbox, unlinking, `/config`) stays off it.
    fn serves(self, path: &str) -> bool {
        let device = ["/link", "/inbox", "/pair/", "/sync/", "/lib/"].iter().any(|p| path.starts_with(p))
            || matches!(path, "/config" | "/metrics");
        let web_app_calls =
            path.starts_with("/pair/") || path.starts_with("/lib/") || path == "/inbox/append";
        match (self, path) {
            (_, "/health" | "/version" | "/routes") | (Face::Both, _) => true,
            (Face::Api, _) => device,
            (Face::Web, _) => !device || web_app_calls,
        }
    }
}

/// A stable label per route, so a key in a path never becomes a metric label or a log field.
pub fn route_label(path: &str) -> &'static str {
    match path {
        "/health" => "/health",
        "/version" => "/version",
        "/config" => "/config",
        "/routes" => "/routes",
        "/metrics" => "/metrics",
        "/link" => "/link",
        "/inbox/append" => "/inbox/append",
        "/inbox/drain" => "/inbox/drain",
        "/pair/new" => "/pair/new",
        "/pair/open" => "/pair/open",
        p if p.starts_with("/pair/") && p.matches('/').count() == 3 => "/pair/:sid/:slot",
        p if p.starts_with("/pair/") => "/pair/:sid",
        p if p.starts_with("/sync/") => "/sync/:id",
        p if p.starts_with("/lib/") && p.ends_with("/batch") => "/lib/:id/batch",
        p if p.starts_with("/lib/") && p.ends_with("/changes") => "/lib/:id/changes",
        p if p.starts_with("/lib/") && p.matches('/').count() == 2 => "/lib/:id",
        _ => "other",
    }
}

fn allowed_methods(route: &str) -> Option<&'static [Method]> {
    const GET: &[Method] = &[Method::GET];
    const GET_PUT: &[Method] = &[Method::GET, Method::PUT];
    const POST: &[Method] = &[Method::POST];
    const DELETE: &[Method] = &[Method::DELETE];
    match route {
        "/health" | "/version" | "/config" | "/metrics" | "/inbox/drain" | "/lib/:id/changes" => Some(GET),
        "/pair/:sid/:slot" => Some(GET_PUT),
        "/inbox/append" | "/lib/:id/batch" | "/pair/new" | "/pair/open" => Some(POST),
        "/link" | "/pair/:sid" | "/lib/:id" | "/sync/:id" => Some(DELETE),
        _ => None,
    }
}

fn body_cap(route: &str) -> usize {
    match route {
        "/lib/:id/batch" => crate::library::BATCH_MAX_BODY_BYTES,
        _ => MAX_BODY_BYTES,
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

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn error(msg: &str) -> Value {
    json!({ "error": msg })
}

/// A route handler's answer: JSON, never cached — pairing slots, drains and backups are real-time, and a
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

/// A storage failure: logged with what failed, answered as a plain 500 — or a 507 when the store is at its cap.
pub fn internal(what: &str, e: std::io::Error) -> Response {
    eprintln!("{what}: {e}");
    if e.kind() == std::io::ErrorKind::StorageFull {
        return bare_json(StatusCode::INSUFFICIENT_STORAGE, &error("storage_full"));
    }
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
/// logs, proxies and history — a CDN's included — so the `?inboxKey=` form older clients sent is no longer
/// read. A body's `inboxKey` still is: bodies aren't logged.
pub fn header_key(req: &Request) -> Option<String> {
    req.headers().get("x-den-link").and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// The link's inbox key on a request without a body: the header, or nothing.
pub fn link_key(req: &Request) -> String {
    header_key(req).unwrap_or_default()
}

/// The visitor's address, for the per-address limits. den-edge is reached directly on the LAN, or through
/// `tailscale serve` and `cloudflared`, which connect from their own address — so behind a proxy listed in
/// `TRUSTED_PROXIES` the address is the one that proxy reports: `CF-Connecting-IP` (Cloudflare), else the last
/// `X-Forwarded-For` entry, the one the proxy added. From anyone else those headers are ignored: they could say
/// anything.
pub fn client_ip(state: &AppState, req: &Request) -> String {
    let Some(peer) = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip()) else {
        return "unknown".to_owned();
    };
    if state.trusted_proxies.contains(&peer) {
        let reported = header_value(req, "cf-connecting-ip")
            .or_else(|| header_value(req, "x-forwarded-for").and_then(|v| v.rsplit(',').next()))
            .and_then(|v| v.trim().parse::<std::net::IpAddr>().ok());
        if let Some(visitor) = reported {
            return visitor.to_string();
        }
    }
    peer.to_string()
}

fn header_value<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers().get(name)?.to_str().ok()
}

/// A link credential: hex, at least 16 characters (a paired link's is 48).
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
            Self::in_dir_with(dir, |_| {})
        }

        /// A harness whose state `configure` sets up first: a setting that comes from the environment.
        pub fn in_dir_with(dir: std::path::PathBuf, configure: impl FnOnce(&mut AppState)) -> Self {
            let clock = Arc::new(AtomicU64::new(1_000_000));
            let store = crate::store::Store::open(&dir, crate::store::DEFAULT_CAP).unwrap();
            let mut state = AppState::new(store, None, false);
            let c = Arc::clone(&clock);
            state.clock = Box::new(move || c.load(Ordering::Relaxed));
            configure(&mut state);
            Harness { state: Arc::new(state), clock, dir }
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

    pub fn sequence(values: &[&str]) -> Box<dyn Fn() -> String + Send + Sync> {
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

    /// A harness serving a web app, with `d.oxy.fi` as its public name and `d-api.oxy.fi` as the device API's.
    fn split_harness() -> Harness {
        let mut h = Harness::new();
        let web = temp_dir();
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("index.html"), "<!doctype html><title>Den</title>").unwrap();
        let s = Arc::get_mut(&mut h.state).unwrap();
        s.web_dir = Some(web);
        s.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        s.api_hosts = crate::parse_hosts("API_HOSTS", " D-API.oxy.fi ,bad:8443");
        s.routes = crate::routes::parse(
            "scout=http://192.168.86.193:8080 https://pve.example:8443/scout access:https://d-scout.oxy.fi;\
             remux=http://192.168.86.193:8095/remux https://pve.example:8443/remux",
        );
        s.remux_origins = crate::routes::remux_origins(&s.routes);
        h
    }

    #[tokio::test]
    async fn every_name_serves_the_whole_routes_table() {
        let h = split_harness();
        // Away from home, a client still matches its LAN install URLs against the LAN entries.
        for host in ["192.168.86.193:8094", "d.oxy.fi", "d-api.oxy.fi"] {
            let routes = body_json(h.send("GET", "/routes", None, &[("host", host)]).await).await;
            assert_eq!(routes["addons"]["scout"][0]["url"], "http://192.168.86.193:8080", "{host}");
        }
        // The player may reach den-remux there, and a trailer plays in YouTube's embed.
        let page = h.send("GET", "/", None, &[("host", "d.oxy.fi")]).await;
        let csp = page.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_owned();
        assert!(csp.contains("media-src 'self' blob: https://pve.example:8443;"), "{csp}");
        assert!(
            csp.contains("connect-src 'self' https://api.themoviedb.org https://pve.example:8443;"),
            "{csp}"
        );
        assert!(csp.contains("frame-src https://www.youtube-nocookie.com;"), "{csp}");
    }

    /// A fake addon on a local port, answering with what it was sent — so a test sees what the relay passed on.
    async fn addon() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|req: Request| async move {
            let (parts, body) = req.into_parts();
            let body = axum::body::to_bytes(body, 1024).await.unwrap();
            let seen = json!({
                "method": parts.method.as_str(),
                "uri": parts.uri.to_string(),
                "cookie": parts.headers.contains_key(header::COOKIE),
                "access": parts.headers.contains_key("cf-access-client-id"),
                "body": String::from_utf8_lossy(&body),
            });
            let mut resp = Response::new(Body::from(seen.to_string()));
            resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("tracking=1"));
            resp
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn the_web_app_asks_the_addons_through_its_own_name() {
        let mut h = split_harness();
        let scout = addon().await;
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays(&format!("/scout={scout}"));
        let resp = h
            .send(
                "POST",
                "/scout/sealed-cfg/availability?x=1",
                Some(r#"{"ids":["tt1"]}"#.into()),
                &[
                    ("host", "d.oxy.fi"),
                    ("content-type", "application/json"),
                    ("cookie", "CF_Authorization=session"),
                    ("cf-access-client-id", "token"),
                ],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!resp.headers().contains_key(header::SET_COOKIE), "the addon's cookie stays behind");
        assert_eq!(
            body_json(resp).await,
            json!({
                "method": "POST",
                "uri": "/sealed-cfg/availability?x=1",
                "cookie": false,
                "access": false,
                "body": r#"{"ids":["tt1"]}"#,
            }),
            "the path and body go along; the browser's session and Cloudflare's headers don't"
        );
        // Never on the device API's name, which bypasses Access; and only what an addon's JSON takes.
        let on_api = h.send("GET", "/scout/cfg/manifest.json", None, &[("host", "d-api.oxy.fi")]).await;
        assert_eq!(on_api.status(), StatusCode::NOT_FOUND);
        let put = h.send("PUT", "/scout/cfg/manifest.json", None, &[("host", "d.oxy.fi")]).await;
        assert_eq!(put.status(), StatusCode::METHOD_NOT_ALLOWED);
        // A prefix must be a whole path segment.
        let beside = h.send("GET", "/scoutx/library", None, &[("host", "d.oxy.fi")]).await;
        assert!(body_text(beside).await.contains("<title>Den</title>"), "not relayed: the app's shell");
    }

    #[test]
    fn relays_are_a_path_segment_and_a_plain_origin() {
        let relays = crate::parse_relays(
            "/scout=http://192.168.86.193:8080/, /bad path=http://x, /atlas=ftp://x, atlas=http://y",
        );
        assert_eq!(relays, [("/scout".to_owned(), "http://192.168.86.193:8080".to_owned())]);
    }

    #[tokio::test]
    async fn each_public_name_serves_only_its_half() {
        let h = split_harness();
        let status = |host: &'static str, method: &'static str, path: &'static str| {
            let h = &h;
            async move { h.send(method, path, None, &[("host", host)]).await.status() }
        };
        // The web app's name: the app and the routes it calls, and nothing only a TV does.
        assert_eq!(status("d.oxy.fi", "GET", "/").await, StatusCode::OK);
        for path in ["/config", "/inbox/drain", "/metrics"] {
            assert_eq!(status("d.oxy.fi", "GET", path).await, StatusCode::NOT_FOUND, "{path} on d");
        }
        assert_eq!(status("d.oxy.fi", "DELETE", "/link").await, StatusCode::NOT_FOUND);
        assert_ne!(
            status("d.oxy.fi", "POST", "/pair/open").await,
            StatusCode::NOT_FOUND,
            "pairing a browser"
        );
        // A batch, not changes: an unwritten library's changes are a 404 of their own.
        let batch = status("d.oxy.fi", "POST", "/lib/0123456789abcdef/batch").await;
        assert_ne!(batch, StatusCode::NOT_FOUND, "the library log");
        assert_ne!(status("d.oxy.fi", "POST", "/inbox/append").await, StatusCode::NOT_FOUND, "Play on TV");
        // The device API's name, however it is cased: the device routes, and never the app.
        assert_eq!(status("D-Api.Oxy.Fi", "GET", "/").await, StatusCode::NOT_FOUND);
        assert_eq!(status("d-api.oxy.fi", "GET", "/index.html").await, StatusCode::NOT_FOUND);
        let lan_drain = status("192.168.86.193:8094", "GET", "/inbox/drain").await;
        assert_ne!(lan_drain, StatusCode::NOT_FOUND, "the premise: the drain answers on the LAN");
        assert_eq!(status("d-api.oxy.fi", "GET", "/inbox/drain").await, lan_drain);
        // Both answer /health; any other name serves both halves, as before.
        for host in ["d.oxy.fi", "d-api.oxy.fi", "192.168.86.193:8094"] {
            assert_eq!(status(host, "GET", "/health").await, StatusCode::OK, "{host}");
        }
        assert_eq!(status("192.168.86.193:8094", "GET", "/").await, StatusCode::OK);
        // A name with a port was refused when parsed, so it does not name the API half.
        assert_eq!(status("bad:8443", "GET", "/").await, StatusCode::OK);
    }

    /// Addresses come from `/routes` alone now (den #16): `/config` is the kill-switch and the update gate.
    #[tokio::test]
    async fn config_carries_no_addresses() {
        let h = split_harness();
        let config =
            body_json(h.send("GET", "/config", None, &[("host", "192.168.86.193:8094")]).await).await;
        assert_eq!(config["minSupportedVersion"], "0.1.0");
        assert!(config.get("lan").is_none() && config.get("access").is_none(), "{config}");
    }

    #[tokio::test]
    async fn the_web_app_origin_gets_cors_and_no_other_origin_does() {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().web_origins = vec!["https://pve.example".into()];
        let preflight = h
            .send(
                "OPTIONS",
                "/lib/0123456789abcdef/changes",
                None,
                &[("origin", "https://pve.example"), ("access-control-request-method", "GET")],
            )
            .await;
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(preflight.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://pve.example");
        let allowed = preflight.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS].to_str().unwrap();
        assert!(allowed.contains("x-den-library-token") && allowed.contains("x-den-link"), "{allowed}");

        let get = h.send("GET", "/health", None, &[("origin", "https://pve.example")]).await;
        assert_eq!(get.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://pve.example");
        assert_eq!(get.headers()[header::VARY], "origin");
        let other = h.send("GET", "/health", None, &[("origin", "https://elsewhere.example")]).await;
        assert!(!other.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        let other_preflight = h
            .send(
                "OPTIONS",
                "/inbox/append",
                None,
                &[("origin", "https://elsewhere.example"), ("access-control-request-method", "POST")],
            )
            .await;
        assert_ne!(
            other_preflight.status(),
            StatusCode::NO_CONTENT,
            "no preflight for an origin not on the list"
        );
    }

    #[test]
    fn a_full_store_answers_507_and_other_failures_500() {
        let full = std::io::Error::new(std::io::ErrorKind::StorageFull, "cap");
        assert_eq!(internal("write", full).status(), StatusCode::INSUFFICIENT_STORAGE);
        let other = std::io::Error::other("disk");
        assert_eq!(internal("write", other).status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn every_response_carries_a_request_id() {
        let resp = Harness::new().send("GET", "/health", None, &[]).await;
        assert_eq!(resp.headers()["x-request-id"].len(), 16);
    }

    #[tokio::test]
    async fn every_answer_is_hardened_and_an_api_answer_can_do_nothing_as_a_page() {
        let h = Harness::new();
        let api = h.send("GET", "/health", None, &[]).await;
        for (name, value) in [
            ("x-content-type-options", "nosniff"),
            ("referrer-policy", "no-referrer"),
            ("cross-origin-opener-policy", "same-origin"),
            ("cross-origin-resource-policy", "same-origin"),
        ] {
            assert_eq!(api.headers()[name], value, "{name}");
        }
        assert_eq!(
            api.headers()[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; frame-ancestors 'none'; sandbox"
        );
    }

    #[tokio::test]
    async fn the_method_allowlist_and_body_caps_answer_before_any_handler() {
        let h = Harness::new();
        assert_eq!(
            h.call("DELETE", "/health", None).await,
            (StatusCode::METHOD_NOT_ALLOWED, error("method_not_allowed"))
        );
        assert_eq!(h.call("GET", "/link", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(h.call("GET", "/sync/0123456789abcdef", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(h.call("GET", "/plugins", None).await.0, StatusCode::NOT_FOUND, "a retired route is gone");
        // An unknown route is the router's 404, whatever the method.
        assert_eq!(h.call("DELETE", "/nope", None).await.0, StatusCode::NOT_FOUND);
        // A preflight and a HEAD probe pass the allowlist; HEAD carries no body.
        assert_eq!(h.call("OPTIONS", "/health", None).await.0, StatusCode::OK);
        let head = h.send("HEAD", "/health", None, &[]).await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(body_text(head).await, "");

        let declared = |n: usize| n.to_string();
        let too_big = declared(crate::library::BATCH_MAX_BODY_BYTES + 1);
        let r = h.send("POST", "/lib/0123456789abcdef/batch", None, &[("content-length", &too_big)]).await;
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        // A batch carries a library's rows while every other route keeps the small cap.
        let over_small = declared(MAX_BODY_BYTES + 1);
        let r = h.send("POST", "/inbox/append", None, &[("content-length", &over_small)]).await;
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        // ...and a body that declares no length is held to the same cap as it is read.
        let big = format!(r#"{{"inboxKey":"abcdef0123456789","sealed":"{}"}}"#, "x".repeat(MAX_BODY_BYTES));
        let r = h.send("POST", "/inbox/append", Some(big), &[]).await;
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn metrics_are_off_without_a_token_and_count_by_route() {
        let h = Harness::new();
        assert_eq!(h.call("GET", "/metrics", None).await.0, StatusCode::NOT_FOUND);

        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().metrics_token = Some("s3cret".into());
        h.call("GET", "/health", None).await;
        h.call("DELETE", "/sync/0123456789abcdef", None).await;
        assert_eq!(
            h.send("GET", "/metrics", None, &[("authorization", "Bearer nope")]).await.status(),
            StatusCode::NOT_FOUND
        );
        let text =
            body_text(h.send("GET", "/metrics", None, &[("authorization", "Bearer s3cret")]).await).await;
        assert!(text.contains(r#"den_edge_requests_total{route="/health",status="200"} 1"#), "{text}");
        // A key in a path never becomes a label.
        assert!(
            text.contains(r#"route="/sync/:id",status="200""#) && !text.contains("0123456789abcdef"),
            "{text}"
        );
    }
}
