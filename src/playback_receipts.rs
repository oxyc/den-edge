//! Opaque managed-playback completion receipts (`den-spec/wire/playback-receipts-v1.md`). Edge binds a one-use
//! callback capability to an authenticated playback and a household drop-box public key, then queues only the
//! sealed result. It never receives title, position or completion plaintext.

use crate::handler::{error, internal, json_reply, read_json, retry_after};
use crate::AppState;
use axum::extract::Request;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const NS: &str = "playback-receipts";
const TTL_MS: u64 = 7 * 86_400_000;
const MAX_QUEUED: usize = 100;
const MAX_CALLBACKS: usize = 512;
const CALLBACKS_PER_MINUTE: u32 = 60;
const CALLBACK_ATTEMPTS_PER_MINUTE: u32 = 12;
const MAX_SEALED: usize = 2_539;
const MIN_SEALED_BYTES: usize = den_assistant::ENC_LEN + 16 + 2;
pub const BODY_BYTES: usize = 4 * 1024;

#[derive(Clone)]
pub struct PlaybackContext {
    pub library: String,
    pub kid: String,
    pub public: String,
    pub id: String,
    pub token: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Callback {
    hash: String,
    token: String,
    request: String,
    library: String,
    kid: String,
    public: String,
    id: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Callbacks {
    entries: Vec<Callback>,
}

#[derive(Serialize, Deserialize, Default)]
struct Queue {
    next: u64,
    messages: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    seq: u64,
    sealed: String,
    callback: String,
    #[serde(rename = "receivedAt")]
    received_at: u64,
}

fn callback_id(token: &str) -> String {
    crate::hex(&Sha256::digest(token.as_bytes()))
}

fn request_id(request: &str) -> String {
    crate::hex(&Sha256::digest(request.as_bytes()))
}

fn queue_key(library: &str) -> String {
    format!("q:{library}")
}

async fn load_callbacks(state: &AppState, now: u64) -> std::io::Result<Callbacks> {
    let mut callbacks = match state.store.get(NS, "callbacks").await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
        None => Callbacks::default(),
    };
    callbacks.entries.retain(|entry| entry.expires_at > now);
    Ok(callbacks)
}

async fn save_callbacks(state: &AppState, callbacks: &Callbacks) -> std::io::Result<()> {
    state.store.put(NS, "callbacks", &serde_json::to_vec(callbacks).expect("callback table serializes")).await
}

fn valid_sealed(sealed: &str) -> bool {
    sealed.len() <= MAX_SEALED
        && den_assistant::b64url_decode(sealed).is_some_and(|bytes| bytes.len() >= MIN_SEALED_BYTES)
}

async fn load_queue(state: &AppState, library: &str, now: u64) -> std::io::Result<Queue> {
    let mut queue = match state.store.get(NS, &queue_key(library)).await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
        None => Queue { next: 1, ..Queue::default() },
    };
    queue.next = queue.next.max(1);
    queue.messages.retain(|entry| entry.received_at.saturating_add(TTL_MS) > now);
    Ok(queue)
}

async fn save_queue(state: &AppState, library: &str, queue: &Queue) -> std::io::Result<()> {
    state
        .store
        .put(NS, &queue_key(library), &serde_json::to_vec(queue).expect("receipt queue serializes"))
        .await
}

/// Called while `assistant_lock` is held by library retirement: no callback can race the queue removal.
pub async fn delete_library_locked(state: &AppState, library: &str) -> std::io::Result<()> {
    state.store.delete(NS, &queue_key(library)).await?;
    let mut callbacks = load_callbacks(state, state.now()).await?;
    callbacks.entries.retain(|entry| entry.library != library);
    save_callbacks(state, &callbacks).await?;
    state.assistant_holds.wake(&format!("playback:{library}"));
    Ok(())
}

async fn member_library(state: &AppState, headers: &HeaderMap) -> Result<String, Box<Response>> {
    let claim = headers.get(crate::library::MEMBER_HEADER).and_then(|value| value.to_str().ok());
    if !crate::library::is_household_member(state, claim).await {
        return Err(Box::new(json_reply(StatusCode::FORBIDDEN, &error("not_a_member"))));
    }
    Ok(claim.and_then(|claim| claim.split_once(':')).map(|(id, _)| id.to_owned()).unwrap())
}

/// Bind a callback to one authenticated playback. Absence of a published drop-box simply leaves this playback on
/// the existing client-save path; storage trouble is returned so the caller can log it without failing playback.
pub async fn authorize(
    state: &AppState,
    library: &str,
    request: &str,
) -> std::io::Result<Option<PlaybackContext>> {
    let _write = state.assistant_lock.lock().await;
    // Serialize the key lookup with drop-box replacement and library retirement. Reading it before this lock
    // could resurrect a callback for a library that retired between the read and the callback-table write.
    let Some(dropbox) = crate::assistant::published_dropbox(state, library).await? else { return Ok(None) };
    let mut callbacks = load_callbacks(state, state.now()).await?;
    let request = request_id(request);
    if let Some(record) =
        callbacks.entries.iter().find(|entry| entry.library == library && entry.request == request)
    {
        return Ok(Some(PlaybackContext {
            library: record.library.clone(),
            kid: record.kid.clone(),
            public: record.public.clone(),
            id: record.id.clone(),
            token: record.token.clone(),
        }));
    }
    let token = den_assistant::b64url(&crate::random_bytes::<32>());
    let id = crate::hex(&crate::random_bytes::<16>());
    let hash = callback_id(&token);
    let record = Callback {
        hash,
        token: token.clone(),
        request,
        library: library.to_owned(),
        kid: dropbox.kid.clone(),
        public: dropbox.pk.clone(),
        id: id.clone(),
        expires_at: state.now().saturating_add(TTL_MS),
    };
    if callbacks.entries.len() >= MAX_CALLBACKS {
        return Ok(None);
    }
    callbacks.entries.push(record);
    save_callbacks(state, &callbacks).await?;
    Ok(Some(PlaybackContext { library: library.to_owned(), kid: dropbox.kid, public: dropbox.pk, id, token }))
}

pub fn is_path(path: &str) -> bool {
    path.starts_with("/playback/receipts/")
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    match (req.method().clone(), req.uri().path()) {
        (Method::POST, "/playback/receipts/callback") => callback(state, req).await,
        (Method::POST, "/playback/receipts/drain") => drain(state, req).await,
        (Method::POST, "/playback/receipts/ack") => ack(state, req).await,
        (_, "/playback/receipts/callback" | "/playback/receipts/drain" | "/playback/receipts/ack") => {
            crate::handler::method_not_allowed()
        }
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

async fn callback(state: &AppState, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(wait) =
        crate::link::throttled_per_minute(state, &format!("playback-receipt:{ip}"), CALLBACKS_PER_MINUTE)
    {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| value.len() == 43)
        .map(str::to_owned);
    let Some(token) = token else {
        return json_reply(StatusCode::UNAUTHORIZED, &error("invalid_callback"));
    };
    let callback_id = callback_id(&token);
    if let Some(wait) = crate::link::throttled_per_minute(
        state,
        &format!("playback-receipt-capability:{callback_id}"),
        CALLBACK_ATTEMPTS_PER_MINUTE,
    ) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let body = match read_json(req, BODY_BYTES).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let Some(sealed) = body
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("sealed"))
        .and_then(Value::as_str)
        .filter(|value| valid_sealed(value))
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_sealed"));
    };
    let _write = state.assistant_lock.lock().await;
    let now = state.now();
    let callbacks = match load_callbacks(state, now).await {
        Ok(callbacks) => callbacks,
        Err(error) => return internal("playback receipt callback read", error),
    };
    let Some(record) = callbacks.entries.iter().find(|entry| entry.hash == callback_id).cloned() else {
        return json_reply(StatusCode::UNAUTHORIZED, &error("invalid_callback"));
    };
    let mut queue = match load_queue(state, &record.library, now).await {
        Ok(queue) => queue,
        Err(error) => return internal("playback receipt queue read", error),
    };
    if let Some(existing) = queue.messages.iter().find(|entry| entry.callback == callback_id) {
        return if existing.sealed == sealed {
            json_reply(StatusCode::OK, &json!({"seq": existing.seq, "queued": queue.messages.len()}))
        } else {
            json_reply(StatusCode::CONFLICT, &error("callback_conflict"))
        };
    }
    if queue.messages.len() >= MAX_QUEUED {
        return json_reply(StatusCode::CONFLICT, &error("queue_full"));
    }
    let seq = queue.next;
    queue.next += 1;
    queue.messages.push(Entry { seq, sealed: sealed.to_owned(), callback: callback_id, received_at: now });
    if let Err(error) = save_queue(state, &record.library, &queue).await {
        return internal("playback receipt queue write", error);
    }
    state.assistant_holds.wake(&format!("playback:{}", record.library));
    json_reply(StatusCode::OK, &json!({"seq": seq, "queued": queue.messages.len()}))
}

async fn drain(state: &AppState, req: Request) -> Response {
    let library = match member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(response) => return *response,
    };
    let ip = crate::handler::client_ip(state, &req);
    let wait = crate::hold::wait(crate::handler::query_param(&req, "wait"));
    let admission = req.extensions().get::<crate::handler::AdmissionSlot>().cloned();
    let held_on = format!("playback:{library}");
    let mut hold = wait.and_then(|wait| Some((state.assistant_holds.hold(&ip, &[&held_on])?, wait)));
    loop {
        let messages = match load_queue(state, &library, state.now()).await {
            Ok(queue) => queue.messages,
            Err(error) => return internal("playback receipt queue read", error),
        };
        if let Some((held, wait)) = hold.take() {
            if messages.is_empty() {
                if !crate::handler::AdmissionSlot::wait_out(admission.as_ref(), state, held.wait(wait)).await
                {
                    return crate::handler::busy();
                }
                continue;
            }
        }
        return json_reply(
            StatusCode::OK,
            &json!({"messages": messages.into_iter().map(|entry| json!({"seq": entry.seq, "sealed": entry.sealed})).collect::<Vec<_>>() }),
        );
    }
}

async fn ack(state: &AppState, req: Request) -> Response {
    let library = match member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(response) => return *response,
    };
    let body = match read_json(req, BODY_BYTES).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let Some(up_to) = body
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("upTo"))
        .and_then(Value::as_u64)
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_seq"));
    };
    let _write = state.assistant_lock.lock().await;
    let mut queue = match load_queue(state, &library, state.now()).await {
        Ok(queue) => queue,
        Err(error) => return internal("playback receipt queue read", error),
    };
    queue.messages.retain(|entry| entry.seq > up_to);
    if let Err(error) = save_queue(state, &library, &queue).await {
        return internal("playback receipt queue write", error);
    }
    json_reply(StatusCode::OK, &json!({"queued": queue.messages.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, Harness};
    use crate::oauth::tests::{member, seed, write_harness, LIB};
    use axum::http::StatusCode;

    async fn request(
        harness: &Harness,
        method: &str,
        path: &str,
        body: Value,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut headers = headers.to_vec();
        headers.push(("content-type", "application/json"));
        let response = harness.send(method, path, Some(body.to_string()), &headers).await;
        let status = response.status();
        (status, body_json(response).await)
    }

    async fn setup() -> (Harness, PlaybackContext) {
        let harness = write_harness().await;
        let secret = seed("dropbox");
        let public = den_assistant::kem_public(&secret);
        let claim = member();
        let response = harness
            .send(
                "PUT",
                "/assistant/dropbox",
                Some(json!({"pk": den_assistant::b64url(&public)}).to_string()),
                &[("content-type", "application/json"), (crate::library::MEMBER_HEADER, &claim)],
            )
            .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let context = authorize(&harness.state, LIB, "test-playback").await.unwrap().unwrap();
        (harness, context)
    }

    #[tokio::test]
    async fn authorization_reuses_one_request_without_reusing_another() {
        let (harness, first) = setup().await;
        let retry = authorize(&harness.state, LIB, "test-playback").await.unwrap().unwrap();
        let other = authorize(&harness.state, LIB, "another-playback").await.unwrap().unwrap();
        assert_eq!(retry.id, first.id);
        assert_eq!(retry.token, first.token);
        assert_ne!(other.id, first.id);
        assert_ne!(other.token, first.token);

        let callbacks = load_callbacks(&harness.state, harness.state.now()).await.unwrap();
        assert_eq!(callbacks.entries.len(), 2);
        assert!(callbacks.entries.iter().all(|entry| entry.request.len() == 64));
        assert!(callbacks.entries.iter().all(|entry| entry.request != "test-playback"));
    }

    fn sealed(context: &PlaybackContext, label: u8, now: u64) -> String {
        let public = den_assistant::b64url_decode(&context.public).unwrap();
        let title = json!({"type": "movie", "id": 550});
        den_assistant::seal_playback_receipt(
            &public,
            &den_assistant::PlaybackReceipt {
                library: &context.library,
                kid: &context.kid,
                id: &context.id,
                title: &title,
                season: None,
                episode: None,
                position_seconds: 5_000,
                duration_seconds: 6_000,
                completed: false,
                ended_at: now,
                expires_at: now + 86_400_000,
            },
            &[label; den_assistant::ESEED_LEN],
        )
        .unwrap()
    }

    #[tokio::test]
    async fn callback_retries_are_idempotent_and_members_drain_then_ack() {
        let (harness, context) = setup().await;
        let sealed = sealed(&context, 7, harness.state.now());
        let bearer = format!("Bearer {}", context.token);
        let first = request(
            &harness,
            "POST",
            "/playback/receipts/callback",
            json!({"sealed": sealed}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(first.0, StatusCode::OK);
        assert_eq!(first.1["seq"], 1);
        let retry = request(
            &harness,
            "POST",
            "/playback/receipts/callback",
            json!({"sealed": sealed}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(retry.1["seq"], 1, "the retry reuses its queue entry");

        let claim = member();
        let (_, drained) = request(
            &harness,
            "POST",
            "/playback/receipts/drain",
            json!({}),
            &[(crate::library::MEMBER_HEADER, &claim)],
        )
        .await;
        assert_eq!(drained["messages"].as_array().unwrap().len(), 1);
        assert_eq!(drained["messages"][0]["sealed"], sealed);

        let (_, acked) = request(
            &harness,
            "POST",
            "/playback/receipts/ack",
            json!({"upTo": 1}),
            &[(crate::library::MEMBER_HEADER, &claim)],
        )
        .await;
        assert_eq!(acked, json!({"queued": 0}));
    }

    #[tokio::test]
    async fn a_callback_is_bound_to_one_ciphertext_and_member_routes_require_membership() {
        let (harness, context) = setup().await;
        let bearer = format!("Bearer {}", context.token);
        let now = harness.state.now();
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": sealed(&context, 1, now)}),
                &[("authorization", &bearer)],
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": sealed(&context, 2, now)}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::CONFLICT, json!({"error": "callback_conflict"}))
        );
        assert_eq!(
            request(&harness, "POST", "/playback/receipts/drain", json!({}), &[]).await.0,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn retiring_a_library_removes_its_queue_and_callback_capabilities() {
        let (harness, context) = setup().await;
        let bearer = format!("Bearer {}", context.token);
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": sealed(&context, 1, harness.state.now())}),
                &[("authorization", &bearer)],
            )
            .await
            .0,
            StatusCode::OK
        );

        crate::assistant::delete_library(&harness.state, LIB).await.unwrap();
        assert!(load_queue(&harness.state, LIB, harness.state.now()).await.unwrap().messages.is_empty());
        assert!(load_callbacks(&harness.state, harness.state.now()).await.unwrap().entries.is_empty());
    }
}
