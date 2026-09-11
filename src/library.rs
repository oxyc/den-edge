//! `/lib/{id}/…` — the library record log (the Den Web plan, §C): an ordered, durable mailbox of per-record
//! ciphertext that the clients merge. Each record key holds only its latest value and every write takes the
//! next sequence number, so a client catches up with "everything after N" and the log never grows past the
//! live records for long. A write names the sequence it was based on; a stale one is refused with the current
//! row, which the client merges and writes again — compare-and-set per record. Tombstones are ordinary
//! writes, and nothing expires.
//!
//!   POST /lib/{id}/batch  { writes: [{ k, base, v }] } → { head, applied: [{ k, seq }], conflicts: [{ k, seq, v }], generation }
//!   GET  /lib/{id}/changes?since=N&limit=L            → { entries: [{ k, seq, v }], head, more, generation }
//!   DELETE /lib/{id}                                   → { deleted: true }
//!
//! All carry `x-den-library-token`. The first write to a library sets it — only its SHA-256 is kept — and
//! every later request must match it. A library nobody has written is a 404, which carries `generation` too.
//!
//! `generation` is the store's (`Store::generation`): a different one tells a client that remembers how far it
//! read that this store was restored or started over, so it reads from 0 and writes back what it holds.
//!
//! On disk a library is one append-only log, `lib/<sha256(id)>.log`: a line with the token's hash, then a
//! line per applied write, synced before the answer goes out. It is replayed into memory on first use and
//! rewritten without its superseded lines once they outnumber the live ones.

use crate::handler::{
    constant_time_eq, error, internal, json_reply, method_not_allowed, query_param, read_json,
};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io;

const NS: &str = "lib";
const EXT: &str = "log";
/// A deleted library's marker: its id is retired.
const MOVED: &str = "moved";
const TOKEN_HEADER: &str = "x-den-library-token";
/// Writes per batch: a client pushes a few at a time, and a first upload of a few thousand in batches.
const MAX_WRITES: usize = 200;
/// A sealed record is under a kilobyte; this is room for any, not a target.
const MAX_VALUE: usize = 32 * 1024;
pub const BATCH_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_LIMIT: usize = 500;
const MAX_LIMIT: usize = 1000;
/// Superseded lines tolerated beyond the live ones before the log is rewritten.
const COMPACT_SLACK: usize = if cfg!(test) { 8 } else { 1000 };
/// Rows a library may hold: a long-time viewer's titles and episodes fit many times over; a stranger using the
/// relay as free storage hits it (issue #8, #5).
const MAX_ROWS: usize = if cfg!(test) { 8 } else { 50_000 };
/// A library nobody has touched for this long leaves memory; its log reloads it on the next request.
const IDLE_MS: u64 = 60 * 60 * 1000;

pub struct Library {
    token_hash: [u8; 32],
    head: u64,
    rows: HashMap<String, Row>,
    /// Write lines in the log file, superseded ones included.
    lines: usize,
    /// When a request last used it, for dropping idle libraries from memory.
    last_used: u64,
}

struct Row {
    seq: u64,
    v: String,
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

pub async fn handle(state: &AppState, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let Some(rest) = path.strip_prefix("/lib/") else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let (id, action) = rest.split_once('/').unwrap_or((rest, ""));
    if !valid_hex_id(id) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_library_id"));
    }
    let Some(token) = req
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|t| !t.is_empty() && t.len() <= 256)
    else {
        return json_reply(StatusCode::UNAUTHORIZED, &error("missing_token"));
    };
    let token_hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    match (action, req.method().clone()) {
        ("batch", Method::POST) => batch(state, id, token_hash, req).await,
        ("changes", Method::GET | Method::HEAD) => {
            let since = query_param(&req, "since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = query_param(&req, "limit")
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_LIMIT)
                .clamp(1, MAX_LIMIT);
            changes(state, id, token_hash, since, limit).await
        }
        ("", Method::DELETE) => forget(state, id, token_hash).await,
        ("batch" | "changes" | "", _) => method_not_allowed(),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

/// The library's owner ends it — a rekey moved the library to a new key (issue #8, audit #2). Its log and rows
/// are gone, and the id is retired: a device still holding the old key gets `410 library_moved` rather than
/// quietly starting the library over (den #12, S5).
async fn forget(state: &AppState, id: &str, token_hash: [u8; 32]) -> Response {
    let mut libs = state.libraries.lock().await;
    if let Err(e) = load(state, &mut libs, id).await {
        return internal("library read", e);
    }
    let Some(lib) = libs.get(id) else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    if !constant_time_eq(&lib.token_hash, &token_hash) {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    }
    if let Err(e) = state.store.replace_file(NS, id, MOVED, b"").await {
        return internal("library retire", e);
    }
    if let Err(e) = state.store.delete_file(NS, id, EXT).await {
        return internal("library delete", e);
    }
    libs.remove(id);
    json_reply(StatusCode::OK, &json!({ "deleted": true }))
}

/// Whether `id` belonged to a library its owner deleted. Asked only when no library is loaded under it.
async fn retired(state: &AppState, id: &str) -> io::Result<bool> {
    Ok(state.store.get_file(NS, id, MOVED).await?.is_some())
}

fn moved() -> Response {
    json_reply(StatusCode::GONE, &error("library_moved"))
}

async fn batch(state: &AppState, id: &str, token_hash: [u8; 32], req: Request) -> Response {
    let body = match read_json(req, BATCH_MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(resp) => return *resp,
    };
    let Some(writes) = parse_writes(&body) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_batch"));
    };
    let mut libs = state.libraries.lock().await;
    if let Err(e) = load(state, &mut libs, id).await {
        return internal("library read", e);
    }
    let now = state.now();
    touch(&mut libs, id, now);
    let fresh = Library { token_hash, head: 0, rows: HashMap::new(), lines: 0, last_used: now };
    let existing = libs.get(id);
    if existing.is_none() {
        match retired(state, id).await {
            Ok(true) => return moved(),
            Ok(false) => {}
            Err(e) => return internal("library read", e),
        }
    }
    if existing.is_some_and(|lib| !constant_time_eq(&lib.token_hash, &token_hash)) {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    }
    let lib = existing.unwrap_or(&fresh);
    let new_rows = writes.iter().filter(|w| !lib.rows.contains_key(&w.k)).count();
    if lib.rows.len() + new_rows > MAX_ROWS {
        return json_reply(StatusCode::PAYLOAD_TOO_LARGE, &error("library_full"));
    }

    // Decide every write against the state before this batch (keys are unique within it), write the
    // applied ones to disk, and only then change what is in memory — a failed write changes nothing.
    let mut head = lib.head;
    let mut out = if existing.is_none() { header_line(&token_hash) } else { String::new() };
    let mut applied = Vec::new();
    let mut conflicts = Vec::new();
    for w in writes {
        let current = lib.rows.get(&w.k);
        let current_seq = current.map_or(0, |r| r.seq);
        if current_seq != w.base {
            conflicts.push(json!({ "k": w.k, "seq": current_seq, "v": current.map(|r| r.v.clone()) }));
            continue;
        }
        head += 1;
        out.push_str(&log_line(head, &w.k, &w.v));
        applied.push((w.k, head, w.v));
    }
    if !out.is_empty() {
        if let Err(e) = state.store.append_file(NS, id, EXT, out.as_bytes()).await {
            return internal("library write", e);
        }
    }
    let lib = libs.entry(id.to_owned()).or_insert(fresh);
    let applied: Vec<Value> = applied
        .into_iter()
        .map(|(k, seq, v)| {
            let entry = json!({ "k": k, "seq": seq });
            lib.rows.insert(k, Row { seq, v });
            lib.lines += 1;
            entry
        })
        .collect();
    lib.head = head;
    if lib.lines > 2 * lib.rows.len() + COMPACT_SLACK {
        // The log already holds every write; a failed rewrite only leaves it longer than it needs to be.
        if let Err(e) = compact(state, id, lib).await {
            eprintln!("library compaction: {e}");
        }
    }
    state.metrics.record_library_writes(applied.len(), conflicts.len());
    json_reply(
        StatusCode::OK,
        &json!({ "head": head, "applied": applied, "conflicts": conflicts, "generation": state.store.generation() }),
    )
}

async fn changes(state: &AppState, id: &str, token_hash: [u8; 32], since: u64, limit: usize) -> Response {
    let mut libs = state.libraries.lock().await;
    if let Err(e) = load(state, &mut libs, id).await {
        return internal("library read", e);
    }
    touch(&mut libs, id, state.now());
    let Some(lib) = libs.get(id) else {
        return match retired(state, id).await {
            Ok(true) => moved(),
            // A store that lost its data answers here, so the generation goes with it.
            Ok(false) => json_reply(
                StatusCode::NOT_FOUND,
                &json!({ "error": "not_found", "generation": state.store.generation() }),
            ),
            Err(e) => internal("library read", e),
        };
    };
    if !constant_time_eq(&lib.token_hash, &token_hash) {
        return json_reply(StatusCode::FORBIDDEN, &error("forbidden"));
    }
    let mut rows: Vec<(&String, &Row)> = lib.rows.iter().filter(|(_, r)| r.seq > since).collect();
    rows.sort_by_key(|(_, r)| r.seq);
    let more = rows.len() > limit;
    let entries: Vec<Value> =
        rows.iter().take(limit).map(|(k, r)| json!({ "k": k, "seq": r.seq, "v": r.v })).collect();
    json_reply(
        StatusCode::OK,
        &json!({ "entries": entries, "head": lib.head, "more": more, "generation": state.store.generation() }),
    )
}

/// Mark `id` used now, and let every library idle for an hour go from memory: a relay that kept every library it
/// ever loaded would grow without bound. Their logs stay on disk, and `load` brings one back when it's asked for.
fn touch(libs: &mut HashMap<String, Library>, id: &str, now: u64) {
    libs.retain(|key, lib| key == id || now.saturating_sub(lib.last_used) < IDLE_MS);
    if let Some(lib) = libs.get_mut(id) {
        lib.last_used = now;
    }
}

/// Bring a library into memory from its log, if it has one and isn't already there.
async fn load(state: &AppState, libs: &mut HashMap<String, Library>, id: &str) -> io::Result<()> {
    if libs.contains_key(id) {
        return Ok(());
    }
    let Some(bytes) = state.store.get_file(NS, id, EXT).await? else { return Ok(()) };
    // An unreadable header is an error, not an absent library: treating it as absent would let the next
    // writer claim the library with a token of their own.
    let mut lib = replay(&bytes).ok_or_else(|| io::Error::other("unreadable library log header"))?;
    // A crash mid-append can leave a last line without its newline. Appending after it would fuse the next
    // write onto it, so the log is rewritten clean before anything is added.
    if !bytes.ends_with(b"\n") {
        compact(state, id, &mut lib).await?;
    }
    libs.insert(id.to_owned(), lib);
    Ok(())
}

fn replay(bytes: &[u8]) -> Option<Library> {
    let mut lines = bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty());
    let header: Value = serde_json::from_slice(lines.next()?).ok()?;
    let token_hash = from_hex32(header.get("token")?.as_str()?)?;
    let mut lib = Library { token_hash, head: 0, rows: HashMap::new(), lines: 0, last_used: 0 };
    for line in lines {
        // Only the last line can be cut short, and everything before it was synced.
        let Ok(line) = serde_json::from_slice::<Line>(line) else { break };
        lib.head = lib.head.max(line.s);
        lib.rows.insert(line.k, Row { seq: line.s, v: line.v });
        lib.lines += 1;
    }
    Some(lib)
}

/// Rewrite the log as its header and the live rows, in sequence order.
async fn compact(state: &AppState, id: &str, lib: &mut Library) -> io::Result<()> {
    let mut rows: Vec<(&String, &Row)> = lib.rows.iter().collect();
    rows.sort_by_key(|(_, r)| r.seq);
    let mut out = header_line(&lib.token_hash);
    for (k, r) in rows {
        out.push_str(&log_line(r.seq, k, &r.v));
    }
    state.store.replace_file(NS, id, EXT, out.as_bytes()).await?;
    lib.lines = lib.rows.len();
    Ok(())
}

fn header_line(token_hash: &[u8; 32]) -> String {
    format!("{}\n", json!({ "token": crate::hex(token_hash) }))
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
        let v = w.get("v")?.as_str().filter(|v| v.len() <= MAX_VALUE)?;
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

    const LIB: &str = "0123456789abcdef0123456789abcdef";
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
        assert_eq!(delete(&h, TOKEN).await, StatusCode::NOT_FOUND);

        // Across a restart too: a device still holding the old key can't start the library over.
        let reopened = Harness::in_dir(h.dir.clone());
        let body = json!({ "writes": [{ "k": K2, "base": 0, "v": "n1" }] }).to_string();
        let resp = reopened
            .send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)])
            .await;
        assert_eq!(resp.status(), StatusCode::GONE);
    }

    #[tokio::test]
    async fn writes_take_sequence_numbers_and_changes_replay_them_in_order() {
        let h = Harness::new();
        let (status, got) =
            batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }, { "k": K2, "base": 0, "v": "c2" }]))
                .await;
        assert_eq!(status, StatusCode::OK);
        let generation = h.state.store.generation();
        assert_eq!(
            got,
            json!({ "head": 2, "applied": [{ "k": K1, "seq": 1 }, { "k": K2, "seq": 2 }], "conflicts": [],
                    "generation": generation })
        );
        let (_, all) = changes(&h, TOKEN, "").await;
        assert_eq!(
            all,
            json!({ "entries": [{ "k": K1, "seq": 1, "v": "c1" }, { "k": K2, "seq": 2, "v": "c2" }],
                    "head": 2, "more": false, "generation": generation })
        );
    }

    /// The store's generation survives a restart; a store that comes back without it — restored from a backup,
    /// which leaves the file out, or started over — answers with a new one, a 404 included.
    #[tokio::test]
    async fn a_restored_store_answers_with_a_new_generation() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "c1" }])).await;
        let first = changes(&h, TOKEN, "").await.1["generation"].clone();
        assert_eq!(first.as_str().map(str::len), Some(32));

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
        assert_eq!(body["generation"].as_str(), Some(empty.state.store.generation()));
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
    async fn the_log_survives_a_restart_and_compacts_without_losing_a_row() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K2, "base": 0, "v": "kept" }])).await;
        let mut base = 0;
        for i in 0..40 {
            let (_, got) = batch(&h, TOKEN, json!([{ "k": K1, "base": base, "v": format!("v{i}") }])).await;
            base = got["applied"][0]["seq"].as_u64().expect("each rewrite is based on the last");
        }
        let log = std::fs::read_dir(h.dir.join("lib")).unwrap().next().unwrap().unwrap().path();
        let lines = std::fs::read_to_string(&log).unwrap().lines().count();
        assert!(lines < 20, "40 rewrites of one key left {lines} lines — the log was never compacted");

        let restarted = Harness::in_dir(h.dir.clone());
        let (_, all) = changes(&restarted, TOKEN, "").await;
        assert_eq!(
            all["entries"],
            json!([{ "k": K2, "seq": 1, "v": "kept" }, { "k": K1, "seq": 41, "v": "v39" }])
        );
        assert_eq!(all["head"], 41);
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
        assert_eq!(h.state.libraries.lock().await.len(), 1, "the idle library was dropped");
        assert_eq!(changes(&h, TOKEN, "").await.1["entries"][0]["v"], "kept");
    }

    /// A crash mid-append leaves the last line cut short. It is dropped, and the next write is not fused
    /// onto it.
    #[tokio::test]
    async fn a_torn_last_line_is_dropped_and_the_log_stays_readable() {
        let h = Harness::new();
        batch(&h, TOKEN, json!([{ "k": K1, "base": 0, "v": "whole" }])).await;
        let log = std::fs::read_dir(h.dir.join("lib")).unwrap().next().unwrap().unwrap().path();
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
}
