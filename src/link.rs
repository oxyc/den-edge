//! `/link` — pairing a phone with a TV. The TV mints a code (shown as text and a QR), the phone claims it and
//! gets a fresh `inboxKey`, and the TV's next poll hands it the same key, once. After that both devices hold
//! the key and nothing here remembers the pair.

use crate::handler::{
    client_ip, error, json_reply, method_not_allowed, query_param, read_json, MAX_BODY_BYTES,
};
use crate::{lock, AppState};
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

const TTL_MS: u64 = 10 * 60 * 1000;
/// No 0/O or 1/I. Thirty-two symbols, so `byte & 31` picks one without bias.
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Claims per client address per minute: the only secret in a pairing is a six-character code.
const CLAIMS_PER_WINDOW: u32 = 20;
const CLAIM_WINDOW_MS: u64 = 60 * 1000;

pub struct LinkState {
    /// Set once the phone has claimed the code.
    inbox_key: Option<String>,
    expires_at: u64,
}

pub struct Throttle {
    count: u32,
    until: u64,
}

/// A six-character code from the OS's random source.
pub fn gen_code() -> String {
    crate::random_bytes::<6>().iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect()
}

/// 192 bits, as 48 hex characters.
pub fn gen_inbox_key() -> String {
    crate::hex(&crate::random_bytes::<24>())
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    match req.uri().path() {
        "/link/new" if req.method() == Method::POST => mint(state),
        "/link/claim" if req.method() == Method::POST => claim(state, req).await,
        "/link/new" | "/link/claim" => method_not_allowed(),
        "/link/poll" => poll(state, &req),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

/// The TV mints a code to display.
fn mint(state: &AppState) -> Response {
    let now = state.now();
    let mut links = lock(&state.links);
    links.retain(|_, link| link.expires_at > now);
    let mut code = (state.gen_code)();
    for _ in 0..5 {
        if !links.contains_key(&code) {
            break;
        }
        code = (state.gen_code)();
    }
    if links.contains_key(&code) {
        return json_reply(StatusCode::SERVICE_UNAVAILABLE, &error("code_unavailable"));
    }
    let expires_at = now + TTL_MS;
    links.insert(code.clone(), LinkState { inbox_key: None, expires_at });
    json_reply(StatusCode::OK, &json!({ "code": code, "expiresAt": expires_at }))
}

/// The phone claims the code and gets a new `inboxKey`.
async fn claim(state: &AppState, req: Request) -> Response {
    if throttled(state, &client_ip(&req)) {
        return json_reply(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"));
    }
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    let code = body.get("code").and_then(Value::as_str).unwrap_or("").to_uppercase();
    let now = state.now();
    let mut links = lock(&state.links);
    match links.get_mut(&code) {
        Some(link) if link.expires_at <= now => {
            links.remove(&code);
            json_reply(StatusCode::GONE, &error("expired_or_unknown"))
        }
        None => json_reply(StatusCode::GONE, &error("expired_or_unknown")),
        Some(link) if link.inbox_key.is_some() => json_reply(StatusCode::CONFLICT, &error("already_claimed")),
        Some(link) => {
            let key = (state.gen_inbox_key)();
            link.inbox_key = Some(key.clone());
            json_reply(StatusCode::OK, &json!({ "inboxKey": key }))
        }
    }
}

/// The TV polls until the code is claimed, then gets the key once and the code is gone.
fn poll(state: &AppState, req: &Request) -> Response {
    let code = query_param(req, "code").unwrap_or_default().to_uppercase();
    let now = state.now();
    let mut links = lock(&state.links);
    let Some(link) = links.get(&code) else {
        return json_reply(StatusCode::GONE, &error("expired_or_unknown"));
    };
    if link.expires_at <= now {
        links.remove(&code);
        return json_reply(StatusCode::GONE, &error("expired_or_unknown"));
    }
    match link.inbox_key.clone() {
        None => json_reply(StatusCode::ACCEPTED, &json!({ "status": "pending" })),
        Some(key) => {
            links.remove(&code);
            json_reply(StatusCode::OK, &json!({ "status": "claimed", "inboxKey": key }))
        }
    }
}

/// Counts a claim from `ip`; true once it is over the limit. A blocked attempt doesn't extend the window, an
/// allowed one does — so a steady stream of guesses stays blocked and the window clears once they stop.
fn throttled(state: &AppState, ip: &str) -> bool {
    let now = state.now();
    let mut claims = lock(&state.claims);
    if claims.len() > 1024 {
        claims.retain(|_, t| t.until > now);
    }
    let t = claims.entry(ip.to_owned()).or_insert(Throttle { count: 0, until: 0 });
    if t.until <= now {
        t.count = 0;
    }
    if t.count >= CLAIMS_PER_WINDOW {
        return true;
    }
    t.count += 1;
    t.until = now + CLAIM_WINDOW_MS;
    false
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;

    #[tokio::test]
    async fn mint_poll_claim_poll_and_the_code_is_single_use() {
        let h = Harness::with_generators(&["LNK234"], &["deadbeefcafe1234"]);
        let (_, minted) = h.call("POST", "/link/new", None).await;
        assert_eq!(minted["code"], "LNK234");
        assert_eq!(h.call("GET", "/link/poll?code=LNK234", None).await.0, StatusCode::ACCEPTED);
        let (status, claimed) = h.call("POST", "/link/claim", Some(json!({ "code": "lnk234" }))).await;
        assert_eq!((status, claimed["inboxKey"].as_str()), (StatusCode::OK, Some("deadbeefcafe1234")));
        let (_, got) = h.call("GET", "/link/poll?code=LNK234", None).await;
        assert_eq!(got, json!({ "status": "claimed", "inboxKey": "deadbeefcafe1234" }));
        assert_eq!(h.call("GET", "/link/poll?code=LNK234", None).await.0, StatusCode::GONE);
    }

    #[tokio::test]
    async fn a_second_claim_is_a_conflict() {
        let h = Harness::with_generators(&["DUP234"], &["aaaa1111bbbb2222", "cccc3333dddd4444"]);
        h.call("POST", "/link/new", None).await;
        h.call("POST", "/link/claim", Some(json!({ "code": "DUP234" }))).await;
        assert_eq!(
            h.call("POST", "/link/claim", Some(json!({ "code": "DUP234" }))).await.0,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn a_code_expires_after_ten_minutes() {
        let h = Harness::with_generators(&["EXP234"], &["ffff0000ffff0000"]);
        h.call("POST", "/link/new", None).await;
        h.advance(601 * 1000);
        assert_eq!(h.call("GET", "/link/poll?code=EXP234", None).await.0, StatusCode::GONE);
        assert_eq!(
            h.call("POST", "/link/claim", Some(json!({ "code": "EXP234" }))).await.0,
            StatusCode::GONE
        );
    }

    #[tokio::test]
    async fn unknown_codes_and_malformed_claims() {
        let h = Harness::new();
        assert_eq!(
            h.call("POST", "/link/claim", Some(json!({ "code": "NOPE99" }))).await.0,
            StatusCode::GONE
        );
        let not_json = h.send("POST", "/link/claim", Some("not json".into()), &[]).await;
        assert_eq!(not_json.status(), StatusCode::BAD_REQUEST);
        assert_eq!(h.call("GET", "/link/poll", None).await.0, StatusCode::GONE);
        assert_eq!(h.call("GET", "/link/elsewhere", None).await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_real_generators_mint_an_unambiguous_code_and_a_48_hex_key() {
        let h = Harness::new();
        let (_, minted) = h.call("POST", "/link/new", None).await;
        let code = minted["code"].as_str().unwrap().to_owned();
        assert!(code.len() == 6 && code.bytes().all(|b| super::ALPHABET.contains(&b)), "{code}");
        let (_, claimed) = h.call("POST", "/link/claim", Some(json!({ "code": code }))).await;
        let key = claimed["inboxKey"].as_str().unwrap();
        assert!(key.len() == 48 && key.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }

    #[tokio::test]
    async fn a_code_collision_mints_another() {
        let h = Harness::with_generators(&["COL234", "COL234", "NEW234"], &["k1k1k1k1k1k1k1k1"]);
        assert_eq!(h.call("POST", "/link/new", None).await.1["code"], "COL234");
        assert_eq!(h.call("POST", "/link/new", None).await.1["code"], "NEW234");
    }

    #[tokio::test]
    async fn claims_are_throttled_per_address_and_the_window_clears() {
        let h = Harness::new();
        for _ in 0..super::CLAIMS_PER_WINDOW {
            assert_eq!(
                h.call("POST", "/link/claim", Some(json!({ "code": "GUESS1" }))).await.0,
                StatusCode::GONE
            );
        }
        assert_eq!(
            h.call("POST", "/link/claim", Some(json!({ "code": "GUESS1" }))).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );
        h.advance(super::CLAIM_WINDOW_MS);
        assert_eq!(
            h.call("POST", "/link/claim", Some(json!({ "code": "GUESS1" }))).await.0,
            StatusCode::GONE
        );
    }
}
