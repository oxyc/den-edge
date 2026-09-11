//! `/pair`: the relay for pairing v1 (den-spec `wire/pairing-v1.md`). A host and a joiner run CPace through
//! four write-once slots. The secret half of the code never reaches here, so den-edge carries the messages
//! without being able to read the key they agree on or pass as either device.

use crate::handler::{client_ip, error, json_reply, read_json, MAX_BODY_BYTES};
use crate::link::{throttled, ALPHABET};
use crate::{lock, AppState};
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::HashMap;

const TTL_MS: u64 = 10 * 60 * 1000;
/// Slots `a`–`d`, in the order the two sides write them: joiner, host, joiner, host.
const SLOTS: [&str; 4] = ["a", "b", "c", "d"];
/// A message is at most 2 KiB: 2731 characters of unpadded base64url.
const MAX_MESSAGE_CHARS: usize = 2731;
/// Live sessions at most. Each holds four small messages for ten minutes, and `new` is limited per address.
const MAX_SESSIONS: usize = 10_000;

pub struct Session {
    nameplate: String,
    opened: bool,
    slots: [Option<String>; 4],
    expires_at: u64,
}

/// Four characters from the code alphabet: the part of the code den-edge sees.
pub fn gen_nameplate() -> String {
    crate::random_bytes::<4>().iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect()
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let parts: Vec<&str> = path.trim_start_matches("/pair/").split('/').collect();
    match (req.method(), parts.as_slice()) {
        (&Method::POST, ["new"]) => create(state, req).await,
        (&Method::POST, ["open"]) => open(state, req).await,
        (&Method::PUT, [sid, slot]) => write(state, sid, slot, req).await,
        (&Method::GET, [sid, slot]) => read(state, sid, slot),
        (&Method::DELETE, [sid]) => forget(state, sid),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

/// The host opens a session under a `sid` it generated, and gets the nameplate to show.
async fn create(state: &AppState, req: Request) -> Response {
    if throttled(state, &format!("mint:{}", client_ip(&req))) {
        return json_reply(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"));
    }
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let sid = body.get("sid").and_then(Value::as_str).unwrap_or("");
    if !valid_sid(sid) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_sid"));
    }
    let now = state.now();
    let mut pairs = lock(&state.pairs);
    pairs.retain(|_, session| session.expires_at > now);
    if pairs.contains_key(sid) {
        return json_reply(StatusCode::CONFLICT, &error("sid_taken"));
    }
    if pairs.len() >= MAX_SESSIONS {
        return json_reply(StatusCode::SERVICE_UNAVAILABLE, &error("busy"));
    }
    let taken = |nameplate: &str| pairs.values().any(|session| session.nameplate == nameplate);
    let mut nameplate = (state.gen_nameplate)();
    for _ in 0..5 {
        if !taken(&nameplate) {
            break;
        }
        nameplate = (state.gen_nameplate)();
    }
    if taken(&nameplate) {
        return json_reply(StatusCode::SERVICE_UNAVAILABLE, &error("nameplate_unavailable"));
    }
    let expires_at = now + TTL_MS;
    let session =
        Session { nameplate: nameplate.clone(), opened: false, slots: Default::default(), expires_at };
    pairs.insert(sid.to_owned(), session);
    json_reply(StatusCode::OK, &json!({ "nameplate": nameplate, "expiresAt": expires_at }))
}

/// The joiner trades the nameplate for the `sid`, once: a second opener is refused, so a stranger who
/// guessed the nameplate ends the pairing visibly instead of joining it quietly. Limited per address, with
/// `/link` claims.
async fn open(state: &AppState, req: Request) -> Response {
    if throttled(state, &client_ip(&req)) {
        return json_reply(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"));
    }
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let nameplate = body.get("nameplate").and_then(Value::as_str).unwrap_or("").to_uppercase();
    let now = state.now();
    let mut pairs = lock(&state.pairs);
    let found = pairs.iter_mut().find(|(_, s)| s.nameplate == nameplate && s.expires_at > now);
    match found {
        None => json_reply(StatusCode::GONE, &error("expired_or_unknown")),
        Some((_, session)) if session.opened => json_reply(StatusCode::CONFLICT, &error("already_opened")),
        Some((sid, session)) => {
            session.opened = true;
            json_reply(StatusCode::OK, &json!({ "sid": sid }))
        }
    }
}

async fn write(state: &AppState, sid: &str, slot: &str, req: Request) -> Response {
    let Some(index) = SLOTS.iter().position(|s| *s == slot) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let message = body.get("m").and_then(Value::as_str).unwrap_or("");
    if !valid_message(message) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_message"));
    }
    let mut pairs = lock(&state.pairs);
    let Some(session) = live(&mut pairs, sid, state.now()) else {
        return json_reply(StatusCode::GONE, &error("expired_or_unknown"));
    };
    if session.slots[index].is_some() {
        return json_reply(StatusCode::CONFLICT, &error("already_written"));
    }
    session.slots[index] = Some(message.to_owned());
    json_reply(StatusCode::OK, &json!({ "written": true }))
}

/// A slot's message, or pending. Reading `d`, the last message, ends the session.
fn read(state: &AppState, sid: &str, slot: &str) -> Response {
    let Some(index) = SLOTS.iter().position(|s| *s == slot) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let mut pairs = lock(&state.pairs);
    let Some(session) = live(&mut pairs, sid, state.now()) else {
        return json_reply(StatusCode::GONE, &error("expired_or_unknown"));
    };
    let Some(message) = session.slots[index].clone() else {
        return json_reply(StatusCode::ACCEPTED, &json!({ "status": "pending" }));
    };
    if index == SLOTS.len() - 1 {
        pairs.remove(sid);
    }
    json_reply(StatusCode::OK, &json!({ "m": message }))
}

/// Either side ends a pairing that failed, was declined or was cancelled. Idempotent.
fn forget(state: &AppState, sid: &str) -> Response {
    lock(&state.pairs).remove(sid);
    json_reply(StatusCode::OK, &json!({ "deleted": true }))
}

fn live<'a>(pairs: &'a mut HashMap<String, Session>, sid: &str, now: u64) -> Option<&'a mut Session> {
    if pairs.get(sid).is_some_and(|session| session.expires_at <= now) {
        pairs.remove(sid);
    }
    pairs.get_mut(sid)
}

/// 16 bytes as lowercase hex.
fn valid_sid(sid: &str) -> bool {
    sid.len() == 32 && sid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_message(message: &str) -> bool {
    !message.is_empty()
        && message.len() <= MAX_MESSAGE_CHARS
        && message.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::{sequence, Harness};
    use axum::http::StatusCode;
    use serde_json::json;
    use std::sync::Arc;

    const SID: &str = "000102030405060708090a0b0c0d0e0f";

    fn harness(nameplates: &[&str]) -> Harness {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().gen_nameplate = sequence(nameplates);
        h
    }

    fn slot(slot: &str) -> String {
        format!("/pair/{SID}/{slot}")
    }

    async fn new_session(h: &Harness) {
        assert_eq!(h.call("POST", "/pair/new", Some(json!({ "sid": SID }))).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_whole_pairing_goes_through_and_ends_once_the_handover_is_read() {
        let h = harness(&["ABCD"]);
        let (status, made) = h.call("POST", "/pair/new", Some(json!({ "sid": SID }))).await;
        assert_eq!((status, made["nameplate"].as_str()), (StatusCode::OK, Some("ABCD")));
        let (_, opened) = h.call("POST", "/pair/open", Some(json!({ "nameplate": "abcd" }))).await;
        assert_eq!(opened, json!({ "sid": SID }));
        assert_eq!(h.call("GET", &slot("a"), None).await.0, StatusCode::ACCEPTED);
        for (name, message) in [("a", "YQ"), ("b", "Yg"), ("c", "Yw"), ("d", "ZA")] {
            let put = h.call("PUT", &slot(name), Some(json!({ "m": message }))).await;
            assert_eq!(put.0, StatusCode::OK, "{name}");
            assert_eq!(h.call("GET", &slot(name), None).await.1, json!({ "m": message }), "{name}");
        }
        assert_eq!(h.call("GET", &slot("a"), None).await.0, StatusCode::GONE);
    }

    #[tokio::test]
    async fn a_nameplate_opens_once_and_a_slot_is_written_once() {
        let h = harness(&["ONCE"]);
        new_session(&h).await;
        assert_eq!(
            h.call("POST", "/pair/open", Some(json!({ "nameplate": "ONCE" }))).await.0,
            StatusCode::OK
        );
        let again = h.call("POST", "/pair/open", Some(json!({ "nameplate": "ONCE" }))).await;
        assert_eq!(again, (StatusCode::CONFLICT, json!({ "error": "already_opened" })));
        h.call("PUT", &slot("a"), Some(json!({ "m": "first" }))).await;
        let replaced = h.call("PUT", &slot("a"), Some(json!({ "m": "second" }))).await;
        assert_eq!(replaced.0, StatusCode::CONFLICT);
        assert_eq!(h.call("GET", &slot("a"), None).await.1, json!({ "m": "first" }));
    }

    #[tokio::test]
    async fn either_side_ends_a_session_and_ten_minutes_end_it_anyway() {
        let h = harness(&["GONE", "LATE"]);
        new_session(&h).await;
        assert_eq!(h.call("DELETE", &format!("/pair/{SID}"), None).await.0, StatusCode::OK);
        assert_eq!(h.call("GET", &slot("a"), None).await.0, StatusCode::GONE);
        assert_eq!(h.call("PUT", &slot("a"), Some(json!({ "m": "YQ" }))).await.0, StatusCode::GONE);
        assert_eq!(h.call("DELETE", &format!("/pair/{SID}"), None).await.0, StatusCode::OK, "again is fine");

        new_session(&h).await;
        h.advance(super::TTL_MS);
        assert_eq!(h.call("GET", &slot("a"), None).await.0, StatusCode::GONE);
        let open = h.call("POST", "/pair/open", Some(json!({ "nameplate": "LATE" }))).await;
        assert_eq!(open.0, StatusCode::GONE);
    }

    #[tokio::test]
    async fn malformed_sessions_and_messages_are_refused() {
        let h = harness(&["SAME", "SAME", "SAME", "SAME", "SAME", "SAME", "SAME", "NEXT"]);
        for sid in ["", "00", "000102030405060708090A0B0C0D0E0F"] {
            let made = h.call("POST", "/pair/new", Some(json!({ "sid": sid }))).await;
            assert_eq!(made.0, StatusCode::BAD_REQUEST, "{sid:?}");
        }
        new_session(&h).await;
        assert_eq!(h.call("POST", "/pair/new", Some(json!({ "sid": SID }))).await.0, StatusCode::CONFLICT);
        let other = "ffffffffffffffffffffffffffffffff";
        let taken = h.call("POST", "/pair/new", Some(json!({ "sid": other }))).await;
        assert_eq!(taken, (StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "nameplate_unavailable" })));

        let too_long = "A".repeat(super::MAX_MESSAGE_CHARS + 1);
        for message in ["", "a+b/", too_long.as_str()] {
            let put = h.call("PUT", &slot("a"), Some(json!({ "m": message }))).await;
            assert_eq!(put.0, StatusCode::BAD_REQUEST);
        }
        assert_eq!(h.call("PUT", &slot("e"), Some(json!({ "m": "YQ" }))).await.0, StatusCode::NOT_FOUND);
        assert_eq!(h.call("DELETE", &format!("/pair/{SID}/a/b"), None).await.0, StatusCode::NOT_FOUND);
        let unknown = h.call("POST", "/pair/open", Some(json!({ "nameplate": "NOPE" }))).await;
        assert_eq!(unknown.0, StatusCode::GONE);
    }

    #[tokio::test]
    async fn opening_is_limited_per_address_with_link_claims() {
        let h = Harness::new();
        for _ in 0..crate::link::CLAIMS_PER_WINDOW {
            let open = h.call("POST", "/pair/open", Some(json!({ "nameplate": "GUES" }))).await;
            assert_eq!(open.0, StatusCode::GONE);
        }
        let open = h.call("POST", "/pair/open", Some(json!({ "nameplate": "GUES" }))).await;
        assert_eq!(open.0, StatusCode::TOO_MANY_REQUESTS);
        let claim = h.call("POST", "/link/claim", Some(json!({ "code": "GUESS1" }))).await;
        assert_eq!(claim.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn a_session_id_never_becomes_a_label() {
        use crate::handler::route_label;
        assert_eq!(route_label(&format!("/pair/{SID}/a")), "/pair/:sid/:slot");
        assert_eq!(route_label(&format!("/pair/{SID}")), "/pair/:sid");
        assert_eq!(route_label("/pair/new"), "/pair/new");
    }

    #[test]
    fn the_real_nameplates_come_from_the_code_alphabet() {
        let nameplate = super::gen_nameplate();
        assert!(nameplate.len() == 4 && nameplate.bytes().all(|b| crate::link::ALPHABET.contains(&b)));
    }
}
