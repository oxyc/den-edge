//! Recovery codes (den-spec `wire/recovery-code.md` §5): the sealed library key a device stores under a locator only
//! its code derives, so a new device holding nothing but the code can open the library.
//!
//!   POST   /recovery        { locator, sealed }  (member proof) → 201 { createdAt }
//!   GET    /recovery        (member proof)                        → { entries: [{ locator, createdAt, opens, lastOpenedAt }] }
//!   DELETE /recovery        { locator }          (member proof) → { deleted }
//!   POST   /recovery/open   { locator }          (no credential)  → { sealed } | 404 unknown_code
//!
//! The member proof is `x-den-library-member: <id>:<member>`, as `library::is_member` checks it; an entry belongs to
//! the library that proof names, and a locator under another library reads as absent. Locators travel in bodies,
//! never in a path, and nothing here logs one, a sealed value or a proof: the request line carries the route and the
//! status only.
//!
//! On disk: `recovery/`, one file per library (`lib:<id>`, its entries) and one per locator (`loc:<locator>`, the
//! library it belongs to), so `open` finds an entry by its exact locator without reading any other library. The
//! store names each file by the SHA-256 of its key. Unlike grants, this directory is in the store's backups: a
//! restored store must still open a code made before the backup.

use crate::handler::{
    error, internal, json_reply, method_not_allowed, read_json, retry_after, MAX_BODY_BYTES,
};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io;

const NS: &str = "recovery";
const VERSION: u32 = 1;
/// A live code, one being made, and room for clean-up (§5).
const MAX_PER_LIBRARY: usize = 4;
/// `sealed` is base64url of nonce (12) ‖ ciphertext ‖ tag (16): at least 38 characters, and at most 512 (§5).
const SEALED_MIN: usize = 38;
const SEALED_MAX: usize = 512;
const MINUTE_MS: u64 = 60 * 1000;
/// `open` per visitor: 5 per 10 minutes and 20 per day. The 110-bit code is what makes guessing fail; these keep
/// den-edge from being a cheap existence oracle or load target.
const OPEN_SHORT: (u32, u64) = (5, 10 * MINUTE_MS);
const OPEN_DAY: (u32, u64) = (20, 24 * 60 * MINUTE_MS);
/// `POST`, `GET` and `DELETE /recovery` per visitor, counted only once the member proof holds.
const OWNER: (u32, u64) = (60, 60 * MINUTE_MS);
/// Recovery's own budget table (`AppState::recovery_claims`): two per visitor that opens, one per member. Full, it
/// evicts rather than refuses (`link::Throttles`), so filling it locks nobody out (§5).
pub const LIMIT_BUCKETS: usize = if cfg!(test) { 64 } else { 16 * 1024 };

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Entry {
    locator: String,
    sealed: String,
    created_at: u64,
    opens: u64,
    last_opened_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct Entries {
    v: u32,
    entries: Vec<Entry>,
}

fn lib_key(id: &str) -> String {
    format!("lib:{id}")
}

fn loc_key(locator: &str) -> String {
    format!("loc:{locator}")
}

/// 16 bytes as lowercase hex.
fn valid_locator(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Unpadded base64url within §5's bounds.
fn valid_sealed(s: &str) -> bool {
    (SEALED_MIN..=SEALED_MAX).contains(&s.len())
        && s.len() % 4 != 1
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

async fn load(state: &AppState, id: &str) -> io::Result<Entries> {
    match state.store.get(NS, &lib_key(id)).await? {
        Some(bytes) => {
            let entries: Entries = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            if entries.v > VERSION {
                return Err(io::Error::other("recovery entries from a newer den-edge"));
            }
            Ok(entries)
        }
        None => Ok(Entries { v: VERSION, entries: Vec::new() }),
    }
}

async fn save(state: &AppState, id: &str, entries: &Entries) -> io::Result<()> {
    if entries.entries.is_empty() {
        state.store.delete(NS, &lib_key(id)).await
    } else {
        state
            .store
            .put(NS, &lib_key(id), &serde_json::to_vec(entries).expect("entries always serialise"))
            .await
    }
}

/// The library a locator's entry belongs to.
async fn owner_of(state: &AppState, locator: &str) -> io::Result<Option<String>> {
    Ok(state.store.get(NS, &loc_key(locator)).await?.and_then(|bytes| String::from_utf8(bytes).ok()))
}

/// Counts one request against `bucket` in fixed windows, in recovery's own table; the refusal once it is over.
fn limited(state: &AppState, bucket: &str, ip: &str, (limit, window): (u32, u64)) -> Option<Response> {
    crate::link::throttled_in_window(
        &state.recovery_claims,
        state.now(),
        &format!("{bucket}:{ip}"),
        limit,
        window,
    )
    .map(|wait| retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait))
}

pub fn is_path(path: &str) -> bool {
    path == "/recovery" || path == "/recovery/open"
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    let ip = crate::handler::client_ip(state, &req);
    // `/recovery/open` takes only a POST: `handler::allowed_methods` refuses anything else before this.
    if req.uri().path() == "/recovery/open" {
        if let Some(refused) = limited(state, "recovery-open", &ip, OPEN_SHORT)
            .or_else(|| limited(state, "recovery-open-day", &ip, OPEN_DAY))
        {
            return refused;
        }
        return open(state, req).await;
    }
    let claim =
        req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let Some((id, _)) = claim.as_deref().and_then(|c| c.split_once(':')) else {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    };
    let id = id.to_owned();
    if !crate::library::is_member(state, claim.as_deref()).await {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    }
    // Counted after the proof: an anonymous request makes no bucket.
    if let Some(refused) = limited(state, "recovery", &ip, OWNER) {
        return refused;
    }
    match req.method().clone() {
        Method::POST => create(state, &id, claim.as_deref().unwrap_or_default(), req).await,
        Method::GET => list(state, &id).await,
        Method::DELETE => remove(state, &id, req).await,
        _ => method_not_allowed(),
    }
}

/// A body's `locator`, and its `sealed` when `with_sealed`.
async fn body(req: Request, with_sealed: bool) -> Result<(String, Option<String>), Box<Response>> {
    let body = read_json(req, MAX_BODY_BYTES).await?;
    let bad = || Box::new(json_reply(StatusCode::BAD_REQUEST, &error("bad_request")));
    let locator = body.get("locator").and_then(Value::as_str).filter(|l| valid_locator(l)).ok_or_else(bad)?;
    let sealed = if with_sealed {
        Some(
            body.get("sealed")
                .and_then(Value::as_str)
                .filter(|s| valid_sealed(s))
                .ok_or_else(bad)?
                .to_owned(),
        )
    } else {
        None
    };
    Ok((locator.to_owned(), sealed))
}

async fn create(state: &AppState, id: &str, claim: &str, req: Request) -> Response {
    let (locator, sealed) = match body(req, true).await {
        Ok(parsed) => parsed,
        Err(resp) => return *resp,
    };
    let now = state.now();
    let _lock = state.recovery_lock.lock().await;
    // Again under the lock `DELETE /lib/{id}` holds across its cascade and the retirement: an entry written after the
    // library was retired would open, and no proof could list or delete it (§5 *Cascade*).
    if !crate::library::is_member(state, Some(claim)).await {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    }
    match owner_of(state, &locator).await {
        Ok(Some(_)) => return json_reply(StatusCode::CONFLICT, &error("locator_taken")),
        Ok(None) => {}
        Err(e) => return internal("recovery read", e),
    }
    let mut entries = match load(state, id).await {
        Ok(entries) => entries,
        Err(e) => return internal("recovery read", e),
    };
    if entries.entries.len() >= MAX_PER_LIBRARY {
        return json_reply(StatusCode::CONFLICT, &error("recovery_full"));
    }
    entries.entries.push(Entry {
        locator: locator.clone(),
        sealed: sealed.expect("asked for"),
        created_at: now,
        opens: 0,
        last_opened_at: None,
    });
    // The library's file first: a locator file always names a library that lists it, and a crash between the two
    // leaves an entry the owner lists and deletes, never one that opens without being listed.
    let written = async {
        save(state, id, &entries).await?;
        state.store.put(NS, &loc_key(&locator), id.as_bytes()).await?;
        state.store.sync_dir(NS).await
    };
    if let Err(e) = written.await {
        return internal("recovery write", e);
    }
    json_reply(StatusCode::CREATED, &json!({ "createdAt": now }))
}

async fn list(state: &AppState, id: &str) -> Response {
    let entries = match load(state, id).await {
        Ok(entries) => entries,
        Err(e) => return internal("recovery read", e),
    };
    let entries: Vec<Value> = entries
        .entries
        .iter()
        .map(|e| {
            json!({
                "locator": e.locator,
                "createdAt": e.created_at,
                "opens": e.opens,
                "lastOpenedAt": e.last_opened_at,
            })
        })
        .collect();
    json_reply(StatusCode::OK, &json!({ "entries": entries }))
}

async fn remove(state: &AppState, id: &str, req: Request) -> Response {
    let (locator, _) = match body(req, false).await {
        Ok(parsed) => parsed,
        Err(resp) => return *resp,
    };
    let _lock = state.recovery_lock.lock().await;
    let mut entries = match load(state, id).await {
        Ok(entries) => entries,
        Err(e) => return internal("recovery read", e),
    };
    let before = entries.entries.len();
    entries.entries.retain(|e| e.locator != locator);
    if entries.entries.len() == before {
        return json_reply(StatusCode::OK, &json!({ "deleted": false }));
    }
    // The locator file first, so the entry stops opening before it stops being listed.
    let written = async {
        state.store.delete(NS, &loc_key(&locator)).await?;
        save(state, id, &entries).await?;
        state.store.sync_dir(NS).await
    };
    if let Err(e) = written.await {
        return internal("recovery delete", e);
    }
    json_reply(StatusCode::OK, &json!({ "deleted": true }))
}

async fn open(state: &AppState, req: Request) -> Response {
    let (locator, _) = match body(req, false).await {
        Ok(parsed) => parsed,
        Err(resp) => return *resp,
    };
    let unknown = || json_reply(StatusCode::NOT_FOUND, &error("unknown_code"));
    let now = state.now();
    let _lock = state.recovery_lock.lock().await;
    let id = match owner_of(state, &locator).await {
        Ok(Some(id)) => id,
        Ok(None) => return unknown(),
        Err(e) => return internal("recovery read", e),
    };
    let mut entries = match load(state, &id).await {
        Ok(entries) => entries,
        Err(e) => return internal("recovery read", e),
    };
    let Some(entry) = entries.entries.iter_mut().find(|e| e.locator == locator) else { return unknown() };
    entry.opens += 1;
    entry.last_opened_at = Some(now);
    let sealed = entry.sealed.clone();
    // The count is advisory (§5): a failure to record it does not keep the person out of their library. Synced like
    // every other write here, so a crash loses no count the person was shown: "opened 0 times" after a crash must not
    // hide a stolen code.
    let counted = async {
        save(state, &id, &entries).await?;
        state.store.sync_dir(NS).await
    };
    if let Err(e) = counted.await {
        eprintln!("recovery open count: {e}");
    }
    json_reply(StatusCode::OK, &json!({ "sealed": sealed }))
}

/// Deletes every entry of library `id`. `DELETE /lib/{id}` calls it before the library is retired, holding
/// `recovery_lock` (taken before the library's own lock) across both, so `create` cannot slip an entry in between
/// (§5 *Cascade*).
pub async fn delete_library(state: &AppState, id: &str) -> io::Result<()> {
    let entries = load(state, id).await?;
    for entry in &entries.entries {
        state.store.delete(NS, &loc_key(&entry.locator)).await?;
    }
    state.store.delete(NS, &lib_key(id)).await?;
    state.store.sync_dir(NS).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, Harness};
    use std::net::IpAddr;
    use std::sync::Arc;

    const LIB: &str = "0123456789abcdef0123456789abcdef";
    const LIB2: &str = "fedcba9876543210fedcba9876543210";
    const TOKEN: &str = "the-write-token";
    const TOKEN2: &str = "the-other-token";
    const LOC: &str = "df858499eebc4d6ea5736d45e3019632";
    const SEALED: &str = "AAECAwQFBgcICQoLlCJZe4Oyvi9z_AUppqfkMI4h8K6p9ZVLCC4DQL7Ovh9eOx3IEdTxSjbYneBl4oHxJhOwhkA_Mjsu_sfPhf7unhVCJeaeO29P6YgG4SWX7YC7b8D8h_YA_LTThorPNOr43Kp8wP5nvv8ikkCz";

    fn loc(n: u8) -> String {
        format!("{n:02x}{}", &LOC[2..])
    }

    async fn start(h: &Harness, lib: &str, token: &str) {
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let started =
            h.send("POST", &format!("/lib/{lib}/batch"), Some(body), &[("x-den-library-token", token)]).await;
        assert_eq!(started.status(), StatusCode::OK);
    }

    async fn harness() -> Harness {
        let h = Harness::new();
        start(&h, LIB, TOKEN).await;
        start(&h, LIB2, TOKEN2).await;
        h
    }

    async fn owner(h: &Harness, method: &str, member: &str, body: Option<Value>) -> (StatusCode, Value) {
        let resp = h
            .send(
                method,
                "/recovery",
                body.map(|b| b.to_string()),
                &[("x-den-library-member", member), ("content-type", "application/json")],
            )
            .await;
        let status = resp.status();
        (status, body_json(resp).await)
    }

    fn member() -> String {
        format!("{LIB}:{TOKEN}")
    }

    async fn make(h: &Harness, locator: &str) -> (StatusCode, Value) {
        owner(h, "POST", &member(), Some(json!({ "locator": locator, "sealed": SEALED }))).await
    }

    async fn open_from(h: &Harness, locator: &str, headers: &[(&str, &str)]) -> Response {
        h.send("POST", "/recovery/open", Some(json!({ "locator": locator }).to_string()), headers).await
    }

    #[tokio::test]
    async fn an_entry_is_made_listed_opened_without_a_credential_and_counted() {
        let h = harness().await;
        let (status, made) = make(&h, LOC).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(made["createdAt"], 1_000_000);

        let opened = open_from(&h, LOC, &[]).await;
        assert_eq!(opened.status(), StatusCode::OK);
        assert_eq!(body_json(opened).await, json!({ "sealed": SEALED }));
        h.advance(5);
        assert_eq!(open_from(&h, LOC, &[]).await.status(), StatusCode::OK);

        let (status, listed) = owner(&h, "GET", &member(), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            listed,
            json!({ "entries": [{ "locator": LOC, "createdAt": 1_000_000, "opens": 2, "lastOpenedAt": 1_000_005 }] })
        );
    }

    #[tokio::test]
    async fn an_unknown_locator_is_unknown_code_and_a_malformed_one_a_bad_request() {
        let h = harness().await;
        let resp = open_from(&h, LOC, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(resp).await, json!({ "error": "unknown_code" }));
        assert_eq!(
            open_from(&h, "DF858499EEBC4D6EA5736D45E3019632", &[]).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(open_from(&h, &LOC[..30], &[]).await.status(), StatusCode::BAD_REQUEST);
        let get = h.send("GET", "/recovery/open", None, &[]).await;
        assert_eq!(get.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn the_owner_routes_need_the_member_proof_of_the_library_that_owns_the_entry() {
        let h = harness().await;
        let body = json!({ "locator": LOC, "sealed": SEALED });
        for (method, body) in
            [("POST", Some(body.clone())), ("GET", None), ("DELETE", Some(json!({ "locator": LOC })))]
        {
            assert_eq!(
                owner(&h, method, "", body.clone()).await.0,
                StatusCode::FORBIDDEN,
                "{method} without"
            );
            let forged = format!("{LIB}:not-the-token");
            assert_eq!(
                owner(&h, method, &forged, body.clone()).await.0,
                StatusCode::FORBIDDEN,
                "{method} forged"
            );
            let resp = h.send(method, "/recovery", body.map(|b| b.to_string()), &[]).await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN, "{method} with no header");
        }
        assert_eq!(make(&h, LOC).await.0, StatusCode::CREATED);

        // Another library's proof neither lists nor deletes it, and cannot take its locator.
        let other = format!("{LIB2}:{TOKEN2}");
        assert_eq!(owner(&h, "GET", &other, None).await.1, json!({ "entries": [] }));
        assert_eq!(
            owner(&h, "DELETE", &other, Some(json!({ "locator": LOC }))).await,
            (StatusCode::OK, json!({ "deleted": false }))
        );
        assert_eq!(
            owner(&h, "POST", &other, Some(json!({ "locator": LOC, "sealed": SEALED }))).await,
            (StatusCode::CONFLICT, json!({ "error": "locator_taken" }))
        );
        assert_eq!(open_from(&h, LOC, &[]).await.status(), StatusCode::OK, "still there");
    }

    #[tokio::test]
    async fn a_library_holds_four_entries_and_delete_is_idempotent() {
        let h = harness().await;
        for n in 0..4 {
            assert_eq!(make(&h, &loc(n)).await.0, StatusCode::CREATED);
        }
        assert_eq!(make(&h, &loc(4)).await, (StatusCode::CONFLICT, json!({ "error": "recovery_full" })));
        assert_eq!(make(&h, &loc(0)).await, (StatusCode::CONFLICT, json!({ "error": "locator_taken" })));

        let gone = Some(json!({ "locator": loc(0) }));
        assert_eq!(
            owner(&h, "DELETE", &member(), gone.clone()).await,
            (StatusCode::OK, json!({ "deleted": true }))
        );
        assert_eq!(owner(&h, "DELETE", &member(), gone).await, (StatusCode::OK, json!({ "deleted": false })));
        assert_eq!(open_from(&h, &loc(0), &[]).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(make(&h, &loc(4)).await.0, StatusCode::CREATED, "room again");
        assert_eq!(owner(&h, "GET", &member(), None).await.1["entries"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn deleting_the_library_deletes_its_entries_and_its_proof_no_longer_counts() {
        let h = harness().await;
        make(&h, LOC).await;
        let other = format!("{LIB2}:{TOKEN2}");
        owner(&h, "POST", &other, Some(json!({ "locator": loc(9), "sealed": SEALED }))).await;

        let deleted = h.send("DELETE", &format!("/lib/{LIB}"), None, &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(deleted.status(), StatusCode::OK);
        assert_eq!(open_from(&h, LOC, &[]).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(owner(&h, "GET", &member(), None).await.0, StatusCode::FORBIDDEN);
        assert_eq!(open_from(&h, &loc(9), &[]).await.status(), StatusCode::OK, "another library's stays");
    }

    #[tokio::test]
    async fn an_entry_survives_a_restart_and_a_backup_restored_elsewhere() {
        let h = harness().await;
        make(&h, LOC).await;
        let restarted = Harness::in_dir(h.dir.clone());
        assert_eq!(open_from(&restarted, LOC, &[]).await.status(), StatusCode::OK);

        // A backup is a copy of the store's directory; restored, it opens with a new generation and the same entries.
        let restored_dir = crate::handler::tests::temp_dir();
        copy_dir(&h.dir, &restored_dir);
        let _ = std::fs::remove_file(restored_dir.join("generation"));
        let restored = Harness::in_dir(restored_dir);
        assert_eq!(body_json(open_from(&restored, LOC, &[]).await).await, json!({ "sealed": SEALED }));
        assert_eq!(owner(&restored, "GET", &member(), None).await.1["entries"][0]["opens"], 2);
    }

    /// One visitor per /64 filling recovery's table with day-long buckets locks nobody out: not a new visitor's
    /// `open`, and not another route, which counts in a table recovery never touches (§5).
    #[tokio::test]
    async fn filling_the_limit_table_locks_no_one_out() {
        let mut h = harness().await;
        Arc::get_mut(&mut h.state).unwrap().trusted_proxies = vec![IpAddr::from([192, 168, 1, 9])];
        for n in 0..LIMIT_BUCKETS {
            let visitor = format!("2001:db8:0:{n:x}::1");
            assert_eq!(
                open_from(&h, LOC, &[("x-forwarded-for", &visitor)]).await.status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(crate::lock(&h.state.recovery_claims).len(), LIMIT_BUCKETS, "full");
        let fresh = [("x-forwarded-for", "2001:db8:ffff::1")];
        assert_eq!(
            open_from(&h, LOC, &fresh).await.status(),
            StatusCode::NOT_FOUND,
            "a new visitor still opens"
        );
        let pair = h
            .send(
                "POST",
                "/pair/new",
                Some(json!({ "sid": "000102030405060708090a0b0c0d0e0f" }).to_string()),
                &fresh,
            )
            .await;
        assert_eq!(pair.status(), StatusCode::OK, "and pairing is untouched");
        assert!(crate::lock(&h.state.claims).len() < 4, "recovery never counted in the shared table");
    }

    /// The owner routes count a visitor only once the member proof holds: anonymous calls make no bucket.
    #[tokio::test]
    async fn anonymous_owner_calls_make_no_bucket() {
        let h = harness().await;
        for _ in 0..100 {
            assert_eq!(owner(&h, "GET", "", None).await.0, StatusCode::FORBIDDEN);
        }
        assert_eq!(crate::lock(&h.state.recovery_claims).len(), 0);
        assert_eq!(owner(&h, "GET", &member(), None).await.0, StatusCode::OK);
    }

    /// A `POST` that passed the member check before a `DELETE /lib/{id}` retired the library writes nothing: it checks
    /// again under the lock the cascade and the retirement hold (§5 *Cascade*).
    #[tokio::test]
    async fn a_post_racing_the_library_delete_writes_no_entry() {
        let h = Arc::new(harness().await);
        let held = h.state.recovery_lock.lock().await;
        let deleting = tokio::spawn({
            let h = Arc::clone(&h);
            async move {
                h.send("DELETE", &format!("/lib/{LIB}"), None, &[("x-den-library-token", TOKEN)])
                    .await
                    .status()
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // The delete waits on the lock; the library still stands, so this post passes its first check and waits too.
        let posting = tokio::spawn({
            let h = Arc::clone(&h);
            async move { make(&h, LOC).await.0 }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(held);
        assert_eq!(deleting.await.unwrap(), StatusCode::OK);
        assert_eq!(posting.await.unwrap(), StatusCode::FORBIDDEN);
        assert_eq!(open_from(&h, LOC, &[]).await.status(), StatusCode::NOT_FOUND, "no orphan opens");
    }

    fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &to.join(entry.file_name()));
            } else {
                std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
            }
        }
    }

    /// Behind a trusted proxy each visitor it reports is its own bucket; the proxy's own address is never one.
    #[tokio::test]
    async fn open_is_limited_per_visitor_behind_a_trusted_proxy() {
        let mut h = harness().await;
        Arc::get_mut(&mut h.state).unwrap().trusted_proxies = vec![IpAddr::from([192, 168, 1, 9])];
        let alice = [("x-forwarded-for", "203.0.113.7")];
        let bob = [("x-forwarded-for", "198.51.100.4")];
        for _ in 0..5 {
            assert_eq!(open_from(&h, LOC, &alice).await.status(), StatusCode::NOT_FOUND);
        }
        let refused = open_from(&h, LOC, &alice).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(refused.headers()[axum::http::header::RETRY_AFTER], "600");
        assert_eq!(body_json(refused).await, json!({ "error": "rate_limited" }));
        assert_eq!(
            open_from(&h, LOC, &bob).await.status(),
            StatusCode::NOT_FOUND,
            "another visitor, another bucket"
        );

        // 20 a day: four ten-minute windows of five, then the day's refusal says when the day ends.
        for _ in 0..3 {
            h.advance(10 * MINUTE_MS);
            for _ in 0..5 {
                assert_eq!(open_from(&h, LOC, &alice).await.status(), StatusCode::NOT_FOUND);
            }
        }
        h.advance(10 * MINUTE_MS);
        let refused = open_from(&h, LOC, &alice).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        let wait: u64 = refused.headers()[axum::http::header::RETRY_AFTER].to_str().unwrap().parse().unwrap();
        assert_eq!(wait, (24 * 60 - 40) * 60);
        h.advance(wait * 1000);
        assert_eq!(open_from(&h, LOC, &alice).await.status(), StatusCode::NOT_FOUND, "a new day");
    }

    #[tokio::test]
    async fn the_owner_routes_share_sixty_an_hour_per_visitor() {
        let h = harness().await;
        for _ in 0..60 {
            assert_eq!(owner(&h, "GET", &member(), None).await.0, StatusCode::OK);
        }
        let resp = h.send("GET", "/recovery", None, &[("x-den-library-member", &member())]).await;
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(resp.headers()[axum::http::header::RETRY_AFTER], "3600");
    }

    /// What a request is logged as: its route label and its error code. Neither may carry a locator, a sealed
    /// value or a member proof.
    #[tokio::test]
    async fn no_secret_reaches_the_request_log() {
        let h = harness().await;
        let member = member();
        let secrets = [LOC, SEALED, TOKEN, member.as_str()];
        let make_body = json!({ "locator": LOC, "sealed": SEALED }).to_string();
        let calls: [(&str, &str, Option<String>); 5] = [
            ("POST", "/recovery", Some(make_body.clone())),
            ("POST", "/recovery", Some(make_body)),
            ("GET", "/recovery", None),
            ("POST", "/recovery/open", Some(json!({ "locator": LOC }).to_string())),
            ("DELETE", "/recovery", Some(json!({ "locator": LOC }).to_string())),
        ];
        for (method, path, body) in calls {
            let resp = h.send(method, path, body, &[("x-den-library-member", &member)]).await;
            let route = crate::handler::route_label(path);
            assert_eq!(route, path);
            let code =
                resp.extensions().get::<crate::handler::ErrorCode>().map(|c| c.0.clone()).unwrap_or_default();
            for secret in secrets {
                assert!(!route.contains(secret) && !code.contains(secret), "{method} {path}");
            }
        }
    }
}
