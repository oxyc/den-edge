//! `/lib/{id}/…` — the library record log (the Den Web plan, §C): an ordered, durable mailbox of per-record
//! ciphertext that the clients merge. Each record key holds only its latest value and every write takes the
//! next sequence number, so a client catches up with "everything after N" and the log never grows past the
//! live records for long. A write names the sequence it was based on; a stale one is refused with the current
//! row, which the client merges and writes again — compare-and-set per record. Tombstones are ordinary
//! writes, and nothing expires.
//!
//!   POST /lib/{id}/batch  { writes: [{ k, base, v }] } → { head, applied: [{ k, seq }], conflicts: [{ k, seq, v }], generation }
//!                                                       (from wire minimum 4, a conflict past 2 MiB of values is
//!                                                       { k, seq, omitted: true })
//!   GET  /lib/{id}/changes?since=N&limit=L            → { entries: [{ k, seq, v }], head, more, generation } (gzip when accepted)
//!                                                       (`&wait=S`: with nothing after `since`, held up to S ≤ 25
//!                                                       seconds until a write to this library commits)
//!   DELETE /lib/{id}                                   → { deleted: true }
//!
//! All carry `x-den-library-token`. The first write to a library sets it — only its SHA-256 is kept — and
//! every later request must match it. A library nobody has written is a 404, which carries `generation` too.
//! With `NEW_LIBRARIES=members`, that first write must also carry `x-den-library-member: <id>:<token>` of another
//! library here (`NewLibraries`).
//! `PUT /lib/{id}/member` registers the separately-derived member proof. Older logs accept the write token as a
//! member proof only until that registration, so clients can migrate one library at a time.
//!
//! `generation` is the store's (`Store::generation`): a different one tells a client that remembers how far it
//! read that this store was restored or started over, so it reads from 0 and writes back what it holds.
//!
//! On disk, v3 is one transactional redb database per library. Its key index, sequence index, canonical row
//! fragments, credentials and head change atomically, and superseded rows disappear in that same commit. A v2
//! append log is migrated lazily under only its library lock; a durable marker selects exactly one authority, so
//! startup neither replays nor migrates libraries and every crash prefix selects a complete v2 or complete v3 state.

use crate::handler::{
    constant_time_eq, error, internal, json_reply, method_not_allowed, query_param, raw_json, read_json,
};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::Infallible;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

pub(crate) mod v3;
#[cfg(test)]
mod v3_model;

const NS: &str = "lib";
const EXT: &str = "log";
const FORMAT_EXT: &str = "format";
const FORMAT_V3: &[u8] = b"3\n";
const AUTHORITY_UNKNOWN: u64 = 0;
const AUTHORITY_V2: u64 = 1;
const AUTHORITY_V3: u64 = 2;
const AUTHORITY_MOVED: u64 = 3;
/// A deleted library's marker: its id is retired.
const MOVED: &str = "moved";
const TOKEN_HEADER: &str = "x-den-library-token";
const WIRE_HEADER: &str = "x-den-wire";
const WIRE_MIN_HEADER: &str = "x-den-wire-min";
const GENERATION_HEADER: &str = "x-den-generation";
/// On a `DELETE` that ends a key reset: the head the caller copied the library through. A write since refuses it.
const BASE_HEADER: &str = "x-den-base";
/// On a `DELETE` that ends a key reset: the lowercase hex SHA-256 of the id of the library it moved to, which
/// `410 library_moved` then names as `successor`. The resetting device knows that id and can match the tag; a device
/// the reset cut off, or anyone else who knows the old id, learns nothing of the new one.
const SUCCESSOR_HEADER: &str = "x-den-successor";
const REWRITE_NS: &str = "lib-rewrite";
const REWRITE_EXT: &str = "json";
const REWRITE_IDLE_MS: u64 = 5 * 60 * 1000;
/// How long a library's v2 log is kept after it switched to v3, as a copy to roll back to, before it is removed.
const V2_LOG_GRACE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// `<id>:<token>` of a library the caller already holds, when it starts another (`NewLibraries::Members`).
pub(crate) const MEMBER_HEADER: &str = "x-den-library-member";
/// Libraries an address may start a minute. A household starts one per TV and another when it moves to a new key;
/// every one is new storage, which anyone may ask for while `NEW_LIBRARIES=open`.
const NEW_PER_WINDOW: u32 = 5;
/// Writes per batch: a client pushes a few at a time, and a first upload of a few thousand in batches.
const MAX_WRITES: usize = 200;
/// A sealed record is under a kilobyte; this is room for any, not a target. The cap below wire minimum 4, and so
/// of every v2 log line.
const MAX_VALUE: usize = 32 * 1024;
/// The cap from wire minimum 4 (den-spec `wire/library-v4.md` §13), where a row is a whole title's or season's
/// document. Staged rewrite rows may reach it at any minimum; the commit applies the minimum it leaves behind.
const MAX_VALUE_V4: usize = 256 * 1024;
/// Conflict values one v4 batch response carries; past it a conflict is `{k, seq, "omitted": true}` and the
/// client reads the row from `/changes`. 200 conflicts at the v4 cap would otherwise be a 50 MiB response. Test
/// builds halve it: their `MAX_ROWS` of 8 rows at the cap make exactly 2 MiB, which never exceeds it.
const MAX_CONFLICT_BYTES: usize = if cfg!(test) { 1024 * 1024 } else { 2 * 1024 * 1024 };
pub const BATCH_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_LIMIT: usize = 500;
const MAX_LIMIT: usize = 1000;
/// Rows a library may hold: a long-time viewer's titles and episodes fit many times over; a stranger using the
/// relay as free storage hits it (issue #8, #5).
const MAX_ROWS: usize = if cfg!(test) { 8 } else { 50_000 };
/// A library nobody has touched for this long leaves memory; its log reloads it on the next request.
const IDLE_MS: u64 = 60 * 60 * 1000;
const LIBRARY_OVERHEAD: usize = 512;
const ROW_OVERHEAD: usize = 192;
// A JSON string may expand each byte to a six-byte escape on disk.
const MAX_LOG_LINE: usize = 6 * (MAX_VALUE + 128) + 128;
const MAX_CACHED_LIBRARIES: usize = 128;
const PAGE_BYTES: usize = 512 * 1024;
/// Held `/changes?wait=` requests per library (`hold.rs`); past it a request is answered at once. A household holds
/// one per TV and per open browser.
pub const MAX_HELD_PER_LIBRARY: usize = 4;
/// Held `/changes` requests across every library. Each keeps a connection open, though no admission slot.
pub const MAX_HELD: usize = 16;
/// Leave networking and small control work cores while large sync pages are compressed. When both are busy a
/// caller receives identity; compression is a representation choice, not a reason to queue or reject the page.
pub(crate) const COMPRESSION_JOBS: usize = 4;

/// Sized for the shipped 64 MiB container, leaving room for requests, serialization and compaction.
/// The charge includes twice the string lengths plus map/row overhead, rather than claiming to
/// measure allocator RSS exactly. The disk quota is a separate limit.
#[derive(Clone, Copy)]
pub struct Limits {
    /// What a legacy (v2) log may charge as it is replayed into memory, and what `load` reserves for one.
    pub library_bytes: usize,
    pub cache_bytes: usize,
    /// The same charge for a v3 library, which lives in its redb file rather than in memory: a bound on what one
    /// library may hold, well inside the per-library file cap, not a memory reservation. 8 MiB here, as for v2, was
    /// about 1,800 watched episodes: an episode row and its tracker event charge about 1 KiB and 3.6 KiB.
    pub stored_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { library_bytes: 8 * 1024 * 1024, cache_bytes: 16 * 1024 * 1024, stored_bytes: 32 * 1024 * 1024 }
    }
}

/// Whether a sealed value fits the cap of a library at `wire_min`. From minimum 4 the value is measured as it is
/// stored, JSON-escaped in its row fragment: identical for base64url, and it keeps one row inside the `PAGE_BYTES`
/// a `/changes` response reserves, which a 256 KiB value of six-byte escapes would not be.
fn value_fits(value: &str, wire_min: u64) -> bool {
    if wire_min < 4 {
        return value.len() <= MAX_VALUE;
    }
    value.len() <= MAX_VALUE_V4
        && serde_json::to_string(value).expect("a string always serialises").len() - 2 <= MAX_VALUE_V4
}

fn row_bytes(k: &str, v: &str, fragment_bytes: usize) -> usize {
    2 * (k.len() + v.len()) + fragment_bytes + ROW_OVERHEAD
}

fn full() -> io::Error {
    io::Error::new(io::ErrorKind::FileTooLarge, "library exceeds its memory budget")
}

fn read_error(e: io::Error) -> Response {
    if e.kind() == io::ErrorKind::FileTooLarge {
        json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("library_full"))
    } else {
        internal("library read", e)
    }
}

/// Who may start a library (env `NEW_LIBRARIES`). `Members`: only a device that proves it holds another library here
/// (`MEMBER_HEADER`), which is what a TV moving its library to a new key does, so a stranger reaching the public
/// device API can't use the relay as storage (den #8). `Open`, the default, lets any first write start one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NewLibraries {
    #[default]
    Open,
    Members,
}

impl NewLibraries {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "open" => Some(Self::Open),
            "members" => Some(Self::Members),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Members => "members",
        }
    }
}

struct Library {
    token_hash: [u8; 32],
    member_hash: Option<[u8; 32]>,
    head: u64,
    rows: HashMap<String, Row>,
    /// Each live row's current sequence to its key. Changes can start at `since` without scanning and sorting
    /// every row in the library; superseded sequences are removed when their key is replaced.
    sequence: BTreeMap<u64, String>,
    /// Write lines in the log file, superseded ones included.
    lines: usize,
    bytes: usize,
}

/// A short-held registry points at independently locked libraries. Disk replay, append, compaction, snapshot
/// selection, and deletion for one household therefore never hold the registry or another household's lock.
/// The registry still owns aggregate cache accounting so the process keeps its hard memory bound.
#[derive(Default)]
pub struct Libraries {
    registry: std::sync::Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    slots: HashMap<String, Arc<LibrarySlot>>,
    bytes: usize,
    loaded: usize,
}

struct LibrarySlot {
    library: tokio::sync::Mutex<Option<Library>>,
    last_used: AtomicU64,
    authority: AtomicU64,
}

impl LibrarySlot {
    fn new(now: u64) -> Self {
        Self {
            library: tokio::sync::Mutex::new(None),
            last_used: AtomicU64::new(now),
            authority: AtomicU64::new(AUTHORITY_UNKNOWN),
        }
    }
}

impl Libraries {
    fn slot(&self, id: &str, now: u64) -> Arc<LibrarySlot> {
        let mut registry = crate::lock(&self.registry);
        let removable: Vec<String> = registry
            .slots
            .iter()
            .filter(|(_, slot)| {
                Arc::strong_count(slot) == 1
                    && (now.saturating_sub(slot.last_used.load(Ordering::Relaxed)) >= IDLE_MS
                        || slot.authority.load(Ordering::Acquire) != AUTHORITY_V3
                            && slot.library.try_lock().is_ok_and(|library| library.is_none()))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for removable_id in removable {
            let stale = registry.slots.remove(&removable_id).expect("the removable slot is registered");
            let mut library = stale.library.try_lock().expect("an inactive slot is unlocked");
            if let Some(library) = library.take() {
                registry.bytes = registry.bytes.saturating_sub(library.bytes);
                registry.loaded -= 1;
            }
        }
        while !registry.slots.contains_key(id) && registry.slots.len() >= MAX_CACHED_LIBRARIES {
            let candidate = registry
                .slots
                .iter()
                .filter(|(_, slot)| Arc::strong_count(slot) == 1)
                .min_by_key(|(_, slot)| slot.last_used.load(Ordering::Relaxed))
                .map(|(id, _)| id.clone());
            let Some(candidate) = candidate else { break };
            let stale = registry.slots.remove(&candidate).expect("the inactive slot is registered");
            let mut library = stale.library.try_lock().expect("an inactive slot is unlocked");
            if let Some(library) = library.take() {
                registry.bytes = registry.bytes.saturating_sub(library.bytes);
                registry.loaded -= 1;
            }
        }
        let slot = Arc::clone(
            registry.slots.entry(id.to_owned()).or_insert_with(|| Arc::new(LibrarySlot::new(now))),
        );
        slot.last_used.store(now, Ordering::Relaxed);
        slot
    }

    /// Reserve the exact charged size for `id`, evicting only inactive libraries. The caller holds this slot's
    /// lock, so its old charge cannot change concurrently. The returned guard restores the old charge if an async
    /// write/replay is cancelled or returns early; commit it only after memory matches the durable state.
    fn reserve<'a>(
        &'a self,
        id: &str,
        slot: &Arc<LibrarySlot>,
        old: usize,
        needed: usize,
        limits: Limits,
    ) -> io::Result<Reservation<'a>> {
        self.adjust(id, slot, old, needed, limits)?;
        Ok(Reservation {
            libraries: self,
            id: id.to_owned(),
            slot: Arc::clone(slot),
            old,
            current: needed,
            limits,
            committed: false,
        })
    }

    fn adjust(
        &self,
        id: &str,
        slot: &Arc<LibrarySlot>,
        old: usize,
        needed: usize,
        limits: Limits,
    ) -> io::Result<()> {
        if needed > limits.library_bytes || needed > limits.cache_bytes {
            return Err(full());
        }
        let mut registry = crate::lock(&self.registry);
        if !registry.slots.get(id).is_some_and(|registered| Arc::ptr_eq(registered, slot)) {
            return Err(io::Error::other("library slot left its registry"));
        }
        registry
            .bytes
            .checked_sub(old)
            .ok_or_else(|| io::Error::other("library cache accounting underflow"))?;
        let adding = usize::from(old == 0 && needed != 0);
        while registry.bytes - old + needed > limits.cache_bytes
            || registry.loaded + adding > MAX_CACHED_LIBRARIES
        {
            let candidate = registry
                .slots
                .iter()
                .filter(|(key, candidate)| key.as_str() != id && Arc::strong_count(candidate) == 1)
                .min_by_key(|(_, candidate)| candidate.last_used.load(Ordering::Relaxed))
                .map(|(key, _)| key.clone())
                .ok_or_else(full)?;
            let candidate = registry.slots.remove(&candidate).expect("the eviction candidate is registered");
            let mut library = candidate.library.try_lock().map_err(|_| full())?;
            if let Some(library) = library.take() {
                registry.bytes = registry.bytes.saturating_sub(library.bytes);
                registry.loaded -= 1;
            }
        }
        registry.bytes = registry.bytes - old + needed;
        registry.loaded = registry.loaded + adding - usize::from(old != 0 && needed == 0);
        Ok(())
    }

    #[cfg(test)]
    async fn cached_len(&self) -> usize {
        crate::lock(&self.registry).loaded
    }

    #[cfg(test)]
    async fn cached_bytes(&self) -> usize {
        crate::lock(&self.registry).bytes
    }

    #[cfg(test)]
    pub(crate) async fn contains_cached(&self, id: &str) -> bool {
        let slot = {
            let registry = crate::lock(&self.registry);
            registry.slots.get(id).cloned()
        };
        let Some(slot) = slot else { return false };
        let cached = slot.library.lock().await.is_some();
        cached
    }

    #[cfg(test)]
    pub(crate) async fn clear(&self) {
        let mut registry = crate::lock(&self.registry);
        registry.slots.clear();
        registry.bytes = 0;
        registry.loaded = 0;
    }
}

struct Reservation<'a> {
    libraries: &'a Libraries,
    id: String,
    slot: Arc<LibrarySlot>,
    old: usize,
    current: usize,
    limits: Limits,
    committed: bool,
}

impl Reservation<'_> {
    fn resize(&mut self, needed: usize) -> io::Result<()> {
        self.libraries.adjust(&self.id, &self.slot, self.current, needed, self.limits)?;
        self.current = needed;
        Ok(())
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.libraries
                .adjust(&self.id, &self.slot, self.current, self.old, self.limits)
                .expect("rolling back a library cache reservation cannot fail");
        }
    }
}

struct Row {
    seq: u64,
    /// A changes snapshot clones this pointer under the state lock, not the ciphertext allocation.
    v: Arc<str>,
    /// Canonical response object, escaped once when the row is written or loaded. Unique pages copy already
    /// serialized fragments rather than re-escaping every ciphertext value on every poll.
    fragment: Arc<[u8]>,
}

#[derive(Serialize, Deserialize)]
struct Line {
    s: u64,
    k: String,
    v: String,
}

struct Write {
    k: String,
    base: u64,
    v: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct RewriteStage {
    id: String,
    base: u64,
    touched: u64,
    rows: Vec<RewriteStageRow>,
}

#[derive(Clone, Deserialize, Serialize)]
struct RewriteStageRow {
    k: String,
    v: String,
}

fn full_generation(state: &AppState, library: &str) -> String {
    format!("{}.{}", state.store.generation(), library)
}

async fn protocol_for(state: &AppState, id: &str) -> Result<Option<v3::Protocol>, io::Error> {
    let manager = Arc::clone(&state.library_v3);
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || {
        let Some((token, _)) = manager.credentials(&id).map_err(v3_io)? else { return Ok(None) };
        let store = manager.existing_library(&id, token).map_err(v3_io)?;
        store.protocol().map(Some).map_err(v3_io)
    })
    .await
    .map_err(io::Error::other)?
}

fn with_wire_headers(state: &AppState, mut response: Response, protocol: Option<&v3::Protocol>) -> Response {
    let wire_min = protocol.map_or(2, |value| value.wire_min);
    let generation =
        protocol.map_or_else(|| "0".to_owned(), |value| full_generation(state, &value.generation));
    let headers = response.headers_mut();
    headers.insert(WIRE_MIN_HEADER, HeaderValue::from_str(&wire_min.to_string()).unwrap());
    headers.insert(GENERATION_HEADER, HeaderValue::from_str(&generation).unwrap());
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn load_rewrite(state: &AppState, id: &str) -> io::Result<Option<RewriteStage>> {
    let Some(bytes) = state.store.get_file(REWRITE_NS, id, REWRITE_EXT).await? else { return Ok(None) };
    let stage: RewriteStage = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if state.now().saturating_sub(stage.touched) >= REWRITE_IDLE_MS {
        state.store.delete_file(REWRITE_NS, id, REWRITE_EXT).await?;
        state.store.sync_dir(REWRITE_NS).await?;
        return Ok(None);
    }
    Ok(Some(stage))
}

async fn save_rewrite(state: &AppState, id: &str, stage: &RewriteStage) -> io::Result<()> {
    let bytes = serde_json::to_vec(stage).map_err(io::Error::other)?;
    state.store.replace_file(REWRITE_NS, id, REWRITE_EXT, &bytes).await?;
    state.store.sync_dir(REWRITE_NS).await
}

fn rewrite_id<'a>(action: &'a str, suffix: &str) -> Option<&'a str> {
    action.strip_prefix("rewrite/")?.strip_suffix(suffix)
}

async fn library_store_locked(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    slot: &Arc<LibrarySlot>,
    library: &mut Option<Library>,
) -> Result<Option<Arc<dyn v3::LibraryStore>>, Box<Response>> {
    match v3_store(state, id, token_hash, slot, library, false).await {
        Ok(store) => Ok(store),
        Err(reason) if reason.kind() == io::ErrorKind::PermissionDenied => {
            Err(Box::new(json_reply(StatusCode::FORBIDDEN, &error("forbidden"))))
        }
        Err(reason) => Err(Box::new(read_error(reason))),
    }
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let Some(rest) = path.strip_prefix("/lib/") else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let (id, action) = rest.split_once('/').unwrap_or((rest, ""));
    if !valid_hex_id(id) {
        return with_wire_headers(
            state,
            json_reply(StatusCode::BAD_REQUEST, &error("invalid_library_id")),
            None,
        );
    }
    let protocol = match protocol_for(state, id).await {
        Ok(protocol) => protocol,
        Err(reason) => return with_wire_headers(state, read_error(reason), None),
    };
    let wire = req.headers().get(WIRE_HEADER).and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
    let sent_generation =
        req.headers().get(GENERATION_HEADER).and_then(|value| value.to_str().ok()).map(str::to_owned);
    let home_check = action == "changes"
        && req.method() == Method::GET
        && query_param(&req, "since").as_deref() == Some("0")
        && query_param(&req, "limit").as_deref() == Some("1");
    let minimum = protocol.as_ref().map_or(2, |value| value.wire_min);
    if minimum >= 3 && wire.unwrap_or(0) < minimum && !home_check {
        let response =
            json_reply(StatusCode::UPGRADE_REQUIRED, &json!({ "error": "upgrade_required", "min": minimum }));
        return with_wire_headers(state, response, protocol.as_ref());
    }
    let is_write = matches!(*req.method(), Method::POST | Method::PUT | Method::DELETE);
    let Some(token) = req
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|t| !t.is_empty() && t.len() <= 256)
    else {
        return with_wire_headers(
            state,
            json_reply(StatusCode::UNAUTHORIZED, &error("missing_token")),
            protocol.as_ref(),
        );
    };
    let token_hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    if protocol.is_some() {
        let manager = Arc::clone(&state.library_v3);
        let owned_id = id.to_owned();
        match tokio::task::spawn_blocking(move || manager.credentials(&owned_id)).await {
            Ok(Ok(Some((stored, _)))) if constant_time_eq(&stored, &token_hash) => {}
            Ok(Ok(Some(_))) => {
                return with_wire_headers(
                    state,
                    json_reply(StatusCode::FORBIDDEN, &error("forbidden")),
                    protocol.as_ref(),
                );
            }
            Ok(Ok(None)) => {}
            Ok(Err(reason)) => {
                return with_wire_headers(
                    state,
                    internal("library credentials", v3_io(reason)),
                    protocol.as_ref(),
                );
            }
            Err(reason) => {
                return with_wire_headers(
                    state,
                    internal("library credentials task", io::Error::other(reason)),
                    protocol.as_ref(),
                );
            }
        }
    }
    // A DELETE to a retired library — a key reset's, retried or replayed — learns that it landed, and for which
    // successor, before the generation check: a retired library has none, and `409 generation_changed` would send the
    // resetting client back to copy a library that is gone.
    if action.is_empty() && req.method() == Method::DELETE {
        match retired(state, id).await {
            Ok(true) => return with_wire_headers(state, moved(state, id).await, protocol.as_ref()),
            Ok(false) => {}
            Err(reason) => return with_wire_headers(state, read_error(reason), protocol.as_ref()),
        }
    }
    if is_write && wire.is_some() {
        let current = protocol
            .as_ref()
            .map_or_else(|| "0".to_owned(), |value| full_generation(state, &value.generation));
        if sent_generation.as_deref() != Some(current.as_str()) {
            eprintln!(
                "library generation changed: library={} sent={} current={}",
                &id[..id.len().min(8)],
                sent_generation.as_deref().unwrap_or("missing"),
                current
            );
            let response = json_reply(StatusCode::CONFLICT, &error("generation_changed"));
            return with_wire_headers(state, response, protocol.as_ref());
        }
    }
    if is_write && !action.starts_with("rewrite") {
        match load_rewrite(state, id).await {
            Ok(Some(_)) => {
                let response = crate::handler::retry_after(
                    StatusCode::CONFLICT,
                    &error("rewrite_in_progress"),
                    REWRITE_IDLE_MS,
                );
                return with_wire_headers(state, response, protocol.as_ref());
            }
            Ok(None) => {}
            Err(reason) => return with_wire_headers(state, read_error(reason), protocol.as_ref()),
        }
    }
    let response = match (action, req.method().clone()) {
        ("batch", Method::POST) => batch(state, id, token_hash, req).await,
        ("changes", Method::GET | Method::HEAD) => {
            let since = query_param(&req, "since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = query_param(&req, "limit")
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_LIMIT)
                .clamp(1, MAX_LIMIT);
            let (_, gzip, identity) = crate::web::encodings(req.headers());
            // Only a GET is held: a HEAD asks about the answer, not for a wait.
            let hold = crate::hold::wait(query_param(&req, "wait"))
                .filter(|_| req.method() == Method::GET)
                .map(|wait| Hold {
                    wait,
                    generation: sent_generation.clone(),
                    admission: req.extensions().get::<crate::handler::AdmissionSlot>().cloned(),
                });
            changes(state, id, token_hash, since, limit, gzip > 0 && gzip >= identity, hold).await
        }
        ("member", Method::PUT) => register_member(state, id, token_hash, req).await,
        ("", Method::DELETE) => match reset_headers(req.headers()) {
            Ok((base, successor)) => forget(state, id, token_hash, base, successor.as_deref()).await,
            Err(()) => json_reply(StatusCode::BAD_REQUEST, &error("bad_request")),
        },
        ("rewrite", Method::POST) => rewrite_open(state, id, token_hash).await,
        (action, Method::POST) if action.starts_with("rewrite/") && action.ends_with("/rows") => {
            rewrite_rows(state, id, token_hash, action, req).await
        }
        (action, Method::POST) if action.starts_with("rewrite/") && action.ends_with("/commit") => {
            rewrite_commit(state, id, token_hash, wire.unwrap_or(0), action, req).await
        }
        (action, Method::DELETE) if action.starts_with("rewrite/") => {
            rewrite_abort(state, id, token_hash, action).await
        }
        ("batch" | "changes" | "member" | "" | "rewrite", _) => method_not_allowed(),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    };
    let latest = protocol_for(state, id).await.ok().flatten().or(protocol);
    with_wire_headers(state, response, latest.as_ref())
}

async fn rewrite_open(state: &AppState, id: &str, token_hash: [u8; 32]) -> Response {
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    let Some(store) = (match library_store_locked(state, id, token_hash, &slot, &mut library).await {
        Ok(store) => store,
        Err(response) => return *response,
    }) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    match load_rewrite(state, id).await {
        Ok(Some(_)) => return json_reply(StatusCode::CONFLICT, &error("rewrite_in_progress")),
        Ok(None) => {}
        Err(reason) => return read_error(reason),
    }
    let protocol = match tokio::task::spawn_blocking(move || store.protocol()).await {
        Ok(Ok(protocol)) => protocol,
        Ok(Err(reason)) => return internal("rewrite open", v3_io(reason)),
        Err(reason) => return internal("rewrite open task", io::Error::other(reason)),
    };
    let stage = RewriteStage {
        id: crate::hex(&crate::random_bytes::<16>()),
        base: protocol.head,
        touched: state.now(),
        rows: Vec::new(),
    };
    if let Err(reason) = save_rewrite(state, id, &stage).await {
        return internal("rewrite stage", reason);
    }
    json_reply(StatusCode::OK, &json!({ "rewrite": stage.id, "base": stage.base }))
}

async fn rewrite_rows(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    action: &str,
    req: Request,
) -> Response {
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    if let Err(response) = library_store_locked(state, id, token_hash, &slot, &mut library).await {
        return *response;
    }
    let Some(requested) = rewrite_id(action, "/rows") else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let body = match read_json(req, BATCH_MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let Some(writes) = body.get("writes").and_then(Value::as_array) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
    };
    if writes.is_empty() || writes.len() > MAX_WRITES {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
    }
    let mut parsed = Vec::with_capacity(writes.len());
    for write in writes {
        let Some(k) = write.get("k").and_then(Value::as_str).filter(|key| valid_hex_id(key)) else {
            return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
        };
        // Staging precedes the commit that raises the minimum, so it takes the v4 cap at any minimum; a commit
        // that leaves the library below 4 refuses a row over 32 KiB (`v3::RedbLibrary::rewrite`).
        let Some(v) = write.get("v").and_then(Value::as_str).filter(|value| value_fits(value, 4)) else {
            return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
        };
        parsed.push(RewriteStageRow { k: k.to_owned(), v: v.to_owned() });
    }
    let mut stage = match load_rewrite(state, id).await {
        Ok(Some(stage)) if stage.id == requested => stage,
        Ok(Some(_)) | Ok(None) => return json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        Err(reason) => return read_error(reason),
    };
    for row in parsed {
        stage.rows.retain(|existing| existing.k != row.k);
        stage.rows.push(row);
    }
    if stage.rows.len() > MAX_ROWS {
        return json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("library_full"));
    }
    // The same stored-byte charge the commit applies, so a staging that is accepted here also commits.
    let charged =
        stage.rows.iter().try_fold(0u64, |total, row| total.checked_add(v3::stored_charge(&row.k, &row.v)));
    if charged.is_none_or(|bytes| bytes > state.library_limits.stored_bytes as u64) {
        return json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("library_full"));
    }
    stage.touched = state.now();
    if let Err(reason) = save_rewrite(state, id, &stage).await {
        return internal("rewrite rows", reason);
    }
    json_reply(StatusCode::OK, &json!({ "staged": stage.rows.len() }))
}

async fn rewrite_commit(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    wire: u64,
    action: &str,
    req: Request,
) -> Response {
    let Some(requested) = rewrite_id(action, "/commit") else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let body = match read_json(req, 1024).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let Some(base) = body.get("base").and_then(Value::as_u64) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
    };
    let Some(wire_min) = body.get("wireMin").and_then(Value::as_u64).filter(|minimum| *minimum <= wire)
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
    };
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    let Some(store) = (match library_store_locked(state, id, token_hash, &slot, &mut library).await {
        Ok(store) => store,
        Err(response) => return *response,
    }) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let stage = match load_rewrite(state, id).await {
        Ok(Some(stage)) if stage.id == requested => stage,
        Ok(Some(_)) | Ok(None) => return json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        Err(reason) => return read_error(reason),
    };
    if base != stage.base {
        return json_reply(StatusCode::CONFLICT, &json!({ "head": stage.base }));
    }
    let rows: Vec<_> =
        stage.rows.iter().map(|row| v3::RewriteRow { key: row.k.clone(), value: row.v.clone() }).collect();
    let live_cap = state.library_limits.stored_bytes;
    let write_store = Arc::clone(&store);
    match tokio::task::spawn_blocking(move || write_store.rewrite(base, &rows, wire_min, live_cap)).await {
        Ok(Ok(protocol)) => {
            // Committed whatever the cleanup does: a held reader learns of the new rows and generation now.
            state.library_holds.wake(id);
            if let Err(reason) = state.store.delete_file(REWRITE_NS, id, REWRITE_EXT).await {
                return internal("rewrite cleanup", reason);
            }
            if let Err(reason) = state.store.sync_dir(REWRITE_NS).await {
                return internal("rewrite cleanup publish", reason);
            }
            maintain_v3(state, id, store).await;
            json_reply(StatusCode::OK, &json!({ "head": protocol.head }))
        }
        Ok(Err(v3::StoreError::Invalid(message))) if message.starts_with("head_moved:") => {
            let head =
                message.split_once(':').and_then(|(_, value)| value.parse::<u64>().ok()).unwrap_or(base);
            json_reply(StatusCode::CONFLICT, &json!({ "head": head }))
        }
        Ok(Err(v3::StoreError::Full)) => json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("library_full")),
        Ok(Err(v3::StoreError::TooLarge)) => json_reply(StatusCode::BAD_REQUEST, &error("value_too_large")),
        Ok(Err(reason)) => internal("rewrite commit", v3_io(reason)),
        Err(reason) => internal("rewrite commit task", io::Error::other(reason)),
    }
}

async fn rewrite_abort(state: &AppState, id: &str, token_hash: [u8; 32], action: &str) -> Response {
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    if let Err(response) = library_store_locked(state, id, token_hash, &slot, &mut library).await {
        return *response;
    }
    let Some(requested) = action.strip_prefix("rewrite/").filter(|value| !value.contains('/')) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    match load_rewrite(state, id).await {
        Ok(Some(stage)) if stage.id == requested => {}
        Ok(Some(_)) | Ok(None) => return json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        Err(reason) => return read_error(reason),
    }
    if let Err(reason) = state.store.delete_file(REWRITE_NS, id, REWRITE_EXT).await {
        return internal("rewrite abort", reason);
    }
    if let Err(reason) = state.store.sync_dir(REWRITE_NS).await {
        return internal("rewrite abort publish", reason);
    }
    json_reply(StatusCode::OK, &json!({ "aborted": true }))
}

/// Replace the temporary legacy membership proof with the key derived specifically for relay membership.
async fn register_member(state: &AppState, id: &str, token_hash: [u8; 32], req: Request) -> Response {
    let Some((claimed_id, member)) =
        req.headers().get(MEMBER_HEADER).and_then(|v| v.to_str().ok()).and_then(|v| v.split_once(':'))
    else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_member"));
    };
    if claimed_id != id || member.is_empty() || member.len() > 256 {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_member"));
    }
    let member_hash: [u8; 32] = Sha256::digest(member.as_bytes()).into();
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    match load_rewrite(state, id).await {
        Ok(Some(_)) => {
            return crate::handler::retry_after(
                StatusCode::CONFLICT,
                &error("rewrite_in_progress"),
                REWRITE_IDLE_MS,
            );
        }
        Ok(None) => {}
        Err(reason) => return read_error(reason),
    }
    let store = match v3_store(state, id, token_hash, &slot, &mut library, false).await {
        Ok(Some(store)) => store,
        Ok(None) => return json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        Err(reason) if reason.kind() == io::ErrorKind::PermissionDenied => {
            return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
        }
        Err(reason) => return read_error(reason),
    };
    match tokio::task::spawn_blocking(move || store.register_member(member_hash)).await {
        Ok(Ok(_)) => {}
        Ok(Err(v3::StoreError::Invalid(message))) if message == "member_already_registered" => {
            return json_reply(StatusCode::CONFLICT, &error("member_already_registered"));
        }
        Ok(Err(reason)) => return internal("member registration", v3_io(reason)),
        Err(reason) => return internal("member registration task", io::Error::other(reason)),
    }
    json_reply(StatusCode::OK, &json!({ "registered": true }))
}

/// A key reset's `DELETE` headers: the head it copied through, and its successor tag. `Err` when either is present
/// but malformed: an unread `x-den-base` would delete with no check at all.
#[allow(clippy::result_unit_err)]
fn reset_headers(headers: &axum::http::HeaderMap) -> Result<(Option<u64>, Option<String>), ()> {
    let header = |name: &str| headers.get(name).map(|v| v.to_str().map_err(|_| ()));
    let base = header(BASE_HEADER).transpose()?.map(|v| v.parse::<u64>().map_err(|_| ())).transpose()?;
    let successor = header(SUCCESSOR_HEADER).transpose()?;
    if successor.is_some_and(|v| !valid_hex_id(v)) {
        return Err(());
    }
    Ok((base, successor.map(str::to_owned)))
}

/// The library's owner ends it — a rekey moved the library to a new key (issue #8, audit #2). Its log and rows
/// are gone, and the id is retired: a device still holding the old key gets `410 library_moved` rather than
/// quietly starting the library over (den #12, S5). A key reset names the head it copied through (`base`, refused
/// with `409 head_changed` once the library moved past it) and a tag of the library it moved to (`successor`, which
/// the `410` then names, so a device that reset concurrently or lost this answer can tell whether the move was its
/// own). A DELETE to an id already retired gets that same `410`.
async fn forget(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    base: Option<u64>,
    successor: Option<&str>,
) -> Response {
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    match load_rewrite(state, id).await {
        Ok(Some(_)) => {
            return crate::handler::retry_after(
                StatusCode::CONFLICT,
                &error("rewrite_in_progress"),
                REWRITE_IDLE_MS,
            );
        }
        Ok(None) => {}
        Err(reason) => return read_error(reason),
    }
    let selected_v3 = match authority(state, &slot, id).await {
        // A retried or replayed DELETE learns that it landed, and for which successor.
        Ok(AUTHORITY_MOVED) => return moved(state, id).await,
        Ok(selected) => selected == AUTHORITY_V3,
        Err(reason) => return read_error(reason),
    };
    // An oversized legacy log can still be deleted by its owner without replaying it. V3 reads only its fixed
    // metadata and never reconstructs rows for deletion.
    let stored_token = if selected_v3 {
        let manager = Arc::clone(&state.library_v3);
        let owned_id = id.to_owned();
        match tokio::task::spawn_blocking(move || manager.credentials(&owned_id)).await {
            Ok(Ok(Some((token, _)))) => token,
            Ok(Ok(None)) => return json_reply(StatusCode::NOT_FOUND, &error("not_found")),
            Ok(Err(reason)) => return internal("library credentials", v3_io(reason)),
            Err(reason) => return internal("library credentials task", io::Error::other(reason)),
        }
    } else if let Some(lib) = library.as_ref() {
        lib.token_hash
    } else {
        let file = match state.store.open_file(NS, id, EXT).await {
            Ok(Some(file)) => file,
            Ok(None) => return json_reply(StatusCode::NOT_FOUND, &error("not_found")),
            Err(e) => return read_error(e),
        };
        match read_header(&mut BufReader::new(file)).await {
            Ok(Some((hash, _))) => hash,
            Ok(None) => return json_reply(StatusCode::NOT_FOUND, &error("not_found")),
            Err(e) => return read_error(e),
        }
    };
    if !constant_time_eq(&stored_token, &token_hash) {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    }
    // A key reset copied the library through `base` (den-spec library-v4 §12): a write since then would be lost with
    // it, so the copy is made again first. Checked under the library's lock, so no write lands between this and the
    // retirement. A head that can't be read (an unloaded v2 log, never the source of a reset) refuses it.
    if let Some(base) = base {
        let head = if selected_v3 {
            let manager = Arc::clone(&state.library_v3);
            let owned_id = id.to_owned();
            match tokio::task::spawn_blocking(move || {
                manager.existing_library(&owned_id, stored_token)?.range(base, 1).map(|page| page.head)
            })
            .await
            {
                Ok(Ok(head)) => Some(head),
                Ok(Err(reason)) => return internal("library head", v3_io(reason)),
                Err(reason) => return internal("library head task", io::Error::other(reason)),
            }
        } else {
            library.as_ref().map(|lib| lib.head)
        };
        if head != Some(base) {
            return json_reply(StatusCode::CONFLICT, &error("head_changed"));
        }
    }
    // The owner's guests go with the token that vouched for them.
    let revoked = match crate::grants::revoke_host(state, id).await {
        Ok(gids) => gids,
        Err(e) => return internal("library grants revoke", e),
    };
    if let Err(e) = state.store.replace_file(NS, id, MOVED, successor.unwrap_or_default().as_bytes()).await {
        return internal("library retire", e);
    }
    // The marker is written: the library is retired, and the answer is 200 from here on. A client told anything else
    // would take its move as failed and delete the only copy left; cleanup that fails is logged and left behind.
    slot.authority.store(AUTHORITY_MOVED, Ordering::Release);
    // A held reader is told now that the library moved, rather than at the end of its wait.
    state.library_holds.wake(id);
    if let Err(e) = state.store.sync_dir(NS).await {
        eprintln!("library retire publish: {e}");
    }
    if selected_v3 {
        let manager = Arc::clone(&state.library_v3);
        let owned_id = id.to_owned();
        match tokio::task::spawn_blocking(move || manager.remove(&owned_id)).await {
            Ok(Ok(())) => {}
            Ok(Err(reason)) => eprintln!("library database delete: {}", v3_io(reason)),
            Err(reason) => eprintln!("library database delete task: {reason}"),
        }
        if let Err(e) = state.store.delete_file(NS, id, FORMAT_EXT).await {
            eprintln!("library format delete: {e}");
        }
    }
    if let Err(e) = state.store.delete_file(NS, id, EXT).await {
        eprintln!("library delete: {e}");
    }
    let charged = library.take().map_or(0, |library| library.bytes);
    state
        .libraries
        .reserve(id, &slot, charged, 0, state.library_limits)
        .expect("a deleted library always releases its cache charge")
        .commit();
    // So the retirement cannot be undone by a power loss. Both are done; a failure is reported, not answered.
    if let Err(e) = state.store.sync_dir(NS).await {
        eprintln!("library retire: {e}");
    }
    drop(library);
    for gid in revoked {
        crate::grants::end_sessions(state, &gid).await;
    }
    json_reply(StatusCode::OK, &json!({ "deleted": true }))
}

/// Whether `id` belonged to a library its owner deleted. Asked only when no library is loaded under it.
async fn retired(state: &AppState, id: &str) -> io::Result<bool> {
    Ok(state.store.get_file(NS, id, MOVED).await?.is_some())
}

/// `410 library_moved`, naming the successor a key reset's `DELETE` gave (`SUCCESSOR_HEADER`), when it gave one. A
/// marker that can't be read is `503`, never a `410` without one: a client takes that as another device's move.
async fn moved(state: &AppState, id: &str) -> Response {
    let successor = match state.store.get_file(NS, id, MOVED).await {
        Ok(marker) => marker.and_then(|bytes| String::from_utf8(bytes).ok()).filter(|s| valid_hex_id(s)),
        Err(reason) => {
            eprintln!("library retire marker: {reason}");
            return json_reply(StatusCode::SERVICE_UNAVAILABLE, &error("library_unavailable"));
        }
    };
    match successor {
        Some(successor) => {
            json_reply(StatusCode::GONE, &json!({ "error": "library_moved", "successor": successor }))
        }
        None => json_reply(StatusCode::GONE, &error("library_moved")),
    }
}

fn v3_io(error: v3::StoreError) -> io::Error {
    match error {
        v3::StoreError::Full => full(),
        v3::StoreError::Forbidden => io::Error::new(io::ErrorKind::PermissionDenied, "forbidden"),
        v3::StoreError::TooLarge => io::Error::new(io::ErrorKind::InvalidInput, "value_too_large"),
        v3::StoreError::Invalid(message) | v3::StoreError::Failed(message) => io::Error::other(message),
    }
}

/// `None` is deliberately v2, `3` is deliberately v3, and every other marker fails closed. A corrupt marker must
/// never make the old log and new database compete as authorities.
async fn format_v3(state: &AppState, id: &str) -> io::Result<bool> {
    match state.store.get_file(NS, id, FORMAT_EXT).await? {
        None => Ok(false),
        Some(marker) if marker == FORMAT_V3 => Ok(true),
        Some(_) => Err(io::Error::other("unsupported library format marker")),
    }
}

async fn authority(state: &AppState, slot: &LibrarySlot, id: &str) -> io::Result<u64> {
    let selected = slot.authority.load(Ordering::Acquire);
    if selected != AUTHORITY_UNKNOWN {
        return Ok(selected);
    }
    let selected = if retired(state, id).await? {
        AUTHORITY_MOVED
    } else if format_v3(state, id).await? {
        AUTHORITY_V3
    } else {
        AUTHORITY_V2
    };
    slot.authority.store(selected, Ordering::Release);
    Ok(selected)
}

async fn publish_v3(state: &AppState, slot: &LibrarySlot, id: &str) -> io::Result<()> {
    state.store.replace_file(NS, id, FORMAT_EXT, FORMAT_V3).await?;
    state.store.sync_dir(NS).await?;
    slot.authority.store(AUTHORITY_V3, Ordering::Release);
    Ok(())
}

/// Upkeep after a committed v3 write, under the library's lock: drop a v2 log past its grace, then compact the
/// database if it is mostly free pages. Neither changes what the library holds, so a failure is logged and the
/// write's answer stands.
async fn maintain_v3(state: &AppState, id: &str, store: Arc<dyn v3::LibraryStore>) {
    let short = &id[..id.len().min(8)];
    if let Err(reason) = retire_v2_log(state, id).await {
        eprintln!("library v2 log retirement: library={short} {reason}");
    }
    // A staged rewrite is about to replace every row; compacting under it would rewrite the file twice.
    match load_rewrite(state, id).await {
        Ok(None) => {}
        Ok(Some(_)) => return,
        Err(reason) => {
            eprintln!("library compaction: library={short} {reason}");
            return;
        }
    }
    let now = state.now();
    match tokio::task::spawn_blocking(move || store.compact_if_sparse(now)).await {
        Ok(Ok(Some((before, after)))) => {
            eprintln!("library compacted: library={short} bytes={before}->{after}");
        }
        Ok(Ok(None)) => {}
        Ok(Err(reason)) => eprintln!("library compaction: library={short} {}", v3_io(reason)),
        Err(reason) => eprintln!("library compaction task: library={short} {reason}"),
    }
}

/// Remove a v3 library's old v2 log once `V2_LOG_GRACE_MS` have passed since its switch. The switch time is the
/// format marker's mtime: `publish_v3` writes the marker once (temporary file, sync, rename) and nothing rewrites it,
/// and backups and restores keep mtimes; one that did not would only restart the grace. Without a v3 marker the log
/// is the authority and stays.
async fn retire_v2_log(state: &AppState, id: &str) -> io::Result<()> {
    if state.store.modified_ms(NS, id, EXT).await?.is_none() {
        return Ok(());
    }
    let Some(switched) = state.store.modified_ms(NS, id, FORMAT_EXT).await? else { return Ok(()) };
    if !format_v3(state, id).await? || state.now().saturating_sub(switched) < V2_LOG_GRACE_MS {
        return Ok(());
    }
    state.store.delete_file(NS, id, EXT).await?;
    state.store.sync_dir(NS).await
}

/// Select one durable authority while holding this library's existing lock. Migration publishes a complete sibling
/// database before the marker; every crash prefix therefore selects v2 or v3, never a mixture of their heads.
async fn v3_store(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    slot: &Arc<LibrarySlot>,
    loaded: &mut Option<Library>,
    create: bool,
) -> io::Result<Option<Arc<dyn v3::LibraryStore>>> {
    match authority(state, slot, id).await? {
        AUTHORITY_MOVED => return Ok(None),
        AUTHORITY_V3 => {
            if let Some(old) = loaded.take() {
                state.libraries.reserve(id, slot, old.bytes, 0, state.library_limits)?.commit();
            }
            return Arc::clone(&state.library_v3).existing_library(id, token_hash).map(Some).map_err(v3_io);
        }
        AUTHORITY_V2 => {}
        _ => unreachable!("authority returns only known states"),
    }

    load(state, slot, loaded, id).await?;
    if loaded.is_none() && !create {
        return Ok(None);
    }
    let old_bytes = loaded.as_ref().map_or(0, |library| library.bytes);
    let temporary = loaded.take().unwrap_or(Library {
        token_hash,
        member_hash: None,
        head: 0,
        rows: HashMap::new(),
        sequence: BTreeMap::new(),
        lines: 0,
        bytes: LIBRARY_OVERHEAD,
    });
    if !constant_time_eq(&temporary.token_hash, &token_hash) {
        *loaded = Some(temporary);
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "forbidden"));
    }
    let manager = Arc::clone(&state.library_v3);
    let owned_id = id.to_owned();
    let imported = tokio::task::spawn_blocking(move || manager.import_v2(&owned_id, &temporary))
        .await
        .map_err(io::Error::other)?
        .map_err(v3_io);
    if let Err(error) = imported {
        // `temporary` moved into the blocking task. Reloading v2 on the next request is safe and bounded; release
        // the old cache reservation now so a failed migration cannot strand aggregate memory accounting.
        state.libraries.reserve(id, slot, old_bytes, 0, state.library_limits)?.commit();
        return Err(error);
    }
    state.libraries.reserve(id, slot, old_bytes, 0, state.library_limits)?.commit();
    publish_v3(state, slot, id).await?;
    Arc::clone(&state.library_v3).existing_library(id, token_hash).map(Some).map_err(v3_io)
}

async fn batch(state: &AppState, id: &str, token_hash: [u8; 32], req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    let member = req.headers().get(MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let wire = req.headers().get(WIRE_HEADER).and_then(|v| v.to_str().ok()?.parse::<u64>().ok());
    let requested_min = req.headers().get(WIRE_MIN_HEADER).and_then(|v| v.to_str().ok()?.parse::<u64>().ok());
    if requested_min.zip(wire).is_some_and(|(minimum, supported)| minimum > supported) {
        return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
    }
    let body = match read_json(req, BATCH_MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some(writes) = parse_writes(&body) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
    };
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    match load_rewrite(state, id).await {
        Ok(Some(_)) => {
            return crate::handler::retry_after(
                StatusCode::CONFLICT,
                &error("rewrite_in_progress"),
                REWRITE_IDLE_MS,
            );
        }
        Ok(None) => {}
        Err(reason) => return read_error(reason),
    }
    let selected_v3 = match authority(state, &slot, id).await {
        Ok(AUTHORITY_MOVED) => return moved(state, id).await,
        Ok(selected) => selected == AUTHORITY_V3,
        Err(reason) => return read_error(reason),
    };
    if !selected_v3 {
        if let Err(error) = load(state, &slot, &mut library, id).await {
            return read_error(error);
        }
    }
    let new_library = !selected_v3 && library.is_none();
    let mut first_min = requested_min.unwrap_or(2);
    if new_library {
        match member_wire_minimum(state, id, member.as_deref()).await {
            Ok(Some(minimum)) => first_min = first_min.max(minimum),
            Ok(None) => {}
            Err(error) => return read_error(error),
        }
        if first_min >= 3 && wire.unwrap_or(0) < first_min {
            return json_reply(
                StatusCode::UPGRADE_REQUIRED,
                &json!({ "error": "upgrade_required", "min": first_min }),
            );
        }
        // Before the store exists: a refused batch must not start a library. `apply_bounded` checks again.
        if writes.iter().any(|write| !value_fits(&write.v, first_min)) {
            return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
        }
    }
    if new_library {
        if state.new_libraries == NewLibraries::Members {
            match holds_another(state, id, member.as_deref()).await {
                Ok(true) => {}
                Ok(false) => return json_reply(StatusCode::FORBIDDEN, &error("new_libraries_closed")),
                Err(e) => return read_error(e),
            }
        }
        if let Some(wait) = crate::link::throttled_at(state, &format!("lib-new:{ip}"), NEW_PER_WINDOW) {
            return crate::handler::retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
        }
    }
    let store = match v3_store(state, id, token_hash, &slot, &mut library, true).await {
        Ok(Some(store)) => store,
        Ok(None) => unreachable!("create=true always returns a store"),
        Err(reason) if reason.kind() == io::ErrorKind::PermissionDenied => {
            return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
        }
        Err(error) => return read_error(error),
    };
    let was_empty = match store.protocol() {
        Ok(protocol) => protocol.head == 0,
        Err(error) => return internal("library protocol", v3_io(error)),
    };
    let writes: Vec<_> = writes
        .into_iter()
        .map(|write| v3::Write { key: write.k, base: write.base, value: write.v })
        .collect();
    let live_cap = state.library_limits.stored_bytes;
    let applied_min = if was_empty { first_min } else { 2 };
    let write_store = Arc::clone(&store);
    let result =
        match tokio::task::spawn_blocking(move || write_store.apply_bounded(&writes, live_cap, applied_min))
            .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(v3::StoreError::Full)) => {
                return json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("library_full"));
            }
            Ok(Err(v3::StoreError::Forbidden)) => {
                return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
            }
            // The answer a v3 client has always had for an oversized value, and one it refuses for good.
            Ok(Err(v3::StoreError::TooLarge)) => {
                return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
            }
            Ok(Err(error)) => return internal("library write", v3_io(error)),
            Err(error) => return internal("library write task", io::Error::other(error)),
        };
    let protocol_store = Arc::clone(&store);
    let protocol = match tokio::task::spawn_blocking(move || protocol_store.protocol()).await {
        Ok(Ok(protocol)) => protocol,
        Ok(Err(error)) => return internal("library protocol", v3_io(error)),
        Err(error) => return internal("library protocol task", io::Error::other(error)),
    };
    if !result.applied.is_empty() {
        state.library_holds.wake(id);
        maintain_v3(state, id, store).await;
    }
    let applied: Vec<Value> =
        result.applied.iter().map(|(key, seq)| json!({ "k": key, "seq": seq })).collect();
    // Only a v4 library bounds its conflicts: a v3 client, whose values are at most 32 KiB, never learned `omitted`.
    let mut conflict_budget = if protocol.wire_min >= 4 { MAX_CONFLICT_BYTES } else { usize::MAX };
    let conflicts: Vec<Value> = result
        .conflicts
        .iter()
        .map(|conflict| {
            let (sequence, value) = conflict.current.as_ref().map_or((0, Value::Null), |row| {
                let decoded: Value = serde_json::from_slice(&row.fragment)
                    .expect("the v3 authority contains only canonical row fragments");
                (row.sequence, decoded.get("v").cloned().unwrap_or(Value::Null))
            });
            let bytes = value.as_str().map_or(0, str::len);
            if bytes > conflict_budget {
                return json!({ "k": conflict.key, "seq": sequence, "omitted": true });
            }
            conflict_budget -= bytes;
            json!({ "k": conflict.key, "seq": sequence, "v": value })
        })
        .collect();
    state.metrics.record_library_writes(applied.len(), conflicts.len());
    json_reply(
        StatusCode::OK,
        &json!({ "head": result.head, "applied": applied, "conflicts": conflicts,
            "generation": full_generation(state, &protocol.generation) }),
    )
}

#[derive(Serialize)]
struct ResponseRow<'a> {
    k: &'a str,
    seq: u64,
    v: &'a str,
}

fn row_fragment(seq: u64, k: &str, v: &str) -> Arc<[u8]> {
    Arc::from(serde_json::to_vec(&ResponseRow { k, seq, v }).expect("a library row always serializes"))
}

fn changes_body(entries: &[Arc<[u8]>], head: u64, more: bool, generation: &str) -> Vec<u8> {
    use std::io::Write as _;

    let entries_bytes: usize = entries.iter().map(|entry| entry.len()).sum();
    let mut body = Vec::with_capacity(entries_bytes + entries.len() + 96);
    body.extend_from_slice(br#"{"entries":["#);
    for (at, entry) in entries.iter().enumerate() {
        if at > 0 {
            body.push(b',');
        }
        body.extend_from_slice(entry);
    }
    write!(body, r#"],"head":{head},"more":{more},"generation":"{generation}"}}"#)
        .expect("writing JSON to memory cannot fail");
    body
}

struct ChunkBody {
    chunks: std::vec::IntoIter<axum::body::Bytes>,
    left: usize,
}

struct HeldLibraryBody {
    body: Body,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl http_body::Body for HeldLibraryBody {
    type Data = axum::body::Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.body).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

impl ChunkBody {
    fn new(page: v3::ChunkPage) -> Self {
        Self { chunks: page.chunks.into_iter(), left: page.len }
    }
}

impl http_body::Body for ChunkBody {
    type Data = axum::body::Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let Some(chunk) = self.chunks.next() else { return Poll::Ready(None) };
        self.left -= chunk.len();
        Poll::Ready(Some(Ok(http_body::Frame::data(chunk))))
    }

    fn is_end_stream(&self) -> bool {
        self.left == 0
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.left as u64)
    }
}

/// A `/changes` request that may be held: for how long, the generation the client read `since` in, and the
/// admission it gives back while it waits.
struct Hold {
    wait: std::time::Duration,
    generation: Option<String>,
    admission: Option<crate::handler::AdmissionSlot>,
}

async fn changes(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    since: u64,
    limit: usize,
    gzip: bool,
    hold: Option<Hold>,
) -> Response {
    // Registered before the head is read: a write that lands after the read must still wake the wait.
    let mut hold = hold.and_then(|hold| Some((state.library_holds.hold(id, &[id])?, hold)));
    let (store, generation) = loop {
        let slot = state.libraries.slot(id, state.now());
        let mut library = slot.library.lock().await;
        match authority(state, &slot, id).await {
            Ok(AUTHORITY_MOVED) => return moved(state, id).await,
            Ok(_) => {}
            Err(reason) => return read_error(reason),
        }
        let store = match v3_store(state, id, token_hash, &slot, &mut library, false).await {
            Ok(Some(store)) => store,
            Err(reason) if reason.kind() == io::ErrorKind::PermissionDenied => {
                return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
            }
            Err(reason) => return read_error(reason),
            Ok(None) => {
                return json_reply(
                    StatusCode::NOT_FOUND,
                    &json!({ "error": "not_found", "generation": "0" }),
                );
            }
        };
        drop(library);
        let protocol_store = Arc::clone(&store);
        let protocol = match tokio::task::spawn_blocking(move || protocol_store.protocol()).await {
            Ok(Ok(protocol)) => protocol,
            Ok(Err(reason)) => return internal("library protocol", v3_io(reason)),
            Err(reason) => return internal("library protocol task", io::Error::other(reason)),
        };
        let generation = full_generation(state, &protocol.generation);
        // Held only when the client is exactly up to date: anything after `since`, a `since` past the head, or a
        // generation other than the one it read in is an answer it needs now.
        if let Some((waiter, hold)) = hold.take() {
            if protocol.head == since && hold.generation.as_deref().is_none_or(|sent| sent == generation) {
                // Neither the library's lock, its open database nor an admission slot is held while waiting: a
                // write, a compaction or a delete goes ahead, and its answer is read afresh.
                drop((slot, store));
                if !crate::handler::AdmissionSlot::wait_out(
                    hold.admission.as_ref(),
                    state,
                    waiter.wait(hold.wait),
                )
                .await
                {
                    return crate::handler::busy();
                }
                continue;
            }
        }
        break (store, generation);
    };
    let response_permit = Arc::clone(&state.library_response_bytes)
        .acquire_many_owned(PAGE_BYTES as u32)
        .await
        .expect("the library response budget is never closed");
    if !gzip {
        let page = if let Some(page) = store.cached_range_chunks(since, limit, &generation) {
            page
        } else {
            match tokio::task::spawn_blocking(move || store.range_chunks(since, limit, &generation)).await {
                Ok(Ok(page)) => page,
                Ok(Err(reason)) => return internal("library read", v3_io(reason)),
                Err(reason) => return internal("library read task", io::Error::other(reason)),
            }
        };
        let length = page.len;
        let body = Body::new(ChunkBody::new(page));
        let mut response =
            raw_json(StatusCode::OK, Body::new(HeldLibraryBody { body, _permit: response_permit }), true);
        response.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&length.to_string()).expect("a body length is a valid header"),
        );
        return response;
    }
    let page = match tokio::task::spawn_blocking(move || store.range(since, limit)).await {
        Ok(Ok(page)) => page,
        Ok(Err(reason)) => return internal("library read", v3_io(reason)),
        Err(reason) => return internal("library read task", io::Error::other(reason)),
    };
    let entries: Vec<_> = page.entries.into_iter().map(|row| row.fragment).collect();

    let mut body = changes_body(&entries, page.head, page.more, &generation);
    if gzip && body.len() >= 1024 {
        if let Ok(permit) = Arc::clone(&state.library_compression_slots).try_acquire_owned() {
            let job = state.metrics.compression_started();
            let compressed = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let input = body.len();
                let compressed = gzip_bytes(&body);
                job.finished(input, compressed.as_ref().map(Vec::len));
                (body, compressed)
            })
            .await;
            match compressed {
                Ok((_, Some(compressed))) => {
                    let body = Body::from(compressed);
                    let mut resp = raw_json(
                        StatusCode::OK,
                        Body::new(HeldLibraryBody { body, _permit: response_permit }),
                        true,
                    );
                    resp.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
                    resp.headers_mut().insert(header::VARY, HeaderValue::from_static("accept-encoding"));
                    return resp;
                }
                Ok((identity, None)) => body = identity,
                Err(error) => {
                    state.metrics.compression_failed();
                    return internal("library compression", io::Error::other(error));
                }
            }
        } else {
            state.metrics.compression_busy();
        }
    }
    let body = Body::from(body);
    raw_json(StatusCode::OK, Body::new(HeldLibraryBody { body, _permit: response_permit }), true)
}

/// A sync page gzipped, when that is worth the bytes. The rows are ciphertext under random nonces and nothing of the
/// request is echoed into them, so compression reveals nothing about what they say.
fn gzip_bytes(body: &[u8]) -> Option<Vec<u8>> {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write as _;
    // These are usually unique sync pages and Cloudflare may recompress public delivery. Fast gzip gives direct
    // clients most of the byte reduction without spending several cores chasing the final few percent.
    let mut encoder = GzEncoder::new(Vec::with_capacity(body.len() / 2), Compression::fast());
    encoder.write_all(body).ok()?;
    encoder.finish().ok()
}

/// Whether `member` (`<id>:<token>`, the `MEMBER_HEADER` a device sends) names a library here and holds its
/// token. What the relay's budget is tiered on: a household that has paired a TV is a known caller and gets
/// room to browse, where an anonymous visitor gets a visitor's allowance. It proves possession of a token
/// den-edge only ever stored the hash of, so it can't be forged from anything readable here.
///
/// Asked on every relayed request, so a library not in memory is answered from its log's header
/// (`holds_member_hash`), not replayed whole under every library's lock.
pub async fn is_member(state: &AppState, member: Option<&str>) -> bool {
    let Some((id, token)) = member.and_then(|m| m.split_once(':')) else {
        return false;
    };
    if !valid_hex_id(id) || token.is_empty() || token.len() > 256 {
        return false;
    }
    let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    holds_member_hash(state, id, &hash).await.unwrap_or_else(|e| {
        eprintln!("library member check: {e}");
        false
    })
}

/// Whether library `id` still takes the member token whose SHA-256 is `hash`: what an assistant connected by a member
/// holds in its stead (`oauth.rs`), so a library key reset — a new member token — also ends those connections.
/// A log that cannot be read is an error, not a "no": the caller must not end a connection over it.
pub async fn holds_member_hash(state: &AppState, id: &str, hash: &[u8; 32]) -> io::Result<bool> {
    if !valid_hex_id(id) {
        return Ok(false);
    }
    // Loaded: answered from memory.
    let slot = state.libraries.slot(id, state.now());
    let library = slot.library.lock().await;
    if let Some(library) = library.as_ref() {
        return Ok(constant_time_eq(library.member_hash.as_ref().unwrap_or(&library.token_hash), hash));
    }
    // Not loaded: its log's first line says whose it is, without replaying the log into memory (and holding every
    // library's lock while it does) for a question the header alone answers. An MCP call asks this every time.
    Ok(header_of(state, &slot, id).await?.is_some_and(|(token_hash, member_hash)| {
        constant_time_eq(member_hash.as_ref().unwrap_or(&token_hash), hash)
    }))
}

/// A library's token and member hashes, from its log's header alone; `None` for a library there is no log of.
async fn header_of(
    state: &AppState,
    slot: &LibrarySlot,
    id: &str,
) -> io::Result<Option<([u8; 32], Option<[u8; 32]>)>> {
    match authority(state, slot, id).await? {
        AUTHORITY_MOVED => return Ok(None),
        AUTHORITY_V3 => {
            let manager = Arc::clone(&state.library_v3);
            let owned_id = id.to_owned();
            return tokio::task::spawn_blocking(move || manager.credentials(&owned_id))
                .await
                .map_err(io::Error::other)?
                .map_err(v3_io);
        }
        AUTHORITY_V2 => {}
        _ => unreachable!("authority returns only known states"),
    }
    let Some(file) = state.store.open_file(NS, id, EXT).await? else { return Ok(None) };
    read_header(&mut BufReader::new(file)).await
}

/// Whether `member` (`<id>:<token>`) names another library on this store and its token. Naming the library being
/// started proves nothing.
async fn holds_another(state: &AppState, id: &str, member: Option<&str>) -> io::Result<bool> {
    let Some((other, token)) = member.and_then(|m| m.split_once(':')) else {
        return Ok(false);
    };
    if other == id || !valid_hex_id(other) || token.is_empty() || token.len() > 256 {
        return Ok(false);
    }
    let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let slot = state.libraries.slot(other, state.now());
    Ok(header_of(state, &slot, other).await?.is_some_and(|(token_hash, member_hash)| {
        constant_time_eq(member_hash.as_ref().unwrap_or(&token_hash), &hash)
    }))
}

async fn member_wire_minimum(state: &AppState, id: &str, member: Option<&str>) -> io::Result<Option<u64>> {
    let Some((other, _)) = member.and_then(|value| value.split_once(':')) else {
        return Ok(None);
    };
    if !holds_another(state, id, member).await? {
        return Ok(None);
    }
    Ok(Some(protocol_for(state, other).await?.map_or(2, |protocol| protocol.wire_min)))
}

/// Read one bounded log line. Even a corrupt/no-newline log cannot allocate its whole file.
async fn log_read(reader: &mut BufReader<tokio::fs::File>) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    (&mut *reader).take((MAX_LOG_LINE + 1) as u64).read_until(b'\n', &mut line).await?;
    if line.len() > MAX_LOG_LINE {
        return Err(full());
    }
    Ok(line)
}

/// A log's token and member hashes, from its first line. `None` when that line was never finished — an empty
/// log, or a header without its newline: the first write failed or was cut short, and nobody was told it landed.
async fn read_header(
    reader: &mut BufReader<tokio::fs::File>,
) -> io::Result<Option<([u8; 32], Option<[u8; 32]>)>> {
    let first = log_read(reader).await?;
    if !first.ends_with(b"\n") {
        return Ok(None);
    }
    log_header(&first).map(Some)
}

fn log_header(line: &[u8]) -> io::Result<([u8; 32], Option<[u8; 32]>)> {
    let header: Value = serde_json::from_slice(line).map_err(io::Error::other)?;
    let token = header
        .get("token")
        .and_then(Value::as_str)
        .and_then(from_hex32)
        .ok_or_else(|| io::Error::other("unreadable library log header"))?;
    let member = match header.get("member") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .and_then(from_hex32)
                .ok_or_else(|| io::Error::other("unreadable library member hash"))?,
        ),
    };
    Ok((token, member))
}

/// Replay incrementally under the same byte limit as writes. Historical versions are discarded
/// as they are replaced, and other cached libraries leave room before replay begins.
async fn load(
    state: &AppState,
    slot: &Arc<LibrarySlot>,
    loaded: &mut Option<Library>,
    id: &str,
) -> io::Result<()> {
    if loaded.is_some() {
        return Ok(());
    }
    let Some(file) = state.store.open_file(NS, id, EXT).await? else { return Ok(()) };
    // Charge the worst-case library before replay starts. Distinct cold libraries may replay concurrently, but
    // their temporary row maps still fit the same aggregate cap; the reservation shrinks to the exact charge.
    let reserved = state.library_limits.library_bytes;
    let mut reservation = state.libraries.reserve(id, slot, 0, reserved, state.library_limits)?;
    let replayed = replay(state, id, file).await;
    match replayed {
        Ok(Some(library)) => {
            reservation.resize(library.bytes)?;
            *loaded = Some(library);
            reservation.commit();
            Ok(())
        }
        Ok(None) => {
            reservation.resize(0)?;
            reservation.commit();
            Ok(())
        }
        Err(error) => Err(error),
    }
}

async fn replay(state: &AppState, id: &str, file: tokio::fs::File) -> io::Result<Option<Library>> {
    let mut reader = BufReader::new(file);
    let Some((token_hash, member_hash)) = read_header(&mut reader).await? else {
        // Left by a first write that never finished; the library was never started.
        state.store.delete_file(NS, id, EXT).await?;
        return Ok(None);
    };
    let mut lib = Library {
        token_hash,
        member_hash,
        head: 0,
        rows: HashMap::new(),
        sequence: BTreeMap::new(),
        lines: 0,
        bytes: LIBRARY_OVERHEAD,
    };
    let mut repair = false;
    loop {
        let bytes = log_read(&mut reader).await?;
        if bytes.is_empty() {
            break;
        }
        let line = match serde_json::from_slice::<Line>(&bytes) {
            Ok(line) => line,
            Err(_) if !bytes.ends_with(b"\n") => {
                repair = true;
                break;
            }
            Err(e) => match glued(&bytes) {
                Some(line) => {
                    repair = true;
                    line
                }
                None => return Err(io::Error::other(e)),
            },
        };
        if !valid_hex_id(&line.k) || line.v.len() > MAX_VALUE {
            return Err(full());
        }
        let fragment = row_fragment(line.s, &line.k, &line.v);
        let previous = lib.rows.get(&line.k).map_or(0, |r| row_bytes(&line.k, &r.v, r.fragment.len()));
        let needed = lib.bytes - previous + row_bytes(&line.k, &line.v, fragment.len());
        if needed > state.library_limits.library_bytes
            || (!lib.rows.contains_key(&line.k) && lib.rows.len() >= MAX_ROWS)
        {
            return Err(full());
        }
        lib.bytes = needed;
        lib.head = lib.head.max(line.s);
        if let Some(previous) =
            lib.rows.insert(line.k.clone(), Row { seq: line.s, v: Arc::from(line.v), fragment })
        {
            lib.sequence.remove(&previous.seq);
        }
        lib.sequence.insert(line.s, line.k);
        lib.lines += 1;
        repair |= !bytes.ends_with(b"\n");
    }
    if repair {
        compact(state, id, &mut lib).await?;
    }
    Ok(Some(lib))
}

/// The write in a line that begins with the fragment of an append that failed part-way, before appends were cut
/// back on failure: the whole line glued on after it. A line starts `{"s":`, which a value, escaped, cannot hold.
fn glued(bytes: &[u8]) -> Option<Line> {
    const START: &[u8] = br#"{"s":"#;
    let at = bytes.windows(START.len()).rposition(|w| w == START).filter(|&at| at > 0)?;
    serde_json::from_slice(&bytes[at..]).ok()
}

/// Rewrite the log as its header and the live rows, in sequence order.
async fn compact(state: &AppState, id: &str, lib: &mut Library) -> io::Result<()> {
    let mut rows: Vec<(&String, &Row)> = lib.rows.iter().collect();
    rows.sort_by_key(|(_, r)| r.seq);
    let mut out = header_line(&lib.token_hash, lib.member_hash.as_ref());
    for (k, r) in rows {
        out.push_str(&log_line(r.seq, k, &r.v));
    }
    state.store.replace_file(NS, id, EXT, out.as_bytes()).await?;
    lib.lines = lib.rows.len();
    // The rename is on disk only once the directory is synced: until then a power loss could bring back the log
    // this one replaced.
    state.store.sync_dir(NS).await
}

fn header_line(token_hash: &[u8; 32], member_hash: Option<&[u8; 32]>) -> String {
    let mut header = json!({ "token": crate::hex(token_hash) });
    if let Some(member_hash) = member_hash {
        header["member"] = json!(crate::hex(member_hash));
    }
    format!("{}\n", header)
}

fn log_line(seq: u64, k: &str, v: &str) -> String {
    let line = Line { s: seq, k: k.to_owned(), v: v.to_owned() };
    format!("{}\n", serde_json::to_string(&line).expect("a log line always serialises"))
}

/// The batch's writes, or `None` if any is malformed or a key repeats.
fn parse_writes(body: &Value) -> Option<Vec<Write>> {
    let raw = body.get("writes")?.as_array()?;
    if raw.is_empty() || raw.len() > MAX_WRITES {
        return None;
    }
    let mut seen = HashSet::new();
    let mut writes = Vec::with_capacity(raw.len());
    for w in raw {
        let k = w.get("k")?.as_str().filter(|k| valid_hex_id(k))?;
        let base = w.get("base")?.as_u64()?;
        // The largest cap; the library's own minimum is applied with the write (`v3::RedbLibrary::apply_bounded`).
        let v = w.get("v")?.as_str().filter(|v| value_fits(v, 4))?;
        if !seen.insert(k) {
            return None;
        }
        writes.push(Write { k: k.to_owned(), base, v: v.to_owned() });
    }
    Some(writes)
}

/// A library id or record key: hex, as HKDF and HMAC outputs are written.
fn valid_hex_id(s: &str) -> bool {
    (16..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn from_hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::{body_json, Harness};
    use axum::http::StatusCode;
    use serde_json::{json, Value};
    use sha2::Digest;
    use std::collections::HashMap;
    use std::sync::Arc;

    const LIB: &str = "0123456789abcdef0123456789abcdef";
    const LIB2: &str = "fedcba9876543210fedcba9876543210";
    const TOKEN: &str = "the-write-token";
    const K1: &str = "aaaaaaaaaaaaaaaa";
    const K2: &str = "bbbbbbbbbbbbbbbb";

    async fn batch(h: &Harness, token: &str, writes: Value) -> (StatusCode, Value) {
        let body = json!({ "writes": writes }).to_string();
        let resp =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", token)]).await;
        let status = resp.status();
        (status, body_json(resp).await)
    }

    async fn delete(h: &Harness, token: &str) -> StatusCode {
        h.send("DELETE", &format!("/lib/{LIB}"), None, &[("x-den-library-token", token)]).await.status()
    }

    async fn changes(h: &Harness, token: &str, query: &str) -> (StatusCode, Value) {
        let resp = h
            .send("GET", &format!("/lib/{LIB}/changes{query}"), None, &[("x-den-library-token", token)])
            .await;
        let status = resp.status();
        (status, body_json(resp).await)
    }

    #[tokio::test]
    async fn only_the_owner_deletes_a_library_and_its_id_is_then_retired() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        assert_eq!(delete(&h, "someone-else").await, StatusCode::FORBIDDEN);
        assert_eq!(delete(&h, TOKEN).await, StatusCode::OK);
        assert_eq!(changes(&h, TOKEN, "").await, (StatusCode::GONE, json!({ "error": "library_moved" })));
        assert_eq!(
            delete(&h, TOKEN).await,
            StatusCode::GONE,
            "a repeated DELETE learns that the first one landed"
        );

        // Across a restart too: a device still holding the old key can't start the library over.
        let reopened = Harness::in_dir(h.dir.clone());
        let body = json!({ "writes": [{ "k": K2, "base": 0, "v": "n1" }] }).to_string();
        let resp = reopened
            .send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)])
            .await;
        assert_eq!(resp.status(), StatusCode::GONE);
    }

    #[tokio::test]
    async fn a_key_reset_deletes_only_through_the_head_it_copied_and_the_410_names_its_successor() {
        for wire in [None, Some("4")] {
            let h = Harness::new();
            let mut headers = vec![("x-den-library-token", TOKEN), ("x-den-generation", "0")];
            if let Some(wire) = wire {
                headers.extend([("x-den-wire", wire), ("x-den-wire-min", wire)]);
            }
            let body = json!({ "writes": [{ "k": K1, "base": 0, "v": "c1" }] }).to_string();
            let resp = h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &headers).await;
            assert_eq!(resp.status(), StatusCode::OK, "wire {wire:?}");
            let generation = resp.headers()["x-den-generation"].to_str().unwrap().to_owned();

            let ending = |base: &'static str| {
                let (h, generation) = (&h, generation.clone());
                async move {
                    let mut headers = vec![
                        ("x-den-library-token", TOKEN),
                        ("x-den-base", base),
                        ("x-den-successor", LIB2),
                        ("x-den-generation", generation.as_str()),
                    ];
                    if let Some(wire) = wire {
                        headers.push(("x-den-wire", wire));
                    }
                    h.send("DELETE", &format!("/lib/{LIB}"), None, &headers).await
                }
            };
            // A write after the copy: the library stays, to be copied again.
            let refused = ending("0").await;
            assert_eq!(refused.status(), StatusCode::CONFLICT, "wire {wire:?}");
            assert_eq!(body_json(refused).await, json!({ "error": "head_changed" }));
            let kept = h.send("GET", &format!("/lib/{LIB}/changes"), None, &headers).await;
            assert_eq!(kept.status(), StatusCode::OK);

            assert_eq!(ending("1").await.status(), StatusCode::OK, "wire {wire:?}");
            let gone =
                h.send("GET", &format!("/lib/{LIB}/changes"), None, &[("x-den-library-token", TOKEN)]).await;
            assert_eq!(gone.status(), StatusCode::GONE);
            assert_eq!(body_json(gone).await, json!({ "error": "library_moved", "successor": LIB2 }));
            // The same DELETE again — a retry, a proxy's replay — learns that it landed, and for which successor.
            let replayed = ending("1").await;
            assert_eq!(replayed.status(), StatusCode::GONE, "wire {wire:?}");
            assert_eq!(body_json(replayed).await, json!({ "error": "library_moved", "successor": LIB2 }));
        }
    }

    #[tokio::test]
    async fn a_key_reset_delete_with_a_malformed_base_or_successor_is_refused_and_deletes_nothing() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        for (name, value) in [("x-den-base", "one"), ("x-den-successor", "not-hex")] {
            let resp = h
                .send(
                    "DELETE",
                    &format!("/lib/{LIB}"),
                    None,
                    &[("x-den-library-token", TOKEN), (name, value)],
                )
                .await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{name}");
        }
        assert_eq!(changes(&h, TOKEN, "").await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn writes_take_sequence_numbers_and_changes_replay_them_in_order() {
        let h = Harness::new();
        let (status, got) =
            batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }, { "k": K2, "base": 0, "v": "c2" }]))
                .await;
        assert_eq!(status, StatusCode::OK);
        let generation = got["generation"].clone();
        assert_eq!(
            got,
            json!({ "head": 2, "applied": [{ "k": K1, "seq": 1 }, { "k": K2, "seq": 2 }], "conflicts": [],
                    "generation": generation.clone() })
        );
        let (_, all) = changes(&h, TOKEN, "").await;
        assert_eq!(
            all,
            json!({ "entries": [{ "k": K1, "seq": 1, "v": "c1" }, { "k": K2, "seq": 2, "v": "c2" }],
                    "head": 2, "more": false, "generation": generation })
        );
    }

    #[tokio::test]
    async fn prepared_row_fragments_preserve_every_json_escape() {
        let h = Harness::new();
        let value = "quote \" slash \\ controls \n\r\t unicode å日本🎬";
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": value }])).await.0, StatusCode::OK);
        assert_eq!(changes(&h, TOKEN, "").await.1["entries"][0]["v"], value);

        let reopened = Harness::in_dir(h.dir.clone());
        assert_eq!(changes(&reopened, TOKEN, "").await.1["entries"][0]["v"], value);
    }

    #[tokio::test]
    async fn one_library_never_waits_for_another_librarys_work() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "first" }])).await;
        let body = json!({ "writes": [{ "k": K1, "base": 0, "v": "second" }] }).to_string();
        assert_eq!(
            h.send("POST", &format!("/lib/{LIB2}/batch"), Some(body), &[("x-den-library-token", TOKEN)])
                .await
                .status(),
            StatusCode::OK
        );

        let first = h.state.libraries.slot(LIB, h.state.now());
        let held = first.library.lock().await;
        let other_path = format!("/lib/{LIB2}/changes");
        let other = h.send("GET", &other_path, None, &[("x-den-library-token", TOKEN)]);
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), other).await.unwrap().status(),
            StatusCode::OK,
            "a different library does not share the held lock"
        );

        let mut same = Box::pin(changes(&h, TOKEN, ""));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut same).await.is_err(),
            "operations on the same library remain serialized"
        );
        drop(held);
        assert_eq!(same.await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn an_abandoned_cache_reservation_restores_the_exact_charge() {
        let h = Harness::new();
        let before = h.state.libraries.cached_bytes().await;
        let slot = h.state.libraries.slot(LIB, h.state.now());
        let held = slot.library.lock().await;
        {
            let _cancelled = h.state.libraries.reserve(LIB, &slot, 0, 128, h.state.library_limits).unwrap();
            assert_eq!(h.state.libraries.cached_bytes().await, before + 128);
        }
        assert_eq!(h.state.libraries.cached_bytes().await, before);
        drop(held);

        let cold = h.state.libraries.slot(LIB2, h.state.now());
        {
            let _cancelled = h
                .state
                .libraries
                .reserve(LIB2, &cold, 0, h.state.library_limits.library_bytes, h.state.library_limits)
                .unwrap();
            assert_eq!(h.state.libraries.cached_len().await, 1);
        }
        assert_eq!(h.state.libraries.cached_bytes().await, before);
        assert_eq!(h.state.libraries.cached_len().await, 0);
    }

    /// The store's generation survives a restart; a store that comes back without it — restored from a backup,
    /// which leaves the file out, or started over — answers with a new one, a 404 included.
    #[tokio::test]
    async fn a_restored_store_answers_with_a_new_generation() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        let first = changes(&h, TOKEN, "").await.1["generation"].clone();
        assert_eq!(first.as_str().map(str::len), Some(65));

        let restarted = Harness::in_dir(h.dir.clone());
        assert_eq!(changes(&restarted, TOKEN, "").await.1["generation"], first, "a restart keeps it");

        std::fs::remove_file(h.dir.join("generation")).unwrap();
        let restored = Harness::in_dir(h.dir.clone());
        let (_, got) = changes(&restored, TOKEN, "").await;
        assert_ne!(got["generation"], first);
        assert_eq!(got["entries"][0]["v"], "c1", "the data itself is untouched");

        let empty = Harness::new();
        let (status, body) = changes(&empty, TOKEN, "").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["generation"], "0");
    }

    #[tokio::test]
    async fn wire_generation_and_the_rewrite_fence_switch_a_library_atomically() {
        let h = Harness::new();
        let missing =
            h.send("GET", &format!("/lib/{LIB}/changes"), None, &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing.headers()[super::WIRE_MIN_HEADER], "2");
        assert_eq!(missing.headers()[super::GENERATION_HEADER], "0");
        assert_eq!(missing.headers()[axum::http::header::CACHE_CONTROL], "no-store");

        let first_body = json!({ "writes": [{ "k": K1, "base": 0, "v": "old" }] }).to_string();
        let first = h
            .send(
                "POST",
                &format!("/lib/{LIB}/batch"),
                Some(first_body),
                &[
                    ("x-den-library-token", TOKEN),
                    (super::WIRE_HEADER, "3"),
                    (super::GENERATION_HEADER, "0"),
                    (super::WIRE_MIN_HEADER, "2"),
                ],
            )
            .await;
        assert_eq!(first.status(), StatusCode::OK);
        let generation = first.headers()[super::GENERATION_HEADER].to_str().unwrap().to_owned();
        assert_ne!(generation, "0");

        let stale = h
            .send(
                "POST",
                &format!("/lib/{LIB}/batch"),
                Some(json!({ "writes": [{ "k": K2, "base": 0, "v": "stale" }] }).to_string()),
                &[("x-den-library-token", TOKEN), (super::WIRE_HEADER, "3"), (super::GENERATION_HEADER, "0")],
            )
            .await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(stale).await["error"], "generation_changed");

        let opened = h
            .send(
                "POST",
                &format!("/lib/{LIB}/rewrite"),
                None,
                &[
                    ("x-den-library-token", TOKEN),
                    (super::WIRE_HEADER, "3"),
                    (super::GENERATION_HEADER, &generation),
                ],
            )
            .await;
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = body_json(opened).await;
        let rewrite = opened["rewrite"].as_str().unwrap();
        let base = opened["base"].as_u64().unwrap();

        for (method, path) in [
            ("POST", format!("/lib/{LIB}/batch")),
            ("PUT", format!("/lib/{LIB}/member")),
            ("DELETE", format!("/lib/{LIB}")),
        ] {
            let refused = h
                .send(
                    method,
                    &path,
                    Some(json!({ "writes": [{ "k": K2, "base": 0, "v": "blocked" }] }).to_string()),
                    &[
                        ("x-den-library-token", TOKEN),
                        (super::WIRE_HEADER, "3"),
                        (super::GENERATION_HEADER, &generation),
                    ],
                )
                .await;
            assert_eq!(refused.status(), StatusCode::CONFLICT, "{method} {path}");
            assert_eq!(body_json(refused).await["error"], "rewrite_in_progress");
        }

        let staged = h
            .send(
                "POST",
                &format!("/lib/{LIB}/rewrite/{rewrite}/rows"),
                Some(json!({ "writes": [{ "k": K2, "v": "new" }] }).to_string()),
                &[
                    ("x-den-library-token", TOKEN),
                    (super::WIRE_HEADER, "3"),
                    (super::GENERATION_HEADER, &generation),
                ],
            )
            .await;
        assert_eq!(staged.status(), StatusCode::OK);

        let committed = h
            .send(
                "POST",
                &format!("/lib/{LIB}/rewrite/{rewrite}/commit"),
                Some(json!({ "base": base, "wireMin": 3 }).to_string()),
                &[
                    ("x-den-library-token", TOKEN),
                    (super::WIRE_HEADER, "3"),
                    (super::GENERATION_HEADER, &generation),
                ],
            )
            .await;
        assert_eq!(committed.status(), StatusCode::OK);
        assert_eq!(committed.headers()[super::WIRE_MIN_HEADER], "3");
        let next_generation = committed.headers()[super::GENERATION_HEADER].to_str().unwrap().to_owned();
        assert_ne!(next_generation, generation);

        let old_client =
            h.send("GET", &format!("/lib/{LIB}/changes"), None, &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(old_client.status(), StatusCode::UPGRADE_REQUIRED);
        assert_eq!(body_json(old_client).await["error"], "upgrade_required");

        let home = h
            .send(
                "GET",
                &format!("/lib/{LIB}/changes?since=0&limit=1"),
                None,
                &[("x-den-library-token", TOKEN)],
            )
            .await;
        assert_eq!(home.status(), StatusCode::OK);

        let current = h
            .send(
                "GET",
                &format!("/lib/{LIB}/changes"),
                None,
                &[
                    ("x-den-library-token", TOKEN),
                    (super::WIRE_HEADER, "3"),
                    (super::GENERATION_HEADER, &next_generation),
                ],
            )
            .await;
        let current = body_json(current).await;
        assert_eq!(current["entries"], json!([{ "k": K2, "seq": base + 1, "v": "new" }]));
    }

    #[tokio::test]
    async fn a_library_only_restore_changes_generation_and_keeps_the_highest_wire_minimum() {
        let h = Harness::new();
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "before" }])).await.0, StatusCode::OK);
        let database = h.state.library_v3.path(LIB);
        let backup = h.dir.join("library-before-switch.backup");
        std::fs::copy(&database, &backup).unwrap();

        let token_hash: [u8; 32] = sha2::Sha256::digest(TOKEN.as_bytes()).into();
        let store = h.state.library_v3.existing_library(LIB, token_hash).unwrap();
        let before = store.protocol().unwrap();
        let switched = store
            .rewrite(
                before.head,
                &[super::v3::RewriteRow { key: K2.to_owned(), value: "after".to_owned() }],
                3,
                h.state.library_limits.stored_bytes,
            )
            .unwrap();
        drop(store);
        let dir = h.dir.clone();
        drop(h);
        std::fs::copy(&backup, &database).unwrap();

        let restored = Harness::in_dir(dir);
        let response = restored
            .send(
                "GET",
                &format!("/lib/{LIB}/changes"),
                None,
                &[(super::WIRE_HEADER, "3"), ("x-den-library-token", TOKEN)],
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[super::WIRE_MIN_HEADER], "3");
        let generation = response.headers()[super::GENERATION_HEADER].to_str().unwrap();
        assert!(!generation.ends_with(&switched.generation));
        let body = body_json(response).await;
        assert_eq!(body["entries"], json!([{ "k": K1, "seq": 1, "v": "before" }]));
    }

    #[tokio::test]
    async fn rewrite_fences_survive_restart_and_expire_or_abort() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "before" }])).await;
        let opened =
            h.send("POST", &format!("/lib/{LIB}/rewrite"), None, &[("x-den-library-token", TOKEN)]).await;
        let rewrite = body_json(opened).await["rewrite"].as_str().unwrap().to_owned();
        let dir = h.dir.clone();
        drop(h);

        let restarted = Harness::in_dir(dir);
        let blocked = restarted
            .send(
                "POST",
                &format!("/lib/{LIB}/batch"),
                Some(json!({ "writes": [{ "k": K2, "base": 0, "v": "blocked" }] }).to_string()),
                &[("x-den-library-token", TOKEN)],
            )
            .await;
        assert_eq!(blocked.status(), StatusCode::CONFLICT);
        assert!(blocked.headers().contains_key(axum::http::header::RETRY_AFTER));

        let aborted = restarted
            .send("DELETE", &format!("/lib/{LIB}/rewrite/{rewrite}"), None, &[("x-den-library-token", TOKEN)])
            .await;
        assert_eq!(aborted.status(), StatusCode::OK);
        let reopened = restarted
            .send("POST", &format!("/lib/{LIB}/rewrite"), None, &[("x-den-library-token", TOKEN)])
            .await;
        assert_eq!(reopened.status(), StatusCode::OK);
        restarted.advance(super::REWRITE_IDLE_MS);
        let after_timeout = restarted
            .send(
                "POST",
                &format!("/lib/{LIB}/batch"),
                Some(json!({ "writes": [{ "k": K2, "base": 0, "v": "after" }] }).to_string()),
                &[("x-den-library-token", TOKEN)],
            )
            .await;
        assert_eq!(after_timeout.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn only_one_concurrent_rewrite_opens() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "before" }])).await;
        let path = format!("/lib/{LIB}/rewrite");
        let first = h.send("POST", &path, None, &[("x-den-library-token", TOKEN)]);
        let second = h.send("POST", &path, None, &[("x-den-library-token", TOKEN)]);
        let (first, second) = tokio::join!(first, second);
        let mut statuses = [first.status(), second.status()];
        statuses.sort();
        assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    }

    #[tokio::test]
    async fn a_first_batch_inherits_its_members_wire_minimum() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "member" }])).await;
        let token_hash: [u8; 32] = sha2::Sha256::digest(TOKEN.as_bytes()).into();
        let member_store = h.state.library_v3.existing_library(LIB, token_hash).unwrap();
        let protocol = member_store.protocol().unwrap();
        member_store.rewrite(protocol.head, &[], 3, h.state.library_limits.stored_bytes).unwrap();

        let body = json!({ "writes": [{ "k": K2, "base": 0, "v": "new" }] }).to_string();
        let member = format!("{LIB}:{TOKEN}");
        let old = h
            .send(
                "POST",
                &format!("/lib/{LIB2}/batch"),
                Some(body.clone()),
                &[
                    ("x-den-library-token", TOKEN),
                    (super::MEMBER_HEADER, &member),
                    (super::WIRE_HEADER, "2"),
                    (super::GENERATION_HEADER, "0"),
                    (super::WIRE_MIN_HEADER, "2"),
                ],
            )
            .await;
        assert_eq!(old.status(), StatusCode::UPGRADE_REQUIRED);

        let current = h
            .send(
                "POST",
                &format!("/lib/{LIB2}/batch"),
                Some(body),
                &[
                    ("x-den-library-token", TOKEN),
                    (super::MEMBER_HEADER, &member),
                    (super::WIRE_HEADER, "3"),
                    (super::GENERATION_HEADER, "0"),
                    (super::WIRE_MIN_HEADER, "2"),
                ],
            )
            .await;
        assert_eq!(current.status(), StatusCode::OK);
        assert_eq!(current.headers()[super::WIRE_MIN_HEADER], "3");
    }

    /// A request from a client at `wire`, which starts a new library at minimum `wire`.
    async fn wired(
        h: &Harness,
        path: &str,
        wire: &str,
        generation: &str,
        body: Value,
    ) -> axum::response::Response {
        h.send(
            "POST",
            &format!("/lib/{path}"),
            Some(body.to_string()),
            &[
                ("x-den-library-token", TOKEN),
                (super::WIRE_HEADER, wire),
                (super::GENERATION_HEADER, generation),
                (super::WIRE_MIN_HEADER, wire),
            ],
        )
        .await
    }

    fn generation_of(response: &axum::response::Response) -> String {
        response.headers()[super::GENERATION_HEADER].to_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn a_batch_takes_256_kib_at_minimum_4_and_32_kib_below() {
        let h = Harness::new();
        let write = |k: &str, v: String| json!({ "writes": [{ "k": k, "base": 0, "v": v }] });
        let v4 =
            wired(&h, &format!("{LIB}/batch"), "4", "0", write(K1, "a".repeat(super::MAX_VALUE_V4))).await;
        assert_eq!(v4.status(), StatusCode::OK);
        assert_eq!(v4.headers()[super::WIRE_MIN_HEADER], "4");
        let generation = generation_of(&v4);
        let over = write(K2, "a".repeat(super::MAX_VALUE_V4 + 1));
        assert_eq!(
            wired(&h, &format!("{LIB}/batch"), "4", &generation, over).await.status(),
            StatusCode::BAD_REQUEST
        );
        // Measured as stored: under 256 KiB of characters, but each a six-byte escape in the row.
        let escaped = write(K2, "\u{0001}".repeat(super::MAX_VALUE_V4 / 6 + 1));
        assert_eq!(
            wired(&h, &format!("{LIB}/batch"), "4", &generation, escaped).await.status(),
            StatusCode::BAD_REQUEST
        );

        let v3 = wired(&h, &format!("{LIB2}/batch"), "3", "0", write(K1, "a".repeat(super::MAX_VALUE))).await;
        assert_eq!(v3.status(), StatusCode::OK);
        assert_eq!(v3.headers()[super::WIRE_MIN_HEADER], "3");
        let generation = generation_of(&v3);
        for (wire, size) in [("3", super::MAX_VALUE + 1), ("4", super::MAX_VALUE_V4)] {
            let refused =
                wired(&h, &format!("{LIB2}/batch"), wire, &generation, write(K2, "a".repeat(size))).await;
            assert_eq!(refused.status(), StatusCode::BAD_REQUEST, "wire {wire}");
            assert_eq!(body_json(refused).await["error"], "invalid_batch", "wire {wire}");
        }
    }

    #[tokio::test]
    async fn the_store_applies_the_cap_of_the_minimum_a_write_leaves() {
        let h = Harness::new();
        let token_hash: [u8; 32] = sha2::Sha256::digest(TOKEN.as_bytes()).into();
        let cap = h.state.library_limits.stored_bytes;
        let big = |key: &str| super::v3::Write {
            key: key.to_owned(),
            base: 0,
            value: "a".repeat(super::MAX_VALUE_V4),
        };
        let v3 = h.state.library_v3.library(LIB, token_hash).unwrap();
        assert!(matches!(v3.apply_bounded(&[big(K1)], cap, 3), Err(super::v3::StoreError::TooLarge)));
        let small = super::v3::Write { key: K1.to_owned(), base: 0, value: "a".repeat(super::MAX_VALUE) };
        assert_eq!(v3.apply_bounded(&[small], cap, 3).unwrap().applied.len(), 1);
        // A minimum named by a later batch does not apply: only a library's first batch sets it.
        assert!(matches!(v3.apply_bounded(&[big(K2)], cap, 4), Err(super::v3::StoreError::TooLarge)));

        let v4 = h.state.library_v3.library(LIB2, token_hash).unwrap();
        assert_eq!(v4.apply_bounded(&[big(K1)], cap, 4).unwrap().applied.len(), 1);
        assert_eq!(v4.protocol().unwrap().wire_min, 4);
        assert_eq!(v4.apply_bounded(&[big(K2)], cap, 2).unwrap().applied.len(), 1);
    }

    #[tokio::test]
    async fn a_rewrite_stages_256_kib_and_commits_it_only_to_minimum_4() {
        let h = Harness::new();
        let first = wired(
            &h,
            &format!("{LIB}/batch"),
            "3",
            "0",
            json!({ "writes": [{ "k": K1, "base": 0, "v": "v3" }] }),
        )
        .await;
        let generation = generation_of(&first);
        let opened = wired(&h, &format!("{LIB}/rewrite"), "4", &generation, json!({})).await;
        let opened = body_json(opened).await;
        let rewrite = opened["rewrite"].as_str().unwrap().to_owned();
        let base = opened["base"].as_u64().unwrap();
        let rows = format!("{LIB}/rewrite/{rewrite}/rows");
        let stage = |k: &str, size: usize| json!({ "writes": [{ "k": k, "v": "a".repeat(size) }] });
        let over = wired(&h, &rows, "4", &generation, stage(K1, super::MAX_VALUE_V4 + 1)).await;
        assert_eq!(over.status(), StatusCode::BAD_REQUEST);
        let staged = wired(&h, &rows, "4", &generation, stage(K1, super::MAX_VALUE_V4)).await;
        assert_eq!(staged.status(), StatusCode::OK, "staging takes the v4 cap while the library is at 3");
        let commit = format!("{LIB}/rewrite/{rewrite}/commit");

        // Below 4, even a 33 KiB staged row is refused, and the stage stays open to fix or abort.
        assert_eq!(wired(&h, &rows, "4", &generation, stage(K1, 33 * 1024)).await.status(), StatusCode::OK);
        let refused = wired(&h, &commit, "4", &generation, json!({ "base": base, "wireMin": 3 })).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(refused).await, json!({ "error": "value_too_large" }));

        assert_eq!(
            wired(&h, &rows, "4", &generation, stage(K1, super::MAX_VALUE_V4)).await.status(),
            StatusCode::OK
        );
        let committed = wired(&h, &commit, "4", &generation, json!({ "base": base, "wireMin": 4 })).await;
        assert_eq!(committed.status(), StatusCode::OK);
        assert_eq!(committed.headers()[super::WIRE_MIN_HEADER], "4");
        let generation = generation_of(&committed);

        let old = wired(
            &h,
            &format!("{LIB}/batch"),
            "3",
            &generation,
            json!({ "writes": [{ "k": K2, "base": 0, "v": "x" }] }),
        )
        .await;
        assert_eq!(old.status(), StatusCode::UPGRADE_REQUIRED);
        assert_eq!(body_json(old).await, json!({ "error": "upgrade_required", "min": 4 }));
        let (_, page) = changes_at(&h, "4", &generation).await;
        assert_eq!(page["entries"][0]["v"].as_str().unwrap().len(), super::MAX_VALUE_V4);
    }

    #[tokio::test]
    async fn the_store_rewrite_takes_the_cap_of_the_minimum_it_leaves() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "v3" }])).await;
        let token_hash: [u8; 32] = sha2::Sha256::digest(TOKEN.as_bytes()).into();
        let store = h.state.library_v3.existing_library(LIB, token_hash).unwrap();
        let cap = h.state.library_limits.stored_bytes;
        let rows = [super::v3::RewriteRow { key: K2.to_owned(), value: "a".repeat(super::MAX_VALUE_V4) }];
        let head = store.protocol().unwrap().head;
        assert!(matches!(store.rewrite(head, &rows, 3, cap), Err(super::v3::StoreError::TooLarge)));
        assert_eq!(store.rewrite(head, &rows, 4, cap).unwrap().wire_min, 4);
        // At 4 already, a commit naming a lower minimum keeps 4, and its cap.
        let head = store.protocol().unwrap().head;
        assert_eq!(store.rewrite(head, &rows, 3, cap).unwrap().wire_min, 4);
    }

    async fn changes_at(h: &Harness, wire: &str, generation: &str) -> (StatusCode, Value) {
        let response = h
            .send(
                "GET",
                &format!("/lib/{LIB}/changes"),
                None,
                &[
                    ("x-den-library-token", TOKEN),
                    (super::WIRE_HEADER, wire),
                    (super::GENERATION_HEADER, generation),
                ],
            )
            .await;
        (response.status(), body_json(response).await)
    }

    #[tokio::test]
    async fn a_v4_batch_omits_conflict_values_past_its_budget() {
        let h = Harness::new();
        let keys: Vec<String> = (0..super::MAX_ROWS).map(|i| format!("{i:016x}")).collect();
        let mut generation = "0".to_owned();
        for chunk in keys.chunks(4) {
            let writes: Vec<_> = chunk
                .iter()
                .map(|k| json!({ "k": k, "base": 0, "v": "a".repeat(super::MAX_VALUE_V4) }))
                .collect();
            let response =
                wired(&h, &format!("{LIB}/batch"), "4", &generation, json!({ "writes": writes })).await;
            assert_eq!(response.status(), StatusCode::OK);
            generation = generation_of(&response);
        }
        let stale: Vec<_> = keys.iter().map(|k| json!({ "k": k, "base": 0, "v": "rival" })).collect();
        let response = wired(&h, &format!("{LIB}/batch"), "4", &generation, json!({ "writes": stale })).await;
        assert_eq!(response.status(), StatusCode::OK);
        let conflicts = body_json(response).await["conflicts"].as_array().unwrap().clone();
        let fits = super::MAX_CONFLICT_BYTES / super::MAX_VALUE_V4;
        assert_eq!(conflicts.len(), keys.len());
        for (i, conflict) in conflicts.iter().enumerate() {
            assert_eq!(conflict["k"], keys[i]);
            assert_eq!(conflict["seq"], i as u64 + 1);
            if i < fits {
                assert_eq!(conflict["v"].as_str().unwrap().len(), super::MAX_VALUE_V4);
            } else {
                assert_eq!(conflict, &json!({ "k": keys[i], "seq": i as u64 + 1, "omitted": true }));
            }
        }
    }

    /// A write based on a stale sequence gets the current row back; one based on the current one lands.
    #[tokio::test]
    async fn a_stale_base_is_a_conflict_with_the_current_row() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "first" }])).await;
        let (_, got) =
            batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "rival" }, { "k": K2, "base": 5, "v": "x" }]))
                .await;
        assert_eq!(got["applied"], json!([]));
        assert_eq!(
            got["conflicts"],
            json!([{ "k": K1, "seq": 1, "v": "first" }, { "k": K2, "seq": 0, "v": null }])
        );
        let (_, got) = batch(&h, TOKEN, json!([{ "k": K1, "base": 1, "v": "merged" }])).await;
        assert_eq!(got["applied"], json!([{ "k": K1, "seq": 2 }]));
        let (_, since) = changes(&h, TOKEN, "?since=1").await;
        assert_eq!(
            since["entries"],
            json!([{ "k": K1, "seq": 2, "v": "merged" }]),
            "only what changed after 1"
        );
    }

    #[tokio::test]
    async fn applied_and_stale_writes_are_counted_for_metrics() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "a" }, { "k": K2, "base": 0, "v": "b" }])).await;
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "stale" }])).await;
        let text = h.state.metrics.render();
        assert!(text.contains(r#"den_edge_library_writes_total{outcome="applied"} 2"#), "{text}");
        assert!(text.contains(r#"den_edge_library_writes_total{outcome="conflict"} 1"#), "{text}");
    }

    #[tokio::test]
    async fn changes_page_by_limit() {
        let h = Harness::new();
        let writes: Vec<Value> =
            (0..5).map(|i| json!({ "k": format!("{i:016x}"), "base": 0, "v": "v" })).collect();
        batch(&h, TOKEN, json!(writes)).await;
        let (_, page) = changes(&h, TOKEN, "?limit=2").await;
        assert_eq!((page["entries"].as_array().unwrap().len(), page["more"].clone()), (2, json!(true)));
        let (_, rest) = changes(&h, TOKEN, "?since=2&limit=10").await;
        assert_eq!((rest["entries"].as_array().unwrap().len(), rest["more"].clone()), (3, json!(false)));
    }

    #[tokio::test]
    async fn the_first_write_sets_the_token_and_every_request_must_match_it() {
        let h = Harness::new();
        assert_eq!(changes(&h, TOKEN, "").await.0, StatusCode::NOT_FOUND, "nobody has written it");
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c" }])).await;
        assert_eq!(
            batch(&h, "someone-else", json!([{ "k": K2, "base": 0, "v": "c" }])).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(changes(&h, "someone-else", "").await.0, StatusCode::FORBIDDEN);
        let no_token = h.send("GET", &format!("/lib/{LIB}/changes"), None, &[]).await;
        assert_eq!(no_token.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(changes(&h, TOKEN, "").await.1["head"], 1, "the refused write changed nothing");
    }

    #[tokio::test]
    async fn registering_a_member_proof_replaces_the_legacy_write_proof_and_survives_restart() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c" }])).await;
        assert!(super::is_member(&h.state, Some(&format!("{LIB}:{TOKEN}"))).await);

        let member = "the-member-proof";
        let claim = format!("{LIB}:{member}");
        let registered = h
            .send(
                "PUT",
                &format!("/lib/{LIB}/member"),
                None,
                &[("x-den-library-token", TOKEN), ("x-den-library-member", &claim)],
            )
            .await;
        assert_eq!(registered.status(), StatusCode::OK);
        assert!(!super::is_member(&h.state, Some(&format!("{LIB}:{TOKEN}"))).await);
        assert!(super::is_member(&h.state, Some(&claim)).await);

        let restarted = Harness::in_dir(h.dir.clone());
        assert!(super::is_member(&restarted.state, Some(&claim)).await);
        assert!(!super::is_member(&restarted.state, Some(&format!("{LIB}:{TOKEN}"))).await);
        assert!(
            restarted.state.libraries.cached_len().await == 0,
            "a member check reads the header, and loads no library"
        );
        let replaced = restarted
            .send(
                "PUT",
                &format!("/lib/{LIB}/member"),
                None,
                &[("x-den-library-token", TOKEN), ("x-den-library-member", &format!("{LIB}:other"))],
            )
            .await;
        assert_eq!(replaced.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn malformed_batches_and_ids_are_refused() {
        let h = Harness::new();
        for writes in [
            json!([]),
            json!([{ "k": K1, "base": 0, "v": "a" }, { "k": K1, "base": 0, "v": "b" }]),
            json!([{ "k": "not hex", "base": 0, "v": "a" }]),
            json!([{ "k": K1, "base": -1, "v": "a" }]),
            json!([{ "k": K1, "base": 0, "v": "x".repeat(super::MAX_VALUE + 1) }]),
            json!((0..=super::MAX_WRITES)
                .map(|i| json!({ "k": format!("{i:016x}"), "base": 0, "v": "v" }))
                .collect::<Vec<_>>()),
        ] {
            assert_eq!(batch(&h, TOKEN, writes).await.0, StatusCode::BAD_REQUEST);
        }
        let bad_id = h.send("GET", "/lib/nope/changes", None, &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(bad_id.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            h.send("GET", &format!("/lib/{LIB}/batch"), None, &[]).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            changes(&h, TOKEN, "").await.0,
            StatusCode::NOT_FOUND,
            "no refused batch created the library"
        );
    }

    #[tokio::test]
    async fn the_v3_authority_survives_a_restart_without_superseded_rows() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K2, "base": 0, "v": "kept" }])).await;
        let mut base = 0;
        for i in 0..40 {
            let (_, got) = batch(&h, TOKEN, json!([{ "k": K1, "base": base, "v": format!("v{i}") }])).await;
            base = got["applied"][0]["seq"].as_u64().expect("each rewrite is based on the last");
        }
        assert!(h.state.library_v3.path(LIB).exists());
        assert_eq!(
            h.state
                .library_v3
                .library(LIB, sha2::Sha256::digest(TOKEN.as_bytes()).into())
                .unwrap()
                .range(0, 500)
                .unwrap()
                .entries
                .len(),
            2,
            "only the two current rows are authoritative"
        );

        let restarted = Harness::in_dir(h.dir.clone());
        let (_, all) = changes(&restarted, TOKEN, "").await;
        assert_eq!(
            all["entries"],
            json!([{ "k": K2, "seq": 1, "v": "kept" }, { "k": K1, "seq": 41, "v": "v39" }])
        );
        assert_eq!(all["head"], 41);
    }

    #[tokio::test]
    async fn every_unpublished_migration_prefix_keeps_v2_authoritative() {
        let fixture = Harness::new();
        write_legacy(&fixture, &[(1, K1, "old")]);
        let temporary = fixture.state.library_v3.path(LIB).with_extension("redb.tmp");
        std::fs::write(&temporary, b"abandoned-before-publish").unwrap();
        let first = Harness::in_dir(fixture.dir.clone());
        assert_eq!(changes(&first, TOKEN, "").await.1["entries"][0]["v"], "old");
        assert!(!temporary.exists(), "the abandoned temporary database was removed");

        // Database rename completed but the marker did not: the stale v2 log must win and deterministically
        // rebuild the database, never dual-read its head.
        first.state.store.delete_file(super::NS, LIB, super::FORMAT_EXT).await.unwrap();
        drop(first);
        let second = Harness::in_dir(fixture.dir.clone());
        assert_eq!(changes(&second, TOKEN, "").await.1["entries"][0]["v"], "old");
        assert_eq!(
            second.state.store.get_file(super::NS, LIB, super::FORMAT_EXT).await.unwrap(),
            Some(super::FORMAT_V3.to_vec())
        );
    }

    #[tokio::test]
    async fn a_published_or_unknown_marker_never_falls_back_to_the_v2_log() {
        let h = Harness::new();
        write_legacy(&h, &[(1, K1, "old")]);
        h.state.store.replace_file(super::NS, LIB, super::FORMAT_EXT, b"99\n").await.unwrap();
        h.state.store.sync_dir(super::NS).await.unwrap();
        assert_eq!(changes(&h, TOKEN, "").await.0, StatusCode::INTERNAL_SERVER_ERROR);

        h.state.store.replace_file(super::NS, LIB, super::FORMAT_EXT, super::FORMAT_V3).await.unwrap();
        h.state.store.sync_dir(super::NS).await.unwrap();
        assert!(!h.state.library_v3.path(LIB).exists());
        assert_eq!(changes(&h, TOKEN, "").await.0, StatusCode::INTERNAL_SERVER_ERROR);

        h.state.store.delete_file(super::NS, LIB, super::FORMAT_EXT).await.unwrap();
        let restarted = Harness::in_dir(h.dir.clone());
        assert_eq!(changes(&restarted, TOKEN, "").await.1["entries"][0]["v"], "old");
    }

    #[tokio::test]
    async fn a_published_retirement_beats_a_leftover_v3_marker_and_database() {
        let h = Harness::new();
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "old" }])).await.0, StatusCode::OK);
        h.state.store.replace_file(super::NS, LIB, super::MOVED, b"").await.unwrap();
        h.state.store.sync_dir(super::NS).await.unwrap();
        let restarted = Harness::in_dir(h.dir.clone());
        assert_eq!(changes(&restarted, TOKEN, "").await.0, StatusCode::GONE);
        assert_eq!(
            batch(&restarted, TOKEN, json!([{ "k": K1, "base": 1, "v": "new" }])).await.0,
            StatusCode::GONE
        );
    }

    #[tokio::test]
    async fn the_v2_log_is_kept_for_thirty_days_after_the_switch_and_then_removed() {
        let h = Harness::new();
        write_legacy(&h, &[(1, K1, "old")]);
        h.advance(super::V2_LOG_GRACE_MS + 1);
        super::retire_v2_log(&h.state, LIB).await.unwrap();
        assert!(log_path(&h).exists(), "without a v3 marker the log is the library");

        // A write migrates the library and publishes the marker beside the old log.
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K1, "base": 1, "v": "two" }])).await.0, StatusCode::OK);
        assert!(log_path(&h).exists());
        let marker =
            h.dir.join("lib").join(format!("{}.format", crate::hex(&sha2::Sha256::digest(LIB.as_bytes()))));
        let switched = std::time::UNIX_EPOCH + std::time::Duration::from_millis(h.state.now());
        std::fs::File::options().write(true).open(marker).unwrap().set_modified(switched).unwrap();

        h.advance(super::V2_LOG_GRACE_MS - 1);
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K1, "base": 2, "v": "three" }])).await.0, StatusCode::OK);
        assert!(log_path(&h).exists(), "kept for the whole grace period");
        h.advance(1);
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K1, "base": 3, "v": "four" }])).await.0, StatusCode::OK);
        assert!(!log_path(&h).exists(), "removed once it has passed");

        let restarted = Harness::in_dir(h.dir.clone());
        assert_eq!(
            changes(&restarted, TOKEN, "").await.1["entries"],
            json!([{ "k": K1, "seq": 4, "v": "four" }])
        );
    }

    #[tokio::test]
    async fn compaction_waits_out_a_staged_rewrite_and_follows_the_next_write() {
        let h = Harness::new();
        let token_hash: [u8; 32] = sha2::Sha256::digest(TOKEN.as_bytes()).into();
        let mut library = super::Library {
            token_hash,
            member_hash: None,
            head: 0,
            rows: HashMap::new(),
            sequence: std::collections::BTreeMap::new(),
            lines: 0,
            bytes: 0,
        };
        for number in 0..2000u64 {
            let key = format!("{number:016x}");
            let value: Arc<str> = Arc::from("s".repeat(4000));
            library.head += 1;
            let fragment = super::row_fragment(library.head, &key, &value);
            library.rows.insert(key, super::Row { seq: library.head, v: value, fragment });
        }
        h.state.library_v3.import_v2(LIB, &library).unwrap();
        h.state.store.replace_file(super::NS, LIB, super::FORMAT_EXT, super::FORMAT_V3).await.unwrap();
        let store = h.state.library_v3.existing_library(LIB, token_hash).unwrap();
        let kept = [super::v3::RewriteRow { key: K1.to_owned(), value: "kept".to_owned() }];
        store.rewrite(library.head, &kept, 2, h.state.library_limits.stored_bytes).unwrap();
        let path = h.state.library_v3.path(LIB);
        let sparse = std::fs::metadata(&path).unwrap().len();

        let opened =
            h.send("POST", &format!("/lib/{LIB}/rewrite"), None, &[("x-den-library-token", TOKEN)]).await;
        let rewrite = body_json(opened).await["rewrite"].as_str().unwrap().to_owned();
        super::maintain_v3(&h.state, LIB, Arc::clone(&store)).await;
        assert_eq!(std::fs::metadata(&path).unwrap().len(), sparse, "not under a staged rewrite");

        let aborted = h
            .send("DELETE", &format!("/lib/{LIB}/rewrite/{rewrite}"), None, &[("x-den-library-token", TOKEN)])
            .await;
        assert_eq!(aborted.status(), StatusCode::OK);
        let head = library.head + 1;
        assert_eq!(
            batch(&h, TOKEN, json!([{ "k": K1, "base": head, "v": "after" }])).await.0,
            StatusCode::OK
        );
        let compacted = std::fs::metadata(&path).unwrap().len();
        assert!(compacted < sparse / 4, "{sparse} -> {compacted}");
        assert_eq!(
            changes(&h, TOKEN, "").await.1["entries"],
            json!([{ "k": K1, "seq": head + 1, "v": "after" }])
        );
    }

    async fn start(h: &Harness, id: &str, token: &str, member: Option<&str>) -> StatusCode {
        let body = json!({ "writes": [{ "k": K1, "base": 0, "v": "v" }] }).to_string();
        let mut headers = vec![("x-den-library-token", token)];
        if let Some(member) = member {
            headers.push(("x-den-library-member", member));
        }
        h.send("POST", &format!("/lib/{id}/batch"), Some(body), &headers).await.status()
    }

    /// With `NEW_LIBRARIES=members` only a device holding another library here starts one — a TV moving its library
    /// to a new key — and a library that exists takes writes as before.
    #[tokio::test]
    async fn with_members_only_a_holder_of_another_library_starts_one() {
        let other = "fedcba9876543210fedcba9876543210";
        let open = Harness::new();
        assert_eq!(start(&open, LIB, TOKEN, None).await, StatusCode::OK, "open by default");

        let h = Harness::in_dir_with(open.dir.clone(), |s| s.new_libraries = super::NewLibraries::Members);
        assert_eq!(start(&h, other, "stranger", None).await, StatusCode::FORBIDDEN);
        assert_eq!(
            start(&h, other, "stranger", Some(&format!("{LIB}:not-its-token"))).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            start(&h, other, "new", Some(&format!("{other}:new"))).await,
            StatusCode::FORBIDDEN,
            "not itself"
        );
        assert_eq!(changes(&h, TOKEN, "").await.1["head"], 1, "the refusals left the member library alone");

        assert_eq!(start(&h, other, "new", Some(&format!("{LIB}:{TOKEN}"))).await, StatusCode::OK);
        assert_eq!(start(&h, other, "new", None).await, StatusCode::OK, "once it exists, no proof");
        assert_eq!(start(&h, LIB, TOKEN, None).await, StatusCode::OK, "nor for a library that already was");
    }

    /// Anyone may start a library while `NEW_LIBRARIES=open`, and a library is new storage: an address starts a few a
    /// minute at most. A library already started takes its writes as before.
    #[tokio::test]
    async fn starting_libraries_is_limited_per_address() {
        let h = Harness::new();
        let id = |n: u32| format!("{n:032x}");
        for n in 0..super::NEW_PER_WINDOW {
            assert_eq!(start(&h, &id(n), TOKEN, None).await, StatusCode::OK, "{n}");
        }
        let body = json!({ "writes": [{ "k": K1, "base": 0, "v": "v" }] }).to_string();
        let over = h
            .send("POST", &format!("/lib/{}/batch", id(99)), Some(body), &[("x-den-library-token", TOKEN)])
            .await;
        assert_eq!(over.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(over.headers().contains_key("retry-after"));
        assert_eq!(
            start(&h, &id(0), TOKEN, None).await,
            StatusCode::OK,
            "an existing library still takes writes"
        );
        h.advance(60_000);
        assert_eq!(start(&h, &id(99), TOKEN, None).await, StatusCode::OK, "the window clears");
    }

    /// A library has a row cap; rewriting a row it already holds is always fine.
    #[tokio::test]
    async fn a_full_library_takes_no_new_rows() {
        let h = Harness::new();
        let writes: Vec<Value> =
            (0..super::MAX_ROWS).map(|i| json!({ "k": format!("{i:016x}"), "base": 0, "v": "v" })).collect();
        assert_eq!(batch(&h, TOKEN, json!(writes)).await.0, StatusCode::OK);
        let (status, body) =
            batch(&h, TOKEN, json!([{ "k": "ffffffffffffffff", "base": 0, "v": "v" }])).await;
        assert_eq!((status, body), (StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "library_full" })));
        assert_eq!(
            batch(&h, TOKEN, json!([{ "k": format!("{:016x}", 0), "base": 1, "v": "w" }])).await.0,
            StatusCode::OK
        );
    }

    /// A library idle for an hour leaves memory, and comes back from its log when asked for.
    #[tokio::test]
    async fn an_idle_library_leaves_memory_and_comes_back() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "kept" }])).await;
        h.advance(super::IDLE_MS + 1);
        let other = "fedcba9876543210fedcba9876543210";
        let body = json!({ "writes": [{ "k": K2, "base": 0, "v": "x" }] }).to_string();
        h.send("POST", &format!("/lib/{other}/batch"), Some(body), &[("x-den-library-token", "other")]).await;
        assert_eq!(h.state.libraries.cached_len().await, 0, "v3 retains no replayed row map");
        assert_eq!(changes(&h, TOKEN, "").await.1["entries"][0]["v"], "kept");
    }

    #[tokio::test]
    async fn an_active_v3_slot_keeps_its_cached_authority_without_a_legacy_row_map() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "kept" }])).await;
        let first = h.state.libraries.slot(LIB, h.state.now());
        assert_eq!(first.authority.load(super::Ordering::Acquire), super::AUTHORITY_V3);
        drop(first);
        let second = h.state.libraries.slot(LIB, h.state.now());
        drop(second);
        let third = h.state.libraries.slot(LIB, h.state.now());
        assert_eq!(third.authority.load(super::Ordering::Acquire), super::AUTHORITY_V3);
        assert_eq!(h.state.libraries.cached_len().await, 0, "v3 retains no replayed rows");
    }

    #[tokio::test]
    async fn v3_authority_slots_have_a_hard_cardinality_bound() {
        let h = Harness::new();
        for number in 0..(super::MAX_CACHED_LIBRARIES * 2) {
            let slot = h.state.libraries.slot(&format!("{number:016x}"), number as u64);
            slot.authority.store(super::AUTHORITY_V3, super::Ordering::Release);
        }
        assert_eq!(h.state.libraries.registry.lock().unwrap().slots.len(), super::MAX_CACHED_LIBRARIES);
    }

    /// A crash mid-append leaves the last line cut short. It is dropped, and the next write is not fused
    /// onto it.
    #[tokio::test]
    async fn a_torn_last_line_is_dropped_and_the_log_stays_readable() {
        let h = Harness::new();
        write_legacy(&h, &[(1, K1, "whole")]);
        let log = log_path(&h);
        let mut text = std::fs::read_to_string(&log).unwrap();
        text.push_str(r#"{"s":2,"k":"bbbbbbbbbbbbbbbb","v":"torn"#);
        std::fs::write(&log, text).unwrap();

        let restarted = Harness::in_dir(h.dir.clone());
        assert_eq!(changes(&restarted, TOKEN, "").await.1["head"], 1);
        batch(&restarted, TOKEN, json!([{ "k": K2, "base": 0, "v": "after" }])).await;
        let again = Harness::in_dir(h.dir.clone());
        let (_, all) = changes(&again, TOKEN, "").await;
        assert_eq!(
            all["entries"],
            json!([{ "k": K1, "seq": 1, "v": "whole" }, { "k": K2, "seq": 2, "v": "after" }])
        );
    }

    fn log_path(h: &Harness) -> std::path::PathBuf {
        h.dir.join("lib").join(format!("{}.log", crate::hex(&sha2::Sha256::digest(LIB.as_bytes()))))
    }

    fn write_legacy(h: &Harness, rows: &[(u64, &str, &str)]) {
        let token_hash: [u8; 32] = sha2::Sha256::digest(TOKEN.as_bytes()).into();
        let mut log = super::header_line(&token_hash, None);
        for (sequence, key, value) in rows {
            log.push_str(&super::log_line(*sequence, key, value));
        }
        std::fs::write(log_path(h), log).unwrap();
    }

    /// An append that failed part-way left its first bytes behind, and the next write was glued onto them: a
    /// line ending in a newline that is no JSON. The glued write is kept; the fragment, which nobody was told
    /// landed, is not.
    #[tokio::test]
    async fn a_fragment_a_failed_append_left_mid_log_is_dropped_on_load() {
        let h = Harness::new();
        write_legacy(&h, &[(1, K1, "whole")]);
        let mut text = std::fs::read_to_string(log_path(&h)).unwrap();
        text.push_str(r#"{"s":2,"k":"bbbbbbbbbbbbbbbb","v":"fail"#);
        text.push_str(&super::log_line(2, K2, "glued"));
        text.push_str(&super::log_line(3, K1, "after"));
        std::fs::write(log_path(&h), text).unwrap();

        let restarted = Harness::in_dir(h.dir.clone());
        let (status, all) = changes(&restarted, TOKEN, "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            all["entries"],
            json!([{ "k": K2, "seq": 2, "v": "glued" }, { "k": K1, "seq": 3, "v": "after" }])
        );
        let again = Harness::in_dir(h.dir.clone());
        assert_eq!(changes(&again, TOKEN, "").await.1["head"], 3, "the log was rewritten whole");
    }

    /// A first write that never finished leaves an empty log or a torn header. Nobody was told it landed, so the
    /// library does not exist: it can be started again, and nothing answers 500.
    #[tokio::test]
    async fn an_empty_or_torn_header_is_a_library_that_was_never_started() {
        for leftover in ["", r#"{"token":"01"#] {
            let h = Harness::new();
            std::fs::write(log_path(&h), leftover).unwrap();
            assert_eq!(changes(&h, TOKEN, "").await.0, StatusCode::NOT_FOUND, "{leftover:?}");
            assert_eq!(delete(&h, TOKEN).await, StatusCode::NOT_FOUND, "{leftover:?}");
            let fresh = Harness::in_dir(h.dir.clone());
            assert_eq!(delete(&fresh, TOKEN).await, StatusCode::NOT_FOUND, "{leftover:?}");
            assert_eq!(
                batch(&fresh, TOKEN, json!([{ "k": K1, "base": 0, "v": "v" }])).await.0,
                StatusCode::OK
            );
            let restarted = Harness::in_dir(h.dir.clone());
            assert_eq!(changes(&restarted, TOKEN, "").await.1["head"], 1, "{leftover:?}");
        }
    }

    fn bounded(h: &Harness, library_bytes: usize, cache_bytes: usize) -> Harness {
        Harness::in_dir_with(h.dir.clone(), |state| {
            state.library_limits = super::Limits { library_bytes, cache_bytes, stored_bytes: library_bytes };
        })
    }

    #[tokio::test]
    async fn byte_limit_refuses_growth_atomically_but_allows_shrinking_and_reload() {
        let root = Harness::new();
        let h = bounded(&root, 1900, 3800);
        let two = json!([{ "k": K1, "base": 0, "v": "x".repeat(800) },
            { "k": K2, "base": 0, "v": "y".repeat(800) }]);
        assert_eq!(batch(&h, TOKEN, two).await.0, StatusCode::OK);
        let third = "cccccccccccccccc";
        let denied = batch(&h, TOKEN, json!([{ "k": third, "base": 0, "v": "z".repeat(800) }])).await;
        assert_eq!(denied, (StatusCode::PAYLOAD_TOO_LARGE, json!({"error":"library_full"})));
        assert_eq!(changes(&h, TOKEN, "").await.1["head"], 2);
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K1, "base": 1, "v": "" }])).await.0, StatusCode::OK);
        assert_eq!(
            batch(&h, TOKEN, json!([{ "k": third, "base": 0, "v": "z".repeat(800) }])).await.0,
            StatusCode::OK
        );
        let reopened = bounded(&root, 1900, 3800);
        assert_eq!(changes(&reopened, TOKEN, "").await.1["head"], 4);
    }

    /// A v3 library lives in its file: what it may hold is `stored_bytes` of keys and values, not the legacy
    /// in-memory `library_bytes` or its `2(k + v) + fragment + 192` charge, which overstated a library ~3×.
    #[tokio::test]
    async fn a_v3_library_is_full_at_stored_bytes_of_its_keys_and_values() {
        let root = Harness::new();
        let h = Harness::in_dir_with(root.dir.clone(), |state| {
            state.library_limits =
                super::Limits { library_bytes: 1900, cache_bytes: 3800, stored_bytes: 5000 };
        });
        let writes = |v: char| {
            json!([{ "k": K1, "base": 0, "v": v.to_string().repeat(100) },
                { "k": K2, "base": 0, "v": v.to_string().repeat(100) },
                { "k": "cccccccccccccccc", "base": 0, "v": v.to_string().repeat(100) }])
        };
        // Three rows of 116 stored bytes each; the legacy charge, ~560 each plus 512, was already past 1,900.
        assert_eq!(batch(&h, TOKEN, writes('x')).await.0, StatusCode::OK);
        let fourth = |length: usize| json!([{ "k": "dddddddddddddddd", "base": 0, "v": "w".repeat(length) }]);
        let room = 5000 - 3 * 116 - 16;
        assert_eq!(
            batch(&h, TOKEN, fourth(room + 1)).await,
            (StatusCode::PAYLOAD_TOO_LARGE, json!({"error":"library_full"}))
        );
        assert_eq!(batch(&h, TOKEN, fourth(room)).await.0, StatusCode::OK, "exactly at the cap");
    }

    #[tokio::test]
    async fn cached_libraries_are_evicted_by_bytes_and_reload_with_their_auth_intact() {
        let root = Harness::new();
        let h = bounded(&root, 1200, 2000);
        for n in 0..4 {
            let id = format!("{n:016x}");
            let body = json!({ "writes": [{ "k": K1, "base": 0, "v": "x".repeat(100) }] });
            assert_eq!(
                h.send(
                    "POST",
                    &format!("/lib/{id}/batch"),
                    Some(body.to_string()),
                    &[("x-den-library-token", TOKEN)]
                )
                .await
                .status(),
                StatusCode::OK
            );
            assert!(h.state.libraries.cached_bytes().await <= 2000);
        }
        assert!(h.state.libraries.cached_len().await < 4);
        let path = "/lib/0000000000000000/changes";
        assert_eq!(
            h.send("GET", path, None, &[("x-den-library-token", "wrong")]).await.status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            body_json(h.send("GET", path, None, &[("x-den-library-token", TOKEN)]).await).await["entries"][0]
                ["v"],
            "x".repeat(100)
        );
    }

    #[tokio::test]
    async fn oversized_legacy_logs_are_not_loaded_or_modified_and_the_owner_can_delete_them() {
        let root = Harness::new();
        let large = "x".repeat(1024);
        write_legacy(&root, &[(1, K1, &large)]);
        let original = root.state.store.get_file(super::NS, LIB, super::EXT).await.unwrap();
        let h = bounded(&root, 1024, 2048);
        assert_eq!(changes(&h, TOKEN, "").await.0, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(h.state.libraries.cached_len().await, 0);
        assert_eq!(h.state.store.get_file(super::NS, LIB, super::EXT).await.unwrap(), original);
        assert_eq!(delete(&h, "wrong").await, StatusCode::FORBIDDEN);
        assert_eq!(delete(&h, TOKEN).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn ordinary_encrypted_values_use_the_page_budget() {
        let h = Harness::new();
        let writes: Vec<_> =
            (0..8).map(|i| json!({"k":format!("{i:016x}"),"base":0,"v":"x".repeat(16 * 1024)})).collect();
        assert_eq!(batch(&h, TOKEN, json!(writes)).await.0, StatusCode::OK);
        let (_, page) = changes(&h, TOKEN, "?limit=1000").await;
        assert_eq!(page["entries"].as_array().unwrap().len(), 8);
        assert_eq!(page["more"], false);
        assert!(serde_json::to_vec(&page).unwrap().len() <= super::PAGE_BYTES);
    }

    #[tokio::test]
    async fn a_sync_page_is_gzipped_only_for_a_client_that_takes_it() {
        let h = Harness::new();
        let writes: Vec<_> =
            (0..8).map(|i| json!({"k":format!("{i:016x}"),"base":0,"v":"x".repeat(1024)})).collect();
        assert_eq!(batch(&h, TOKEN, json!(writes)).await.0, StatusCode::OK);
        let path = format!("/lib/{LIB}/changes");
        let ask = |encoding: &'static str| {
            let (h, path) = (&h, &path);
            async move {
                h.send("GET", path, None, &[("x-den-library-token", TOKEN), ("accept-encoding", encoding)])
                    .await
            }
        };
        let plain = ask("identity").await;
        assert!(!plain.headers().contains_key("content-encoding"));
        let plain = body_json(plain).await;

        let zipped = ask("br, gzip").await;
        assert_eq!(zipped.headers()["content-encoding"], "gzip");
        assert_eq!(zipped.headers()["cache-control"], "no-store");
        let bytes = axum::body::to_bytes(zipped.into_body(), usize::MAX).await.unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&bytes[..]), &mut text).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), plain);
        assert!(bytes.len() < text.len() / 4, "{} of {}", bytes.len(), text.len());

        let held = std::sync::Arc::clone(&h.state.library_compression_slots)
            .acquire_many_owned(super::COMPRESSION_JOBS as u32)
            .await
            .unwrap();
        let busy = ask("gzip").await;
        assert!(!busy.headers().contains_key("content-encoding"), "busy compression falls back to identity");
        assert_eq!(body_json(busy).await, plain);
        drop(held);

        assert!(!ask("gzip;q=0").await.headers().contains_key("content-encoding"));
        let metrics = h.state.metrics.render();
        assert!(metrics.contains(r#"den_edge_compression_active 0"#), "{metrics}");
        assert!(
            metrics.contains(r#"den_edge_compression_jobs_total{kind="library_gzip",outcome="success"} 1"#)
        );
        assert!(metrics.contains(r#"den_edge_compression_jobs_total{kind="library_gzip",outcome="busy"} 1"#));
        assert!(!metrics.contains(r#"den_edge_compression_input_bytes_total{kind="library_gzip"} 0"#));
        assert!(!metrics.contains(r#"den_edge_compression_output_bytes_total{kind="library_gzip"} 0"#));
    }

    #[tokio::test]
    async fn a_slow_changes_body_holds_and_releases_its_exact_response_admission() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "kept" }])).await;
        let before = h.state.library_response_bytes.available_permits();
        let response = h
            .send(
                "GET",
                &format!("/lib/{LIB}/changes"),
                None,
                &[("x-den-library-token", TOKEN), ("accept-encoding", "identity")],
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(h.state.library_response_bytes.available_permits(), before - super::PAGE_BYTES);
        drop(response);
        assert_eq!(h.state.library_response_bytes.available_permits(), before);
    }

    #[tokio::test]
    async fn changes_page_by_bytes_without_skipping_rows() {
        let h = Harness::new();
        let writes: Vec<_> = (0..8)
            .map(|i| json!({"k":format!("{i:016x}"),"base":0,"v":"\u{0001}".repeat(super::MAX_VALUE)}))
            .collect();
        assert_eq!(batch(&h, TOKEN, json!(writes)).await.0, StatusCode::OK);
        let mut since = 0;
        let mut count = 0;
        loop {
            let (_, page) = changes(&h, TOKEN, &format!("?since={since}&limit=1000")).await;
            let entries = page["entries"].as_array().unwrap();
            assert!(entries.len() < 8);
            assert!(serde_json::to_vec(&page).unwrap().len() <= super::PAGE_BYTES);
            assert!(!entries.is_empty());
            count += entries.len();
            since = entries.last().unwrap()["seq"].as_u64().unwrap();
            if page["more"] == false {
                break;
            }
        }
        assert_eq!(count, 8);
    }

    const SHORT: std::time::Duration = std::time::Duration::from_millis(200);
    const PROMPT: std::time::Duration = std::time::Duration::from_secs(2);

    #[tokio::test]
    async fn a_held_request_answers_as_soon_as_another_client_writes() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        let mut held = Box::pin(changes(&h, TOKEN, "?since=1&wait=20"));
        assert!(tokio::time::timeout(SHORT, &mut held).await.is_err(), "nothing after since: held");
        assert_eq!(
            h.state.request_slots.available_permits(),
            crate::handler::REQUESTS,
            "a waiting request holds no admission slot"
        );
        // The held request holds no lock: another client's write goes straight through.
        let started = std::time::Instant::now();
        assert_eq!(batch(&h, TOKEN, json!([{ "k": K2, "base": 0, "v": "c2" }])).await.0, StatusCode::OK);
        let (status, page) = tokio::time::timeout(PROMPT, held).await.expect("woken by the write");
        assert!(started.elapsed() < PROMPT);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["entries"], json!([{ "k": K2, "seq": 2, "v": "c2" }]));
        assert_eq!(page["head"], 2);
    }

    #[tokio::test]
    async fn a_held_request_answers_empty_at_its_timeout() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        let started = std::time::Instant::now();
        let (status, page) = changes(&h, TOKEN, "?since=1&wait=1").await;
        assert!(started.elapsed() >= std::time::Duration::from_millis(900), "held for its wait");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["entries"], json!([]));
        assert_eq!(page["head"], 1);
        assert_eq!(page["more"], false);
    }

    #[tokio::test]
    async fn rows_after_since_are_answered_without_waiting() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        let (status, page) =
            tokio::time::timeout(PROMPT, changes(&h, TOKEN, "?since=0&wait=25")).await.expect("not held");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["entries"], json!([{ "k": K1, "seq": 1, "v": "c1" }]));
        // A `since` past the head, or a generation the client did not read in, is news too.
        let ahead = tokio::time::timeout(PROMPT, changes(&h, TOKEN, "?since=7&wait=25")).await;
        assert_eq!(ahead.expect("not held").0, StatusCode::OK);
        let path = format!("/lib/{LIB}/changes?since=1&wait=25");
        let other_generation = h.send(
            "GET",
            &path,
            None,
            &[("x-den-library-token", TOKEN), (super::GENERATION_HEADER, "another")],
        );
        assert_eq!(
            tokio::time::timeout(PROMPT, other_generation).await.expect("not held").status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn a_write_to_one_library_does_not_wake_another_librarys_wait() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        let other = |v: &str| json!({ "writes": [{ "k": K1, "base": 0, "v": v }] }).to_string();
        let path = format!("/lib/{LIB2}/batch");
        h.send("POST", &path, Some(other("first")), &[("x-den-library-token", TOKEN)]).await;

        let mut held = Box::pin(changes(&h, TOKEN, "?since=1&wait=20"));
        assert!(tokio::time::timeout(SHORT, &mut held).await.is_err());
        let body = json!({ "writes": [{ "k": K2, "base": 0, "v": "elsewhere" }] }).to_string();
        let written = h.send("POST", &path, Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(written.status(), StatusCode::OK);
        assert!(tokio::time::timeout(SHORT, &mut held).await.is_err(), "another library's write is not news");

        batch(&h, TOKEN, json!([{ "k": K2, "base": 0, "v": "here" }])).await;
        let (_, page) = tokio::time::timeout(PROMPT, held).await.expect("its own library's write wakes it");
        assert_eq!(page["entries"][0]["v"], "here");
    }

    #[tokio::test]
    async fn a_rewrite_commit_wakes_a_held_request_with_the_new_generation() {
        let h = Harness::new();
        let headers = |generation: &str| {
            vec![
                ("x-den-library-token", TOKEN.to_owned()),
                (super::WIRE_HEADER, "3".to_owned()),
                (super::GENERATION_HEADER, generation.to_owned()),
            ]
        };
        let send = |method: &'static str, path: String, body: Option<String>, generation: String| {
            let h = &h;
            async move {
                let owned = headers(&generation);
                let borrowed: Vec<(&str, &str)> = owned.iter().map(|(n, v)| (*n, v.as_str())).collect();
                h.send(method, &path, body, &borrowed).await
            }
        };
        let first = json!({ "writes": [{ "k": K1, "base": 0, "v": "old" }] }).to_string();
        let first = send("POST", format!("/lib/{LIB}/batch"), Some(first), "0".to_owned()).await;
        assert_eq!(first.status(), StatusCode::OK);
        let generation = first.headers()[super::GENERATION_HEADER].to_str().unwrap().to_owned();

        let mut held =
            Box::pin(send("GET", format!("/lib/{LIB}/changes?since=1&wait=20"), None, generation.clone()));
        assert!(tokio::time::timeout(SHORT, &mut held).await.is_err());

        let opened = send("POST", format!("/lib/{LIB}/rewrite"), None, generation.clone()).await;
        let opened = body_json(opened).await;
        let rewrite = opened["rewrite"].as_str().unwrap().to_owned();
        let rows = json!({ "writes": [{ "k": K2, "v": "new" }] }).to_string();
        let staged =
            send("POST", format!("/lib/{LIB}/rewrite/{rewrite}/rows"), Some(rows), generation.clone()).await;
        assert_eq!(staged.status(), StatusCode::OK);
        assert!(tokio::time::timeout(SHORT, &mut held).await.is_err(), "staging commits nothing");

        let commit = json!({ "base": opened["base"], "wireMin": 3 }).to_string();
        let committed =
            send("POST", format!("/lib/{LIB}/rewrite/{rewrite}/commit"), Some(commit), generation.clone())
                .await;
        assert_eq!(committed.status(), StatusCode::OK);
        let answer = tokio::time::timeout(PROMPT, held).await.expect("the commit wakes it");
        assert_eq!(answer.status(), StatusCode::OK);
        assert_ne!(answer.headers()[super::GENERATION_HEADER].to_str().unwrap(), generation);
    }

    #[tokio::test]
    async fn held_requests_are_capped_per_library() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        let mut held: Vec<_> = (0..super::MAX_HELD_PER_LIBRARY)
            .map(|_| Box::pin(changes(&h, TOKEN, "?since=1&wait=20")))
            .collect();
        for request in &mut held {
            assert!(tokio::time::timeout(SHORT, request).await.is_err());
        }
        let (status, page) = tokio::time::timeout(PROMPT, changes(&h, TOKEN, "?since=1&wait=20"))
            .await
            .expect("past the cap a request is answered at once");
        assert_eq!((status, page["entries"].clone()), (StatusCode::OK, json!([])));

        drop(held);
        let mut again = Box::pin(changes(&h, TOKEN, "?since=1&wait=20"));
        assert!(
            tokio::time::timeout(SHORT, &mut again).await.is_err(),
            "a finished wait gives its place back"
        );
    }
}
