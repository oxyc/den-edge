//! Guest grants (oxyc/den#100): a library owner invites a named, revocable, optionally expiring guest who
//! gets the owner's addons without ever holding one of their install links.
//!
//!   POST   /lib/{id}/grants          { name, addons, installs, codeExpiresAt?, accessDays?|accessUntil?, devices? } → { gid, code, grant }
//!   GET    /lib/{id}/grants          → { grants }
//!   PUT    /lib/{id}/grants/{gid}    any of the fields above → { grant }
//!   DELETE /lib/{id}/grants/{gid}    revokes → 204
//!   POST   /grant/redeem             { code, secretHash } → { gid, name, addons, expiresAt }
//!   GET    /grant/addons             (x-den-grant) → { gid, name, expiresAt, addons: { <addon>: "/<addon>/~<gid>" } }
//!   DELETE /grant/{gid}              (x-den-grant) the guest leaves → 204
//!
//! The host proves membership as `is_member` does (`x-den-library-member: <id>:<token>`, `<id>` being the
//! library in the path). A guest is NOT a member: it holds a per-device secret whose SHA-256 is all that is kept,
//! sent as `x-den-grant: <gid>:<secret>` and honoured by the relay (`relay::guest`), which swaps the virtual
//! `~<gid>` install for the host's real one. That real install is the escrow: only its validated single config
//! segment is stored, never a URL, so the relay table alone decides where a request goes.
//!
//! Every secret comes from the OS random source and only its hash is written down; comparisons are constant time.
//! Nothing here is derived from the clock except expiry, which is decided from `state.clock` on every call, so it
//! is exact without a timer. A sweep ends the remux sessions of a grant that stopped being live and reaps the
//! records 30 days after.
//!
//! On disk: `grants/`, one file per grant (`g:<gid>`) and an `index` of `{gid, host}` — the store cannot list a
//! directory, and the per-host live cap and the sweep both need to. The directory is mode 0700 and is left out
//! of backups: escrow is a bearer copy of the host's installs, and a restored store simply reissues.

use crate::handler::{
    constant_time_eq, error, internal, json_reply, method_not_allowed, read_json, retry_after, MAX_BODY_BYTES,
};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::Full;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// The guest's credential, `<gid>:<secret>`. Same origin only, never in a URL.
pub const HEADER: &str = "x-den-grant";
/// The addons a grant may hand out: the ones the relay table names and the web app browses with.
pub const ADDONS: [&str; 4] = ["scout", "atlas", "reel", "subtitles"];

const NS: &str = "grants";
const INDEX: &str = "index";
const VERSION: u32 = 1;
const DAY_MS: u64 = 86_400_000;
const CODE_DEFAULT_MS: u64 = 14 * DAY_MS;
const CODE_MAX_MS: u64 = 90 * DAY_MS;
/// How long an ended grant's record is kept, so the host can still see it and extend it.
const REAP_MS: u64 = 30 * DAY_MS;
/// Grants a host may have running (invited or active).
const MAX_LIVE: usize = 10;
/// Records of one host, ended ones included, so revoking and re-inviting cannot grow the store without bound.
const MAX_RECORDS: usize = 100;
const NAME_MAX: usize = 60;
/// A config segment is a few hundred bytes; this is room, not a target.
const SEGMENT_MAX: usize = 2048;
const SEGMENT_MIN: usize = 16;
/// Grant records across every host, ended ones included, so the index and the sweep stay small.
const MAX_TOTAL: usize = 200;
/// Redeem attempts per address per minute. A code is 128 bits, so this is about not doing work for a flood.
const REDEEM_PER_WINDOW: u32 = 10;
const HOST_PER_WINDOW: u32 = 60;
const ADDONS_PER_WINDOW: u32 = 300;
/// Distinct addresses one grant may open the public media listener for, so rotating addresses cannot open
/// many sources. A source is forgotten after the longest a session lives.
pub const MAX_SOURCES: usize = 4;
const SOURCE_TTL_MS: u64 = 6 * 60 * 60 * 1000;
const SWEEP_EVERY: Duration = Duration::from_secs(30);
const KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// What lives in memory beside the records: nothing here is worth writing to disk.
#[derive(Default)]
pub struct Grants {
    /// Held across every read-modify-write of a record or the index, and so across redeem's check-and-mark.
    lock: tokio::sync::Mutex<()>,
    /// When each grant last made a call. Kept in memory: a write per relayed call would be the hot path's cost.
    last_used: Mutex<HashMap<String, u64>>,
    /// Source addresses a grant's media listener was opened for, and when.
    sources: Mutex<HashMap<String, Vec<(IpAddr, u64)>>>,
    /// Ended grants whose remux sessions were already killed, so the sweep asks once rather than every tick.
    killed: Mutex<HashSet<String>>,
    kill_unconfigured: AtomicBool,
}

impl Grants {
    /// May `gid` open its media listener for `addr`? A known address always may; a new one only while the
    /// grant holds fewer than `MAX_SOURCES`.
    pub fn allow_source(&self, gid: &str, addr: IpAddr, now: u64) -> bool {
        let mut sources = crate::lock(&self.sources);
        let list = sources.entry(gid.to_owned()).or_default();
        list.retain(|(_, at)| now.saturating_sub(*at) < SOURCE_TTL_MS);
        if let Some(known) = list.iter_mut().find(|(a, _)| *a == addr) {
            known.1 = now;
            return true;
        }
        if list.len() >= MAX_SOURCES {
            return false;
        }
        list.push((addr, now));
        true
    }

    fn forget(&self, gid: &str) {
        crate::lock(&self.sources).remove(gid);
        crate::lock(&self.last_used).remove(gid);
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Record {
    v: u32,
    gid: String,
    name: String,
    /// The library that owns it.
    host: String,
    /// Hex SHA-256 of the invite code.
    code_hash: String,
    /// Hex SHA-256 of each redeemed device's secret.
    devices: Vec<String>,
    max_devices: u32,
    addons: Vec<String>,
    /// The escrow: addon → the host's real config segment.
    installs: BTreeMap<String, String>,
    created_at: u64,
    code_expires_at: u64,
    access_days: Option<u32>,
    access_until: Option<u64>,
    redeemed_at: Option<u64>,
    revoked_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    v: u32,
    entries: Vec<IndexEntry>,
}

#[derive(Serialize, Deserialize, Clone)]
struct IndexEntry {
    gid: String,
    host: String,
}

/// When access ends, if it is known: an absolute date, or the trial length counted from the first redeem.
fn end(r: &Record) -> Option<u64> {
    r.access_until.or_else(|| Some(r.redeemed_at? + u64::from(r.access_days?) * DAY_MS))
}

/// The instant the grant stops being usable by expiry (possibly still ahead): an invited grant when its code or
/// its absolute end lapses first, a redeemed one at its end.
fn expires_at(r: &Record) -> Option<u64> {
    match r.redeemed_at {
        Some(_) => end(r),
        None => Some(end(r).map_or(r.code_expires_at, |e| e.min(r.code_expires_at))),
    }
}

fn status(r: &Record, now: u64) -> &'static str {
    if r.revoked_at.is_some() {
        "revoked"
    } else if expires_at(r).is_some_and(|t| now >= t) {
        "expired"
    } else if r.redeemed_at.is_some() {
        "active"
    } else {
        "invited"
    }
}

fn is_live(r: &Record, now: u64) -> bool {
    matches!(status(r, now), "invited" | "active")
}

/// When a grant that is no longer live stopped being so.
fn ended_at(r: &Record, now: u64) -> Option<u64> {
    r.revoked_at.or_else(|| expires_at(r).filter(|t| now >= *t))
}

fn grant_json(state: &AppState, r: &Record, now: u64) -> Value {
    json!({
        "gid": r.gid,
        "name": r.name,
        "status": status(r, now),
        "addons": r.addons,
        "createdAt": r.created_at,
        "codeExpiresAt": r.code_expires_at,
        "accessDays": r.access_days,
        "accessUntil": r.access_until,
        "redeemedAt": r.redeemed_at,
        "expiresAt": end(r),
        "devices": r.max_devices,
        "deviceCount": r.devices.len(),
        "lastUsedAt": crate::lock(&state.grants.last_used).get(&r.gid).copied(),
    })
}

fn key(gid: &str) -> String {
    format!("g:{gid}")
}

async fn load(state: &AppState, gid: &str) -> io::Result<Option<Record>> {
    let Some(bytes) = state.store.get(NS, &key(gid)).await? else { return Ok(None) };
    let record: Record = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if record.v > VERSION {
        return Err(io::Error::other("a grant record from a newer den-edge"));
    }
    Ok(Some(record))
}

async fn save(state: &AppState, r: &Record) -> io::Result<()> {
    state.store.put(NS, &key(&r.gid), &serde_json::to_vec(r).expect("a grant always serialises")).await?;
    // Synced so a revocation cannot come back after a power loss.
    state.store.sync_dir(NS).await
}

async fn load_index(state: &AppState) -> io::Result<Index> {
    match state.store.get(NS, INDEX).await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        None => Ok(Index { v: VERSION, entries: Vec::new() }),
    }
}

async fn save_index(state: &AppState, index: &Index) -> io::Result<()> {
    state.store.put(NS, INDEX, &serde_json::to_vec(index).expect("the index always serialises")).await?;
    state.store.sync_dir(NS).await
}

fn valid_gid(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// One base64url config segment: the only thing escrow keeps. Nothing that could be a URL, a scheme, a path or a
/// virtual `~` install, so a host cannot point the relay anywhere or make a grant hand out a grant. Unpadded, and
/// long enough that replacing it with `~<gid>` in an answer cannot mangle unrelated text.
fn valid_segment(s: &str) -> bool {
    (SEGMENT_MIN..=SEGMENT_MAX).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// A name a host can read back without it being disguised: no control, bidi or zero-width format characters.
fn valid_name(s: &str) -> bool {
    (1..=NAME_MAX).contains(&s.chars().count())
        && !s.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
        })
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url.
fn b64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
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
    // Leftover bits of a canonical encoding are zero.
    (acc == 0).then_some(out)
}

/// `%XX` decoded, or `None` for a `%` that is not followed by two hex digits.
pub fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

fn sha(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

fn not_found() -> Response {
    json_reply(StatusCode::NOT_FOUND, &error("not_found"))
}

fn bad_request() -> Response {
    json_reply(StatusCode::BAD_REQUEST, &error("bad_request"))
}

/// One answer for every reason a code can fail, so it cannot be used to tell them apart.
fn invalid_code() -> Response {
    json_reply(StatusCode::NOT_FOUND, &error("invalid_code"))
}

fn no_content() -> Response {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

fn gate(state: &AppState, ip: &str, what: &str, limit: u32) -> Option<Response> {
    crate::link::throttled_at(state, &format!("{what}:{ip}"), limit)
        .map(|wait| retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait))
}

/// `/lib/{id}/grants` or `/lib/{id}/grants/{gid}`: the id, and the gid when there is one.
fn host_route(path: &str) -> Option<(&str, Option<&str>)> {
    let mut parts = path.strip_prefix("/lib/")?.split('/');
    let id = parts.next()?;
    if parts.next()? != "grants" {
        return None;
    }
    let gid = parts.next();
    if parts.next().is_some() {
        return None;
    }
    match gid {
        Some("") => None,
        gid => Some((id, gid)),
    }
}

pub fn is_host_path(path: &str) -> bool {
    host_route(path).is_some()
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    if let Some((id, gid)) = host_route(&path) {
        return host(state, req, id, gid).await;
    }
    match (path.as_str(), req.method().clone()) {
        ("/grant/redeem", Method::POST) => redeem(state, req).await,
        ("/grant/addons", Method::GET | Method::HEAD) => addons(state, req).await,
        (p, Method::DELETE) if p.strip_prefix("/grant/").is_some_and(valid_gid) => {
            leave(state, req, &p["/grant/".len()..]).await
        }
        ("/grant/redeem" | "/grant/addons", _) => method_not_allowed(),
        _ => not_found(),
    }
}

// ---- the host's side

async fn host(state: &AppState, req: Request, id: &str, gid: Option<&str>) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, &ip, "grants-host", HOST_PER_WINDOW) {
        return limited;
    }
    let claim =
        req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    // The proof must be for the library in the path: a member of some other library here is not this host.
    let names_it = claim.as_deref().and_then(|c| c.split_once(':')).is_some_and(|(claimed, _)| claimed == id);
    if !names_it || !crate::library::is_member(state, claim.as_deref()).await {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    }
    match (req.method().clone(), gid) {
        (Method::POST, None) => create(state, id, req).await,
        (Method::GET | Method::HEAD, None) => list(state, id).await,
        (Method::PUT, Some(gid)) => update(state, id, gid, req).await,
        (Method::DELETE, Some(gid)) => revoke(state, id, gid).await,
        _ => method_not_allowed(),
    }
}

/// Apply a create or update body to `r`. `None` is any invalid field, or a result that is not a whole grant.
fn apply(r: &mut Record, body: &Map<String, Value>, now: u64, creating: bool) -> Option<()> {
    if let Some(v) = body.get("name") {
        let name = v.as_str()?.trim();
        if !valid_name(name) {
            return None;
        }
        r.name = name.to_owned();
    }
    if let Some(v) = body.get("addons") {
        let mut list: Vec<String> = Vec::new();
        for addon in v.as_array()? {
            let addon = addon.as_str().filter(|a| ADDONS.contains(a))?;
            if !list.iter().any(|a| a == addon) {
                list.push(addon.to_owned());
            }
        }
        r.addons = list;
    }
    if let Some(v) = body.get("installs") {
        for (addon, segment) in v.as_object()? {
            let segment = segment.as_str().filter(|s| valid_segment(s))?;
            if !ADDONS.contains(&addon.as_str()) {
                return None;
            }
            r.installs.insert(addon.clone(), segment.to_owned());
        }
    }
    if let Some(v) = body.get("codeExpiresAt") {
        let at = v.as_u64()?;
        if at <= now || at > now + CODE_MAX_MS {
            return None;
        }
        r.code_expires_at = at;
    }
    let (days, until) = (body.get("accessDays"), body.get("accessUntil"));
    let set = |v: Option<&Value>| v.is_some_and(|v| !v.is_null());
    if set(days) && set(until) {
        return None;
    }
    if let Some(v) = days {
        r.access_days = if v.is_null() {
            None
        } else {
            let n = v.as_u64().filter(|n| (1..=365).contains(n))?;
            r.access_until = None;
            Some(n as u32)
        };
    }
    if let Some(v) = until {
        r.access_until = if v.is_null() {
            None
        } else {
            let at = v.as_u64().filter(|at| !creating || *at > now)?;
            r.access_days = None;
            Some(at)
        };
    }
    if let Some(v) = body.get("devices") {
        r.max_devices = v.as_u64().filter(|n| (1..=5).contains(n))? as u32;
    }
    r.installs.retain(|addon, _| r.addons.contains(addon));
    let whole = !r.name.is_empty()
        && !r.addons.is_empty()
        && r.addons.iter().all(|addon| r.installs.contains_key(addon));
    whole.then_some(())
}

/// Grants are only meaningful when strangers cannot start a library of their own: under `NEW_LIBRARIES=open`
/// anyone could create one and mint a guest that reaches the household's remux.
pub fn libraries_are_members_only(state: &AppState) -> bool {
    state.new_libraries == crate::library::NewLibraries::Members
}

async fn create(state: &AppState, host: &str, req: Request) -> Response {
    if !libraries_are_members_only(state) {
        return json_reply(StatusCode::FORBIDDEN, &error("new_libraries_closed"));
    }
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let now = state.now();
    let mut record = Record {
        v: VERSION,
        gid: String::new(),
        name: String::new(),
        host: host.to_owned(),
        code_hash: String::new(),
        devices: Vec::new(),
        max_devices: 1,
        addons: Vec::new(),
        installs: BTreeMap::new(),
        created_at: now,
        code_expires_at: now + CODE_DEFAULT_MS,
        access_days: None,
        access_until: None,
        redeemed_at: None,
        revoked_at: None,
    };
    if body.as_object().and_then(|map| apply(&mut record, map, now, true)).is_none() {
        return bad_request();
    }
    let _lock = state.grants.lock.lock().await;
    let mut index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("grants index", e),
    };
    let mine: Vec<&IndexEntry> = index.entries.iter().filter(|e| e.host == host).collect();
    let mut live = 0;
    for entry in &mine {
        match load(state, &entry.gid).await {
            Ok(Some(r)) if is_live(&r, now) => live += 1,
            Ok(_) => {}
            Err(e) => return internal("grant read", e),
        }
    }
    if live >= MAX_LIVE || mine.len() >= MAX_RECORDS || index.entries.len() >= MAX_TOTAL {
        return json_reply(StatusCode::CONFLICT, &error("too_many_grants"));
    }
    record.gid = loop {
        let gid = crate::hex(&crate::random_bytes::<4>());
        if !index.entries.iter().any(|e| e.gid == gid) {
            break gid;
        }
    };
    let code = format!("{}.{}", record.gid, b64url(&crate::random_bytes::<16>()));
    record.code_hash = sha(code.as_bytes());
    // The record first: a crash between the two leaves a file nothing lists, never a listed grant with no file.
    if let Err(e) = save(state, &record).await {
        return internal("grant write", e);
    }
    index.v = VERSION;
    index.entries.push(IndexEntry { gid: record.gid.clone(), host: host.to_owned() });
    if let Err(e) = save_index(state, &index).await {
        return internal("grants index write", e);
    }
    json_reply(
        StatusCode::CREATED,
        &json!({ "gid": record.gid, "code": code, "grant": grant_json(state, &record, now) }),
    )
}

async fn list(state: &AppState, host: &str) -> Response {
    let now = state.now();
    let index = match load_index(state).await {
        Ok(index) => index,
        Err(e) => return internal("grants index", e),
    };
    let mut records = Vec::new();
    for entry in index.entries.iter().filter(|e| e.host == host) {
        match load(state, &entry.gid).await {
            Ok(Some(r)) if r.host == host => records.push(r),
            Ok(_) => {}
            Err(e) => return internal("grant read", e),
        }
    }
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.gid.cmp(&b.gid)));
    let grants: Vec<Value> = records.iter().map(|r| grant_json(state, r, now)).collect();
    json_reply(StatusCode::OK, &json!({ "grants": grants }))
}

/// A grant that is this host's and has not been revoked. A revoked one is gone for the host's purposes too.
async fn owned(state: &AppState, host: &str, gid: &str) -> Result<Record, Box<Response>> {
    match load(state, gid).await {
        Ok(Some(r)) if r.host == host && r.revoked_at.is_none() => Ok(r),
        Ok(_) => Err(Box::new(not_found())),
        Err(e) => Err(Box::new(internal("grant read", e))),
    }
}

async fn update(state: &AppState, host: &str, gid: &str, req: Request) -> Response {
    let body = match read_json(req, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let now = state.now();
    let _lock = state.grants.lock.lock().await;
    let mut record = match owned(state, host, gid).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    if body.as_object().and_then(|map| apply(&mut record, map, now, false)).is_none() {
        return bad_request();
    }
    if let Err(e) = save(state, &record).await {
        return internal("grant write", e);
    }
    // An extension can bring an ended grant back to life; its sessions must be ended again when it next lapses.
    crate::lock(&state.grants.killed).remove(gid);
    json_reply(StatusCode::OK, &json!({ "grant": grant_json(state, &record, now) }))
}

/// End a grant: it stops answering, its escrow and device secrets are dropped, and its remux sessions are killed.
async fn end_grant(state: &AppState, record: &mut Record, now: u64) -> io::Result<()> {
    record.revoked_at.get_or_insert(now);
    record.devices.clear();
    record.installs.clear();
    save(state, record).await
}

async fn revoke(state: &AppState, host: &str, gid: &str) -> Response {
    let now = state.now();
    {
        let _lock = state.grants.lock.lock().await;
        let mut record = match load(state, gid).await {
            Ok(Some(r)) if r.host == host => r,
            Ok(_) => return not_found(),
            Err(e) => return internal("grant read", e),
        };
        if let Err(e) = end_grant(state, &mut record, now).await {
            return internal("grant write", e);
        }
    }
    end_sessions(state, gid).await;
    no_content()
}

// ---- the guest's side

/// Why a guest's credential was refused.
pub enum Denied {
    /// Unknown, revoked, or a secret that does not match: all one answer.
    NotFound,
    /// The secret matched, but access ended at this time.
    Expired(u64),
}

/// A live, authenticated grant, as the relay needs it.
pub struct Live {
    pub gid: String,
    pub name: String,
    /// The library that shares it.
    pub host: String,
    pub addons: Vec<String>,
    pub installs: BTreeMap<String, String>,
    pub expires_at: Option<u64>,
}

/// Whether a grant is live now, without its secret: for what a grant's holder was given in its name (an assistant's
/// connection, `oauth.rs`), which must stop the moment the grant is revoked, expires or is shortened. The end of
/// access, if it has one, when it is.
pub async fn standing(state: &AppState, gid: &str) -> Option<Option<u64>> {
    if !valid_gid(gid) {
        return None;
    }
    let record = match load(state, gid).await {
        Ok(Some(r)) => r,
        Ok(None) => return None,
        Err(e) => {
            eprintln!("grant read: {e}");
            return None;
        }
    };
    (record.redeemed_at.is_some() && is_live(&record, state.now())).then(|| end(&record))
}

/// `<gid>:<secret>`.
fn parse_header(value: &str) -> Option<(&str, &str)> {
    let (gid, secret) = value.split_once(':')?;
    let ok = valid_gid(gid)
        && !secret.is_empty()
        && secret.len() <= 128
        && secret.bytes().all(|b| b.is_ascii_graphic());
    ok.then_some((gid, secret))
}

/// The grant a request's `x-den-grant` value names, when its secret is one of its devices' and it is live.
/// `path_gid` is the gid the URL names, which must be the header's own. Expiry is only revealed to a caller that
/// proved the secret: to anyone else an expired grant is as unknown as a wrong one.
pub async fn authenticate(
    state: &AppState,
    header: Option<&str>,
    path_gid: Option<&str>,
) -> Result<Live, Denied> {
    let (gid, secret) = header.and_then(parse_header).ok_or(Denied::NotFound)?;
    if path_gid.is_some_and(|p| p != gid) {
        return Err(Denied::NotFound);
    }
    let record = match load(state, gid).await {
        Ok(Some(r)) => r,
        Ok(None) => return Err(Denied::NotFound),
        Err(e) => {
            eprintln!("grant read: {e}");
            return Err(Denied::NotFound);
        }
    };
    let want = sha(secret.as_bytes());
    // Every device is compared, whichever matches, so the answer takes the same time.
    let matched =
        record.devices.iter().fold(false, |found, d| constant_time_eq(d.as_bytes(), want.as_bytes()) | found);
    if !matched || record.revoked_at.is_some() {
        return Err(Denied::NotFound);
    }
    let now = state.now();
    if let Some(at) = expires_at(&record).filter(|at| now >= *at) {
        return Err(Denied::Expired(at));
    }
    crate::lock(&state.grants.last_used).insert(record.gid.clone(), now);
    Ok(Live {
        expires_at: end(&record),
        gid: record.gid,
        name: record.name,
        host: record.host,
        addons: record.addons,
        installs: record.installs,
    })
}

fn expired_reply(at: u64) -> Response {
    json_reply(StatusCode::GONE, &json!({ "error": "grant_expired", "expiredAt": at }))
}

fn header_of(req: &Request) -> Option<String> {
    req.headers().get(HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

async fn redeem(state: &AppState, req: Request) -> Response {
    // Counted before anything is read: the point is to not do work for a flood, and every attempt counts.
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, &ip, "grant-redeem", REDEEM_PER_WINDOW) {
        return limited;
    }
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), 4096).await else { return invalid_code() };
    let Ok(body) = serde_json::from_slice::<Value>(&bytes) else { return invalid_code() };
    let (Some(code), Some(secret_hash)) =
        (body.get("code").and_then(Value::as_str), body.get("secretHash").and_then(Value::as_str))
    else {
        return invalid_code();
    };
    let Some(device) = b64url_decode(secret_hash).filter(|h| h.len() == 32).map(|h| crate::hex(&h)) else {
        return invalid_code();
    };
    let Some(gid) = code.split_once('.').map(|(gid, _)| gid).filter(|gid| valid_gid(gid)) else {
        return invalid_code();
    };
    if code.len() > 64 {
        return invalid_code();
    }
    let now = state.now();
    let _lock = state.grants.lock.lock().await;
    let mut record = match load(state, gid).await {
        Ok(Some(r)) => r,
        Ok(None) => return invalid_code(),
        Err(e) => {
            eprintln!("grant read: {e}");
            return invalid_code();
        }
    };
    if !constant_time_eq(record.code_hash.as_bytes(), sha(code.as_bytes()).as_bytes())
        || !is_live(&record, now)
    {
        return invalid_code();
    }
    // A device that already redeemed is let back in whatever else has changed since, so a lost answer can be retried.
    let known = record
        .devices
        .iter()
        .fold(false, |found, d| constant_time_eq(d.as_bytes(), device.as_bytes()) | found);
    if !known {
        // The redeem-by date binds every new device, not only the first: it is what the host was told the code lasts.
        if now >= record.code_expires_at || record.devices.len() >= record.max_devices as usize {
            return invalid_code();
        }
        record.devices.push(device);
        // The access clock starts with the first redeem and never again.
        record.redeemed_at.get_or_insert(now);
        // Marked before it is answered: a guest told "yes" holds a slot that is on disk.
        if let Err(e) = save(state, &record).await {
            eprintln!("grant write: {e}");
            return invalid_code();
        }
    }
    json_reply(
        StatusCode::OK,
        &json!({ "gid": record.gid, "name": record.name, "addons": record.addons, "expiresAt": end(&record) }),
    )
}

async fn addons(state: &AppState, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, &ip, "grant-addons", ADDONS_PER_WINDOW) {
        return limited;
    }
    match authenticate(state, header_of(&req).as_deref(), None).await {
        Ok(live) => {
            let addons: Map<String, Value> =
                live.addons.iter().map(|a| (a.clone(), json!(format!("/{a}/~{}", live.gid)))).collect();
            json_reply(
                StatusCode::OK,
                &json!({ "gid": live.gid, "name": live.name, "expiresAt": live.expires_at, "addons": addons }),
            )
        }
        Err(Denied::Expired(at)) => expired_reply(at),
        Err(Denied::NotFound) => not_found(),
    }
}

/// The guest leaves. The simplest honest meaning of it: the grant is revoked, which drops the device's secret
/// and the escrow and ends its sessions. The host sees it as revoked and can invite again.
async fn leave(state: &AppState, req: Request, gid: &str) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    if let Some(limited) = gate(state, &ip, "grant-addons", ADDONS_PER_WINDOW) {
        return limited;
    }
    // An expired grant can be left too: the secret is what proves it is theirs.
    match authenticate(state, header_of(&req).as_deref(), Some(gid)).await {
        Ok(_) | Err(Denied::Expired(_)) => {}
        Err(Denied::NotFound) => return not_found(),
    }
    let now = state.now();
    {
        let _lock = state.grants.lock.lock().await;
        let mut record = match load(state, gid).await {
            Ok(Some(r)) => r,
            Ok(None) => return not_found(),
            Err(e) => return internal("grant read", e),
        };
        if let Err(e) = end_grant(state, &mut record, now).await {
            return internal("grant write", e);
        }
    }
    end_sessions(state, gid).await;
    no_content()
}

/// Revoke every grant of a library that is going away, so its guests do not outlive the token that vouched for
/// them. Returns the gids to pass to `end_sessions` once the caller has let go of whatever it holds.
pub async fn revoke_host(state: &AppState, host: &str) -> io::Result<Vec<String>> {
    let now = state.now();
    let index = load_index(state).await?;
    let mut revoked = Vec::new();
    for entry in index.entries.iter().filter(|e| e.host == host) {
        let _lock = state.grants.lock.lock().await;
        let Some(mut record) = load(state, &entry.gid).await? else { continue };
        if record.host != host || record.revoked_at.is_some() {
            continue;
        }
        end_grant(state, &mut record, now).await?;
        revoked.push(entry.gid.clone());
    }
    Ok(revoked)
}

// ---- the relay's side

/// A request path of the form `/<addon>/~<gid>/…`, after decoding.
pub struct GuestPath {
    pub addon: &'static str,
    pub gid: String,
    /// Everything after the `~<gid>` segment as it arrived: empty, or starting with `/`.
    pub rest: String,
}

/// `None` when this path is not one of a guest's. `Some(Err)` when it is shaped like one but cannot be trusted:
/// a `~` that only appears once decoded (`%7E`), an empty or malformed gid, or a `..` or an encoded slash
/// anywhere after it. Those are refused rather than let through to be read differently upstream.
pub fn parse_guest_path(path: &str) -> Option<Result<GuestPath, ()>> {
    let (addon, tail) = path.strip_prefix('/')?.split_once('/')?;
    let addon = *ADDONS.iter().find(|a| **a == addon)?;
    let (segment, rest) = tail.find('/').map_or((tail, ""), |i| tail.split_at(i));
    let Some(decoded) = percent_decode(segment) else { return Some(Err(())) };
    if decoded.first() != Some(&b'~') {
        return None;
    }
    let gid = std::str::from_utf8(&decoded[1..]).ok().filter(|g| valid_gid(g));
    let clean = rest.split('/').all(|s| {
        percent_decode(s)
            .is_some_and(|d| d != b".." && d != b"." && !d.iter().any(|b| matches!(b, b'/' | b'\\' | 0)))
    });
    Some(match gid {
        Some(gid) if clean => Ok(GuestPath { addon, gid: gid.to_owned(), rest: rest.to_owned() }),
        _ => Err(()),
    })
}

/// What a guest may ask of an addon, by the path after `~<gid>`: the routes each addon serves under its config
/// that the web app calls, and never an install's own — `/configure`, `/config-key`, scout's `/stream` (its
/// lists carry play tickets) and `/play`. Reel's `/play`, `/hls`, `/m` and the like are served at its root, not
/// under a config, so a guest never names them with `~<gid>` and none is allowed here.
pub fn allowed(addon: &str, method: &Method, rest: &str) -> bool {
    let read = matches!(*method, Method::GET | Method::HEAD);
    let under = |dir: &str| rest.strip_prefix(dir).is_some_and(|r| r.is_empty() || r.starts_with('/'));
    if rest == "/manifest.json" {
        return read;
    }
    match addon {
        "scout" => *method == Method::POST && rest == "/availability",
        "atlas" => {
            (read
                && (under("/index")
                    || under("/catalog")
                    || matches!(rest, "/labels.json" | "/vectors.bin" | "/meta.json")))
                || (under("/recommend") && (read || *method == Method::POST))
        }
        "reel" => read && under("/meta"),
        "subtitles" => read && under("/subtitle"),
        _ => false,
    }
}

/// Does this query name one of `keys`? A guest may not ask for scout's `?debug`, nor put an install of its own
/// in a `/remux` query.
pub fn query_names(query: Option<&str>, keys: &[&str]) -> bool {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .any(|(k, _)| keys.iter().any(|n| k.eq_ignore_ascii_case(n)))
}

/// What a debrid service is called in a manifest, which tells a guest whose account is being spent.
const DEBRID: [&str; 12] = [
    "real-debrid",
    "realdebrid",
    "all-debrid",
    "alldebrid",
    "premiumize",
    "debrid-link",
    "debridlink",
    "torbox",
    "offcloud",
    "easydebrid",
    "putio",
    "pikpak",
];

fn scrub_text(text: &str) -> String {
    let mut out = text.to_owned();
    for name in DEBRID {
        let mut from = 0;
        // ASCII lowercasing keeps every byte offset, so a match found in the copy is a match in `out`.
        while let Some(i) = out.to_ascii_lowercase()[from..].find(name) {
            let at = from + i;
            out.replace_range(at..at + name.len(), "debrid");
            from = at + "debrid".len();
        }
    }
    out
}

/// A manifest as a guest may see it: without the host's install id, and without naming their debrid service.
pub fn strip_manifest(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("denInstallId");
            map.values_mut().for_each(strip_manifest);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_manifest),
        Value::String(text) => *text = scrub_text(text),
        _ => {}
    }
}

// ---- ending a grant's sessions

/// Everything a grant that stopped being live must lose: the source addresses it opened the media listener for,
/// the assistants connected in its name, and its sessions at den-remux. Returns whether remux was told (or had
/// nothing to be told).
pub async fn end_sessions(state: &AppState, gid: &str) -> bool {
    state.grants.forget(gid);
    crate::oauth::end_grant(state, gid).await;
    let done = kill_remux(state, gid).await;
    if done {
        crate::lock(&state.grants.killed).insert(gid.to_owned());
    }
    done
}

async fn kill_remux(state: &AppState, gid: &str) -> bool {
    let target = crate::relay::target(&state.relays, "/remux/admin/kill");
    let (Some(secret), Some(url)) = (state.remux_edge_secret.as_deref(), target) else {
        // Guest sessions are only ever offered with the secret set, so there is nothing to end. Said once.
        if !state.grants.kill_unconfigured.swap(true, Ordering::Relaxed) {
            eprintln!("grants: REMUX_EDGE_SECRET or the /remux relay is unset — no remux sessions to end for a grant");
        }
        return true;
    };
    let body = json!({ "owner": format!("grant:{gid}") }).to_string();
    let Ok(request) = axum::http::Request::builder()
        .method(Method::POST)
        .uri(url)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-den-edge-secret", secret)
        .body(Full::new(Bytes::from(body)))
    else {
        return false;
    };
    match tokio::time::timeout(KILL_TIMEOUT, state.relay_client.request(request)).await {
        Ok(Ok(answer)) if answer.status().is_success() => true,
        Ok(Ok(answer)) => {
            eprintln!("grants: ending sessions of {gid}: remux said {}", answer.status());
            false
        }
        Ok(Err(e)) => {
            eprintln!("grants: ending sessions of {gid}: {e}");
            false
        }
        Err(_) => {
            eprintln!("grants: ending sessions of {gid}: remux timed out");
            false
        }
    }
}

/// One pass: end the sessions of every grant that is no longer live, once, and reap the records of those that
/// ended 30 days ago. A kill that fails is tried again on the next pass.
pub async fn sweep(state: &AppState) {
    let now = state.now();
    // The ids are read once and each grant is then locked on its own, so a create or a redeem waits for one record
    // and not for the whole scan.
    let entries = match load_index(state).await {
        Ok(index) => index.entries,
        Err(e) => {
            eprintln!("grants sweep: {e}");
            return;
        }
    };
    let mut ended = Vec::new();
    let mut gone = Vec::new();
    for entry in entries {
        let _lock = state.grants.lock.lock().await;
        match load(state, &entry.gid).await {
            Ok(Some(record)) => match ended_at(&record, now) {
                Some(at) if now >= at + REAP_MS => {
                    if let Err(e) = state.store.delete(NS, &key(&entry.gid)).await {
                        eprintln!("grants sweep: {e}");
                        continue;
                    }
                    state.grants.forget(&entry.gid);
                    crate::lock(&state.grants.killed).remove(&entry.gid);
                    gone.push(entry.gid);
                }
                Some(_) => {
                    if !crate::lock(&state.grants.killed).contains(&entry.gid) {
                        ended.push(entry.gid);
                    }
                }
                None => {
                    crate::lock(&state.grants.killed).remove(&entry.gid);
                }
            },
            Ok(None) => gone.push(entry.gid),
            Err(e) => eprintln!("grants sweep: {e}"),
        }
    }
    if !gone.is_empty() {
        let _lock = state.grants.lock.lock().await;
        match load_index(state).await {
            Ok(mut index) => {
                index.entries.retain(|e| !gone.contains(&e.gid));
                if let Err(e) = save_index(state, &index).await {
                    eprintln!("grants sweep: {e}");
                }
            }
            Err(e) => eprintln!("grants sweep: {e}"),
        }
    }
    for gid in ended {
        end_sessions(state, &gid).await;
    }
}

pub async fn sweep_forever(state: std::sync::Arc<AppState>) {
    loop {
        tokio::time::sleep(SWEEP_EVERY).await;
        sweep(&state).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, temp_dir, Harness};
    use axum::http::HeaderMap;
    use std::sync::Arc;

    const LIB: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "the-write-token";
    const SCOUT: &str = "c2NvdXQtY29uZmlnLXNlZ21lbnQ";
    const ATLAS: &str = "YXRsYXMtY29uZmln";
    const SUBS: &str = "c3Vicy1jb25maWctc2VnbWVudA";
    const REEL: &str = "cmVlbC1jb25maWctc2VnbWVudA";
    const SECRET: &str = "the-guests-device-secret-of-43-chars-000000";
    const SECRET2: &str = "a-second-device-secret-of-43-chars-0000000";

    fn member() -> String {
        format!("{LIB}:{TOKEN}")
    }

    async fn start_library(h: &Harness) {
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK);
    }

    /// Starts the host's library while anyone may, then closes the store to strangers as grants require.
    async fn members_only(mut h: Harness) -> Harness {
        start_library(&h).await;
        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Members;
        h
    }

    async fn harness() -> Harness {
        members_only(Harness::new()).await
    }

    async fn host_call(h: &Harness, method: &str, suffix: &str, body: Option<Value>) -> (StatusCode, Value) {
        let claim = member();
        let resp = h
            .send(
                method,
                &format!("/lib/{LIB}/grants{suffix}"),
                body.map(|b| b.to_string()),
                &[("x-den-library-member", &claim), ("content-type", "application/json")],
            )
            .await;
        let status = resp.status();
        (status, body_json(resp).await)
    }

    fn invite(extra: Value) -> Value {
        let mut body = json!({
            "name": "Sam",
            "addons": ["scout", "atlas"],
            "installs": { "scout": SCOUT, "atlas": ATLAS },
        });
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        body
    }

    async fn invited(h: &Harness, extra: Value) -> (String, String) {
        let (status, made) = host_call(h, "POST", "", Some(invite(extra))).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        (made["gid"].as_str().unwrap().to_owned(), made["code"].as_str().unwrap().to_owned())
    }

    async fn redeem_with(h: &Harness, code: &str, secret: &str) -> (StatusCode, Value) {
        let hash = b64url(&Sha256::digest(secret.as_bytes()));
        h.call("POST", "/grant/redeem", Some(json!({ "code": code, "secretHash": hash }))).await
    }

    /// A grant that has been redeemed once with `SECRET`, and the header that proves it.
    async fn redeemed(h: &Harness, extra: Value) -> (String, String) {
        let (gid, code) = invited(h, extra).await;
        assert_eq!(redeem_with(h, &code, SECRET).await.0, StatusCode::OK);
        let header = format!("{gid}:{SECRET}");
        (gid, header)
    }

    fn grant_headers(header: &str) -> [(&str, &str); 1] {
        [(HEADER, header)]
    }

    #[test]
    fn base64url_round_trips_and_refuses_the_non_canonical() {
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(b64url(b"a"), "YQ");
        assert_eq!(b64url_decode("-_8"), Some(vec![0xfb, 0xff]));
        let bytes = crate::random_bytes::<32>();
        assert_eq!(b64url_decode(&b64url(&bytes)), Some(bytes.to_vec()));
        assert_eq!(b64url_decode("YR"), None, "trailing bits must be zero");
        assert_eq!(b64url_decode("Y"), None);
        assert_eq!(b64url_decode("a+b/"), None, "standard base64 is not base64url");
    }

    #[test]
    fn a_config_segment_is_one_bare_token() {
        assert!(valid_segment(SCOUT));
        for bad in [
            "",
            "a",
            &"a".repeat(15),
            "abcdefghijklmnop=",
            "a/b",
            "a:b",
            "~abc",
            "a.b",
            "a b",
            "http://x",
            "a%2Fb",
            "a?b",
            &"a".repeat(2049),
        ] {
            assert!(!valid_segment(bad), "{bad:?}");
        }
        assert!(valid_segment(&"a".repeat(16)) && valid_segment(&"a".repeat(2048)));
    }

    #[test]
    fn a_name_cannot_hide_behind_invisible_or_reordering_characters() {
        assert!(valid_name("Sam Ö") && valid_name(&"n".repeat(NAME_MAX)));
        for bad in [
            "",
            &"n".repeat(NAME_MAX + 1),
            "a\nb",
            "a\u{202E}b",
            "a\u{200B}b",
            "a\u{2066}b",
            "\u{FEFF}a",
            "a\u{200F}",
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_guest_path_is_decoded_before_it_is_believed() {
        let ok = |p: &str| parse_guest_path(p).unwrap().ok().map(|g| (g.addon, g.gid, g.rest));
        assert_eq!(
            ok("/scout/~0a1b2c3d/manifest.json"),
            Some(("scout", "0a1b2c3d".into(), "/manifest.json".into()))
        );
        assert_eq!(
            ok("/atlas/%7E0a1b2c3d/catalog/x.json"),
            Some(("atlas", "0a1b2c3d".into(), "/catalog/x.json".into()))
        );
        assert_eq!(ok("/reel/%7e0a1b2c3d"), Some(("reel", "0a1b2c3d".into(), String::new())));
        for bad in [
            "/scout/~/x",
            "/scout/~0A1B2C3D/x",
            "/scout/~0a1b2c3d/../x",
            "/scout/~0a1b2c3d/%2e%2E/x",
            "/scout/~0a1b2c3d/a%2Fb",
            "/scout/~0a1b2c3d%2Fx/y",
            "/scout/~0a1b2c3d/a%5Cb",
            "/scout/~0a1b2c3d/%zz",
            "/scout/~0a1b2c3d1/x",
        ] {
            assert!(parse_guest_path(bad).unwrap().is_err(), "{bad}");
        }
        for not_guest in
            ["/scout/abc/x", "/scout", "/remux/~0a1b2c3d/x", "/nope/~0a1b2c3d/x", "/lib/x/grants"]
        {
            assert!(parse_guest_path(not_guest).is_none(), "{not_guest}");
        }
    }

    #[test]
    fn a_guest_may_browse_and_never_reach_streams_or_setup() {
        let (get, post) = (Method::GET, Method::POST);
        assert!(allowed("scout", &get, "/manifest.json"));
        assert!(allowed("scout", &post, "/availability"));
        for path in [
            "/stream/movie/tt1.json",
            "/play/x",
            "/p/ticket",
            "/configure",
            "/config-key",
            "/catalog/movie/top.json",
            "/meta/movie/tt1.json",
            "",
        ] {
            assert!(!allowed("scout", &get, path), "{path}");
            assert!(!allowed("scout", &post, path), "{path}");
        }
        assert!(!allowed("scout", &get, "/availability"));
        assert!(allowed("atlas", &post, "/recommend") && allowed("atlas", &get, "/recommend"));
        assert!(allowed("atlas", &get, "/index/row/movie.json"));
        assert!(allowed("atlas", &get, "/catalog/movie/top.json"));
        for path in ["/labels.json", "/vectors.bin", "/meta.json"] {
            assert!(allowed("atlas", &get, path), "{path}");
        }
        assert!(!allowed("atlas", &post, "/index/x") && !allowed("atlas", &get, "/labels"));
        assert!(
            allowed("reel", &get, "/meta/movie/tt1.json") && !allowed("reel", &post, "/meta/movie/tt1.json")
        );
        for path in
            ["/configure", "/play/x.mp4", "/hls/x.m3u8", "/m/n/blob", "/sources/abc.json", "/crop", "/direct"]
        {
            assert!(!allowed("reel", &get, path), "{path}");
        }
        assert!(allowed("subtitles", &get, "/subtitle/42.srt"));
        for path in ["/configure", "/subtitles/movie/tt1.json", "/subtitlex/1.srt"] {
            assert!(!allowed("subtitles", &get, path), "{path}");
        }
        assert!(!allowed("remux", &get, "/subtitle/x"), "only the four addons have a guest allowlist");
    }

    #[test]
    fn a_manifest_loses_the_install_id_and_the_debrid_name() {
        let mut manifest = json!({
            "id": "com.den.scout",
            "denInstallId": "abc",
            "description": "Streams via TorBox and Real-Debrid",
            "config": [{ "options": ["realdebrid", "keep"], "nested": { "denInstallId": "x" } }],
        });
        strip_manifest(&mut manifest);
        assert_eq!(
            manifest,
            json!({
                "id": "com.den.scout",
                "description": "Streams via debrid and debrid",
                "config": [{ "options": ["debrid", "keep"], "nested": {} }],
            })
        );
    }

    #[test]
    fn a_source_address_is_capped_and_forgotten() {
        let grants = Grants::default();
        let addr = |n: u8| IpAddr::from([203, 0, 113, n]);
        for n in 0..MAX_SOURCES as u8 {
            assert!(grants.allow_source("g", addr(n), 0));
        }
        assert!(!grants.allow_source("g", addr(99), 1), "a fifth address is refused");
        assert!(grants.allow_source("g", addr(0), 1), "a known one is not");
        assert!(grants.allow_source("other", addr(99), 1), "another grant has its own");
        assert!(grants.allow_source("g", addr(99), SOURCE_TTL_MS + 10), "old sources lapse");
        grants.forget("g");
        assert!(grants.allow_source("g", addr(50), 2));
    }

    #[tokio::test]
    async fn the_host_api_takes_a_proof_for_the_library_in_the_path() {
        let h = harness().await;
        let path = format!("/lib/{LIB}/grants");
        let anon = h.send("GET", &path, None, &[]).await;
        assert_eq!(anon.status(), StatusCode::FORBIDDEN);
        let wrong = h.send("GET", &path, None, &[("x-den-library-member", &format!("{LIB}:nope"))]).await;
        assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
        // A member of another library here is not this host.
        let other = "fedcba9876543210fedcba9876543210";
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        h.send("POST", &format!("/lib/{other}/batch"), Some(body), &[("x-den-library-token", "other-token")])
            .await;
        let stranger =
            h.send("GET", &path, None, &[("x-den-library-member", &format!("{other}:other-token"))]).await;
        assert_eq!(stranger.status(), StatusCode::FORBIDDEN);
        assert_eq!(host_call(&h, "GET", "", None).await, (StatusCode::OK, json!({ "grants": [] })));
        assert_eq!(h.send("PATCH", &path, None, &[]).await.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn a_created_grant_is_listed_without_a_secret_and_stored_only_as_hashes() {
        let h = harness().await;
        let (status, made) =
            host_call(&h, "POST", "", Some(invite(json!({ "accessDays": 7, "devices": 2 })))).await;
        assert_eq!(status, StatusCode::CREATED);
        let (gid, code) = (made["gid"].as_str().unwrap(), made["code"].as_str().unwrap());
        assert_eq!(gid.len(), 8);
        assert!(code.starts_with(&format!("{gid}.")) && code.len() == 8 + 1 + 22, "{code}");
        let grant = &made["grant"];
        assert_eq!(grant["status"], "invited");
        assert_eq!(grant["addons"], json!(["scout", "atlas"]));
        assert_eq!(grant["codeExpiresAt"], 1_000_000 + 14 * DAY_MS);
        assert_eq!((grant["accessDays"].clone(), grant["expiresAt"].clone()), (json!(7), Value::Null));
        assert_eq!((grant["devices"].clone(), grant["deviceCount"].clone()), (json!(2), json!(0)));

        let listed = host_call(&h, "GET", "", None).await.1;
        assert_eq!(listed["grants"][0]["gid"], gid);
        let text = listed.to_string();
        for secret in [SCOUT, ATLAS, code] {
            assert!(!text.contains(secret), "the list leaked {secret}");
        }

        assert_eq!(redeem_with(&h, code, SECRET).await.0, StatusCode::OK);
        let stored = String::from_utf8(h.state.store.get(NS, &key(gid)).await.unwrap().unwrap()).unwrap();
        assert!(!stored.contains(code) && !stored.contains(SECRET), "a secret was written down");
        assert!(stored.contains(&sha(SECRET.as_bytes())) && stored.contains(&sha(code.as_bytes())));
        assert!(stored.contains(SCOUT), "the escrow is the one thing kept in the clear");
    }

    #[cfg(unix)]
    #[test]
    fn the_grants_directory_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        crate::store::Store::open(&dir, 1 << 20).unwrap();
        let mode = std::fs::metadata(dir.join("grants")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[tokio::test]
    async fn an_invite_is_validated() {
        let h = harness().await;
        let base = invite(json!({}));
        let with = |field: &str, value: Value| {
            let mut body = base.clone();
            body[field] = value;
            body
        };
        let too_long = "n".repeat(61);
        let bad = [
            with("name", json!("")),
            with("name", json!(too_long)),
            with("name", json!("a\nb")),
            with("name", json!(5)),
            with("name", json!("Sam\u{202E}")),
            with("name", json!("Sa\u{200B}m")),
            with("addons", json!([])),
            with("addons", json!(["scout", "remux"])),
            with("addons", json!(["scout", "atlas", "reel"])),
            with("installs", json!({ "scout": SCOUT })),
            with("installs", json!({ "scout": "http://192.168.1.2:8080/abc", "atlas": ATLAS })),
            with("installs", json!({ "scout": "a/b", "atlas": ATLAS })),
            with("installs", json!({ "scout": "a:b", "atlas": ATLAS })),
            with("installs", json!({ "scout": "~abc", "atlas": ATLAS })),
            with("installs", json!({ "scout": "a.b", "atlas": ATLAS })),
            with("installs", json!({ "scout": "a b", "atlas": ATLAS })),
            with("installs", json!({ "scout": "a".repeat(2049), "atlas": ATLAS })),
            with("installs", json!({ "scout": "a", "atlas": ATLAS })),
            with("installs", json!({ "scout": format!("{SCOUT}="), "atlas": ATLAS })),
            with("installs", json!({ "scout": SCOUT, "atlas": ATLAS, "remux": SCOUT })),
            with("devices", json!(0)),
            with("devices", json!(6)),
            with("accessDays", json!(0)),
            with("accessDays", json!(366)),
            with("accessUntil", json!(5)),
            with("codeExpiresAt", json!(5)),
            with("codeExpiresAt", json!(1_000_000 + 91 * DAY_MS)),
            {
                let mut both = with("accessDays", json!(3));
                both["accessUntil"] = json!(1_000_000 + 5 * DAY_MS);
                both
            },
            json!([]),
        ];
        for body in bad {
            assert_eq!(
                host_call(&h, "POST", "", Some(body.clone())).await.0,
                StatusCode::BAD_REQUEST,
                "{body}"
            );
        }
        let fine = with("accessUntil", json!(1_000_000 + 5 * DAY_MS));
        assert_eq!(host_call(&h, "POST", "", Some(fine)).await.0, StatusCode::CREATED);
    }

    #[tokio::test]
    async fn only_ten_grants_may_be_live_and_a_revoked_one_makes_room() {
        let h = harness().await;
        let mut first = String::new();
        for i in 0..MAX_LIVE {
            let (gid, _) = invited(&h, json!({ "name": format!("g{i}") })).await;
            if i == 0 {
                first = gid;
            }
        }
        let (status, refused) = host_call(&h, "POST", "", Some(invite(json!({})))).await;
        assert_eq!((status, refused), (StatusCode::CONFLICT, json!({ "error": "too_many_grants" })));
        assert_eq!(host_call(&h, "DELETE", &format!("/{first}"), None).await.0, StatusCode::NO_CONTENT);
        assert_eq!(host_call(&h, "POST", "", Some(invite(json!({})))).await.0, StatusCode::CREATED);
    }

    #[tokio::test]
    async fn a_grant_that_is_not_this_hosts_is_not_found() {
        let h = harness().await;
        assert_eq!(host_call(&h, "PUT", "/deadbeef", Some(json!({}))).await.0, StatusCode::NOT_FOUND);
        assert_eq!(host_call(&h, "DELETE", "/deadbeef", None).await.0, StatusCode::NOT_FOUND);
        // Another host's.
        let (gid, _) = invited(&h, json!({})).await;
        let mut stored: Record = load(&h.state, &gid).await.unwrap().unwrap();
        stored.host = "fedcba9876543210fedcba9876543210".into();
        save(&h.state, &stored).await.unwrap();
        assert_eq!(
            host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "name": "x" }))).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(host_call(&h, "DELETE", &format!("/{gid}"), None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(host_call(&h, "GET", "", None).await.1["grants"], json!([]));
    }

    #[tokio::test]
    async fn a_code_redeems_for_a_device_and_every_failure_looks_alike() {
        let h = harness().await;
        let (gid, code) = invited(&h, json!({ "accessDays": 7 })).await;
        let invalid = (StatusCode::NOT_FOUND, json!({ "error": "invalid_code" }));
        let hash = b64url(&Sha256::digest(SECRET.as_bytes()));

        for body in [
            json!({ "code": format!("{gid}.{}", "A".repeat(22)), "secretHash": hash }),
            json!({ "code": "deadbeef.AAAAAAAAAAAAAAAAAAAAAA", "secretHash": hash }),
            json!({ "code": code, "secretHash": "short" }),
            json!({ "code": code }),
            json!({ "code": "nonsense", "secretHash": hash }),
            json!({ "code": 5, "secretHash": hash }),
            json!("text"),
        ] {
            assert_eq!(h.call("POST", "/grant/redeem", Some(body.clone())).await, invalid, "{body}");
        }
        assert_eq!(h.call("GET", "/grant/redeem", None).await.0, StatusCode::METHOD_NOT_ALLOWED);

        h.advance(1_000);
        let (status, got) = redeem_with(&h, &code, SECRET).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            got,
            json!({ "gid": gid, "name": "Sam", "addons": ["scout", "atlas"], "expiresAt": 1_001_000 + 7 * DAY_MS })
        );

        // A lost answer is retried with the same hash, and nothing moves.
        h.advance(60_000);
        assert_eq!(redeem_with(&h, &code, SECRET).await, (StatusCode::OK, got.clone()));
        let listed = host_call(&h, "GET", "", None).await.1["grants"][0].clone();
        assert_eq!((listed["deviceCount"].clone(), listed["status"].clone()), (json!(1), json!("active")));
        assert_eq!(listed["redeemedAt"], 1_001_000);

        // One device by default: another secret is turned away, indistinguishably.
        assert_eq!(redeem_with(&h, &code, SECRET2).await, invalid);
    }

    #[tokio::test]
    async fn the_access_clock_starts_at_the_first_redeem_only() {
        let h = harness().await;
        let (_, code) = invited(&h, json!({ "accessDays": 2, "devices": 2 })).await;
        let (_, first) = redeem_with(&h, &code, SECRET).await;
        h.advance(DAY_MS);
        let (_, second) = redeem_with(&h, &code, SECRET2).await;
        assert_eq!(first["expiresAt"], second["expiresAt"], "a second device does not restart the trial");
        assert_eq!(first["expiresAt"], 1_000_000 + 2 * DAY_MS);
    }

    #[tokio::test]
    async fn a_lapsed_code_a_lapsed_grant_and_a_revoked_one_all_refuse_a_redeem() {
        let h = harness().await;
        let invalid = (StatusCode::NOT_FOUND, json!({ "error": "invalid_code" }));

        let (_, lapsing) = invited(&h, json!({ "codeExpiresAt": 1_000_000 + DAY_MS })).await;
        h.advance(DAY_MS);
        assert_eq!(redeem_with(&h, &lapsing, SECRET).await, invalid, "redeem by has passed");
        let listed = host_call(&h, "GET", "", None).await.1;
        assert_eq!(listed["grants"][0]["status"], "expired", "an invited grant past its code reads expired");

        let (gid, revoked) = invited(&h, json!({ "name": "Rev" })).await;
        assert_eq!(host_call(&h, "DELETE", &format!("/{gid}"), None).await.0, StatusCode::NO_CONTENT);
        assert_eq!(redeem_with(&h, &revoked, SECRET).await, invalid);

        let (_, trial) = invited(&h, json!({ "name": "Trial", "accessDays": 1 })).await;
        assert_eq!(redeem_with(&h, &trial, SECRET).await.0, StatusCode::OK);
        h.advance(DAY_MS);
        assert_eq!(redeem_with(&h, &trial, SECRET).await, invalid, "even the same device, once access ended");
    }

    #[tokio::test]
    async fn a_redeem_is_throttled_per_address() {
        let h = harness().await;
        let (_, code) = invited(&h, json!({})).await;
        for _ in 0..REDEEM_PER_WINDOW {
            assert_eq!(
                redeem_with(&h, "deadbeef.AAAAAAAAAAAAAAAAAAAAAA", SECRET).await.0,
                StatusCode::NOT_FOUND
            );
        }
        let refused = redeem_with(&h, &code, SECRET).await.0;
        assert_eq!(refused, StatusCode::TOO_MANY_REQUESTS);
        h.advance(61_000);
        assert_eq!(redeem_with(&h, &code, SECRET).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn addons_are_offered_to_a_live_guest_and_expiry_is_said_only_to_the_secret_holder() {
        let h = harness().await;
        let (gid, header) = redeemed(&h, json!({ "accessDays": 3 })).await;
        let (status, got) = {
            let resp = h.send("GET", "/grant/addons", None, &grant_headers(&header)).await;
            (resp.status(), body_json(resp).await)
        };
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            got,
            json!({ "gid": gid, "name": "Sam", "expiresAt": 1_000_000 + 3 * DAY_MS,
                    "addons": { "scout": format!("/scout/~{gid}"), "atlas": format!("/atlas/~{gid}") } })
        );

        let wrong = format!("{gid}:not-the-secret");
        for header in [wrong.as_str(), "garbage", "", "deadbeef:x"] {
            let resp = h.send("GET", "/grant/addons", None, &grant_headers(header)).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{header:?}");
        }
        assert_eq!(h.send("GET", "/grant/addons", None, &[]).await.status(), StatusCode::NOT_FOUND);

        h.advance(3 * DAY_MS);
        let expired = h.send("GET", "/grant/addons", None, &grant_headers(&header)).await;
        assert_eq!(expired.status(), StatusCode::GONE);
        assert_eq!(
            body_json(expired).await,
            json!({ "error": "grant_expired", "expiredAt": 1_000_000 + 3 * DAY_MS })
        );
        let stranger = h.send("GET", "/grant/addons", None, &grant_headers(&wrong)).await;
        assert_eq!(stranger.status(), StatusCode::NOT_FOUND, "no expiry for a wrong secret");
    }

    #[tokio::test]
    async fn last_use_is_kept_in_memory_and_shown_to_the_host() {
        let h = harness().await;
        let (gid, header) = redeemed(&h, json!({})).await;
        assert_eq!(host_call(&h, "GET", "", None).await.1["grants"][0]["lastUsedAt"], Value::Null);
        h.advance(5_000);
        h.send("GET", "/grant/addons", None, &grant_headers(&header)).await;
        assert_eq!(host_call(&h, "GET", "", None).await.1["grants"][0]["lastUsedAt"], 1_005_000);
        let stored = String::from_utf8(h.state.store.get(NS, &key(&gid)).await.unwrap().unwrap()).unwrap();
        assert!(!stored.contains("1005000"), "a call must not write the record");
    }

    #[tokio::test]
    async fn leaving_revokes_and_the_host_sees_it() {
        let h = harness().await;
        let (gid, header) = redeemed(&h, json!({})).await;
        let other = h.send("DELETE", "/grant/deadbeef", None, &grant_headers(&header)).await;
        assert_eq!(other.status(), StatusCode::NOT_FOUND, "the header must be for this grant");
        assert_eq!(
            h.send("DELETE", &format!("/grant/{gid}"), None, &[]).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            h.send("DELETE", &format!("/grant/{gid}"), None, &grant_headers(&header)).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            h.send("GET", "/grant/addons", None, &grant_headers(&header)).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(host_call(&h, "GET", "", None).await.1["grants"][0]["status"], "revoked");
        assert_eq!(
            h.send("POST", &format!("/grant/{gid}"), None, &[]).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn extending_a_redeemed_grant_recomputes_its_end() {
        let h = harness().await;
        let (gid, header) = redeemed(&h, json!({ "accessDays": 1 })).await;
        h.advance(DAY_MS);
        assert_eq!(
            h.send("GET", "/grant/addons", None, &grant_headers(&header)).await.status(),
            StatusCode::GONE
        );
        assert_eq!(host_call(&h, "GET", "", None).await.1["grants"][0]["status"], "expired");

        let (status, got) =
            host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "accessDays": 30, "name": "  Samuel " })))
                .await;
        assert_eq!(status, StatusCode::OK, "{got}");
        assert_eq!(got["grant"]["status"], "active");
        assert_eq!(got["grant"]["name"], "Samuel");
        assert_eq!(got["grant"]["expiresAt"], 1_000_000 + 30 * DAY_MS, "counted from the first redeem");
        assert_eq!(
            h.send("GET", "/grant/addons", None, &grant_headers(&header)).await.status(),
            StatusCode::OK
        );

        let until = 1_000_000 + 40 * DAY_MS;
        let (_, got) = host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "accessUntil": until }))).await;
        assert_eq!(
            (got["grant"]["expiresAt"].clone(), got["grant"]["accessDays"].clone()),
            (json!(until), Value::Null)
        );
        let (_, got) = host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "accessUntil": null }))).await;
        assert_eq!(got["grant"]["expiresAt"], Value::Null, "cleared: it never expires");

        let (_, got) = host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "addons": ["scout"] }))).await;
        assert_eq!(got["grant"]["addons"], json!(["scout"]));
        assert_eq!(
            host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "addons": ["scout", "reel"] }))).await.0,
            StatusCode::BAD_REQUEST,
            "reel has no install"
        );
        let (status, _) = host_call(
            &h,
            "PUT",
            &format!("/{gid}"),
            Some(json!({ "addons": ["scout", "reel"], "installs": { "reel": REEL } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_revoked_grant_has_no_escrow_and_cannot_be_edited() {
        let h = harness().await;
        let (gid, _) = redeemed(&h, json!({})).await;
        host_call(&h, "DELETE", &format!("/{gid}"), None).await;
        let stored: Record = load(&h.state, &gid).await.unwrap().unwrap();
        assert!(stored.installs.is_empty() && stored.devices.is_empty());
        assert_eq!(
            host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "name": "x" }))).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            host_call(&h, "DELETE", &format!("/{gid}"), None).await.0,
            StatusCode::NO_CONTENT,
            "again is fine"
        );
    }

    /// A stand-in for an addon: answers with what `reply` says, and remembers what it was asked.
    type Seen = Arc<Mutex<Vec<(String, HeaderMap, String)>>>;

    async fn addon(reply: fn(&str) -> (StatusCode, &'static str, String)) -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let app = axum::Router::new().fallback(move |req: Request| {
            let log = Arc::clone(&log);
            async move {
                let path = req.uri().path_and_query().unwrap().as_str().to_owned();
                let headers = req.headers().clone();
                let body = axum::body::to_bytes(req.into_body(), 1 << 20).await.unwrap();
                log.lock().unwrap().push((
                    path.clone(),
                    headers,
                    String::from_utf8_lossy(&body).into_owned(),
                ));
                let (status, content_type, body) = reply(&path);
                let mut resp = Response::new(Body::from(body));
                *resp.status_mut() = status;
                resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
                resp
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, seen)
    }

    fn ok_json(_: &str) -> (StatusCode, &'static str, String) {
        (StatusCode::OK, "application/json", json!({ "metas": [] }).to_string())
    }

    /// A harness relaying every addon, and the remux control plane, to one stand-in.
    async fn relaying(
        reply: fn(&str) -> (StatusCode, &'static str, String),
        secret: Option<&str>,
    ) -> (Harness, Seen) {
        let (base, seen) = addon(reply).await;
        let secret = secret.map(str::to_owned);
        let h = Harness::in_dir_with(temp_dir(), move |s| {
            s.relays = crate::parse_relays(&format!(
                "/scout={base}, /atlas={base}, /reel={base}, /subtitles={base}, /remux={base}"
            ));
            s.remux_edge_secret = secret;
        });
        (members_only(h).await, seen)
    }

    #[tokio::test]
    async fn the_relay_swaps_the_virtual_install_for_the_real_one_and_keeps_the_credential_home() {
        let (h, seen) = relaying(ok_json, None).await;
        let (gid, header) = redeemed(&h, json!({})).await;
        let claim = member();
        let resp = h
            .send(
                "GET",
                &format!("/scout/~{gid}/manifest.json?skip=20"),
                None,
                &[(HEADER, &header), ("x-den-library-member", &claim), ("cookie", "session=1")],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let (path, headers, _) = seen.lock().unwrap().pop().unwrap();
        assert_eq!(path, format!("/{SCOUT}/manifest.json?skip=20"));
        for name in [HEADER, "x-den-library-member", "cookie"] {
            assert!(!headers.contains_key(name), "{name} went upstream");
        }
        // The `~` may arrive encoded.
        let encoded = h
            .send("GET", &format!("/atlas/%7E{gid}/catalog/movie/top.json"), None, &grant_headers(&header))
            .await;
        assert_eq!(encoded.status(), StatusCode::OK);
        assert_eq!(seen.lock().unwrap().pop().unwrap().0, format!("/{ATLAS}/catalog/movie/top.json"));
    }

    #[tokio::test]
    async fn the_relay_refuses_what_a_guest_may_not_reach() {
        let (h, seen) = relaying(ok_json, None).await;
        let (gid, header) = redeemed(&h, json!({})).await;
        let ask = |path: String, headers: Vec<(&'static str, String)>| {
            let h = &h;
            async move {
                let pairs: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
                h.send("GET", &path, None, &pairs).await.status()
            }
        };
        let with = || vec![(HEADER, header.clone())];
        for path in [
            format!("/scout/~{gid}/stream/movie/tt1.json"),
            format!("/scout/~{gid}/p/ticket"),
            format!("/scout/~{gid}/configure"),
            format!("/scout/~{gid}/config-key"),
            format!("/scout/~{gid}/manifest.json?debug=1"),
            format!("/scout/~{gid}/catalog/movie/top.json"),
            format!("/atlas/~{gid}/catalog/../stream/x"),
            format!("/atlas/~{gid}/catalog/%2e%2e/stream/x"),
            format!("/atlas/~{gid}/catalog/a%2Fb"),
            format!("/scout/~{gid}"),
            format!("/reel/~{gid}/meta/movie/x.json"),
            "/scout/~/manifest.json".to_owned(),
            format!("/scout/~{}/manifest.json", "f".repeat(8)),
            format!("/scout/~{gid}%2F..%2Fx/manifest.json"),
        ] {
            assert_eq!(ask(path.clone(), with()).await, StatusCode::NOT_FOUND, "{path}");
        }
        // No credential, a wrong one, another grant's.
        let path = format!("/scout/~{gid}/manifest.json");
        assert_eq!(ask(path.clone(), vec![]).await, StatusCode::NOT_FOUND);
        assert_eq!(ask(path.clone(), vec![(HEADER, format!("{gid}:wrong"))]).await, StatusCode::NOT_FOUND);
        assert_eq!(
            ask(path.clone(), vec![(HEADER, format!("deadbeef:{SECRET}"))]).await,
            StatusCode::NOT_FOUND
        );
        // A guest's own member claim does not stand in for a grant.
        assert_eq!(ask(path.clone(), vec![("x-den-library-member", member())]).await, StatusCode::NOT_FOUND);
        assert!(seen.lock().unwrap().is_empty(), "nothing refused may reach an addon");

        assert_eq!(ask(path.clone(), with()).await, StatusCode::OK);
        // Not a POST to a read route.
        let post = h.send("POST", &path, None, &grant_headers(&header)).await;
        assert_eq!(post.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn an_addon_outside_the_grant_is_not_reachable_and_expiry_is_told_to_the_guest() {
        let (h, _) = relaying(ok_json, None).await;
        let (gid, header) = redeemed(&h, json!({ "accessDays": 1 })).await;
        let reel =
            h.send("GET", &format!("/reel/~{gid}/meta/movie/x.json"), None, &grant_headers(&header)).await;
        assert_eq!(reel.status(), StatusCode::NOT_FOUND, "reel was not shared");
        h.advance(DAY_MS);
        let path = format!("/scout/~{gid}/catalog/movie/top.json");
        let resp = h.send("GET", &path, None, &grant_headers(&header)).await;
        assert_eq!(resp.status(), StatusCode::GONE);
        assert_eq!(body_json(resp).await["error"], "grant_expired");
        let wrong = h.send("GET", &path, None, &grant_headers(&format!("{gid}:nope"))).await;
        assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
    }

    fn manifest(_: &str) -> (StatusCode, &'static str, String) {
        (
            StatusCode::OK,
            "application/json",
            json!({ "id": "x", "denInstallId": "host-install", "description": "via TorBox",
                    "stremioAddonsConfig": format!("http://192.168.1.2/{SCOUT}/manifest.json") })
            .to_string(),
        )
    }

    #[tokio::test]
    async fn a_guests_manifest_is_stripped_and_asked_for_uncompressed() {
        let (h, seen) = relaying(manifest, None).await;
        let (gid, header) = redeemed(&h, json!({})).await;
        let resp = h
            .send(
                "GET",
                &format!("/scout/~{gid}/manifest.json"),
                None,
                &[(HEADER, &header), ("accept-encoding", "gzip")],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let got = body_json(resp).await;
        assert_eq!(got["denInstallId"], Value::Null);
        assert_eq!(got["description"], "via debrid");
        assert_eq!(
            got["stremioAddonsConfig"],
            format!("http://192.168.1.2/~{gid}/manifest.json"),
            "the real segment never comes back"
        );
        let (_, headers, _) = seen.lock().unwrap().pop().unwrap();
        assert_eq!(headers[header::ACCEPT_ENCODING], "identity");
    }

    #[tokio::test]
    async fn a_guest_is_never_a_member_and_has_a_budget_per_grant() {
        let (h, _) = relaying(ok_json, None).await;
        let (gid, header) = redeemed(&h, json!({})).await;
        let claim = member();
        let path = format!("/scout/~{gid}/manifest.json");
        // A guest is not held to the visitor's per-address budget: only its grant's own bucket, below, counts.
        for i in 0..crate::relay::GUEST_PER_WINDOW + 10 {
            let status = h
                .send("GET", &path, None, &[(HEADER, &header), ("x-den-library-member", &claim)])
                .await
                .status();
            assert_eq!(status, StatusCode::OK, "{i}");
        }

        // The grant's own bucket does not depend on who is asking.
        let (h, _) = relaying(ok_json, None).await;
        let (gid, header) = redeemed(&h, json!({})).await;
        for _ in 0..crate::relay::GRANT_PER_WINDOW {
            assert!(crate::link::throttled_at(
                &h.state,
                &format!("relay-grant:{gid}"),
                crate::relay::GRANT_PER_WINDOW
            )
            .is_none());
        }
        let refused =
            h.send("GET", &format!("/scout/~{gid}/manifest.json"), None, &grant_headers(&header)).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    fn remux_reply(path: &str) -> (StatusCode, &'static str, String) {
        if path == "/remux/admin/kill" {
            (StatusCode::OK, "application/json", json!({ "ended": 0 }).to_string())
        } else {
            (StatusCode::OK, "application/json", json!({ "ok": true }).to_string())
        }
    }

    async fn remux_call(
        h: &Harness,
        method: &str,
        path: &str,
        header: &str,
        body: Option<Value>,
    ) -> Response {
        h.send(
            method,
            path,
            body.map(|b| b.to_string()),
            &[
                (HEADER, header),
                ("content-type", "application/json"),
                ("x-den-owner", "install:somebody-else"),
            ],
        )
        .await
    }

    #[tokio::test]
    async fn a_guests_remux_body_names_the_virtual_install_and_leaves_with_the_real_one() {
        let (h, seen) = relaying(remux_reply, Some("edge-secret")).await;
        let (gid, header) = redeemed(
            &h,
            json!({ "addons": ["scout", "subtitles"], "installs": { "scout": SCOUT, "subtitles": SUBS } }),
        )
        .await;
        let base = h.state.relays.iter().find(|(p, _)| p == "/scout").unwrap().1.clone();
        let good = json!({
            "scout": format!("https://d.example/scout/~{gid}"),
            "subtitles": format!("https://d.example/subtitles/~{gid}/"),
            "player": "hls",
        });
        let resp = remux_call(&h, "POST", "/remux/session", &header, Some(good.clone())).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let (path, headers, body) = seen.lock().unwrap().pop().unwrap();
        assert_eq!(path, "/remux/session");
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent["scout"], format!("{base}/{SCOUT}"));
        assert_eq!(sent["subtitles"], format!("{base}/{SUBS}"));
        assert_eq!(sent["player"], "hls");
        assert_eq!(headers["x-den-edge-secret"], "edge-secret");
        assert_eq!(
            headers["x-den-owner"],
            format!("grant:{gid}"),
            "the guest's own owner claim is not forwarded"
        );
        assert!(!headers.contains_key(HEADER));

        for bad in [
            json!({ "scout": format!("http://192.168.1.2:8080/{SCOUT}") }),
            json!({ "scout": "https://d.example/scout/~deadbeef" }),
            json!({ "scout": format!("https://d.example/atlas/~{gid}") }),
            json!({ "scout": format!("https://d.example/scout/~{gid}/manifest.json") }),
            json!({ "scout": format!("https://d.example/scout/~{gid}?x=1") }),
            json!({ "scout": format!("https://u:p@d.example/scout/~{gid}") }),
            json!({ "subtitles": 5 }),
            json!({ "subtitles": format!("https://d.example/scout/~{gid}") }),
            json!({ "scout": format!("https://d.example/scout/~{gid}"), "subtitles": "http://evil.example/x" }),
        ] {
            let resp = remux_call(&h, "POST", "/remux/session", &header, Some(bad.clone())).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{bad}");
        }
        assert!(seen.lock().unwrap().is_empty(), "a rejected body never reaches remux");

        // Releases take the same rewrite; health and everything else follow the same gate.
        assert_eq!(
            remux_call(&h, "POST", "/remux/releases", &header, Some(good)).await.status(),
            StatusCode::OK
        );
        assert_eq!(seen.lock().unwrap().pop().unwrap().0, "/remux/releases");
        assert_eq!(remux_call(&h, "GET", "/remux/health", &header, None).await.status(), StatusCode::OK);
        for path in ["/remux/video", "/remux/admin/kill", "/remux/s/a/b/master.m3u8"] {
            assert_eq!(
                remux_call(&h, "POST", path, &header, None).await.status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        let injected =
            remux_call(&h, "GET", "/remux/releases?scout=http://evil.example", &header, None).await;
        assert_eq!(injected.status(), StatusCode::BAD_REQUEST);
        // An addon that was not shared has no install to name.
        let (gid2, header2) = redeemed_second(&h).await;
        let unshared = json!({ "subtitles": format!("https://d.example/subtitles/~{gid2}") });
        let resp = remux_call(&h, "POST", "/remux/session", &header2, Some(unshared)).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// A player away from home times its link before it starts a session. Through the relay that is `/remux/speed`,
    /// for a member and a guest alike: never more bytes than the web app's probe, never cached, and nothing for anyone
    /// else.
    #[tokio::test]
    async fn the_relay_passes_a_capped_speed_test_to_members_and_guests() {
        let (mut h, seen) = relaying(remux_reply, Some("edge-secret")).await;
        Arc::get_mut(&mut h.state).unwrap().web_hosts = crate::parse_hosts("WEB_HOSTS", "d.example");
        let (gid, grant) = redeemed(&h, json!({})).await;
        let cap = crate::relay::SPEED_MAX_BYTES;
        for (asked, sent) in [
            ("/remux/speed?bytes=999999999&other=1", format!("/remux/speed?bytes={cap}")),
            ("/remux/speed?bytes=4096", "/remux/speed?bytes=4096".to_owned()),
            ("/remux/speed", format!("/remux/speed?bytes={cap}")),
        ] {
            let resp = h.send("GET", asked, None, &[("host", "d.example"), (HEADER, &grant)]).await;
            assert_eq!(resp.status(), StatusCode::OK, "{asked}");
            assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
            let (path, headers, _) = seen.lock().unwrap().pop().unwrap();
            assert_eq!(path, sent);
            assert_eq!(headers["x-den-owner"], format!("grant:{gid}"), "counted as the guest's");
        }

        let claim = member();
        let member_speed = |path: &'static str| {
            let claim = claim.clone();
            let h = &h;
            async move {
                h.send("GET", path, None, &[("host", "d.example"), ("x-den-library-member", &claim)])
                    .await
                    .status()
            }
        };
        assert_eq!(member_speed("/remux/speed?bytes=999999999").await, StatusCode::OK);
        assert_eq!(seen.lock().unwrap().pop().unwrap().0, format!("/remux/speed?bytes={cap}"));
        assert_eq!(member_speed("/remux/speed?bytes=lots").await, StatusCode::BAD_REQUEST);
        let stranger = h.send("GET", "/remux/speed", None, &[("host", "d.example")]).await;
        assert_eq!(stranger.status(), StatusCode::NOT_FOUND, "neither a member nor a guest");
        assert!(seen.lock().unwrap().is_empty());
    }

    /// Each relayed speed test is a relayed call like any other: it spends the guest's grant budget, and the member's
    /// address budget.
    #[tokio::test]
    async fn a_relayed_speed_test_spends_the_callers_budget() {
        let (mut h, _) = relaying(remux_reply, Some("edge-secret")).await;
        Arc::get_mut(&mut h.state).unwrap().web_hosts = crate::parse_hosts("WEB_HOSTS", "d.example");
        let (gid, grant) = redeemed(&h, json!({})).await;
        for _ in 0..crate::relay::GRANT_PER_WINDOW {
            crate::link::throttled_at(
                &h.state,
                &format!("relay-grant:{gid}"),
                crate::relay::GRANT_PER_WINDOW,
            );
        }
        let guest = h.send("GET", "/remux/speed", None, &[("host", "d.example"), (HEADER, &grant)]).await;
        assert_eq!(guest.status(), StatusCode::TOO_MANY_REQUESTS);

        let claim = member();
        let mut answered = 0;
        loop {
            let status = h
                .send("GET", "/remux/speed", None, &[("host", "d.example"), ("x-den-library-member", &claim)])
                .await
                .status();
            if status != StatusCode::OK {
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                break;
            }
            answered += 1;
            assert!(answered <= 1_000, "a member's speed tests were never counted");
        }
        assert!(answered >= crate::relay::GUEST_PER_WINDOW, "{answered}");
    }

    /// A second grant, sharing scout only, for a second guest.
    async fn redeemed_second(h: &Harness) -> (String, String) {
        let (gid, code) = invited(h, json!({ "name": "Kim", "addons": ["scout"] })).await;
        assert_eq!(redeem_with(h, &code, SECRET2).await.0, StatusCode::OK);
        (gid.clone(), format!("{gid}:{SECRET2}"))
    }

    #[tokio::test]
    async fn guest_remux_is_off_without_the_shared_secret_and_needs_a_live_grant() {
        let (h, seen) = relaying(remux_reply, None).await;
        let (_, header) = redeemed(&h, json!({ "accessDays": 1 })).await;
        assert_eq!(
            remux_call(&h, "GET", "/remux/health", &header, None).await.status(),
            StatusCode::NOT_FOUND
        );
        assert!(seen.lock().unwrap().is_empty());

        let (h, seen) = relaying(remux_reply, Some("s")).await;
        let (gid, header) = redeemed(&h, json!({ "accessDays": 1 })).await;
        assert_eq!(remux_call(&h, "GET", "/remux/health", &header, None).await.status(), StatusCode::OK);
        assert_eq!(
            remux_call(&h, "GET", "/remux/health", &format!("{gid}:no"), None).await.status(),
            StatusCode::NOT_FOUND
        );
        h.advance(DAY_MS);
        assert_eq!(remux_call(&h, "GET", "/remux/health", &header, None).await.status(), StatusCode::GONE);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn grants_are_refused_while_strangers_may_start_libraries() {
        let h = Harness::new();
        start_library(&h).await;
        let (status, refused) = host_call(&h, "POST", "", Some(invite(json!({})))).await;
        assert_eq!((status, refused), (StatusCode::FORBIDDEN, json!({ "error": "new_libraries_closed" })));
        assert_eq!(host_call(&h, "GET", "", None).await.1["grants"], json!([]));

        // A grant made while it was closed stops reaching remux the moment it opens.
        let (mut h, seen) = relaying(remux_reply, Some("s")).await;
        let (_, header) = redeemed(&h, json!({})).await;
        assert_eq!(remux_call(&h, "GET", "/remux/health", &header, None).await.status(), StatusCode::OK);
        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Open;
        seen.lock().unwrap().clear();
        assert_eq!(
            remux_call(&h, "GET", "/remux/health", &header, None).await.status(),
            StatusCode::NOT_FOUND
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_second_device_is_turned_away_once_the_code_has_lapsed() {
        let h = harness().await;
        let (gid, code) =
            invited(&h, json!({ "devices": 2, "accessDays": 30, "codeExpiresAt": 1_000_000 + DAY_MS })).await;
        assert_eq!(redeem_with(&h, &code, SECRET).await.0, StatusCode::OK);
        h.advance(DAY_MS);
        let invalid = (StatusCode::NOT_FOUND, json!({ "error": "invalid_code" }));
        assert_eq!(redeem_with(&h, &code, SECRET2).await, invalid, "redeem by has passed for a new device");
        assert_eq!(
            redeem_with(&h, &code, SECRET).await.0,
            StatusCode::OK,
            "a known device is still let back in"
        );
        let listed = host_call(&h, "GET", "", None).await.1["grants"][0].clone();
        assert_eq!((listed["gid"].clone(), listed["deviceCount"].clone()), (json!(gid), json!(1)));
    }

    #[tokio::test]
    async fn deleting_the_library_revokes_its_grants() {
        let h = harness().await;
        let (gid, header) = redeemed(&h, json!({})).await;
        let (other, _) = invited(&h, json!({ "name": "Kim" })).await;
        let gone = h.send("DELETE", &format!("/lib/{LIB}"), None, &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(gone.status(), StatusCode::OK);
        for gid in [&gid, &other] {
            let stored: Record = load(&h.state, gid).await.unwrap().unwrap();
            assert!(stored.revoked_at.is_some() && stored.installs.is_empty() && stored.devices.is_empty());
            assert!(crate::lock(&h.state.grants.killed).contains(gid), "its sessions were ended");
        }
        let after = h.send("GET", "/grant/addons", None, &grant_headers(&header)).await;
        assert_eq!(after.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn every_host_together_may_hold_only_so_many_grants() {
        let h = harness().await;
        let entries =
            (0..MAX_TOTAL).map(|i| IndexEntry { gid: format!("{i:08x}"), host: "f".repeat(32) }).collect();
        save_index(&h.state, &Index { v: VERSION, entries }).await.unwrap();
        let (status, refused) = host_call(&h, "POST", "", Some(invite(json!({})))).await;
        assert_eq!((status, refused), (StatusCode::CONFLICT, json!({ "error": "too_many_grants" })));
    }

    #[tokio::test]
    async fn a_guest_cannot_reach_reels_streams_through_its_grant() {
        let (h, seen) = relaying(ok_json, None).await;
        let (gid, header) = redeemed(&h, json!({ "addons": ["reel"], "installs": { "reel": REEL } })).await;
        for path in [
            "/play/x.mp4",
            "/hls/x.m3u8",
            "/progressive/x.mp4",
            "/m/n/blob",
            "/meta/play/x.mp4",
            "/meta/x/hls/y.m3u8",
            "/sources/abc.json",
        ] {
            let resp = h.send("GET", &format!("/reel/~{gid}{path}"), None, &grant_headers(&header)).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path}");
        }
        assert!(seen.lock().unwrap().is_empty(), "nothing refused may reach reel");
        let meta =
            h.send("GET", &format!("/reel/~{gid}/meta/movie/x.json"), None, &grant_headers(&header)).await;
        assert_eq!(meta.status(), StatusCode::OK);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_guests_media_listener_opens_for_its_own_address_and_never_wide() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        fn session(_: &str) -> (StatusCode, &'static str, String) {
            (
                StatusCode::CREATED,
                "application/json",
                json!({ "playlist": "/remux/s/id/sig/master.m3u8" }).to_string(),
            )
        }
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("listener.sock");
        let unix = tokio::net::UnixListener::bind(&socket).unwrap();
        let (sent, mut opened) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (stream, _) = unix.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let _ = sent.send(line);
                stream.into_inner().write_all(b"ok\n").await.unwrap();
            }
        });
        let (base, _) = addon(session).await;
        let h = Harness::in_dir_with(temp_dir(), move |s| {
            s.relays = crate::parse_relays(&format!("/remux={base}, /scout={base}"));
            s.remux_edge_secret = Some("s".into());
            s.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
            s.trusted_proxies = vec![IpAddr::from([192, 168, 1, 9])];
            // The home's address is the last of the guest's four sources, so that one is behind the home's router.
            s.public_media_base = Some("https://203.0.113.4".into());
            s.lan_media_base = Some("https://lan.media.example:8449".into());
            s.public_media_socket = Some(socket);
        });
        let h = members_only(h).await;
        let (gid, header) =
            redeemed(&h, json!({ "addons": ["scout"], "installs": { "scout": SCOUT } })).await;
        let body = json!({ "scout": format!("https://d.oxy.fi/scout/~{gid}") });
        let start = |source: &'static str, body: Value| {
            let (h, header) = (&h, header.clone());
            async move {
                h.send(
                    "POST",
                    "/remux/session",
                    Some(body.to_string()),
                    &[
                        (HEADER, &header),
                        ("host", "d.oxy.fi"),
                        ("content-type", "application/json"),
                        ("x-forwarded-for", source),
                    ],
                )
                .await
            }
        };

        let resp = start("203.0.113.1", body.clone()).await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        let scope = resp.extensions().get::<crate::handler::ListenerScope>().map(|s| s.0);
        assert_eq!(scope, Some("browser"), "logged as the guest's own address");
        let answer = body_json(resp).await;
        assert_eq!(answer["publicBase"], "https://203.0.113.4");
        assert!(
            answer.get("lanBase").is_none(),
            "a guest away from home is not handed the LAN address: {answer}"
        );
        let asked: Value = serde_json::from_str(opened.recv().await.unwrap().trim()).unwrap();
        assert_eq!(asked, json!({ "open": true, "source": "203.0.113.1", "scope": "browser" }));

        // IPv6 and Cast would need the wide scope, which a guest never gets. Each is refused under its own code.
        let refused = |resp: Response| async move {
            let status = resp.status();
            let logged = resp.extensions().get::<crate::handler::ErrorCode>().map(|c| c.0.clone());
            (status, body_json(resp).await["error"].clone(), logged)
        };
        let ipv6 =
            (StatusCode::SERVICE_UNAVAILABLE, json!("public_media_ipv6"), Some("public_media_ipv6".into()));
        assert_eq!(refused(start("2001:db8::7", body.clone()).await).await, ipv6);
        let mut cast = body.clone();
        cast["player"] = json!("cast");
        let cast_refused =
            (StatusCode::SERVICE_UNAVAILABLE, json!("public_media_cast"), Some("public_media_cast".into()));
        assert_eq!(refused(start("203.0.113.1", cast.clone()).await).await, cast_refused);
        assert_eq!(refused(start("2001:db8::7", cast).await).await, cast_refused, "casting is the reason");

        for source in ["203.0.113.2", "203.0.113.3", "203.0.113.4"] {
            let resp = start(source, body.clone()).await;
            assert_eq!(resp.status(), StatusCode::CREATED, "{source}");
            let answer = body_json(resp).await;
            // Only the source that is the home's own address is behind its router.
            assert_eq!(answer.get("lanBase").is_some(), source == "203.0.113.4", "{source}: {answer}");
        }
        let refused = start("203.0.113.5", body.clone()).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS, "a fifth source address");
        assert_eq!(start("203.0.113.1", body).await.status(), StatusCode::CREATED, "a known one still plays");

        let metrics = h.state.metrics.render();
        for counted in [
            r#"den_edge_guest_play_refused_total{code="public_media_ipv6"} 1"#,
            r#"den_edge_guest_play_refused_total{code="public_media_cast"} 2"#,
            r#"den_edge_guest_play_refused_total{code="too_many_sources"} 1"#,
            r#"den_edge_guest_play_refused_total{code="public_media_unavailable"} 0"#,
            r#"den_edge_public_media_wide_total{reason="cast",who="guest"} 0"#,
            r#"den_edge_public_media_wide_total{reason="ipv6",who="guest"} 0"#,
        ] {
            assert!(metrics.contains(counted), "{counted} in {metrics}");
        }
    }

    #[tokio::test]
    async fn a_guests_session_without_a_public_media_listener_is_refused_as_unavailable() {
        let (base, _) = addon(|_| (StatusCode::CREATED, "application/json", "{}".into())).await;
        let h = Harness::in_dir_with(temp_dir(), move |s| {
            s.relays = crate::parse_relays(&format!("/remux={base}, /scout={base}"));
            s.remux_edge_secret = Some("s".into());
            s.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        });
        let h = members_only(h).await;
        let (gid, header) =
            redeemed(&h, json!({ "addons": ["scout"], "installs": { "scout": SCOUT } })).await;
        let body = json!({ "scout": format!("https://d.oxy.fi/scout/~{gid}") });
        let resp = h
            .send(
                "POST",
                "/remux/session",
                Some(body.to_string()),
                &[(HEADER, &header), ("host", "d.oxy.fi"), ("content-type", "application/json")],
            )
            .await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body_json(resp).await["error"], "public_media_unavailable");
        let metrics = h.state.metrics.render();
        let counted = r#"den_edge_guest_play_refused_total{code="public_media_unavailable"} 1"#;
        assert!(metrics.contains(counted), "{metrics}");
    }

    #[tokio::test]
    async fn revoking_and_expiring_end_the_grants_remux_sessions_once() {
        let (h, seen) = relaying(remux_reply, Some("edge-secret")).await;
        let (gid, _) = redeemed(&h, json!({ "accessDays": 1 })).await;
        let (revoked, _) = redeemed_second(&h).await;

        let kills = |seen: &Seen| -> Vec<(String, String)> {
            seen.lock()
                .unwrap()
                .iter()
                .filter(|(path, _, _)| path == "/remux/admin/kill")
                .map(|(_, headers, body)| {
                    (headers["x-den-edge-secret"].to_str().unwrap().to_owned(), body.clone())
                })
                .collect()
        };
        assert_eq!(host_call(&h, "DELETE", &format!("/{revoked}"), None).await.0, StatusCode::NO_CONTENT);
        assert_eq!(
            kills(&seen),
            vec![("edge-secret".into(), json!({ "owner": format!("grant:{revoked}") }).to_string())]
        );

        sweep(&h.state).await;
        assert_eq!(
            kills(&seen).len(),
            1,
            "the revoked grant is not killed again, and the live one not at all"
        );

        h.advance(DAY_MS);
        sweep(&h.state).await;
        assert_eq!(kills(&seen).len(), 2);
        assert_eq!(kills(&seen)[1].1, json!({ "owner": format!("grant:{gid}") }).to_string());
        sweep(&h.state).await;
        assert_eq!(kills(&seen).len(), 2, "once");

        // Extended and expiring again, it is ended again.
        host_call(&h, "PUT", &format!("/{gid}"), Some(json!({ "accessDays": 2 }))).await;
        sweep(&h.state).await;
        h.advance(DAY_MS);
        sweep(&h.state).await;
        assert_eq!(kills(&seen).len(), 3);
    }

    #[tokio::test]
    async fn a_failed_kill_is_tried_again_and_an_unset_secret_is_quiet() {
        // Nothing listens: the kill fails and stays owed.
        let h = Harness::in_dir_with(temp_dir(), |s| {
            s.relays = crate::parse_relays("/remux=http://127.0.0.1:9");
            s.remux_edge_secret = Some("s".into());
        });
        let h = members_only(h).await;
        let (gid, _) = invited(&h, json!({ "codeExpiresAt": 1_000_000 + DAY_MS })).await;
        h.advance(DAY_MS);
        sweep(&h.state).await;
        assert!(!crate::lock(&h.state.grants.killed).contains(&gid));

        let quiet = harness().await;
        let (gid, _) = invited(&quiet, json!({})).await;
        assert_eq!(host_call(&quiet, "DELETE", &format!("/{gid}"), None).await.0, StatusCode::NO_CONTENT);
        assert!(crate::lock(&quiet.state.grants.killed).contains(&gid), "nothing to end counts as ended");
    }

    #[tokio::test]
    async fn an_ended_grant_is_reaped_thirty_days_later() {
        let h = harness().await;
        let (gid, header) = redeemed(&h, json!({ "accessDays": 1 })).await;
        h.advance(DAY_MS + REAP_MS - 1);
        sweep(&h.state).await;
        assert_eq!(
            host_call(&h, "GET", "", None).await.1["grants"][0]["status"],
            "expired",
            "kept for the host"
        );
        assert_eq!(
            h.send("GET", "/grant/addons", None, &grant_headers(&header)).await.status(),
            StatusCode::GONE
        );
        h.advance(1);
        sweep(&h.state).await;
        assert_eq!(host_call(&h, "GET", "", None).await.1["grants"], json!([]));
        assert!(h.state.store.get(NS, &key(&gid)).await.unwrap().is_none());
        assert_eq!(
            h.send("GET", "/grant/addons", None, &grant_headers(&header)).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(host_call(&h, "PUT", &format!("/{gid}"), Some(json!({}))).await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn every_grant_route_has_a_label_a_method_list_and_cors() {
        use crate::handler::route_label;
        assert_eq!(route_label(&format!("/lib/{LIB}/grants")), "/lib/:id/grants");
        assert_eq!(route_label(&format!("/lib/{LIB}/grants/deadbeef")), "/lib/:id/grants/:gid");
        assert_eq!(route_label("/grant/redeem"), "/grant/redeem");
        assert_eq!(route_label("/grant/addons"), "/grant/addons");
        assert_eq!(route_label("/grant/deadbeef"), "/grant/:gid");
        assert_eq!(route_label(&format!("/lib/{LIB}/batch")), "/lib/:id/batch");

        let h = harness().await;
        let claim = member();
        let put =
            h.send("PUT", &format!("/lib/{LIB}/grants"), None, &[("x-den-library-member", &claim)]).await;
        assert_eq!(put.status(), StatusCode::METHOD_NOT_ALLOWED);
        let post = h
            .send("POST", &format!("/lib/{LIB}/grants/deadbeef"), None, &[("x-den-library-member", &claim)])
            .await;
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(h.send("POST", "/grant/addons", None, &[]).await.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            h.send("GET", "/grant/deadbeef", None, &[]).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );

        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().web_origins = vec!["https://pve.example".into()];
        let preflight = h
            .send(
                "OPTIONS",
                "/grant/addons",
                None,
                &[("origin", "https://pve.example"), ("access-control-request-method", "GET")],
            )
            .await;
        let allowed = preflight.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS].to_str().unwrap();
        assert!(allowed.contains("x-den-grant"), "{allowed}");
    }

    #[tokio::test]
    async fn the_guest_routes_answer_on_every_name_a_browser_or_a_tv_may_use() {
        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        state.api_hosts = crate::parse_hosts("API_HOSTS", "d-api.oxy.fi");
        for host in ["d.oxy.fi", "d-api.oxy.fi", "192.168.1.2:8094"] {
            let resp = h
                .send(
                    "POST",
                    "/grant/redeem",
                    Some("{}".into()),
                    &[("host", host), ("content-type", "application/json")],
                )
                .await;
            assert_eq!(
                body_json(resp).await,
                json!({ "error": "invalid_code" }),
                "{host}: reached the handler"
            );
        }
    }
}
