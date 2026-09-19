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

/// The TV's kill-switch and update gate, and the public client configuration a browser needs to offer what it
/// can offer. Nothing in it is a secret: it is what any client of this box may know about itself.
fn config(state: &AppState) -> String {
    let mut config = json!({
        "minSupportedVersion": "0.1.0",
        "recommendedVersion": "0.1.0",
        "features": { "addonModule": true, "aiReco": false },
    });
    // SIMKL's PIN flow runs in the browser and needs only the app's public client id. Left out when unset, so
    // the web app hides a sign-in it could not complete rather than offering one that fails.
    if let Some(id) = &state.simkl_client_id {
        config["simklClientId"] = Value::String(id.clone());
    }
    config.to_string()
}

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
        _ => dispatch(&state, req, route, &rid).await,
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
/// another origin than den-edge's. Credentials travel only in explicit headers this allow-list permits.
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
        HeaderValue::from_static("content-type, x-den-link, x-den-library-token, x-den-library-member"),
    );
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    resp
}

/// `rid` is this request's id, the one the log line and the answer both carry. It travels on to an addon the
/// relay asks, so a line here and a line there can be put side by side — without it the two halves of one
/// request were two unrelated entries in two journals.
async fn dispatch(state: &Arc<AppState>, req: Request, route: &'static str, rid: &str) -> Response {
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
        return crate::relay::relay(state, req, target, rid, face).await;
    }
    if path.starts_with("/tmdb/") {
        return crate::tmdb::handle(state, req, rid).await;
    }
    // doesthedogdie's content warnings, which a browser cannot ask for itself: they answer no CORS preflight.
    if path.starts_with("/warnings/") {
        return crate::warnings::handle(state, req, rid).await;
    }
    // Allowlisted title metadata learned by a paired client. Provenance keeps direct TMDB observations apart
    // from Atlas's existing JustWatch-sourced IMDb score.
    if path == "/metadata/title" || path == "/metadata/title/query" {
        return crate::title_metadata::handle(state, req).await;
    }
    // OMDb's ratings, kept for every device the same way.
    if path.starts_with("/ratings/") {
        return crate::ratings::handle(state, req, rid).await;
    }
    // SkipDB's skip segments, kept the same way, for the web app alone: the Apple TV asks SkipDB itself and
    // keeps its own answers on the device.
    if path.starts_with("/skipdb/") {
        return crate::skipdb::handle(state, req, rid).await;
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
        "/config" => revalidated(config(state), req.headers()),
        // Both public names get the public table when the deployment built one: a stranger at either has no use
        // for the LAN addresses or the tailnet name, and publishing the homelab's shape to anyone who asks is
        // not part of answering them. The LAN and the tailnet keep the whole table, which is what a TV at home
        // and a phone on the tailnet read.
        //
        // The device API was deliberately exempt from this for a while, and the reason it no longer needs to be
        // is worth recording. A TV does not merely READ this table: it matches its own URLs against it and
        // rewrites them to whatever works from where it is standing, and an away fetch OVERWRITES its stored
        // copy — so a public-only answer here used to make it discard the one `edge` entry keeping its sync and
        // pairing reachable, by its own hand. What changed is on the TV: it now addresses den-edge by the public
        // name to begin with and takes its table from the LAN face at home, so nothing it needs comes from this
        // answer. Trailers are the case that looks alarming and is not — the routes table only ever OVERRIDES a
        // URL that matches an entry, so an addon installed by an address that already works is simply not
        // rewritten, and reel at home lands on the same LAN address either way.
        //
        // What is still load-bearing here is `edge` itself carrying at least one https entry. It is the only
        // bootstrap a device with no stored table has, and the only fallback when the LAN cannot be reached:
        // losing it strands a TV, where losing reel would only cost it a trailer.
        "/routes" => {
            let table = match (face, &state.routes_public) {
                (Face::Web | Face::Api, Some(public)) => public,
                _ => &state.routes,
            };
            revalidated(crate::routes::to_json(table).to_string(), req.headers())
        }
        "/metrics" if metrics_authorized(state, &req) => {
            let mut resp = Response::new(Body::from(state.metrics.render()));
            resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
            );
            resp
        }
        "/metrics" => bare_json(StatusCode::NOT_FOUND, &error("not_found")),
        p => match &state.web_dir {
            Some(_) if matches!(*req.method(), Method::GET | Method::HEAD) => {
                let query = req.uri().query().map(str::to_owned);
                crate::web::serve(state, p, query.as_deref(), req.headers(), face).await
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
    Invalid,
}

impl Face {
    fn of(state: &AppState, req: &Request) -> Face {
        let mut fields = req.headers().get_all(header::HOST).iter();
        let first = fields.next();
        if fields.next().is_some() {
            return Face::Invalid;
        }
        let raw = match first {
            Some(h) => match h.to_str() {
                Ok(h) => Some(h),
                Err(_) => return Face::Invalid,
            },
            None => req.uri().authority().map(|a| a.as_str()),
        };
        let host = match raw {
            Some(raw) => match raw.parse::<axum::http::uri::Authority>() {
                Ok(a) if !raw.contains('@') && (a.port().is_none() || a.port_u16().is_some()) => {
                    let name = a.host().trim_end_matches('.').to_ascii_lowercase();
                    if name.is_empty() {
                        return Face::Invalid;
                    }
                    Some(name)
                }
                _ => return Face::Invalid,
            },
            None => None,
        };
        let named = |names: &[String]| {
            host.as_ref()
                .is_some_and(|h| names.iter().any(|n| n.trim_end_matches('.').eq_ignore_ascii_case(h)))
        };
        if named(&state.web_hosts) {
            Face::Web
        } else if named(&state.api_hosts) {
            Face::Api
        } else {
            Face::Both
        }
    }

    /// `/health`, `/version`, `/routes` and `/config` answer on every name; the device routes and `/metrics`
    /// only where devices call; the web app's files only where browsers load it. The web app is a device too:
    /// the routes it calls on its own origin — pairing, the library log, sending to the TV — answer on its name
    /// as well, where they sit behind Access. What only a TV does (draining its inbox, unlinking) stays off it.
    ///
    /// `/config` was a TV's alone until the web app needed the same public client configuration — the SIMKL
    /// client id it must have to offer a sign-in. It carries no secret and never has.
    fn serves(self, path: &str) -> bool {
        let device = ["/link", "/inbox", "/pair/", "/sync/", "/lib/"].iter().any(|p| path.starts_with(p))
            || path == "/metrics";
        let web_app_calls =
            path.starts_with("/pair/") || path.starts_with("/lib/") || path == "/inbox/append";
        // TMDB, the content warnings and the ratings through this origin answer on every name: a browser asks them
        // on the public one, and a TV on the LAN or the device API. They lend a key and read nothing of this box, so
        // neither half owns them.
        let tmdb = path.starts_with("/tmdb/")
            || path.starts_with("/warnings/")
            || path.starts_with("/ratings/")
            || path.starts_with("/metadata/")
            || path.starts_with("/skipdb/");
        match (self, path) {
            (Face::Invalid, _) => false,
            (_, "/health" | "/version" | "/routes" | "/config") | (Face::Both, _) => true,
            _ if tmdb => true,
            (Face::Api, _) => device,
            (Face::Web, _) => !device || web_app_calls,
        }
    }
}

/// reel's own route inside the relay mount.
///
/// Every relayed request used to log as `other`, which left a hero's ask indistinguishable from a
/// press's warm-up, and a master fetch from a segment — most of what there is to know when a trailer
/// is slow. The config segment is optional, so a verb is found by name rather than by position, and an
/// unknown `/m/<kind>` is still named rather than collapsed: a kind falling through to the JSON path
/// was the 0.133.0 bug, and a label that hides it would hide the next one too.
fn reel_route(rest: &str) -> &'static str {
    let mut rest = rest;
    loop {
        let (segment, tail) = rest.split_once('/').unwrap_or((rest, ""));
        let mut beyond = tail.split('/');
        let (next, then) = (beyond.next().unwrap_or(""), beyond.next().unwrap_or(""));
        match segment {
            "m" if next == "n" => return "/reel/m/n",
            "m" if next == "s" && then == "seg" => return "/reel/m/s/seg",
            "m" if next == "s" => return "/reel/m/s",
            "m" => return "/reel/m",
            "sources" => return "/reel/sources",
            "meta" => return "/reel/meta",
            "play" => return "/reel/play",
            "hls" if next == "seg" => return "/reel/hls/seg",
            "hls" => return "/reel/hls",
            "seg" => return "/reel/seg",
            "progressive" => return "/reel/progressive",
            "direct" => return "/reel/direct",
            "crop" => return "/reel/crop",
            _ => {}
        }
        if tail.is_empty() {
            return "/reel";
        }
        rest = tail;
    }
}

/// A stable label per route, so a key in a path never becomes a metric label or a log field.
pub fn route_label(path: &str) -> &'static str {
    if let Some(rest) = path.strip_prefix("/reel/") {
        return reel_route(rest);
    }
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
        p if p.starts_with("/tmdb/") => "/tmdb",
        p if p.starts_with("/warnings/") => "/warnings",
        "/metadata/title" => "/metadata/title",
        "/metadata/title/query" => "/metadata/title/query",
        p if p.starts_with("/ratings/") => "/ratings",
        p if p.starts_with("/skipdb/") => "/skipdb",
        // One label each: what happens inside them is their own repo's log to keep.
        p if p.starts_with("/scout/") => "/scout",
        p if p.starts_with("/atlas/") => "/atlas",
        p if p.starts_with("/subtitles/") => "/subtitles",
        p if p.starts_with("/remux/") => "/remux",
        _ => "other",
    }
}

fn allowed_methods(route: &str) -> Option<&'static [Method]> {
    const GET: &[Method] = &[Method::GET];
    const GET_PUT: &[Method] = &[Method::GET, Method::PUT];
    const POST: &[Method] = &[Method::POST];
    const PUT: &[Method] = &[Method::PUT];
    const DELETE: &[Method] = &[Method::DELETE];
    match route {
        "/health" | "/version" | "/config" | "/metrics" | "/inbox/drain" | "/lib/:id/changes" | "/tmdb" => {
            Some(GET)
        }
        "/pair/:sid/:slot" => Some(GET_PUT),
        "/inbox/append" | "/lib/:id/batch" | "/pair/new" | "/pair/open" => Some(POST),
        "/metadata/title/query" => Some(POST),
        "/metadata/title" => Some(PUT),
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

/// `/config` and `/routes`: asked again every time, and a 304 while unchanged. A client reads both on every start,
/// and a kill-switch or a moved address must reach it on the next one — but the answer is the same bytes nearly
/// always, and a TV away from home is fetching them over the device API.
fn revalidated(body: String, request: &HeaderMap) -> Response {
    let mut resp = raw_json(StatusCode::OK, Body::from(body.clone()), false);
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    crate::cache::validated(resp, body.as_bytes(), None, request)
}

/// Router answers must not pin health, a credential refusal, or an error in an intermediary cache.
fn bare_json(status: StatusCode, body: &Value) -> Response {
    raw_json(status, Body::from(body.to_string()), true)
}

/// A refusal that says when to come back: the same JSON, plus `Retry-After` in seconds.
///
/// Rounded UP and never below one, because `Retry-After: 0` invites an immediate retry — which is the very
/// thing being refused — and a sub-second wait rounded down to zero says exactly that.
pub fn retry_after(status: StatusCode, body: &Value, after_ms: u64) -> Response {
    let mut resp = json_reply(status, body);
    let secs = after_ms.div_ceil(1000).max(1);
    if let Ok(value) = HeaderValue::from_str(&secs.to_string()) {
        resp.headers_mut().insert(header::RETRY_AFTER, value);
    }
    resp
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
    client_addr(state, req).map_or_else(|| "unknown".to_owned(), rate_limit_key)
}

/// The actual visitor address reported by a trusted proxy. Unlike `client_ip`, IPv6 is not collapsed to a
/// rate-limit /64: this value is forwarded to den-remux and to the public-listener helper as an address.
pub fn client_addr(state: &AppState, req: &Request) -> Option<std::net::IpAddr> {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip())?;
    if state.trusted_proxies.contains(&peer) {
        let reported = header_value(req, "cf-connecting-ip")
            .or_else(|| header_value(req, "x-forwarded-for").and_then(|v| v.rsplit(',').next()))
            .and_then(|v| v.trim().parse::<std::net::IpAddr>().ok());
        if reported.is_some() {
            return reported;
        }
    }
    Some(peer)
}

/// The address as a RATE-LIMIT bucket: an IPv4 host, or an IPv6 /64.
///
/// Every per-IP limit in this service — pair minting, pair opening, the inbox, the relay, the TMDB proxy —
/// is only as good as what it counts. A residential IPv6 customer is handed a /64 as a matter of course,
/// which is 18 quintillion addresses: one visitor can spend a fresh source address on every request and
/// never meet a limit keyed on the full address. Anything narrower than /64 is not a person, and anything
/// wider would put unrelated households in one bucket.
///
/// IPv4 is left whole: a /24 there is a genuinely different set of people.
pub fn rate_limit_key(ip: std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(v4) => v4.to_string(),
        std::net::IpAddr::V6(v6) => {
            let o = v6.octets();
            // The routing prefix, zeroed below /64, written back as an address so the key stays readable
            // in a log: 2001:db8:1:2::/64.
            let prefix = std::net::Ipv6Addr::from([
                o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7], 0, 0, 0, 0, 0, 0, 0, 0,
            ]);
            format!("{prefix}/64")
        }
    }
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

    /// `GET other` for every relayed request is what made a slow trailer unreadable in the log: a hero's
    /// ask, a press's warm-up, a master and a segment all arrived under the same name. The config
    /// segment is optional, so the ones that carry it are spelled both ways here.
    #[test]
    fn a_relayed_reel_request_names_the_route_it_asked_for() {
        assert_eq!(route_label("/reel/sources/dQw4w9WgXcQ.json"), "/reel/sources");
        assert_eq!(route_label("/reel/cfg/sources/dQw4w9WgXcQ.json"), "/reel/sources");
        assert_eq!(route_label("/reel/m/n/AbC123"), "/reel/m/n");
        assert_eq!(route_label("/reel/cfg/m/n/AbC123"), "/reel/m/n");
        assert_eq!(route_label("/reel/m/s/AbC123"), "/reel/m/s");
        // The carried segments arrive in bulk where a native master's never touch this box at all, so
        // telling the two apart is most of what the log is for.
        assert_eq!(route_label("/reel/m/s/seg"), "/reel/m/s/seg");
        assert_eq!(route_label("/reel/cfg/meta/movie/tmdb:550.json"), "/reel/meta");
        assert_eq!(route_label("/reel/hls/abc.m3u8"), "/reel/hls");
        assert_eq!(route_label("/reel/hls/seg"), "/reel/hls/seg");
        assert_eq!(route_label("/reel/play/abc.mp4"), "/reel/play");
        assert_eq!(route_label("/reel/progressive/abc.mp4"), "/reel/progressive");

        // A kind this build has never heard of is still reel's, and still named. One falling through to
        // the JSON path was the 0.133.0 bug; a label reading `other` would have hidden the next one too.
        assert_eq!(route_label("/reel/m/x/AbC123"), "/reel/m");
        assert_eq!(route_label("/reel/whatever"), "/reel");

        // The set stays closed: a video id, a config or a ticket must never become a metric label.
        assert_eq!(route_label("/scout/cfg/manifest.json"), "/scout");
        assert_eq!(route_label("/atlas/recommend"), "/atlas");
        assert_eq!(route_label("/nope"), "other");
    }

    /// A residential IPv6 customer gets a /64 — 18 quintillion addresses — so a limit keyed on the full
    /// address counts nothing at all: one visitor spends a fresh source address per request and never meets
    /// it. Every per-IP limit here (pair mint, pair open, inbox, relay, TMDB) depends on this bucketing.
    #[test]
    fn an_ipv6_visitor_cannot_walk_out_of_its_own_rate_limit() {
        let key = |s: &str| rate_limit_key(s.parse().unwrap());
        let first = key("2001:db8:1:2:3:4:5:6");
        assert_eq!(first, key("2001:db8:1:2:ffff:ffff:ffff:ffff"), "same /64, same bucket");
        assert_eq!(first, key("2001:db8:1:2::1"));
        assert_ne!(first, key("2001:db8:1:3::1"), "a different /64 is a different customer");
        assert_eq!(first, "2001:db8:1:2::/64");

        // IPv4 stays whole: a /24 there is a genuinely different set of people.
        assert_eq!(key("203.0.113.7"), "203.0.113.7");
        assert_ne!(key("203.0.113.7"), key("203.0.113.8"));
    }

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
        s.media_origins = crate::routes::media_origins(&s.routes);
        h
    }

    /// With a public table built for it, the web app's public name serves that and nothing else: the LAN
    /// addresses and the tailnet name are the homelab's shape, and a browser out there couldn't use them anyway.
    #[tokio::test]
    async fn the_public_name_serves_only_the_public_table() {
        let mut h = split_harness();
        Arc::get_mut(&mut h.state).unwrap().routes_public =
            Some(crate::routes::parse("edge=https://d-api.oxy.fi"));
        // BOTH public names, the browser's and the device API's. The device API was exempt while a TV took its
        // own addressing from this table and would overwrite its stored copy with a public-only answer,
        // discarding the `edge` entry keeping it reachable. It now addresses den-edge by the public name and
        // reads its table from the LAN face at home, so nothing it depends on comes from here.
        for host in ["d.oxy.fi", "d-api.oxy.fi"] {
            let public = body_json(h.send("GET", "/routes", None, &[("host", host)]).await).await;
            assert_eq!(public["addons"]["edge"][0]["url"], "https://d-api.oxy.fi", "{host}");
            assert!(public["addons"]["scout"].is_null(), "the LAN addresses are not published on {host}");
            // The one entry that must survive the gate: it is the only bootstrap a device with no stored table
            // has, and the only fallback when the LAN cannot be reached. Losing it strands a TV.
            let edge = public["addons"]["edge"][0]["url"].as_str().unwrap_or_default();
            assert!(edge.starts_with("https://"), "edge must keep an https entry on {host}: {edge}");
        }
        // The LAN keeps the whole table, which is what a TV at home reads.
        let full = body_json(h.send("GET", "/routes", None, &[("host", "192.168.86.193:8094")]).await).await;
        assert_eq!(full["addons"]["scout"][0]["url"], "http://192.168.86.193:8080");
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
        // And YouTube's own media hosts, which a trailer resolved through den-reel's /direct streams
        // from — without them the browser refuses the video and the page silently falls back to /play.
        //
        // `data:` is hls.js's, not ours: YouTube's master carries subtitle renditions, so it opens a
        // text track on `data:,WEBVTT` before any cue exists. Refused, that is a console error on
        // every trailer with subtitles — the media itself is a string the page wrote.
        // The tailnet wildcard stands ahead of the table's own entries and does not replace them: a household
        // on its LAN still reaches den-remux by the address the table names, and the wildcard is only what
        // lets a page use the tailnet address it stored for itself when the table withholds one.
        assert!(
            csp.contains(
                "media-src 'self' blob: data: https://*.googlevideo.com \
                 https://video-ssl.itunes.apple.com https://*.ts.net:8443 https://pve.example:8443;"
            ),
            "{csp}"
        );
        // doesthedogdie and OMDb are deliberately NOT here: `/warnings/` and `/ratings/` answer for them on this
        // origin, which `'self'` already covers.
        assert!(
            csp.contains(
                "connect-src 'self' https://api.themoviedb.org \
                 https://*.ts.net:8443 https://pve.example:8443;"
            ),
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
            let text =
                |name: header::HeaderName| parts.headers.get(name).map(|v| v.to_str().unwrap().to_owned());
            let seen = json!({
                "method": parts.method.as_str(),
                "uri": parts.uri.to_string(),
                "cookie": parts.headers.contains_key(header::COOKIE),
                "access": parts.headers.contains_key("cf-access-client-id"),
                "if_modified_since": text(header::IF_MODIFIED_SINCE),
                "accept_encoding": text(header::ACCEPT_ENCODING),
                "body": String::from_utf8_lossy(&body),
            });
            let revalidated = text(header::IF_NONE_MATCH).as_deref() == Some("\"v1\"");
            let mut resp =
                Response::new(if revalidated { Body::empty() } else { Body::from(seen.to_string()) });
            if revalidated {
                *resp.status_mut() = StatusCode::NOT_MODIFIED;
            }
            resp.headers_mut().insert(header::ETAG, HeaderValue::from_static("\"v1\""));
            resp.headers_mut()
                .insert(header::LAST_MODIFIED, HeaderValue::from_static("Sat, 12 Sep 2026 12:00:00 GMT"));
            resp.headers_mut().insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
            resp.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("identity"));
            resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("tracking=1"));
            resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            resp.headers_mut().insert("server-timing", HeaderValue::from_static("cache;desc=stale"));
            resp.headers_mut().insert("x-den-degraded", HeaderValue::from_static("upstream_unavailable"));
            resp.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("https://untrusted.example"),
            );
            resp.headers_mut()
                .insert(header::LOCATION, HeaderValue::from_static("https://untrusted.example"));
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
        // Paired, because on the public web name scout answers to nothing else: its `/configure` mints
        // installs, and an install a stranger makes scrapes indexers from this household's address.
        let lib = "0123456789abcdef0123456789abcdef";
        let token = "the-write-token";
        let started = h
            .send(
                "POST",
                &format!("/lib/{lib}/batch"),
                Some(json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string()),
                &[("x-den-library-token", token)],
            )
            .await;
        assert_eq!(started.status(), StatusCode::OK, "the library this membership is proved against");
        let member = format!("{lib}:{token}");
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
                    ("x-den-library-member", &member),
                ],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!resp.headers().contains_key(header::SET_COOKIE), "the addon's cookie stays behind");
        assert_eq!(resp.headers()["server-timing"], "cache;desc=stale");
        assert_eq!(resp.headers()["x-den-degraded"], "upstream_unavailable");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!resp.headers().contains_key(header::LOCATION));
        assert!(!resp.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        assert_eq!(resp.headers()[header::ETAG], "\"v1\"");
        assert_eq!(resp.headers()[header::LAST_MODIFIED], "Sat, 12 Sep 2026 12:00:00 GMT");
        assert_eq!(resp.headers()[header::VARY], "Accept-Encoding");
        assert_eq!(resp.headers()[header::CONTENT_ENCODING], "identity");
        assert_eq!(
            body_json(resp).await,
            json!({
                "method": "POST",
                "uri": "/sealed-cfg/availability?x=1",
                "cookie": false,
                "access": false,
                "if_modified_since": null,
                "accept_encoding": null,
                "body": r#"{"ids":["tt1"]}"#,
            }),
            "the path and body go along; the browser's session and Cloudflare's headers don't"
        );
        // The browser's validators go along too, so a revalidation is the addon's 304.
        let since = h
            .send(
                "GET",
                "/scout/cfg/manifest.json",
                None,
                &[
                    ("host", "d.oxy.fi"),
                    ("if-modified-since", "Sat, 12 Sep 2026 12:00:00 GMT"),
                    ("accept-encoding", "gzip"),
                    ("x-den-library-member", &member),
                ],
            )
            .await;
        let since = body_json(since).await;
        assert_eq!(since["if_modified_since"], "Sat, 12 Sep 2026 12:00:00 GMT");
        assert_eq!(since["accept_encoding"], "gzip");
        let unchanged = h
            .send(
                "GET",
                "/scout/cfg/manifest.json",
                None,
                &[("host", "d.oxy.fi"), ("if-none-match", "\"v1\""), ("x-den-library-member", &member)],
            )
            .await;
        assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(unchanged.headers()[header::ETAG], "\"v1\"");
        assert!(body_text(unchanged).await.is_empty());
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
        for path in ["/inbox/drain", "/metrics"] {
            assert_eq!(status("d.oxy.fi", "GET", path).await, StatusCode::NOT_FOUND, "{path} on d");
        }
        // The public client configuration, which the web app needs as much as a TV does and which carries no
        // secret: without it here, a browser on this name could not tell what this box lets it offer.
        assert_eq!(status("d.oxy.fi", "GET", "/config").await, StatusCode::OK);
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

    /// The browser needs the same public client configuration a TV does. SIMKL's PIN flow runs in the browser
    /// and needs only the app's client id, which is not a secret; unset, it is absent rather than empty, so the
    /// app hides a sign-in it could not complete instead of offering one that fails.
    #[tokio::test]
    async fn config_carries_public_client_configuration() {
        let mut h = split_harness();
        Arc::get_mut(&mut h.state).unwrap().simkl_client_id = Some("simkl-public-id".to_owned());
        let answer = h.send("GET", "/config", None, &[("host", "d.oxy.fi")]).await;
        assert_eq!(answer.status(), StatusCode::OK);
        let config = body_json(answer).await;
        assert_eq!(config["simklClientId"], "simkl-public-id");
        assert_eq!(config["minSupportedVersion"], "0.1.0", "the kill-switch is untouched");

        let plain = split_harness();
        let without = body_json(plain.send("GET", "/config", None, &[("host", "d.oxy.fi")]).await).await;
        assert!(without.get("simklClientId").is_none(), "unset is absent, not empty");
    }

    /// Both are read on every start. Always asked again, so a kill-switch or a moved address lands at once, and
    /// unchanged is a 304 carrying the same policy and tag rather than the whole table again.
    #[tokio::test]
    async fn config_and_routes_are_revalidated_every_time() {
        let h = split_harness();
        for path in ["/config", "/routes"] {
            let first = h.send("GET", path, None, &[("host", "d.oxy.fi")]).await;
            assert_eq!(first.status(), StatusCode::OK, "{path}");
            assert_eq!(first.headers()[header::CACHE_CONTROL], "no-cache", "{path}");
            let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
            let again = h.send("GET", path, None, &[("host", "d.oxy.fi"), ("if-none-match", &etag)]).await;
            assert_eq!(again.status(), StatusCode::NOT_MODIFIED, "{path}");
            assert_eq!(again.headers()[header::CACHE_CONTROL], "no-cache");
            assert_eq!(again.headers()[header::ETAG], etag.as_str());
            assert!(body_text(again).await.is_empty());
        }
        // A different face is a different table, and its tag says so.
        let mut h = split_harness();
        Arc::get_mut(&mut h.state).unwrap().routes_public =
            Some(crate::routes::parse("edge=https://d-api.oxy.fi"));
        let public = h.send("GET", "/routes", None, &[("host", "d.oxy.fi")]).await;
        let lan = h.send("GET", "/routes", None, &[("host", "192.168.86.193:8094")]).await;
        assert_ne!(public.headers()[header::ETAG], lan.headers()[header::ETAG]);
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
        assert!(
            allowed.contains("x-den-library-token")
                && allowed.contains("x-den-library-member")
                && allowed.contains("x-den-link"),
            "{allowed}"
        );

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

    #[tokio::test]
    async fn authority_ports_and_dns_root_dots_do_not_bypass_public_host_boundaries() {
        let h = split_harness();
        for host in ["d-api.oxy.fi:443", "D-API.OXY.FI.:443", "d-api.oxy.fi."] {
            for path in ["/", "/index.html", "/scout/cfg/manifest.json"] {
                assert_eq!(
                    h.send("GET", path, None, &[("host", host)]).await.status(),
                    StatusCode::NOT_FOUND,
                    "{host} {path}"
                );
            }
            assert_eq!(h.send("GET", "/health", None, &[("host", host)]).await.status(), StatusCode::OK);
        }
        for host in ["d.oxy.fi:443", "D.OXY.FI.:443"] {
            assert_eq!(h.send("GET", "/", None, &[("host", host)]).await.status(), StatusCode::OK);
            assert_eq!(
                h.send("GET", "/config", None, &[("host", host)]).await.status(),
                StatusCode::OK,
                "public client configuration answers on the web app's name too"
            );
        }
        for host in ["d-api.oxy.fi:bad", "d-api.oxy.fi:999999", "user@d-api.oxy.fi"] {
            assert_eq!(h.send("GET", "/", None, &[("host", host)]).await.status(), StatusCode::NOT_FOUND);
        }
    }
}
