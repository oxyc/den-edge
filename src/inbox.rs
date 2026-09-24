//! `/inbox` — a paired device's messages to a TV (den-spec `wire/inbox-v1.md`). The device appends under its link
//! credential, sealed under the link's key, so den-edge can't read, forge or replay them; the TV drains the queue
//! on launch and while in front, which empties it. A readable message is refused: every device that sends one
//! pairs now.

use crate::handler::{
    error, header_key, internal, json_reply, link_key, method_not_allowed, read_json, retry_after,
    valid_inbox_key, MAX_BODY_BYTES,
};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

const NS: &str = "inbox";
/// Appends per address per minute. A key is the only credential here — den-edge never learns the link keys, which
/// pairing derives without it — so the limit is what stands between a public name and anyone's queue.
const APPENDS_PER_WINDOW: u32 = 60;
/// Queues STARTED per address per minute, priced far lower than appending to one: an append to a live queue is
/// bounded by `MAX_MESSAGES`, while a new queue is new storage, and filling the store is the cheap attack.
const NEW_QUEUES_PER_WINDOW: u32 = 5;
/// A queue an unopened TV never drains goes after a week.
const TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// The newest fifty are kept; older ones fall off the front.
const MAX_MESSAGES: usize = 50;
const MAX_SEALED_CHARS: usize = 4096;
/// Queues one `POST /inbox/drain` may take: a TV drains one per linked device, and a household links a handful.
const MAX_DRAIN_KEYS: usize = 16;

/// Cleanup is independent of requests to an abandoned link. Run once before serving, then hourly.
pub async fn sweep(state: &AppState) {
    if let Err(e) = state.store.sweep_inboxes(state.now(), &state.write_lock).await {
        eprintln!("inbox expiry sweep: {e}");
    }
}

pub async fn sweep_forever(state: std::sync::Arc<AppState>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        sweep(&state).await;
    }
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    match req.uri().path() {
        "/inbox/append" if req.method() == Method::POST => append(state, req).await,
        "/inbox/append" => method_not_allowed(),
        "/inbox/drain" if req.method() == Method::POST => drain_many(state, req).await,
        "/inbox/drain" if req.method() == Method::GET => {
            if let Some(wait) = drain_budget(state, &crate::handler::client_ip(state, &req), 1) {
                return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
            }
            drain(state, link_key(&req)).await
        }
        "/inbox/drain" => method_not_allowed(),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

/// Several queues in one request: `{"keys": [...]}` in, `{"queues": [[...], ...]}` out, in the order asked. A TV
/// with a handful of linked devices polls every few seconds while in front, and asked once per device.
///
/// Each key is still its own credential, exactly as for a single drain: a queue is emptied only for the key that
/// names it, and one malformed key refuses the request rather than being skipped, so a client never mistakes a
/// refused key for an empty queue. The keys travel in the body, which is never logged, like the header does for
/// one.
async fn drain_many(state: &AppState, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some(keys) = body.get("keys").and_then(Value::as_array) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_keys"));
    };
    if keys.is_empty() || keys.len() > MAX_DRAIN_KEYS {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_keys"));
    }
    let Some(keys) =
        keys.iter().map(|k| k.as_str().filter(|k| valid_inbox_key(k))).collect::<Option<Vec<_>>>()
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_key"));
    };
    if keys.iter().collect::<std::collections::HashSet<_>>().len() != keys.len() {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_keys"));
    }
    if let Some(wait) = drain_budget(state, &ip, keys.len()) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let now = state.now();
    let mut queues = Vec::with_capacity(keys.len());
    for key in keys {
        // One queue at a time under the store's write lock, so a drain of many never holds every other writer
        // for all of them. Nothing is lost by it: a queue that cannot be read is left where it is, answered as
        // empty and delivered by the next drain; one that cannot be deleted is still handed over, and again next
        // time, where a paired TV drops what it already applied (den-spec inbox-v1 §3).
        let _write = state.write_lock.lock().await;
        queues.push(match load(state, key, now).await {
            Ok(Some(queue)) => {
                if let Err(e) = state.store.delete(NS, key).await {
                    eprintln!("inbox delete: {e}");
                }
                queue
            }
            Ok(None) => Vec::new(),
            Err(e) => {
                eprintln!("inbox read: {e}");
                Vec::new()
            }
        });
    }
    json_reply(StatusCode::OK, &json!({ "queues": queues }))
}

/// Queues drained per address per minute, a queue each whether asked one at a time or together. A drain is a read
/// and a delete under the store's write lock, and the route answers on the public names: without a budget one
/// address could keep every other writer waiting. A TV polling seven linked devices every ten seconds spends 42.
///
/// Fixed minute windows, not `throttled_by`'s window that moves on with every request allowed: a TV polls without
/// pause, so a moving window would never close and a steady poller would add up to the limit within minutes.
const DRAINS_PER_WINDOW: u32 = 240;

fn drain_budget(state: &AppState, ip: &str, queues: usize) -> Option<u64> {
    let cost = u32::try_from(queues).unwrap_or(u32::MAX);
    crate::link::throttled_per_minute_by(state, &format!("inbox-drain:{ip}"), DRAINS_PER_WINDOW, cost)
}

async fn append(state: &AppState, req: Request) -> Response {
    // Counted before the body is read: the point is to not do work for a flood.
    let ip = crate::handler::client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_at(state, &format!("inbox:{ip}"), APPENDS_PER_WINDOW) {
        return crate::handler::retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
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
    let existing = match load(state, key, now).await {
        Ok(queue) => queue,
        Err(e) => return internal("inbox read", e),
    };
    if existing.is_none() {
        let started = crate::link::throttled_at(state, &format!("inbox-new:{ip}"), NEW_QUEUES_PER_WINDOW);
        if let Some(wait) = started {
            return crate::handler::retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
        }
    }
    let mut queue = existing.unwrap_or_default();
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

    /// A drain empties the queue, so only the methods that ask for one drain. A HEAD or OPTIONS used to pass the
    /// method allowlist and then drain, handing the messages to nobody: a HEAD answer has no body.
    #[tokio::test]
    async fn a_head_or_options_never_drains() {
        let h = Harness::new();
        assert_eq!(append(&h, "AAEC").await, StatusCode::OK);
        for method in ["HEAD", "OPTIONS"] {
            let origin = [
                ("x-den-link", KEY),
                ("origin", "https://elsewhere.example"),
                ("access-control-request-method", "GET"),
            ];
            let resp = h.send(method, "/inbox/drain", None, &origin).await;
            assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
        }
        assert_eq!(drain(&h).await, vec![json!({ "sealed": "AAEC" })], "still there for the GET");
    }

    /// A TV with several linked devices drains all of their queues in one request, in the order it named them,
    /// and each queue is emptied only for its own key.
    #[tokio::test]
    async fn several_queues_drain_in_one_request_in_the_order_asked() {
        let h = Harness::new();
        let other = "0123456789abcdef0123";
        let idle = "fedcba9876543210fedc";
        assert_eq!(append(&h, "AAEC").await, StatusCode::OK);
        let body = json!({ "inboxKey": other, "sealed": "BBBB" });
        assert_eq!(h.call("POST", "/inbox/append", Some(body)).await.0, StatusCode::OK);

        let (status, answer) =
            h.call("POST", "/inbox/drain", Some(json!({ "keys": [other, idle, KEY] }))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer, json!({ "queues": [[{ "sealed": "BBBB" }], [], [{ "sealed": "AAEC" }]] }));
        let (_, again) = h.call("POST", "/inbox/drain", Some(json!({ "keys": [KEY, other] }))).await;
        assert_eq!(again, json!({ "queues": [[], []] }), "each queue was emptied");
        assert!(drain(&h).await.is_empty());
    }

    /// Each key is its own credential, so one that is not a key refuses the request instead of reading as an
    /// empty queue — and refuses it before any queue is emptied.
    #[tokio::test]
    async fn a_multi_drain_is_bounded_and_refuses_a_bad_key_whole() {
        let h = Harness::new();
        assert_eq!(append(&h, "AAEC").await, StatusCode::OK);
        let too_many: Vec<String> = (0..=super::MAX_DRAIN_KEYS as u64).map(|n| format!("{n:016x}")).collect();
        for body in [
            json!({}),
            json!({ "keys": [] }),
            json!({ "keys": KEY }),
            json!({ "keys": too_many }),
            json!({ "keys": [KEY, KEY] }),
            json!({ "keys": [KEY, "short"] }),
            json!({ "keys": [KEY, 7] }),
        ] {
            assert_eq!(
                h.call("POST", "/inbox/drain", Some(body.clone())).await.0,
                StatusCode::BAD_REQUEST,
                "{body}"
            );
        }
        assert_eq!(drain(&h).await, vec![json!({ "sealed": "AAEC" })], "nothing was emptied");
        let at_most: Vec<String> = (1..=super::MAX_DRAIN_KEYS as u64).map(|n| format!("{n:016x}")).collect();
        assert_eq!(h.call("POST", "/inbox/drain", Some(json!({ "keys": at_most }))).await.0, StatusCode::OK);
    }

    /// Draining is priced per queue, however they are asked for: a 16-key drain spends 16 of an address's minute,
    /// and a single drain shares the same budget. Refused whole, with the wait to come back after.
    #[tokio::test]
    async fn drains_are_limited_per_address_by_the_queues_they_take() {
        let h = Harness::new();
        let keys: Vec<String> = (1..=super::MAX_DRAIN_KEYS as u64).map(|n| format!("{n:016x}")).collect();
        let rounds = super::DRAINS_PER_WINDOW as usize / super::MAX_DRAIN_KEYS;
        for round in 0..rounds {
            let status = h.call("POST", "/inbox/drain", Some(json!({ "keys": keys }))).await.0;
            assert_eq!(status, StatusCode::OK, "{round}");
        }
        let over = h.send("POST", "/inbox/drain", Some(json!({ "keys": keys }).to_string()), &[]).await;
        assert_eq!(over.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(over.headers().contains_key("retry-after"));
        let one = h.send("GET", "/inbox/drain", None, &[("x-den-link", KEY)]).await;
        assert_eq!(one.status(), StatusCode::TOO_MANY_REQUESTS, "a single drain spends the same budget");

        h.advance(60_000);
        assert_eq!(drain(&h).await, Vec::<Value>::new(), "the window clears");
    }

    /// A TV polls without pause: seven single drains every ten seconds, for an hour, stay inside the budget. A
    /// window that moved on with every allowed request would never close and refuse it within minutes.
    #[tokio::test]
    async fn a_steady_poller_is_never_refused() {
        let h = Harness::new();
        for poll in 0..360 {
            for _ in 0..7 {
                let status = h.send("GET", "/inbox/drain", None, &[("x-den-link", KEY)]).await.status();
                assert_eq!(status, StatusCode::OK, "poll {poll}");
            }
            h.advance(10_000);
        }
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

    /// A key is the only credential on this route — den-edge never learns one — so on a public name the limit is
    /// what stands between a stranger and every queue.
    #[tokio::test]
    async fn appends_are_limited_per_address() {
        let h = Harness::new();
        for i in 0..super::APPENDS_PER_WINDOW {
            assert_eq!(append(&h, &format!("k{i}")).await, StatusCode::OK, "{i}");
        }
        assert_eq!(append(&h, "over").await, StatusCode::TOO_MANY_REQUESTS);
    }

    /// Starting queues is priced far below appending to one: an append is bounded by `MAX_MESSAGES`, while a new
    /// queue is new storage, and filling the store is the cheap attack.
    #[tokio::test]
    async fn starting_queues_runs_out_long_before_the_append_budget() {
        let h = Harness::new();
        let key = |n: u64| format!("{n:016x}");
        for n in 1..=super::NEW_QUEUES_PER_WINDOW as u64 {
            let body = json!({ "inboxKey": key(n), "sealed": "AAEC" });
            assert_eq!(h.call("POST", "/inbox/append", Some(body)).await.0, StatusCode::OK, "{n}");
        }
        let another = json!({ "inboxKey": key(999), "sealed": "AAEC" });
        assert_eq!(h.call("POST", "/inbox/append", Some(another)).await.0, StatusCode::TOO_MANY_REQUESTS);
        // A queue already started still takes messages: the tighter budget prices storage, not delivery.
        let existing = json!({ "inboxKey": key(1), "sealed": "BBBB" });
        assert_eq!(h.call("POST", "/inbox/append", Some(existing)).await.0, StatusCode::OK);
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

    /// One file the sweep cannot read is reported and passed over; it does not stop the sweep reclaiming the rest.
    #[tokio::test]
    async fn a_file_the_sweep_cannot_read_does_not_stop_it() {
        let h = Harness::new();
        assert_eq!(append(&h, "AAEC").await, StatusCode::OK);
        // Directories named like queues: opened, but never read.
        for n in 0..10 {
            std::fs::create_dir(h.dir.join("inbox").join(format!("{n}.json"))).unwrap();
        }
        h.advance(super::TTL_MS);
        super::sweep(&h.state).await;
        assert!(
            h.state.store.get(super::NS, KEY).await.unwrap().is_none(),
            "the expired queue was reclaimed"
        );
    }

    #[tokio::test]
    async fn sweep_reclaims_abandoned_queues_and_keeps_refreshed_queues() {
        let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |s| {
            // The inbox's share of it, a quarter, is 700 bytes.
            s.store = crate::store::Store::open(&crate::handler::tests::temp_dir(), 2800).unwrap();
        });
        assert_eq!(append(&h, &"x".repeat(200)).await, StatusCode::OK);
        h.advance(super::TTL_MS - 1000);
        let other = "1234567890abcdef";
        let payload = json!({"inboxKey":other,"sealed":"y".repeat(200)});
        assert_eq!(h.call("POST", "/inbox/append", Some(payload.clone())).await.0, StatusCode::OK);
        h.advance(2000);
        super::sweep(&h.state).await;
        assert!(h.state.store.get(super::NS, KEY).await.unwrap().is_none());
        assert!(h.state.store.get(super::NS, other).await.unwrap().is_some());
        // Reclaimed bytes are reflected in the shared quota, not just deleted from the filesystem.
        assert_eq!(append(&h, &"z".repeat(200)).await, StatusCode::OK);
        super::sweep(&h.state).await;
        assert_eq!(drain(&h).await.len(), 1);
    }
}
