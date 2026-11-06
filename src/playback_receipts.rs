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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted: Option<Accepted>,
    /// Missing on capabilities issued before accepted bindings existed. Such a capability can recover from a
    /// still-queued entry, but must fail closed once that entry is gone because its first ciphertext is unknowable.
    #[serde(default, rename = "bindingVersion", skip_serializing_if = "is_zero")]
    binding_version: u8,
}

/// The queue entry is the first durable binding. This copy survives acknowledgement, so the capability remains
/// idempotent for its whole lifetime. `sealed` is a digest rather than the ciphertext: Edge still retains only one
/// copy of a waiting ciphertext, and SHA-256 binds its exact wire representation.
#[derive(Clone, Serialize, Deserialize)]
struct Accepted {
    #[serde(rename = "sealedHash")]
    sealed: String,
    seq: u64,
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

fn sealed_id(sealed: &str) -> String {
    crate::hex(&Sha256::digest(sealed.as_bytes()))
}

fn is_zero(value: &u8) -> bool {
    *value == 0
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
    let mut callbacks = load_callbacks(state, state.now()).await?;
    callbacks.entries.retain(|entry| entry.library != library);
    save_callbacks(state, &callbacks).await?;
    // Retire the capabilities durably before their queue. A crash can leave an unreachable orphaned queue, but
    // never a live unbound capability after its binding was removed with the queue.
    state.store.sync_dir(NS).await?;
    state.store.delete(NS, &queue_key(library)).await?;
    state.store.sync_dir(NS).await?;
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
        accepted: None,
        binding_version: 1,
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
    let mut callbacks = match load_callbacks(state, now).await {
        Ok(callbacks) => callbacks,
        Err(error) => return internal("playback receipt callback read", error),
    };
    let Some(record_index) = callbacks.entries.iter().position(|entry| entry.hash == callback_id) else {
        return json_reply(StatusCode::UNAUTHORIZED, &error("invalid_callback"));
    };
    let library = callbacks.entries[record_index].library.clone();
    let mut queue = match load_queue(state, &library, now).await {
        Ok(queue) => queue,
        Err(error) => return internal("playback receipt queue read", error),
    };
    let sealed_id = sealed_id(sealed);
    if let Some(accepted) = &callbacks.entries[record_index].accepted {
        if accepted.sealed != sealed_id {
            return json_reply(StatusCode::CONFLICT, &error("callback_conflict"));
        }
        if let Some(existing) = queue.messages.iter().find(|entry| entry.callback == callback_id) {
            if existing.seq != accepted.seq || existing.sealed != sealed {
                return internal(
                    "playback receipt binding read",
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "callback binding disagrees with queue",
                    ),
                );
            }
        }
        // Absence means the accepted entry was acknowledged (or aged out). It must not recreate delivery work.
        return json_reply(StatusCode::OK, &json!({"seq": accepted.seq, "queued": queue.messages.len()}));
    }
    if let Some(existing) = queue.messages.iter().find(|entry| entry.callback == callback_id) {
        if existing.sealed != sealed {
            return json_reply(StatusCode::CONFLICT, &error("callback_conflict"));
        }
        // Recover an interruption after queue insertion. Until this write is durable the queue entry remains the
        // authoritative binding, and acknowledgement performs the same transfer before deleting it.
        callbacks.entries[record_index].accepted = Some(Accepted { sealed: sealed_id, seq: existing.seq });
        callbacks.entries[record_index].binding_version = 1;
        if let Err(error) = save_callbacks(state, &callbacks).await {
            return internal("playback receipt callback binding write", error);
        }
        if let Err(error) = state.store.sync_dir(NS).await {
            return internal("playback receipt callback binding sync", error);
        }
        return json_reply(StatusCode::OK, &json!({"seq": existing.seq, "queued": queue.messages.len()}));
    }
    if callbacks.entries[record_index].binding_version != 1 {
        // An old unbound record may be genuinely unused or may have lost its binding through acknowledgement.
        // Refusing both cases is the only safe migration: accepting would let a changed ciphertext claim it.
        return json_reply(StatusCode::UNAUTHORIZED, &error("invalid_callback"));
    }
    if queue.messages.len() >= MAX_QUEUED {
        return json_reply(StatusCode::CONFLICT, &error("queue_full"));
    }
    let seq = queue.next;
    queue.next += 1;
    queue.messages.push(Entry { seq, sealed: sealed.to_owned(), callback: callback_id, received_at: now });
    if let Err(error) = save_queue(state, &library, &queue).await {
        return internal("playback receipt queue write", error);
    }
    if let Err(error) = state.store.sync_dir(NS).await {
        return internal("playback receipt queue sync", error);
    }
    // The queue is already a durable binding if the second write fails. Ack transfers it before deletion.
    callbacks.entries[record_index].accepted = Some(Accepted { sealed: sealed_id, seq });
    if let Err(error) = save_callbacks(state, &callbacks).await {
        state.assistant_holds.wake(&format!("playback:{library}"));
        return internal("playback receipt callback binding write", error);
    }
    if let Err(error) = state.store.sync_dir(NS).await {
        state.assistant_holds.wake(&format!("playback:{library}"));
        return internal("playback receipt callback binding sync", error);
    }
    state.assistant_holds.wake(&format!("playback:{library}"));
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
    let removed: Vec<_> = queue.messages.iter().filter(|entry| entry.seq <= up_to).collect();
    if !removed.is_empty() {
        let mut callbacks = match load_callbacks(state, state.now()).await {
            Ok(callbacks) => callbacks,
            Err(error) => return internal("playback receipt ack binding read", error),
        };
        let mut changed = false;
        for entry in &removed {
            let Some(callback) =
                callbacks.entries.iter_mut().find(|callback| callback.hash == entry.callback)
            else {
                continue;
            };
            let accepted = Accepted { sealed: sealed_id(&entry.sealed), seq: entry.seq };
            if let Some(existing) = &callback.accepted {
                if existing.sealed != accepted.sealed || existing.seq != accepted.seq {
                    return internal(
                        "playback receipt ack binding read",
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "callback binding disagrees with acknowledged queue entry",
                        ),
                    );
                }
            } else {
                callback.accepted = Some(accepted);
                changed = true;
            }
            if callback.binding_version != 1 {
                callback.binding_version = 1;
                changed = true;
            }
        }
        if changed {
            if let Err(error) = save_callbacks(state, &callbacks).await {
                return internal("playback receipt ack binding write", error);
            }
            // This ordering is the transaction boundary: after it completes, either the queue entry or the
            // callback record (usually both) remains durable across a crash.
            if let Err(error) = state.store.sync_dir(NS).await {
                return internal("playback receipt ack binding sync", error);
            }
        }
    }
    queue.messages.retain(|entry| entry.seq > up_to);
    if let Err(error) = save_queue(state, &library, &queue).await {
        return internal("playback receipt queue write", error);
    }
    if let Err(error) = state.store.sync_dir(NS).await {
        return internal("playback receipt queue sync", error);
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
        assert!(callbacks.entries.iter().all(|entry| entry.binding_version == 1));
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
        let first_sealed = sealed(&context, 7, harness.state.now());
        let bearer = format!("Bearer {}", context.token);
        let first = request(
            &harness,
            "POST",
            "/playback/receipts/callback",
            json!({"sealed": first_sealed}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(first.0, StatusCode::OK);
        assert_eq!(first.1["seq"], 1);
        let retry = request(
            &harness,
            "POST",
            "/playback/receipts/callback",
            json!({"sealed": first_sealed}),
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
        assert_eq!(drained["messages"][0]["sealed"], first_sealed);

        let (_, acked) = request(
            &harness,
            "POST",
            "/playback/receipts/ack",
            json!({"upTo": 1}),
            &[(crate::library::MEMBER_HEADER, &claim)],
        )
        .await;
        assert_eq!(acked, json!({"queued": 0}));

        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::OK, json!({"seq": 1, "queued": 0})),
            "an acknowledged retry keeps its original result without recreating delivery"
        );
        assert!(load_queue(&harness.state, LIB, harness.state.now()).await.unwrap().messages.is_empty());
        let changed_sealed = sealed(&context, 8, harness.state.now());
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": changed_sealed}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::CONFLICT, json!({"error": "callback_conflict"}))
        );

        let dir = harness.dir.clone();
        drop(harness);
        let restarted = Harness::in_dir(dir);
        assert_eq!(
            request(
                &restarted,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::OK, json!({"seq": 1, "queued": 0}))
        );
        assert_eq!(
            request(
                &restarted,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": changed_sealed}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::CONFLICT, json!({"error": "callback_conflict"}))
        );
    }

    #[tokio::test]
    async fn concurrent_first_callbacks_choose_one_ciphertext_and_one_delivery() {
        let (harness, context) = setup().await;
        let bearer = format!("Bearer {}", context.token);
        let now = harness.state.now();
        let first_sealed = sealed(&context, 1, now);
        let second_sealed = sealed(&context, 2, now);
        let headers = [("authorization", bearer.as_str())];
        let (first, second) = tokio::join!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &headers,
            ),
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": second_sealed}),
                &headers,
            )
        );
        assert_eq!((first.0 == StatusCode::OK) as usize + (second.0 == StatusCode::OK) as usize, 1);
        assert_eq!(
            (first.0 == StatusCode::CONFLICT) as usize + (second.0 == StatusCode::CONFLICT) as usize,
            1
        );
        let queue = load_queue(&harness.state, LIB, now).await.unwrap();
        assert_eq!(queue.messages.len(), 1);
        assert_eq!(queue.messages[0].seq, 1);
    }

    #[tokio::test]
    async fn ack_recovers_a_queue_binding_left_by_an_interrupted_first_callback() {
        let (harness, context) = setup().await;
        let first_sealed = sealed(&context, 3, harness.state.now());
        let callback = callback_id(&context.token);
        let mut queue = load_queue(&harness.state, LIB, harness.state.now()).await.unwrap();
        queue.next = 2;
        queue.messages.push(Entry {
            seq: 1,
            sealed: first_sealed.clone(),
            callback,
            received_at: harness.state.now(),
        });
        save_queue(&harness.state, LIB, &queue).await.unwrap();
        harness.state.store.sync_dir(NS).await.unwrap();
        assert!(load_callbacks(&harness.state, harness.state.now()).await.unwrap().entries[0]
            .accepted
            .is_none());

        let dir = harness.dir.clone();
        drop(harness);
        let restarted = Harness::in_dir(dir);
        let claim = member();
        assert_eq!(
            request(
                &restarted,
                "POST",
                "/playback/receipts/ack",
                json!({"upTo": 1}),
                &[(crate::library::MEMBER_HEADER, &claim)],
            )
            .await,
            (StatusCode::OK, json!({"queued": 0}))
        );
        let bound = load_callbacks(&restarted.state, restarted.state.now()).await.unwrap();
        assert_eq!(bound.entries[0].accepted.as_ref().unwrap().seq, 1);

        let dir = restarted.dir.clone();
        drop(restarted);
        let restarted = Harness::in_dir(dir);
        let bearer = format!("Bearer {}", context.token);
        assert_eq!(
            request(
                &restarted,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::OK, json!({"seq": 1, "queued": 0}))
        );
        assert_eq!(
            request(
                &restarted,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": sealed(&context, 4, restarted.state.now())}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::CONFLICT, json!({"error": "callback_conflict"}))
        );
    }

    #[tokio::test]
    async fn an_expired_callback_cannot_retry_its_accepted_ciphertext() {
        let (harness, context) = setup().await;
        let first_sealed = sealed(&context, 1, harness.state.now());
        let bearer = format!("Bearer {}", context.token);
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &[("authorization", &bearer)],
            )
            .await
            .0,
            StatusCode::OK
        );
        harness.advance(TTL_MS);
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::UNAUTHORIZED, json!({"error": "invalid_callback"}))
        );
    }

    #[tokio::test]
    async fn an_old_unbound_callback_fails_closed_when_its_queue_binding_is_gone() {
        let (harness, context) = setup().await;
        let mut callbacks = load_callbacks(&harness.state, harness.state.now()).await.unwrap();
        callbacks.entries[0].binding_version = 0;
        save_callbacks(&harness.state, &callbacks).await.unwrap();
        harness.state.store.sync_dir(NS).await.unwrap();

        let bearer = format!("Bearer {}", context.token);
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": sealed(&context, 1, harness.state.now())}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::UNAUTHORIZED, json!({"error": "invalid_callback"}))
        );
        assert!(load_queue(&harness.state, LIB, harness.state.now()).await.unwrap().messages.is_empty());
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
        let first_sealed = sealed(&context, 1, harness.state.now());
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &[("authorization", &bearer)],
            )
            .await
            .0,
            StatusCode::OK
        );

        crate::assistant::delete_library(&harness.state, LIB).await.unwrap();
        assert!(load_queue(&harness.state, LIB, harness.state.now()).await.unwrap().messages.is_empty());
        assert!(load_callbacks(&harness.state, harness.state.now()).await.unwrap().entries.is_empty());
        assert_eq!(
            request(
                &harness,
                "POST",
                "/playback/receipts/callback",
                json!({"sealed": first_sealed}),
                &[("authorization", &bearer)],
            )
            .await,
            (StatusCode::UNAUTHORIZED, json!({"error": "invalid_callback"}))
        );
    }
}
