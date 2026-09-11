//! `/sync/{syncId}` — where the retired settings backup and six-character links' library backups lived. Nothing
//! writes there any more; a TV erases what an old link left.
//!
//!   DELETE /sync/{id}  → { deleted: true }

use crate::handler::{error, internal, json_reply};
use crate::AppState;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;

const NS: &str = "sync";

pub async fn handle(state: &AppState, req: Request) -> Response {
    let id = req.uri().path().strip_prefix("/sync/").unwrap_or("").to_owned();
    if !(16..=128).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_sync_id"));
    }
    forget(state, &id).await
}

/// Remove a backup. Idempotent.
async fn forget(state: &AppState, id: &str) -> Response {
    let _write = state.write_lock.lock().await;
    match state.store.delete(NS, id).await {
        Ok(()) => json_reply(StatusCode::OK, &json!({ "deleted": true })),
        Err(e) => internal("sync delete", e),
    }
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;

    const ID: &str = "deadbeefcafe1234deadbeef";

    #[tokio::test]
    async fn an_old_backup_is_erased_and_nothing_new_is_taken() {
        let h = Harness::new();
        h.state.store.put("sync", ID, b"{}").await.unwrap();
        assert_eq!(
            h.call("DELETE", &format!("/sync/{ID}"), None).await,
            (StatusCode::OK, json!({ "deleted": true }))
        );
        assert_eq!(h.state.store.get("sync", ID).await.unwrap(), None);
        assert_eq!(h.call("DELETE", &format!("/sync/{ID}"), None).await.0, StatusCode::OK, "again is fine");
        assert_eq!(h.call("DELETE", "/sync/nope", None).await.0, StatusCode::BAD_REQUEST);
        let put =
            h.call("PUT", &format!("/sync/{ID}"), Some(json!({ "ciphertext": "A", "nonce": "n" }))).await;
        assert_eq!(put.0, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(h.call("GET", &format!("/sync/{ID}"), None).await.0, StatusCode::METHOD_NOT_ALLOWED);
    }
}
