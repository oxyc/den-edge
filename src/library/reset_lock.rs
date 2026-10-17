//! Exclusive locks for a compound multi-profile key reset (den-spec `wire/profiles-v1.md` §9.1).
//!
//! The lock is §8.1's: one durable `exclusive-operation-lock` per library, checked inside every write transaction
//! of the library (`v3.rs`). A key reset adds records beside it, in the same library database, through the generic
//! `ExclusiveEdit` compare-and-set commit. No commit ever spans two libraries: the household's record is the single
//! authority, a member lock is subordinate to it, and every cross-library effect is a separate, idempotent commit
//! performed after the household has decided.
//!
//! * `model` is the pure decision function the spec's `resetLockContract` vectors pin.
//! * This module builds a world from what is stored, asks the model, and performs exactly the decided effect.
//!
//! Everything here is dormant behind `PROFILE_RESET_ENABLED` (which follows `PROFILE_MIGRATION_ENABLED` when
//! unset): with it off none of these routes exist, and a `DELETE` carrying the exclusive headers is an ordinary
//! `DELETE`.

pub(crate) mod model;
#[cfg(test)]
mod tests;

use super::snapshot;
use super::v3::{ExclusiveEdit, LibraryStore, LockChange, LockExpect, Protocol, StoreError};
use super::{
    authority, full_generation, library_store_locked, moved, owned, retire_owned_marked, retired, v3_io,
    valid_hex_id, Library, LibrarySlot, AUTHORITY_MOVED, AUTHORITY_V3, MOVED, NS,
};
use crate::handler::{error, internal, json_reply, method_not_allowed, read_json};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use model::{
    Decision, Invalid, Kind, Lib, LibRole, Lock, Member, Phase, Req, Role, Source, World, PURPOSE,
    RECOVERY_PURPOSE,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io;
use std::sync::Arc;

const BODY_BYTES: usize = 16 * 1024;
/// The household's current record: the lock's phase, owner and declaration.
const RESET: &str = "exclusive:reset";
/// Successor libraries still to delete after the household decided against the reset (a JSON list of ids).
const SWEEP: &str = "exclusive:sweep";
/// A sweep hint is a file in this namespace naming a household that may have successors to delete, so a restart
/// finds them without opening every library. It is written before the decision and is only ever a hint: the
/// household's own `SWEEP` record is the authority.
const HINT_NS: &str = "lib-profile-reset";
/// Where releases before `HINT_NS` wrote their hints. Still read and cleared, so a hint left by one is swept.
const LEGACY_HINT_NS: &str = "lib-profile-migration";
const HINT_EXT: &str = "hint";
const SUCCESSOR_TOKEN_HEADER: &str = "x-den-successor-token";

fn entry_key(attempt: &str) -> String {
    format!("exclusive:attempt:{attempt}")
}

fn hint_key(household: &str) -> String {
    format!("exclusive-sweep:{household}")
}

type R<T> = Result<T, Box<Response>>;

macro_rules! tri {
    ($expression:expr) => {
        match $expression {
            Ok(value) => value,
            Err(response) => return *response,
        }
    };
}

fn err(status: StatusCode, code: &str) -> Response {
    json_reply(status, &error(code))
}

fn conflict() -> Response {
    err(StatusCode::CONFLICT, "migration_in_progress")
}

fn bad_request() -> Response {
    err(StatusCode::BAD_REQUEST, "bad_request")
}

fn not_found() -> Response {
    err(StatusCode::NOT_FOUND, "not_found")
}

// ---------------------------------------------------------------------------------------------------------------
// What is stored

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Fence {
    generation: u64,
    base: u64,
    head: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Link {
    attempt: String,
    by: String,
}

/// A library's current key-reset lock. A household's is the authority over the reset; a profile library's is
/// subordinate to it and in force only while the household record is live and of the same attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Record {
    /// The attempt that acquired the lock.
    attempt: String,
    /// Who may act on it now: the acquiring attempt, or the recovery that took it over (household only).
    owner: String,
    role: Role,
    phase: Phase,
    lock: String,
    wire_min: u64,
    fence: Fence,
    successor: String,
    #[serde(default)]
    members: Vec<Member>,
    #[serde(default)]
    household: Option<String>,
    proven: bool,
    /// Previous owners of the household lock, oldest first, each with the attempt that took it over.
    #[serde(default)]
    chain: Vec<Link>,
    /// Declared successors that already existed when the lock was acquired. They were not made by this reset, so a
    /// sweep never deletes them.
    #[serde(default)]
    preexisting: Vec<String>,
}

impl Record {
    fn model(&self, swept: bool) -> Lock {
        Lock {
            attempt: self.attempt.clone(),
            owner: if self.role == Role::Household { self.owner.clone() } else { String::new() },
            purpose: PURPOSE.to_owned(),
            role: self.role,
            phase: self.phase,
            source: Source { generation: self.fence.generation, head: self.fence.head.clone() },
            successor: self.successor.clone(),
            members: self.members.clone(),
            household: self.household.clone(),
            swept,
            proven: self.proven,
            preexisting: self.preexisting.clone(),
        }
    }

    /// What den-edge owes once the household decided against the reset: the declared successors it made, and the
    /// member locks to clear.
    fn owed(&self) -> Owed {
        Owed {
            attempt: self.attempt.clone(),
            successors: std::iter::once(self.successor.clone())
                .chain(self.members.iter().map(|member| member.successor.clone()))
                .filter(|id| !self.preexisting.contains(id))
                .collect(),
            members: self.members.iter().map(|member| member.library_id.clone()).collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Owed {
    attempt: String,
    successors: Vec<String>,
    members: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    Reset,
    Recovery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EntryState {
    Active,
    Aborted,
    Recovered,
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Aborted,
    Retired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Recovers {
    attempt: String,
    phase: Phase,
    successor: String,
    members: Vec<Member>,
}

/// Everything one attempt asked and was told, durable: the stored answer a replay returns, and the terminal
/// tombstone a lookup returns after the attempt ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    kind: EntryKind,
    role: Role,
    state: EntryState,
    #[serde(default)]
    by: Option<String>,
    #[serde(default)]
    outcome: Option<Outcome>,
    source: Source,
    fence: Fence,
    wire_min: u64,
    lock: String,
    #[serde(default)]
    successor: Option<String>,
    #[serde(default)]
    members: Vec<Member>,
    #[serde(default)]
    household: Option<String>,
    #[serde(default)]
    recovers: Option<Recovers>,
}

/// What a retired library keeps in place of its database: the `moved` marker, extended so the lock's terminal
/// `retired` result and the retirement are one file replace. A legacy marker is only a bare successor tag.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    successor: String,
    exclusive: Tombstone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Tombstone {
    lock: String,
    acquired: String,
    owner: String,
    role: Role,
    #[serde(default)]
    household: Option<String>,
    #[serde(default)]
    chain: Vec<Link>,
    #[serde(default)]
    members: Vec<Member>,
}

fn parse_marker(raw: &[u8]) -> Option<Marker> {
    if raw.first() != Some(&b'{') {
        return None;
    }
    serde_json::from_slice(raw).ok()
}

/// The successor tag a legacy `moved` marker names. A key-reset lock's marker names none: the id it retired under
/// is for the attempt that retired it, not for whoever learns the old id.
pub(super) fn marker_successor(raw: &[u8]) -> Option<String> {
    if raw.first() == Some(&b'{') {
        return None;
    }
    String::from_utf8(raw.to_vec()).ok()
}

fn dummy_source() -> Source {
    Source { generation: 0, head: "0".repeat(64) }
}

fn tombstone_lock(marker: &Marker) -> Lock {
    let tombstone = &marker.exclusive;
    Lock {
        attempt: tombstone.acquired.clone(),
        owner: tombstone.owner.clone(),
        purpose: PURPOSE.to_owned(),
        role: tombstone.role,
        phase: Phase::Retired,
        source: dummy_source(),
        successor: marker.successor.clone(),
        members: tombstone.members.clone(),
        household: tombstone.household.clone(),
        swept: false,
        proven: true,
        preexisting: Vec::new(),
    }
}

fn foreign_lock(key: &str) -> Lock {
    Lock {
        attempt: key.to_owned(),
        owner: key.to_owned(),
        purpose: "migration".to_owned(),
        role: Role::Household,
        phase: Phase::Open,
        source: dummy_source(),
        successor: String::new(),
        members: Vec::new(),
        household: None,
        swept: false,
        proven: true,
        preexisting: Vec::new(),
    }
}

/// The model's view of a library's lock: the key-reset record while the lock key names it, any other holder of
/// the key as a migration lock, and an aborted household (or voided member) as a lock that is no longer held.
fn model_lock(key: Option<&str>, record: Option<&Record>, pending_sweep: bool) -> Option<Lock> {
    match (key, record) {
        (Some(key), Some(record))
            if record.phase != Phase::Aborted && (key == record.owner || key == record.attempt) =>
        {
            Some(record.model(false))
        }
        (Some(key), _) => Some(foreign_lock(key)),
        (None, Some(record)) if record.phase == Phase::Aborted => Some(record.model(!pending_sweep)),
        _ => None,
    }
}

fn read<T: DeserializeOwned>(
    store: &dyn LibraryStore,
    key: &str,
) -> Result<Option<(T, Vec<u8>)>, StoreError> {
    match store.exclusive_record(key)? {
        None => Ok(None),
        Some(raw) => serde_json::from_slice(&raw).map(|value| Some((value, raw))).map_err(|reason| {
            StoreError::Invalid(format!("invalid exclusive-operation record {key}: {reason}"))
        }),
    }
}

fn put<T: Serialize>(edit: &mut ExclusiveEdit, key: String, value: &T) {
    edit.put.push((key, serde_json::to_vec(value).expect("a record always serialises")));
}

fn hex_of(bytes: &[u8]) -> String {
    crate::hex(bytes)
}

// ---------------------------------------------------------------------------------------------------------------
// Libraries seen from another library

/// One library as another request sees it: its database when it has one, or the marker that retired it.
struct Peer {
    id: String,
    store: Option<Arc<dyn LibraryStore>>,
    marker: Option<Vec<u8>>,
}

impl Peer {
    fn tombstone(&self) -> Option<Marker> {
        self.marker.as_deref().and_then(parse_marker)
    }
}

async fn blocking<T: Send + 'static>(
    label: &'static str,
    work: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
) -> R<T> {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(reason)) => Err(Box::new(store_failure(label, reason))),
        Err(reason) => Err(Box::new(internal(label, io::Error::other(reason)))),
    }
}

fn store_failure(label: &str, reason: StoreError) -> Response {
    match reason {
        StoreError::Locked => conflict(),
        StoreError::Invalid(message) if message == "migration_source_changed" => {
            err(StatusCode::CONFLICT, "migration_source_changed")
        }
        // The state moved between the decision and its commit: another request won. The loser's client looks up.
        StoreError::Invalid(message) if message == "exclusive_precondition" => conflict(),
        other => internal(label, v3_io(other)),
    }
}

async fn peer(state: &AppState, id: &str) -> io::Result<Peer> {
    let marker = state.store.get_file(NS, id, MOVED).await?;
    if marker.is_some() {
        return Ok(Peer { id: id.to_owned(), store: None, marker });
    }
    let manager = Arc::clone(&state.library_v3);
    let owned_id = id.to_owned();
    let store = tokio::task::spawn_blocking(move || -> Result<Option<Arc<dyn LibraryStore>>, StoreError> {
        let Some((token, _)) = manager.credentials(&owned_id)? else { return Ok(None) };
        manager.existing_library(&owned_id, token).map(Some)
    })
    .await
    .map_err(io::Error::other)?
    .map_err(v3_io)?;
    Ok(Peer { id: id.to_owned(), store, marker: None })
}

async fn peer_or_500(state: &AppState, id: &str) -> R<Peer> {
    peer(state, id).await.map_err(|reason| Box::new(internal("exclusive operation library", reason)))
}

struct View {
    lib: Lib,
    fence: Option<Fence>,
}

fn observed(id: &str, store: &dyn LibraryStore) -> Result<(Source, Fence), StoreError> {
    let snapshot = store.snapshot()?;
    let (generation, head) = snapshot::source(id, &snapshot)
        .map_err(|reason| StoreError::Invalid(format!("library source is unusable: {reason:?}")))?;
    let fence = Fence {
        generation: snapshot.protocol.migration_generation,
        base: snapshot.protocol.head,
        head: head.clone(),
    };
    Ok((Source { generation, head }, fence))
}

/// A library as the model sees it. `None` when there is no such library. The source is computed only when the
/// request compares it.
fn view(peer: &Peer, role: Option<LibRole>, want_source: bool) -> Result<Option<View>, StoreError> {
    if let Some(raw) = &peer.marker {
        let marker = parse_marker(raw);
        let role = marker
            .as_ref()
            .map(|marker| match marker.exclusive.role {
                Role::Household => LibRole::Household,
                Role::Profile => LibRole::Profile,
            })
            .or(role)
            .unwrap_or(LibRole::Profile);
        let lock = marker.as_ref().map(tombstone_lock);
        let lib = Lib {
            role,
            wire_min: 0,
            source: dummy_source(),
            rows: 0,
            retired: true,
            lock,
            credential: None,
            exists: true,
        };
        return Ok(Some(View { lib, fence: None }));
    }
    let Some(store) = peer.store.as_deref() else { return Ok(None) };
    let protocol = store.protocol()?;
    let key = store.exclusive_operation_lock()?;
    let record = read::<Record>(store, RESET)?.map(|(record, _)| record);
    let pending = store.exclusive_record(SWEEP)?.is_some();
    let lock = model_lock(key.as_deref(), record.as_ref(), pending);
    let rows = u64::from(!store.range(0, 1)?.entries.is_empty());
    let (source, fence) = if want_source {
        let (source, fence) = observed(&peer.id, store)?;
        (source, Some(fence))
    } else {
        (dummy_source(), None)
    };
    let role = role.unwrap_or(if protocol.wire_min >= 5 { LibRole::Household } else { LibRole::Profile });
    Ok(Some(View {
        lib: Lib {
            role,
            wire_min: protocol.wire_min,
            source,
            rows,
            retired: false,
            lock,
            credential: Some(hex_of(&store.credentials().0)),
            exists: true,
        },
        fence,
    }))
}

// ---------------------------------------------------------------------------------------------------------------
// Serialization across libraries

struct SlotSet {
    ids: Vec<String>,
    slots: Vec<Arc<LibrarySlot>>,
}

impl SlotSet {
    /// The libraries a request reads or writes, taken in ascending id order so two requests cannot deadlock.
    fn new<'a>(state: &AppState, ids: impl IntoIterator<Item = &'a str>) -> Self {
        let mut ids: Vec<String> = ids.into_iter().map(str::to_owned).collect();
        ids.sort_unstable();
        ids.dedup();
        let slots = ids.iter().map(|id| state.libraries.slot(id, state.now())).collect();
        Self { ids, slots }
    }

    fn index(&self, id: &str) -> usize {
        self.ids.iter().position(|candidate| candidate == id).expect("the set names this library")
    }

    async fn lock(&self) -> Vec<tokio::sync::MutexGuard<'_, Option<Library>>> {
        let mut guards = Vec::with_capacity(self.slots.len());
        for slot in &self.slots {
            guards.push(slot.library.lock().await);
        }
        guards
    }
}

async fn target_store(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    set: &SlotSet,
    guards: &mut [tokio::sync::MutexGuard<'_, Option<Library>>],
) -> R<Arc<dyn LibraryStore>> {
    let index = set.index(id);
    match library_store_locked(state, id, token_hash, &set.slots[index], &mut guards[index]).await {
        Ok(Some(store)) => Ok(store),
        Ok(None) => match retired(state, id).await {
            Ok(true) => Err(Box::new(moved(state, id).await)),
            _ => Err(Box::new(not_found())),
        },
        Err(response) => Err(response),
    }
}

fn decide(world: &World, request: &Req) -> R<Decision> {
    model::step(world, request).map_err(|invalid| {
        Box::new(match invalid {
            Invalid::AttemptMismatch => err(StatusCode::CONFLICT, "migration_attempt_mismatch"),
            _ => bad_request(),
        })
    })
}

fn refusal(status: u16, code: &str) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::CONFLICT);
    err(status, code)
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

fn open_json(library: &str, attempt: &str, entry: &Entry, phase: Phase) -> Value {
    let state = match (entry.kind, entry.role) {
        (EntryKind::Reset, Role::Household) if phase != Phase::Open => "committed",
        _ => "open",
    };
    let mut body = json!({
        "attempt": attempt,
        "state": state,
        "purpose": if entry.kind == EntryKind::Reset { PURPOSE } else { RECOVERY_PURPOSE },
        "role": entry.role,
        "library": library,
        "wireMin": entry.wire_min,
        "lock": entry.lock,
        "fence": { "generation": entry.fence.generation, "base": entry.fence.base, "head": entry.fence.head },
    });
    match entry.kind {
        EntryKind::Reset => {
            body["successor"] = json!(entry.successor);
            if entry.role == Role::Household {
                body["members"] = json!(entry.members);
            } else {
                body["household"] = json!(entry.household);
            }
        }
        EntryKind::Recovery => body["recovers"] = json!(entry.recovers),
    }
    body
}

fn terminal_json(library: &str, attempt: &str, entry: &Entry) -> Value {
    match entry.state {
        EntryState::Aborted => json!({ "attempt": attempt, "state": "aborted", "library": library }),
        EntryState::Recovered => {
            let mut body = json!({ "attempt": attempt, "state": "recovered", "recovery": entry.by });
            if let Some(outcome) = entry.outcome {
                body["outcome"] = json!(outcome);
            }
            body
        }
        EntryState::Completed => {
            json!({ "attempt": attempt, "state": "completed", "outcome": entry.outcome })
        }
        EntryState::Active => unreachable!("an active entry renders as its open answer"),
    }
}

fn marker_json(library: &str, attempt: &str, marker: &Marker) -> Option<Value> {
    let tombstone = &marker.exclusive;
    if let Some(link) = tombstone.chain.iter().find(|link| link.attempt == attempt) {
        return Some(
            json!({ "attempt": attempt, "state": "recovered", "recovery": link.by, "outcome": Outcome::Retired }),
        );
    }
    if attempt == tombstone.owner && attempt != tombstone.acquired && tombstone.role == Role::Household {
        return Some(json!({ "attempt": attempt, "state": "completed", "outcome": Outcome::Retired }));
    }
    (attempt == tombstone.owner || attempt == tombstone.acquired).then(|| {
        json!({ "attempt": attempt, "state": "retired", "library": library, "successor": marker.successor })
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Routes

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcquireBody {
    attempt: String,
    purpose: String,
    role: Role,
    expected_source: Source,
    #[serde(default)]
    successor: Option<String>,
    #[serde(default)]
    members: Option<Vec<Member>>,
    #[serde(default)]
    household: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitBody {
    successor: String,
}

async fn typed<T: DeserializeOwned>(request: Request) -> R<T> {
    let value = read_json(request, BODY_BYTES).await?;
    serde_json::from_value(value).map_err(|_| Box::new(bad_request()))
}

/// `/lib/{id}/exclusive-operation[...]`. The caller has checked the feature gate, the library's wire and, for a
/// library that still has a database, its token.
pub(super) async fn handle(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    action: &str,
    request: Request,
) -> Response {
    let rest = action.strip_prefix("exclusive-operation").unwrap_or_default();
    let segments: Vec<&str> = match rest.strip_prefix('/') {
        Some(rest) => rest.split('/').collect(),
        None if rest.is_empty() => Vec::new(),
        None => return not_found(),
    };
    let method = request.method().clone();
    match (segments.as_slice(), &method) {
        ([], &Method::POST) => post(state, id, token_hash, request).await,
        (["source"], &Method::GET) => source(state, id, token_hash).await,
        ([attempt], &Method::GET) if model::valid_id32(attempt) => {
            lookup(state, id, token_hash, attempt).await
        }
        ([attempt], &Method::DELETE) if model::valid_id32(attempt) => {
            abort(state, id, token_hash, attempt).await
        }
        ([attempt, "successor"], &Method::POST) if model::valid_id32(attempt) => {
            successor_commit(state, id, token_hash, attempt, request).await
        }
        ([], _) | (["source"], _) => method_not_allowed(),
        ([attempt], _) | ([attempt, "successor"], _) if model::valid_id32(attempt) => method_not_allowed(),
        // A malformed attempt is a bad request wherever the surface takes one.
        ([_], _) | ([_, "successor"], _) => bad_request(),
        _ => not_found(),
    }
}

async fn source(state: &AppState, id: &str, token_hash: [u8; 32]) -> Response {
    let set = SlotSet::new(state, [id]);
    let mut guards = set.lock().await;
    let store = tri!(target_store(state, id, token_hash, &set, &mut guards).await);
    let owned_id = id.to_owned();
    let (source, _) = tri!(blocking("exclusive source", move || observed(&owned_id, store.as_ref())).await);
    json_reply(StatusCode::OK, &json!({ "source": source }))
}

async fn lookup(state: &AppState, id: &str, token_hash: [u8; 32], attempt: &str) -> Response {
    let target = tri!(peer_or_500(state, id).await);
    if target.marker.is_some() {
        let Some(marker) = target.tombstone() else { return not_found() };
        if let Some(body) = marker_json(id, attempt, &marker) {
            return json_reply(StatusCode::OK, &body);
        }
        if follows_household(state, &marker, attempt).await {
            let body = json!({ "attempt": attempt, "state": "retired", "library": id, "successor": marker.successor });
            return json_reply(StatusCode::OK, &body);
        }
        return not_found();
    }
    let set = SlotSet::new(state, [id]);
    let mut guards = set.lock().await;
    let store = tri!(target_store(state, id, token_hash, &set, &mut guards).await);
    let household = match read_record(&store).await {
        Ok(Some((record, _))) if record.role == Role::Profile => record.household,
        Ok(_) => None,
        Err(response) => return *response,
    };
    let household_peer = match &household {
        Some(household) => Some(tri!(peer_or_500(state, household).await)),
        None => None,
    };
    let owned_id = id.to_owned();
    let attempt = attempt.to_owned();
    let found = tri!(
        blocking("exclusive lookup", move || lookup_body(
            &owned_id,
            store.as_ref(),
            household_peer.as_ref(),
            &attempt
        ))
        .await
    );
    match found {
        Some(body) => json_reply(StatusCode::OK, &body),
        None => not_found(),
    }
}

async fn read_record(store: &Arc<dyn LibraryStore>) -> R<Option<(Record, Vec<u8>)>> {
    let store = Arc::clone(store);
    blocking("exclusive record", move || read::<Record>(store.as_ref(), RESET)).await
}

/// Authority on a member lock follows the household lock's current owner: a recovery that took the household over
/// may repeat, and look up, the retirement of a member that the attempt before it retired.
async fn follows_household(state: &AppState, marker: &Marker, attempt: &str) -> bool {
    let tombstone = &marker.exclusive;
    let Some(household) = tombstone.household.as_ref().filter(|_| tombstone.role == Role::Profile) else {
        return false;
    };
    let Ok(found) = peer(state, household).await else { return false };
    let Some(store) = found.store else { return false };
    let read_store = Arc::clone(&store);
    let current = tokio::task::spawn_blocking(move || read::<Record>(read_store.as_ref(), RESET)).await;
    matches!(current, Ok(Ok(Some((record, _)))) if record.attempt == tombstone.acquired && record.owner == attempt)
}

/// The stored answer for `attempt` on this library, or its terminal result.
fn lookup_body(
    id: &str,
    store: &dyn LibraryStore,
    household: Option<&Peer>,
    attempt: &str,
) -> Result<Option<Value>, StoreError> {
    let Some((entry, _)) = read::<Entry>(store, &entry_key(attempt))? else { return Ok(None) };
    let record = read::<Record>(store, RESET)?.map(|(record, _)| record);
    if entry.state != EntryState::Active {
        return Ok(Some(terminal_json(id, attempt, &entry)));
    }
    if entry.role == Role::Profile {
        // A member whose household aborted answers `aborted` before its own record is cleaned up.
        let voided = match household {
            Some(household) => household_voids(household, record.as_ref())?,
            None => false,
        };
        if voided || record.as_ref().is_none_or(|record| record.attempt != attempt) {
            return Ok(Some(json!({ "attempt": attempt, "state": "aborted", "library": id })));
        }
    }
    let phase = record.as_ref().map_or(Phase::Open, |record| record.phase);
    Ok(Some(open_json(id, attempt, &entry, phase)))
}

/// Whether a member's lock has been voided by its household: the household record is gone, or is of another
/// attempt, or is no longer live.
fn household_voids(household: &Peer, member: Option<&Record>) -> Result<bool, StoreError> {
    let Some(member) = member else { return Ok(true) };
    if member.phase == Phase::Aborted {
        return Ok(true);
    }
    let Some(store) = household.store.as_deref() else {
        // A retired household retired every member first; a member still locked under it keeps its lock.
        return Ok(false);
    };
    let record = read::<Record>(store, RESET)?.map(|(record, _)| record);
    Ok(record.is_none_or(|record| record.attempt != member.attempt || !record.phase.live()))
}

// ---------------------------------------------------------------------------------------------------------------
// Acquire and recovery

async fn post(state: &AppState, id: &str, token_hash: [u8; 32], request: Request) -> Response {
    let proof_header = request.headers().get(SUCCESSOR_TOKEN_HEADER).map(|value| {
        value.to_str().ok().filter(|token| !token.is_empty() && token.len() <= 256).map(str::to_owned)
    });
    let body: AcquireBody = tri!(typed(request).await);
    // A header that is present but unusable is a proof that does not match anything.
    let proof_hash: Option<[u8; 32]> = match proof_header {
        None => None,
        Some(Some(token)) => Some(Sha256::digest(token.as_bytes()).into()),
        Some(None) => return conflict(),
    };
    let acquire = match body.purpose.as_str() {
        PURPOSE => true,
        RECOVERY_PURPOSE => false,
        _ => return bad_request(),
    };
    if !model::valid_id32(&body.attempt) {
        return bad_request();
    }
    let household_id = (acquire && body.role == Role::Profile)
        .then(|| body.household.clone().filter(|household| valid_hex_id(household)))
        .flatten();
    if acquire && body.role == Role::Profile && household_id.is_none() {
        return bad_request();
    }
    let set = SlotSet::new(state, std::iter::once(id).chain(household_id.as_deref()));
    let mut guards = set.lock().await;
    let store = tri!(target_store(state, id, token_hash, &set, &mut guards).await);
    let target = tri!(peer_or_500(state, id).await);
    let current = tri!(read_record(&store).await);

    // Lookup first: the same attempt is a replay of its stored answer, any other value under it a mismatch.
    let entry_store = Arc::clone(&store);
    let attempt_key = entry_key(&body.attempt);
    let existing =
        tri!(blocking("exclusive entry", move || read::<Entry>(entry_store.as_ref(), &attempt_key)).await);
    if let Some((entry, _)) = existing {
        let same = match entry.kind {
            EntryKind::Reset => {
                acquire
                    && entry.role == body.role
                    && entry.source == body.expected_source
                    && entry.successor == body.successor
                    && entry.members.as_slice() == body.members.as_deref().unwrap_or_default()
                    && entry.household == body.household
            }
            EntryKind::Recovery => {
                !acquire && body.role == Role::Household && entry.source == body.expected_source
            }
        };
        if !same {
            return err(StatusCode::CONFLICT, "migration_attempt_mismatch");
        }
        let household = match &household_id {
            Some(household) => Some(tri!(peer_or_500(state, household).await)),
            None => None,
        };
        let owned_id = id.to_owned();
        let attempt = body.attempt.clone();
        let found = tri!(
            blocking("exclusive replay", move || lookup_body(
                &owned_id,
                store.as_ref(),
                household.as_ref(),
                &attempt
            ))
            .await
        );
        return found.map_or_else(not_found, |found| json_reply(StatusCode::OK, &found));
    }

    // The world the model decides over: this library, its household (a profile acquire) and, for a recovery that
    // brings a proof, the declared successor.
    let mut peers: Vec<(Peer, Option<LibRole>)> = vec![(target, None)];
    if let Some(household) = &household_id {
        peers.push((tri!(peer_or_500(state, household).await), Some(LibRole::Household)));
    }
    let mut proof_credential = None;
    if let (Some(hash), Some((record, _))) = (proof_hash, &current) {
        proof_credential = Some(hex_of(&hash));
        peers.push((tri!(peer_or_500(state, &record.successor).await), Some(LibRole::Successor)));
    } else if proof_hash.is_some() {
        // A proof against a reset that does not exist proves nothing.
        return conflict();
    }
    let target_id = id.to_owned();
    let built = tri!(blocking("exclusive world", move || build_world(&peers, &target_id, true)).await);
    let (world, fence) = built;
    let request = Req {
        kind: if acquire { Kind::Acquire } else { Kind::Takeover },
        library: id.to_owned(),
        attempt: Some(body.attempt.clone()),
        purpose: Some(body.purpose.clone()),
        role: Some(body.role),
        expected_source: Some(body.expected_source.clone()),
        successor: body.successor.clone(),
        members: body.members.clone(),
        household: body.household.clone(),
        successor_credential: proof_credential,
    };
    if !acquire {
        // The hint precedes any decision that may end the reset, so a crash after the commit still finds it.
        write_hint(state, id).await;
    }
    match tri!(decide(&world, &request)) {
        Decision::Refused { status, error } => refusal(status, error),
        Decision::Lookup => {
            let owned_id = id.to_owned();
            let attempt = body.attempt.clone();
            let found = tri!(
                blocking("exclusive replay", move || lookup_body(&owned_id, store.as_ref(), None, &attempt))
                    .await
            );
            found.map_or_else(not_found, |found| json_reply(StatusCode::OK, &found))
        }
        Decision::Open { .. } => {
            let fence = fence.expect("a source was requested for the acquire");
            if body.role == Role::Household {
                open_household(state, id, &store, &body, fence).await
            } else {
                open_member(id, &store, &body, fence, current).await
            }
        }
        Decision::Takeover { .. } => {
            let proven = proof_hash.is_some();
            takeover(id, &store, &body, proven).await
        }
        Decision::Rollback => rollback(state, id, &store, &body).await,
        _ => conflict(),
    }
}

/// Peers into the model's world. The first is the request's own library.
fn build_world(
    peers: &[(Peer, Option<LibRole>)],
    target: &str,
    want_source: bool,
) -> Result<(World, Option<Fence>), StoreError> {
    let mut world = World::default();
    let mut fence = None;
    for (peer, role) in peers {
        let is_target = peer.id == target;
        if let Some(built) = view(peer, *role, want_source && is_target)? {
            if is_target {
                fence = built.fence;
            }
            world.libraries.insert(peer.id.clone(), built.lib);
        }
    }
    Ok((world, fence))
}

async fn open_household(
    state: &AppState,
    id: &str,
    store: &Arc<dyn LibraryStore>,
    body: &AcquireBody,
    fence: Fence,
) -> Response {
    let successor = body.successor.clone().unwrap_or_default();
    let members = body.members.clone().unwrap_or_default();
    let mut preexisting = Vec::new();
    for declared in std::iter::once(&successor).chain(members.iter().map(|member| &member.successor)) {
        let found = tri!(peer_or_500(state, declared).await);
        if found.store.is_some() || found.marker.is_some() {
            preexisting.push(declared.clone());
        }
    }
    let protocol_store = Arc::clone(store);
    let protocol = tri!(blocking("exclusive protocol", move || protocol_store.protocol()).await);
    let record = Record {
        attempt: body.attempt.clone(),
        owner: body.attempt.clone(),
        role: Role::Household,
        phase: Phase::Open,
        lock: format!("lock-{}", hex_of(&crate::random_bytes::<16>())),
        wire_min: protocol.wire_min,
        fence,
        successor: successor.clone(),
        members: members.clone(),
        household: None,
        proven: true,
        chain: Vec::new(),
        preexisting,
    };
    let entry = new_entry(&record, body);
    let answer = open_json(id, &body.attempt, &entry, Phase::Open);
    tri!(commit_open(store, &record, &entry).await);
    json_reply(StatusCode::OK, &answer)
}

async fn open_member(
    id: &str,
    store: &Arc<dyn LibraryStore>,
    body: &AcquireBody,
    fence: Fence,
    current: Option<(Record, Vec<u8>)>,
) -> Response {
    let protocol_store = Arc::clone(store);
    let protocol = tri!(blocking("exclusive protocol", move || protocol_store.protocol()).await);
    let record = Record {
        attempt: body.attempt.clone(),
        owner: body.attempt.clone(),
        role: Role::Profile,
        phase: Phase::Open,
        lock: format!("lock-{}", hex_of(&crate::random_bytes::<16>())),
        wire_min: protocol.wire_min,
        fence,
        successor: body.successor.clone().unwrap_or_default(),
        members: Vec::new(),
        household: body.household.clone(),
        proven: true,
        chain: Vec::new(),
        preexisting: Vec::new(),
    };
    let entry = new_entry(&record, body);
    let answer = open_json(id, &body.attempt, &entry, Phase::Open);
    let replaced = current.map(|(_, raw)| raw);
    let edit_store = Arc::clone(store);
    tri!(
        blocking("exclusive acquire", move || {
            // A voided lock of a finished reset may still hold the key; the record it names is what is replaced.
            let mut edit = ExclusiveEdit::new(LockExpect::Any, LockChange::Set(record.attempt.clone()));
            edit.expect_source = Some((record.fence.generation, record.fence.base));
            edit.expect_records.push((RESET.to_owned(), replaced));
            put(&mut edit, RESET.to_owned(), &record);
            put(&mut edit, entry_key(&record.attempt), &entry);
            edit_store.exclusive_commit(&edit)
        })
        .await
    );
    json_reply(StatusCode::OK, &answer)
}

fn new_entry(record: &Record, body: &AcquireBody) -> Entry {
    Entry {
        kind: EntryKind::Reset,
        role: record.role,
        state: EntryState::Active,
        by: None,
        outcome: None,
        source: body.expected_source.clone(),
        fence: record.fence.clone(),
        wire_min: record.wire_min,
        lock: record.lock.clone(),
        successor: body.successor.clone(),
        members: body.members.clone().unwrap_or_default(),
        household: body.household.clone(),
        recovers: None,
    }
}

async fn commit_open(store: &Arc<dyn LibraryStore>, record: &Record, entry: &Entry) -> R<()> {
    let store = Arc::clone(store);
    let record = record.clone();
    let entry = entry.clone();
    blocking("exclusive acquire", move || {
        let replaced = store.exclusive_record(RESET)?;
        let mut edit = ExclusiveEdit::new(LockExpect::Absent, LockChange::Set(record.attempt.clone()));
        edit.expect_source = Some((record.fence.generation, record.fence.base));
        edit.expect_records.push((RESET.to_owned(), replaced));
        put(&mut edit, RESET.to_owned(), &record);
        put(&mut edit, entry_key(&record.attempt), &entry);
        store.exclusive_commit(&edit)
    })
    .await
}

/// Replace the household's owner with a recovery attempt. The household lock is never released by it.
async fn takeover(id: &str, store: &Arc<dyn LibraryStore>, body: &AcquireBody, proven: bool) -> Response {
    let store = Arc::clone(store);
    let recovery = body.attempt.clone();
    let source = body.expected_source.clone();
    let library = id.to_owned();
    let answer = tri!(
        blocking("exclusive takeover", move || {
            let (record, raw) = read::<Record>(store.as_ref(), RESET)?
                .ok_or_else(|| StoreError::Invalid("exclusive_precondition".into()))?;
            let previous = record.owner.clone();
            let mut next = record.clone();
            next.owner = recovery.clone();
            next.proven = proven;
            next.chain.push(Link { attempt: previous.clone(), by: recovery.clone() });
            let entry = Entry {
                kind: EntryKind::Recovery,
                role: Role::Household,
                state: EntryState::Active,
                by: None,
                outcome: None,
                source,
                fence: record.fence.clone(),
                wire_min: record.wire_min,
                lock: record.lock.clone(),
                successor: None,
                members: Vec::new(),
                household: None,
                recovers: Some(Recovers {
                    attempt: previous.clone(),
                    phase: record.phase,
                    successor: record.successor.clone(),
                    members: record.members.clone(),
                }),
            };
            let mut edit =
                ExclusiveEdit::new(LockExpect::Held(previous.clone()), LockChange::Set(recovery.clone()));
            edit.expect_records.push((RESET.to_owned(), Some(raw)));
            put(&mut edit, RESET.to_owned(), &next);
            if let Some((mut old, _)) = read::<Entry>(store.as_ref(), &entry_key(&previous))? {
                old.state = EntryState::Recovered;
                old.by = Some(recovery.clone());
                put(&mut edit, entry_key(&previous), &old);
            }
            put(&mut edit, entry_key(&recovery), &entry);
            store.exclusive_commit(&edit)?;
            Ok(open_json(&library, &recovery, &entry, record.phase))
        })
        .await
    );
    json_reply(StatusCode::OK, &answer)
}

/// The proofless recovery of a `committed` reset: one commit on the household that ends the reset.
async fn rollback(state: &AppState, id: &str, store: &Arc<dyn LibraryStore>, body: &AcquireBody) -> Response {
    let edit_store = Arc::clone(store);
    let recovery = body.attempt.clone();
    let source = body.expected_source.clone();
    tri!(
        blocking("exclusive rollback", move || {
            let (record, raw) = read::<Record>(edit_store.as_ref(), RESET)?
                .ok_or_else(|| StoreError::Invalid("exclusive_precondition".into()))?;
            let edit = end_edit(edit_store.as_ref(), &record, raw, Some((&recovery, source)))?;
            edit_store.exclusive_commit(&edit)
        })
        .await
    );
    note_sweep(state, id);
    json_reply(
        StatusCode::OK,
        &json!({ "attempt": body.attempt, "state": "completed", "outcome": Outcome::Aborted }),
    )
}

/// Everything that ends a reset without retiring it, as one commit on the household: the phase, the release of
/// the household's own lock (every member lock is void from this commit on), each attempt's tombstone and the list
/// of successor libraries den-edge now owes a deletion. `by` is a recovery that never became owner (a rollback).
fn end_edit(
    store: &dyn LibraryStore,
    record: &Record,
    raw: Vec<u8>,
    by: Option<(&str, Source)>,
) -> Result<ExclusiveEdit, StoreError> {
    let mut next = record.clone();
    next.phase = Phase::Aborted;
    let mut edit = ExclusiveEdit::new(LockExpect::Held(record.owner.clone()), LockChange::Clear);
    edit.expect_records.push((RESET.to_owned(), Some(raw)));
    let owner_entry = read::<Entry>(store, &entry_key(&record.owner))?.map(|(entry, _)| entry);
    match by {
        None => {
            if let Some(mut entry) = owner_entry {
                match entry.kind {
                    EntryKind::Reset => entry.state = EntryState::Aborted,
                    EntryKind::Recovery => {
                        entry.state = EntryState::Completed;
                        entry.outcome = Some(Outcome::Aborted);
                    }
                }
                put(&mut edit, entry_key(&record.owner), &entry);
            }
        }
        Some((recovery, source)) => {
            if let Some(mut entry) = owner_entry {
                entry.state = EntryState::Recovered;
                entry.by = Some(recovery.to_owned());
                entry.outcome = Some(Outcome::Aborted);
                put(&mut edit, entry_key(&record.owner), &entry);
            }
            next.chain.push(Link { attempt: record.owner.clone(), by: recovery.to_owned() });
            let finished = Entry {
                kind: EntryKind::Recovery,
                role: Role::Household,
                state: EntryState::Completed,
                by: None,
                outcome: Some(Outcome::Aborted),
                source,
                fence: record.fence.clone(),
                wire_min: record.wire_min,
                lock: record.lock.clone(),
                successor: None,
                members: Vec::new(),
                household: None,
                recovers: None,
            };
            put(&mut edit, entry_key(recovery), &finished);
        }
    }
    for link in &record.chain {
        if let Some((mut entry, _)) = read::<Entry>(store, &entry_key(&link.attempt))? {
            entry.state = EntryState::Recovered;
            entry.by = Some(link.by.clone());
            entry.outcome = Some(Outcome::Aborted);
            put(&mut edit, entry_key(&link.attempt), &entry);
        }
    }
    put(&mut edit, SWEEP.to_owned(), &record.owed());
    put(&mut edit, RESET.to_owned(), &next);
    Ok(edit)
}

// ---------------------------------------------------------------------------------------------------------------
// Successor commit and abort

async fn successor_commit(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    attempt: &str,
    request: Request,
) -> Response {
    let body: CommitBody = tri!(typed(request).await);
    let set = SlotSet::new(state, [id]);
    let mut guards = set.lock().await;
    let store = tri!(target_store(state, id, token_hash, &set, &mut guards).await);
    let current = tri!(read_record(&store).await);
    let mut peers = vec![(tri!(peer_or_500(state, id).await), None)];
    if let Some((record, _)) = &current {
        for member in &record.members {
            peers.push((tri!(peer_or_500(state, &member.library_id).await), Some(LibRole::Profile)));
        }
        peers.push((tri!(peer_or_500(state, &record.successor).await), Some(LibRole::Successor)));
    }
    let target_id = id.to_owned();
    let (world, _) = tri!(blocking("exclusive world", move || build_world(&peers, &target_id, false)).await);
    let request = Req {
        kind: Kind::Commit,
        library: id.to_owned(),
        attempt: Some(attempt.to_owned()),
        purpose: None,
        role: None,
        expected_source: None,
        successor: Some(body.successor.clone()),
        members: None,
        household: None,
        successor_credential: None,
    };
    match tri!(decide(&world, &request)) {
        Decision::Refused { status, error } => refusal(status, error),
        Decision::Lookup => lookup_reply(id, &store, attempt).await,
        Decision::Committed => {
            let edit_store = Arc::clone(&store);
            tri!(
                blocking("exclusive successor commit", move || {
                    let (record, raw) = read::<Record>(edit_store.as_ref(), RESET)?
                        .ok_or_else(|| StoreError::Invalid("exclusive_precondition".into()))?;
                    let mut next = record.clone();
                    next.phase = Phase::Committed;
                    let mut edit =
                        ExclusiveEdit::new(LockExpect::Held(record.owner.clone()), LockChange::Keep);
                    edit.expect_records.push((RESET.to_owned(), Some(raw)));
                    put(&mut edit, RESET.to_owned(), &next);
                    edit_store.exclusive_commit(&edit)
                })
                .await
            );
            lookup_reply(id, &store, attempt).await
        }
        _ => conflict(),
    }
}

async fn lookup_reply(id: &str, store: &Arc<dyn LibraryStore>, attempt: &str) -> Response {
    let store = Arc::clone(store);
    let owned_id = id.to_owned();
    let owned_attempt = attempt.to_owned();
    let found = tri!(
        blocking("exclusive lookup", move || lookup_body(&owned_id, store.as_ref(), None, &owned_attempt))
            .await
    );
    found.map_or_else(not_found, |found| json_reply(StatusCode::OK, &found))
}

async fn abort(state: &AppState, id: &str, token_hash: [u8; 32], attempt: &str) -> Response {
    let set = SlotSet::new(state, [id]);
    let mut guards = set.lock().await;
    let store = tri!(target_store(state, id, token_hash, &set, &mut guards).await);
    let peers = vec![(tri!(peer_or_500(state, id).await), None)];
    let target_id = id.to_owned();
    let (world, _) = tri!(blocking("exclusive world", move || build_world(&peers, &target_id, false)).await);
    let request = Req {
        kind: Kind::Abort,
        library: id.to_owned(),
        attempt: Some(attempt.to_owned()),
        purpose: None,
        role: None,
        expected_source: None,
        successor: None,
        members: None,
        household: None,
        successor_credential: None,
    };
    write_hint(state, id).await;
    match tri!(decide(&world, &request)) {
        Decision::Refused { status, error } => refusal(status, error),
        Decision::Lookup => lookup_reply(id, &store, attempt).await,
        Decision::Aborted => {
            let edit_store = Arc::clone(&store);
            tri!(
                blocking("exclusive abort", move || {
                    let (record, raw) = read::<Record>(edit_store.as_ref(), RESET)?
                        .ok_or_else(|| StoreError::Invalid("exclusive_precondition".into()))?;
                    let edit = end_edit(edit_store.as_ref(), &record, raw, None)?;
                    edit_store.exclusive_commit(&edit)
                })
                .await
            );
            note_sweep(state, id);
            lookup_reply(id, &store, attempt).await
        }
        _ => conflict(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Retirement

/// `DELETE /lib/{id}` with `x-den-exclusive-attempt` and `x-den-successor`: retire a locked library and release
/// its lock in one commit on that library, crossing the household's retirement door first when this is the first
/// retirement of the reset.
pub(super) async fn retire(
    state: &AppState,
    id: &str,
    token_hash: [u8; 32],
    attempt: &str,
    successor: &str,
    sent_generation: Option<&str>,
) -> Response {
    // Taken before any library's lock, as `forget` and recovery take them.
    let recovery = state.recovery_lock.lock().await;
    let first = tri!(peer_or_500(state, id).await);
    if let Some(marker) = first.tombstone() {
        // A repeat by the retiring attempt, or by whoever owns the household lock now, with the recorded successor
        // is a success; anyone else learns only that it moved.
        let repeat = marker.successor == successor
            && (marker.exclusive.owner == attempt
                || marker.exclusive.acquired == attempt
                || follows_household(state, &marker, attempt).await);
        return if repeat {
            json_reply(StatusCode::OK, &json!({ "deleted": true }))
        } else {
            moved(state, id).await
        };
    }
    if first.marker.is_some() {
        return moved(state, id).await;
    }
    // Who the household is decides which libraries this retirement serializes with.
    let household_id = match &first.store {
        Some(store) => {
            let store = Arc::clone(store);
            match tri!(blocking("exclusive record", move || read::<Record>(store.as_ref(), RESET)).await) {
                Some((record, _)) if record.role == Role::Profile => record.household,
                _ => None,
            }
        }
        None => None,
    };
    // A live handle on the library's database would stop its removal once retired.
    drop(first);
    let set = SlotSet::new(state, std::iter::once(id).chain(household_id.as_deref()));
    let mut guards = set.lock().await;
    let index = set.index(id);
    let (selected_v3, _) = match owned(state, &set.slots[index], &guards[index], id, token_hash).await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    let store = tri!(target_store(state, id, token_hash, &set, &mut guards).await);
    let Some((record, _)) = tri!(read_record(&store).await) else {
        // A lock of another operation is held by someone else; no lock at all is not held.
        let lock_store = Arc::clone(&store);
        let held = tri!(blocking("exclusive lock", move || lock_store.exclusive_operation_lock()).await);
        return if held.is_some() { conflict() } else { err(StatusCode::CONFLICT, "lock_not_held") };
    };

    // The libraries whose locks the decision reads.
    let mut peers = vec![(tri!(peer_or_500(state, id).await), None)];
    let mut household_peer_id = None;
    match record.role {
        Role::Profile => {
            if let Some(household) = &record.household {
                peers.push((tri!(peer_or_500(state, household).await), Some(LibRole::Household)));
                household_peer_id = Some(household.clone());
            }
        }
        Role::Household => {
            for member in &record.members {
                peers.push((tri!(peer_or_500(state, &member.library_id).await), Some(LibRole::Profile)));
            }
        }
    }
    let target_id = id.to_owned();
    let (mut world, _) =
        tri!(blocking("exclusive world", move || build_world(&peers, &target_id, false)).await);
    if record.role == Role::Household {
        // A member retired by another reset's lock is not retired by this one.
        for member in &record.members {
            if let Some(lib) = world.libraries.get_mut(&member.library_id) {
                if lib
                    .lock
                    .as_ref()
                    .is_some_and(|lock| lock.phase == Phase::Retired && lock.attempt != record.attempt)
                {
                    lib.lock = None;
                }
            }
        }
    }
    let request = Req {
        kind: Kind::Retire,
        library: id.to_owned(),
        attempt: Some(attempt.to_owned()),
        purpose: None,
        role: None,
        expected_source: None,
        successor: Some(successor.to_owned()),
        members: None,
        household: None,
        successor_credential: None,
    };
    let door = match tri!(decide(&world, &request)) {
        Decision::Refused { status, error } => return refusal(status, error),
        Decision::Retired { door } => door,
        Decision::Lookup => return json_reply(StatusCode::OK, &json!({ "deleted": true })),
        _ => return conflict(),
    };

    // Under a lock the generation cannot change; a mismatch is a storage failure the client must surface.
    let protocol_store = Arc::clone(&store);
    let protocol: Protocol = tri!(blocking("exclusive protocol", move || protocol_store.protocol()).await);
    if sent_generation != Some(full_generation(state, &protocol.generation).as_str()) {
        return err(StatusCode::CONFLICT, "generation_changed");
    }

    if door {
        let household = household_peer_id.expect("a member retirement has its household");
        let Some(household_store) = tri!(peer_or_500(state, &household).await).store else {
            return not_found();
        };
        tri!(
            blocking("exclusive retirement door", move || {
                let (record, raw) = read::<Record>(household_store.as_ref(), RESET)?
                    .ok_or_else(|| StoreError::Invalid("exclusive_precondition".into()))?;
                if record.phase != Phase::Committed {
                    return Err(StoreError::Invalid("exclusive_precondition".into()));
                }
                let mut next = record.clone();
                next.phase = Phase::Retiring;
                let mut edit = ExclusiveEdit::new(LockExpect::Held(record.owner.clone()), LockChange::Keep);
                edit.expect_records.push((RESET.to_owned(), Some(raw)));
                put(&mut edit, RESET.to_owned(), &next);
                household_store.exclusive_commit(&edit)
            })
            .await
        );
    }

    let tombstone = Marker {
        successor: successor.to_owned(),
        exclusive: Tombstone {
            lock: record.lock.clone(),
            acquired: record.attempt.clone(),
            owner: if record.role == Role::Household { record.owner.clone() } else { attempt.to_owned() },
            role: record.role,
            household: record.household.clone(),
            chain: record.chain.clone(),
            members: record.members.clone(),
        },
    };
    let marker = serde_json::to_vec(&tombstone).expect("a marker always serialises");
    drop(store);
    retire_owned_marked(state, id, &set.slots[index], &mut guards[index], selected_v3, &marker, recovery)
        .await
}

// ---------------------------------------------------------------------------------------------------------------
// Ordinary writes

/// Whether a lock is in force on this library, which refuses every mutation that is not an effect of the owning
/// operation. A member lock whose household has aborted is void: it is cleared here, on first access, and the
/// write that found it proceeds.
pub(super) async fn write_blocked(
    state: &AppState,
    id: &str,
    store: &Arc<dyn LibraryStore>,
) -> io::Result<bool> {
    for _ in 0..3 {
        let read_store = Arc::clone(store);
        let (key, record) = tokio::task::spawn_blocking(move || {
            // The common case, a library nobody locked, costs the one read it always did.
            let Some(key) = read_store.exclusive_operation_lock()? else { return Ok((None, None)) };
            Ok::<_, StoreError>((Some(key), read::<Record>(read_store.as_ref(), RESET)?))
        })
        .await
        .map_err(io::Error::other)?
        .map_err(v3_io)?;
        let Some(key) = key else { return Ok(false) };
        // A retired library whose database is still being removed holds no lock: it answers `410` instead.
        if retired(state, id).await? {
            return Ok(false);
        }
        let Some((record, raw)) = record else { return Ok(true) };
        if record.role != Role::Profile || record.phase != Phase::Open || key != record.attempt {
            return Ok(true);
        }
        let Some(household) = record.household.clone() else { return Ok(true) };
        let household = peer(state, &household).await?;
        let verdict = {
            let member = record.clone();
            tokio::task::spawn_blocking(move || household_voids(&household, Some(&member)))
                .await
                .map_err(io::Error::other)?
                .map_err(v3_io)?
        };
        if !verdict {
            return Ok(true);
        }
        let clear_store = Arc::clone(store);
        let cleared = tokio::task::spawn_blocking(move || clear_void(clear_store.as_ref(), &record, raw))
            .await
            .map_err(io::Error::other)?;
        match cleared {
            Ok(()) => return Ok(false),
            // Another request changed the library first: look again.
            Err(StoreError::Invalid(message)) if message == "exclusive_precondition" => {}
            Err(StoreError::Locked) => {}
            Err(reason) => return Err(v3_io(reason)),
        }
    }
    Ok(true)
}

/// Clear a member lock its household voided: the key is released and the record keeps only the tombstone.
fn clear_void(store: &dyn LibraryStore, record: &Record, raw: Vec<u8>) -> Result<(), StoreError> {
    let mut next = record.clone();
    next.phase = Phase::Aborted;
    let mut edit = ExclusiveEdit::new(LockExpect::Held(record.attempt.clone()), LockChange::Clear);
    edit.expect_records.push((RESET.to_owned(), Some(raw)));
    put(&mut edit, RESET.to_owned(), &next);
    if let Some((mut entry, _)) = read::<Entry>(store, &entry_key(&record.attempt))? {
        entry.state = EntryState::Aborted;
        put(&mut edit, entry_key(&record.attempt), &entry);
    }
    store.exclusive_commit(&edit)
}

// ---------------------------------------------------------------------------------------------------------------
// Successor sweep

async fn write_hint(state: &AppState, household: &str) {
    let written = async {
        state.store.replace_file(HINT_NS, &hint_key(household), HINT_EXT, household.as_bytes()).await?;
        state.store.sync_dir(HINT_NS).await
    };
    if let Err(reason) = written.await {
        eprintln!("key reset sweep hint: {reason}");
    }
}

async fn clear_hint(state: &AppState, household: &str) {
    for namespace in [HINT_NS, LEGACY_HINT_NS] {
        if let Err(reason) = state.store.delete_file(namespace, &hint_key(household), HINT_EXT).await {
            eprintln!("key reset sweep hint: {reason}");
        }
    }
}

fn note_sweep(state: &AppState, household: &str) {
    crate::lock(&state.reset_sweeps).insert(household.to_owned());
}

/// On the next access to a household whose reset ended without retiring: delete what it owes.
pub(super) async fn sweep_if_due(state: &AppState, id: &str) {
    let due = crate::lock(&state.reset_sweeps).contains(id);
    if due {
        if let Err(reason) = sweep(state, id).await {
            eprintln!("key reset sweep: library={} {reason}", &id[..id.len().min(8)]);
        }
    }
}

/// Delete every declared successor of an aborted or rolled-back reset, then record that the household is swept.
/// Each deletion is its own idempotent commit on its own library; only the final record is the household's.
pub(super) async fn sweep(state: &AppState, household: &str) -> io::Result<()> {
    let found = peer(state, household).await?;
    let Some(store) = found.store else {
        crate::lock(&state.reset_sweeps).remove(household);
        clear_hint(state, household).await;
        return Ok(());
    };
    let read_store = Arc::clone(&store);
    let owed = tokio::task::spawn_blocking(move || read::<Owed>(read_store.as_ref(), SWEEP))
        .await
        .map_err(io::Error::other)?
        .map_err(v3_io)?;
    let Some((owed, raw)) = owed else {
        crate::lock(&state.reset_sweeps).remove(household);
        clear_hint(state, household).await;
        return Ok(());
    };
    for successor in &owed.successors {
        delete_successor(state, successor).await?;
    }
    for member in &owed.members {
        clear_void_member(state, member, &owed.attempt).await?;
    }
    // The household's lock slot serializes this with a new acquire; the compare-and-set keeps a newer list.
    let set = SlotSet::new(state, [household]);
    let _guards = set.lock().await;
    let done_store = Arc::clone(&store);
    let committed = tokio::task::spawn_blocking(move || {
        let mut edit = ExclusiveEdit::new(LockExpect::Any, LockChange::Keep);
        edit.expect_records.push((SWEEP.to_owned(), Some(raw)));
        edit.remove.push(SWEEP.to_owned());
        done_store.exclusive_commit(&edit)
    })
    .await
    .map_err(io::Error::other)?;
    match committed {
        Ok(()) => {}
        // A newer list replaced it: the next access sweeps that one.
        Err(StoreError::Invalid(message)) if message == "exclusive_precondition" => return Ok(()),
        Err(reason) => return Err(v3_io(reason)),
    }
    crate::lock(&state.reset_sweeps).remove(household);
    clear_hint(state, household).await;
    Ok(())
}

/// Clear a member's lock if it is still the one of the reset the household decided against. By then it is void by
/// rule; clearing it leaves a library nobody writes to without a stale key.
async fn clear_void_member(state: &AppState, member: &str, attempt: &str) -> io::Result<()> {
    let found = peer(state, member).await?;
    let Some(store) = found.store else { return Ok(()) };
    let attempt = attempt.to_owned();
    let cleared = tokio::task::spawn_blocking(move || {
        let key = store.exclusive_operation_lock()?;
        match read::<Record>(store.as_ref(), RESET)? {
            Some((record, raw))
                if key.as_deref() == Some(record.attempt.as_str())
                    && record.role == Role::Profile
                    && record.phase == Phase::Open
                    && record.attempt == attempt =>
            {
                clear_void(store.as_ref(), &record, raw)
            }
            _ => Ok(()),
        }
    })
    .await
    .map_err(io::Error::other)?;
    match cleared {
        Ok(()) => Ok(()),
        // Another request changed that library first: it is no longer this reset's to clear.
        Err(StoreError::Invalid(message)) if message == "exclusive_precondition" => Ok(()),
        Err(StoreError::Locked) => Ok(()),
        Err(reason) => Err(v3_io(reason)),
    }
}

/// Retire one declared successor library if it exists. A successor that was never created, or already retired,
/// is skipped: the sweep may run any number of times.
async fn delete_successor(state: &AppState, id: &str) -> io::Result<()> {
    let found = peer(state, id).await?;
    if found.marker.is_some() || found.store.is_none() {
        return Ok(());
    }
    drop(found);
    let recovery = state.recovery_lock.lock().await;
    let slot = state.libraries.slot(id, state.now());
    let mut library = slot.library.lock().await;
    let selected = authority(state, &slot, id).await?;
    if selected == AUTHORITY_MOVED {
        return Ok(());
    }
    let response =
        retire_owned_marked(state, id, &slot, &mut library, selected == AUTHORITY_V3, b"", recovery).await;
    if response.status() == StatusCode::OK {
        Ok(())
    } else {
        Err(io::Error::other(format!("successor library retirement answered {}", response.status())))
    }
}

/// At startup: every hint names a household that may owe a sweep; the household's own record decides.
pub async fn sweep_startup(state: Arc<AppState>) {
    let mut hinted = Vec::new();
    for namespace in [HINT_NS, LEGACY_HINT_NS] {
        let Ok(mut entries) = tokio::fs::read_dir(state.store.namespace_dir(namespace)).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != HINT_EXT) {
                continue;
            }
            match tokio::fs::read_to_string(&path).await {
                Ok(household) if valid_hex_id(household.trim()) => hinted.push(household.trim().to_owned()),
                Ok(_) | Err(_) => {}
            }
        }
    }
    hinted.sort();
    hinted.dedup();
    for household in hinted {
        crate::lock(&state.reset_sweeps).insert(household.clone());
        if let Err(reason) = sweep(&state, &household).await {
            eprintln!("key reset sweep: library={} {reason}", &household[..household.len().min(8)]);
        }
    }
}

/// Whether starting library `id` with the member proof of `prover` is the work of a key reset that is running now.
/// A reset starts one successor per live library in one go, so those are not new storage in the sense of the
/// per-address new-library budget. Exactly two proofs count, and each only for what it declared:
///
/// * the household's own, for any successor its live (`open` or `committed`) lock declared; and
/// * a member library's, for the one successor its own lock declares, while its household's lock is live and of the
///   same attempt (this is the proof `takeMoved` sends: the library the new one is moved from).
///
/// A successor that already existed when the lock was acquired was not made by the reset, and an ended or retiring
/// lock declares nothing to start; both are ordinary new libraries.
pub(super) async fn declared_successor(state: &AppState, prover: &str, id: &str) -> bool {
    if !state.profile_reset_enabled {
        return false;
    }
    match declares(state, prover, id).await {
        Ok(declared) => declared,
        Err(reason) => {
            eprintln!("key reset successor check: {reason}");
            false
        }
    }
}

async fn record_of(state: &AppState, id: &str) -> io::Result<Option<Record>> {
    let Some(store) = peer(state, id).await?.store else { return Ok(None) };
    tokio::task::spawn_blocking(move || read::<Record>(store.as_ref(), RESET))
        .await
        .map_err(io::Error::other)?
        .map(|found| found.map(|(record, _)| record))
        .map_err(v3_io)
}

async fn declares(state: &AppState, prover: &str, id: &str) -> io::Result<bool> {
    let Some(record) = record_of(state, prover).await? else { return Ok(false) };
    let live = |record: &Record| matches!(record.phase, Phase::Open | Phase::Committed);
    let made_by_reset = |record: &Record| !record.preexisting.contains(&id.to_owned());
    match record.role {
        Role::Household => Ok(live(&record)
            && made_by_reset(&record)
            && (record.successor == id || record.members.iter().any(|member| member.successor == id))),
        Role::Profile => {
            if record.phase != Phase::Open || record.successor != id {
                return Ok(false);
            }
            let Some(household) = record.household.as_deref() else { return Ok(false) };
            let Some(house) = record_of(state, household).await? else { return Ok(false) };
            Ok(house.role == Role::Household
                && live(&house)
                && house.attempt == record.attempt
                && made_by_reset(&house)
                && house.members.iter().any(|member| member.library_id == prover && member.successor == id))
        }
    }
}

/// The wire minimum an exclusive-operation route requires of the library it names: 5 for a household, 4 for a
/// profile library. `None` below 4: such a library is never part of a key reset.
pub(super) fn required_wire(wire_min: u64) -> Option<u64> {
    match wire_min {
        0..=3 => None,
        4 => Some(4),
        _ => Some(5),
    }
}

/// `x-den-exclusive-attempt` on a `DELETE` selects a key reset's retirement, with the `x-den-successor` it names (an
/// absent or unusable one never matches the declared successor). `Err` when the attempt itself is malformed.
#[allow(clippy::result_unit_err)]
pub(super) fn retire_headers(headers: &axum::http::HeaderMap) -> Result<Option<(String, String)>, ()> {
    let Some(attempt) = headers.get("x-den-exclusive-attempt") else { return Ok(None) };
    let attempt = attempt.to_str().map_err(|_| ())?;
    if !model::valid_id32(attempt) {
        return Err(());
    }
    let successor = headers
        .get("x-den-successor")
        .and_then(|value| value.to_str().ok())
        .filter(|successor| valid_hex_id(successor))
        .unwrap_or_default();
    Ok(Some((attempt.to_owned(), successor.to_owned())))
}
