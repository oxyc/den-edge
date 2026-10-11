//! `/assistant/…` — assistant writes' drop-box and queue (den-spec `wire/assistant-v1.md` §9). den-mcp seals a request
//! to a library's drop-box public key and appends it under the assistant's access token; a device of the library
//! drains the queue, opens and checks each request, applies it and acknowledges it. den-edge holds the public key and
//! opaque sealed bytes: it can open nothing here, and learns only when an assistant writes and how much.
//!
//!   PUT  /assistant/dropbox         member   the library's drop-box public key
//!   GET  /assistant/dropbox         bearer   den-mcp asks for it
//!   POST /assistant/append          bearer   den-mcp queues a sealed request
//!   POST /assistant/drain[?wait=S]  member   every waiting request, oldest first, none removed
//!   POST /assistant/ack             member   remove those up to a `seq`
//!
//! And reads (§15): devices publish each read grant's projection, sealed under a read key den-edge holds only wrapped
//! under a refresh secret it does not keep, and den-mcp fetches it with the session's token.
//!
//!   PUT    /assistant/projection/{grant}  member   replace a grant's projection, all its parts at once
//!   DELETE /assistant/projection/{grant}  member   drop it
//!   GET    /assistant/projection          bearer   the session's grant's projection, every part of one publish
//!
//! Log lines name the route and status only (`handler.rs`); nothing here logs a body, a key or a token.

use crate::handler::{error, internal, json_reply, read_json, retry_after};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const NS: &str = "assistant";
/// A queue holds at most this many requests, and each for at most a week: an older one is `stale` to every device.
const MAX_QUEUED: usize = 200;
const TTL_MS: u64 = 7 * 86_400_000;
/// The longest sealed request taken, in characters, and the fewest bytes one decodes to: `enc`, a signature, one
/// byte of message and a tag.
const MAX_SEALED: usize = den_assistant::MAX_SEALED;
const MIN_SEALED_BYTES: usize = den_assistant::ENC_LEN + den_assistant::SIG_LEN + 1 + 16;
/// Body caps: a public key in JSON, and a sealed request in JSON.
pub const DROPBOX_BODY_BYTES: usize = 4 * 1024;
pub const APPEND_BODY_BYTES: usize = 8 * 1024;
/// Budgets: drop-box keys put per library a minute; appends per session a minute and per library a day.
const DROPBOX_PER_MINUTE: u32 = 10;
const APPENDS_PER_MINUTE: u32 = 30;
const APPENDS_PER_DAY: u32 = 300;
const DAY_MS: u64 = 86_400_000;
/// Held drains per address (as inbox v1 §3), and in all.
pub const MAX_HELD_PER_ADDRESS: usize = 2;
pub const MAX_HELD: usize = 16;
/// A projection (§15): one publish's set id and at most `MAX_PARTS` sealed parts of at most `MAX_PART` characters,
/// 16 MiB in all, each longer than a nonce and a tag. Stored whole, so a reader never sees parts of two publishes.
const MAX_PROJECTION_CHARS: usize = den_assistant::MAX_PART * den_assistant::MAX_PARTS;
const PART_OVERHEAD_BYTES: usize = 12 + 16;
/// The body cap of a projection's PUT: 17 MiB, its parts and set id in JSON.
pub const PROJECTION_BODY_BYTES: usize = 17 * 1024 * 1024;
/// Publishes per grant an hour.
const PROJECTIONS_PER_HOUR: u32 = 60;
const HOUR_MS: u64 = 3_600_000;

#[derive(Serialize, Deserialize)]
struct Projection {
    library: String,
    set: String,
    parts: Vec<String>,
    #[serde(rename = "storedAt")]
    stored_at: u64,
}

fn projection_key(grant: &str) -> String {
    format!("p:{grant}")
}

#[derive(Serialize, Deserialize, Default)]
struct Queue {
    /// The next `seq`: never reused for this library, whatever was acknowledged.
    next: u64,
    messages: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    seq: u64,
    sealed: String,
    #[serde(rename = "receivedAt")]
    received_at: u64,
}

#[derive(Serialize, Deserialize)]
struct Dropbox {
    pk: String,
    kid: String,
}

fn queue_key(library: &str) -> String {
    format!("q:{library}")
}

fn dropbox_key(library: &str) -> String {
    format!("d:{library}")
}

pub fn is_path(path: &str) -> bool {
    path.starts_with("/assistant/")
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    match (req.method().clone(), req.uri().path()) {
        (Method::PUT, "/assistant/dropbox") => put_dropbox(state, req).await,
        (Method::GET | Method::HEAD, "/assistant/dropbox") => get_dropbox(state, req).await,
        (Method::POST, "/assistant/append") => append(state, req).await,
        (Method::POST, "/assistant/drain") => drain(state, req).await,
        (Method::POST, "/assistant/ack") => ack(state, req).await,
        (Method::GET | Method::HEAD, "/assistant/projection") => get_projection(state, req).await,
        (_, "/assistant/dropbox" | "/assistant/append" | "/assistant/drain" | "/assistant/ack")
        | (_, "/assistant/projection") => crate::handler::method_not_allowed(),
        (method, path) => match path.strip_prefix("/assistant/projection/") {
            Some(grant)
                if grant.len() == 32 && grant.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
            {
                let grant = grant.to_owned();
                match method {
                    Method::PUT => put_projection(state, req, &grant).await,
                    Method::DELETE => drop_projection(state, req, &grant).await,
                    _ => crate::handler::method_not_allowed(),
                }
            }
            _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        },
    }
}

/// Every part unpadded base64url of more than a nonce and a tag and at most `MAX_PART` characters, at most
/// `MAX_PARTS` of them and `MAX_PROJECTION_CHARS` in all.
fn valid_parts(parts: &[String]) -> bool {
    !parts.is_empty()
        && parts.len() <= den_assistant::MAX_PARTS
        && parts.iter().map(String::len).sum::<usize>() <= MAX_PROJECTION_CHARS
        && parts.iter().all(|part| {
            part.len() <= den_assistant::MAX_PART
                && den_assistant::b64url_decode(part).is_some_and(|bytes| bytes.len() > PART_OVERHEAD_BYTES)
        })
}

/// A set id: 32 lowercase hex.
fn valid_set(set: &str) -> bool {
    set.len() == 32 && set.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

async fn put_projection(state: &AppState, req: Request, grant: &str) -> Response {
    let library = match member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    let bucket = format!("assistant-projection:{grant}");
    if let Some(refused) =
        limited(crate::link::throttled_per_window(state, &bucket, PROJECTIONS_PER_HOUR, 1, HOUR_MS))
    {
        return refused;
    }
    let body = match read_json(req, PROJECTION_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some(set) = body.get("set").and_then(Value::as_str).filter(|set| valid_set(set)).map(str::to_owned)
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_set"));
    };
    let Some(parts) = body
        .get("parts")
        .and_then(Value::as_array)
        .and_then(|parts| parts.iter().map(|p| p.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>())
        .filter(|parts| valid_parts(parts))
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_sealed"));
    };
    // Checked under the lock a session's end deletes the projection under, so a publish racing it is refused or
    // deleted after it, never left behind.
    let _write = state.assistant_lock.lock().await;
    match crate::oauth::reads_grant(state, &library, grant).await {
        Ok(true) => {}
        Ok(false) => return json_reply(StatusCode::NOT_FOUND, &error("unknown_grant")),
        Err(e) => return internal("assistant projection grant", e),
    }
    let record = Projection { library, set, parts, stored_at: state.now() };
    let bytes = serde_json::to_vec(&record).expect("a projection always serialises");
    if let Err(e) = state.store.put(NS, &projection_key(grant), &bytes).await {
        return internal("assistant projection write", e);
    }
    no_content()
}

async fn drop_projection(state: &AppState, req: Request, grant: &str) -> Response {
    let library = match member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    let _write = state.assistant_lock.lock().await;
    // Only the member's own library's: another library's grant is left as it is, and answered the same.
    match load_projection(state, grant).await {
        Ok(Some(held)) if held.library == library => {
            if let Err(e) = state.store.delete(NS, &projection_key(grant)).await {
                return internal("assistant projection delete", e);
            }
        }
        Ok(_) => {}
        Err(e) => return internal("assistant projection read", e),
    }
    no_content()
}

async fn get_projection(state: &AppState, req: Request) -> Response {
    let session = match crate::oauth::read_session(state, req.headers()).await {
        Ok(session) => session,
        Err(refused) => return *refused,
    };
    match load_projection(state, &session.grant).await {
        Ok(Some(held)) if held.library == session.library => json_reply(
            StatusCode::OK,
            &json!({
                "library": held.library,
                "grant": session.grant,
                "set": held.set,
                "parts": held.parts,
                "storedAt": held.stored_at,
            }),
        ),
        Ok(_) => json_reply(StatusCode::NOT_FOUND, &error("no_projection")),
        Err(e) => internal("assistant projection read", e),
    }
}

async fn load_projection(state: &AppState, grant: &str) -> std::io::Result<Option<Projection>> {
    match state.store.get(NS, &projection_key(grant)).await? {
        Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(std::io::Error::other),
        None => Ok(None),
    }
}

/// Drop a grant's projection: its last read session ended (`oauth.rs`).
pub async fn delete_projection(state: &AppState, grant: &str) -> std::io::Result<()> {
    let _write = state.assistant_lock.lock().await;
    state.store.delete(NS, &projection_key(grant)).await
}

/// The library a member route's `x-den-library-member` proves, or `403 not_a_member`.
async fn member_library(state: &AppState, headers: &HeaderMap) -> Result<String, Box<Response>> {
    let claim = headers.get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok());
    if !crate::library::is_member(state, claim).await {
        return Err(Box::new(json_reply(StatusCode::FORBIDDEN, &error("not_a_member"))));
    }
    Ok(claim.and_then(|c| c.split_once(':')).map(|(id, _)| id.to_owned()).expect("a member claim has an id"))
}

fn limited(wait: Option<u64>) -> Option<Response> {
    wait.map(|wait| retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait))
}

async fn load_queue(state: &AppState, library: &str, now: u64) -> std::io::Result<Queue> {
    let mut queue: Queue = match state.store.get(NS, &queue_key(library)).await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
        None => Queue { next: 1, messages: Vec::new() },
    };
    queue.next = queue.next.max(1);
    queue.messages.retain(|m| m.received_at.saturating_add(TTL_MS) > now);
    Ok(queue)
}

async fn save_queue(state: &AppState, library: &str, queue: &Queue) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(queue).expect("a queue always serialises");
    state.store.put(NS, &queue_key(library), &bytes).await
}

async fn put_dropbox(state: &AppState, req: Request) -> Response {
    let library = match member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    let bucket = format!("assistant-dropbox:{library}");
    if let Some(refused) = limited(crate::link::throttled_per_minute(state, &bucket, DROPBOX_PER_MINUTE)) {
        return refused;
    }
    let body = match read_json(req, DROPBOX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some((pk, public)) = body
        .get("pk")
        .and_then(Value::as_str)
        .and_then(|pk| Some((pk, den_assistant::b64url_decode(pk)?)))
        .filter(|(_, public)| public.len() == den_assistant::KEM_PUBLIC_LEN)
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_public_key"));
    };
    let record = Dropbox { pk: pk.to_owned(), kid: den_assistant::key_id(&public) };
    let _write = state.assistant_lock.lock().await;
    let bytes = serde_json::to_vec(&record).expect("a key record always serialises");
    if let Err(e) = state.store.put(NS, &dropbox_key(&library), &bytes).await {
        return internal("assistant dropbox write", e);
    }
    no_content()
}

async fn get_dropbox(state: &AppState, req: Request) -> Response {
    let session = match crate::oauth::write_session(state, req.headers()).await {
        Ok(session) => session,
        Err(refused) => return *refused,
    };
    match state.store.get(NS, &dropbox_key(&session.library)).await {
        Ok(Some(bytes)) => match serde_json::from_slice::<Dropbox>(&bytes) {
            Ok(d) => {
                json_reply(StatusCode::OK, &json!({ "library": session.library, "pk": d.pk, "kid": d.kid }))
            }
            Err(e) => internal("assistant dropbox read", std::io::Error::other(e)),
        },
        Ok(None) => json_reply(StatusCode::NOT_FOUND, &error("no_dropbox")),
        Err(e) => internal("assistant dropbox read", e),
    }
}

/// Unpadded base64url of at most `MAX_SEALED` characters, decoding to at least `MIN_SEALED_BYTES`.
fn valid_sealed(sealed: &str) -> bool {
    sealed.len() <= MAX_SEALED
        && den_assistant::b64url_decode(sealed).is_some_and(|bytes| bytes.len() >= MIN_SEALED_BYTES)
}

async fn append(state: &AppState, req: Request) -> Response {
    let session = match crate::oauth::write_session(state, req.headers()).await {
        Ok(session) => session,
        Err(refused) => return *refused,
    };
    // Counted before the body is read: an assistant sending a flood gets no work done for it.
    let per_minute = format!("assistant-append:{}", session.sid);
    if let Some(refused) = limited(crate::link::throttled_per_minute(state, &per_minute, APPENDS_PER_MINUTE))
    {
        return refused;
    }
    let per_day = format!("assistant-append-day:{}", session.library);
    if let Some(refused) =
        limited(crate::link::throttled_per_window(state, &per_day, APPENDS_PER_DAY, 1, DAY_MS))
    {
        return refused;
    }
    let body = match read_json(req, APPEND_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some(sealed) = body.get("sealed").and_then(Value::as_str).filter(|s| valid_sealed(s)) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_sealed"));
    };
    let _write = state.assistant_lock.lock().await;
    let now = state.now();
    let mut queue = match load_queue(state, &session.library, now).await {
        Ok(queue) => queue,
        Err(e) => return internal("assistant queue read", e),
    };
    // Full is full: the oldest waiting request is never dropped for a new one.
    if queue.messages.len() >= MAX_QUEUED {
        return json_reply(StatusCode::CONFLICT, &error("queue_full"));
    }
    let seq = queue.next;
    queue.next += 1;
    queue.messages.push(Entry { seq, sealed: sealed.to_owned(), received_at: now });
    if let Err(e) = save_queue(state, &session.library, &queue).await {
        return internal("assistant queue write", e);
    }
    state.assistant_holds.wake(&session.library);
    json_reply(StatusCode::OK, &json!({ "seq": seq, "queued": queue.messages.len() }))
}

/// Every waiting request, oldest first, without removing any: a device acknowledges what it handled (`ack`), so a
/// drain that is lost on the way delivers again, and the library's applied set dedupes. `?wait=S` holds an empty
/// drain until a request arrives or S (≤ 25) seconds pass, at most two per address, as the inbox's drains are held.
async fn drain(state: &AppState, req: Request) -> Response {
    let library = match member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    let ip = crate::handler::client_ip(state, &req);
    let wait = crate::hold::wait(crate::handler::query_param(&req, "wait"));
    let admission = req.extensions().get::<crate::handler::AdmissionSlot>().cloned();
    // Registered before the queue is read: a request appended after the read still wakes the wait.
    let mut hold = wait.and_then(|wait| Some((state.assistant_holds.hold(&ip, &[library.as_str()])?, wait)));
    loop {
        let messages = match load_queue(state, &library, state.now()).await {
            Ok(queue) => queue.messages,
            Err(e) => return internal("assistant queue read", e),
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
        let messages: Vec<Value> =
            messages.into_iter().map(|m| json!({ "seq": m.seq, "sealed": m.sealed })).collect();
        return json_reply(StatusCode::OK, &json!({ "messages": messages }));
    }
}

async fn ack(state: &AppState, req: Request) -> Response {
    let library = match member_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    let body = match read_json(req, DROPBOX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some(up_to) = body.get("upTo").and_then(Value::as_u64) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_seq"));
    };
    let _write = state.assistant_lock.lock().await;
    let mut queue = match load_queue(state, &library, state.now()).await {
        Ok(queue) => queue,
        Err(e) => return internal("assistant queue read", e),
    };
    let before = queue.messages.len();
    queue.messages.retain(|m| m.seq > up_to);
    let removed = before - queue.messages.len();
    if removed > 0 {
        if let Err(e) = save_queue(state, &library, &queue).await {
            return internal("assistant queue write", e);
        }
    }
    json_reply(StatusCode::OK, &json!({ "removed": removed }))
}

/// A library deleted or moved to a new key: its queue and drop-box key go with it. A new key's library starts its own.
pub async fn delete_library(state: &AppState, library: &str) -> std::io::Result<()> {
    let _write = state.assistant_lock.lock().await;
    state.store.delete(NS, &queue_key(library)).await?;
    state.store.delete(NS, &dropbox_key(library)).await?;
    state.assistant_holds.wake(library);
    Ok(())
}

fn no_content() -> Response {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    resp
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::{body_json, Harness};
    use crate::oauth::tests::{
        connect_member, connect_read, connect_write, member, seed, vectors, write_harness, LIB, TOKEN,
    };
    use axum::http::{header, StatusCode};
    use serde_json::{json, Value};

    /// The vectors' sealed request: what den-mcp appends.
    fn sealed() -> String {
        vectors()["fixed"]["request"]["sealed"].as_str().unwrap().to_owned()
    }

    fn public() -> String {
        den_assistant::b64url(&den_assistant::kem_public(&seed("dropbox")))
    }

    async fn send(
        h: &Harness,
        method: &str,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut headers = headers.to_vec();
        headers.push(("content-type", "application/json"));
        let resp = h.send(method, path, body.map(|b| b.to_string()), &headers).await;
        let status = resp.status();
        let text = crate::handler::tests::body_text(resp).await;
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn as_member(h: &Harness, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let claim = member();
        send(h, method, path, body, &[("x-den-library-member", &claim)]).await
    }

    async fn as_assistant(
        h: &Harness,
        access: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let bearer = format!("Bearer {access}");
        send(h, method, path, body, &[("authorization", &bearer)]).await
    }

    async fn write_access(h: &Harness) -> (Value, String) {
        let tokens = connect_write(h, &seed("grant")).await;
        let access = tokens["access_token"].as_str().unwrap().to_owned();
        (tokens, access)
    }

    #[tokio::test]
    async fn a_member_puts_the_dropbox_key_and_den_mcp_reads_it() {
        let h = write_harness().await;
        let (_, access) = write_access(&h).await;
        assert_eq!(
            as_assistant(&h, &access, "GET", "/assistant/dropbox", None).await,
            (StatusCode::NOT_FOUND, json!({ "error": "no_dropbox" }))
        );
        let (status, _) = send(&h, "PUT", "/assistant/dropbox", Some(json!({ "pk": public() })), &[]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "only a member");
        for bad in [json!({ "pk": "AAAA" }), json!({ "pk": format!("{}=", public()) }), json!({})] {
            assert_eq!(
                as_member(&h, "PUT", "/assistant/dropbox", Some(bad)).await,
                (StatusCode::BAD_REQUEST, json!({ "error": "invalid_public_key" }))
            );
        }
        assert_eq!(
            as_member(&h, "PUT", "/assistant/dropbox", Some(json!({ "pk": public() }))).await.0,
            StatusCode::NO_CONTENT
        );
        let kid = vectors()["fixed"]["keys"]["dropbox"]["kid"].clone();
        assert_eq!(
            as_assistant(&h, &access, "GET", "/assistant/dropbox", None).await,
            (StatusCode::OK, json!({ "library": LIB, "pk": public(), "kid": kid }))
        );
    }

    #[tokio::test]
    async fn the_bearer_routes_take_only_a_live_write_session() {
        let h = write_harness().await;
        let body = Some(json!({ "sealed": sealed() }));
        let resp = h
            .send(
                "POST",
                "/assistant/append",
                body.as_ref().map(Value::to_string),
                &[("content-type", "application/json")],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(resp.headers()[header::WWW_AUTHENTICATE].to_str().unwrap().contains("invalid_token"));
        assert_eq!(body_json(resp).await, json!({ "error": "invalid_token" }));
        // A search-only connection has no write scope.
        let plain = connect_member(&h).await;
        let search = plain["access_token"].as_str().unwrap();
        assert_eq!(
            as_assistant(&h, search, "POST", "/assistant/append", body.clone()).await,
            (StatusCode::FORBIDDEN, json!({ "error": "insufficient_scope" }))
        );
        // Disconnected from Settings: refused at the very next call, not when the token runs out.
        let (_, access) = write_access(&h).await;
        assert_eq!(
            as_assistant(&h, &access, "POST", "/assistant/append", body.clone()).await.0,
            StatusCode::OK
        );
        let claim = member();
        let (_, listed) =
            send(&h, "GET", "/oauth/connections", None, &[("x-den-library-member", &claim)]).await;
        let sid = listed["connections"].as_array().unwrap().iter().find(|c| !c["grant"].is_null()).unwrap()
            ["sid"]
            .as_str()
            .unwrap()
            .to_owned();
        let (status, _) = send(
            &h,
            "DELETE",
            &format!("/oauth/connections/{sid}"),
            None,
            &[("x-den-library-member", &claim)],
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            as_assistant(&h, &access, "POST", "/assistant/append", body).await.0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn appends_are_checked_and_capped() {
        let h = write_harness().await;
        let (mut tokens, _) = write_access(&h).await;
        let short = den_assistant::b64url(&[7; 1200]);
        let long = den_assistant::b64url(&vec![7; 3100]);
        for bad in [short, long, format!("{}=", &sealed()[..sealed().len() - 1]), "not base64!".into()] {
            assert_eq!(
                append_with(&h, &tokens, bad).await,
                (StatusCode::BAD_REQUEST, json!({ "error": "invalid_sealed" }))
            );
        }
        // Refused appends were counted, as they are before the body is read: start both windows afresh.
        tokens = later(&h, &tokens, super::DAY_MS).await;
        let (status, first) = append_with(&h, &tokens, sealed()).await;
        assert_eq!((status, &first), (StatusCode::OK, &json!({ "seq": 1, "queued": 1 })));
        // 30 a minute per session.
        let mut accepted = 1;
        loop {
            let (status, answer) = append_with(&h, &tokens, sealed()).await;
            if status == StatusCode::TOO_MANY_REQUESTS {
                break;
            }
            assert_eq!(status, StatusCode::OK, "{answer}");
            accepted += 1;
        }
        assert_eq!(accepted, super::APPENDS_PER_MINUTE);
        // A queue holds 200: the 201st is refused, and none is dropped for it.
        while accepted < super::MAX_QUEUED as u32 {
            tokens = later(&h, &tokens, 61_000).await;
            for _ in 0..super::APPENDS_PER_MINUTE.min(super::MAX_QUEUED as u32 - accepted) {
                assert_eq!(append_with(&h, &tokens, sealed()).await.0, StatusCode::OK);
                accepted += 1;
            }
        }
        tokens = later(&h, &tokens, 61_000).await;
        assert_eq!(
            append_with(&h, &tokens, sealed()).await,
            (StatusCode::CONFLICT, json!({ "error": "queue_full" }))
        );
        let (_, drained) = as_member(&h, "POST", "/assistant/drain", Some(json!({}))).await;
        let messages = drained["messages"].as_array().unwrap();
        assert_eq!((messages.len(), &messages[0]["seq"]), (super::MAX_QUEUED, &json!(1)));
        // Acknowledged, there is room again; past 300 in a day for the library, appends wait for tomorrow. The
        // refused one above was counted too.
        let (_, acked) = as_member(&h, "POST", "/assistant/ack", Some(json!({ "upTo": 200 }))).await;
        assert_eq!(acked, json!({ "removed": 200 }));
        accepted += 1;
        while accepted < super::APPENDS_PER_DAY {
            tokens = later(&h, &tokens, 61_000).await;
            for _ in 0..super::APPENDS_PER_MINUTE.min(super::APPENDS_PER_DAY - accepted) {
                assert_eq!(append_with(&h, &tokens, sealed()).await.0, StatusCode::OK);
                accepted += 1;
            }
        }
        tokens = later(&h, &tokens, 61_000).await;
        assert_eq!(append_with(&h, &tokens, sealed()).await.0, StatusCode::TOO_MANY_REQUESTS);
    }

    async fn append_with(h: &Harness, tokens: &Value, sealed: String) -> (StatusCode, Value) {
        let access = tokens["access_token"].as_str().unwrap();
        as_assistant(h, access, "POST", "/assistant/append", Some(json!({ "sealed": sealed }))).await
    }

    /// `by` later, with the assistant's tokens refreshed, as den-mcp's client keeps them.
    async fn later(h: &Harness, tokens: &Value, by: u64) -> Value {
        h.advance(by);
        let form = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("grant_type", "refresh_token"),
                ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
                ("client_id", tokens["client_id"].as_str().unwrap()),
            ])
            .finish();
        let resp = h
            .send(
                "POST",
                "/oauth/token",
                Some(form),
                &[("content-type", "application/x-www-form-urlencoded")],
            )
            .await;
        let mut next = body_json(resp).await;
        assert!(next["access_token"].is_string(), "{next}");
        next["client_id"] = tokens["client_id"].clone();
        next
    }

    #[tokio::test]
    async fn a_drain_keeps_everything_until_it_is_acknowledged() {
        let h = write_harness().await;
        let (_, access) = write_access(&h).await;
        let (status, _) = send(
            &h,
            "POST",
            "/assistant/drain",
            Some(json!({})),
            &[("x-den-library-member", &format!("{LIB}:nope"))],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        for _ in 0..3 {
            as_assistant(&h, &access, "POST", "/assistant/append", Some(json!({ "sealed": sealed() }))).await;
        }
        let seqs = |v: &Value| {
            v["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_u64().unwrap()).collect::<Vec<_>>()
        };
        let (_, once) = as_member(&h, "POST", "/assistant/drain", None).await;
        assert_eq!(seqs(&once), [1, 2, 3]);
        assert_eq!(once["messages"][0]["sealed"], sealed());
        assert_eq!(
            seqs(&as_member(&h, "POST", "/assistant/drain", None).await.1),
            [1, 2, 3],
            "nothing removed"
        );
        for bad in [json!({ "upTo": -1 }), json!({ "upTo": "2" }), json!({}), json!({ "upTo": 1.5 })] {
            assert_eq!(
                as_member(&h, "POST", "/assistant/ack", Some(bad)).await,
                (StatusCode::BAD_REQUEST, json!({ "error": "invalid_seq" }))
            );
        }
        assert_eq!(
            as_member(&h, "POST", "/assistant/ack", Some(json!({ "upTo": 2 }))).await.1,
            json!({ "removed": 2 })
        );
        assert_eq!(
            as_member(&h, "POST", "/assistant/ack", Some(json!({ "upTo": 2 }))).await.1,
            json!({ "removed": 0 })
        );
        assert_eq!(seqs(&as_member(&h, "POST", "/assistant/drain", None).await.1), [3]);
        // A sequence number is never handed out twice, even once its queue is empty.
        as_member(&h, "POST", "/assistant/ack", Some(json!({ "upTo": 3 }))).await;
        let (_, next) =
            as_assistant(&h, &access, "POST", "/assistant/append", Some(json!({ "sealed": sealed() }))).await;
        assert_eq!(next["seq"], 4);
        // A week on, a request no device took is gone: it would be stale anyway.
        h.advance(super::TTL_MS);
        assert_eq!(seqs(&as_member(&h, "POST", "/assistant/drain", None).await.1), Vec::<u64>::new());
    }

    #[tokio::test]
    async fn a_held_drain_answers_when_a_request_arrives() {
        let h = write_harness().await;
        let (_, access) = write_access(&h).await;
        let claim = member();
        let proof = [("x-den-library-member", claim.as_str())];
        let held = h.send("POST", "/assistant/drain?wait=20", None, &proof);
        let append = async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            as_assistant(&h, &access, "POST", "/assistant/append", Some(json!({ "sealed": sealed() }))).await
        };
        let started = std::time::Instant::now();
        let (resp, _) = tokio::join!(held, append);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(body_json(resp).await["messages"][0]["seq"], 1);
    }

    /// A key reset retires the library: its queue and drop-box key go, and its write sessions end with it.
    #[tokio::test]
    async fn a_retired_library_takes_its_queue_dropbox_and_write_sessions_with_it() {
        let h = write_harness().await;
        let (tokens, access) = write_access(&h).await;
        as_member(&h, "PUT", "/assistant/dropbox", Some(json!({ "pk": public() }))).await;
        as_assistant(&h, &access, "POST", "/assistant/append", Some(json!({ "sealed": sealed() }))).await;
        let resp = h
            .send(
                "DELETE",
                &format!("/lib/{LIB}"),
                None,
                &[("x-den-library-token", TOKEN), ("x-den-generation", "0")],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        for key in [super::queue_key(LIB), super::dropbox_key(LIB)] {
            assert!(h.state.store.get(super::NS, &key).await.unwrap().is_none(), "{key}");
        }
        assert_eq!(
            as_assistant(&h, &access, "GET", "/assistant/dropbox", None).await.0,
            StatusCode::UNAUTHORIZED
        );
        let form = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("grant_type", "refresh_token"),
                ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
                ("client_id", tokens["client_id"].as_str().unwrap()),
            ])
            .finish();
        let refreshed = h
            .send(
                "POST",
                "/oauth/token",
                Some(form),
                &[("content-type", "application/x-www-form-urlencoded")],
            )
            .await;
        assert_eq!(body_json(refreshed).await["error"], "invalid_grant");
    }

    // ---- reads (§15)

    fn grant_id() -> String {
        den_assistant::GrantKey::from_secret(&seed("grant")).id().to_owned()
    }

    fn part(byte: u8) -> String {
        den_assistant::b64url(&[byte; 64])
    }

    const SET: &str = "fa55fe2ae16c6d338a484d1b247bb6f6";

    /// A publish's body: one set id and these parts.
    fn publish(parts: &[String]) -> Value {
        json!({ "set": SET, "parts": parts })
    }

    async fn read_access(h: &Harness) -> String {
        let tokens = connect_read(h, &seed("grant"), &[5; 32], false).await;
        tokens["access_token"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn a_device_publishes_a_projection_and_den_mcp_reads_every_part_of_it() {
        let h = write_harness().await;
        let path = format!("/assistant/projection/{}", grant_id());
        // Nobody may read it yet: nothing is stored.
        assert_eq!(
            as_member(&h, "PUT", &path, Some(publish(&[part(1)]))).await,
            (StatusCode::NOT_FOUND, json!({ "error": "unknown_grant" }))
        );
        let access = read_access(&h).await;
        assert_eq!(
            as_assistant(&h, &access, "GET", "/assistant/projection", None).await,
            (StatusCode::NOT_FOUND, json!({ "error": "no_projection" }))
        );
        let (status, _) = send(&h, "PUT", &path, Some(publish(&[part(1)])), &[]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "only a member publishes");
        for bad in [
            json!({ "parts": [part(1)] }),
            json!({ "set": SET.to_uppercase(), "parts": [part(1)] }),
            json!({ "set": &SET[1..], "parts": [part(1)] }),
        ] {
            assert_eq!(
                as_member(&h, "PUT", &path, Some(bad)).await,
                (StatusCode::BAD_REQUEST, json!({ "error": "invalid_set" }))
            );
        }
        let too_many: Vec<String> = (0..=den_assistant::MAX_PARTS).map(|_| part(1)).collect();
        // A nonce and a tag alone (28 bytes) carry nothing; a part may be no longer than `MAX_PART`.
        let bare = den_assistant::b64url(&[1; 28]);
        let too_long = "A".repeat(den_assistant::MAX_PART + 4);
        let too_much: Vec<String> =
            (0..den_assistant::MAX_PARTS).map(|_| "A".repeat(den_assistant::MAX_PART)).collect();
        for bad in [
            publish(&[]),
            publish(&["AAAA".into()]),
            publish(&["not base64url!".into()]),
            publish(&[bare]),
            publish(&[too_long]),
            publish(&too_many),
            json!({ "set": SET }),
        ] {
            assert_eq!(
                as_member(&h, "PUT", &path, Some(bad)).await,
                (StatusCode::BAD_REQUEST, json!({ "error": "invalid_sealed" }))
            );
        }
        // 64 full parts are exactly 16 MiB: the most a publish may carry.
        assert_eq!(as_member(&h, "PUT", &path, Some(publish(&too_much))).await.0, StatusCode::NO_CONTENT);
        assert_eq!(
            as_member(&h, "PUT", &path, Some(publish(&[den_assistant::b64url(&[1; 29]), part(2)]))).await.0,
            StatusCode::NO_CONTENT
        );
        // A later publish replaces the whole set: never parts of two.
        let later = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            as_member(&h, "PUT", &path, Some(json!({ "set": later, "parts": [part(3)] }))).await.0,
            StatusCode::NO_CONTENT
        );
        let (status, got) = as_assistant(&h, &access, "GET", "/assistant/projection", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            (&got["library"], &got["grant"], &got["set"], &got["parts"]),
            (&json!(LIB), &json!(grant_id()), &json!(later), &json!([part(3)]))
        );
        assert!(got["storedAt"].is_u64());
        // A write-only connection has no read scope.
        let (_, write) = write_access(&h).await;
        assert_eq!(
            as_assistant(&h, &write, "GET", "/assistant/projection", None).await,
            (StatusCode::FORBIDDEN, json!({ "error": "insufficient_scope" }))
        );
        // A device deletes it once the read is revoked.
        assert_eq!(as_member(&h, "DELETE", &path, None).await.0, StatusCode::NO_CONTENT);
        assert_eq!(as_member(&h, "DELETE", &path, None).await.0, StatusCode::NO_CONTENT);
        assert_eq!(
            as_assistant(&h, &access, "GET", "/assistant/projection", None).await.0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn publishes_are_limited_per_grant_an_hour() {
        let h = write_harness().await;
        read_access(&h).await;
        let path = format!("/assistant/projection/{}", grant_id());
        for _ in 0..super::PROJECTIONS_PER_HOUR {
            assert_eq!(
                as_member(&h, "PUT", &path, Some(publish(&[part(1)]))).await.0,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            as_member(&h, "PUT", &path, Some(publish(&[part(1)]))).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );
        h.advance(super::HOUR_MS);
        assert_eq!(as_member(&h, "PUT", &path, Some(publish(&[part(1)]))).await.0, StatusCode::NO_CONTENT);
    }

    /// The projection goes with the last session that could read it: disconnected from Settings, or the library's key
    /// reset.
    #[tokio::test]
    async fn a_projection_goes_with_its_read_session() {
        let h = write_harness().await;
        let path = format!("/assistant/projection/{}", grant_id());
        let stored = |h: &Harness| {
            let state = std::sync::Arc::clone(&h.state);
            async move { state.store.get(super::NS, &super::projection_key(&grant_id())).await.unwrap().is_some() }
        };
        read_access(&h).await;
        as_member(&h, "PUT", &path, Some(publish(&[part(1)]))).await;
        assert!(stored(&h).await);
        let claim = member();
        let (_, listed) =
            send(&h, "GET", "/oauth/connections", None, &[("x-den-library-member", &claim)]).await;
        let sid = listed["connections"][0]["sid"].as_str().unwrap().to_owned();
        send(&h, "DELETE", &format!("/oauth/connections/{sid}"), None, &[("x-den-library-member", &claim)])
            .await;
        assert!(!stored(&h).await, "disconnected");

        read_access(&h).await;
        as_member(&h, "PUT", &path, Some(publish(&[part(1)]))).await;
        assert!(stored(&h).await);
        let resp = h
            .send(
                "DELETE",
                &format!("/lib/{LIB}"),
                None,
                &[("x-den-library-token", TOKEN), ("x-den-generation", "0")],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!stored(&h).await, "the key reset");
    }
}
