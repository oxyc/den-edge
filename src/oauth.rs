//! The authorization server for Den's MCP connector (oxyc/den#25): an LLM client such as Claude or ChatGPT registers
//! itself, sends its person here to say yes, and gets short-lived access tokens for den-mcp, which this server relays
//! `/mcp` to. OAuth 2.1 as the MCP authorization spec asks for it:
//!
//!   GET    /.well-known/oauth-authorization-server   RFC 8414 metadata
//!   GET    /.well-known/oauth-protected-resource[/mcp]   RFC 9728, den-mcp's own answer relayed
//!   POST   /oauth/register                           RFC 7591 dynamic registration: public clients only
//!   GET    /oauth/authorize                          code + PKCE (S256 only) → Den Web's consent page
//!   GET    /oauth/request/{id}                       what the consent page shows
//!   POST   /oauth/request/{id}/approve|deny          the consent page's answer, with a member's or a guest's proof
//!   POST   /oauth/token                              authorization_code, refresh_token (rotated)
//!   POST   /oauth/revoke                             RFC 7009
//!   GET    /oauth/connections                        the connected assistants a member or a guest can see
//!   DELETE /oauth/connections/{sid}                  revoke one
//!   *      /mcp                                      relayed to den-mcp, streamed, once the token's session stands
//!
//! Who may approve: a library member (`x-den-library-member`, as `library::is_member` proves it) or a guest holding a
//! live grant (`x-den-grant`, `grants::authenticate`). Nobody else, and nothing about a library reaches the client:
//! the token names an opaque session.
//!
//! # Tokens
//!
//! An access token is a compact JWS signed with Ed25519 (`alg: EdDSA`, `typ: at+jwt`, RFC 9068's claims), so den-mcp
//! checks it with the public key alone and never asks this server. It lasts `ACCESS_TTL_S`, and a guest's never
//! outlasts the grant. The refresh token is `<sid>.<secret>`; only the secret's SHA-256 is kept, it is replaced on
//! every use, and presenting a replaced one ends the session (refresh-token reuse detection, OAuth 2.1 §4.3.1) —
//! except the one just replaced, once more within `REFRESH_GRACE_MS`, which is a client retrying a lost answer.
//!
//! # Before consent
//!
//! Registering and asking are open to anyone, so nothing before a person says yes sends a browser anywhere: every
//! refusal is Den's own page (`error_page`), and the consent page leads with where the answer would go, marked known
//! only for the assistants' own hosts. Full tables make room by dropping the oldest unused entry.
//!
//! # Cutting a connection off
//!
//! A session is one file; revoking it removes the file. The `/mcp` relay reads the session behind every call, and for
//! a guest the grant too, so a revoked connection, a revoked or expired grant, and a member whose library key was
//! reset all stop at the next call — not when the access token runs out. Ending a grant (`grants::end_sessions`)
//! deletes its sessions as well, so they cannot be refreshed either.

use crate::handler::{constant_time_eq, error, internal, json_reply, retry_after};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use http_body_util::Full;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use std::time::Duration;

const NS: &str = "oauth";
const INDEX: &str = "index";
const VERSION: u32 = 1;
pub const SCOPE: &str = "den:search";
/// How long an access token lasts. Short, because it is checked without asking this server; the relay's check of
/// the session is what makes revocation immediate.
const ACCESS_TTL_S: u64 = 15 * 60;
/// A session unused this long ends: its refresh token is not accepted after.
const IDLE_MS: u64 = 30 * 86_400_000;
/// How long the consent page may take, and how long a code waits to be exchanged.
const PENDING_MS: u64 = 10 * 60_000;
const CODE_MS: u64 = 60_000;
/// Registered clients kept, and how long one that was never used is kept.
const MAX_CLIENTS: usize = 500;
const UNUSED_CLIENT_MS: u64 = 86_400_000;
/// How long a client that was consented to is kept once it has no connection left.
const IDLE_CLIENT_MS: u64 = 30 * 86_400_000;
/// Authorizations waiting for the consent page, in all and for one client.
const MAX_PENDING: usize = 1000;
const MAX_PENDING_PER_CLIENT: usize = 10;
/// The most of `state` an authorization request may carry: it is sent back, and kept until then.
const STATE_MAX: usize = 1024;
/// Connections one library may have (its guests' included), one guest may make, and in all.
const MAX_SESSIONS_PER_HOST: usize = 50;
const MAX_SESSIONS_PER_GRANT: usize = 5;
const MAX_SESSIONS: usize = 1000;
/// How long after a refresh the refresh token it replaced is still taken, once: a client whose answer was lost
/// retries with the old one, and that is a retry, not a theft.
const REFRESH_GRACE_MS: u64 = 60_000;
/// Replaced refresh secrets remembered per session, so any older one presented is known for reuse.
const RETIRED_KEPT: usize = 8;
/// Requests per address per minute to each public endpoint, and per session to `/mcp`.
const REGISTER_PER_WINDOW: u32 = 10;
const AUTHORIZE_PER_WINDOW: u32 = 60;
const TOKEN_PER_WINDOW: u32 = 60;
const CONSENT_PER_WINDOW: u32 = 30;
const MCP_GATE_PER_WINDOW: u32 = 600;
const MCP_PER_SESSION: u32 = 600;
const MCP_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a call's body may take to arrive: it is at most 256 KiB, read before the call takes a slot.
const MCP_BODY_TIMEOUT: Duration = Duration::from_millis(if cfg!(test) { 300 } else { 10_000 });
/// How long a call's answer may go without a frame before its slot comes back: den-mcp answers in milliseconds, so
/// this is an answer that stalled or a caller that stopped reading.
const MCP_ANSWER_IDLE: Duration = Duration::from_millis(if cfg!(test) { 300 } else { 30_000 });
const SWEEP_EVERY: Duration = Duration::from_secs(3600);
const NAME_MAX: usize = 80;
const URI_MAX: usize = 512;
const MAX_REDIRECTS: usize = 5;

/// What this server is configured as. `None` in `AppState` turns every route here off (404).
pub struct OAuth {
    /// The authorization server's origin: `iss` in every token, and the base of every endpoint the metadata names.
    pub issuer: String,
    /// The MCP server clients connect to (`<origin>/mcp`), which a token is issued for (`aud`).
    pub resource: String,
    /// Where Den Web's consent page is: the issuer's origin unless the web app is served from another name.
    pub consent_origin: String,
    key: SigningKey,
    kid: String,
    pending: Mutex<HashMap<String, Pending>>,
    codes: Mutex<HashMap<String, Code>>,
    /// Held across every read-modify-write of the index, a session's rotation included.
    lock: tokio::sync::Mutex<()>,
    /// `/mcp` calls relayed at once (`MCP_IN_FLIGHT`), held until den-mcp's answer has been passed on or has idled out.
    mcp_slots: std::sync::Arc<tokio::sync::Semaphore>,
    /// `/mcp` request bodies arriving at once. Separate from `mcp_slots`, so a slow upload does not occupy a call
    /// slot, but many bounded bodies still cannot accumulate without a global cap.
    mcp_body_slots: std::sync::Arc<tokio::sync::Semaphore>,
}

/// The most `/mcp` calls relayed to den-mcp at once. den-mcp answers a call in milliseconds and runs 32 at a time
/// itself; this keeps a flood from reaching it and holding this server's connections open while it waits.
const MCP_IN_FLIGHT: usize = 32;
const MCP_BODY_IN_FLIGHT: usize = MCP_IN_FLIGHT;

impl OAuth {
    /// `seed` is the Ed25519 private key's 32 bytes.
    pub fn new(issuer: String, resource: String, consent_origin: String, seed: [u8; 32]) -> OAuth {
        let key = SigningKey::from_bytes(&seed);
        let kid = crate::hex(&Sha256::digest(key.verifying_key().as_bytes())[..8]);
        OAuth {
            issuer,
            resource,
            consent_origin,
            key,
            kid,
            pending: Mutex::default(),
            codes: Mutex::default(),
            lock: tokio::sync::Mutex::new(()),
            mcp_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(MCP_IN_FLIGHT)),
            mcp_body_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(MCP_BODY_IN_FLIGHT)),
        }
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.key.verifying_key()
    }

    /// Where the resource's metadata is, for a 401's `WWW-Authenticate`.
    fn resource_metadata(&self) -> String {
        let origin = self.resource.strip_suffix("/mcp").unwrap_or(&self.resource);
        format!("{origin}/.well-known/oauth-protected-resource/mcp")
    }
}

/// An authorization request waiting for the consent page.
struct Pending {
    client_id: String,
    client_name: String,
    redirect_uri: String,
    challenge: String,
    state: Option<String>,
    until: u64,
    /// Arrival order, which decides the oldest when several arrived in the same millisecond.
    seq: u64,
}

/// A code, waiting to be exchanged.
struct Code {
    client_id: String,
    redirect_uri: String,
    challenge: String,
    who: Who,
    until: u64,
}

/// Whom a connection speaks for.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Who {
    /// A member of `library`, holding the member token whose SHA-256 is `member_hash` (hex).
    Member { library: String, member_hash: String },
    /// A guest of grant `gid`, which `host` shares, named `name`.
    Guest { gid: String, host: String, name: String },
}

impl Who {
    fn host(&self) -> &str {
        match self {
            Who::Member { library, .. } => library,
            Who::Guest { host, .. } => host,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Who::Member { .. } => "member",
            Who::Guest { .. } => "guest",
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Client {
    v: u32,
    id: String,
    name: String,
    redirect_uris: Vec<String>,
    created_at: u64,
    /// A consent was given to it at least once; an unused registration is reaped after a day.
    used: bool,
    /// When a consent was last given to it; with no connection left, it is reaped `IDLE_CLIENT_MS` after.
    #[serde(default)]
    consented_at: u64,
}

#[derive(Serialize, Deserialize)]
struct Session {
    v: u32,
    sid: String,
    client_id: String,
    client_name: String,
    /// The host its approval was sent back to, which is who really holds it; Settings shows it beside the name.
    #[serde(default)]
    redirect_host: Option<String>,
    who: Who,
    /// Hex SHA-256 of the refresh secret now valid, and of the one it replaced, which is taken again only within
    /// `REFRESH_GRACE_MS` of `rotated_at`.
    refresh_hash: String,
    previous_hash: Option<String>,
    #[serde(default)]
    rotated_at: u64,
    /// Older replaced secrets: one of them presented is a stolen token being used, and ends the session.
    #[serde(default)]
    retired: Vec<String>,
    created_at: u64,
    used_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    v: u32,
    clients: Vec<IndexClient>,
    sessions: Vec<IndexSession>,
}

#[derive(Serialize, Deserialize, Clone)]
struct IndexClient {
    id: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct IndexSession {
    sid: String,
    host: String,
    gid: Option<String>,
}

fn sha(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url.
pub fn b64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for b in s.bytes() {
        acc = acc << 6 | B64.iter().position(|c| *c == b)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    (acc == 0).then_some(out)
}

fn random_id() -> String {
    crate::hex(&crate::random_bytes::<16>())
}

/// The paths this module answers.
pub fn is_path(path: &str) -> bool {
    path == "/mcp"
        || path.starts_with("/mcp/")
        || path.starts_with("/oauth/")
        || path == "/.well-known/oauth-authorization-server"
        || path == "/.well-known/oauth-protected-resource"
        || path == "/.well-known/oauth-protected-resource/mcp"
}

pub async fn handle(state: &AppState, req: Request, rid: &str) -> Response {
    let Some(oauth) = state.oauth.as_ref() else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let path = req.uri().path().to_owned();
    let method = req.method().clone();
    match (method, path.as_str()) {
        (Method::GET | Method::HEAD, "/.well-known/oauth-authorization-server") => metadata(oauth),
        (Method::GET | Method::HEAD, "/.well-known/oauth-protected-resource")
        | (Method::GET | Method::HEAD, "/.well-known/oauth-protected-resource/mcp") => {
            relay_mcp(state, req, rid).await
        }
        (Method::POST, "/oauth/register") => register(state, oauth, req).await,
        (Method::GET, "/oauth/authorize") => authorize(state, oauth, req).await,
        (Method::POST, "/oauth/token") => token(state, oauth, req).await,
        (Method::POST, "/oauth/revoke") => revoke(state, oauth, req).await,
        (Method::GET | Method::HEAD, "/oauth/connections") => connections(state, req).await,
        (Method::DELETE, p) if p.starts_with("/oauth/connections/") => {
            disconnect(state, req, &p["/oauth/connections/".len()..]).await
        }
        (Method::GET | Method::HEAD, p) if p.starts_with("/oauth/request/") => {
            request_info(state, oauth, req, &p["/oauth/request/".len()..])
        }
        (Method::POST, p) if p.starts_with("/oauth/request/") => {
            let rest = &p["/oauth/request/".len()..];
            match rest.split_once('/') {
                Some((id, "approve")) => consent(state, oauth, req, id, true).await,
                Some((id, "deny")) => consent(state, oauth, req, id, false).await,
                _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
            }
        }
        (_, "/mcp") => gate_mcp(state, oauth, req, rid).await,
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

fn metadata(oauth: &OAuth) -> Response {
    let i = &oauth.issuer;
    json_reply(
        StatusCode::OK,
        &json!({
            "issuer": i,
            "authorization_endpoint": format!("{i}/oauth/authorize"),
            "token_endpoint": format!("{i}/oauth/token"),
            "registration_endpoint": format!("{i}/oauth/register"),
            "revocation_endpoint": format!("{i}/oauth/revoke"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "revocation_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": [SCOPE],
            "authorization_response_iss_parameter_supported": true,
        }),
    )
}

/// An OAuth error answer: `{error, error_description}`, never cached.
fn oauth_error(status: StatusCode, code: &str, description: &str) -> Response {
    let mut resp = json_reply(status, &json!({ "error": code, "error_description": description }));
    resp.headers_mut().insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    resp
}

fn gate(state: &AppState, bucket: String, limit: u32) -> Option<Response> {
    crate::link::throttled_at(state, &bucket, limit)
        .map(|wait| retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait))
}

/// `limit` a minute to `/mcp`, in fixed windows: an assistant calls steadily, and a window that moved on with every
/// call allowed (`gate`) would never close and refuse it for good once past the limit.
fn gate_steady(state: &AppState, bucket: String, limit: u32) -> Option<Response> {
    crate::link::throttled_per_minute(state, &bucket, limit)
        .map(|wait| retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait))
}

// ---- storage

async fn load<T: serde::de::DeserializeOwned>(state: &AppState, key: &str) -> io::Result<Option<T>> {
    match state.store.get(NS, key).await? {
        Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(io::Error::other),
        None => Ok(None),
    }
}

async fn save<T: Serialize>(state: &AppState, key: &str, value: &T) -> io::Result<()> {
    state.store.put(NS, key, &serde_json::to_vec(value).expect("a record always serialises")).await?;
    // Synced, so a revocation cannot come back after a power loss.
    state.store.sync_dir(NS).await
}

async fn load_index(state: &AppState) -> io::Result<Index> {
    Ok(load(state, INDEX).await?.unwrap_or(Index { v: VERSION, ..Index::default() }))
}

fn client_key(id: &str) -> String {
    format!("c:{id}")
}

fn session_key(sid: &str) -> String {
    format!("s:{sid}")
}

fn valid_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Remove sessions (by sid) and their index entries. Under `oauth.lock`.
async fn drop_sessions(state: &AppState, index: &mut Index, sids: &[String]) -> io::Result<()> {
    for sid in sids {
        state.store.delete(NS, &session_key(sid)).await?;
    }
    index.sessions.retain(|s| !sids.contains(&s.sid));
    save(state, INDEX, index).await
}

/// Remove one session. Under `oauth.lock`.
async fn end_session(state: &AppState, sid: &str) -> io::Result<()> {
    let mut index = load_index(state).await?;
    drop_sessions(state, &mut index, &[sid.to_owned()]).await
}

// ---- registration

/// A redirect URI a public client may register: https, or http to this machine's loopback (a desktop client), with
/// no fragment and nothing that reads differently from how it matches.
fn valid_redirect(uri: &str) -> bool {
    if uri.len() > URI_MAX || uri.contains('#') {
        return false;
    }
    let Ok(url) = url::Url::parse(uri) else { return false };
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some()
        && (url.scheme() == "https" || (url.scheme() == "http" && loopback))
}

/// A client's name as a person reads it on the consent page: no control, bidi or zero-width characters.
fn clean_name(name: &str) -> Option<String> {
    let name = name.trim();
    let bad = |c: char| {
        c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
    };
    ((1..=NAME_MAX).contains(&name.chars().count()) && !name.chars().any(bad)).then(|| name.to_owned())
}

async fn register(state: &AppState, oauth: &OAuth, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-register:{ip}"), REGISTER_PER_WINDOW) {
        return limited;
    }
    let body = match crate::handler::read_json(req, 16 * 1024).await {
        Ok(body) => body,
        Err(_) => return oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "a JSON body"),
    };
    let uris: Vec<String> = body
        .get("redirect_uris")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|u| u.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    if uris.is_empty() || uris.len() > MAX_REDIRECTS || !uris.iter().all(|u| valid_redirect(u)) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_redirect_uri",
            "one to five https redirect URIs (http only to loopback), without a fragment",
        );
    }
    // Only the code flow, with refresh tokens. A client asking for anything else is told what it gets instead.
    let grant_types = body.get("grant_types").and_then(Value::as_array);
    if grant_types.is_some_and(|g| {
        !g.iter().all(|t| matches!(t.as_str(), Some("authorization_code" | "refresh_token")))
    }) {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "authorization_code only");
    }
    let name = body.get("client_name").and_then(Value::as_str).and_then(clean_name).unwrap_or_else(|| {
        url::Url::parse(&uris[0]).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
    });
    let now = state.now();
    let client = Client {
        v: VERSION,
        id: random_id(),
        name,
        redirect_uris: uris,
        created_at: now,
        used: false,
        consented_at: 0,
    };
    let _lock = oauth.lock.lock().await;
    let mut index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("oauth index", e),
    };
    // Registering is open to anyone, so a full table makes room by dropping the oldest registration nobody ever
    // consented to, rather than refusing everyone after it; only a table of clients people use is full.
    if index.clients.len() >= MAX_CLIENTS {
        match oldest_unused(state, &index).await {
            Ok(Some(id)) => {
                if let Err(e) = state.store.delete(NS, &client_key(&id)).await {
                    return internal("oauth client delete", e);
                }
                index.clients.retain(|c| c.id != id);
            }
            Ok(None) => {
                return oauth_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "temporarily_unavailable",
                    "too many clients",
                )
            }
            Err(e) => return internal("oauth client read", e),
        }
    }
    if let Err(e) = save(state, &client_key(&client.id), &client).await {
        return internal("oauth client write", e);
    }
    index.clients.push(IndexClient { id: client.id.clone(), created_at: now });
    if let Err(e) = save(state, INDEX, &index).await {
        return internal("oauth index write", e);
    }
    json_reply(
        StatusCode::CREATED,
        &json!({
            "client_id": client.id,
            "client_id_issued_at": now / 1000,
            "client_name": client.name,
            "redirect_uris": client.redirect_uris,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": SCOPE,
        }),
    )
}

/// The oldest registration no consent was ever given to. Under `oauth.lock`.
async fn oldest_unused(state: &AppState, index: &Index) -> io::Result<Option<String>> {
    let mut by_age: Vec<&IndexClient> = index.clients.iter().collect();
    by_age.sort_by_key(|c| c.created_at);
    for entry in by_age {
        match load::<Client>(state, &client_key(&entry.id)).await? {
            Some(client) if client.used => {}
            _ => return Ok(Some(entry.id.clone())),
        }
    }
    Ok(None)
}

// ---- authorization

/// The registered redirect `given` names: the same URI, or — for an app on this computer — the same loopback URI on
/// any port, which RFC 8252 §7.3 has the server allow, since a desktop app takes whatever port is free at the time.
fn registered_redirect(registered: &[String], given: &str) -> bool {
    if registered.iter().any(|r| r == given) {
        return true;
    }
    let Ok(given) = url::Url::parse(given) else { return false };
    let loopback = |u: &url::Url| {
        u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
    };
    loopback(&given)
        && registered.iter().filter_map(|r| url::Url::parse(r).ok()).any(|r| {
            loopback(&r)
                && r.host_str() == given.host_str()
                && r.path() == given.path()
                && r.query() == given.query()
                && r.fragment().is_none()
                && given.fragment().is_none()
        })
}

/// An authorization that cannot go ahead, said on Den's own page. Never a redirect: before a person has said yes,
/// a registered redirect URI is only what some client chose, and sending the browser there on an error would make
/// this server an open redirector for anyone who registers one.
fn error_page(detail: &str) -> Response {
    let escape =
        |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let html = format!(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" \
         content=\"width=device-width,initial-scale=1\"><title>Den — can't connect</title>\
         <body style=\"font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem\">\
         <h1 style=\"font-size:1.3rem\">This connection can't go ahead</h1><p>{}</p>\
         <p>Start connecting again from the assistant.</p></body></html>",
        escape(detail)
    );
    let mut resp = Response::new(Body::from(html));
    *resp.status_mut() = StatusCode::BAD_REQUEST;
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

fn query_map(req: &Request) -> HashMap<String, String> {
    url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes()).into_owned().collect()
}

/// `redirect_uri` with the answer's parameters added.
fn with_params(redirect_uri: &str, params: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(redirect_uri).expect("a registered redirect URI parses");
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in params {
            pairs.append_pair(k, v);
        }
    }
    url.to_string()
}

fn redirect(to: &str) -> Response {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::FOUND;
    if let Ok(location) = HeaderValue::from_str(to) {
        resp.headers_mut().insert(header::LOCATION, location);
    }
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

/// A PKCE challenge as S256 writes it: 43 base64url characters.
fn valid_challenge(c: &str) -> bool {
    c.len() == 43 && b64url_decode(c).is_some_and(|b| b.len() == 32)
}

async fn authorize(state: &AppState, oauth: &OAuth, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-authorize:{ip}"), AUTHORIZE_PER_WINDOW) {
        return limited;
    }
    let q = query_map(&req);
    let get = |k: &str| q.get(k).map(String::as_str);
    // Nothing is redirected before a person has said yes (`error_page`): every refusal here is said on Den's page.
    let Some(client_id) = get("client_id").filter(|id| valid_id(id)) else {
        return error_page("The assistant named no client Den knows.");
    };
    let client: Client = match load(state, &client_key(client_id)).await {
        Ok(Some(client)) => client,
        Ok(None) => return error_page("The assistant named no client Den knows."),
        Err(e) => return internal("oauth client read", e),
    };
    let redirect_uri = match get("redirect_uri") {
        Some(uri) if registered_redirect(&client.redirect_uris, uri) => uri.to_owned(),
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        _ => return error_page("The assistant asked for its answer at an address it did not register."),
    };
    let state_param = get("state").map(str::to_owned);
    if state_param.as_ref().is_some_and(|s| s.len() > STATE_MAX) {
        return error_page("The assistant's request is too long.");
    }
    if get("response_type") != Some("code") {
        return error_page(
            "The assistant asked for a kind of answer Den does not give (response_type code only).",
        );
    }
    let Some(challenge) = get("code_challenge").filter(|c| valid_challenge(c)) else {
        return error_page("The assistant did not use PKCE, which Den requires (code_challenge, S256).");
    };
    if get("code_challenge_method") != Some("S256") {
        return error_page("The assistant used a PKCE method Den does not take (S256 only).");
    }
    if get("resource").is_some_and(|r| r.trim_end_matches('/') != oauth.resource) {
        return error_page("The assistant asked to connect to something other than Den's search (/mcp).");
    }
    if get("scope").is_some_and(|s| s.split(' ').any(|s| !s.is_empty() && s != SCOPE)) {
        return error_page("The assistant asked for more than Den gives: searching only (den:search).");
    }
    let now = state.now();
    let id = random_id();
    {
        let mut pending = crate::lock(&oauth.pending);
        pending.retain(|_, p| p.until > now);
        // Full, in all or for this client: the oldest waiting request makes room, so a flood of unanswered requests
        // cannot lock anyone else out; a person answers within minutes or not at all.
        let oldest = |pending: &HashMap<String, Pending>, client: Option<&str>| {
            pending
                .iter()
                .filter(|(_, p)| client.is_none_or(|c| p.client_id == c))
                .min_by_key(|(_, p)| (p.until, p.seq))
                .map(|(k, _)| k.clone())
        };
        let seq = pending.values().map(|p| p.seq + 1).max().unwrap_or(0);
        if pending.values().filter(|p| p.client_id == client.id).count() >= MAX_PENDING_PER_CLIENT {
            if let Some(key) = oldest(&pending, Some(&client.id)) {
                pending.remove(&key);
            }
        }
        if pending.len() >= MAX_PENDING {
            if let Some(key) = oldest(&pending, None) {
                pending.remove(&key);
            }
        }
        pending.insert(
            id.clone(),
            Pending {
                client_id: client.id,
                client_name: client.name,
                redirect_uri,
                challenge: challenge.to_owned(),
                state: state_param,
                until: now + PENDING_MS,
                seq,
            },
        );
    }
    redirect(&format!("{}/connect?request={id}", oauth.consent_origin))
}

fn redirect_host(uri: &str) -> Option<String> {
    url::Url::parse(uri).ok().and_then(|u| u.host_str().map(str::to_owned))
}

/// The hosts known to be the assistants' own, where a connection's answer goes back to. A client names itself
/// whatever it likes at registration, so the consent page leads with where the answer goes, and marks it known only
/// for these — and for an app on this very computer (loopback), which only its own person can be running.
const KNOWN_ASSISTANT_HOSTS: &[&str] = &["claude.ai", "chatgpt.com"];

fn known_host(host: &str) -> bool {
    KNOWN_ASSISTANT_HOSTS.contains(&host) || matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

fn request_info(state: &AppState, oauth: &OAuth, req: Request, id: &str) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-consent:{ip}"), CONSENT_PER_WINDOW * 2) {
        return limited;
    }
    let now = state.now();
    let pending = crate::lock(&oauth.pending);
    match pending.get(id).filter(|p| p.until > now) {
        Some(p) => {
            let host = redirect_host(&p.redirect_uri);
            let verified = host.as_deref().is_some_and(known_host);
            json_reply(
                StatusCode::OK,
                &json!({ "client": p.client_name, "redirectHost": host, "verified": verified, "scope": SCOPE }),
            )
        }
        None => json_reply(StatusCode::NOT_FOUND, &error("request_expired")),
    }
}

/// The proofs a request carries: a member's (`x-den-library-member`) and a guest's (`x-den-grant`).
fn proofs(req: &Request) -> (Option<String>, Option<String>) {
    let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    (header(crate::library::MEMBER_HEADER), header(crate::grants::HEADER))
}

/// Whom a request's proof names: a member, or a guest with a live grant. A member's claim that fails is not tried
/// as a guest's.
async fn who(state: &AppState, (member, grant): (Option<String>, Option<String>)) -> Option<Who> {
    if let Some(claim) = member {
        if crate::library::is_member(state, Some(&claim)).await {
            let (library, token) = claim.split_once(':')?;
            return Some(Who::Member { library: library.to_owned(), member_hash: sha(token.as_bytes()) });
        }
        return None;
    }
    let live = crate::grants::authenticate(state, grant.as_deref(), None).await.ok()?;
    Some(Who::Guest { gid: live.gid, host: live.host, name: live.name })
}

async fn consent(state: &AppState, oauth: &OAuth, req: Request, id: &str, approve: bool) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-consent:{ip}"), CONSENT_PER_WINDOW) {
        return limited;
    }
    let now = state.now();
    let who = if approve {
        match who(state, proofs(&req)).await {
            Some(who) => Some(who),
            None => return json_reply(StatusCode::FORBIDDEN, &error("not_a_member")),
        }
    } else {
        None
    };
    let Some(pending) = crate::lock(&oauth.pending).remove(id).filter(|p| p.until > now) else {
        return json_reply(StatusCode::NOT_FOUND, &error("request_expired"));
    };
    let mut params = vec![("iss", oauth.issuer.clone())];
    if let Some(s) = &pending.state {
        params.push(("state", s.clone()));
    }
    match who {
        Some(who) => {
            let code = b64url(&crate::random_bytes::<32>());
            {
                let mut codes = crate::lock(&oauth.codes);
                codes.retain(|_, c| c.until > now);
                codes.insert(
                    sha(code.as_bytes()),
                    Code {
                        client_id: pending.client_id.clone(),
                        redirect_uri: pending.redirect_uri.clone(),
                        challenge: pending.challenge,
                        who,
                        until: now + CODE_MS,
                    },
                );
            }
            params.push(("code", code));
            // A client that was consented to is kept past the day an unused registration is, and for
            // `IDLE_CLIENT_MS` after the last consent once it has no connection left.
            let _lock = oauth.lock.lock().await;
            if let Ok(Some(mut client)) = load::<Client>(state, &client_key(&pending.client_id)).await {
                client.used = true;
                client.consented_at = now;
                if let Err(e) = save(state, &client_key(&client.id), &client).await {
                    eprintln!("oauth client write: {e}");
                }
            }
        }
        None => {
            params.push(("error", "access_denied".to_owned()));
        }
    }
    let pairs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
    json_reply(StatusCode::OK, &json!({ "redirect": with_params(&pending.redirect_uri, &pairs) }))
}

// ---- tokens

/// A token request's parameters: form-encoded as OAuth asks, or JSON, which some clients send.
async fn params_of(req: Request) -> Option<HashMap<String, String>> {
    let json = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("application/json"));
    let bytes = axum::body::to_bytes(req.into_body(), 16 * 1024).await.ok()?;
    if json {
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        return Some(
            value
                .as_object()?
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                .collect(),
        );
    }
    Some(url::form_urlencoded::parse(&bytes).into_owned().collect())
}

/// An access token for `session`: a compact JWS, `EdDSA`, RFC 9068's claims. A guest's never outlasts the grant.
fn access_token(oauth: &OAuth, session: &Session, now_ms: u64, grant_end: Option<u64>) -> (String, u64) {
    let now = now_ms / 1000;
    let exp = grant_end.map_or(now + ACCESS_TTL_S, |end| (now + ACCESS_TTL_S).min(end / 1000));
    let header = json!({ "alg": "EdDSA", "typ": "at+jwt", "kid": oauth.kid });
    let claims = json!({
        "iss": oauth.issuer,
        "aud": oauth.resource,
        "sub": session.sid,
        "client_id": session.client_id,
        "scope": SCOPE,
        "kind": session.who.kind(),
        "iat": now,
        "exp": exp,
        "jti": random_id(),
    });
    let signed =
        format!("{}.{}", b64url(header.to_string().as_bytes()), b64url(claims.to_string().as_bytes()));
    let signature = oauth.key.sign(signed.as_bytes()).to_bytes();
    (format!("{signed}.{}", b64url(&signature)), exp.saturating_sub(now))
}

fn token_reply(access: String, expires_in: u64, refresh: String) -> Response {
    let mut resp = json_reply(
        StatusCode::OK,
        &json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "refresh_token": refresh,
            "scope": SCOPE,
        }),
    );
    resp.headers_mut().insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    resp
}

/// Whether the one a session speaks for still stands, and until when a guest's access lasts. `None` when it does
/// not: a revoked, expired or shortened grant, or a library whose member token changed. An error when that could not
/// be read, which ends nothing.
async fn still_stands(state: &AppState, who: &Who) -> io::Result<Option<Option<u64>>> {
    match who {
        Who::Member { library, member_hash } => {
            let Some(hash) = hex_bytes::<32>(member_hash) else { return Ok(None) };
            Ok(crate::library::holds_member_hash(state, library, &hash).await?.then_some(None))
        }
        Who::Guest { gid, .. } => crate::grants::standing(state, gid).await,
    }
}

fn hex_bytes<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

async fn token(state: &AppState, oauth: &OAuth, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-token:{ip}"), TOKEN_PER_WINDOW) {
        return limited;
    }
    let Some(p) = params_of(req).await else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "a form-encoded body");
    };
    let get = |k: &str| p.get(k).map(String::as_str);
    match get("grant_type") {
        Some("authorization_code") => exchange(state, oauth, &p).await,
        Some("refresh_token") => refresh(state, oauth, get("refresh_token"), get("client_id")).await,
        _ => oauth_error(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            "authorization_code or refresh_token",
        ),
    }
}

async fn exchange(state: &AppState, oauth: &OAuth, p: &HashMap<String, String>) -> Response {
    let get = |k: &str| p.get(k).map(String::as_str);
    let now = state.now();
    let invalid = |why: &str| oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", why);
    // Taken out on first sight: a code is good once, whatever the outcome.
    let Some(code) = get("code").and_then(|c| crate::lock(&oauth.codes).remove(&sha(c.as_bytes()))) else {
        return invalid("unknown or used code");
    };
    if code.until <= now {
        return invalid("the code expired");
    }
    if get("client_id") != Some(code.client_id.as_str()) {
        return invalid("the code was issued to another client");
    }
    if get("redirect_uri").is_some_and(|r| r != code.redirect_uri) {
        return invalid("redirect_uri differs from the authorization request's");
    }
    let verifier = get("code_verifier").unwrap_or("");
    let verified = (43..=128).contains(&verifier.len())
        && verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        && constant_time_eq(
            b64url(&Sha256::digest(verifier.as_bytes())).as_bytes(),
            code.challenge.as_bytes(),
        );
    if !verified {
        return invalid("code_verifier does not match the code_challenge");
    }
    let grant_end = match still_stands(state, &code.who).await {
        Ok(Some(end)) => end,
        Ok(None) => return invalid("the membership or invite behind this approval has ended"),
        Err(e) => return internal("oauth standing", e),
    };
    let client_name = match load::<Client>(state, &client_key(&code.client_id)).await {
        Ok(Some(client)) => client.name,
        Ok(None) => return invalid("the client is no longer registered"),
        Err(e) => return internal("oauth client read", e),
    };
    let secret = b64url(&crate::random_bytes::<32>());
    let session = Session {
        v: VERSION,
        sid: random_id(),
        client_id: code.client_id,
        client_name,
        redirect_host: redirect_host(&code.redirect_uri),
        who: code.who,
        refresh_hash: sha(secret.as_bytes()),
        previous_hash: None,
        rotated_at: 0,
        retired: Vec::new(),
        created_at: now,
        used_at: now,
    };
    let _lock = oauth.lock.lock().await;
    let mut index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("oauth index", e),
    };
    let host = session.who.host().to_owned();
    // A guest's connections are capped on their own, so one invite cannot use up its host's.
    let grant_full = match &session.who {
        Who::Guest { gid, .. } => {
            index.sessions.iter().filter(|s| s.gid.as_deref() == Some(gid.as_str())).count()
                >= MAX_SESSIONS_PER_GRANT
        }
        Who::Member { .. } => false,
    };
    if grant_full
        || index.sessions.len() >= MAX_SESSIONS
        || index.sessions.iter().filter(|s| s.host == host).count() >= MAX_SESSIONS_PER_HOST
    {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "too many connections: revoke one first",
        );
    }
    if let Err(e) = save(state, &session_key(&session.sid), &session).await {
        return internal("oauth session write", e);
    }
    let gid = match &session.who {
        Who::Guest { gid, .. } => Some(gid.clone()),
        Who::Member { .. } => None,
    };
    index.sessions.push(IndexSession { sid: session.sid.clone(), host, gid });
    if let Err(e) = save(state, INDEX, &index).await {
        return internal("oauth index write", e);
    }
    let (access, expires_in) = access_token(oauth, &session, now, grant_end);
    token_reply(access, expires_in, format!("{}.{secret}", session.sid))
}

async fn refresh(state: &AppState, oauth: &OAuth, token: Option<&str>, client_id: Option<&str>) -> Response {
    let invalid = |why: &str| oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", why);
    let Some((sid, secret)) = token.and_then(|t| t.split_once('.')).filter(|(sid, _)| valid_id(sid)) else {
        return invalid("unknown refresh token");
    };
    let now = state.now();
    let _lock = oauth.lock.lock().await;
    let mut session: Session = match load(state, &session_key(sid)).await {
        Ok(Some(session)) => session,
        Ok(None) => return invalid("unknown refresh token"),
        Err(e) => return internal("oauth session read", e),
    };
    // A public client names itself on every refresh (OAuth 2.1 §4.3.1), and only the client the session is for may.
    if client_id != Some(session.client_id.as_str()) {
        return invalid("client_id is required, and must be the client the token was issued to");
    }
    let presented = sha(secret.as_bytes());
    let is = |hash: &str| constant_time_eq(hash.as_bytes(), presented.as_bytes());
    let current = is(&session.refresh_hash);
    // The token the last refresh replaced, presented again within the grace: the client never got that answer and
    // retried. It gets a fresh pair, and the one it never received is retired.
    let retry = !current
        && session.previous_hash.as_deref().is_some_and(is)
        && now < session.rotated_at + REFRESH_GRACE_MS;
    if !current && !retry {
        // A replaced token presented after the grace, or any older one: two holders of one session. End it for both.
        let reused =
            session.previous_hash.as_deref().is_some_and(is) || session.retired.iter().any(|h| is(h));
        if reused {
            eprintln!("oauth: a replaced refresh token was used again ({sid}) — ending the session");
            if let Err(e) = end_session(state, sid).await {
                return internal("oauth session delete", e);
            }
        }
        return invalid("unknown refresh token");
    }
    let stands =
        if now >= session.used_at + IDLE_MS { Ok(None) } else { still_stands(state, &session.who).await };
    let grant_end = match stands {
        Ok(Some(end)) => end,
        Ok(None) => {
            if let Err(e) = end_session(state, sid).await {
                return internal("oauth session delete", e);
            }
            return invalid("the connection has ended");
        }
        Err(e) => return internal("oauth standing", e),
    };
    let secret = b64url(&crate::random_bytes::<32>());
    let replaced = std::mem::replace(&mut session.refresh_hash, sha(secret.as_bytes()));
    if retry {
        // The secret the lost answer carried is never valid, and the retry allowance is consumed: accepting the
        // same old token repeatedly would let it retire each newly issued token throughout the grace window.
        session.retired.push(replaced);
        session.retired.extend(session.previous_hash.take());
    } else {
        session.retired.extend(session.previous_hash.replace(replaced));
        session.rotated_at = now;
    }
    let excess = session.retired.len().saturating_sub(RETIRED_KEPT);
    session.retired.drain(..excess);
    session.used_at = now;
    if let Err(e) = save(state, &session_key(sid), &session).await {
        return internal("oauth session write", e);
    }
    let (access, expires_in) = access_token(oauth, &session, now, grant_end);
    token_reply(access, expires_in, format!("{sid}.{secret}"))
}

/// RFC 7009: the session a token was issued in ends — for its refresh token, one a refresh replaced (the client may
/// not have had the answer), or an access token, which is only as good as its session. An unknown token is
/// answered the same, as the RFC asks.
async fn revoke(state: &AppState, oauth: &OAuth, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-token:{ip}"), TOKEN_PER_WINDOW) {
        return limited;
    }
    let Some(p) = params_of(req).await else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "a form-encoded body");
    };
    let token = p.get("token").map_or("", String::as_str);
    // An access token is a signed JWS naming its session; a refresh token is `<sid>.<secret>`.
    let access = session_of(oauth, Some(&format!("Bearer {token}")), state.now() / 1000);
    let refresh = token.split_once('.').filter(|(sid, _)| valid_id(sid));
    let Some(sid) = access.as_deref().or(refresh.map(|(sid, _)| sid)) else {
        return json_reply(StatusCode::OK, &json!({}));
    };
    let _lock = oauth.lock.lock().await;
    let session = match load::<Session>(state, &session_key(sid)).await {
        Ok(Some(session)) => session,
        Ok(None) => return json_reply(StatusCode::OK, &json!({})),
        Err(e) => return internal("oauth session read", e),
    };
    let issued = access.is_some()
        || refresh.is_some_and(|(_, secret)| {
            let presented = sha(secret.as_bytes());
            let is = |hash: &String| constant_time_eq(hash.as_bytes(), presented.as_bytes());
            is(&session.refresh_hash) || session.previous_hash.iter().chain(&session.retired).any(is)
        });
    if issued {
        if let Err(e) = end_session(state, sid).await {
            return internal("oauth session delete", e);
        }
    }
    json_reply(StatusCode::OK, &json!({}))
}

// ---- Settings › Assistants

/// The connections a request's proof may see and end: a member sees its library's, its guests' included; a guest
/// sees those made in its grant's name.
fn visible(who: &Who, entry: &IndexSession) -> bool {
    match who {
        Who::Member { library, .. } => entry.host == *library,
        Who::Guest { gid, .. } => entry.gid.as_deref() == Some(gid.as_str()),
    }
}

async fn connections(state: &AppState, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-consent:{ip}"), CONSENT_PER_WINDOW * 2) {
        return limited;
    }
    let Some(who) = who(state, proofs(&req)).await else {
        return json_reply(StatusCode::FORBIDDEN, &error("not_a_member"));
    };
    let index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("oauth index", e),
    };
    let mut listed = Vec::new();
    for entry in index.sessions.iter().filter(|e| visible(&who, e)) {
        match load::<Session>(state, &session_key(&entry.sid)).await {
            Ok(Some(s)) => listed.push(json!({
                "sid": s.sid,
                "client": s.client_name,
                "redirectHost": s.redirect_host,
                "kind": s.who.kind(),
                "guest": match &s.who { Who::Guest { name, .. } => Some(name.clone()), Who::Member { .. } => None },
                "createdAt": s.created_at,
                "usedAt": s.used_at,
            })),
            Ok(None) => {}
            Err(e) => return internal("oauth session read", e),
        }
    }
    json_reply(StatusCode::OK, &json!({ "connections": listed }))
}

async fn disconnect(state: &AppState, req: Request, sid: &str) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-consent:{ip}"), CONSENT_PER_WINDOW) {
        return limited;
    }
    let (Some(oauth), true) = (state.oauth.as_ref(), valid_id(sid)) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let Some(who) = who(state, proofs(&req)).await else {
        return json_reply(StatusCode::FORBIDDEN, &error("not_a_member"));
    };
    let _lock = oauth.lock.lock().await;
    let mut index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("oauth index", e),
    };
    if !index.sessions.iter().any(|e| e.sid == sid && visible(&who, e)) {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    }
    if let Err(e) = drop_sessions(state, &mut index, &[sid.to_owned()]).await {
        return internal("oauth session delete", e);
    }
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    resp
}

/// End every connection made in a grant's name: it was revoked, left or expired (`grants::end_sessions`).
pub async fn end_grant(state: &AppState, gid: &str) {
    let Some(oauth) = state.oauth.as_ref() else { return };
    let _lock = oauth.lock.lock().await;
    let result = async {
        let mut index = load_index(state).await?;
        let sids: Vec<String> =
            index.sessions.iter().filter(|e| e.gid.as_deref() == Some(gid)).map(|e| e.sid.clone()).collect();
        if sids.is_empty() {
            return Ok(());
        }
        drop_sessions(state, &mut index, &sids).await
    };
    if let Err(e) = result.await {
        eprintln!("oauth: ending the connections of grant {gid}: {e}");
    }
}

/// One pass: end idle sessions and those whose member or grant no longer stands, and reap registrations never used.
pub async fn sweep(state: &AppState) {
    let Some(oauth) = state.oauth.as_ref() else { return };
    let now = state.now();
    let index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => {
            eprintln!("oauth sweep: {e}");
            return;
        }
    };
    let mut ended = Vec::new();
    // The clients a connection still stands for.
    let mut connected: Vec<String> = Vec::new();
    for entry in &index.sessions {
        match load::<Session>(state, &session_key(&entry.sid)).await {
            Ok(Some(s)) if now < s.used_at + IDLE_MS => match still_stands(state, &s.who).await {
                Ok(Some(_)) => connected.push(s.client_id),
                Ok(None) => ended.push(entry.sid.clone()),
                // Not known to have ended, so it is kept, and its client with it.
                Err(e) => {
                    eprintln!("oauth sweep: {e}");
                    connected.push(s.client_id);
                }
            },
            Ok(_) => ended.push(entry.sid.clone()),
            Err(e) => eprintln!("oauth sweep: {e}"),
        }
    }
    // A registration nobody ever consented to, a day on, is reaped: registering is open to anyone. So is one that
    // was consented to but has had no connection for `IDLE_CLIENT_MS` since: an assistant that comes back
    // registers again.
    let mut unused = Vec::new();
    for entry in index.clients.iter().filter(|c| now >= c.created_at + UNUSED_CLIENT_MS) {
        match load::<Client>(state, &client_key(&entry.id)).await {
            Ok(Some(client)) if !client.used => unused.push(entry.id.clone()),
            Ok(Some(client)) => {
                let last = client.consented_at.max(client.created_at);
                if !connected.contains(&client.id) && now >= last + IDLE_CLIENT_MS {
                    unused.push(entry.id.clone());
                }
            }
            Ok(None) => unused.push(entry.id.clone()),
            Err(e) => eprintln!("oauth sweep: {e}"),
        }
    }
    if ended.is_empty() && unused.is_empty() {
        return;
    }
    let _lock = oauth.lock.lock().await;
    let result = async {
        let mut index = load_index(state).await?;
        // Only those still unused: a consent given since they were read renews them.
        let mut reaped = Vec::new();
        for id in &unused {
            match load::<Client>(state, &client_key(id)).await? {
                Some(c) if c.used && now < c.consented_at.max(c.created_at) + IDLE_CLIENT_MS => {}
                Some(c) if c.used && connected.contains(&c.id) => {}
                _ => {
                    state.store.delete(NS, &client_key(id)).await?;
                    reaped.push(id.clone());
                }
            }
        }
        index.clients.retain(|c| !reaped.contains(&c.id));
        // Only those still ended: a session refreshed since it was read is no longer idle.
        let mut still = Vec::new();
        for sid in &ended {
            match load::<Session>(state, &session_key(sid)).await? {
                // Kept unless it is known to have ended: a failed read is not a revocation.
                Some(s)
                    if now < s.used_at + IDLE_MS
                        && !matches!(still_stands(state, &s.who).await, Ok(None)) => {}
                _ => still.push(sid.clone()),
            }
        }
        drop_sessions(state, &mut index, &still).await
    };
    if let Err(e) = result.await {
        eprintln!("oauth sweep: {e}");
    }
}

pub async fn sweep_forever(state: std::sync::Arc<AppState>) {
    loop {
        tokio::time::sleep(SWEEP_EVERY).await;
        sweep(&state).await;
    }
}

// ---- /mcp

/// The session an access token names, when its signature is this server's and it is for the MCP resource and in date.
/// den-mcp checks it again; this is so the relay can look the session up before anything reaches den-mcp.
fn session_of(oauth: &OAuth, authorization: Option<&str>, now_s: u64) -> Option<String> {
    // The scheme is case-insensitive (RFC 9110 §11.1).
    let (scheme, token) = authorization?.trim_start().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    let mut parts = token.split('.');
    let (head, body, sig) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Value = serde_json::from_slice(&b64url_decode(head)?).ok()?;
    if header.get("alg").and_then(Value::as_str) != Some("EdDSA") {
        return None;
    }
    // An access token (RFC 9068), not any other JWT this key might one day sign.
    let typ = header.get("typ").and_then(Value::as_str).unwrap_or("");
    if !typ.eq_ignore_ascii_case("at+jwt") && !typ.eq_ignore_ascii_case("application/at+jwt") {
        return None;
    }
    let sig: [u8; 64] = b64url_decode(sig)?.try_into().ok()?;
    let signed = &token.as_bytes()[..head.len() + 1 + body.len()];
    oauth.verifying_key().verify_strict(signed, &ed25519_dalek::Signature::from_bytes(&sig)).ok()?;
    let claims: Value = serde_json::from_slice(&b64url_decode(body)?).ok()?;
    let fresh = claims.get("exp").and_then(Value::as_u64).is_some_and(|exp| now_s <= exp + 30);
    let ours = claims.get("iss").and_then(Value::as_str) == Some(oauth.issuer.as_str())
        && claims.get("aud").and_then(Value::as_str) == Some(oauth.resource.as_str());
    let sid = claims.get("sub").and_then(Value::as_str).filter(|s| valid_id(s))?;
    (fresh && ours).then(|| sid.to_owned())
}

fn unauthorized(oauth: &OAuth, invalid: bool) -> Response {
    let mut challenge = format!("Bearer realm=\"den\", resource_metadata=\"{}\"", oauth.resource_metadata());
    if invalid {
        challenge.push_str(", error=\"invalid_token\"");
    }
    let mut resp = json_reply(StatusCode::UNAUTHORIZED, &error("unauthorized"));
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        resp.headers_mut().insert(header::WWW_AUTHENTICATE, value);
    }
    resp
}

/// `/mcp`: the token's session must still exist, and the member or grant behind it still stand, on every call — that
/// is what makes a revocation immediate — then the call goes to den-mcp.
async fn gate_mcp(state: &AppState, oauth: &OAuth, req: Request, rid: &str) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate_steady(state, format!("mcp-gate:{ip}"), MCP_GATE_PER_WINDOW) {
        return limited;
    }
    // A real CORS preflight carries no token, by design; it is still relayed, so it is counted and takes a slot.
    // A bare OPTIONS is not a preflight and must not become an unauthenticated body-buffering path.
    let preflight = req.method() == Method::OPTIONS
        && req.headers().contains_key(header::ORIGIN)
        && req
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|m| matches!(m, "GET" | "POST"));
    if req.method() == Method::OPTIONS && !preflight {
        return json_reply(StatusCode::METHOD_NOT_ALLOWED, &error("method_not_allowed"));
    }
    if !preflight {
        let authorization = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
        let Some(sid) = session_of(oauth, authorization, state.now() / 1000) else {
            return unauthorized(oauth, authorization.is_some());
        };
        let session: Session = match load(state, &session_key(&sid)).await {
            Ok(Some(session)) => session,
            Ok(None) => return unauthorized(oauth, true),
            Err(e) => return internal("oauth session read", e),
        };
        match still_stands(state, &session.who).await {
            Ok(Some(_)) => {}
            Ok(None) => return unauthorized(oauth, true),
            Err(e) => return internal("oauth standing", e),
        }
        if let Some(limited) = gate_steady(state, format!("mcp:{sid}"), MCP_PER_SESSION) {
            return limited;
        }
    }
    // The body is read before a call slot is taken, and in bounded time: one sent slowly must not hold a call slot.
    // Its separate admission permit bounds how many bodies can be buffered or stalled at once.
    let Ok(body_slot) = std::sync::Arc::clone(&oauth.mcp_body_slots).try_acquire_owned() else {
        return retry_after(StatusCode::SERVICE_UNAVAILABLE, &error("busy"), 2_000);
    };
    let (parts, body) = req.into_parts();
    let body = match tokio::time::timeout(
        MCP_BODY_TIMEOUT,
        axum::body::to_bytes(body, crate::handler::MAX_BODY_BYTES),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("payload_too_large")),
        Err(_) => return json_reply(StatusCode::REQUEST_TIMEOUT, &error("request_timeout")),
    };
    drop(body_slot);
    let req = Request::from_parts(parts, Body::from(body));
    // At most `MCP_IN_FLIGHT` calls at den-mcp at once from here, whoever makes them: past that, come back shortly.
    let Ok(slot) = std::sync::Arc::clone(&oauth.mcp_slots).try_acquire_owned() else {
        return retry_after(StatusCode::SERVICE_UNAVAILABLE, &error("busy"), 2_000);
    };
    let call = req.method() == Method::POST;
    let resp = relay_mcp(state, req, rid).await;
    if !call {
        return resp;
    }
    // A call's answer may be an event stream (Streamable HTTP), and the call is at den-mcp until it ends, so the slot
    // goes with the answer. A GET is not held: it opens the stream den-mcp may speak first on, which stays open.
    let slot = std::sync::Arc::new(HeldSlot {
        permit: Mutex::new(Some(slot)),
        sent: Mutex::new(tokio::time::Instant::now()),
    });
    tokio::spawn(release_when_idle(std::sync::Arc::downgrade(&slot)));
    resp.map(|body| Body::new(Held { body, slot }))
}

/// An answer that holds its `/mcp` slot until its last frame, until it is dropped unfinished, or until it has gone
/// `MCP_ANSWER_IDLE` without a frame. Unbounded, an answer that stalled mid-stream or a caller that never read it held
/// a slot for as long as the connection stayed open, and 32 of them refused every call until a restart.
struct Held {
    body: Body,
    slot: std::sync::Arc<HeldSlot>,
}

struct HeldSlot {
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
    /// When the answer last passed on a frame (or began).
    sent: Mutex<tokio::time::Instant>,
}

/// Gives a held slot back once its answer has gone `MCP_ANSWER_IDLE` without a frame. A task of its own, not the
/// body's `poll_frame`: an answer nobody reads is not polled at all (as in `an_answer_that_goes_idle_gives_its_slot_back`),
/// which is what a caller that stopped reading is expected to look like here. The answer itself runs on.
async fn release_when_idle(slot: std::sync::Weak<HeldSlot>) {
    loop {
        let Some(held) = slot.upgrade() else { return };
        let deadline = *crate::lock(&held.sent) + MCP_ANSWER_IDLE;
        if deadline <= tokio::time::Instant::now() {
            crate::lock(&held.permit).take();
            return;
        }
        drop(held);
        tokio::time::sleep_until(deadline).await;
    }
}

impl http_body::Body for Held {
    type Data = axum::body::Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let frame = std::pin::Pin::new(&mut self.body).poll_frame(cx);
        match frame {
            std::task::Poll::Ready(Some(Ok(_))) => {
                *crate::lock(&self.slot.sent) = tokio::time::Instant::now()
            }
            std::task::Poll::Ready(None | Some(Err(_))) => drop(crate::lock(&self.slot.permit).take()),
            std::task::Poll::Pending => {}
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

/// den-mcp's LAN origin: the `/mcp` entry of `ADDON_RELAY`.
fn mcp_origin(state: &AppState) -> Option<&str> {
    state.relays.iter().find(|(prefix, _)| prefix == "/mcp").map(|(_, origin)| origin.as_str())
}

/// Relay to den-mcp, the answer streamed as it comes: Streamable HTTP may answer with an event stream, and nothing
/// here may hold one back until it ends.
async fn relay_mcp(state: &AppState, req: Request, rid: &str) -> Response {
    let Some(origin) = mcp_origin(state) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let method = req.method().clone();
    let target = format!("{origin}{}", req.uri().path_and_query().map_or("/mcp", |pq| pq.as_str()));
    let mut out = axum::http::Request::builder().method(method).uri(&target).header("x-request-id", rid);
    for name in [
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        header::ACCEPT,
        header::ORIGIN,
        header::ACCESS_CONTROL_REQUEST_METHOD,
        header::ACCESS_CONTROL_REQUEST_HEADERS,
    ]
    .into_iter()
    .chain(["mcp-protocol-version", "mcp-session-id", "last-event-id"].map(header::HeaderName::from_static))
    {
        if let Some(value) = req.headers().get(&name) {
            out = out.header(name, value.clone());
        }
    }
    let Ok(body) = axum::body::to_bytes(req.into_body(), crate::handler::MAX_BODY_BYTES).await else {
        return json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("payload_too_large"));
    };
    let Ok(out) = out.body(Full::new(body)) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
    };
    // The timeout covers reaching den-mcp and its answer's head; a stream then takes as long as it takes.
    let answer = match tokio::time::timeout(MCP_TIMEOUT, state.relay_client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("mcp relay: {e}");
            return json_reply(StatusCode::BAD_GATEWAY, &error("mcp_unreachable"));
        }
        Err(_) => return json_reply(StatusCode::GATEWAY_TIMEOUT, &error("mcp_timeout")),
    };
    let (parts, body) = answer.into_parts();
    let mut resp = Response::new(Body::new(body));
    *resp.status_mut() = parts.status;
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::WWW_AUTHENTICATE,
        header::RETRY_AFTER,
        header::ALLOW,
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::ACCESS_CONTROL_MAX_AGE,
    ]
    .into_iter()
    .chain(["mcp-session-id"].map(header::HeaderName::from_static))
    {
        if let Some(value) = parts.headers.get(&name) {
            resp.headers_mut().insert(name, value.clone());
        }
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, body_text, temp_dir, Harness};
    use std::sync::Arc;

    const ISSUER: &str = "https://den.example";
    const LIB: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "the-write-token";
    const REDIRECT: &str = "https://assistant.example/callback";
    const VERIFIER: &str = "a-pkce-code-verifier-of-at-least-forty-three-characters";
    const GUEST_SECRET: &str = "the-guests-device-secret-of-43-chars-000000";

    fn challenge(verifier: &str) -> String {
        b64url(&Sha256::digest(verifier.as_bytes()))
    }

    /// A fake den-mcp: says what it was sent, with the header a 401 carries passed back as it would be.
    async fn mcp() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|req: Request| async move {
            let seen = json!({
                "path": req.uri().path(),
                "authorization": req.headers().contains_key(header::AUTHORIZATION),
                "version": req.headers().get("mcp-protocol-version").map(|v| v.to_str().unwrap().to_owned()),
            });
            let mut resp = Response::new(Body::from(seen.to_string()));
            resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            resp.headers_mut().insert("mcp-session-id", HeaderValue::from_static("abc"));
            resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("x=1"));
            resp
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    async fn harness() -> Harness {
        let mcp = mcp().await;
        let h = Harness::in_dir_with(temp_dir(), |s| {
            s.oauth = Some(OAuth::new(ISSUER.into(), format!("{ISSUER}/mcp"), ISSUER.into(), [9u8; 32]));
            s.relays = crate::parse_relays(&format!("/mcp={mcp}"));
        });
        // The host's library, then a store closed to strangers, as guest grants require.
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let path = format!("/lib/{LIB}/batch");
        let started = h.send("POST", &path, Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK);
        let mut h = h;
        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Members;
        h
    }

    fn member() -> String {
        format!("{LIB}:{TOKEN}")
    }

    async fn register(h: &Harness) -> String {
        let (status, client) = h
            .call(
                "POST",
                "/oauth/register",
                Some(json!({ "client_name": "Claude", "redirect_uris": [REDIRECT],
                             "grant_types": ["authorization_code", "refresh_token"],
                             "token_endpoint_auth_method": "none" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{client}");
        assert_eq!(client["token_endpoint_auth_method"], "none");
        client["client_id"].as_str().unwrap().to_owned()
    }

    fn authorize_url(client: &str, extra: &str) -> String {
        format!(
            "/oauth/authorize?response_type=code&client_id={client}&redirect_uri={}&code_challenge={}\
             &code_challenge_method=S256&state=xyz&resource={}{extra}",
            url::form_urlencoded::byte_serialize(REDIRECT.as_bytes()).collect::<String>(),
            challenge(VERIFIER),
            url::form_urlencoded::byte_serialize(format!("{ISSUER}/mcp").as_bytes()).collect::<String>(),
        )
    }

    fn location(resp: &Response) -> String {
        resp.headers()[header::LOCATION].to_str().unwrap().to_owned()
    }

    fn query_of(location: &str) -> HashMap<String, String> {
        url::Url::parse(location).unwrap().query_pairs().into_owned().collect()
    }

    /// Authorize, and the consent request id Den Web's page is sent to.
    async fn request(h: &Harness, client: &str) -> String {
        let resp = h.send("GET", &authorize_url(client, ""), None, &[]).await;
        assert_eq!(resp.status(), StatusCode::FOUND);
        let to = location(&resp);
        let (page, id) = to.split_once("?request=").unwrap();
        assert_eq!(page, format!("{ISSUER}/connect"));
        id.to_owned()
    }

    async fn approve(h: &Harness, id: &str, proof: &[(&str, &str)]) -> (StatusCode, Value) {
        let resp = h.send("POST", &format!("/oauth/request/{id}/approve"), None, proof).await;
        let status = resp.status();
        (status, body_json(resp).await)
    }

    async fn post_form(h: &Harness, path: &str, form: &[(&str, &str)]) -> (StatusCode, Value) {
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
        let resp =
            h.send("POST", path, Some(body), &[("content-type", "application/x-www-form-urlencoded")]).await;
        let status = resp.status();
        (status, body_json(resp).await)
    }

    /// The whole flow for `proof`, to a token answer.
    async fn connect(h: &Harness, proof: &[(&str, &str)]) -> Value {
        let client = register(h).await;
        let id = request(h, &client).await;
        let (status, approved) = approve(h, &id, proof).await;
        assert_eq!(status, StatusCode::OK, "{approved}");
        let code = query_of(approved["redirect"].as_str().unwrap())["code"].clone();
        let (status, mut tokens) = post_form(
            h,
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("client_id", &client),
                ("redirect_uri", REDIRECT),
                ("code_verifier", VERIFIER),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{tokens}");
        tokens["client_id"] = json!(client);
        tokens
    }

    async fn send_json(
        h: &Harness,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let resp = h.send(method, path, None, headers).await;
        let status = resp.status();
        (status, body_json(resp).await)
    }

    async fn call_mcp(h: &Harness, access: &str) -> Response {
        let bearer = format!("Bearer {access}");
        h.send(
            "POST",
            "/mcp",
            Some(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.into()),
            &[
                ("authorization", &bearer),
                ("content-type", "application/json"),
                ("mcp-protocol-version", "2025-06-18"),
            ],
        )
        .await
    }

    /// A redeemed guest grant, and the header that proves it.
    async fn guest(h: &Harness, extra: Value) -> (String, String) {
        let mut invite =
            json!({ "name": "Sam", "addons": ["atlas"], "installs": { "atlas": "YXRsYXMtY29uZmln" } });
        invite.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let claim = member();
        let made = h
            .send(
                "POST",
                &format!("/lib/{LIB}/grants"),
                Some(invite.to_string()),
                &[("x-den-library-member", &claim), ("content-type", "application/json")],
            )
            .await;
        assert_eq!(made.status(), StatusCode::CREATED);
        let made = body_json(made).await;
        let (gid, code) =
            (made["gid"].as_str().unwrap().to_owned(), made["code"].as_str().unwrap().to_owned());
        let hash = b64url(&Sha256::digest(GUEST_SECRET.as_bytes()));
        let (status, _) =
            h.call("POST", "/grant/redeem", Some(json!({ "code": code, "secretHash": hash }))).await;
        assert_eq!(status, StatusCode::OK);
        let header = format!("{gid}:{GUEST_SECRET}");
        (gid, header)
    }

    #[tokio::test]
    async fn the_metadata_names_the_endpoints_and_pkce() {
        let h = harness().await;
        let (status, meta) = h.call("GET", "/.well-known/oauth-authorization-server", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(meta["issuer"], ISSUER);
        assert_eq!(meta["token_endpoint"], format!("{ISSUER}/oauth/token"));
        assert_eq!(meta["registration_endpoint"], format!("{ISSUER}/oauth/register"));
        assert_eq!(meta["code_challenge_methods_supported"], json!(["S256"]));
        // Off without its configuration: nothing here answers.
        let off = Harness::new();
        assert_eq!(
            off.call("GET", "/.well-known/oauth-authorization-server", None).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(off.call("POST", "/mcp", None).await.0, StatusCode::NOT_FOUND);
    }

    /// The connector lives on the web app's own name: the assistant's server registers, trades codes and calls `/mcp`
    /// there, and its person approves on the same origin's `/connect`. The web-app name's split (`handler::Face`) must
    /// not hide any of it, and the hardening every answer gets must leave each one usable to a client that is not a
    /// browser page: JSON stays JSON, the redirect keeps its `Location`, a 401 keeps its challenge.
    #[tokio::test]
    async fn the_connector_answers_on_the_web_apps_name() {
        let web = temp_dir();
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("index.html"), "<!doctype html><title>Den</title>").unwrap();
        let origin = "https://web.example";
        let h = Harness::in_dir_with(temp_dir(), |s| {
            s.oauth = Some(OAuth::new(origin.into(), format!("{origin}/mcp"), origin.into(), [9u8; 32]));
            s.web_dir = Some(web);
            s.web_hosts = vec!["web.example".into()];
            s.api_hosts = vec!["api.example".into()];
        });
        let host = [("host", "web.example")];
        let meta = h.send("GET", "/.well-known/oauth-authorization-server", None, &host).await;
        assert_eq!(meta.status(), StatusCode::OK);
        assert_eq!(meta.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(body_json(meta).await["authorization_endpoint"], format!("{origin}/oauth/authorize"));

        let body = json!({ "client_name": "Claude", "redirect_uris": [REDIRECT] }).to_string();
        let registered = h
            .send(
                "POST",
                "/oauth/register",
                Some(body),
                &[("host", "web.example"), ("content-type", "application/json")],
            )
            .await;
        assert_eq!(registered.status(), StatusCode::CREATED);
        let client = body_json(registered).await["client_id"].as_str().unwrap().to_owned();

        // The resource is this origin's /mcp, URL-encoded in the query.
        let url = authorize_url(&client, "").replace("den.example", "web.example");
        let authorize = h.send("GET", &url, None, &host).await;
        assert_eq!(authorize.status(), StatusCode::FOUND);
        assert!(
            location(&authorize).starts_with(&format!("{origin}/connect?request=")),
            "{}",
            location(&authorize)
        );
        // The consent page is the web app's own shell on the same name.
        let page = h.send("GET", "/connect?request=x", None, &host).await;
        assert!(body_text(page).await.contains("<title>Den</title>"));

        let mcp = h.send("POST", "/mcp", Some("{}".into()), &host).await;
        assert_eq!(mcp.status(), StatusCode::UNAUTHORIZED);
        assert!(mcp.headers()[header::WWW_AUTHENTICATE]
            .to_str()
            .unwrap()
            .contains(&format!("{origin}/.well-known")));
        // The device API's name and the LAN answer as well; nothing about the connector depends on the name.
        for other in ["api.example", "192.168.1.2:8094"] {
            let status = h
                .send("GET", "/.well-known/oauth-authorization-server", None, &[("host", other)])
                .await
                .status();
            assert_eq!(status, StatusCode::OK, "{other}");
        }
    }

    #[tokio::test]
    async fn registration_takes_https_redirects_and_loopback_only() {
        let h = harness().await;
        register(&h).await;
        for uris in [
            json!([]),
            json!(["http://assistant.example/cb"]),
            json!(["https://assistant.example/cb#frag"]),
            json!(["https://user:pw@assistant.example/cb"]),
            json!(["javascript:alert(1)"]),
        ] {
            let (status, answer) = h
                .call("POST", "/oauth/register", Some(json!({ "client_name": "x", "redirect_uris": uris })))
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uris}: {answer}");
        }
        let (status, _) = h
            .call("POST", "/oauth/register", Some(json!({ "redirect_uris": ["http://127.0.0.1:33418/cb"] })))
            .await;
        assert_eq!(status, StatusCode::CREATED, "a desktop client's loopback redirect");
        let (status, _) = h
            .call(
                "POST",
                "/oauth/register",
                Some(json!({ "redirect_uris": [REDIRECT], "grant_types": ["client_credentials"] })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn authorize_refuses_what_it_cannot_trust_and_sends_the_rest_to_consent() {
        let h = harness().await;
        let client = register(&h).await;
        // An unknown client or redirect is answered here, never sent anywhere.
        let unknown = h.send("GET", &authorize_url(&"0".repeat(32), ""), None, &[]).await;
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        let elsewhere = authorize_url(&client, "").replace("assistant.example", "evil.example");
        assert_eq!(h.send("GET", &elsewhere, None, &[]).await.status(), StatusCode::BAD_REQUEST);
        // PKCE is required, and S256 only; the resource is /mcp and the state is short. Every refusal before a
        // person said yes is said on Den's own page and sends the browser nowhere: a registered redirect is only what
        // some client chose, and following it on an error would make this an open redirector.
        let long_state = format!("&state={}", "s".repeat(STATE_MAX + 1));
        for (url, says) in [
            (
                authorize_url(&client, "")
                    .replace("code_challenge_method=S256", "code_challenge_method=plain"),
                "S256",
            ),
            (authorize_url(&client, "").replace("code_challenge=", "x="), "PKCE"),
            (authorize_url(&client, "").replace("%2Fmcp", "%2Fother"), "/mcp"),
            (
                authorize_url(&client, "").replace("response_type=code", "response_type=token"),
                "response_type",
            ),
            (authorize_url(&client, "&scope=admin"), "den:search"),
            (authorize_url(&client, &long_state).replace("&state=xyz", ""), "too long"),
            (authorize_url(&"0".repeat(32), ""), "no client"),
        ] {
            let resp = h.send("GET", &url, None, &[]).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{url}");
            assert!(!resp.headers().contains_key(header::LOCATION), "{url}: never redirected");
            assert_eq!(resp.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
            let page = body_text(resp).await;
            assert!(page.contains(says), "{url}: {page}");
        }
        let id = request(&h, &client).await;
        let (status, info) = h.call("GET", &format!("/oauth/request/{id}"), None).await;
        // The consent page is told where the answer goes, and that assistant.example is no assistant Den knows.
        assert_eq!(
            (status, &info["client"], &info["redirectHost"], &info["verified"]),
            (StatusCode::OK, &json!("Claude"), &json!("assistant.example"), &json!(false))
        );
    }

    /// A client names itself whatever it likes: the consent page leads with where the answer goes, and marks as known
    /// only the assistants' own hosts and this computer.
    #[test]
    fn only_the_assistants_hosts_and_this_computer_are_known() {
        for host in ["claude.ai", "chatgpt.com", "127.0.0.1", "localhost", "[::1]"] {
            assert!(known_host(host), "{host}");
        }
        for host in ["evil.example", "claude.ai.evil.example", "evil-claude.ai", "chatgpt.com.example", ""] {
            assert!(!known_host(host), "{host}");
        }
    }

    /// RFC 8252 §7.3: a desktop app's loopback redirect is taken on whatever port it has free now.
    #[test]
    fn a_loopback_redirect_is_taken_on_any_port() {
        let registered = vec!["http://127.0.0.1:33418/callback".to_owned(), REDIRECT.to_owned()];
        assert!(registered_redirect(&registered, "http://127.0.0.1:50123/callback"));
        assert!(registered_redirect(&registered, "http://127.0.0.1/callback"));
        assert!(registered_redirect(&registered, REDIRECT));
        assert!(!registered_redirect(&registered, "http://127.0.0.1:50123/other"), "the path must match");
        assert!(!registered_redirect(&registered, "http://[::1]:50123/callback"), "the host must match");
        assert!(
            !registered_redirect(&registered, "https://assistant.example:8443/callback"),
            "not for https"
        );
        assert!(!registered_redirect(&registered, "http://127.0.0.1:1/callback#x"));
    }

    /// Registering and asking are open to anyone, so a full table makes room rather than locking everyone out: the
    /// oldest registration never consented to, and a client's own oldest waiting request.
    #[tokio::test]
    async fn a_full_table_makes_room_instead_of_refusing() {
        let h = harness().await;
        let client = register(&h).await;
        let ids: Vec<String> = {
            let mut ids = Vec::new();
            for _ in 0..MAX_PENDING_PER_CLIENT + 2 {
                ids.push(request(&h, &client).await);
            }
            ids
        };
        let oauth = h.state.oauth.as_ref().unwrap();
        let waiting = crate::lock(&oauth.pending).values().filter(|p| p.client_id == client).count();
        assert_eq!(waiting, MAX_PENDING_PER_CLIENT, "one client's requests are capped");
        let (latest, _) = h.call("GET", &format!("/oauth/request/{}", ids.last().unwrap()), None).await;
        assert_eq!(latest, StatusCode::OK, "the newest request stands");
        let (first, _) = h.call("GET", &format!("/oauth/request/{}", ids[0]), None).await;
        assert_eq!(first, StatusCode::NOT_FOUND, "the oldest made room");

        // Clients: fill the table, then one more registers in place of the oldest unused one.
        let mut index = load_index(&h.state).await.unwrap();
        for n in index.clients.len()..MAX_CLIENTS {
            let id = format!("{n:032x}");
            let c = Client {
                v: VERSION,
                id: id.clone(),
                name: "x".into(),
                redirect_uris: vec![REDIRECT.into()],
                created_at: n as u64 + 1,
                used: false,
                consented_at: 0,
            };
            save(&h.state, &client_key(&id), &c).await.unwrap();
            index.clients.push(IndexClient { id, created_at: n as u64 + 1 });
        }
        save(&h.state, INDEX, &index).await.unwrap();
        let newest = register(&h).await;
        let index = load_index(&h.state).await.unwrap();
        assert_eq!(index.clients.len(), MAX_CLIENTS);
        assert!(index.clients.iter().any(|c| c.id == newest));
        assert!(index.clients.iter().any(|c| c.id == client), "the client in use was not the one dropped");
    }

    #[tokio::test]
    async fn a_member_connects_and_the_token_is_one_den_mcp_verifies() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        assert_eq!(tokens["token_type"], "Bearer");
        assert_eq!(tokens["expires_in"], ACCESS_TTL_S);
        let access = tokens["access_token"].as_str().unwrap();
        let oauth = h.state.oauth.as_ref().unwrap();
        let sid = session_of(oauth, Some(&format!("Bearer {access}")), h.state.now() / 1000).unwrap();
        let claims: Value =
            serde_json::from_slice(&b64url_decode(access.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["iss"], ISSUER);
        assert_eq!(claims["aud"], format!("{ISSUER}/mcp"));
        assert_eq!(claims["sub"], sid.as_str());
        assert_eq!(claims["scope"], SCOPE);
        assert_eq!(claims["kind"], "member");
        let body = claims.to_string();
        assert!(
            !body.contains(LIB) && !body.contains(TOKEN),
            "nothing about the library is in the token: {body}"
        );
        // Relayed to den-mcp with its token, streamed back with only what crosses the boundary.
        let resp = call_mcp(&h, access).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["mcp-session-id"], "abc");
        assert!(!resp.headers().contains_key(header::SET_COOKIE));
        let seen = body_json(resp).await;
        assert_eq!(seen, json!({ "path": "/mcp", "authorization": true, "version": "2025-06-18" }));
    }

    #[tokio::test]
    async fn a_stranger_cannot_approve_and_a_code_is_good_once() {
        let h = harness().await;
        let client = register(&h).await;
        let id = request(&h, &client).await;
        assert_eq!(approve(&h, &id, &[]).await.0, StatusCode::FORBIDDEN);
        let forged = format!("{LIB}:not-the-token");
        assert_eq!(approve(&h, &id, &[("x-den-library-member", &forged)]).await.0, StatusCode::FORBIDDEN);
        assert_eq!(approve(&h, &id, &[("x-den-grant", "0a1b2c3d:nope")]).await.0, StatusCode::FORBIDDEN);
        // A refusal leaves the request for the right person to answer.
        let claim = member();
        let (status, approved) = approve(&h, &id, &[("x-den-library-member", &claim)]).await;
        assert_eq!(status, StatusCode::OK);
        let back = query_of(approved["redirect"].as_str().unwrap());
        assert_eq!((back["state"].as_str(), back["iss"].as_str()), ("xyz", ISSUER));
        let code = back["code"].clone();
        let exchange = |verifier: &'static str| {
            let (h, code, client) = (&h, code.clone(), client.clone());
            async move {
                post_form(
                    h,
                    "/oauth/token",
                    &[
                        ("grant_type", "authorization_code"),
                        ("code", &code),
                        ("client_id", &client),
                        ("redirect_uri", REDIRECT),
                        ("code_verifier", verifier),
                    ],
                )
                .await
            }
        };
        let (status, wrong) = exchange("a-different-verifier-that-is-also-long-enough-000000").await;
        assert_eq!((status, &wrong["error"]), (StatusCode::BAD_REQUEST, &json!("invalid_grant")));
        // The failed exchange used the code up.
        assert_eq!(exchange(VERIFIER).await.1["error"], "invalid_grant");
        // Deny sends the client an access_denied.
        let id = request(&h, &client).await;
        let (_, denied) = h.call("POST", &format!("/oauth/request/{id}/deny"), None).await;
        assert_eq!(query_of(denied["redirect"].as_str().unwrap())["error"], "access_denied");
    }

    #[tokio::test]
    async fn a_refresh_token_rotates_and_a_replaced_one_ends_the_session() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let client = tokens["client_id"].as_str().unwrap();
        let first = tokens["refresh_token"].as_str().unwrap();
        let refresh = |token: String| {
            let (h, client) = (&h, client.to_owned());
            async move {
                post_form(
                    h,
                    "/oauth/token",
                    &[("grant_type", "refresh_token"), ("refresh_token", &token), ("client_id", &client)],
                )
                .await
            }
        };
        let (status, next) = refresh(first.to_owned()).await;
        assert_eq!(status, StatusCode::OK, "{next}");
        let second = next["refresh_token"].as_str().unwrap().to_owned();
        assert_ne!(second, first);
        // The replaced one again, past the grace a lost answer gets: two holders of one session. It ends for both.
        h.advance(REFRESH_GRACE_MS + 1);
        assert_eq!(refresh(first.to_owned()).await.1["error"], "invalid_grant");
        assert_eq!(refresh(second).await.1["error"], "invalid_grant");
        let access = next["access_token"].as_str().unwrap();
        assert_eq!(
            call_mcp(&h, access).await.status(),
            StatusCode::UNAUTHORIZED,
            "its access token is refused too"
        );
    }

    /// A client whose refresh answer was lost retries with the token it still holds: within the grace that is a
    /// retry, answered with a fresh pair, and the pair it never received is retired. Any retired token presented later
    /// ends the session.
    #[tokio::test]
    async fn a_lost_refresh_is_retried_and_a_retired_token_ends_the_session() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let client = tokens["client_id"].as_str().unwrap().to_owned();
        let refresh = |token: String| {
            let (h, client) = (&h, client.clone());
            async move {
                post_form(
                    h,
                    "/oauth/token",
                    &[("grant_type", "refresh_token"), ("refresh_token", &token), ("client_id", &client)],
                )
                .await
            }
        };
        let first = tokens["refresh_token"].as_str().unwrap().to_owned();
        let (_, lost) = refresh(first.clone()).await;
        let lost = lost["refresh_token"].as_str().unwrap().to_owned();
        // The answer never arrived: the same token again, a few seconds on.
        h.advance(5_000);
        let (status, again) = refresh(first.clone()).await;
        assert_eq!(status, StatusCode::OK, "{again}");
        let kept = again["refresh_token"].as_str().unwrap().to_owned();
        assert_eq!(call_mcp(&h, again["access_token"].as_str().unwrap()).await.status(), StatusCode::OK);
        // Rotating on normally, later.
        h.advance(REFRESH_GRACE_MS);
        let (status, later) = refresh(kept).await;
        assert_eq!(status, StatusCode::OK, "{later}");
        // The token the lost answer carried turns up: someone else has it. The session ends.
        assert_eq!(refresh(lost).await.1["error"], "invalid_grant");
        let next = later["refresh_token"].as_str().unwrap().to_owned();
        assert_eq!(refresh(next).await.1["error"], "invalid_grant", "ended for its holder too");
    }

    /// The grace is for one lost answer, not a minute in which an old token can keep retiring every new one.
    #[tokio::test]
    async fn a_lost_refresh_token_is_accepted_only_once() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let client = tokens["client_id"].as_str().unwrap().to_owned();
        let first = tokens["refresh_token"].as_str().unwrap().to_owned();
        let refresh = |token: String| {
            let (h, client) = (&h, client.clone());
            async move {
                post_form(
                    h,
                    "/oauth/token",
                    &[("grant_type", "refresh_token"), ("refresh_token", &token), ("client_id", &client)],
                )
                .await
            }
        };
        let (_, lost) = refresh(first.clone()).await;
        h.advance(5_000);
        let (status, retry) = refresh(first.clone()).await;
        assert_eq!(status, StatusCode::OK, "{retry}");
        let current = retry["refresh_token"].as_str().unwrap().to_owned();

        assert_eq!(refresh(first).await.1["error"], "invalid_grant", "the one retry was consumed");
        assert_eq!(refresh(current).await.1["error"], "invalid_grant", "reuse ended the session");
        assert_eq!(
            refresh(lost["refresh_token"].as_str().unwrap().to_owned()).await.1["error"],
            "invalid_grant"
        );
    }

    /// A public client names itself on every refresh, and only the client a session is for can refresh it.
    #[tokio::test]
    async fn a_refresh_names_its_client() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let token = tokens["refresh_token"].as_str().unwrap();
        for form in [
            vec![("grant_type", "refresh_token"), ("refresh_token", token)],
            vec![("grant_type", "refresh_token"), ("refresh_token", token), ("client_id", LIB)],
        ] {
            let (status, answer) = post_form(&h, "/oauth/token", &form).await;
            assert_eq!((status, &answer["error"]), (StatusCode::BAD_REQUEST, &json!("invalid_grant")));
            assert!(answer["error_description"].as_str().unwrap().contains("client_id"), "{answer}");
        }
        let client = tokens["client_id"].as_str().unwrap();
        let form = [("grant_type", "refresh_token"), ("refresh_token", token), ("client_id", client)];
        assert_eq!(
            post_form(&h, "/oauth/token", &form).await.0,
            StatusCode::OK,
            "and the token still stands"
        );
    }

    /// One invite's guest may connect a few assistants, never its host's whole allowance.
    #[tokio::test]
    async fn a_guest_connects_a_few_assistants_at_most() {
        let h = harness().await;
        let (_, proof) = guest(&h, json!({})).await;
        for _ in 0..MAX_SESSIONS_PER_GRANT {
            connect(&h, &[("x-den-grant", &proof)]).await;
        }
        let client = register(&h).await;
        let id = request(&h, &client).await;
        let (_, approved) = approve(&h, &id, &[("x-den-grant", &proof)]).await;
        let code = query_of(approved["redirect"].as_str().unwrap())["code"].clone();
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", client.as_str()),
            ("redirect_uri", REDIRECT),
            ("code_verifier", VERIFIER),
        ];
        let (status, answer) = post_form(&h, "/oauth/token", &form).await;
        assert_eq!((status, &answer["error"]), (StatusCode::BAD_REQUEST, &json!("invalid_grant")));
        // The host's own members are not held to it.
        let claim = member();
        connect(&h, &[("x-den-library-member", &claim)]).await;
    }

    /// A client consented to is kept while a connection stands for it, and reaped `IDLE_CLIENT_MS` after its last
    /// consent once none does.
    #[tokio::test]
    async fn a_client_with_no_connection_left_is_reaped_in_time() {
        let h = harness().await;
        let claim = member();
        let gone = connect(&h, &[("x-den-library-member", &claim)]).await;
        let kept = connect(&h, &[("x-den-library-member", &claim)]).await;
        let (_, listed) =
            send_json(&h, "GET", "/oauth/connections", &[("x-den-library-member", &claim)]).await;
        let first_sid = listed["connections"][0]["sid"].as_str().unwrap().to_owned();
        let gone_session: Session = load(&h.state, &session_key(&first_sid)).await.unwrap().unwrap();
        let (gone_client, kept_client) = if gone_session.client_id == gone["client_id"] {
            (gone["client_id"].as_str().unwrap().to_owned(), kept["client_id"].as_str().unwrap().to_owned())
        } else {
            (kept["client_id"].as_str().unwrap().to_owned(), gone["client_id"].as_str().unwrap().to_owned())
        };
        let del = h
            .send(
                "DELETE",
                &format!("/oauth/connections/{first_sid}"),
                None,
                &[("x-den-library-member", &claim)],
            )
            .await;
        assert_eq!(del.status(), StatusCode::NO_CONTENT);
        // Twenty days on the remaining connection is used; another fifteen and both clients are past the idle time
        // since their consent, but only one still has a connection.
        h.advance(20 * 86_400_000);
        let kept_token = if kept_client == kept["client_id"] { &kept } else { &gone };
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", kept_token["refresh_token"].as_str().unwrap()),
            ("client_id", kept_client.as_str()),
        ];
        assert_eq!(post_form(&h, "/oauth/token", &form).await.0, StatusCode::OK);
        h.advance(15 * 86_400_000);
        sweep(&h.state).await;
        let index = load_index(&h.state).await.unwrap();
        assert!(!index.clients.iter().any(|c| c.id == gone_client), "no connection left: reaped");
        assert!(index.clients.iter().any(|c| c.id == kept_client), "still connected: kept");
    }

    /// Every /mcp call checks the member behind it; for a library not loaded, that is its log's header alone, not a
    /// replay of the whole log into memory.
    #[tokio::test]
    async fn checking_a_member_does_not_load_their_library() {
        let h = harness().await;
        h.state.libraries.lock().await.clear();
        let hash: [u8; 32] = Sha256::digest(TOKEN.as_bytes()).into();
        assert!(crate::library::holds_member_hash(&h.state, LIB, &hash).await.unwrap());
        assert!(!crate::library::holds_member_hash(&h.state, LIB, &[0u8; 32]).await.unwrap());
        assert!(!h.state.libraries.lock().await.contains_key(LIB), "the library was not loaded to answer");
        // Loaded, it is answered from memory the same way.
        let claim = member();
        connect(&h, &[("x-den-library-member", &claim)]).await;
        assert!(crate::library::holds_member_hash(&h.state, LIB, &hash).await.unwrap());
    }

    /// An assistant calls steadily: its /mcp allowance renews each minute, where a window moved on by every call
    /// allowed would never close.
    #[tokio::test]
    async fn a_steady_caller_gets_a_new_window_each_minute() {
        let h = harness().await;
        let (steady, moving) = ("mcp:steady", "mcp:moving");
        for bucket in [steady, moving] {
            let limited = |b: &str| {
                if b == steady {
                    crate::link::throttled_per_minute(&h.state, b, 2).is_some()
                } else {
                    crate::link::throttled_at(&h.state, b, 2).is_some()
                }
            };
            assert!(!limited(bucket));
            h.advance(30_000);
            assert!(!limited(bucket));
            h.advance(10_000);
            assert!(limited(bucket), "{bucket}: past the limit within the minute");
            h.advance(21_000);
            if bucket == steady {
                assert!(!limited(bucket), "a minute after the first call, a new window");
            } else {
                assert!(limited(bucket), "the moving window is still open: what /mcp no longer uses");
            }
        }
    }

    /// `/mcp` calls at den-mcp at once are capped here too: past it a caller is told to come back.
    #[tokio::test]
    async fn mcp_calls_past_the_cap_are_told_to_come_back() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let access = tokens["access_token"].as_str().unwrap();
        let oauth = h.state.oauth.as_ref().unwrap();
        let held = oauth.mcp_slots.try_acquire_many(MCP_IN_FLIGHT as u32).unwrap();
        let busy = call_mcp(&h, access).await;
        assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(busy.headers().contains_key(header::RETRY_AFTER));
        drop(held);
        assert_eq!(call_mcp(&h, access).await.status(), StatusCode::OK);
    }

    /// A call holds its slot until den-mcp's answer has been passed on whole, not only its head: an answer may be a
    /// stream, and it is at den-mcp until it ends.
    #[tokio::test]
    async fn a_call_holds_its_slot_until_its_answer_ends() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let oauth = h.state.oauth.as_ref().unwrap();
        let answer = call_mcp(&h, tokens["access_token"].as_str().unwrap()).await;
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(oauth.mcp_slots.available_permits(), MCP_IN_FLIGHT - 1, "the answer is still coming");
        body_text(answer).await;
        assert_eq!(oauth.mcp_slots.available_permits(), MCP_IN_FLIGHT);
    }

    /// An answer nobody reads gives its slot back once it has gone the idle time without a frame: held until it ended,
    /// 32 callers that never read — or 32 answers stalled mid-stream — refused every call until a restart.
    #[tokio::test]
    async fn an_answer_that_goes_idle_gives_its_slot_back() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let oauth = h.state.oauth.as_ref().unwrap();
        let answer = call_mcp(&h, tokens["access_token"].as_str().unwrap()).await;
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(oauth.mcp_slots.available_permits(), MCP_IN_FLIGHT - 1);
        tokio::time::sleep(MCP_ANSWER_IDLE * 2).await;
        assert_eq!(oauth.mcp_slots.available_permits(), MCP_IN_FLIGHT, "never read, and given back");
        assert!(!body_text(answer).await.is_empty(), "the answer itself was not cut");
    }

    /// A body that never finishes arriving: what a caller sending slowly looks like from here.
    struct Stalled;

    impl http_body::Body for Stalled {
        type Data = axum::body::Bytes;
        type Error = std::convert::Infallible;
        fn poll_frame(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
            std::task::Poll::Pending
        }
    }

    /// A call's body is read before it takes an upstream slot, and in bounded time. It holds only one of the
    /// separately bounded body-ingress slots while it arrives.
    #[tokio::test]
    async fn a_slow_body_holds_no_slot() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let bearer = format!("Bearer {}", tokens["access_token"].as_str().unwrap());
        let req = axum::http::Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("authorization", &bearer)
            .body(Body::new(Stalled))
            .unwrap();
        let state = Arc::clone(&h.state);
        let call =
            tokio::spawn(async move { gate_mcp(&state, state.oauth.as_ref().unwrap(), req, "rid").await });
        tokio::time::sleep(MCP_BODY_TIMEOUT / 2).await;
        let oauth = h.state.oauth.as_ref().unwrap();
        assert_eq!(oauth.mcp_slots.available_permits(), MCP_IN_FLIGHT, "no slot while the body arrives");
        assert_eq!(oauth.mcp_body_slots.available_permits(), MCP_BODY_IN_FLIGHT - 1);
        assert_eq!(call.await.unwrap().status(), StatusCode::REQUEST_TIMEOUT);
        assert_eq!(oauth.mcp_slots.available_permits(), MCP_IN_FLIGHT);
        assert_eq!(oauth.mcp_body_slots.available_permits(), MCP_BODY_IN_FLIGHT);
    }

    #[tokio::test]
    async fn mcp_bodies_past_the_ingress_cap_are_refused_before_they_are_read() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let oauth = h.state.oauth.as_ref().unwrap();
        let held = oauth.mcp_body_slots.try_acquire_many(MCP_BODY_IN_FLIGHT as u32).unwrap();
        let busy = call_mcp(&h, tokens["access_token"].as_str().unwrap()).await;
        assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(busy.headers().contains_key(header::RETRY_AFTER));
        drop(held);
    }

    async fn preflight(h: &Harness) -> Response {
        let headers = [("origin", "https://claude.ai"), ("access-control-request-method", "POST")];
        h.send("OPTIONS", "/mcp", None, &headers).await
    }

    /// A preflight carries no token, by design, but it still reaches den-mcp: it takes a slot, and counts against
    /// its address's budget.
    #[tokio::test]
    async fn a_preflight_is_counted_like_a_call() {
        let h = harness().await;
        let oauth = h.state.oauth.as_ref().unwrap();

        assert_eq!(preflight(&h).await.status(), StatusCode::OK);
        let held = oauth.mcp_slots.try_acquire_many(MCP_IN_FLIGHT as u32).unwrap();
        assert_eq!(preflight(&h).await.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(held);
        for _ in 1..MCP_GATE_PER_WINDOW {
            preflight(&h).await;
        }
        assert_eq!(preflight(&h).await.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn a_bare_options_is_not_an_unauthenticated_mcp_call() {
        let h = harness().await;
        assert_eq!(
            h.send("OPTIONS", "/mcp", Some("{}".into()), &[]).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        let only_origin = [("origin", "https://claude.ai")];
        assert_eq!(
            h.send("OPTIONS", "/mcp", None, &only_origin).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    /// The relay reads the bearer scheme in any case, and takes only an access token.
    #[test]
    fn the_relay_reads_any_bearer_and_only_an_access_token() {
        let oauth = OAuth::new(ISSUER.into(), format!("{ISSUER}/mcp"), ISSUER.into(), [9u8; 32]);
        let session = Session {
            v: VERSION,
            sid: "0123456789abcdef0123456789abcdef".into(),
            client_id: "c".into(),
            client_name: "c".into(),
            redirect_host: None,
            who: Who::Member { library: LIB.into(), member_hash: String::new() },
            refresh_hash: String::new(),
            previous_hash: None,
            rotated_at: 0,
            retired: Vec::new(),
            created_at: 0,
            used_at: 0,
        };
        let now = 1_800_000_000;
        let (token, _) = access_token(&oauth, &session, now * 1000, None);
        for scheme in ["Bearer", "bearer", "BEARER"] {
            assert!(session_of(&oauth, Some(&format!("{scheme} {token}")), now).is_some(), "{scheme}");
        }
        assert!(session_of(&oauth, Some(&format!("Basic {token}")), now).is_none());
        // The same key and claims under another type: not an access token.
        let (_, rest) = token.split_once('.').unwrap();
        let (body, _) = rest.split_once('.').unwrap();
        let head = b64url(br#"{"alg":"EdDSA","typ":"JWT"}"#);
        let signed = format!("{head}.{body}");
        let other = format!("{signed}.{}", b64url(&oauth.key.sign(signed.as_bytes()).to_bytes()));
        assert!(session_of(&oauth, Some(&format!("Bearer {other}")), now).is_none());
    }

    #[tokio::test]
    async fn a_guest_connects_and_is_cut_off_when_the_grant_is_revoked() {
        let h = harness().await;
        let (gid, proof) = guest(&h, json!({})).await;
        let tokens = connect(&h, &[("x-den-grant", &proof)]).await;
        let access = tokens["access_token"].as_str().unwrap().to_owned();
        assert_eq!(call_mcp(&h, &access).await.status(), StatusCode::OK);
        // The guest sees its own connection; the host sees it as its guest's.
        let (_, mine) = send_json(&h, "GET", "/oauth/connections", &[("x-den-grant", &proof)]).await;
        assert_eq!(mine["connections"][0]["guest"], "Sam");
        let claim = member();
        let (_, host) = send_json(&h, "GET", "/oauth/connections", &[("x-den-library-member", &claim)]).await;
        assert_eq!(host["connections"].as_array().unwrap().len(), 1);
        // Revoked by the host: the very next call is refused, and the session cannot be refreshed.
        let revoked = h
            .send("DELETE", &format!("/lib/{LIB}/grants/{gid}"), None, &[("x-den-library-member", &claim)])
            .await;
        assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
        let refused = call_mcp(&h, &access).await;
        assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
        assert!(refused.headers()[header::WWW_AUTHENTICATE].to_str().unwrap().contains("invalid_token"));
        let refresh = tokens["refresh_token"].as_str().unwrap();
        let client = tokens["client_id"].as_str().unwrap();
        let form = [("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", client)];
        let (_, answer) = post_form(&h, "/oauth/token", &form).await;
        assert_eq!(answer["error"], "invalid_grant");
        assert!(
            answer["error_description"].as_str().unwrap().contains("unknown"),
            "the session is gone: {answer}"
        );
    }

    #[tokio::test]
    async fn a_guests_token_never_outlasts_the_grant_and_expiry_cuts_it_off() {
        let h = harness().await;
        let until = h.state.now() + 5 * 60_000;
        let (_, proof) = guest(&h, json!({ "accessUntil": until })).await;
        let tokens = connect(&h, &[("x-den-grant", &proof)]).await;
        assert!(tokens["expires_in"].as_u64().unwrap() <= 5 * 60, "{tokens}");
        let access = tokens["access_token"].as_str().unwrap().to_owned();
        assert_eq!(call_mcp(&h, &access).await.status(), StatusCode::OK);
        h.advance(5 * 60_000);
        assert_eq!(call_mcp(&h, &access).await.status(), StatusCode::UNAUTHORIZED);
        let refresh = tokens["refresh_token"].as_str().unwrap();
        let client = tokens["client_id"].as_str().unwrap();
        let form = [("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", client)];
        let (_, answer) = post_form(&h, "/oauth/token", &form).await;
        assert_eq!(answer["error"], "invalid_grant");
        assert!(answer["error_description"].as_str().unwrap().contains("ended"), "{answer}");
    }

    #[tokio::test]
    async fn a_member_revokes_a_connection_from_settings() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let (status, listed) =
            send_json(&h, "GET", "/oauth/connections", &[("x-den-library-member", &claim)]).await;
        assert_eq!(status, StatusCode::OK);
        let sid = listed["connections"][0]["sid"].as_str().unwrap().to_owned();
        assert_eq!(listed["connections"][0]["client"], "Claude");
        assert_eq!(listed["connections"][0]["redirectHost"], "assistant.example");
        assert_eq!(send_json(&h, "GET", "/oauth/connections", &[]).await.0, StatusCode::FORBIDDEN);
        let path = format!("/oauth/connections/{sid}");
        // Another library's member, or a stranger, cannot end it.
        assert_eq!(h.send("DELETE", &path, None, &[]).await.status(), StatusCode::FORBIDDEN);
        let gone = h.send("DELETE", &path, None, &[("x-den-library-member", &claim)]).await;
        assert_eq!(gone.status(), StatusCode::NO_CONTENT);
        let access = tokens["access_token"].as_str().unwrap();
        assert_eq!(call_mcp(&h, access).await.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn mcp_without_a_token_says_where_to_get_one() {
        let h = harness().await;
        let resp = h.send("POST", "/mcp", Some("{}".into()), &[]).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers()[header::WWW_AUTHENTICATE],
            "Bearer realm=\"den\", resource_metadata=\"https://den.example/.well-known/oauth-protected-resource/mcp\""
        );
        // A token signed by any other key is refused before it reaches den-mcp.
        let other = OAuth::new(ISSUER.into(), format!("{ISSUER}/mcp"), ISSUER.into(), [7u8; 32]);
        let session = Session {
            v: VERSION,
            sid: "0".repeat(32),
            client_id: "c".into(),
            client_name: "c".into(),
            redirect_host: None,
            who: Who::Member { library: LIB.into(), member_hash: sha(TOKEN.as_bytes()) },
            refresh_hash: String::new(),
            previous_hash: None,
            rotated_at: 0,
            retired: Vec::new(),
            created_at: 0,
            used_at: 0,
        };
        let (forged, _) = access_token(&other, &session, h.state.now(), None);
        assert_eq!(call_mcp(&h, &forged).await.status(), StatusCode::UNAUTHORIZED);
        // The resource's own metadata is den-mcp's to say.
        let (status, seen) = h.call("GET", "/.well-known/oauth-protected-resource/mcp", None).await;
        assert_eq!(
            (status, &seen["path"]),
            (StatusCode::OK, &json!("/.well-known/oauth-protected-resource/mcp"))
        );
    }

    /// den-mcp holds a token this function signed as a fixed vector (its `a_token_den_edge_signs_verifies`), so a
    /// change to the header, the claims or the encoding here that den-mcp would refuse fails there. This pins the
    /// inputs that vector was made from; `jti` is the only part that differs between runs.
    #[test]
    fn the_token_shape_den_mcp_holds_as_a_vector() {
        let oauth = OAuth::new(ISSUER.into(), format!("{ISSUER}/mcp"), ISSUER.into(), [7u8; 32]);
        let session = Session {
            v: VERSION,
            sid: "0123456789abcdef0123456789abcdef".into(),
            client_id: "c1".into(),
            client_name: "Claude".into(),
            redirect_host: None,
            who: Who::Guest { gid: "0a1b2c3d".into(), host: LIB.into(), name: "Sam".into() },
            refresh_hash: String::new(),
            previous_hash: None,
            rotated_at: 0,
            retired: Vec::new(),
            created_at: 0,
            used_at: 0,
        };
        let (token, expires_in) = access_token(&oauth, &session, 1_800_000_000_000, None);
        assert_eq!(expires_in, ACCESS_TTL_S);
        let parts: Vec<&str> = token.split('.').collect();
        let header: Value = serde_json::from_slice(&b64url_decode(parts[0]).unwrap()).unwrap();
        assert_eq!((&header["alg"], &header["typ"]), (&json!("EdDSA"), &json!("at+jwt")));
        let claims: Value = serde_json::from_slice(&b64url_decode(parts[1]).unwrap()).unwrap();
        for (claim, value) in [
            ("iss", json!(ISSUER)),
            ("aud", json!(format!("{ISSUER}/mcp"))),
            ("sub", json!(session.sid)),
            ("scope", json!(SCOPE)),
            ("kind", json!("guest")),
            ("iat", json!(1_800_000_000u64)),
            ("exp", json!(1_800_000_000u64 + ACCESS_TTL_S)),
        ] {
            assert_eq!(claims[claim], value, "{claim}");
        }
        println!("{token}");
    }

    /// RFC 7009: any token the session was given ends it — its refresh token, the one a refresh just replaced, or
    /// an access token (which is checked against the session, so ending the session is what revokes it). Anything
    /// else is answered the same and ends nothing.
    #[tokio::test]
    async fn revoking_any_of_a_sessions_tokens_ends_it() {
        let h = harness().await;
        let claim = member();
        let revoke = |token: String| {
            let h = &h;
            async move { post_form(h, "/oauth/revoke", &[("token", &token)]).await.0 }
        };
        for which in ["refresh", "previous", "access"] {
            let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
            let client = tokens["client_id"].as_str().unwrap();
            let first = tokens["refresh_token"].as_str().unwrap();
            let form = [("grant_type", "refresh_token"), ("refresh_token", first), ("client_id", client)];
            let (status, next) = post_form(&h, "/oauth/token", &form).await;
            assert_eq!(status, StatusCode::OK);
            let access = next["access_token"].as_str().unwrap();
            assert_eq!(revoke("junk".into()).await, StatusCode::OK);
            assert_eq!(call_mcp(&h, access).await.status(), StatusCode::OK, "{which}: junk ended nothing");
            let token = match which {
                "refresh" => next["refresh_token"].as_str().unwrap(),
                "previous" => first,
                _ => access,
            };
            assert_eq!(revoke(token.to_owned()).await, StatusCode::OK);
            assert_eq!(call_mcp(&h, access).await.status(), StatusCode::UNAUTHORIZED, "{which}");
        }
    }

    /// A member's library log or a guest's grant that cannot be read for a moment is not a revocation: the call is a
    /// 500, and neither a refresh nor the sweep ends the connection over it.
    #[tokio::test]
    async fn a_failed_read_behind_a_connection_ends_nothing() {
        let h = harness().await;
        let claim = member();
        let (gid, proof) = guest(&h, json!({})).await;
        let hashed = |ns: &str, key: &str, ext: &str| {
            h.dir.join(ns).join(format!("{}.{ext}", crate::hex(&Sha256::digest(key.as_bytes()))))
        };
        for (proof, record) in [
            (("x-den-library-member", claim.as_str()), hashed("lib", LIB, "log")),
            (("x-den-grant", proof.as_str()), hashed("grants", &format!("g:{gid}"), "json")),
        ] {
            let tokens = connect(&h, &[proof]).await;
            let access = tokens["access_token"].as_str().unwrap();
            let form = [
                ("grant_type", "refresh_token"),
                ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
                ("client_id", tokens["client_id"].as_str().unwrap()),
            ];
            // The record is there but reading it fails: a directory stands in its place.
            h.state.libraries.lock().await.clear();
            let aside = record.with_extension("aside");
            std::fs::rename(&record, &aside).unwrap();
            std::fs::create_dir(&record).unwrap();
            assert_eq!(call_mcp(&h, access).await.status(), StatusCode::INTERNAL_SERVER_ERROR, "{record:?}");
            assert_eq!(post_form(&h, "/oauth/token", &form).await.0, StatusCode::INTERNAL_SERVER_ERROR);
            sweep(&h.state).await;

            std::fs::remove_dir(&record).unwrap();
            std::fs::rename(&aside, &record).unwrap();
            assert_eq!(call_mcp(&h, access).await.status(), StatusCode::OK, "{record:?}");
            let (status, refreshed) = post_form(&h, "/oauth/token", &form).await;
            assert_eq!(status, StatusCode::OK, "the connection outlived the failure: {refreshed}");
        }
    }

    #[tokio::test]
    async fn a_library_key_reset_ends_its_members_connections() {
        let h = harness().await;
        let claim = member();
        let tokens = connect(&h, &[("x-den-library-member", &claim)]).await;
        let access = tokens["access_token"].as_str().unwrap();
        let oauth = h.state.oauth.as_ref().unwrap();
        let sid = session_of(oauth, Some(&format!("Bearer {access}")), h.state.now() / 1000).unwrap();
        // A session whose member token is no longer the library's stands for nothing.
        let mut session: Session = load(&h.state, &session_key(&sid)).await.unwrap().unwrap();
        session.who = Who::Member { library: LIB.into(), member_hash: sha(b"an-older-member-token") };
        save(&h.state, &session_key(&sid), &session).await.unwrap();
        assert_eq!(call_mcp(&h, access).await.status(), StatusCode::UNAUTHORIZED);
    }
}
