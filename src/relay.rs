//! The addons' JSON routes relayed from the web app's own origin (`ADDON_RELAY`, oxyc/den#15). On its public name
//! the web app asks `/scout/…` and `/atlas/…` here, and den-edge fetches them at the addon's LAN address — as
//! `tailscale serve` does on the tailnet. So the browser needs no Cloudflare Access service token (which stays on
//! the TVs), no CORS preflight past Access, and a library's LAN install URLs work as they are. Only an addon's
//! JSON goes through: den-remux's video never takes this path.

use crate::handler::{error, raw_json, MAX_BODY_BYTES};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use std::time::Duration;

/// Plain HTTP: every target is a LAN address.
pub type RelayClient = Client<HttpConnector, Full<Bytes>>;

pub fn client() -> RelayClient {
    Client::builder(TokioExecutor::new()).build_http()
}

/// Past scout's scrape timeout on a slow indexer (8 s), with its answer still to come.
const TIMEOUT: Duration = Duration::from_secs(30);
/// An addon's JSON answer — a catalog page, an index slice — is far under this.
const MAX_ANSWER_BYTES: usize = 8 * 1024 * 1024;

/// Where `path_and_query` goes when it is under one of `relays`: that addon's LAN origin with the rest of it.
pub fn target(relays: &[(String, String)], path_and_query: &str) -> Option<String> {
    relays.iter().find_map(|(prefix, origin)| {
        let rest = path_and_query.strip_prefix(prefix.as_str())?;
        match rest.chars().next() {
            None => Some(format!("{origin}/")),
            Some('/') => Some(format!("{origin}{rest}")),
            Some('?') => Some(format!("{origin}/{rest}")),
            _ => None,
        }
    })
}

pub async fn relay(state: &AppState, req: Request, target: String) -> Response {
    let method = req.method().clone();
    if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let content_type = req.headers().get(header::CONTENT_TYPE).cloned();
    let conditions: Vec<_> = [header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE, header::ACCEPT_ENCODING]
        .into_iter()
        .filter_map(|name| req.headers().get(&name).cloned().map(|value| (name, value)))
        .collect();
    let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES).await else {
        return json(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");
    };
    // Nothing of the browser's goes along but what the addon reads: not its cookies, which carry its Access
    // session, nor anything Cloudflare added. Its validators do, so a revalidation is the addon's 304 rather
    // than the whole answer again, and the encodings it takes, so a large file (atlas's labels) arrives gzipped
    // and within `MAX_ANSWER_BYTES`.
    let mut out =
        axum::http::Request::builder().method(method).uri(&target).header(header::ACCEPT, "application/json");
    if let Some(content_type) = content_type {
        out = out.header(header::CONTENT_TYPE, content_type);
    }
    for (name, value) in conditions {
        out = out.header(name, value);
    }
    let Ok(out) = out.body(Full::new(body)) else { return json(StatusCode::BAD_REQUEST, "bad_request") };
    let answer = match tokio::time::timeout(TIMEOUT, state.relay_client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("relay: {e}");
            return json(StatusCode::BAD_GATEWAY, "addon_unreachable");
        }
        Err(_) => return json(StatusCode::GATEWAY_TIMEOUT, "addon_timeout"),
    };
    let (parts, body) = answer.into_parts();
    let Ok(bytes) = Limited::new(body, MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes()) else {
        return json(StatusCode::BAD_GATEWAY, "addon_answer_unreadable");
    };
    // Only the answer's cache policy, its validators and diagnostic fields cross this boundary. In particular
    // an upstream cannot set a cookie, redirect the browser, or grant another origin access.
    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = parts.status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_ENCODING,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
        header::VARY,
        header::HeaderName::from_static("server-timing"),
        header::HeaderName::from_static("x-den-degraded"),
    ] {
        if let Some(value) = parts.headers.get(&name) {
            resp.headers_mut().insert(name, value.clone());
        }
    }
    resp
}

fn json(status: StatusCode, code: &str) -> Response {
    raw_json(status, Body::from(error(code).to_string()), true)
}
