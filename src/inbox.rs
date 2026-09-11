//! `/inbox` — a paired device's messages to a TV (den-spec `wire/inbox-v1.md`). The device appends under its link
//! credential, sealed under the link's key, so den-edge can't read, forge or replay them; the TV drains the queue
//! on launch and while in front, which empties it. A readable message is refused: every device that sends one
//! pairs now.

use crate::handler::{
    error, header_key, internal, json_reply, link_key, method_not_allowed, read_json, valid_inbox_key,
    MAX_BODY_BYTES,
};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

const NS: &str = "inbox";
/// A queue an unopened TV never drains goes after a week.
const TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// The newest fifty are kept; older ones fall off the front.
const MAX_MESSAGES: usize = 50;
const MAX_SEALED_CHARS: usize = 4096;

pub async fn handle(state: &AppState, req: Request) -> Response {
    match req.uri().path() {
        "/inbox/append" if req.method() == Method::POST => append(state, req).await,
        "/inbox/append" => method_not_allowed(),
        "/inbox/drain" => drain(state, link_key(&req)).await,
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

async fn append(state: &AppState, req: Request) -> Response {
    let from_header = header_key(&req);
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let key = from_header.as_deref().or_else(|| body.get("inboxKey").and_then(Value::as_str)).unwrap_or("");
    if !valid_inbox_key(key) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_key"));
    }
    let Some(message) = body.get("sealed").and_then(sealed_message) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_message"));
    };
    let _write = state.write_lock.lock().await;
    let now = state.now();
    let mut queue = match load(state, key, now).await {
        Ok(queue) => queue.unwrap_or_default(),
        Err(e) => return internal("inbox read", e),
    };
    queue.push(message);
    if queue.len() > MAX_MESSAGES {
        queue.drain(..queue.len() - MAX_MESSAGES);
    }
    let stored = json!({ "expiresAt": now + TTL_MS, "messages": queue });
    if let Err(e) = state.store.put(NS, key, stored.to_string().as_bytes()).await {
        return internal("inbox write", e);
    }
    json_reply(StatusCode::OK, &json!({ "ok": true }))
}

async fn drain(state: &AppState, key: String) -> Response {
    if !valid_inbox_key(&key) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_key"));
    }
    let _write = state.write_lock.lock().await;
    let messages = match load(state, &key, state.now()).await {
        Ok(None) => Vec::new(),
        Ok(Some(messages)) => {
            // The TV acknowledges by draining.
            if let Err(e) = state.store.delete(NS, &key).await {
                return internal("inbox delete", e);
            }
            messages
        }
        Err(e) => return internal("inbox read", e),
    };
    json_reply(StatusCode::OK, &json!({ "messages": messages }))
}

/// The queue under `key`, or `None` when there is none or it has expired (and is then deleted).
async fn load(state: &AppState, key: &str, now: u64) -> std::io::Result<Option<Vec<Value>>> {
    let Some(bytes) = state.store.get(NS, key).await? else { return Ok(None) };
    let stored: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if stored.get("expiresAt").and_then(Value::as_u64).is_none_or(|at| at <= now) {
        state.store.delete(NS, key).await?;
        return Ok(None);
    }
    Ok(Some(stored.get("messages").and_then(Value::as_array).cloned().unwrap_or_default()))
}

/// A paired device's message: opaque base64url, which only its TV can open.
fn sealed_message(raw: &Value) -> Option<Value> {
    let sealed = raw.as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= MAX_SEALED_CHARS
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })?;
    Some(json!({ "sealed": sealed }))
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    const KEY: &str = "deadbeefcafe1234deadbeef";

    async fn append(h: &Harness, sealed: &str) -> StatusCode {
        h.call("POST", "/inbox/append", Some(json!({ "inboxKey": KEY, "sealed": sealed }))).await.0
    }

    async fn drain(h: &Harness) -> Vec<Value> {
        let resp = h.send("GET", "/inbox/drain", None, &[("x-den-link", KEY)]).await;
        crate::handler::tests::body_json(resp).await["messages"].as_array().unwrap().clone()
    }

    #[tokio::test]
    async fn append_two_then_drain_returns_both_once() {
        let h = Harness::new();
        assert_eq!(append(&h, "AAECAw-_").await, StatusCode::OK);
        assert_eq!(append(&h, "BAUG").await, StatusCode::OK);
        assert_eq!(drain(&h).await, vec![json!({ "sealed": "AAECAw-_" }), json!({ "sealed": "BAUG" })]);
        assert!(drain(&h).await.is_empty(), "a drain empties the queue");
    }

    #[tokio::test]
    async fn only_a_well_formed_sealed_message_is_taken() {
        let h = Harness::new();
        let too_long = "A".repeat(super::MAX_SEALED_CHARS + 1);
        for bad in [json!(""), json!("a+b/"), json!(too_long), json!(3)] {
            let status =
                h.call("POST", "/inbox/append", Some(json!({ "inboxKey": KEY, "sealed": bad }))).await.0;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        }
        let readable = json!({ "inboxKey": KEY, "message": { "type": "tmdbKey", "key": "k" } });
        assert_eq!(h.call("POST", "/inbox/append", Some(readable)).await.0, StatusCode::BAD_REQUEST);
        assert!(drain(&h).await.is_empty());
    }

    /// The key travels in `x-den-link`, out of the URL; a header wins over a body key.
    #[tokio::test]
    async fn the_key_can_travel_in_a_header() {
        let h = Harness::new();
        let body = json!({ "inboxKey": "not a key!", "sealed": "AAEC" });
        let appended = h.send("POST", "/inbox/append", Some(body.to_string()), &[("x-den-link", KEY)]).await;
        assert_eq!(appended.status(), StatusCode::OK);
        assert_eq!(drain(&h).await, vec![json!({ "sealed": "AAEC" })]);
        let query = h.send("GET", &format!("/inbox/drain?inboxKey={KEY}"), None, &[]).await;
        assert_eq!(query.status(), StatusCode::BAD_REQUEST, "a key in the URL is not read");
    }

    #[tokio::test]
    async fn junk_keys_are_refused_and_an_unknown_queue_is_empty() {
        let h = Harness::new();
        let body = json!({ "inboxKey": "not a key!", "sealed": "AAEC" });
        assert_eq!(h.call("POST", "/inbox/append", Some(body)).await.0, StatusCode::BAD_REQUEST);
        let short = h.send("GET", "/inbox/drain", None, &[("x-den-link", "short")]).await;
        assert_eq!(short.status(), StatusCode::BAD_REQUEST);
        let empty = h.send("GET", "/inbox/drain", None, &[("x-den-link", "abcdef0123456789")]).await;
        assert_eq!(crate::handler::tests::body_json(empty).await, json!({ "messages": [] }));
        assert_eq!(h.call("GET", "/inbox/append", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn the_newest_fifty_are_kept_and_a_week_old_queue_is_gone() {
        let h = Harness::new();
        for i in 0..55 {
            append(&h, &format!("k{i}")).await;
        }
        let messages = drain(&h).await;
        assert_eq!((messages.len(), messages[0]["sealed"].clone()), (50, json!("k5")));

        append(&h, "old").await;
        h.advance(super::TTL_MS);
        assert!(drain(&h).await.is_empty(), "an expired queue is not delivered");
    }

    /// Workers KV read the queue, appended and wrote it back, so two appends at once kept one. Here the
    /// read-modify-write is one step.
    #[tokio::test]
    async fn concurrent_appends_are_all_kept() {
        let h = std::sync::Arc::new(Harness::new());
        let appends: Vec<_> = (0..20)
            .map(|i| {
                let h = std::sync::Arc::clone(&h);
                tokio::spawn(async move { append(&h, &format!("k{i}")).await })
            })
            .collect();
        for a in appends {
            assert_eq!(a.await.unwrap(), StatusCode::OK);
        }
        assert_eq!(drain(&h).await.len(), 20);
    }
}
