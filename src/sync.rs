//! `/sync/{syncId}` — the TV's encrypted library backup: one opaque blob per sync id, never parsed. `version`
//! is a compare-and-set counter: a write must name the version it was based on, and a stale one gets the
//! current version back to merge against. Under the write lock the check and the write are one step, which
//! Workers KV could only approximate.
//!
//!   GET /sync/{id}                                → { ciphertext, nonce, version } | 404
//!   PUT /sync/{id}  { ciphertext, nonce, baseVersion } → { version } | 409 { error, version }
//!   DELETE /sync/{id}                             → { deleted: true } — on unlinking, the backup filed under
//!                                                   that link goes too

use crate::handler::{
    error, internal, js_len, json_reply, method_not_allowed, raw_json, read_json, SYNC_MAX_BODY_BYTES,
};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

const NS: &str = "sync";
/// A few thousand titles seal to a few MB; `handler::SYNC_MAX_BODY_BYTES` is sized from this.
pub const MAX_CIPHERTEXT: usize = 4_000_000;

pub async fn handle(state: &AppState, req: Request) -> Response {
    let id = req.uri().path().strip_prefix("/sync/").unwrap_or("").to_owned();
    if !(16..=128).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_sync_id"));
    }
    match *req.method() {
        Method::GET => read(state, &id).await,
        Method::PUT => write(state, &id, req).await,
        Method::DELETE => forget(state, &id).await,
        _ => method_not_allowed(),
    }
}

/// Remove a backup. Idempotent, and asks nothing but the id — which is all a write asks, too.
async fn forget(state: &AppState, id: &str) -> Response {
    let _write = state.write_lock.lock().await;
    match state.store.delete(NS, id).await {
        Ok(()) => json_reply(StatusCode::OK, &json!({ "deleted": true })),
        Err(e) => internal("sync delete", e),
    }
}

/// The stored blob goes out as it was written — it is already the response body.
async fn read(state: &AppState, id: &str) -> Response {
    match state.store.get(NS, id).await {
        Ok(Some(bytes)) => raw_json(StatusCode::OK, Body::from(bytes), true),
        Ok(None) => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        Err(e) => internal("sync read", e),
    }
}

async fn write(state: &AppState, id: &str, req: Request) -> Response {
    let body = match read_json(req, SYNC_MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let (Some(ciphertext), Some(nonce)) =
        (body.get("ciphertext").and_then(Value::as_str), body.get("nonce").and_then(Value::as_str))
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_blob"));
    };
    if ciphertext.is_empty() || js_len(ciphertext) > MAX_CIPHERTEXT {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_blob"));
    }
    let base = body.get("baseVersion").and_then(Value::as_f64).unwrap_or(0.0);

    let _write = state.write_lock.lock().await;
    let current = match state.store.get(NS, id).await {
        Ok(stored) => stored.and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).ok()?.get("version").and_then(Value::as_u64)
        }),
        Err(e) => return internal("sync read", e),
    };
    if let Some(current) = current.filter(|v| *v as f64 != base) {
        return json_reply(StatusCode::CONFLICT, &json!({ "error": "conflict", "version": current }));
    }
    let version = current.unwrap_or(0) + 1;
    let stored = json!({ "ciphertext": ciphertext, "nonce": nonce, "version": version });
    if let Err(e) = state.store.put(NS, id, stored.to_string().as_bytes()).await {
        return internal("sync write", e);
    }
    json_reply(StatusCode::OK, &json!({ "version": version }))
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;

    const ID: &str = "deadbeefcafe1234deadbeef";

    async fn put(h: &Harness, ciphertext: &str, base: u64) -> (StatusCode, serde_json::Value) {
        h.call(
            "PUT",
            &format!("/sync/{ID}"),
            Some(json!({ "ciphertext": ciphertext, "nonce": "n", "baseVersion": base })),
        )
        .await
    }

    #[tokio::test]
    async fn a_put_is_version_one_and_reads_back_only_the_blob() {
        let h = Harness::new();
        assert_eq!(put(&h, "AAAA", 0).await, (StatusCode::OK, json!({ "version": 1 })));
        let (status, body) = h.call("GET", &format!("/sync/{ID}"), None).await;
        assert_eq!(
            (status, body),
            (StatusCode::OK, json!({ "ciphertext": "AAAA", "nonce": "n", "version": 1 }))
        );
    }

    #[tokio::test]
    async fn a_stale_base_version_gets_the_current_one() {
        let h = Harness::new();
        put(&h, "v1", 0).await;
        assert_eq!(
            put(&h, "x", 0).await,
            (StatusCode::CONFLICT, json!({ "error": "conflict", "version": 1 }))
        );
        assert_eq!(put(&h, "v2", 1).await, (StatusCode::OK, json!({ "version": 2 })));
    }

    #[tokio::test]
    async fn a_library_sized_blob_fits_and_one_over_the_cap_does_not() {
        let h = Harness::new();
        let big = "A".repeat(super::MAX_CIPHERTEXT);
        assert_eq!(put(&h, &big, 0).await.0, StatusCode::OK);
        let (_, body) = h.call("GET", &format!("/sync/{ID}"), None).await;
        assert_eq!(body["ciphertext"].as_str().unwrap().len(), super::MAX_CIPHERTEXT);
        assert_eq!(put(&h, &(big + "A"), 1).await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn bad_ids_and_blobs_are_refused_and_an_unknown_id_is_absent() {
        let h = Harness::new();
        assert_eq!(h.call("GET", "/sync/0123456789abcdef", None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(h.call("GET", "/sync/nope", None).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(put(&h, "", 0).await.0, StatusCode::BAD_REQUEST);
        let missing =
            h.call("PUT", &format!("/sync/{ID}"), Some(json!({ "nonce": "n", "baseVersion": 0 }))).await;
        assert_eq!(missing.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_backup_can_be_deleted_and_deleting_twice_is_fine() {
        let h = Harness::new();
        put(&h, "gone", 0).await;
        assert_eq!(
            h.call("DELETE", &format!("/sync/{ID}"), None).await,
            (StatusCode::OK, json!({ "deleted": true }))
        );
        assert_eq!(h.call("GET", &format!("/sync/{ID}"), None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(h.call("DELETE", &format!("/sync/{ID}"), None).await.0, StatusCode::OK);
    }

    /// The backup outlives the process — the one thing a relay that loses it on restart gets wrong.
    #[tokio::test]
    async fn a_backup_survives_a_restart() {
        let h = Harness::new();
        put(&h, "kept", 0).await;
        let restarted = Harness::in_dir(h.dir.clone());
        assert_eq!(restarted.call("GET", &format!("/sync/{ID}"), None).await.1["ciphertext"], "kept");
        assert_eq!(put(&restarted, "next", 1).await, (StatusCode::OK, json!({ "version": 2 })));
    }
}
