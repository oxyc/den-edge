//! `/play/result` — what a TV says back about a Play on TV request (den-spec `wire/play-results-v1.md`): preparing,
//! playing, or why not. Each result is sealed under a key derived from the request's own id, which only its sender and
//! its receiver read; den-edge stores them opaque, by an address derived from the same id, in memory for ten minutes.
//! It learns how many results an address got and when, never what they say or which request they are for.
//!
//!   POST /play/result                    member            a receiver stores one sealed result
//!   GET  /play/result/{address}[?wait=]  member or bearer  a requester reads them, held until a new one arrives
//!
//! Log lines name the route and status only (`handler.rs`); nothing here logs an address or a result.

use crate::handler::{error, json_reply, read_json, retry_after};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Results kept per address: a receiver sends `preparing` and a terminal state, and a recovery's `playing` after a
/// `failed` (§3), so four leaves room for one more and no more.
const PER_ADDRESS: usize = 4;
/// Addresses kept in all, the oldest dropped first.
const MAX_ADDRESSES: usize = 4_096;
/// How long an address is kept from its first result: well past every play window (120 s).
const TTL_MS: u64 = 10 * 60_000;
/// A v1 result is 208 characters; a later version may be longer, never more than this.
const MAX_SEALED: usize = 512;
/// A nonce, a tag and one byte.
const MIN_SEALED_BYTES: usize = 12 + 16 + 1;
const BODY_BYTES: usize = 1024;
/// Posts per library a minute.
const POSTS_PER_MINUTE: u32 = 120;
/// Held reads per client address, and in all.
pub const MAX_HELD_PER_ADDRESS: usize = 2;
pub const MAX_HELD: usize = 32;

/// Every address's results, in memory alone: a restart loses them, which a requester reads as unconfirmed.
#[derive(Default)]
pub struct Results {
    addresses: HashMap<String, Stored>,
}

struct Stored {
    first: u64,
    sealed: Vec<String>,
}

impl Results {
    fn expire(&mut self, now: u64) {
        self.addresses.retain(|_, stored| stored.first.saturating_add(TTL_MS) > now);
    }
}

pub fn is_path(path: &str) -> bool {
    path == "/play/result" || path.starts_with("/play/result/")
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    match (req.method().clone(), path.strip_prefix("/play/result")) {
        (Method::POST, Some("")) => post(state, req).await,
        (Method::GET | Method::HEAD, Some(rest)) if rest.starts_with('/') => {
            let address = rest[1..].to_owned();
            get(state, req, &address).await
        }
        (_, Some("")) => crate::handler::method_not_allowed(),
        (_, Some(rest)) if rest.starts_with('/') => crate::handler::method_not_allowed(),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

fn valid_address(address: &str) -> bool {
    address.len() == 32 && address.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_sealed(sealed: &str) -> bool {
    sealed.len() <= MAX_SEALED
        && den_assistant::b64url_decode(sealed).is_some_and(|bytes| bytes.len() >= MIN_SEALED_BYTES)
}

fn hold_key(address: &str) -> String {
    format!("play-result:{address}")
}

async fn post(state: &AppState, req: Request) -> Response {
    let library = match crate::assistant::member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    let bucket = format!("play-result:{library}");
    if let Some(wait) = crate::link::throttled_per_minute(state, &bucket, POSTS_PER_MINUTE) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let body = match read_json(req, BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some(address) = body.get("address").and_then(Value::as_str).filter(|a| valid_address(a)) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_address"));
    };
    let Some(sealed) = body.get("sealed").and_then(Value::as_str).filter(|s| valid_sealed(s)) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_sealed"));
    };
    let now = state.now();
    {
        let mut results = state.play_results.lock().expect("play results");
        results.expire(now);
        if !results.addresses.contains_key(address) && results.addresses.len() >= MAX_ADDRESSES {
            let oldest =
                results.addresses.iter().min_by_key(|(_, stored)| stored.first).map(|(a, _)| a.clone());
            if let Some(oldest) = oldest {
                results.addresses.remove(&oldest);
            }
        }
        let stored = results
            .addresses
            .entry(address.to_owned())
            .or_insert_with(|| Stored { first: now, sealed: Vec::new() });
        if stored.sealed.len() >= PER_ADDRESS {
            return json_reply(StatusCode::CONFLICT, &error("results_full"));
        }
        stored.sealed.push(sealed.to_owned());
    }
    state.play_result_holds.wake(&hold_key(address));
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    resp
}

/// A member of any library, or an assistant's write session: whoever holds a request's id. The address is the
/// capability; the proof only keeps strangers from asking.
async fn reader(state: &AppState, headers: &HeaderMap) -> Result<(), Box<Response>> {
    if headers.contains_key(header::AUTHORIZATION) {
        return crate::oauth::write_session(state, headers).await.map(|_| ());
    }
    crate::assistant::member_library(state, headers).await.map(|_| ())
}

fn stored(state: &AppState, address: &str) -> Vec<String> {
    let mut results = state.play_results.lock().expect("play results");
    results.expire(state.now());
    results.addresses.get(address).map(|stored| stored.sealed.clone()).unwrap_or_default()
}

async fn get(state: &AppState, req: Request, address: &str) -> Response {
    if let Err(refused) = reader(state, req.headers()).await {
        return *refused;
    }
    if !valid_address(address) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_address"));
    }
    let after = crate::handler::query_param(&req, "after").and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
    let wait = crate::hold::wait(crate::handler::query_param(&req, "wait"));
    let ip = crate::handler::client_ip(state, &req);
    let admission = req.extensions().get::<crate::handler::AdmissionSlot>().cloned();
    // Registered before the results are read: a result posted after the read still wakes the wait.
    let key = hold_key(address);
    let mut hold = wait.and_then(|wait| Some((state.play_result_holds.hold(&ip, &[key.as_str()])?, wait)));
    loop {
        let results = stored(state, address);
        if let Some((held, wait)) = hold.take() {
            if results.len() <= after {
                if !crate::handler::AdmissionSlot::wait_out(admission.as_ref(), state, held.wait(wait)).await
                {
                    return crate::handler::busy();
                }
                continue;
            }
        }
        return json_reply(StatusCode::OK, &json!({ "results": results }));
    }
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::{body_json, Harness};
    use crate::oauth::tests::{connect_write, member, seed, write_harness};
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    /// den-spec's vectors: an address, and one result of each state as a TV seals them.
    fn vectors() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("spec/vectors/play-results-v1.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("den-spec's play-results vectors"))
            .unwrap()
    }

    async fn send(
        h: &Harness,
        method: &str,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut headers = headers.to_vec();
        headers.push(("content-type", "application/json"));
        let resp = h.send(method, path, body.map(|b| b.to_string()), &headers).await;
        let status = resp.status();
        let text = crate::handler::tests::body_text(resp).await;
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn as_member(h: &Harness, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let claim = member();
        send(h, method, path, body, &[("x-den-library-member", &claim)]).await
    }

    #[tokio::test]
    async fn a_tv_posts_results_and_its_requesters_read_them_in_order() {
        let h = write_harness().await;
        let v = vectors();
        let address = v["address"].as_str().unwrap();
        let sealed: Vec<Value> =
            v["results"].as_array().unwrap().iter().map(|r| r["sealed"].clone()).collect();
        let path = format!("/play/result/{address}");
        // Nobody has said anything yet: an empty list, never a 404 that would tell an unknown address apart.
        assert_eq!(as_member(&h, "GET", &path, None).await, (StatusCode::OK, json!({ "results": [] })));
        // Only a member posts, and only a well-formed result.
        let post = |sealed: &Value| Some(json!({ "address": address, "sealed": sealed }));
        assert_eq!(send(&h, "POST", "/play/result", post(&sealed[0]), &[]).await.0, StatusCode::FORBIDDEN);
        for (body, code) in [
            (json!({ "address": "AB", "sealed": sealed[0] }), "invalid_address"),
            (json!({ "address": address, "sealed": "AAAA" }), "invalid_sealed"),
            (json!({ "address": address, "sealed": "x".repeat(600) }), "invalid_sealed"),
            (json!({ "address": address }), "invalid_sealed"),
        ] {
            assert_eq!(
                as_member(&h, "POST", "/play/result", Some(body)).await,
                (StatusCode::BAD_REQUEST, json!({ "error": code }))
            );
        }
        for result in &sealed {
            assert_eq!(as_member(&h, "POST", "/play/result", post(result)).await.0, StatusCode::NO_CONTENT);
        }
        assert_eq!(as_member(&h, "GET", &path, None).await, (StatusCode::OK, json!({ "results": sealed })));
        // An assistant reads them with its write session, as den-mcp does.
        let tokens = connect_write(&h, &seed("grant")).await;
        let bearer = format!("Bearer {}", tokens["access_token"].as_str().unwrap());
        assert_eq!(
            send(&h, "GET", &path, None, &[("authorization", &bearer)]).await,
            (StatusCode::OK, json!({ "results": sealed }))
        );
        assert_eq!(
            send(&h, "GET", &path, None, &[("authorization", "Bearer nope")]).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(send(&h, "GET", &path, None, &[]).await.0, StatusCode::FORBIDDEN);
        // Four at most per address; a stranger's flood cannot grow one past that.
        assert_eq!(as_member(&h, "POST", "/play/result", post(&sealed[0])).await.0, StatusCode::NO_CONTENT);
        assert_eq!(
            as_member(&h, "POST", "/play/result", post(&sealed[0])).await,
            (StatusCode::CONFLICT, json!({ "error": "results_full" }))
        );
        // Ten minutes on, the address is gone.
        h.advance(super::TTL_MS);
        assert_eq!(as_member(&h, "GET", &path, None).await, (StatusCode::OK, json!({ "results": [] })));
    }

    #[tokio::test]
    async fn a_held_read_answers_when_the_tv_posts() {
        let h = write_harness().await;
        let v = vectors();
        let address = v["address"].as_str().unwrap().to_owned();
        let sealed = v["results"][0]["sealed"].clone();
        let claim = member();
        let proof = [("x-den-library-member", claim.as_str())];
        let path = format!("/play/result/{address}?wait=20");
        let held = h.send("GET", &path, None, &proof);
        let post = async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            as_member(&h, "POST", "/play/result", Some(json!({ "address": address, "sealed": sealed }))).await
        };
        let started = std::time::Instant::now();
        let (resp, posted) = tokio::join!(held, post);
        assert_eq!(posted.0, StatusCode::NO_CONTENT);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(body_json(resp).await["results"].as_array().unwrap().len(), 1);
        // `after` holds until there are more than that many: one already there answers a hold with after=0 at once,
        // and a hold with after=1 waits out its time.
        let started = std::time::Instant::now();
        let resp = h.send("GET", &format!("/play/result/{address}?after=1&wait=1"), None, &proof).await;
        assert!(started.elapsed() >= std::time::Duration::from_millis(900));
        assert_eq!(body_json(resp).await["results"].as_array().unwrap().len(), 1);
    }
}
