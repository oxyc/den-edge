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
//! every use, and presenting a replaced one ends the session (refresh-token reuse detection, OAuth 2.1 §4.3.1).
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
/// Connections one library may have (its guests' included), and in all.
const MAX_SESSIONS_PER_HOST: usize = 50;
const MAX_SESSIONS: usize = 1000;
/// Requests per address per minute to each public endpoint, and per session to `/mcp`.
const REGISTER_PER_WINDOW: u32 = 10;
const AUTHORIZE_PER_WINDOW: u32 = 60;
const TOKEN_PER_WINDOW: u32 = 60;
const CONSENT_PER_WINDOW: u32 = 30;
const MCP_GATE_PER_WINDOW: u32 = 600;
const MCP_PER_SESSION: u32 = 600;
const MCP_TIMEOUT: Duration = Duration::from_secs(60);
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
}

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
}

#[derive(Serialize, Deserialize)]
struct Session {
    v: u32,
    sid: String,
    client_id: String,
    client_name: String,
    who: Who,
    /// Hex SHA-256 of the refresh secret now valid, and of the one it replaced (reuse detection).
    refresh_hash: String,
    previous_hash: Option<String>,
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
    let client =
        Client { v: VERSION, id: random_id(), name, redirect_uris: uris, created_at: now, used: false };
    let _lock = oauth.lock.lock().await;
    let mut index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("oauth index", e),
    };
    if index.clients.len() >= MAX_CLIENTS {
        return oauth_error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable", "too many clients");
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

// ---- authorization

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
    // Until the client and its redirect URI are known good, an error is said here and never sent anywhere.
    let Some(client_id) = get("client_id").filter(|id| valid_id(id)) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "unknown client_id");
    };
    let client: Client = match load(state, &client_key(client_id)).await {
        Ok(Some(client)) => client,
        Ok(None) => return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "unknown client_id"),
        Err(e) => return internal("oauth client read", e),
    };
    let redirect_uri = match get("redirect_uri") {
        Some(uri) if client.redirect_uris.iter().any(|r| r == uri) => uri.to_owned(),
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        _ => {
            return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri is not registered")
        }
    };
    let state_param = get("state").map(str::to_owned);
    let fail = |code: &str, description: &str| {
        let mut params =
            vec![("error", code), ("error_description", description), ("iss", oauth.issuer.as_str())];
        if let Some(s) = &state_param {
            params.push(("state", s));
        }
        redirect(&with_params(&redirect_uri, &params))
    };
    if get("response_type") != Some("code") {
        return fail("unsupported_response_type", "code only");
    }
    let Some(challenge) = get("code_challenge").filter(|c| valid_challenge(c)) else {
        return fail("invalid_request", "PKCE is required: code_challenge with code_challenge_method S256");
    };
    if get("code_challenge_method") != Some("S256") {
        return fail("invalid_request", "code_challenge_method S256 only");
    }
    if get("resource").is_some_and(|r| r.trim_end_matches('/') != oauth.resource) {
        return fail("invalid_target", "the resource is this server's /mcp");
    }
    if get("scope").is_some_and(|s| s.split(' ').any(|s| !s.is_empty() && s != SCOPE)) {
        return fail("invalid_scope", "den:search only");
    }
    let now = state.now();
    let id = random_id();
    {
        let mut pending = crate::lock(&oauth.pending);
        pending.retain(|_, p| p.until > now);
        if pending.len() >= 1000 {
            return fail("temporarily_unavailable", "too many authorizations in progress");
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
            },
        );
    }
    redirect(&format!("{}/connect?request={id}", oauth.consent_origin))
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
            let host = url::Url::parse(&p.redirect_uri).ok().and_then(|u| u.host_str().map(str::to_owned));
            json_reply(
                StatusCode::OK,
                &json!({ "client": p.client_name, "redirectHost": host, "scope": SCOPE }),
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
            // A client that was consented to is kept past the day an unused registration is.
            let _lock = oauth.lock.lock().await;
            if let Ok(Some(mut client)) = load::<Client>(state, &client_key(&pending.client_id)).await {
                if !client.used {
                    client.used = true;
                    if let Err(e) = save(state, &client_key(&client.id), &client).await {
                        eprintln!("oauth client write: {e}");
                    }
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
/// not: a revoked, expired or shortened grant, or a library whose member token changed.
async fn still_stands(state: &AppState, who: &Who) -> Option<Option<u64>> {
    match who {
        Who::Member { library, member_hash } => {
            let hash: [u8; 32] = hex_bytes(member_hash)?;
            crate::library::holds_member_hash(state, library, &hash).await.then_some(None)
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
    let Some(grant_end) = still_stands(state, &code.who).await else {
        return invalid("the membership or invite behind this approval has ended");
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
        who: code.who,
        refresh_hash: sha(secret.as_bytes()),
        previous_hash: None,
        created_at: now,
        used_at: now,
    };
    let _lock = oauth.lock.lock().await;
    let mut index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("oauth index", e),
    };
    let host = session.who.host().to_owned();
    if index.sessions.len() >= MAX_SESSIONS
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
    let presented = sha(secret.as_bytes());
    if !constant_time_eq(presented.as_bytes(), session.refresh_hash.as_bytes()) {
        // A replaced token presented again means two holders of one session: end it for both.
        if session
            .previous_hash
            .as_deref()
            .is_some_and(|p| constant_time_eq(p.as_bytes(), presented.as_bytes()))
        {
            eprintln!("oauth: a replaced refresh token was used again — ending the session");
            if let Err(e) = end_session(state, sid).await {
                return internal("oauth session delete", e);
            }
        }
        return invalid("unknown refresh token");
    }
    if client_id.is_some_and(|c| c != session.client_id) {
        return invalid("the token was issued to another client");
    }
    let stands =
        if now >= session.used_at + IDLE_MS { None } else { still_stands(state, &session.who).await };
    let Some(grant_end) = stands else {
        if let Err(e) = end_session(state, sid).await {
            return internal("oauth session delete", e);
        }
        return invalid("the connection has ended");
    };
    let secret = b64url(&crate::random_bytes::<32>());
    session.previous_hash = Some(std::mem::replace(&mut session.refresh_hash, sha(secret.as_bytes())));
    session.used_at = now;
    if let Err(e) = save(state, &session_key(sid), &session).await {
        return internal("oauth session write", e);
    }
    let (access, expires_in) = access_token(oauth, &session, now, grant_end);
    token_reply(access, expires_in, format!("{sid}.{secret}"))
}

/// RFC 7009: the refresh token's session ends. An unknown token is answered the same, as the RFC asks.
async fn revoke(state: &AppState, oauth: &OAuth, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("oauth-token:{ip}"), TOKEN_PER_WINDOW) {
        return limited;
    }
    let Some(p) = params_of(req).await else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "a form-encoded body");
    };
    if let Some((sid, secret)) =
        p.get("token").and_then(|t| t.split_once('.')).filter(|(sid, _)| valid_id(sid))
    {
        let _lock = oauth.lock.lock().await;
        if let Ok(Some(session)) = load::<Session>(state, &session_key(sid)).await {
            if constant_time_eq(sha(secret.as_bytes()).as_bytes(), session.refresh_hash.as_bytes()) {
                match load_index(state).await {
                    Ok(mut index) => {
                        if let Err(e) = drop_sessions(state, &mut index, &[sid.to_owned()]).await {
                            return internal("oauth session delete", e);
                        }
                    }
                    Err(e) => return internal("oauth index", e),
                }
            }
        }
    }
    json_reply(StatusCode::OK, &json!({}))
}

// ---- Settings › Connections

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
    for entry in &index.sessions {
        match load::<Session>(state, &session_key(&entry.sid)).await {
            Ok(Some(s)) if now < s.used_at + IDLE_MS && still_stands(state, &s.who).await.is_some() => {}
            Ok(_) => ended.push(entry.sid.clone()),
            Err(e) => eprintln!("oauth sweep: {e}"),
        }
    }
    // A registration nobody ever consented to, a day on, is reaped: registering is open to anyone.
    let mut unused = Vec::new();
    for entry in index.clients.iter().filter(|c| now >= c.created_at + UNUSED_CLIENT_MS) {
        match load::<Client>(state, &client_key(&entry.id)).await {
            Ok(Some(client)) if client.used => {}
            Ok(_) => unused.push(entry.id.clone()),
            Err(e) => eprintln!("oauth sweep: {e}"),
        }
    }
    if ended.is_empty() && unused.is_empty() {
        return;
    }
    let _lock = oauth.lock.lock().await;
    let result = async {
        let mut index = load_index(state).await?;
        for id in &unused {
            state.store.delete(NS, &client_key(id)).await?;
        }
        index.clients.retain(|c| !unused.contains(&c.id));
        // Only those still ended: a session refreshed since it was read is no longer idle.
        let mut still = Vec::new();
        for sid in &ended {
            match load::<Session>(state, &session_key(sid)).await? {
                Some(s) if now < s.used_at + IDLE_MS && still_stands(state, &s.who).await.is_some() => {}
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
    let token = authorization?.strip_prefix("Bearer ")?.trim();
    let mut parts = token.split('.');
    let (head, body, sig) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Value = serde_json::from_slice(&b64url_decode(head)?).ok()?;
    if header.get("alg").and_then(Value::as_str) != Some("EdDSA") {
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
    if req.method() == Method::OPTIONS {
        return relay_mcp(state, req, rid).await;
    }
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, format!("mcp-gate:{ip}"), MCP_GATE_PER_WINDOW) {
        return limited;
    }
    let authorization = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let Some(sid) = session_of(oauth, authorization, state.now() / 1000) else {
        return unauthorized(oauth, authorization.is_some());
    };
    let session: Session = match load(state, &session_key(&sid)).await {
        Ok(Some(session)) => session,
        Ok(None) => return unauthorized(oauth, true),
        Err(e) => return internal("oauth session read", e),
    };
    if still_stands(state, &session.who).await.is_none() {
        return unauthorized(oauth, true);
    }
    if let Some(limited) = gate(state, format!("mcp:{sid}"), MCP_PER_SESSION) {
        return limited;
    }
    relay_mcp(state, req, rid).await
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
    use crate::handler::tests::{body_json, temp_dir, Harness};
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

    /// An assistant's server reaches the connector on whichever public name it was given — the device API's, which
    /// bypasses Access, or the web app's — and its person approves in the web app.
    #[tokio::test]
    async fn the_connector_answers_on_every_public_name() {
        let h = Harness::in_dir_with(temp_dir(), |s| {
            s.oauth = Some(OAuth::new(ISSUER.into(), format!("{ISSUER}/mcp"), ISSUER.into(), [9u8; 32]));
            s.web_hosts = vec!["web.example".into()];
            s.api_hosts = vec!["api.example".into()];
        });
        for host in ["web.example", "api.example", "192.168.1.2:8094"] {
            for path in ["/.well-known/oauth-authorization-server", "/mcp"] {
                let status = h.send("GET", path, None, &[("host", host)]).await.status();
                assert_ne!(status, StatusCode::NOT_FOUND, "{host}{path}");
            }
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
        // PKCE is required, and S256 only.
        for (from, to) in
            [("code_challenge_method=S256", "code_challenge_method=plain"), ("code_challenge=", "x=")]
        {
            let resp = h.send("GET", &authorize_url(&client, "").replace(from, to), None, &[]).await;
            assert_eq!(resp.status(), StatusCode::FOUND);
            let back = query_of(&location(&resp));
            assert_eq!((back["error"].as_str(), back["state"].as_str()), ("invalid_request", "xyz"));
        }
        let other = authorize_url(&client, "").replace("%2Fmcp", "%2Fother");
        assert_eq!(query_of(&location(&h.send("GET", &other, None, &[]).await))["error"], "invalid_target");
        let id = request(&h, &client).await;
        let (status, info) = h.call("GET", &format!("/oauth/request/{id}"), None).await;
        assert_eq!(
            (status, &info["client"], &info["redirectHost"]),
            (StatusCode::OK, &json!("Claude"), &json!("assistant.example"))
        );
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
        // The replaced one again: two holders of one session. It ends for both.
        assert_eq!(refresh(first.to_owned()).await.1["error"], "invalid_grant");
        assert_eq!(refresh(second).await.1["error"], "invalid_grant");
        let access = next["access_token"].as_str().unwrap();
        assert_eq!(
            call_mcp(&h, access).await.status(),
            StatusCode::UNAUTHORIZED,
            "its access token is refused too"
        );
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
        let (_, answer) =
            post_form(&h, "/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", refresh)])
                .await;
        assert_eq!(answer["error"], "invalid_grant");
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
        let (_, answer) =
            post_form(&h, "/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", refresh)])
                .await;
        assert_eq!(answer["error"], "invalid_grant");
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
            who: Who::Member { library: LIB.into(), member_hash: sha(TOKEN.as_bytes()) },
            refresh_hash: String::new(),
            previous_hash: None,
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
            who: Who::Guest { gid: "0a1b2c3d".into(), host: LIB.into(), name: "Sam".into() },
            refresh_hash: String::new(),
            previous_hash: None,
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
