//! `DELETE /link` — unlinking a device erases what its link left here. Links are made by pairing (`pair.rs`); the
//! six-character codes this module once minted are retired. The per-address throttle that code guesses count
//! against lives here too.

use crate::handler::{error, internal, json_reply, link_key, method_not_allowed, valid_inbox_key};
use crate::{lock, AppState};
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::json;

/// No 0/O or 1/I. Thirty-two symbols, so `byte & 31` picks one without bias.
pub(crate) const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Guesses per client address per minute: a pairing's nameplate is only four characters.
pub(crate) const CLAIMS_PER_WINDOW: u32 = 20;
const CLAIM_WINDOW_MS: u64 = 60 * 1000;

pub struct Throttle {
    count: u32,
    until: u64,
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    match req.uri().path() {
        "/link" if req.method() == Method::DELETE => forget(state, link_key(&req)).await,
        "/link" => method_not_allowed(),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

/// Unlinking a device erases what its link left here — its inbox, and the plugins and settings it shared — so a
/// device the TV no longer trusts can't read or add to them (issue #8, N3). Idempotent.
async fn forget(state: &AppState, key: String) -> Response {
    if !valid_inbox_key(&key) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_key"));
    }
    let _write = state.write_lock.lock().await;
    for ns in ["inbox", "plugins", "settings"] {
        if let Err(e) = state.store.delete(ns, &key).await {
            return internal("link forget", e);
        }
    }
    json_reply(StatusCode::OK, &json!({ "forgotten": true }))
}

/// Counts a guess from `ip`; `Some(ms)` once it is over the pairing limit.
pub(crate) fn throttled(state: &AppState, ip: &str) -> Option<u64> {
    throttled_at(state, ip, CLAIMS_PER_WINDOW)
}

/// Counts one act against `bucket`'s own budget; true once it is over `limit`. A blocked attempt doesn't extend
/// the window, an allowed one does — so a steady stream stays blocked and the window clears once it stops.
///
/// `bucket` is the whole key, so a caller prefixes what it is limiting (`relay:<ip>`, `inbox:<ip>`) and each
/// budget counts on its own: browsing the relay hard must not spend the pairing allowance, and the other way
/// about. All of them share the one map, and so the one sweep that keeps it bounded.
/// `None` while the caller is within its budget; `Some(ms)` once it is over, carrying how long until the
/// window clears.
///
/// The time is the whole point. A limit that says only "no" leaves the caller to guess when to come back, and
/// every client here guessed the same way — a fixed few seconds, forever — which turns one refusal into a
/// steady knock against a door that was going to open on its own.
pub(crate) fn throttled_at(state: &AppState, bucket: &str, limit: u32) -> Option<u64> {
    throttled_by(state, bucket, limit, 1)
}

/// `throttled_at` for an act that costs `cost` of the budget at once — a drain of several queues costs one per
/// queue. Refused whole when it does not fit, and then it spends nothing.
pub(crate) fn throttled_by(state: &AppState, bucket: &str, limit: u32, cost: u32) -> Option<u64> {
    let now = state.now();
    let mut claims = lock(&state.claims);
    if claims.len() > 1024 {
        claims.retain(|_, t| t.until > now);
    }
    let t = claims.entry(bucket.to_owned()).or_insert(Throttle { count: 0, until: 0 });
    if t.until <= now {
        t.count = 0;
    }
    if t.count.saturating_add(cost) > limit {
        return Some(t.until.saturating_sub(now));
    }
    t.count += cost;
    t.until = now + CLAIM_WINDOW_MS;
    None
}

/// `limit` a minute in fixed windows: a window opens at its first request and closes a minute later, whatever came
/// in it. For a steady caller — an assistant's MCP calls — where `throttled_at`, whose window moves on with every
/// request allowed, would never close and refuse it for good once it passed the limit.
pub(crate) fn throttled_per_minute(state: &AppState, bucket: &str, limit: u32) -> Option<u64> {
    throttled_per_minute_by(state, bucket, limit, 1)
}

/// `throttled_per_minute` for an act that costs `cost` of the budget at once. Refused whole when it does not fit,
/// and then it spends nothing.
pub(crate) fn throttled_per_minute_by(state: &AppState, bucket: &str, limit: u32, cost: u32) -> Option<u64> {
    let now = state.now();
    let mut claims = lock(&state.claims);
    if claims.len() > 1024 {
        claims.retain(|_, t| t.until > now);
    }
    let t = claims.entry(bucket.to_owned()).or_insert(Throttle { count: 0, until: 0 });
    if t.until <= now {
        t.count = 0;
        t.until = now + CLAIM_WINDOW_MS;
    }
    if t.count.saturating_add(cost) > limit {
        return Some(t.until.saturating_sub(now));
    }
    t.count += cost;
    None
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;

    #[tokio::test]
    async fn unlinking_erases_what_the_link_left_behind() {
        let h = Harness::new();
        let key = "abcdef0123456789";
        let link = [("x-den-link", key)];
        h.send("POST", "/inbox/append", Some(json!({ "sealed": "AAECAw" }).to_string()), &link).await;
        // What an older link shared, before those routes were retired.
        h.state.store.put("plugins", key, b"{}").await.unwrap();
        h.state.store.put("settings", key, b"{}").await.unwrap();

        assert_eq!(h.send("DELETE", "/link", None, &link).await.status(), StatusCode::OK);
        assert_eq!(h.state.store.get("plugins", key).await.unwrap(), None);
        assert_eq!(h.state.store.get("settings", key).await.unwrap(), None);
        let drained =
            crate::handler::tests::body_json(h.send("GET", "/inbox/drain", None, &link).await).await;
        assert_eq!(drained["messages"], json!([]));
        assert_eq!(h.send("DELETE", "/link", None, &link).await.status(), StatusCode::OK, "again is fine");
        assert_eq!(h.send("DELETE", "/link", None, &[]).await.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn the_six_character_code_routes_are_gone() {
        let h = Harness::new();
        assert_eq!(h.call("POST", "/link/new", None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(
            h.call("POST", "/link/claim", Some(json!({ "code": "ABC234" }))).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(h.call("GET", "/link/poll?code=ABC234", None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(h.call("GET", "/link", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
    }
}
