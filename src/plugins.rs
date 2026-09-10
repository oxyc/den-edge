//! `/plugins` — the addon list the phone and the TV share, keyed by their `inboxKey`. Each entry is
//! `{ url, name?, resources? }`: the TV fills in the name and what an addon provides, which a phone can't
//! read from a LAN `http` manifest. Whole-list last-writer-wins with a version counter. Never written means
//! 404, so a reader keeps its own list; `addons: []` is a real, empty list.
//!
//!   GET /plugins?inboxKey=…                         → { addons, version } | 404
//!   PUT /plugins  { inboxKey, addons: [url | { url, name?, resources? }] } → { version }

use crate::handler::{
    error, internal, js_len, json_reply, method_not_allowed, query_param, raw_json, read_json,
    valid_inbox_key, MAX_BODY_BYTES,
};
use crate::inbox::acceptable_manifest_url;
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};

const NS: &str = "plugins";
const MAX_ADDONS: usize = 100;
const MAX_URL_LEN: usize = 2_000;
const MAX_NAME_LEN: usize = 200;
const MAX_RESOURCES: usize = 20;

pub async fn handle(state: &AppState, req: Request) -> Response {
    match *req.method() {
        Method::GET => read(state, query_param(&req, "inboxKey").unwrap_or_default()).await,
        Method::PUT => write(state, req).await,
        _ => method_not_allowed(),
    }
}

async fn read(state: &AppState, key: String) -> Response {
    if !valid_inbox_key(&key) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_key"));
    }
    match state.store.get(NS, &key).await {
        Ok(Some(bytes)) => raw_json(StatusCode::OK, Body::from(bytes), true),
        Ok(None) => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        Err(e) => internal("plugins read", e),
    }
}

async fn write(state: &AppState, req: Request) -> Response {
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let key = body.get("inboxKey").and_then(Value::as_str).unwrap_or("");
    if !valid_inbox_key(key) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_key"));
    }
    let Some(raw) = body.get("addons").and_then(Value::as_array).filter(|a| a.len() <= MAX_ADDONS) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_addons"));
    };
    let mut addons: Vec<Value> = Vec::with_capacity(raw.len());
    for entry in raw {
        let Some(entry) = sanitize(entry) else {
            return json_reply(StatusCode::BAD_REQUEST, &error("invalid_addons"));
        };
        // Deduplicated by url, first one kept.
        if !addons.iter().any(|a| a["url"] == entry["url"]) {
            addons.push(entry);
        }
    }
    let _write = state.write_lock.lock().await;
    let version = match current_version(state, NS, key).await {
        Ok(v) => v + 1,
        Err(e) => return internal("plugins read", e),
    };
    let stored = json!({ "addons": addons, "version": version });
    if let Err(e) = state.store.put(NS, key, stored.to_string().as_bytes()).await {
        return internal("plugins write", e);
    }
    json_reply(StatusCode::OK, &json!({ "version": version }))
}

/// A stored blob's version, 0 when there is none.
pub async fn current_version(state: &AppState, ns: &str, key: &str) -> std::io::Result<u64> {
    Ok(state
        .store
        .get(ns, key)
        .await?
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()?.get("version")?.as_u64())
        .unwrap_or(0))
}

/// `"url"` or `{ url, name?, resources? }`, with a well-formed manifest url — or `None`.
fn sanitize(raw: &Value) -> Option<Value> {
    let (url, obj) = match raw {
        Value::String(url) => (url.as_str(), None),
        Value::Object(obj) => (obj.get("url")?.as_str()?, Some(obj)),
        _ => return None,
    };
    if js_len(url) > MAX_URL_LEN || !acceptable_manifest_url(url) {
        return None;
    }
    let mut entry = Map::new();
    entry.insert("url".into(), url.into());
    if let Some(obj) = obj {
        if let Some(name) = obj.get("name").and_then(Value::as_str).filter(|n| js_len(n) <= MAX_NAME_LEN) {
            entry.insert("name".into(), name.into());
        }
        if let Some(resources) = obj.get("resources").and_then(Value::as_array) {
            let kept: Vec<Value> =
                resources.iter().filter(|r| r.is_string()).take(MAX_RESOURCES).cloned().collect();
            if !kept.is_empty() {
                entry.insert("resources".into(), kept.into());
            }
        }
    }
    Some(Value::Object(entry))
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    const KEY: &str = "abcdef0123456789";

    async fn put(h: &Harness, addons: Value) -> (StatusCode, Value) {
        h.call("PUT", "/plugins", Some(json!({ "inboxKey": KEY, "addons": addons }))).await
    }

    async fn get(h: &Harness) -> (StatusCode, Value) {
        h.call("GET", &format!("/plugins?inboxKey={KEY}"), None).await
    }

    #[tokio::test]
    async fn absent_until_written_then_round_trips_and_bumps_the_version() {
        let h = Harness::new();
        assert_eq!(get(&h).await.0, StatusCode::NOT_FOUND);
        let entry =
            json!({ "url": "https://addon.example/manifest.json", "name": "Addon", "resources": ["stream"] });
        assert_eq!(put(&h, json!([entry.clone()])).await, (StatusCode::OK, json!({ "version": 1 })));
        assert_eq!(get(&h).await, (StatusCode::OK, json!({ "addons": [entry], "version": 1 })));
        assert_eq!(put(&h, json!([])).await, (StatusCode::OK, json!({ "version": 2 })));
        // An empty list is a real value, not an absence.
        assert_eq!(get(&h).await, (StatusCode::OK, json!({ "addons": [], "version": 2 })));
    }

    #[tokio::test]
    async fn bare_urls_and_lan_http_are_normalised_and_duplicates_dropped() {
        let h = Harness::new();
        let addons = json!(["https://a.example/manifest.json", { "url": "http://192.168.1.5:8080/manifest.json",
                            "resources": [1, "catalog"], "name": "n".repeat(201) }, "https://a.example/manifest.json"]);
        assert_eq!(put(&h, addons).await.0, StatusCode::OK);
        assert_eq!(
            get(&h).await.1["addons"],
            json!([{ "url": "https://a.example/manifest.json" },
            { "url": "http://192.168.1.5:8080/manifest.json", "resources": ["catalog"] }])
        );
    }

    #[tokio::test]
    async fn public_http_too_many_and_junk_keys_are_refused() {
        let h = Harness::new();
        assert_eq!(
            put(&h, json!([{ "url": "http://insecure.example/manifest.json" }])).await.0,
            StatusCode::BAD_REQUEST
        );
        let many: Vec<String> = (0..101).map(|i| format!("https://a{i}.example/manifest.json")).collect();
        assert_eq!(put(&h, json!(many)).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(put(&h, json!("not a list")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(h.call("GET", "/plugins?inboxKey=nope!", None).await.0, StatusCode::BAD_REQUEST);
        let junk = json!({ "inboxKey": "nope!", "addons": [] });
        assert_eq!(h.call("PUT", "/plugins", Some(junk)).await.0, StatusCode::BAD_REQUEST);
    }
}
