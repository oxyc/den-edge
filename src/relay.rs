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
use std::sync::Arc;
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
/// Relayed fetches per address per minute. A member — a device proving it holds a library here — is browsing with
/// a household behind it, and one page of the billboard fans out into many addon calls, so it needs real room. A
/// visitor gets enough to read pages and not enough to mine the addons through this origin.
const MEMBER_PER_WINDOW: u32 = 240;
const GUEST_PER_WINDOW: u32 = 30;
/// Relayed fetches in flight at once, across everyone. The addons are one small box: without this a handful of
/// visitors on a public name can hold every upstream socket and starve the TVs that actually live here.
pub(crate) const MAX_IN_FLIGHT: usize = 16;
/// How long a request waits for one of those slots before giving up, so a queue can't grow without bound.
const SLOT_WAIT: Duration = Duration::from_secs(5);

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

pub async fn relay(state: &AppState, req: Request, target: String, rid: &str) -> Response {
    let method = req.method().clone();
    if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    // The visitor's budget is spent first, and only an address past it is asked whether it is a member and has
    // the larger one. That order is deliberate: checking membership first would let a forged member header make
    // every relayed request do a library lookup, which is the work this limit exists to protect.
    let ip = crate::handler::client_ip(state, &req);
    if let Some(visitor_wait) = crate::link::throttled_at(state, &format!("relay:{ip}"), GUEST_PER_WINDOW) {
        let member =
            req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
        if !crate::library::is_member(state, member.as_deref()).await {
            return limited(visitor_wait);
        }
        if let Some(wait) = crate::link::throttled_at(state, &format!("relay-member:{ip}"), MEMBER_PER_WINDOW)
        {
            return limited(wait);
        }
    }
    // Held until this answer is done with, so the cap counts what is actually in flight upstream.
    let slot = tokio::time::timeout(SLOT_WAIT, Arc::clone(&state.relay_slots).acquire_owned()).await;
    let _slot = match slot {
        Ok(Ok(permit)) => permit,
        // Every slot is taken: the wait it just spent is also how long the next caller should give it.
        _ => {
            return crate::handler::retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &error("relay_busy"),
                SLOT_WAIT.as_millis() as u64,
            )
        }
    };
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
    // This request's id goes with it. The addon logs one line per request and so does this server; without a
    // shared id the two are impossible to put side by side afterwards, which is exactly when you want to.
    let mut out = axum::http::Request::builder()
        .method(method)
        .uri(&target)
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid);
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
        // An addon's own rate limit, which the browser can only honour if it is allowed to hear it. Without
        // this the page met a bare 429 and did what every client here does with one: came straight back.
        header::RETRY_AFTER,
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

/// A refusal that says when the window clears, rather than leaving the caller to guess and come straight back.
fn limited(after_ms: u64) -> Response {
    crate::handler::retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), after_ms)
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;
    use std::sync::Arc;

    const LIB: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "the-write-token";

    /// Relaying `/scout` at a port nothing listens on: whatever gets past the limit fails at the fetch, which is
    /// all these need to tell an allowed request from a refused one.
    fn harness() -> Harness {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays("/scout=http://127.0.0.1:9");
        h
    }

    async fn ask(h: &Harness, headers: &[(&str, &str)]) -> StatusCode {
        h.send("GET", "/scout/manifest.json", None, headers).await.status()
    }

    /// A public name is an unmetered proxy to the addons without this — including atlas's half-megabyte labels.
    #[tokio::test]
    async fn a_visitor_gets_a_visitors_allowance() {
        let h = harness();
        for i in 0..super::GUEST_PER_WINDOW {
            assert_eq!(ask(&h, &[]).await, StatusCode::BAD_GATEWAY, "{i}");
        }
        let refused = h.send("GET", "/scout/manifest.json", None, &[]).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        // A refusal that does not say when the window clears is one the caller simply repeats — which is
        // what every client here did with a bare 429, on a fixed few seconds, indefinitely.
        assert!(refused.headers().contains_key("retry-after"), "the refusal never said when to return");
    }

    /// One page of the billboard fans out into many addon calls, so a household that has paired a TV must not be
    /// held to a stranger's budget.
    #[tokio::test]
    async fn a_member_browses_past_the_visitors_allowance() {
        let h = harness();
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK, "the library this membership is proved against");

        let member = format!("{LIB}:{TOKEN}");
        for i in 0..super::GUEST_PER_WINDOW + 10 {
            let status = ask(&h, &[("x-den-library-member", &member)]).await;
            assert_eq!(status, StatusCode::BAD_GATEWAY, "{i}");
        }
        // The token is what earns it: a guessed id with the wrong token is a visitor, whose budget is now spent.
        let forged = format!("{LIB}:not-the-token");
        assert_eq!(ask(&h, &[("x-den-library-member", &forged)]).await, StatusCode::TOO_MANY_REQUESTS);
    }
}
