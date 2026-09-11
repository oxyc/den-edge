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

/// Counts a guess from `ip`; true once it is over the limit. A blocked attempt doesn't extend the window, an
/// allowed one does — so a steady stream of guesses stays blocked and the window clears once they stop.
pub(crate) fn throttled(state: &AppState, ip: &str) -> bool {
    let now = state.now();
    let mut claims = lock(&state.claims);
    if claims.len() > 1024 {
        claims.retain(|_, t| t.until > now);
    }
    let t = claims.entry(ip.to_owned()).or_insert(Throttle { count: 0, until: 0 });
    if t.until <= now {
        t.count = 0;
    }
    if t.count >= CLAIMS_PER_WINDOW {
        return true;
    }
    t.count += 1;
    t.until = now + CLAIM_WINDOW_MS;
    false
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
