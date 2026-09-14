//! doesthedogdie's content warnings through this origin (`/warnings/…`).
//!
//! The warnings, and Settings' check of the key they need, are the one thing in Den a browser cannot ask for
//! itself. The key travels in an `x-api-key` header, which makes the request preflight, and doesthedogdie
//! answers no preflight and sends no `Access-Control-Allow-Origin` at all — so the browser refuses it before it
//! ever leaves the page, whatever the CSP says. Naming their origin in the policy was a wasted release. The TV
//! has never had the trouble, because a native request is not CORS-checked.
//!
//! So this forwards it. Unlike `/tmdb/`, no key of the household's is lent here: the caller's own key is passed
//! along, and nothing is kept — so the route is worth nothing to anyone who does not already hold a key. Their
//! status comes back as itself, because "refused" and "no such title" are the two answers the key check reads,
//! and their body never does: it may name the key.

use crate::handler::{error, raw_json, retry_after};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use std::time::Duration;

const HOST: &str = "https://www.doesthedogdie.com";
/// The header their API takes a key in, and the only one that travels from the caller.
const KEY_HEADER: &str = "x-api-key";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Their largest answer here is one title's topic votes.
const MAX_ANSWER_BYTES: usize = 2 * 1024 * 1024;
/// Questions per address per minute. A detail page asks two.
const PER_WINDOW: u32 = 60;

/// The two paths the app asks for: a search, and one title's record.
///
/// An allow-list rather than a pass-through, because every request leaving here carries somebody's API key. A
/// route that would forward any path under their host is one that can be pointed at the rest of their site with
/// a stranger's credential attached.
fn allowed(path: &str) -> bool {
    let plain = !path.contains("..")
        && !path.contains("//")
        && path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.'));
    if !plain {
        return false;
    }
    let mut parts = path.split('/').skip(1);
    match parts.next() {
        Some("search") => parts.next().is_none(),
        Some("media") => {
            parts.next().is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
                && parts.next().is_none()
        }
        _ => false,
    }
}

pub async fn handle(state: &AppState, req: Request, rid: &str) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let path = req.uri().path().trim_start_matches("/warnings").to_owned();
    if !allowed(&path) {
        return json(StatusCode::NOT_FOUND, "not_found");
    }
    // The caller's own key. Without one there is nothing to ask with, and nothing here to lend instead.
    let Some(key) = req.headers().get(KEY_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned) else {
        return json(StatusCode::UNAUTHORIZED, "no_key");
    };
    if key.is_empty() || key.len() > 256 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return json(StatusCode::BAD_REQUEST, "bad_key");
    }
    let ip = crate::handler::client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_at(state, &format!("warnings:{ip}"), PER_WINDOW) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let Some(client) = state.tmdb_client.as_ref() else {
        return json(StatusCode::NOT_FOUND, "warnings_proxy_off");
    };
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let out = axum::http::Request::builder()
        .method(Method::GET)
        .uri(format!("{HOST}{path}{query}"))
        .header(header::ACCEPT, "application/json")
        .header(KEY_HEADER, &key)
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()));
    let Ok(out) = out else { return json(StatusCode::BAD_REQUEST, "bad_request") };
    let answer = match tokio::time::timeout(TIMEOUT, client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("warnings: {e}");
            return json(StatusCode::BAD_GATEWAY, "warnings_unreachable");
        }
        Err(_) => return json(StatusCode::GATEWAY_TIMEOUT, "warnings_timeout"),
    };
    let status = answer.status();
    let Ok(bytes) = Limited::new(answer.into_body(), MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes())
    else {
        return json(StatusCode::BAD_GATEWAY, "warnings_answer_unreadable");
    };
    // Their verdict, as itself: the key check reads 401 and 403 as "not accepted", and a 404 as a working key
    // that found nothing. Anything else is ours to call a bad gateway.
    if !status.is_success() {
        return match status {
            StatusCode::UNAUTHORIZED => json(StatusCode::UNAUTHORIZED, "key_refused"),
            StatusCode::FORBIDDEN => json(StatusCode::FORBIDDEN, "key_refused"),
            StatusCode::NOT_FOUND => json(StatusCode::NOT_FOUND, "not_found"),
            _ => json(StatusCode::BAD_GATEWAY, "warnings_refused"),
        };
    }
    // Never stored: the answer belongs to whichever key asked for it.
    raw_json(StatusCode::OK, Body::from(bytes), true)
}

fn json(status: StatusCode, code: &str) -> Response {
    raw_json(status, Body::from(error(code).to_string()), true)
}

#[cfg(test)]
mod tests {
    /// Everything leaving here carries someone's key, so the path is named rather than forwarded.
    #[test]
    fn only_a_search_or_one_title_may_be_asked_for() {
        assert!(super::allowed("/search"));
        assert!(super::allowed("/media/1234"));
        assert!(!super::allowed("/media/1234/edit"));
        assert!(!super::allowed("/media/abc"));
        assert!(!super::allowed("/media"));
        assert!(!super::allowed("/account"));
        assert!(!super::allowed("/search/../account"));
        assert!(!super::allowed("//evil.example/"));
        assert!(!super::allowed("/search?q=x"), "a query is not part of the path here");
    }
}
