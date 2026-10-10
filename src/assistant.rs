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
        (_, "/assistant/dropbox" | "/assistant/append" | "/assistant/drain" | "/assistant/ack") => {
            crate::handler::method_not_allowed()
        }
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
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
        connect_member, connect_write, member, seed, vectors, write_harness, LIB, TOKEN,
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
}
