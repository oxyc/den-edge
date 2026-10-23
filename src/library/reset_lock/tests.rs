//! Tests for the key-reset lock set (den-spec `wire/profiles-v1.md` §9.1).
//!
//! * `vectors`: every case of the spec's `resetLockContract`, through the same `model::step` the handlers decide
//!   with.
//! * everything else drives the real handlers in process (the way the profile-migration tests do): the full
//!   rehearsals, the proofless rollback, each window of the spec's crash table across a restart, and the
//!   exclusion between key-reset and migration locks.

use super::model::{Decision, Phase, Req, World};
use super::*;
use crate::handler::tests::{body_json, Harness};
use crate::library::v3::{LockChange, LockExpect};
use axum::http::StatusCode;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------------------------------
// The spec's vectors

fn contract() -> Value {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/profiles-v1.json")).unwrap();
    vectors["resetLockContract"].clone()
}

fn set_pointer(world: &mut Value, mutation: &Value) {
    let path = mutation["path"].as_str().unwrap();
    *world.pointer_mut(path).unwrap_or_else(|| panic!("no such path {path}")) = mutation["value"].clone();
}

fn expected_json(decision: &Decision) -> Value {
    match decision {
        Decision::Lookup => json!({ "effect": "lookup" }),
        Decision::Refused { status, error } => {
            json!({ "effect": "refused", "status": status, "error": error, "sideEffects": [] })
        }
        Decision::Open { preexisting: None } => json!({ "effect": "open", "sideEffects": ["lock"] }),
        Decision::Open { preexisting: Some(existing) } => {
            json!({ "effect": "open", "sideEffects": ["lock"], "preexisting": existing })
        }
        Decision::Rendered { state } => json!({ "effect": "lookup", "state": state }),
        Decision::Takeover { phase } => {
            json!({ "effect": "takeover", "phase": phase, "sideEffects": ["owner-replaced"] })
        }
        Decision::Rollback => {
            json!({ "effect": "rollback", "phase": "committed", "sideEffects": ["household-aborted"] })
        }
        Decision::Committed => json!({ "effect": "committed", "sideEffects": ["phase-committed"] }),
        Decision::Aborted => json!({ "effect": "aborted", "sideEffects": ["household-aborted"] }),
        Decision::Allowed => json!({ "effect": "allowed", "sideEffects": [] }),
        Decision::Sweep { delete } => json!({
            "effect": "sweep",
            "delete": delete,
            "sideEffects": ["successors-deleted", "household-swept"],
        }),
        Decision::Nothing => json!({ "effect": "none", "sideEffects": [] }),
        Decision::OrdinaryDelete => {
            json!({ "effect": "ordinary-delete", "sideEffects": ["library-retired"] })
        }
        Decision::Retired { door } => {
            let mut effects = Vec::new();
            if *door {
                effects.push("household-retiring");
            }
            effects.extend(["library-retired", "lock-released"]);
            json!({ "effect": "retired", "sideEffects": effects })
        }
    }
}

#[test]
fn every_reset_lock_vector_decides_as_the_spec_says() {
    let contract = contract();
    let cases = contract["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 100, "the spec's vector set changed: map the new cases to tests");
    // The contract flags the implementation commits to.
    assert_eq!(contract["sweepSkipsPreexistingSuccessors"], json!(true));
    assert_eq!(contract["lookupRendersRetiringAs"], json!("committed"));
    assert_eq!(contract["keyResetRetiredBodyNamesSuccessor"], json!(false));
    assert_eq!(contract["malformedAttemptStatus"], json!(400));
    assert_eq!(contract["retireCarriesGeneration"], json!(true));
    let mut checked = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut world = contract["worldBase"].clone();
        for (library, overrides) in
            contract["scenarios"][case["scenario"].as_str().unwrap()].as_object().unwrap()
        {
            for (field, value) in overrides.as_object().unwrap() {
                world["libraries"][library][field] = value.clone();
            }
        }
        for mutation in case["mutations"].as_array().into_iter().flatten() {
            set_pointer(&mut world, mutation);
        }
        let world: World = serde_json::from_value(world).unwrap_or_else(|reason| panic!("{name}: {reason}"));
        let request: Req = serde_json::from_value(case["request"].clone()).unwrap();
        let decided = model::step(&world, &request);
        match (&decided, case.get("error"), case.get("expect")) {
            (Err(invalid), Some(error), None) => {
                assert_eq!(invalid.code(), error.as_str().unwrap(), "{name}")
            }
            (Ok(decision), None, Some(expect)) => assert_eq!(&expected_json(decision), expect, "{name}"),
            other => panic!("{name}: the model answered {other:?}"),
        }
        checked += 1;
    }
    assert_eq!(checked, cases.len());
}

#[test]
fn the_vector_world_is_the_one_the_handlers_build() {
    // Every field of every scenario lock must deserialize: a vector the model silently ignored would pass above.
    let contract = contract();
    for (name, scenario) in contract["scenarios"].as_object().unwrap() {
        let mut world = contract["worldBase"].clone();
        for (library, overrides) in scenario.as_object().unwrap() {
            for (field, value) in overrides.as_object().unwrap() {
                world["libraries"][library][field] = value.clone();
            }
        }
        let parsed: World =
            serde_json::from_value(world.clone()).unwrap_or_else(|reason| panic!("{name}: {reason}"));
        let lock_count =
            world["libraries"].as_object().unwrap().values().filter(|lib| !lib["lock"].is_null()).count();
        assert_eq!(parsed.libraries.values().filter(|lib| lib.lock.is_some()).count(), lock_count, "{name}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures for the real handlers

const HOUSEHOLD: &str = "5e1ab5db12f9b30e640e3ee80fb3e072";
const OWNER: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const KID1: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const KID2: &str = "b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4";
const NEW_HOUSEHOLD: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const NEW_OWNER: &str = "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1";
const NEW_KID1: &str = "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
const NEW_KID2: &str = "f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4";
const ATTEMPT: &str = "0123456789abcdef0123456789abcdef";
const OTHER: &str = "11111111111111111111111111111111";
const RECOVERY: &str = "fedcba9876543210fedcba9876543210";
const RECOVERY2: &str = "22222222222222222222222222222222";
const ROW: &str = "aaaaaaaaaaaaaaaa";

fn token_of(id: &str) -> String {
    format!("token-of-{id}")
}

fn hash_of(id: &str) -> [u8; 32] {
    Sha256::digest(token_of(id).as_bytes()).into()
}

fn is_household(id: &str) -> bool {
    id == HOUSEHOLD || id == NEW_HOUSEHOLD
}

fn wire_of(id: &str) -> &'static str {
    if is_household(id) {
        "5"
    } else {
        "4"
    }
}

fn old_members() -> Vec<(&'static str, &'static str)> {
    vec![(OWNER, NEW_OWNER), (KID1, NEW_KID1), (KID2, NEW_KID2)]
}

fn members_json() -> Value {
    json!(old_members()
        .iter()
        .map(|(old, new)| json!({ "libraryId": old, "successor": new }))
        .collect::<Vec<_>>())
}

/// The key reset on and the profile migration off: nothing a reset does may lean on the migration's switch.
fn enabled(dir: std::path::PathBuf) -> Harness {
    Harness::in_dir_with(dir, |state| state.profile_reset_enabled = true)
}

fn new_harness() -> Harness {
    enabled(crate::handler::tests::temp_dir())
}

/// A restarted process over the same data: nothing in memory survives, everything on disk does.
fn restart(h: &Harness) -> Harness {
    enabled(h.dir.clone())
}

async fn call(
    h: &Harness,
    method: &str,
    path: &str,
    token_for: &str,
    wire: &str,
    body: Option<Value>,
    extra: &[(&str, &str)],
) -> (StatusCode, Value) {
    let token = token_of(token_for);
    let mut headers: Vec<(&str, &str)> = vec![("x-den-wire", wire), ("x-den-library-token", &token)];
    headers.extend_from_slice(extra);
    let response = h.send(method, path, body.map(|body| body.to_string()), &headers).await;
    let status = response.status();
    (status, body_json(response).await)
}

async fn create(h: &Harness, id: &str) {
    // A minute passes between libraries: an address may start only a few a minute.
    h.advance(61_000);
    let token = token_of(id);
    let wire = wire_of(id);
    let response = h
        .send(
            "POST",
            &format!("/lib/{id}/batch"),
            Some(json!({ "writes": [{ "k": ROW, "base": 0, "v": "first" }] }).to_string()),
            &[
                ("x-den-wire", wire),
                ("x-den-wire-min", wire),
                ("x-den-generation", "0"),
                ("x-den-library-token", &token),
            ],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK, "creating {id}");
}

fn store_of(h: &Harness, id: &str) -> Arc<dyn LibraryStore> {
    h.state.library_v3.existing_library(id, hash_of(id)).unwrap()
}

fn generation_of(h: &Harness, id: &str) -> String {
    let protocol = store_of(h, id).protocol().unwrap();
    super::super::full_generation(&h.state, &protocol.generation)
}

fn head_of(h: &Harness, id: &str) -> u64 {
    store_of(h, id).protocol().unwrap().head
}

/// An ordinary write to the library's one row, at its current sequence.
async fn write(h: &Harness, id: &str, value: &str) -> (StatusCode, Value) {
    let base = store_of(h, id).latest(ROW).unwrap().map_or(0, |row| row.sequence);
    let generation = generation_of(h, id);
    call(
        h,
        "POST",
        &format!("/lib/{id}/batch"),
        id,
        wire_of(id),
        Some(json!({ "writes": [{ "k": ROW, "base": base, "v": value }] })),
        &[("x-den-generation", &generation)],
    )
    .await
}

async fn changes(h: &Harness, id: &str) -> (StatusCode, Value) {
    call(h, "GET", &format!("/lib/{id}/changes?since=0"), id, wire_of(id), None, &[]).await
}

async fn build_old_set(h: &Harness) {
    for id in [HOUSEHOLD, OWNER, KID1, KID2] {
        create(h, id).await;
    }
}

/// The successors the executor copies into, each with a row; the household's at minimum 5.
async fn build_successors(h: &Harness) {
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        create(h, id).await;
    }
}

async fn source_of(h: &Harness, id: &str) -> Value {
    let (status, body) =
        call(h, "GET", &format!("/lib/{id}/exclusive-operation/source"), id, wire_of(id), None, &[]).await;
    assert_eq!(status, StatusCode::OK, "source of {id}: {body}");
    body["source"].clone()
}

fn household_request(attempt: &str, source: Value) -> Value {
    json!({
        "attempt": attempt,
        "purpose": "key-reset",
        "role": "household",
        "expectedSource": source,
        "successor": NEW_HOUSEHOLD,
        "members": members_json(),
    })
}

fn profile_request(attempt: &str, source: Value, successor: &str) -> Value {
    json!({
        "attempt": attempt,
        "purpose": "key-reset",
        "role": "profile",
        "expectedSource": source,
        "successor": successor,
        "household": HOUSEHOLD,
    })
}

async fn post_lock(h: &Harness, id: &str, body: Value) -> (StatusCode, Value) {
    call(h, "POST", &format!("/lib/{id}/exclusive-operation"), id, wire_of(id), Some(body), &[]).await
}

async fn acquire_household(h: &Harness, attempt: &str) -> (StatusCode, Value) {
    let source = source_of(h, HOUSEHOLD).await;
    post_lock(h, HOUSEHOLD, household_request(attempt, source)).await
}

async fn acquire_member(h: &Harness, attempt: &str, id: &str, successor: &str) -> (StatusCode, Value) {
    let source = source_of(h, id).await;
    post_lock(h, id, profile_request(attempt, source, successor)).await
}

async fn acquire_all(h: &Harness, attempt: &str) {
    let (status, body) = acquire_household(h, attempt).await;
    assert_eq!(status, StatusCode::OK, "household acquire: {body}");
    for (old, new) in old_members() {
        let (status, body) = acquire_member(h, attempt, old, new).await;
        assert_eq!(status, StatusCode::OK, "{old} acquire: {body}");
    }
}

async fn lookup(h: &Harness, id: &str, attempt: &str) -> (StatusCode, Value) {
    call(h, "GET", &format!("/lib/{id}/exclusive-operation/{attempt}"), id, wire_of(id), None, &[]).await
}

async fn commit(h: &Harness, attempt: &str, successor: &str) -> (StatusCode, Value) {
    call(
        h,
        "POST",
        &format!("/lib/{HOUSEHOLD}/exclusive-operation/{attempt}/successor"),
        HOUSEHOLD,
        "5",
        Some(json!({ "successor": successor })),
        &[],
    )
    .await
}

async fn abort(h: &Harness, attempt: &str) -> (StatusCode, Value) {
    call(h, "DELETE", &format!("/lib/{HOUSEHOLD}/exclusive-operation/{attempt}"), HOUSEHOLD, "5", None, &[])
        .await
}

async fn retire(h: &Harness, id: &str, attempt: &str, successor: &str) -> (StatusCode, Value) {
    let generation = if h.state.library_v3.path(id).exists() { generation_of(h, id) } else { "0".to_owned() };
    call(
        h,
        "DELETE",
        &format!("/lib/{id}"),
        id,
        wire_of(id),
        None,
        &[
            ("x-den-exclusive-attempt", attempt),
            ("x-den-successor", successor),
            ("x-den-generation", &generation),
        ],
    )
    .await
}

/// A recovery attempt: observe the household source, optionally prove the successor key, take the lock over.
async fn recover(h: &Harness, attempt: &str, proof: Option<&str>) -> (StatusCode, Value) {
    let source = source_of(h, HOUSEHOLD).await;
    let body = json!({
        "attempt": attempt,
        "purpose": "key-reset-recovery",
        "role": "household",
        "expectedSource": source,
    });
    let token = token_of(HOUSEHOLD);
    let mut headers: Vec<(&str, &str)> = vec![("x-den-wire", "5"), ("x-den-library-token", &token)];
    let proof_token;
    if let Some(proof) = proof {
        proof_token = token_of(proof);
        headers.push((SUCCESSOR_TOKEN_HEADER, &proof_token));
    }
    let response = h
        .send("POST", &format!("/lib/{HOUSEHOLD}/exclusive-operation"), Some(body.to_string()), &headers)
        .await;
    let status = response.status();
    (status, body_json(response).await)
}

fn lock_key(h: &Harness, id: &str) -> Option<String> {
    store_of(h, id).exclusive_operation_lock().unwrap()
}

fn assert_in_progress(response: &(StatusCode, Value)) {
    assert_eq!(response.0, StatusCode::CONFLICT, "{}", response.1);
    assert_eq!(response.1, json!({ "error": "migration_in_progress" }));
}

fn assert_moved(response: &(StatusCode, Value)) {
    assert_eq!(response.0, StatusCode::GONE, "{}", response.1);
    assert_eq!(response.1, json!({ "error": "library_moved" }));
}

async fn assert_all_writable(h: &Harness) {
    for (n, id) in [HOUSEHOLD, OWNER, KID1, KID2].into_iter().enumerate() {
        let (status, body) = write(h, id, &format!("unlocked-{n}")).await;
        assert_eq!(status, StatusCode::OK, "{id} must accept writes: {body}");
    }
}

async fn assert_all_refuse_writes(h: &Harness) {
    for id in [HOUSEHOLD, OWNER, KID1, KID2] {
        assert_in_progress(&write(h, id, "refused").await);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Dormancy, gates and the generic primitive

#[tokio::test]
async fn the_reset_surface_does_not_exist_while_its_gate_is_off() {
    let h = Harness::new();
    build_old_set(&h).await;
    let (status, body) =
        call(&h, "GET", &format!("/lib/{HOUSEHOLD}/exclusive-operation/source"), HOUSEHOLD, "5", None, &[])
            .await;
    assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    // The headers of a retirement mean nothing: the library is simply deleted, as before the feature existed.
    let (status, body) = retire(&h, OWNER, ATTEMPT, NEW_OWNER).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "deleted": true })));
    let (status, body) = changes(&h, OWNER).await;
    assert_eq!((status, &body["error"]), (StatusCode::GONE, &json!("library_moved")));
}

#[tokio::test]
async fn wire_and_library_kind_gate_the_surface() {
    let h = new_harness();
    build_old_set(&h).await;
    let path = format!("/lib/{HOUSEHOLD}/exclusive-operation/source");
    let (status, body) = call(&h, "GET", &path, HOUSEHOLD, "4", None, &[]).await;
    assert_eq!(
        (status, body),
        (StatusCode::UPGRADE_REQUIRED, json!({ "error": "upgrade_required", "min": 5 }))
    );
    let (status, body) =
        call(&h, "GET", &format!("/lib/{KID1}/exclusive-operation/source"), KID1, "5", None, &[]).await;
    assert_eq!(
        (status, body),
        (StatusCode::UPGRADE_REQUIRED, json!({ "error": "upgrade_required", "min": 4 }))
    );
    // A library nobody has written, and a legacy household below minimum 4, are not part of any reset.
    let (status, _) = call(
        &h,
        "GET",
        "/lib/9999999999999999/exclusive-operation/source",
        "9999999999999999",
        "5",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let legacy = "7777777777777777";
    let response = h
        .send(
            "POST",
            &format!("/lib/{legacy}/batch"),
            Some(json!({ "writes": [{ "k": ROW, "base": 0, "v": "legacy" }] }).to_string()),
            &[("x-den-library-token", &token_of(legacy))],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let (status, _) =
        call(&h, "GET", &format!("/lib/{legacy}/exclusive-operation/source"), legacy, "5", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // The token is the library's own.
    let (status, _) = call(&h, "GET", &path, KID1, "5", None, &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_household_cannot_be_locked_as_a_profile_nor_the_reverse() {
    let h = new_harness();
    build_old_set(&h).await;
    let source = source_of(&h, KID1).await;
    let (status, body) = post_lock(&h, KID1, household_request(ATTEMPT, source)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let source = source_of(&h, HOUSEHOLD).await;
    let (status, _) = post_lock(&h, HOUSEHOLD, profile_request(ATTEMPT, source, NEW_OWNER)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(lock_key(&h, HOUSEHOLD), None);
    assert_eq!(lock_key(&h, KID1), None);
}

#[test]
fn the_generic_commit_is_all_or_nothing_and_checks_its_preconditions() {
    let dir = crate::handler::tests::temp_dir();
    let manager = crate::library::v3::StoreManager::open(&dir, 4 << 20, 32 << 20, 8 << 20).unwrap();
    let store = manager.library("1111111111111111", [7; 32]).unwrap();
    let mut edit = ExclusiveEdit::new(LockExpect::Absent, LockChange::Set("holder".into()));
    edit.put.push(("exclusive:one".into(), b"1".to_vec()));
    store.exclusive_commit(&edit).unwrap();
    assert_eq!(store.exclusive_operation_lock().unwrap().as_deref(), Some("holder"));
    assert_eq!(store.exclusive_record("exclusive:one").unwrap().as_deref(), Some(&b"1"[..]));

    // A held lock refuses an `Absent` edit whole: its record writes do not land.
    let mut refused = ExclusiveEdit::new(LockExpect::Absent, LockChange::Keep);
    refused.put.push(("exclusive:two".into(), b"2".to_vec()));
    assert!(matches!(store.exclusive_commit(&refused), Err(StoreError::Locked)));
    assert_eq!(store.exclusive_record("exclusive:two").unwrap(), None);

    // A stale record precondition refuses the edit whole, lock change included.
    let mut stale = ExclusiveEdit::new(LockExpect::Held("holder".into()), LockChange::Clear);
    stale.expect_records.push(("exclusive:one".into(), Some(b"other".to_vec())));
    assert!(matches!(store.exclusive_commit(&stale), Err(StoreError::Invalid(_))));
    assert_eq!(store.exclusive_operation_lock().unwrap().as_deref(), Some("holder"));

    // A source precondition is the lock primitive's own fence.
    let protocol = store.protocol().unwrap();
    let mut moved = ExclusiveEdit::new(LockExpect::Any, LockChange::Keep);
    moved.expect_source = Some((protocol.migration_generation + 1, protocol.head));
    assert!(
        matches!(store.exclusive_commit(&moved), Err(StoreError::Invalid(message)) if message == "migration_source_changed")
    );

    // Records outside the namespace are not this primitive's to touch.
    let mut foreign = ExclusiveEdit::new(LockExpect::Any, LockChange::Keep);
    foreign.put.push(("token".into(), vec![0]));
    assert!(store.exclusive_commit(&foreign).is_err());
    assert!(store.exclusive_record("token").is_err());

    let mut release = ExclusiveEdit::new(LockExpect::Held("holder".into()), LockChange::Clear);
    release.remove.push("exclusive:one".into());
    store.exclusive_commit(&release).unwrap();
    assert_eq!(store.exclusive_operation_lock().unwrap(), None);
    assert_eq!(store.exclusive_record("exclusive:one").unwrap(), None);
}

// ---------------------------------------------------------------------------------------------------------------
// Acquire

#[tokio::test]
async fn acquire_is_exact_replayable_and_blocks_everyone_else() {
    let h = new_harness();
    build_old_set(&h).await;
    let source = source_of(&h, HOUSEHOLD).await;
    let head = head_of(&h, HOUSEHOLD);
    let (status, opened) = post_lock(&h, HOUSEHOLD, household_request(ATTEMPT, source.clone())).await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    assert_eq!(opened["attempt"], ATTEMPT);
    assert_eq!(opened["state"], "open");
    assert_eq!(opened["purpose"], "key-reset");
    assert_eq!(opened["role"], "household");
    assert_eq!(opened["library"], HOUSEHOLD);
    assert_eq!(opened["wireMin"], 5);
    assert!(opened["lock"].as_str().unwrap().starts_with("lock-"));
    assert!(opened["lock"].as_str().unwrap().len() >= "lock-".len() + 32, "at least 128 random bits");
    assert_eq!(
        opened["fence"],
        json!({ "generation": source["generation"], "base": head, "head": source["head"] })
    );
    assert_eq!(opened["successor"], NEW_HOUSEHOLD);
    assert_eq!(opened["members"], members_json());
    assert_eq!(lock_key(&h, HOUSEHOLD).as_deref(), Some(ATTEMPT));
    assert_eq!(head_of(&h, HOUSEHOLD), head, "acquisition advances no counter");

    // Lookup first: the same attempt gets the stored answer even after the library moved on (it cannot here, so
    // the replay is byte-identical), a lookup agrees, and any other declaration under it is a mismatch.
    let (status, replay) = post_lock(&h, HOUSEHOLD, household_request(ATTEMPT, source.clone())).await;
    assert_eq!((status, &replay), (StatusCode::OK, &opened));
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await, (StatusCode::OK, opened.clone()));
    let mut changed = household_request(ATTEMPT, source.clone());
    changed["successor"] = json!("f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0");
    let (status, body) = post_lock(&h, HOUSEHOLD, changed).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "migration_attempt_mismatch" })));

    // A different attempt learns nothing, whatever source it presents, and nothing changes.
    let wrong = json!({ "generation": 0, "head": "9".repeat(64) });
    for source in [source.clone(), wrong] {
        assert_in_progress(&post_lock(&h, HOUSEHOLD, household_request(OTHER, source)).await);
    }
    assert_eq!(lookup(&h, HOUSEHOLD, OTHER).await.0, StatusCode::NOT_FOUND);
    assert_eq!(lock_key(&h, HOUSEHOLD).as_deref(), Some(ATTEMPT));

    // Reads continue; every mutation of the household is refused with the one metadata-free answer.
    assert_eq!(changes(&h, HOUSEHOLD).await.0, StatusCode::OK);
    assert_in_progress(&write(&h, HOUSEHOLD, "refused").await);
    assert_in_progress(
        &call(
            &h,
            "PUT",
            &format!("/lib/{HOUSEHOLD}/member"),
            HOUSEHOLD,
            "5",
            None,
            &[("x-den-generation", &generation_of(&h, HOUSEHOLD))],
        )
        .await,
    );
    assert_in_progress(
        &call(&h, "POST", &format!("/lib/{HOUSEHOLD}/rewrite"), HOUSEHOLD, "5", None, &[]).await,
    );
    assert_in_progress(&call(&h, "DELETE", &format!("/lib/{HOUSEHOLD}"), HOUSEHOLD, "5", None, &[]).await);
}

#[tokio::test]
async fn a_moved_source_is_refused_without_any_effect() {
    let h = new_harness();
    build_old_set(&h).await;
    let source = source_of(&h, HOUSEHOLD).await;
    assert_eq!(write(&h, HOUSEHOLD, "moved on").await.0, StatusCode::OK);
    let (status, body) = post_lock(&h, HOUSEHOLD, household_request(ATTEMPT, source)).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "migration_source_changed" })));
    assert_eq!(lock_key(&h, HOUSEHOLD), None);
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await.0, StatusCode::NOT_FOUND);
    // Re-observing and retrying succeeds.
    assert_eq!(acquire_household(&h, ATTEMPT).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_declaration_must_be_sorted_distinct_and_non_empty() {
    let h = new_harness();
    build_old_set(&h).await;
    let source = source_of(&h, HOUSEHOLD).await;
    let mut unsorted = household_request(ATTEMPT, source.clone());
    unsorted["members"] = json!([
        { "libraryId": KID1, "successor": NEW_KID1 },
        { "libraryId": OWNER, "successor": NEW_OWNER },
    ]);
    let mut empty = household_request(ATTEMPT, source.clone());
    empty["members"] = json!([]);
    let mut successor_is_old = household_request(ATTEMPT, source.clone());
    successor_is_old["successor"] = json!(OWNER);
    let mut twice = household_request(ATTEMPT, source.clone());
    twice["members"] = json!([
        { "libraryId": OWNER, "successor": NEW_OWNER },
        { "libraryId": KID1, "successor": NEW_OWNER },
    ]);
    let mut bad_attempt = household_request("not-an-attempt", source);
    bad_attempt["members"] = members_json();
    for request in [unsorted, empty, successor_is_old, twice, bad_attempt] {
        let (status, body) = post_lock(&h, HOUSEHOLD, request.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{request}: {body}");
    }
    assert_eq!(lock_key(&h, HOUSEHOLD), None);
}

#[tokio::test]
async fn a_profile_lock_needs_the_open_household_lock_of_its_own_attempt_and_declaration() {
    let h = new_harness();
    build_old_set(&h).await;
    let source = source_of(&h, OWNER).await;
    // No household lock yet.
    assert_in_progress(&post_lock(&h, OWNER, profile_request(ATTEMPT, source.clone(), NEW_OWNER)).await);
    assert_eq!(acquire_household(&h, ATTEMPT).await.0, StatusCode::OK);
    // Another attempt's household lock does not admit this attempt.
    assert_in_progress(&post_lock(&h, OWNER, profile_request(OTHER, source.clone(), NEW_OWNER)).await);
    // A profile the household did not declare, and a successor it declared for another profile, are refused.
    let stranger = "9191919191919191";
    create(&h, stranger).await;
    let stranger_source = source_of(&h, stranger).await;
    assert_in_progress(&post_lock(&h, stranger, profile_request(ATTEMPT, stranger_source, NEW_OWNER)).await);
    assert_in_progress(&post_lock(&h, OWNER, profile_request(ATTEMPT, source.clone(), NEW_KID1)).await);
    assert_eq!(lock_key(&h, OWNER), None);
    assert_eq!(lock_key(&h, stranger), None);

    // The declared profile opens at its exact source; a moved source is retried, not locked.
    assert_eq!(write(&h, OWNER, "moved").await.0, StatusCode::OK);
    let (status, body) = post_lock(&h, OWNER, profile_request(ATTEMPT, source, NEW_OWNER)).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "migration_source_changed" })));
    let (status, opened) = acquire_member(&h, ATTEMPT, OWNER, NEW_OWNER).await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    assert_eq!(opened["role"], "profile");
    assert_eq!(opened["library"], OWNER);
    assert_eq!(opened["wireMin"], 4);
    assert_eq!(opened["household"], HOUSEHOLD);
    assert_eq!(opened["successor"], NEW_OWNER);
    assert!(opened.get("members").is_none());
    assert_eq!(lookup(&h, OWNER, ATTEMPT).await, (StatusCode::OK, opened.clone()));
    let (status, replay) = acquire_member(&h, ATTEMPT, OWNER, NEW_OWNER).await;
    assert_eq!(
        (status, replay),
        (StatusCode::OK, opened),
        "a replay answers even though the source cannot move"
    );
    assert_in_progress(&write(&h, OWNER, "refused").await);
    assert_eq!(changes(&h, OWNER).await.0, StatusCode::OK);
}

#[tokio::test]
async fn an_existing_successor_is_never_swept_but_a_missing_one_is_skipped() {
    let h = new_harness();
    build_old_set(&h).await;
    // The household's successor already exists (somebody else's library), the profiles' do not.
    create(&h, NEW_HOUSEHOLD).await;
    assert_eq!(acquire_household(&h, ATTEMPT).await.0, StatusCode::OK);
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    // The next access sweeps; the library that was not made by the reset is untouched.
    assert_eq!(changes(&h, HOUSEHOLD).await.0, StatusCode::OK);
    assert_eq!(changes(&h, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    assert_eq!(store_of(&h, HOUSEHOLD).exclusive_record(SWEEP).unwrap(), None, "the household is swept");
}

// ---------------------------------------------------------------------------------------------------------------
// Successor commit

#[tokio::test]
async fn the_successor_commit_needs_every_lock_and_a_ready_successor_and_is_recorded_once() {
    let h = new_harness();
    build_old_set(&h).await;
    assert_eq!(acquire_household(&h, ATTEMPT).await.0, StatusCode::OK);
    let (status, _) = acquire_member(&h, ATTEMPT, OWNER, NEW_OWNER).await;
    assert_eq!(status, StatusCode::OK);
    // A member is still unlocked.
    let (status, body) = commit(&h, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "locks_incomplete" })));
    for (old, new) in old_members().into_iter().skip(1) {
        assert_eq!(acquire_member(&h, ATTEMPT, old, new).await.0, StatusCode::OK);
    }
    // The successor household does not exist yet.
    let (status, body) = commit(&h, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "successor_not_ready" })));
    build_successors(&h).await;
    // Another successor than the declared one is a mismatch; another attempt gets the metadata-free refusal.
    let (status, body) = commit(&h, ATTEMPT, NEW_OWNER).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "migration_attempt_mismatch" })));
    assert_in_progress(&commit(&h, OTHER, NEW_HOUSEHOLD).await);
    assert_eq!(
        lookup(&h, HOUSEHOLD, ATTEMPT).await.1["state"],
        "open",
        "a successor that exists is not committed"
    );

    let (status, committed) = commit(&h, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    assert_eq!(committed["state"], "committed");
    assert_eq!(committed["attempt"], ATTEMPT);
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await, (StatusCode::OK, committed.clone()));
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await, (StatusCode::OK, committed));
    // Members keep refusing writes after the commit.
    assert_all_refuse_writes(&h).await;
    // Abort is no longer possible once the successor committed.
    assert_in_progress(&abort(&h, ATTEMPT).await);
}

#[tokio::test]
async fn a_successor_below_minimum_five_or_without_rows_is_not_ready() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    // Created as a minimum-4 library: a household successor must be at 5.
    let token = token_of(NEW_HOUSEHOLD);
    let response = h
        .send(
            "POST",
            &format!("/lib/{NEW_HOUSEHOLD}/batch"),
            Some(json!({ "writes": [{ "k": ROW, "base": 0, "v": "x" }] }).to_string()),
            &[
                ("x-den-wire", "4"),
                ("x-den-wire-min", "4"),
                ("x-den-generation", "0"),
                ("x-den-library-token", &token),
            ],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let (status, body) = commit(&h, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "successor_not_ready" })));
}

// ---------------------------------------------------------------------------------------------------------------
// Abort, lazy void member locks and the successor sweep

#[tokio::test]
async fn abort_is_one_household_commit_that_frees_every_member_at_once_and_is_swept_by_den_edge() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_all_refuse_writes(&h).await;

    // Not a member route; another attempt is refused; the owner aborts.
    let (status, _) =
        call(&h, "DELETE", &format!("/lib/{OWNER}/exclusive-operation/{ATTEMPT}"), OWNER, "4", None, &[])
            .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_in_progress(&abort(&h, OTHER).await);
    let (status, aborted) = abort(&h, ATTEMPT).await;
    assert_eq!(status, StatusCode::OK, "{aborted}");
    assert_eq!(aborted, json!({ "attempt": ATTEMPT, "state": "aborted", "library": HOUSEHOLD }));

    // The household's own lock is gone at once; the members' records are still there but void.
    assert_eq!(lock_key(&h, HOUSEHOLD), None);
    assert_eq!(lock_key(&h, OWNER).as_deref(), Some(ATTEMPT), "member records are cleaned afterwards");
    assert_eq!(
        lookup(&h, OWNER, ATTEMPT).await.1,
        json!({ "attempt": ATTEMPT, "state": "aborted", "library": OWNER })
    );
    assert_eq!(
        abort(&h, ATTEMPT).await,
        (StatusCode::OK, aborted.clone()),
        "an aborted reset replays its abort"
    );
    assert_all_writable(&h).await;
    for id in [OWNER, KID1, KID2] {
        assert_eq!(lock_key(&h, id), None, "the first access cleared the void lock");
    }
    assert_eq!(lookup(&h, KID1, ATTEMPT).await.1["state"], "aborted");

    // den-edge, not the client, deletes the declared successors on the next access and marks the household swept.
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert_moved(&changes(&h, id).await);
    }
    assert_eq!(store_of(&h, HOUSEHOLD).exclusive_record(SWEEP).unwrap(), None);
    // A new reset may lock the freed household.
    assert_eq!(acquire_household(&h, OTHER).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_sweep_also_clears_member_locks_nobody_writes_to() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    for id in [OWNER, KID1, KID2] {
        assert_eq!(lock_key(&h, id).as_deref(), Some(ATTEMPT), "{id}: void, not yet cleared");
    }
    // The household's next access sweeps: no member library is touched by anyone but den-edge.
    assert_eq!(changes(&h, HOUSEHOLD).await.0, StatusCode::OK);
    for id in [OWNER, KID1, KID2] {
        assert_eq!(lock_key(&h, id), None, "{id}");
        assert_eq!(lookup(&h, id, ATTEMPT).await.1["state"], "aborted", "{id}");
    }
    assert_eq!(store_of(&h, HOUSEHOLD).exclusive_record(SWEEP).unwrap(), None);
}

#[tokio::test]
async fn a_void_member_lock_is_not_a_lock_for_a_new_reset_or_a_plain_delete() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    // The member still holds the key (the sweep has not run), but the very first request that depends on it finds
    // it void: a new reset locks the library straight over it.
    crate::lock(&h.state.reset_sweeps).clear();
    assert_eq!(lock_key(&h, KID2).as_deref(), Some(ATTEMPT));
    assert_eq!(acquire_household(&h, OTHER).await.0, StatusCode::OK);
    let (status, opened) = acquire_member(&h, OTHER, KID2, NEW_KID2).await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    assert_eq!(lock_key(&h, KID2).as_deref(), Some(OTHER));
    assert_eq!(lookup(&h, KID2, ATTEMPT).await.1["state"], "aborted", "the old attempt stays a tombstone");
    // And an old attempt's retirement of a void lock is refused as not held.
    let (status, body) = retire(&h, OWNER, ATTEMPT, NEW_OWNER).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "lock_not_held" })));
    // A plain delete of a void library is an ordinary delete.
    let (status, body) = call(
        &h,
        "DELETE",
        &format!("/lib/{OWNER}"),
        OWNER,
        "4",
        None,
        &[("x-den-generation", &generation_of(&h, OWNER))],
    )
    .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "deleted": true })));
}

#[tokio::test]
async fn a_member_that_raced_an_abort_is_void_by_rule_and_harmless() {
    let h = new_harness();
    build_old_set(&h).await;
    assert_eq!(acquire_household(&h, ATTEMPT).await.0, StatusCode::OK);
    // The member's source is observed while the household is open ...
    let source = source_of(&h, OWNER).await;
    // ... then the household aborts before the member's acquire arrives: refused, nothing recorded.
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    assert_in_progress(&post_lock(&h, OWNER, profile_request(ATTEMPT, source, NEW_OWNER)).await);
    assert_eq!(lock_key(&h, OWNER), None);
    // Now the other order: the member recorded its lock and the household aborted before anyone noticed.
    assert_eq!(acquire_household(&h, OTHER).await.0, StatusCode::OK);
    assert_eq!(acquire_member(&h, OTHER, OWNER, NEW_OWNER).await.0, StatusCode::OK);
    assert_eq!(abort(&h, OTHER).await.0, StatusCode::OK);
    assert_eq!(write(&h, OWNER, "free").await.0, StatusCode::OK);
}

// ---------------------------------------------------------------------------------------------------------------
// Retirement

#[tokio::test]
async fn nothing_retires_before_the_commit_and_a_locked_library_needs_its_owner_and_successor() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    // Before the commit, for every library.
    for (id, successor) in [(OWNER, NEW_OWNER), (HOUSEHOLD, NEW_HOUSEHOLD)] {
        let (status, body) = retire(&h, id, ATTEMPT, successor).await;
        assert_eq!(
            (status, body),
            (StatusCode::CONFLICT, json!({ "error": "successor_not_committed" })),
            "{id}"
        );
    }
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);

    // A locked library without the headers, or under another attempt, learns only that a migration is going on.
    assert_in_progress(
        &call(
            &h,
            "DELETE",
            &format!("/lib/{OWNER}"),
            OWNER,
            "4",
            None,
            &[("x-den-generation", &generation_of(&h, OWNER))],
        )
        .await,
    );
    assert_in_progress(&retire(&h, OWNER, OTHER, NEW_OWNER).await);
    // It names exactly the declared successor.
    let (status, body) = retire(&h, OWNER, ATTEMPT, NEW_KID1).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "successor_mismatch" })));
    let (status, body) = retire(&h, OWNER, ATTEMPT, "").await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "successor_mismatch" })));
    // The household never retires while a member is unretired.
    let (status, body) = retire(&h, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "locks_held" })));
    assert_eq!(lock_key(&h, OWNER).as_deref(), Some(ATTEMPT));
    assert_eq!(changes(&h, OWNER).await.0, StatusCode::OK);
    // A generation mismatch is a storage failure that retires nothing.
    let (status, body) = call(
        &h,
        "DELETE",
        &format!("/lib/{OWNER}"),
        OWNER,
        "4",
        None,
        &[
            ("x-den-exclusive-attempt", ATTEMPT),
            ("x-den-successor", NEW_OWNER),
            ("x-den-generation", "stale"),
        ],
    )
    .await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "generation_changed" })));
    assert_eq!(changes(&h, OWNER).await.0, StatusCode::OK);
    assert_eq!(
        lookup(&h, HOUSEHOLD, ATTEMPT).await.1["state"],
        "committed",
        "the door is not crossed by a refusal"
    );
}

#[tokio::test]
async fn full_rehearsal_household_owner_and_two_kids() {
    let h = new_harness();
    build_old_set(&h).await;
    // Acquire the household first and the profiles in ascending id order.
    acquire_all(&h, ATTEMPT).await;
    assert_all_refuse_writes(&h).await;
    // Copy the successors (ordinary batches that create new ids) while the old set stays readable.
    build_successors(&h).await;
    for id in [HOUSEHOLD, OWNER, KID1, KID2] {
        assert_eq!(changes(&h, id).await.0, StatusCode::OK);
    }
    let (status, committed) = commit(&h, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!(status, StatusCode::OK, "{committed}");

    // The first retirement crosses the door on the household before it retires the member.
    let first = retire(&h, OWNER, ATTEMPT, NEW_OWNER).await;
    assert_eq!(first, (StatusCode::OK, json!({ "deleted": true })));
    let (household_phase, _) = {
        let record = read::<Record>(store_of(&h, HOUSEHOLD).as_ref(), RESET).unwrap().unwrap().0;
        (record.phase, record.owner)
    };
    assert_eq!(household_phase, Phase::Retiring);
    // The retire response is lost: the identical request is answered 200 again, only to the owner and successor.
    assert_eq!(retire(&h, OWNER, ATTEMPT, NEW_OWNER).await, (StatusCode::OK, json!({ "deleted": true })));
    assert_moved(&retire(&h, OWNER, OTHER, NEW_OWNER).await);
    assert_moved(&retire(&h, OWNER, ATTEMPT, NEW_KID1).await);
    assert_eq!(
        lookup(&h, OWNER, ATTEMPT).await,
        (
            StatusCode::OK,
            json!({ "attempt": ATTEMPT, "state": "retired", "library": OWNER, "successor": NEW_OWNER })
        )
    );
    // The household still cannot retire before the last member.
    assert_eq!(retire(&h, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await.1, json!({ "error": "locks_held" }));
    assert_eq!(changes(&h, HOUSEHOLD).await.0, StatusCode::OK, "the old directory is readable until the end");

    for (id, successor) in [(KID1, NEW_KID1), (KID2, NEW_KID2)] {
        assert_eq!(
            retire(&h, id, ATTEMPT, successor).await,
            (StatusCode::OK, json!({ "deleted": true })),
            "{id}"
        );
    }
    assert_eq!(
        retire(&h, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await,
        (StatusCode::OK, json!({ "deleted": true }))
    );
    assert_eq!(
        retire(&h, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await,
        (StatusCode::OK, json!({ "deleted": true }))
    );

    // Every old library answers 410 library_moved, no lock remains anywhere, and the successors are live.
    for id in [HOUSEHOLD, OWNER, KID1, KID2] {
        assert_moved(&changes(&h, id).await);
        let late = call(
            &h,
            "POST",
            &format!("/lib/{id}/batch"),
            id,
            wire_of(id),
            Some(json!({ "writes": [{ "k": ROW, "base": 0, "v": "late" }] })),
            &[("x-den-generation", "0")],
        )
        .await;
        assert_moved(&late);
        assert!(!h.state.library_v3.path(id).exists(), "{id}: no database, so no lock record, remains");
    }
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert_eq!(changes(&h, id).await.0, StatusCode::OK);
        assert_eq!(write(&h, id, "adopted").await.0, StatusCode::OK);
        assert_eq!(lock_key(&h, id), None);
    }
    assert_eq!(
        lookup(&h, HOUSEHOLD, ATTEMPT).await,
        (
            StatusCode::OK,
            json!({ "attempt": ATTEMPT, "state": "retired", "library": HOUSEHOLD, "successor": NEW_HOUSEHOLD })
        )
    );
    // The terminal results and the retirement survive a restart.
    let restarted = restart(&h);
    assert_eq!(
        retire(&restarted, KID2, ATTEMPT, NEW_KID2).await,
        (StatusCode::OK, json!({ "deleted": true }))
    );
    assert_eq!(lookup(&restarted, HOUSEHOLD, ATTEMPT).await.1["state"], "retired");
    assert_moved(&changes(&restarted, OWNER).await);
    // An abort after the fact is refused.
    assert_moved(&abort(&restarted, ATTEMPT).await);
}

#[tokio::test]
async fn proofless_rollback_rehearsal_sweeps_the_successors_and_frees_the_old_libraries() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    assert_all_refuse_writes(&h).await;

    // A device that lost its journal recovers without the successor key: before the door that is the rollback.
    let (status, done) = recover(&h, RECOVERY, None).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done, json!({ "attempt": RECOVERY, "state": "completed", "outcome": "aborted" }));
    assert_eq!(
        recover(&h, RECOVERY, None).await.1,
        done,
        "a lost response is repeated: the identical request"
    );

    // The old owner is shut out for good, and its attempt reports the recovery and its outcome.
    assert_eq!(
        lookup(&h, HOUSEHOLD, ATTEMPT).await.1,
        json!({ "attempt": ATTEMPT, "state": "recovered", "recovery": RECOVERY, "outcome": "aborted" })
    );
    assert_eq!(lookup(&h, HOUSEHOLD, RECOVERY).await.1, done);
    let (status, body) = retire(&h, OWNER, ATTEMPT, NEW_OWNER).await;
    assert_eq!(
        (status, body),
        (StatusCode::CONFLICT, json!({ "error": "lock_not_held" })),
        "after a rollback the member retirement is refused"
    );
    let (status, body) = retire(&h, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "lock_not_held" })));
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::CONFLICT);

    // The old libraries are writable again, with no step left for any client.
    assert_all_writable(&h).await;
    // den-edge swept the successors on that access (the household was accessed above) and marked it swept.
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert_moved(&changes(&h, id).await);
    }
    assert_eq!(store_of(&h, HOUSEHOLD).exclusive_record(SWEEP).unwrap(), None);
    // A later proofless recovery learns nothing.
    assert_in_progress(&recover(&h, RECOVERY2, None).await);
    // The freed household is lockable by a new reset.
    assert_eq!(acquire_household(&h, OTHER).await.0, StatusCode::OK);
}

#[tokio::test]
async fn recovery_with_a_wrong_or_missing_proof_and_the_phases_it_may_take_over() {
    let h = new_harness();
    build_old_set(&h).await;
    // Nothing locked: nothing to recover, and a proof proves nothing.
    assert_in_progress(&recover(&h, RECOVERY, None).await);
    assert_in_progress(&recover(&h, RECOVERY, Some(NEW_HOUSEHOLD)).await);
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    // A profile library cannot be recovered; a recovery attempt id cannot reuse the reset attempt.
    let source = source_of(&h, OWNER).await;
    let (status, body) = post_lock(
        &h,
        OWNER,
        json!({ "attempt": RECOVERY, "purpose": "key-reset-recovery", "role": "profile", "expectedSource": source }),
    )
    .await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "migration_in_progress" })));
    let source = source_of(&h, HOUSEHOLD).await;
    let body = json!({ "attempt": ATTEMPT, "purpose": "key-reset-recovery", "role": "household", "expectedSource": source });
    let (status, answer) = post_lock(&h, HOUSEHOLD, body).await;
    assert_eq!(
        (status, answer),
        (StatusCode::CONFLICT, json!({ "error": "migration_attempt_mismatch" })),
        "the reset's own attempt id under another purpose is a mismatch, not a recovery"
    );
    // A wrong proof (not the successor's credential) is refused in any phase, with no effect.
    assert_in_progress(&recover(&h, RECOVERY, Some(NEW_OWNER)).await);
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    assert_in_progress(&recover(&h, RECOVERY, Some(NEW_OWNER)).await);
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await.1["state"], "committed");
    // A proof against a successor that is gone is refused too.
    let gone = retire_successor(&h, NEW_HOUSEHOLD).await;
    assert!(gone);
    assert_in_progress(&recover(&h, RECOVERY, Some(NEW_HOUSEHOLD)).await);
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await.1["state"], "committed");
}

/// Delete a successor the way an operator or an earlier sweep would, to test what the proof checks.
async fn retire_successor(h: &Harness, id: &str) -> bool {
    let (status, _) = call(
        h,
        "DELETE",
        &format!("/lib/{id}"),
        id,
        wire_of(id),
        None,
        &[("x-den-generation", &generation_of(h, id))],
    )
    .await;
    status == StatusCode::OK
}

#[tokio::test]
async fn recovery_with_proof_takes_over_and_finishes_retirement_through_the_new_owner() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);

    let (status, taken) = recover(&h, RECOVERY, Some(NEW_HOUSEHOLD)).await;
    assert_eq!(status, StatusCode::OK, "{taken}");
    assert_eq!(taken["state"], "open");
    assert_eq!(taken["purpose"], "key-reset-recovery");
    assert_eq!(taken["recovers"]["attempt"], ATTEMPT);
    assert_eq!(taken["recovers"]["phase"], "committed");
    assert_eq!(taken["recovers"]["successor"], NEW_HOUSEHOLD);
    assert_eq!(taken["recovers"]["members"], members_json());
    assert_eq!(
        lock_key(&h, HOUSEHOLD).as_deref(),
        Some(RECOVERY),
        "the household lock is never released by it"
    );
    assert_eq!(recover(&h, RECOVERY, Some(NEW_HOUSEHOLD)).await, (StatusCode::OK, taken.clone()));
    assert_all_refuse_writes(&h).await;

    // The old owner is shut out atomically: its retirement, abort and commit are refused.
    assert_in_progress(&retire(&h, OWNER, ATTEMPT, NEW_OWNER).await);
    assert_in_progress(&abort(&h, ATTEMPT).await);
    assert_eq!(
        lookup(&h, HOUSEHOLD, ATTEMPT).await.1,
        json!({ "attempt": ATTEMPT, "state": "recovered", "recovery": RECOVERY })
    );
    // After a takeover the recovery can never abort or roll back.
    assert_in_progress(&abort(&h, RECOVERY).await);
    // It retires the members through the new owner, taking the successors from `recovers`, then the household.
    for member in taken["recovers"]["members"].as_array().unwrap() {
        let (id, successor) = (member["libraryId"].as_str().unwrap(), member["successor"].as_str().unwrap());
        assert_eq!(
            retire(&h, id, RECOVERY, successor).await,
            (StatusCode::OK, json!({ "deleted": true })),
            "{id}"
        );
    }
    assert_eq!(
        retire(&h, HOUSEHOLD, RECOVERY, NEW_HOUSEHOLD).await,
        (StatusCode::OK, json!({ "deleted": true }))
    );
    assert_eq!(
        lookup(&h, HOUSEHOLD, RECOVERY).await.1,
        json!({ "attempt": RECOVERY, "state": "completed", "outcome": "retired" })
    );
    assert_eq!(
        lookup(&h, HOUSEHOLD, ATTEMPT).await.1,
        json!({ "attempt": ATTEMPT, "state": "recovered", "recovery": RECOVERY, "outcome": "retired" })
    );
    assert_eq!(
        lookup(&h, OWNER, ATTEMPT).await.1["state"],
        "retired",
        "the journaled executor adopts its successor"
    );
    for id in [HOUSEHOLD, OWNER, KID1, KID2] {
        assert_moved(&changes(&h, id).await);
    }
}

#[tokio::test]
async fn an_unproven_recovery_owner_retires_nothing_and_a_second_recovery_may_take_over() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    // Before the commit a proofless recovery takes the open reset over (it will only ever abort) ...
    let (status, taken) = recover(&h, RECOVERY, None).await;
    assert_eq!(status, StatusCode::OK, "{taken}");
    assert_eq!(taken["recovers"]["phase"], "open");
    // ... and cannot retire, record the commit, or be mistaken for the reset.
    assert_in_progress(&commit(&h, RECOVERY, NEW_HOUSEHOLD).await);
    assert_in_progress(&retire(&h, OWNER, RECOVERY, NEW_OWNER).await);
    assert_in_progress(&commit(&h, ATTEMPT, NEW_HOUSEHOLD).await);
    // A second recovery takes the first over: recovery is itself crash-recoverable.
    let (status, second) = recover(&h, RECOVERY2, None).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["recovers"]["attempt"], RECOVERY);
    assert_eq!(
        lookup(&h, HOUSEHOLD, RECOVERY).await.1,
        json!({ "attempt": RECOVERY, "state": "recovered", "recovery": RECOVERY2 })
    );
    assert_in_progress(&abort(&h, RECOVERY).await);
    // The last recovery aborts with one household commit; everyone earlier learns the outcome.
    let (status, done) = abort(&h, RECOVERY2).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done, json!({ "attempt": RECOVERY2, "state": "completed", "outcome": "aborted" }));
    for earlier in [ATTEMPT, RECOVERY] {
        let found = lookup(&h, HOUSEHOLD, earlier).await.1;
        assert_eq!(found["state"], "recovered", "{earlier}");
        assert_eq!(found["outcome"], "aborted", "{earlier}");
    }
    assert_all_writable(&h).await;
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert_moved(&changes(&h, id).await);
    }
}

#[tokio::test]
async fn after_the_door_a_proofless_recovery_is_refused_and_a_proven_one_finishes_partial_retirement() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    assert_eq!(retire(&h, OWNER, ATTEMPT, NEW_OWNER).await.0, StatusCode::OK);

    // Fail closed: the old libraries stay readable and every write stays refused.
    assert_in_progress(&recover(&h, RECOVERY, None).await);
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await.1["state"], "committed");
    assert_eq!(changes(&h, KID1).await.0, StatusCode::OK);
    assert_in_progress(&write(&h, KID1, "refused").await);
    // A wrong proof is refused as well; the right one takes the `retiring` lock over.
    assert_in_progress(&recover(&h, RECOVERY, Some(NEW_OWNER)).await);
    let (status, taken) = recover(&h, RECOVERY, Some(NEW_HOUSEHOLD)).await;
    assert_eq!(status, StatusCode::OK, "{taken}");
    assert_eq!(taken["recovers"]["phase"], "retiring");
    for (id, successor) in [(OWNER, NEW_OWNER), (KID1, NEW_KID1), (KID2, NEW_KID2)] {
        assert_eq!(
            retire(&h, id, RECOVERY, successor).await,
            (StatusCode::OK, json!({ "deleted": true })),
            "{id}"
        );
    }
    assert_eq!(retire(&h, HOUSEHOLD, RECOVERY, NEW_HOUSEHOLD).await.0, StatusCode::OK);
}

// ---------------------------------------------------------------------------------------------------------------
// The crash table of §9.1, window by window, across a restart

#[tokio::test]
async fn crash_before_the_household_acquire_commit_leaves_no_lock() {
    let h = new_harness();
    build_old_set(&h).await;
    let source = source_of(&h, HOUSEHOLD).await;
    // A failed commit (the source moved under it) is the same durable state as a crash before the commit.
    assert_eq!(write(&h, HOUSEHOLD, "x").await.0, StatusCode::OK);
    assert_eq!(post_lock(&h, HOUSEHOLD, household_request(ATTEMPT, source)).await.0, StatusCode::CONFLICT);
    let restarted = restart(&h);
    assert_eq!(lock_key(&restarted, HOUSEHOLD), None);
    assert_eq!(lookup(&restarted, HOUSEHOLD, ATTEMPT).await.0, StatusCode::NOT_FOUND);
    assert_eq!(acquire_household(&restarted, ATTEMPT).await.0, StatusCode::OK, "repeat or start again");
}

#[tokio::test]
async fn crash_after_the_household_acquire_keeps_the_set_declared_and_abortable() {
    let h = new_harness();
    build_old_set(&h).await;
    let (_, opened) = acquire_household(&h, ATTEMPT).await;
    let restarted = restart(&h);
    assert_eq!(lock_key(&restarted, HOUSEHOLD).as_deref(), Some(ATTEMPT));
    assert_in_progress(&write(&restarted, HOUSEHOLD, "refused").await);
    assert_eq!(lookup(&restarted, HOUSEHOLD, ATTEMPT).await, (StatusCode::OK, opened.clone()));
    // Acquire the rest in order after the restart, or abort.
    for (old, new) in old_members() {
        assert_eq!(acquire_member(&restarted, ATTEMPT, old, new).await.0, StatusCode::OK);
    }
    assert_eq!(abort(&restarted, ATTEMPT).await.0, StatusCode::OK);
    assert_all_writable(&restarted).await;
}

#[tokio::test]
async fn crash_between_profile_acquires_replays_and_continues_or_aborts() {
    let h = new_harness();
    build_old_set(&h).await;
    assert_eq!(acquire_household(&h, ATTEMPT).await.0, StatusCode::OK);
    let (_, owner_lock) = acquire_member(&h, ATTEMPT, OWNER, NEW_OWNER).await;
    let restarted = restart(&h);
    // The acquire whose response was lost is repeated and returns the stored answer.
    let (status, replay) = acquire_member(&restarted, ATTEMPT, OWNER, NEW_OWNER).await;
    assert_eq!((status, replay), (StatusCode::OK, owner_lock));
    assert_eq!(acquire_member(&restarted, ATTEMPT, KID1, NEW_KID1).await.0, StatusCode::OK);
    // KID2 was never locked: the set is incomplete, so the commit refuses.
    build_successors(&restarted).await;
    assert_eq!(commit(&restarted, ATTEMPT, NEW_HOUSEHOLD).await.1, json!({ "error": "locks_incomplete" }));
    assert_eq!(abort(&restarted, ATTEMPT).await.0, StatusCode::OK);
    assert_all_writable(&restarted).await;
}

#[tokio::test]
async fn crash_before_the_successor_commit_can_verify_and_commit() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    let restarted = restart(&h);
    assert_eq!(lookup(&restarted, HOUSEHOLD, ATTEMPT).await.1["state"], "open");
    assert_eq!(commit(&restarted, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
}

#[tokio::test]
async fn crash_before_the_successor_commit_can_abort_and_the_uncommitted_successor_is_swept() {
    let h2 = new_harness();
    build_old_set(&h2).await;
    acquire_all(&h2, ATTEMPT).await;
    build_successors(&h2).await;
    let restarted = restart(&h2);
    assert_eq!(abort(&restarted, ATTEMPT).await.0, StatusCode::OK);
    assert_all_writable(&restarted).await;
    assert_moved(&changes(&restarted, NEW_HOUSEHOLD).await);
}

#[tokio::test]
async fn crash_after_the_commit_shows_committed_and_the_door_is_crossed_by_the_first_retirement() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    let restarted = restart(&h);
    assert_eq!(lookup(&restarted, HOUSEHOLD, ATTEMPT).await.1["state"], "committed");
    assert_all_refuse_writes(&restarted).await;
    assert_eq!(retire(&restarted, KID2, ATTEMPT, NEW_KID2).await.0, StatusCode::OK);
    let record = read::<Record>(store_of(&restarted, HOUSEHOLD).as_ref(), RESET).unwrap().unwrap().0;
    assert_eq!(record.phase, Phase::Retiring);
}

#[tokio::test]
async fn crash_after_the_abort_before_any_member_or_successor_effect_converges_at_startup() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    // Nothing else happened: the hint is on disk, the household owes its sweep, and the members' keys are void.
    assert!(store_of(&h, HOUSEHOLD).exclusive_record(SWEEP).unwrap().is_some());
    assert_eq!(lock_key(&h, KID1).as_deref(), Some(ATTEMPT));
    assert_eq!(std::fs::read_dir(h.state.store.namespace_dir(HINT_NS)).unwrap().count(), 1);

    let restarted = restart(&h);
    assert!(!crate::lock(&restarted.state.reset_sweeps).contains(HOUSEHOLD));
    // Writes are already allowed (the member locks are void by rule) ...
    assert_eq!(write(&restarted, KID1, "free").await.0, StatusCode::OK);
    // ... and den-edge finds the owed deletions at startup, without anybody touching the household.
    sweep_startup(Arc::clone(&restarted.state)).await;
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert!(
            !restarted.state.library_v3.path(id).exists()
                || restarted.state.store.get_file(NS, id, MOVED).await.unwrap().is_some()
        );
        assert_moved(&changes(&restarted, id).await);
    }
    assert_eq!(store_of(&restarted, HOUSEHOLD).exclusive_record(SWEEP).unwrap(), None, "marked swept");
    assert_eq!(std::fs::read_dir(restarted.state.store.namespace_dir(HINT_NS)).unwrap().count(), 0);
}

#[tokio::test]
async fn a_hint_an_older_release_left_in_the_migration_namespace_is_still_swept_after_a_restart() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    let hints = |ns: &str| std::fs::read_dir(h.state.store.namespace_dir(ns)).unwrap().count();
    assert_eq!(
        (hints(HINT_NS), hints(LEGACY_HINT_NS)),
        (1, 0),
        "a hint is written to the reset's own namespace"
    );
    // The same hint as a release that kept it beside the migration's files wrote it.
    let hint = std::fs::read_dir(h.state.store.namespace_dir(HINT_NS)).unwrap().next().unwrap().unwrap();
    std::fs::rename(hint.path(), h.state.store.namespace_dir(LEGACY_HINT_NS).join(hint.file_name())).unwrap();

    let restarted = restart(&h);
    sweep_startup(Arc::clone(&restarted.state)).await;
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert_moved(&changes(&restarted, id).await);
    }
    assert_eq!(store_of(&restarted, HOUSEHOLD).exclusive_record(SWEEP).unwrap(), None, "marked swept");
    assert_eq!((hints(HINT_NS), hints(LEGACY_HINT_NS)), (0, 0), "the old hint is cleared too");
}

#[tokio::test]
async fn crash_between_successor_deletions_finishes_the_rest_and_never_touches_a_live_successor() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    // The sweep got as far as the first deletion before the process died.
    delete_successor(&h.state, NEW_HOUSEHOLD).await.unwrap();
    let restarted = restart(&h);
    sweep_startup(Arc::clone(&restarted.state)).await;
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert_moved(&changes(&restarted, id).await);
    }
    // Idempotent: nothing is owed any more, and a repeated sweep changes nothing.
    sweep(&restarted.state, HOUSEHOLD).await.unwrap();
    assert_eq!(store_of(&restarted, HOUSEHOLD).exclusive_record(SWEEP).unwrap(), None);
}

#[tokio::test]
async fn crash_after_the_door_before_the_first_member_retirement_fails_closed_without_proof() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    // The door commit landed and the member retirement did not.
    let household = store_of(&h, HOUSEHOLD);
    let (record, raw) = read::<Record>(household.as_ref(), RESET).unwrap().unwrap();
    let mut next = record.clone();
    next.phase = Phase::Retiring;
    let mut edit = ExclusiveEdit::new(LockExpect::Held(record.owner.clone()), LockChange::Keep);
    edit.expect_records.push((RESET.to_owned(), Some(raw)));
    put(&mut edit, RESET.to_owned(), &next);
    household.exclusive_commit(&edit).unwrap();

    let restarted = restart(&h);
    assert_in_progress(&recover(&restarted, RECOVERY, None).await);
    assert_all_refuse_writes(&restarted).await;
    assert_eq!(changes(&restarted, OWNER).await.0, StatusCode::OK, "the old libraries stay readable");
    // The owner repeats the request and it is idempotent about the door.
    for (id, successor) in [(OWNER, NEW_OWNER), (KID1, NEW_KID1), (KID2, NEW_KID2)] {
        assert_eq!(retire(&restarted, id, ATTEMPT, successor).await.0, StatusCode::OK, "{id}");
    }
    assert_eq!(retire(&restarted, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
}

#[tokio::test]
async fn crash_between_member_retirements_and_before_the_household_retirement_resumes() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    assert_eq!(retire(&h, OWNER, ATTEMPT, NEW_OWNER).await.0, StatusCode::OK);
    let restarted = restart(&h);
    // Repeat the DELETEs: the retired one answers 200 again, the rest proceed, the household goes last.
    assert_eq!(retire(&restarted, OWNER, ATTEMPT, NEW_OWNER).await.0, StatusCode::OK);
    assert_eq!(retire(&restarted, KID1, ATTEMPT, NEW_KID1).await.0, StatusCode::OK);
    let restarted_again = restart(&restarted);
    // Every member but one retired: the household still refuses, and its old directory is readable.
    assert_eq!(
        retire(&restarted_again, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await.1,
        json!({ "error": "locks_held" })
    );
    assert_eq!(changes(&restarted_again, HOUSEHOLD).await.0, StatusCode::OK);
    assert_eq!(retire(&restarted_again, KID2, ATTEMPT, NEW_KID2).await.0, StatusCode::OK);
    let third = restart(&restarted_again);
    // After the last member and before the household: repeat the household DELETE.
    assert_eq!(retire(&third, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    assert_eq!(retire(&third, HOUSEHOLD, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
}

#[tokio::test]
async fn crash_during_takeover_leaves_one_owner_and_a_recoverable_state() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    let (_, taken) = recover(&h, RECOVERY, None).await;
    let restarted = restart(&h);
    assert_eq!(lock_key(&restarted, HOUSEHOLD).as_deref(), Some(RECOVERY));
    assert_eq!(
        recover(&restarted, RECOVERY, None).await.1,
        taken,
        "the takeover is repeated, not repeated twice"
    );
    assert_in_progress(&abort(&restarted, ATTEMPT).await);
    assert_eq!(abort(&restarted, RECOVERY).await.0, StatusCode::OK);
    assert_all_writable(&restarted).await;
}

#[tokio::test]
async fn crash_after_the_proofless_rollback_keeps_it_final() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    let (_, done) = recover(&h, RECOVERY, None).await;
    // The process died with the rollback committed and nothing else done.
    let restarted = restart(&h);
    assert_eq!(lookup(&restarted, HOUSEHOLD, RECOVERY).await.1, done);
    assert_eq!(write(&restarted, OWNER, "free").await.0, StatusCode::OK);
    sweep_startup(Arc::clone(&restarted.state)).await;
    for id in [NEW_HOUSEHOLD, NEW_OWNER, NEW_KID1, NEW_KID2] {
        assert_moved(&changes(&restarted, id).await);
    }
    assert_eq!(
        recover(&restarted, RECOVERY, None).await.1,
        done,
        "the rollback's lost response is repeatable"
    );
    assert_all_writable(&restarted).await;
}

// ---------------------------------------------------------------------------------------------------------------
// Exclusion with another holder of the shared exclusive lock

#[tokio::test]
async fn a_key_reset_and_another_exclusive_lock_exclude_each_other() {
    let h = new_harness();
    build_old_set(&h).await;
    // A migration-style lock on the household blocks a key-reset acquisition, whatever the source.
    let protocol = store_of(&h, HOUSEHOLD).protocol().unwrap();
    store_of(&h, HOUSEHOLD)
        .acquire_exclusive_operation_lock(OTHER, protocol.migration_generation, protocol.head)
        .unwrap();
    assert_in_progress(&acquire_household(&h, ATTEMPT).await);
    let wrong = json!({ "generation": 0, "head": "9".repeat(64) });
    assert_in_progress(&post_lock(&h, HOUSEHOLD, household_request(ATTEMPT, wrong)).await);
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await.0, StatusCode::NOT_FOUND);
    store_of(&h, HOUSEHOLD).release_exclusive_operation_lock(OTHER).unwrap();

    // And the reverse: a held key-reset lock refuses the shared primitive to another exclusive operation.
    assert_eq!(acquire_household(&h, ATTEMPT).await.0, StatusCode::OK);
    let protocol = store_of(&h, HOUSEHOLD).protocol().unwrap();
    assert!(matches!(
        store_of(&h, HOUSEHOLD).acquire_exclusive_operation_lock(
            OTHER,
            protocol.migration_generation,
            protocol.head
        ),
        Err(StoreError::Locked)
    ));
    // A library held by another operation is not retired by a reset that never locked it.
    let kid = store_of(&h, KID1).protocol().unwrap();
    store_of(&h, KID1).acquire_exclusive_operation_lock(OTHER, kid.migration_generation, kid.head).unwrap();
    assert_in_progress(&retire(&h, KID1, ATTEMPT, NEW_KID1).await);
    store_of(&h, KID1).release_exclusive_operation_lock(OTHER).unwrap();
    // Once the reset aborted, the household is free for another exclusive operation again.
    assert_eq!(abort(&h, ATTEMPT).await.0, StatusCode::OK);
    let protocol = store_of(&h, HOUSEHOLD).protocol().unwrap();
    store_of(&h, HOUSEHOLD)
        .acquire_exclusive_operation_lock(OTHER, protocol.migration_generation, protocol.head)
        .unwrap();
}

#[tokio::test]
async fn an_ordinary_delete_of_an_unlocked_library_is_unchanged_and_exclusive_headers_on_it_are_not_a_lock() {
    let h = new_harness();
    build_old_set(&h).await;
    let (status, body) = retire(&h, KID1, ATTEMPT, NEW_KID1).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "lock_not_held" })));
    assert_eq!(changes(&h, KID1).await.0, StatusCode::OK);
    let generation = generation_of(&h, KID1);
    let (status, body) =
        call(&h, "DELETE", &format!("/lib/{KID1}"), KID1, "4", None, &[("x-den-generation", &generation)])
            .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "deleted": true })));
    assert_moved(&changes(&h, KID1).await);
    // A malformed attempt header is a bad request, never a guess.
    let (status, _) = call(
        &h,
        "DELETE",
        &format!("/lib/{KID2}"),
        KID2,
        "4",
        None,
        &[("x-den-exclusive-attempt", "nope"), ("x-den-generation", &generation_of(&h, KID2))],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(changes(&h, KID2).await.0, StatusCode::OK);
}

#[tokio::test]
async fn lookup_is_metadata_free_for_an_unknown_attempt_and_markers_do_not_leak_the_successor() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    let (status, body) = lookup(&h, HOUSEHOLD, OTHER).await;
    assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    assert_eq!(retire(&h, OWNER, ATTEMPT, NEW_OWNER).await.0, StatusCode::OK);
    // Whoever merely knows the old id is told the library moved, not where to.
    let bare = h
        .send(
            "GET",
            &format!("/lib/{OWNER}/changes?since=0"),
            None,
            &[("x-den-wire", "4"), ("x-den-library-token", "anything")],
        )
        .await;
    assert_eq!(bare.status(), StatusCode::GONE);
    assert_eq!(body_json(bare).await, json!({ "error": "library_moved" }));
    // A retired library answers the lookup only for the attempt that retired it.
    assert_eq!(lookup(&h, OWNER, OTHER).await.0, StatusCode::NOT_FOUND);
    assert_eq!(lookup(&h, OWNER, ATTEMPT).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_retirement_without_its_generation_and_a_malformed_attempt_are_refused() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    build_successors(&h).await;
    assert_eq!(commit(&h, ATTEMPT, NEW_HOUSEHOLD).await.0, StatusCode::OK);
    let (status, body) = call(
        &h,
        "DELETE",
        &format!("/lib/{OWNER}"),
        OWNER,
        "4",
        None,
        &[("x-den-exclusive-attempt", ATTEMPT), ("x-den-successor", NEW_OWNER)],
    )
    .await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "generation_changed" })));
    assert_eq!(lookup(&h, HOUSEHOLD, ATTEMPT).await.1["state"], "committed", "no door was crossed");
    for (method, path) in [
        ("GET", format!("/lib/{HOUSEHOLD}/exclusive-operation/zz")),
        ("DELETE", format!("/lib/{HOUSEHOLD}/exclusive-operation/zz")),
        ("POST", format!("/lib/{HOUSEHOLD}/exclusive-operation/zz/successor")),
    ] {
        let body = (method == "POST").then(|| json!({ "successor": NEW_HOUSEHOLD }));
        let (status, answer) = call(&h, method, &path, HOUSEHOLD, "5", body, &[]).await;
        assert_eq!(
            (status, answer),
            (StatusCode::BAD_REQUEST, json!({ "error": "bad_request" })),
            "{method}"
        );
    }
}

#[test]
fn the_routes_have_stable_labels_and_methods() {
    use crate::handler::route_label;
    let base = format!("/lib/{HOUSEHOLD}/exclusive-operation");
    for (path, label) in [
        (base.clone(), "/lib/:id/exclusive-operation"),
        (format!("{base}/source"), "/lib/:id/exclusive-operation/source"),
        (format!("{base}/{ATTEMPT}"), "/lib/:id/exclusive-operation/:attempt"),
        (format!("{base}/{ATTEMPT}/successor"), "/lib/:id/exclusive-operation/:attempt/successor"),
    ] {
        assert_eq!(route_label(&path), label);
    }
}

#[tokio::test]
async fn the_retired_migration_surface_stays_absent_while_the_reset_keeps_its_own_switch() {
    // Reset on: reset routes work and the retired migration routes remain absent.
    let h = new_harness();
    build_old_set(&h).await;
    let absent = (StatusCode::NOT_FOUND, json!({ "error": "not_found" }));
    let retired = [
        ("GET", format!("/lib/{HOUSEHOLD}/profile-capability")),
        ("POST", format!("/lib/{HOUSEHOLD}/profile-migration")),
        ("GET", format!("/lib/{HOUSEHOLD}/profile-migration/source")),
    ];
    for (method, path) in &retired {
        assert_eq!(call(&h, method, path, HOUSEHOLD, "5", None, &[]).await, absent);
    }
    acquire_all(&h, ATTEMPT).await;

    // Reset off: both the retired migration surface and reset routes are absent, including the retirement a
    // `DELETE` with the exclusive headers would otherwise be.
    let m = Harness::in_dir_with(h.dir.clone(), |_| {});
    for (method, path) in &retired {
        assert_eq!(call(&m, method, path, HOUSEHOLD, "5", None, &[]).await, absent);
    }
    let reset_source = format!("/lib/{HOUSEHOLD}/exclusive-operation/source");
    assert_eq!(call(&m, "GET", &reset_source, HOUSEHOLD, "5", None, &[]).await, absent);
    assert_eq!(lookup(&m, HOUSEHOLD, ATTEMPT).await, absent);
    // Switching the routes off never unlocks a library: the lock is in the store, not in the switch.
    assert_in_progress(&write(&m, KID1, "during").await);
    assert_in_progress(&retire(&m, KID1, ATTEMPT, NEW_KID1).await);

    // And the reset resumes once its switch is back.
    let back = restart(&h);
    assert_eq!(lookup(&back, HOUSEHOLD, ATTEMPT).await.1["state"], "open");
    assert_eq!(abort(&back, ATTEMPT).await.0, StatusCode::OK);
    assert_all_writable(&back).await;
}

#[test]
fn markers_round_trip_and_a_legacy_marker_still_names_its_tag() {
    let marker = Marker {
        successor: NEW_OWNER.to_owned(),
        exclusive: Tombstone {
            lock: "lock-1".into(),
            acquired: ATTEMPT.into(),
            owner: ATTEMPT.into(),
            role: Role::Profile,
            household: Some(HOUSEHOLD.into()),
            chain: Vec::new(),
            members: Vec::new(),
        },
    };
    let raw = serde_json::to_vec(&marker).unwrap();
    assert_eq!(parse_marker(&raw), Some(marker));
    assert_eq!(marker_successor(&raw), None, "a key-reset marker never reveals its successor");
    let legacy = NEW_OWNER.as_bytes();
    assert_eq!(parse_marker(legacy), None);
    assert_eq!(marker_successor(legacy).as_deref(), Some(NEW_OWNER));
    assert_eq!(marker_successor(b""), Some(String::new()));
}

// ---------------------------------------------------------------------------------------------------------------
// Starting the successors

/// Start a library with one row, the way `takeMoved` does: its own token and wire, naming `member` when given.
async fn start_library(h: &Harness, id: &str, member: Option<&str>) -> StatusCode {
    let token = token_of(id);
    let wire = wire_of(id);
    let mut headers: Vec<(&str, &str)> = vec![
        ("x-den-library-token", &token),
        ("x-den-wire", wire),
        ("x-den-wire-min", wire),
        ("x-den-generation", "0"),
    ];
    if let Some(member) = member {
        headers.push(("x-den-library-member", member));
    }
    let body = json!({ "writes": [{ "k": ROW, "base": 0, "v": "first" }] }).to_string();
    h.send("POST", &format!("/lib/{id}/batch"), Some(body), &headers).await.status()
}

fn proof_of(id: &str) -> String {
    format!("{id}:{}", token_of(id))
}

fn household_proof() -> String {
    proof_of(HOUSEHOLD)
}

/// Spend the address's whole new-library budget on libraries that are nobody's successors.
async fn exhaust_new_library_budget(h: &Harness) {
    let mut refused = false;
    for n in 0..16u32 {
        let id = format!("{:032x}", 0x7000_0000 + n);
        if start_library(h, &id, None).await == StatusCode::TOO_MANY_REQUESTS {
            refused = true;
            break;
        }
    }
    assert!(refused, "the budget never ran out");
}

#[tokio::test]
async fn successors_a_live_lock_declares_do_not_spend_the_new_library_budget() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    exhaust_new_library_budget(&h).await;
    let proof = household_proof();

    // Every other way of starting a library is still throttled.
    assert_eq!(
        start_library(&h, &format!("{:032x}", 0x7100_0000u32), None).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        start_library(&h, &format!("{:032x}", 0x7100_0001u32), Some(&proof_of(OWNER))).await,
        StatusCode::TOO_MANY_REQUESTS,
        "a member may not start a library it did not declare"
    );
    assert_eq!(
        start_library(&h, NEW_OWNER, Some(&format!("{HOUSEHOLD}:not-its-token"))).await,
        StatusCode::TOO_MANY_REQUESTS,
        "without the household's token a declared id is not exempt"
    );
    assert_eq!(
        start_library(&h, NEW_OWNER, Some(&proof_of(KID1))).await,
        StatusCode::TOO_MANY_REQUESTS,
        "a member may start only its own successor"
    );
    assert_eq!(start_library(&h, NEW_OWNER, None).await, StatusCode::TOO_MANY_REQUESTS, "no proof at all");

    // The household's own proof starts the declared successors, all of them, in one go.
    assert_eq!(start_library(&h, NEW_HOUSEHOLD, Some(&proof)).await, StatusCode::OK);
    // The same holds once the successor is committed.
    let (status, body) = commit(&h, ATTEMPT, NEW_HOUSEHOLD).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Each profile successor is started the way `takeMoved` starts it: naming the library it is moved from.
    for (old, new) in [(OWNER, NEW_OWNER), (KID1, NEW_KID1), (KID2, NEW_KID2)] {
        assert_eq!(start_library(&h, new, Some(&proof_of(old))).await, StatusCode::OK, "{new}");
    }
    // And the budget was not touched on the way.
    assert_eq!(
        start_library(&h, &format!("{:032x}", 0x7200_0000u32), None).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn an_ended_or_absent_lock_exempts_nothing() {
    let h = new_harness();
    build_old_set(&h).await;
    // No reset at all.
    exhaust_new_library_budget(&h).await;
    assert_eq!(
        start_library(&h, NEW_HOUSEHOLD, Some(&household_proof())).await,
        StatusCode::TOO_MANY_REQUESTS
    );

    // A reset the household aborted no longer declares successors it can start.
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    let (status, body) = abort(&h, ATTEMPT).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    exhaust_new_library_budget(&h).await;
    assert_eq!(start_library(&h, NEW_OWNER, Some(&proof_of(OWNER))).await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_successor_that_already_existed_is_not_the_resets_to_start_for_free() {
    let h = new_harness();
    build_old_set(&h).await;
    // The declared successor of the Owner exists before the lock is acquired, so the reset did not make it.
    create(&h, NEW_OWNER).await;
    acquire_all(&h, ATTEMPT).await;
    exhaust_new_library_budget(&h).await;
    // It exists, so writing to it is not a new library; the others, which the reset makes, are exempt.
    assert_eq!(start_library(&h, NEW_KID1, Some(&proof_of(KID1))).await, StatusCode::OK);
    assert!(h.state.library_v3.path(NEW_OWNER).exists());
}

#[tokio::test]
async fn under_members_only_a_holder_of_the_household_starts_its_successors() {
    let h = new_harness();
    build_old_set(&h).await;
    acquire_all(&h, ATTEMPT).await;
    let m = Harness::in_dir_with(h.dir.clone(), |state| {
        state.profile_reset_enabled = true;
        state.new_libraries = crate::library::NewLibraries::Members;
    });
    assert_eq!(start_library(&m, NEW_HOUSEHOLD, None).await, StatusCode::FORBIDDEN);
    assert_eq!(start_library(&m, NEW_OWNER, Some(&proof_of(OWNER))).await, StatusCode::OK);
    assert_eq!(start_library(&m, NEW_HOUSEHOLD, Some(&household_proof())).await, StatusCode::OK);
}
