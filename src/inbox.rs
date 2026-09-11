//! `/inbox` — the companion's messages to a TV. The phone appends under its `inboxKey`; the TV drains the
//! queue on launch and foreground, which empties it. Five kinds of message: add an addon, add to the
//! watchlist, play, and the user's TMDB and other metadata keys.

use crate::handler::{
    error, header_key, internal, js_len, json_reply, link_key, method_not_allowed, read_json,
    valid_inbox_key, MAX_BODY_BYTES,
};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};

const NS: &str = "inbox";
/// A queue an unopened TV never drains goes after a week.
const TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// The newest fifty are kept; older ones fall off the front.
const MAX_MESSAGES: usize = 50;
/// Metadata services whose keys the companion may send — never anything that plays or pays.
const API_KEY_SERVICES: [&str; 2] = ["omdb", "doesthedogdie"];

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
    let Some(message) = validate(body.get("message")) else {
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

/// A well-formed companion message, rebuilt from only the fields it may carry — or `None`.
fn validate(raw: Option<&Value>) -> Option<Value> {
    let m = raw?.as_object()?;
    let mut out = Map::new();
    let kind = m.get("type")?.as_str()?;
    out.insert("type".into(), kind.into());
    match kind {
        "addon" => {
            let url = m.get("manifestUrl")?.as_str().filter(|u| acceptable_manifest_url(u))?;
            out.insert("manifestUrl".into(), url.into());
        }
        "watchlist" | "play" => {
            let tmdb_id = m.get("tmdbId").filter(|v| v.is_number())?;
            let media_type = m.get("mediaType")?.as_str().filter(|t| *t == "movie" || *t == "tv")?;
            let title = m.get("title")?.as_str().filter(|t| !t.is_empty())?;
            out.insert("tmdbId".into(), tmdb_id.clone());
            out.insert("mediaType".into(), media_type.into());
            out.insert("title".into(), title.into());
            let optional: &[(&str, Check)] = if kind == "watchlist" {
                &[("posterPath", Value::is_string), ("year", Value::is_number)]
            } else {
                &[("season", Value::is_number), ("episode", Value::is_number)]
            };
            for (field, ok) in optional {
                if let Some(v) = m.get(*field).filter(|v| ok(v)) {
                    out.insert((*field).into(), v.clone());
                }
            }
        }
        "tmdbKey" => {
            out.insert("key".into(), bounded_key(m)?.into());
        }
        "apiKey" => {
            let service = m.get("service")?.as_str().filter(|s| API_KEY_SERVICES.contains(s))?;
            out.insert("service".into(), service.into());
            out.insert("key".into(), bounded_key(m)?.into());
        }
        "device" => {
            out.insert("name".into(), crate::link::device_label(m.get("name"))?.into());
        }
        _ => return None,
    }
    Some(Value::Object(out))
}

/// What an optional field's value must be to be kept.
type Check = fn(&Value) -> bool;

fn bounded_key(m: &Map<String, Value>) -> Option<&str> {
    m.get("key")?.as_str().filter(|k| !k.is_empty() && js_len(k) <= 200)
}

/// A host on the user's own network — the rule DenKit's `AddonClient.isLocalHost` and the companion page
/// apply.
fn is_local_host(host: &str) -> bool {
    if matches!(host, "localhost" | "127.0.0.1" | "::1") || host.ends_with(".local") {
        return true;
    }
    let octets: Vec<&str> = host.split('.').collect();
    if octets.len() != 4 || !octets.iter().all(|o| !o.is_empty() && o.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    let n = |o: &str| o.parse::<u64>().unwrap_or(u64::MAX);
    let (a, b) = (n(octets[0]), n(octets[1]));
    a == 10 || (a == 192 && b == 168) || (a == 172 && (16..=31).contains(&b))
}

/// https anywhere, or http only to a LAN or local host — the add-time rule the phone and the TV enforce.
pub fn acceptable_manifest_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else { return false };
    match url.scheme() {
        "https" => true,
        "http" => url.host_str().is_some_and(is_local_host),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    const KEY: &str = "deadbeefcafe1234deadbeef";

    async fn append(h: &Harness, message: Value) -> StatusCode {
        h.call("POST", "/inbox/append", Some(json!({ "inboxKey": KEY, "message": message }))).await.0
    }

    async fn drain(h: &Harness) -> Vec<Value> {
        let (_, body) = h.call("GET", &format!("/inbox/drain?inboxKey={KEY}"), None).await;
        body["messages"].as_array().unwrap().clone()
    }

    #[tokio::test]
    async fn append_two_then_drain_returns_both_once() {
        let h = Harness::new();
        let watchlist = json!({ "type": "watchlist", "tmdbId": 693134, "mediaType": "movie", "title": "Dune: Part Two",
                                "year": 2024, "posterPath": "/x.jpg", "junk": 1 });
        assert_eq!(append(&h, watchlist).await, StatusCode::OK);
        assert_eq!(
            append(&h, json!({ "type": "addon", "manifestUrl": "https://addon.example/manifest.json" }))
                .await,
            StatusCode::OK
        );
        let messages = drain(&h).await;
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0],
            json!({ "type": "watchlist", "tmdbId": 693134, "mediaType": "movie",
                                        "title": "Dune: Part Two", "year": 2024, "posterPath": "/x.jpg" })
        );
        assert!(drain(&h).await.is_empty(), "a drain empties the queue");
    }

    #[tokio::test]
    async fn every_kind_of_message_is_checked() {
        let h = Harness::new();
        let play = json!({ "type": "play", "tmdbId": 1396, "mediaType": "tv", "title": "Breaking Bad", "season": 2, "episode": 4 });
        assert_eq!(append(&h, play.clone()).await, StatusCode::OK);
        assert_eq!(append(&h, json!({ "type": "tmdbKey", "key": "abc123" })).await, StatusCode::OK);
        assert_eq!(
            append(&h, json!({ "type": "apiKey", "service": "omdb", "key": "OMDB1" })).await,
            StatusCode::OK
        );
        assert_eq!(
            append(&h, json!({ "type": "addon", "manifestUrl": "http://192.168.1.50:8093/manifest.json" }))
                .await,
            StatusCode::OK
        );
        assert_eq!(
            append(&h, json!({ "type": "device", "name": " Mac · Chrome\u{7}", "model": "x" })).await,
            StatusCode::OK
        );
        let messages = drain(&h).await;
        assert_eq!(messages[0], play);
        assert_eq!(messages[2], json!({ "type": "apiKey", "service": "omdb", "key": "OMDB1" }));
        assert_eq!(messages[4], json!({ "type": "device", "name": "Mac · Chrome" }));

        for bad in [
            json!({ "type": "play", "tmdbId": 1, "mediaType": "person", "title": "x" }),
            json!({ "type": "watchlist", "tmdbId": "1", "mediaType": "movie", "title": "x" }),
            json!({ "type": "watchlist", "tmdbId": 1, "mediaType": "movie", "title": "" }),
            json!({ "type": "tmdbKey", "key": "" }),
            json!({ "type": "tmdbKey", "key": "k".repeat(201) }),
            json!({ "type": "apiKey", "service": "trakt", "key": "x" }),
            json!({ "type": "addon", "manifestUrl": "http://insecure.example/manifest.json" }),
            json!({ "type": "addon", "manifestUrl": "ftp://192.168.1.5/manifest.json" }),
            json!({ "type": "device", "name": "  " }),
            json!({ "type": "device", "name": 3 }),
            json!({ "type": "nope" }),
            json!("addon"),
        ] {
            assert_eq!(append(&h, bad.clone()).await, StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    /// The key travels in `x-den-link`, out of the URL; a header wins over a body key.
    #[tokio::test]
    async fn the_key_can_travel_in_a_header() {
        let h = Harness::new();
        let body = json!({ "inboxKey": "not a key!", "message": { "type": "tmdbKey", "key": "k" } });
        let appended = h.send("POST", "/inbox/append", Some(body.to_string()), &[("x-den-link", KEY)]).await;
        assert_eq!(appended.status(), StatusCode::OK);
        let drained = h.send("GET", "/inbox/drain", None, &[("x-den-link", KEY)]).await;
        let messages = crate::handler::tests::body_json(drained).await["messages"].clone();
        assert_eq!(messages, json!([{ "type": "tmdbKey", "key": "k" }]));
        let junk =
            h.send("GET", "/inbox/drain?inboxKey=abcdef0123456789", None, &[("x-den-link", "nope")]).await;
        assert_eq!(junk.status(), StatusCode::BAD_REQUEST, "a header wins over the query");
    }

    #[tokio::test]
    async fn junk_keys_are_refused_and_an_unknown_queue_is_empty() {
        let h = Harness::new();
        let body = json!({ "inboxKey": "not a key!", "message": { "type": "tmdbKey", "key": "k" } });
        assert_eq!(h.call("POST", "/inbox/append", Some(body)).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(h.call("GET", "/inbox/drain?inboxKey=short", None).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(
            h.call("GET", "/inbox/drain?inboxKey=abcdef0123456789", None).await,
            (StatusCode::OK, json!({ "messages": [] }))
        );
        assert_eq!(h.call("GET", "/inbox/append", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn the_newest_fifty_are_kept_and_a_week_old_queue_is_gone() {
        let h = Harness::new();
        for i in 0..55 {
            append(&h, json!({ "type": "tmdbKey", "key": format!("k{i}") })).await;
        }
        let messages = drain(&h).await;
        assert_eq!((messages.len(), messages[0]["key"].clone()), (50, json!("k5")));

        append(&h, json!({ "type": "tmdbKey", "key": "old" })).await;
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
                tokio::spawn(
                    async move { append(&h, json!({ "type": "tmdbKey", "key": format!("k{i}") })).await },
                )
            })
            .collect();
        for a in appends {
            assert_eq!(a.await.unwrap(), StatusCode::OK);
        }
        assert_eq!(drain(&h).await.len(), 20);
    }

    #[test]
    fn local_hosts_are_the_lan_and_nothing_else() {
        for ok in
            ["localhost", "127.0.0.1", "nas.local", "10.0.0.2", "192.168.86.193", "172.16.0.1", "172.31.9.9"]
        {
            assert!(super::is_local_host(ok), "{ok}");
        }
        for no in ["172.32.0.1", "192.169.1.1", "8.8.8.8", "example.com", "[::1]", "1.2.3"] {
            assert!(!super::is_local_host(no), "{no}");
        }
    }
}
