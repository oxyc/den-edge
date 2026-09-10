//! `/settings` — the user settings the TV and the companion share, keyed by their `inboxKey`: the app's
//! tagged config values (`{ bool | int | string | ints | strings }`), stored as given and bounded, never
//! interpreted. Whole-blob last-writer-wins with a version counter; never written means 404.
//!
//!   GET /settings?inboxKey=…              → { settings, version } | 404
//!   PUT /settings  { inboxKey, settings }  → { version }

use crate::handler::{
    error, internal, js_len, json_reply, method_not_allowed, query_param, raw_json, read_json,
    valid_inbox_key, MAX_BODY_BYTES,
};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

const NS: &str = "settings";
const MAX_KEYS: usize = 60;
const MAX_JSON_LEN: usize = 20_000;

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
        Err(e) => internal("settings read", e),
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
    let Some(settings) = body.get("settings").filter(|s| s.is_object()) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_settings"));
    };
    if settings.as_object().is_some_and(|s| s.len() > MAX_KEYS) {
        return json_reply(StatusCode::BAD_REQUEST, &error("too_many"));
    }
    if js_len(&settings.to_string()) > MAX_JSON_LEN {
        return json_reply(StatusCode::BAD_REQUEST, &error("too_large"));
    }
    let _write = state.write_lock.lock().await;
    let version = match crate::plugins::current_version(state, NS, key).await {
        Ok(v) => v + 1,
        Err(e) => return internal("settings read", e),
    };
    let stored = json!({ "settings": settings, "version": version });
    if let Err(e) = state.store.put(NS, key, stored.to_string().as_bytes()).await {
        return internal("settings write", e);
    }
    json_reply(StatusCode::OK, &json!({ "version": version }))
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::{json, Map, Value};

    const KEY: &str = "abcdef0123456789";

    async fn put(h: &Harness, settings: Value) -> (StatusCode, Value) {
        h.call("PUT", "/settings", Some(json!({ "inboxKey": KEY, "settings": settings }))).await
    }

    #[tokio::test]
    async fn absent_until_written_then_round_trips_and_bumps_the_version() {
        let h = Harness::new();
        assert_eq!(h.call("GET", &format!("/settings?inboxKey={KEY}"), None).await.0, StatusCode::NOT_FOUND);
        let settings = json!({ "den.shownWarningCategories": { "strings": ["A death", "A dog dies"] },
                               "den.hideWatched": { "bool": true } });
        assert_eq!(put(&h, settings.clone()).await, (StatusCode::OK, json!({ "version": 1 })));
        let (_, got) = h.call("GET", &format!("/settings?inboxKey={KEY}"), None).await;
        assert_eq!(got, json!({ "settings": settings, "version": 1 }));
        assert_eq!(put(&h, json!({ "a": { "bool": false } })).await.1, json!({ "version": 2 }));
    }

    #[tokio::test]
    async fn bad_keys_non_objects_and_oversized_settings_are_refused() {
        let h = Harness::new();
        assert_eq!(h.call("GET", "/settings?inboxKey=nope!", None).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(put(&h, json!([1, 2])).await.1, json!({ "error": "invalid_settings" }));
        assert_eq!(put(&h, json!("x")).await.1, json!({ "error": "invalid_settings" }));
        let many: Map<String, Value> = (0..61).map(|i| (format!("k{i}"), json!({ "bool": true }))).collect();
        assert_eq!(put(&h, Value::Object(many)).await.1, json!({ "error": "too_many" }));
        assert_eq!(
            put(&h, json!({ "k": { "string": "x".repeat(20_000) } })).await.1,
            json!({ "error": "too_large" })
        );
    }
}
