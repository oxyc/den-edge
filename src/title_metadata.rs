//! Shared title metadata observed by household clients.
//!
//! Provenance stays explicit: direct TMDB responses and Atlas's JustWatch-sourced IMDb score are stored as
//! separate observations. Each allowlisted field carries its own server timestamp so partial observations
//! merge and expire independently.
//!
//! TMDB answers fetched by the proxy are recorded behind their response (`observe_tmdb`, from `tmdb.rs`). Atlas
//! charts stay on the relay's bounded streaming path; the web client extracts their small rating projection and
//! batches it through `PUT /metadata/title`. `POST /metadata/title/query` is how every client reads observations.

use crate::handler::{client_ip, error, json_reply, read_json, retry_after};
use crate::AppState;
use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const MAX_PUBLISH_ENTRIES: usize = 100;
const MAX_QUERY_TITLES: usize = 200;
const MAX_BODY: usize = 32 * 1024;
const PER_WINDOW: u32 = 60;
const RETENTION_MS: u64 = 180 * 86_400_000;
const SOURCES: [&str; 2] = ["tmdb", "justwatch-imdb"];
const STORE_FILE: &str = "title-metadata.redb";
const STORE_CACHE_BYTES: usize = 4 * 1024 * 1024;
const STORE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const STORE_COMMIT_HEADROOM: u64 = 4 * 1024 * 1024;
const SWEEP_BATCH: usize = 512;
const ENTRIES: TableDefinition<&str, &[u8]> = TableDefinition::new("entries-v1");
const META: TableDefinition<&str, u64> = TableDefinition::new("meta-v1");
const LEGACY_IMPORTED: &str = "legacy-json-imported-v1";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaRef {
    #[serde(rename = "type")]
    kind: String,
    id: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Query {
    titles: Vec<MediaRef>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputFields {
    rating: Option<f64>,
    vote_count: Option<u32>,
    poster_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    #[serde(rename = "type")]
    kind: String,
    id: u32,
    source: String,
    fields: InputFields,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publish {
    entries: Vec<Observation>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observed<T> {
    value: T,
    observed_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    rating: Option<Observed<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vote_count: Option<Observed<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poster_path: Option<Observed<String>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    #[serde(rename = "type")]
    kind: String,
    id: u32,
    source: String,
    fields: StoredFields,
}

fn valid_ref(kind: &str, id: u32) -> bool {
    matches!(kind, "movie" | "tv") && id > 0
}
fn valid_rating(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= 10.0
}
fn valid_poster(path: &str) -> bool {
    path.len() <= 256
        && path.starts_with('/')
        && path.len() > 1
        && path[1..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
        && !path.contains("..")
}
fn nonempty(fields: &InputFields) -> bool {
    fields.rating.is_some() || fields.vote_count.is_some() || fields.poster_path.is_some()
}
fn valid_source(source: &str) -> bool {
    SOURCES.contains(&source)
}
fn valid_observation(o: &Observation) -> bool {
    valid_ref(&o.kind, o.id)
        && valid_source(&o.source)
        && nonempty(&o.fields)
        && o.fields.rating.is_none_or(valid_rating)
        && o.fields.poster_path.as_deref().is_none_or(valid_poster)
        && (o.source == "tmdb"
            || (o.fields.rating.is_some() && o.fields.vote_count.is_none() && o.fields.poster_path.is_none()))
}
fn fresh(at: u64, now: u64) -> bool {
    at <= now && now - at < RETENTION_MS
}

fn sanitize(fields: &mut StoredFields, source: &str, now: u64) {
    if fields.rating.as_ref().is_some_and(|v| !fresh(v.observed_at, now) || !valid_rating(v.value)) {
        fields.rating = None;
    }
    if fields.vote_count.as_ref().is_some_and(|v| !fresh(v.observed_at, now)) {
        fields.vote_count = None;
    }
    if fields.poster_path.as_ref().is_some_and(|v| !fresh(v.observed_at, now) || !valid_poster(&v.value)) {
        fields.poster_path = None;
    }
    if source != "tmdb" {
        fields.vote_count = None;
        fields.poster_path = None;
    }
}

fn empty(fields: &StoredFields) -> bool {
    fields.rating.is_none() && fields.vote_count.is_none() && fields.poster_path.is_none()
}

fn key(kind: &str, id: u32, source: &str) -> String {
    format!("{kind}:{id}:{source}")
}

#[derive(Debug)]
enum StoreError {
    Full,
    Failed(String),
}

impl StoreError {
    fn redb(error: impl Into<redb::Error>) -> Self {
        match error.into() {
            redb::Error::Io(error) if error.kind() == std::io::ErrorKind::StorageFull => Self::Full,
            error => Self::Failed(error.to_string()),
        }
    }

    fn io(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::StorageFull {
            Self::Full
        } else {
            Self::Failed(error.to_string())
        }
    }
}

/// The durable projection store. `Database` supplies one crash-atomic commit for a complete publish batch and
/// MVCC read snapshots for complete queries; the small explicit cache leaves headroom in den-edge's 64 MiB cgroup.
pub struct Store {
    database: Database,
    path: PathBuf,
}

trait ProjectionStore {
    fn merge_batch(&self, observations: Vec<Observation>, now: u64) -> Result<(), StoreError>;
    fn query_batch(&self, titles: Vec<MediaRef>, now: u64) -> Result<Vec<Entry>, StoreError>;
    fn sweep_expired(&self, now: u64) -> Result<(), StoreError>;
}

impl Store {
    fn open(dir: &Path, now: u64) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(StoreError::io)?;
        let path = dir.join(STORE_FILE);
        let mut builder = Database::builder();
        builder.set_cache_size(STORE_CACHE_BYTES);
        let database = builder.create(&path).map_err(StoreError::redb)?;
        let store = Self { database, path };
        store.import_legacy(dir, now)?;
        Ok(store)
    }

    /// Existing JSON records remain in place as a rollback copy. Bounded transactions leave resumable progress;
    /// the marker is committed only after the complete scan, and `Store::open` returns nothing before then, so a
    /// crash retries missing records instead of exposing a half-migrated store to requests.
    fn import_legacy(&self, dir: &Path, now: u64) -> Result<(), StoreError> {
        let transaction = self.database.begin_write().map_err(StoreError::redb)?;
        {
            let meta = transaction.open_table(META).map_err(StoreError::redb)?;
            if meta.get(LEGACY_IMPORTED).map_err(StoreError::redb)?.is_some() {
                return Ok(());
            }
            transaction.open_table(ENTRIES).map_err(StoreError::redb)?;
        }
        transaction.commit().map_err(StoreError::redb)?;

        let mut batch = Vec::with_capacity(SWEEP_BATCH);
        for file in std::fs::read_dir(dir).map_err(StoreError::io)? {
            let file = file.map_err(StoreError::io)?;
            if file.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(file.path()) else { continue };
            let Ok(mut entry) = serde_json::from_slice::<Entry>(&bytes) else { continue };
            if !valid_ref(&entry.kind, entry.id) || !valid_source(&entry.source) {
                continue;
            }
            let expected_name = format!("{}-{}-{}.json", entry.kind, entry.id, entry.source);
            if file.file_name().to_str() != Some(expected_name.as_str()) {
                continue;
            }
            sanitize(&mut entry.fields, &entry.source, now);
            if empty(&entry.fields) {
                continue;
            }
            let record_key = key(&entry.kind, entry.id, &entry.source);
            let value = serde_json::to_vec(&entry).map_err(|error| StoreError::Failed(error.to_string()))?;
            batch.push((record_key, value));
            if batch.len() == SWEEP_BATCH {
                self.import_batch(&mut batch)?;
            }
        }
        self.import_batch(&mut batch)?;

        let transaction = self.database.begin_write().map_err(StoreError::redb)?;
        {
            let mut meta = transaction.open_table(META).map_err(StoreError::redb)?;
            meta.insert(LEGACY_IMPORTED, &now).map_err(StoreError::redb)?;
        }
        transaction.commit().map_err(StoreError::redb)
    }

    fn import_batch(&self, records: &mut Vec<(String, Vec<u8>)>) -> Result<(), StoreError> {
        if records.is_empty() {
            return Ok(());
        }
        if !self.within_quota()? {
            return Err(StoreError::Full);
        }
        let transaction = self.database.begin_write().map_err(StoreError::redb)?;
        {
            let mut table = transaction.open_table(ENTRIES).map_err(StoreError::redb)?;
            for (record_key, value) in records.iter() {
                if table.get(record_key.as_str()).map_err(StoreError::redb)?.is_none() {
                    table.insert(record_key.as_str(), value.as_slice()).map_err(StoreError::redb)?;
                }
            }
        }
        transaction.commit().map_err(StoreError::redb)?;
        records.clear();
        Ok(())
    }

    fn within_quota(&self) -> Result<bool, StoreError> {
        Ok(std::fs::metadata(&self.path).map_err(StoreError::io)?.len()
            <= STORE_MAX_BYTES.saturating_sub(STORE_COMMIT_HEADROOM))
    }
}

impl ProjectionStore for Store {
    fn merge_batch(&self, observations: Vec<Observation>, now: u64) -> Result<(), StoreError> {
        if !self.within_quota()? {
            return Err(StoreError::Full);
        }
        let transaction = self.database.begin_write().map_err(StoreError::redb)?;
        {
            let mut table = transaction.open_table(ENTRIES).map_err(StoreError::redb)?;
            for observation in observations {
                let record_key = key(&observation.kind, observation.id, &observation.source);
                let mut fields = table
                    .get(record_key.as_str())
                    .map_err(StoreError::redb)?
                    .and_then(|bytes| serde_json::from_slice::<Entry>(bytes.value()).ok())
                    .filter(|entry| {
                        entry.kind == observation.kind
                            && entry.id == observation.id
                            && entry.source == observation.source
                    })
                    .map(|entry| entry.fields)
                    .unwrap_or_default();
                sanitize(&mut fields, &observation.source, now);
                if let Some(value) = observation.fields.rating {
                    fields.rating = Some(Observed { value, observed_at: now });
                }
                if let Some(value) = observation.fields.vote_count {
                    fields.vote_count = Some(Observed { value, observed_at: now });
                }
                if let Some(value) = observation.fields.poster_path {
                    fields.poster_path = Some(Observed { value, observed_at: now });
                }
                let entry =
                    Entry { kind: observation.kind, id: observation.id, source: observation.source, fields };
                let value =
                    serde_json::to_vec(&entry).map_err(|error| StoreError::Failed(error.to_string()))?;
                table.insert(record_key.as_str(), value.as_slice()).map_err(StoreError::redb)?;
            }
        }
        transaction.commit().map_err(StoreError::redb)
    }

    fn query_batch(&self, titles: Vec<MediaRef>, now: u64) -> Result<Vec<Entry>, StoreError> {
        let transaction = self.database.begin_read().map_err(StoreError::redb)?;
        let table = transaction.open_table(ENTRIES).map_err(StoreError::redb)?;
        let mut entries = Vec::new();
        for title in titles {
            for source in SOURCES {
                let record_key = key(&title.kind, title.id, source);
                let Some(bytes) = table.get(record_key.as_str()).map_err(StoreError::redb)? else { continue };
                let Ok(mut entry) = serde_json::from_slice::<Entry>(bytes.value()) else { continue };
                if entry.kind != title.kind || entry.id != title.id || entry.source != source {
                    continue;
                }
                sanitize(&mut entry.fields, source, now);
                if !empty(&entry.fields) {
                    entries.push(entry);
                }
            }
        }
        Ok(entries)
    }

    fn sweep_expired(&self, now: u64) -> Result<(), StoreError> {
        let mut after: Option<String> = None;
        loop {
            let keys = {
                let transaction = self.database.begin_read().map_err(StoreError::redb)?;
                let table = transaction.open_table(ENTRIES).map_err(StoreError::redb)?;
                let mut keys = Vec::with_capacity(SWEEP_BATCH);
                if let Some(after) = after.as_deref() {
                    for item in table
                        .range::<&str>((Bound::Excluded(after), Bound::Unbounded))
                        .map_err(StoreError::redb)?
                        .take(SWEEP_BATCH)
                    {
                        keys.push(item.map_err(StoreError::redb)?.0.value().to_owned());
                    }
                } else {
                    for item in table.iter().map_err(StoreError::redb)?.take(SWEEP_BATCH) {
                        keys.push(item.map_err(StoreError::redb)?.0.value().to_owned());
                    }
                }
                keys
            };
            let Some(last) = keys.last().cloned() else { return Ok(()) };
            let count = keys.len();
            let transaction = self.database.begin_write().map_err(StoreError::redb)?;
            {
                let mut table = transaction.open_table(ENTRIES).map_err(StoreError::redb)?;
                for record_key in keys {
                    let Some(value) = table.get(record_key.as_str()).map_err(StoreError::redb)? else {
                        continue;
                    };
                    let original = value.value();
                    let update = if let Ok(mut entry) = serde_json::from_slice::<Entry>(original) {
                        sanitize(&mut entry.fields, &entry.source, now);
                        if empty(&entry.fields) {
                            None
                        } else {
                            Some(
                                serde_json::to_vec(&entry)
                                    .map_err(|error| StoreError::Failed(error.to_string()))?,
                            )
                        }
                    } else {
                        None
                    };
                    drop(value);
                    if let Some(value) = update {
                        table.insert(record_key.as_str(), value.as_slice()).map_err(StoreError::redb)?;
                    } else {
                        table.remove(record_key.as_str()).map_err(StoreError::redb)?;
                    }
                }
            }
            transaction.commit().map_err(StoreError::redb)?;
            after = Some(last);
            if count < SWEEP_BATCH {
                return Ok(());
            }
        }
    }
}

async fn store(state: &AppState) -> Result<Arc<Store>, Unstored> {
    let Some(dir) = state.title_metadata_cache_dir.clone() else { return Err(Unstored::Unavailable) };
    let now = state.now();
    state
        .title_metadata_store
        .get_or_try_init(|| async move {
            tokio::task::spawn_blocking(move || Store::open(&dir, now))
                .await
                .map_err(|error| StoreError::Failed(error.to_string()))?
                .map(Arc::new)
        })
        .await
        .map(Arc::clone)
        .map_err(Unstored::from)
}

pub async fn handle(state: &Arc<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_per_minute(state, &format!("title-metadata:{ip}"), PER_WINDOW)
    {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    match (req.method().clone(), path.as_str()) {
        (Method::POST, "/metadata/title/query") => query(state, req).await,
        (Method::PUT, "/metadata/title") => publish(state, req).await,
        _ => json_reply(StatusCode::METHOD_NOT_ALLOWED, &error("method_not_allowed")),
    }
}

async fn query(state: &AppState, req: Request) -> Response {
    let value = match read_json(req, MAX_BODY).await {
        Ok(v) => v,
        Err(r) => return *r,
    };
    let Ok(body) = serde_json::from_value::<Query>(value) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_metadata_query"));
    };
    if body.titles.is_empty()
        || body.titles.len() > MAX_QUERY_TITLES
        || body.titles.iter().any(|r| !valid_ref(&r.kind, r.id))
    {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_metadata_query"));
    }
    let store = match store(state).await {
        Ok(store) => store,
        Err(Unstored::Unavailable) => return json_reply(StatusCode::OK, &json!({ "entries": [] })),
        Err(Unstored::Full | Unstored::Failed) => {
            return json_reply(StatusCode::INTERNAL_SERVER_ERROR, &error("metadata_store_failed"));
        }
    };
    let now = state.now();
    match tokio::task::spawn_blocking(move || store.query_batch(body.titles, now)).await {
        Ok(Ok(entries)) => json_reply(StatusCode::OK, &json!({ "entries": entries })),
        Ok(Err(store_error)) => {
            eprintln!("title metadata query: {store_error:?}");
            json_reply(StatusCode::INTERNAL_SERVER_ERROR, &error("metadata_store_failed"))
        }
        Err(task_error) => {
            eprintln!("title metadata query task: {task_error}");
            json_reply(StatusCode::INTERNAL_SERVER_ERROR, &error("metadata_store_failed"))
        }
    }
}

async fn publish(state: &AppState, req: Request) -> Response {
    let member =
        req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    if !crate::library::is_member(state, member.as_deref()).await {
        return json_reply(StatusCode::UNAUTHORIZED, &error("member_required"));
    }
    let value = match read_json(req, MAX_BODY).await {
        Ok(v) => v,
        Err(r) => return *r,
    };
    let Ok(body) = serde_json::from_value::<Publish>(value) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_metadata"));
    };
    if body.entries.is_empty()
        || body.entries.len() > MAX_PUBLISH_ENTRIES
        || body.entries.iter().any(|o| !valid_observation(o))
    {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_metadata"));
    }
    match merge(state, body.entries).await {
        Ok(()) => json_reply(StatusCode::NO_CONTENT, &Value::Null),
        Err(Unstored::Unavailable) => {
            json_reply(StatusCode::SERVICE_UNAVAILABLE, &error("metadata_store_unavailable"))
        }
        Err(Unstored::Full) => json_reply(StatusCode::INSUFFICIENT_STORAGE, &error("storage_full")),
        Err(Unstored::Failed) => {
            json_reply(StatusCode::INTERNAL_SERVER_ERROR, &error("metadata_store_failed"))
        }
    }
}

/// Why observations were not kept.
#[derive(Debug)]
enum Unstored {
    /// No store configured.
    Unavailable,
    /// The configured durable store is at its explicit or filesystem capacity.
    Full,
    /// A record could not be written.
    Failed,
}

impl From<StoreError> for Unstored {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Full => Self::Full,
            StoreError::Failed(message) => {
                eprintln!("title metadata store: {message}");
                Self::Failed
            }
        }
    }
}

/// Each observation is merged into what is kept for its title and source, field by field, with every field stamped
/// now. One write transaction commits the complete batch; the mutex avoids redundant writer contention.
async fn merge(state: &AppState, entries: Vec<Observation>) -> Result<(), Unstored> {
    let _write = state.title_metadata_writes.lock().await;
    let now = state.now();
    let store = store(state).await?;
    tokio::task::spawn_blocking(move || store.merge_batch(entries, now))
        .await
        .map_err(|error| {
            eprintln!("title metadata merge task: {error}");
            Unstored::Failed
        })?
        .map_err(Unstored::from)
}

/// Observations being worked out and written at once, past which a new answer's are not recorded. A page asks for
/// a row of titles at once, so a burst of misses is dozens; this bounds the work behind it, never the answers.
pub const OBSERVING: usize = 64;

/// What a TMDB answer den-edge just fetched says about its titles (`tmdb.rs`), kept as source `tmdb` — what a
/// browser used to send back with `PUT` after receiving it through this proxy. Worked out and written behind the
/// answer: spawned, bounded by `OBSERVING`, and unable to slow or fail it. An answer served from the cache is
/// not observed again; it was when it was fetched, and is again each time TMDB confirms it (a 304), so a title
/// seen only through a cached detail does not expire here.
pub fn observe_tmdb(state: &Arc<AppState>, path: &str, body: &Bytes) {
    let path = path.to_owned();
    record(state, body, move |body| tmdb_observations(&path, body));
}

/// Whether the observation was taken on: false with no store, or with `OBSERVING` already at work.
fn record(
    state: &Arc<AppState>,
    body: &Bytes,
    read: impl FnOnce(&[u8]) -> Vec<Observation> + Send + 'static,
) -> bool {
    if state.title_metadata_cache_dir.is_none() {
        return false;
    }
    let Ok(permit) = Arc::clone(&state.title_metadata_observing).try_acquire_owned() else { return false };
    let (state, body) = (Arc::clone(state), body.clone());
    tokio::spawn(async move {
        let _permit = permit;
        let entries = read(&body);
        if entries.is_empty() {
            return;
        }
        if let Err(e) = merge(&state, entries).await {
            eprintln!("title metadata: an observation was not kept ({e:?})");
        }
    });
    true
}

/// The allowlisted fields a TMDB answer carries for its titles: a title's own record (`/3/movie/550`), and every
/// title in a `results` list, typed by the path (`/3/discover/movie`) or by each item's `media_type`
/// (`/3/trending/all/week`). The web app's `metadataIn` did this before; unlike it, the top-level record counts
/// only on a title's own path and for its own id, because a season (`/3/tv/1399/season/1`) carries an id and a
/// rating of its own that are not the series'.
fn tmdb_observations(path: &str, body: &[u8]) -> Vec<Observation> {
    let Ok(Value::Object(parsed)) = serde_json::from_slice::<Value>(body) else { return Vec::new() };
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    let fixed = segments.iter().copied().find(|s| matches!(*s, "movie" | "tv"));
    let mut found: Vec<Observation> = Vec::new();
    let mut add = |kind: &str, item: &serde_json::Map<String, Value>| {
        let Some(id) = item.get("id").and_then(Value::as_u64).and_then(|id| u32::try_from(id).ok()) else {
            return;
        };
        let fields = InputFields {
            rating: item.get("vote_average").and_then(Value::as_f64).filter(|r| valid_rating(*r)),
            vote_count: item.get("vote_count").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()),
            poster_path: item
                .get("poster_path")
                .and_then(Value::as_str)
                .filter(|p| valid_poster(p))
                .map(str::to_owned),
        };
        let o = Observation { kind: kind.to_owned(), id, source: "tmdb".to_owned(), fields };
        if valid_observation(&o) && !found.iter().any(|f| f.kind == o.kind && f.id == o.id) {
            found.push(o);
        }
    };
    if let ["3", kind @ ("movie" | "tv"), id] = segments.as_slice() {
        if parsed.get("id").and_then(Value::as_u64).is_some_and(|own| id.parse() == Ok(own)) {
            add(kind, &parsed);
        }
    }
    if let Some(Value::Array(results)) = parsed.get("results") {
        for item in results.iter().filter_map(Value::as_object) {
            let kind = fixed.or_else(|| item.get("media_type").and_then(Value::as_str));
            if let Some(kind @ ("movie" | "tv")) = kind {
                add(kind, item);
            }
        }
    }
    found.truncate(MAX_PUBLISH_ENTRIES);
    found
}

pub async fn sweep_forever(state: Arc<AppState>) {
    if state.title_metadata_cache_dir.is_none() {
        return;
    }
    loop {
        sweep(&state).await;
        tokio::time::sleep(Duration::from_secs(86_400)).await;
    }
}

/// Expiry works in bounded transactions. Each candidate is read again inside its write transaction, so a renewal
/// committed after the scan saw the key is sanitized as fresh rather than removed; readers keep stable snapshots.
async fn sweep(state: &AppState) {
    let Ok(store) = store(state).await else { return };
    let now = state.now();
    if let Ok(Err(error)) = tokio::task::spawn_blocking(move || store.sweep_expired(now)).await {
        eprintln!("title metadata sweep: {error:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, Harness};
    use std::sync::atomic::Ordering;

    const LIB: &str = "0123456789abcdef";
    const TOKEN: &str = "metadata-writer";

    async fn harness() -> Harness {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().title_metadata_cache_dir = Some(h.dir.join("title-metadata"));
        let body = json!({"writes":[{"k":"aaaaaaaaaaaaaaaa","base":0,"v":"c1"}]}).to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK);
        h
    }

    async fn put_as(h: &Harness, source: &str, fields: Value) -> Response {
        let member = format!("{LIB}:{TOKEN}");
        h.send(
            "PUT",
            "/metadata/title",
            Some(json!({"entries":[{"type":"movie","id":550,"source":source,"fields":fields}]}).to_string()),
            &[(crate::library::MEMBER_HEADER, &member)],
        )
        .await
    }

    async fn put(h: &Harness, fields: Value) -> Response {
        put_as(h, "tmdb", fields).await
    }

    async fn get(h: &Harness) -> Value {
        body_json(
            h.send(
                "POST",
                "/metadata/title/query",
                Some(json!({"titles":[{"type":"movie","id":550}]}).to_string()),
                &[],
            )
            .await,
        )
        .await
    }

    /// Release-mode comparison fixture for the projection store. Run with:
    /// `cargo test --release title_metadata_store_benchmark -- --ignored --nocapture`
    ///
    /// This deliberately calls the same merge and query paths as the endpoints, after seeding a mixed-source
    /// working set. It is ignored because it measures the host filesystem rather than asserting a timing.
    #[tokio::test]
    #[ignore]
    async fn title_metadata_store_benchmark() {
        use http_body_util::BodyExt as _;
        use std::time::Instant;

        let h = harness().await;
        h.clock.store(2_000_000, Ordering::Relaxed);
        let observations = |count: usize, round: usize| {
            (0..count)
                .map(|index| Observation {
                    kind: if index % 3 == 0 { "tv" } else { "movie" }.to_owned(),
                    id: 1 + ((round * 211 + index) % 10_000) as u32,
                    source: if index % 4 == 0 { "justwatch-imdb" } else { "tmdb" }.to_owned(),
                    fields: if index % 4 == 0 {
                        InputFields {
                            rating: Some(5.0 + (index % 50) as f64 / 10.0),
                            ..InputFields::default()
                        }
                    } else if index % 2 == 0 {
                        InputFields {
                            poster_path: Some(format!("/poster-{index}.jpg")),
                            ..InputFields::default()
                        }
                    } else {
                        InputFields {
                            rating: Some(5.0 + (index % 50) as f64 / 10.0),
                            vote_count: Some((index * 17) as u32),
                            ..InputFields::default()
                        }
                    },
                })
                .collect::<Vec<_>>()
        };
        for round in 0..100 {
            merge(&h.state, observations(100, round)).await.unwrap();
        }

        for count in [1, 25, 100] {
            let mut samples = Vec::new();
            for round in 0..30 {
                let started = Instant::now();
                merge(&h.state, observations(count, 100 + round)).await.unwrap();
                samples.push(started.elapsed());
            }
            samples.sort_unstable();
            let total: Duration = samples.iter().sum();
            eprintln!(
                "title-metadata put/{count}: {:.1} batches/s p50={:?} p95={:?} p99={:?}",
                samples.len() as f64 / total.as_secs_f64(),
                samples[samples.len() / 2],
                samples[samples.len() * 95 / 100],
                samples[samples.len() * 99 / 100]
            );
        }
        for count in [1, 50, 200] {
            let titles = (0..count)
                .map(|index| MediaRef {
                    kind: if index % 3 == 0 { "tv" } else { "movie" }.to_owned(),
                    id: 1 + index as u32,
                })
                .collect::<Vec<_>>();
            let body = serde_json::to_vec(&Query { titles }).unwrap();
            let mut samples = Vec::new();
            for _ in 0..100 {
                let req = Request::builder().body(axum::body::Body::from(body.clone())).unwrap();
                let started = Instant::now();
                let response = query(&h.state, req).await;
                assert_eq!(response.status(), StatusCode::OK);
                response.into_body().collect().await.unwrap();
                samples.push(started.elapsed());
            }
            samples.sort_unstable();
            let total: Duration = samples.iter().sum();
            eprintln!(
                "title-metadata query/{count}: {:.1} batches/s p50={:?} p95={:?} p99={:?}",
                samples.len() as f64 / total.as_secs_f64(),
                samples[samples.len() / 2],
                samples[samples.len() * 95 / 100],
                samples[samples.len() * 99 / 100]
            );
        }
    }

    #[tokio::test]
    async fn partial_observations_merge_without_erasing_fresher_fields() {
        let h = harness().await;
        h.clock.store(1_000_000, Ordering::Relaxed);
        assert_eq!(put(&h, json!({"rating":8.4,"voteCount":31000})).await.status(), StatusCode::NO_CONTENT);
        h.clock.store(1_000_100, Ordering::Relaxed);
        assert_eq!(put(&h, json!({"posterPath":"/fight-club.jpg"})).await.status(), StatusCode::NO_CONTENT);
        let body = get(&h).await;
        assert_eq!(body["entries"][0]["fields"]["rating"], json!({"value":8.4,"observedAt":1_000_000}));
        assert_eq!(
            body["entries"][0]["fields"]["posterPath"],
            json!({"value":"/fight-club.jpg","observedAt":1_000_100})
        );
    }

    #[tokio::test]
    async fn simultaneous_partial_observations_do_not_lose_a_field() {
        let h = harness().await;
        h.clock.store(2_000_000, Ordering::Relaxed);
        let (rating, poster) = tokio::join!(
            put(&h, json!({"rating":8.4,"voteCount":31000})),
            put(&h, json!({"posterPath":"/fight-club.jpg"}))
        );
        assert_eq!(rating.status(), StatusCode::NO_CONTENT);
        assert_eq!(poster.status(), StatusCode::NO_CONTENT);
        let fields = get(&h).await["entries"][0]["fields"].clone();
        assert_eq!(fields["rating"]["value"], 8.4);
        assert_eq!(fields["posterPath"]["value"], "/fight-club.jpg");
    }

    #[tokio::test]
    async fn observations_from_different_sources_are_kept_separately() {
        let h = harness().await;
        h.clock.store(2_000_000, Ordering::Relaxed);
        assert_eq!(
            put_as(&h, "justwatch-imdb", json!({"rating":7.4})).await.status(),
            StatusCode::NO_CONTENT
        );
        h.clock.store(2_000_100, Ordering::Relaxed);
        assert_eq!(put(&h, json!({"rating":8.1,"voteCount":900})).await.status(), StatusCode::NO_CONTENT);
        let entries = get(&h).await["entries"].as_array().unwrap().clone();
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|entry| entry["source"] == "justwatch-imdb" && entry["fields"]["rating"]["value"] == 7.4));
        assert!(entries
            .iter()
            .any(|entry| entry["source"] == "tmdb" && entry["fields"]["rating"]["value"] == 8.1));
    }

    #[tokio::test]
    async fn writes_require_membership_and_reject_unknown_or_invalid_fields() {
        let h = harness().await;
        let body = Some(
            json!({"entries":[{"type":"movie","id":550,"source":"tmdb","fields":{"rating":8,"overview":"no"}}]})
                .to_string(),
        );
        assert_eq!(
            h.send("PUT", "/metadata/title", body.clone(), &[]).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let member = format!("{LIB}:{TOKEN}");
        assert_eq!(
            h.send("PUT", "/metadata/title", body, &[(crate::library::MEMBER_HEADER, &member)],)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            put(&h, json!({"posterPath":"https://bad.example/x.jpg"})).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            put_as(&h, "justwatch-imdb", json!({"posterPath":"/not-from-justwatch.jpg"})).await.status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn fields_expire_independently_and_malformed_records_are_not_served() {
        let h = harness().await;
        h.clock.store(1_000, Ordering::Relaxed);
        assert_eq!(put(&h, json!({"rating":7.1})).await.status(), StatusCode::NO_CONTENT);
        h.clock.store(1_000 + RETENTION_MS - 10, Ordering::Relaxed);
        assert_eq!(put(&h, json!({"posterPath":"/fresh.jpg"})).await.status(), StatusCode::NO_CONTENT);
        h.clock.store(1_000 + RETENTION_MS + 20, Ordering::Relaxed);
        let body = get(&h).await;
        assert!(body["entries"][0]["fields"].get("rating").is_none());
        assert_eq!(body["entries"][0]["fields"]["posterPath"]["value"], "/fresh.jpg");
        let projection = store(&h.state).await.unwrap();
        let replace = |source: &str, bytes: &[u8]| {
            let transaction = projection.database.begin_write().unwrap();
            {
                let mut table = transaction.open_table(ENTRIES).unwrap();
                table.insert(key("movie", 550, source).as_str(), bytes).unwrap();
            }
            transaction.commit().unwrap();
        };
        replace("tmdb", b"not-json");
        assert_eq!(get(&h).await, json!({"entries":[]}));

        let future = json!({
            "type":"movie","id":550,"source":"tmdb",
            "fields":{"rating":{"value":9.9,"observedAt":h.state.now() + 1}}
        });
        replace("tmdb", future.to_string().as_bytes());
        assert_eq!(get(&h).await, json!({"entries":[]}));

        let wrong_source_fields = json!({
            "type":"movie","id":550,"source":"justwatch-imdb",
            "fields":{
                "rating":{"value":7.4,"observedAt":h.state.now()},
                "posterPath":{"value":"/not-from-justwatch.jpg","observedAt":h.state.now()}
            }
        });
        replace("justwatch-imdb", wrong_source_fields.to_string().as_bytes());
        let answer = get(&h).await;
        assert!(answer["entries"][0]["fields"].get("posterPath").is_none());
    }

    /// An observation as kind, id, source, rating, votes and poster.
    type Seen<'a> = (String, u32, &'a str, Option<f64>, Option<u32>, Option<&'a str>);

    fn observed(o: &[Observation]) -> Vec<Seen<'_>> {
        o.iter()
            .map(|o| {
                let f = &o.fields;
                (o.kind.clone(), o.id, o.source.as_str(), f.rating, f.vote_count, f.poster_path.as_deref())
            })
            .collect()
    }

    /// What the web app's `metadataIn` read from a TMDB answer, now read here: a title's own record, and each
    /// title in a `results` list, typed by the path or by its `media_type`.
    #[test]
    fn a_tmdb_answer_is_read_for_its_titles_and_nothing_else() {
        let detail = br#"{"id":550,"title":"Fight Club","vote_average":8.4,"vote_count":31000,"poster_path":"/p.jpg"}"#;
        assert_eq!(
            observed(&tmdb_observations("/3/movie/550", detail)),
            [("movie".into(), 550, "tmdb", Some(8.4), Some(31000), Some("/p.jpg"))]
        );
        let listed = br#"{"page":1,"results":[{"id":1,"vote_average":7.0},{"id":"x"},{"id":2,"poster_path":"https://x"}]}"#;
        assert_eq!(
            observed(&tmdb_observations("/3/discover/tv", listed)),
            [("tv".into(), 1, "tmdb", Some(7.0), None, None)]
        );
        let trending = br#"{"results":[{"id":3,"media_type":"movie","vote_count":5},{"id":4,"media_type":"person","vote_average":6.0}]}"#;
        assert_eq!(
            observed(&tmdb_observations("/3/trending/all/week", trending)),
            [("movie".into(), 3, "tmdb", None, Some(5), None)]
        );
        // A season carries an id and a rating of its own, which are not the series'; nor is another title's id.
        let season = br#"{"id":3624,"vote_average":8.1,"poster_path":"/s.jpg","episodes":[]}"#;
        assert!(tmdb_observations("/3/tv/1399/season/1", season).is_empty());
        assert!(tmdb_observations("/3/movie/551", detail).is_empty());
        for junk in [&b"not json"[..], b"[1,2]", br#"{"id":550}"#, br#"{"id":550,"vote_average":11}"#] {
            assert!(tmdb_observations("/3/movie/550", junk).is_empty(), "{}", String::from_utf8_lossy(junk));
        }
    }

    /// Atlas catalogs stay on the relay's streaming path. With no `kept` header, the web client's existing bounded
    /// batch publisher sends their small rating projection back through `PUT /metadata/title`.
    #[tokio::test]
    async fn a_relayed_atlas_chart_is_left_to_the_clients_bounded_publisher() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|| async {
            let chart =
                json!({"metas":[{"type":"movie","moviedb_id":550,"name":"Fight Club","imdbRating":"8.8"}]});
            let mut resp = Response::new(axum::body::Body::from(chart.to_string()));
            resp.headers_mut().insert(axum::http::header::CONTENT_TYPE, "application/json".parse().unwrap());
            resp
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.title_metadata_cache_dir = Some(h.dir.join("title-metadata"));
        state.relays = crate::parse_relays(&format!("/atlas=http://{addr}"));

        let chart = h.send("GET", "/atlas/catalog/movie/jw-nfx/country=US.json", None, &[]).await;
        assert!(!chart.headers().contains_key("x-den-title-metadata"));
        let body = crate::handler::tests::body_json(chart).await;
        assert_eq!(body["metas"][0]["imdbRating"], "8.8", "the chart itself is unchanged");
    }

    #[tokio::test]
    async fn batches_and_storage_are_bounded_and_failed_storage_is_reported() {
        let h = harness().await;
        let member = format!("{LIB}:{TOKEN}");
        let entries: Vec<Value> = (1..=MAX_PUBLISH_ENTRIES + 1)
            .map(|id| json!({"type":"movie","id":id,"source":"tmdb","fields":{"rating":8.0}}))
            .collect();
        assert_eq!(
            h.send(
                "PUT",
                "/metadata/title",
                Some(json!({"entries": entries}).to_string()),
                &[(crate::library::MEMBER_HEADER, &member)],
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );

        let titles = |count: usize| (1..=count).map(|id| json!({"type":"movie","id":id})).collect::<Vec<_>>();
        assert_eq!(
            h.send(
                "POST",
                "/metadata/title/query",
                Some(json!({"titles": titles(MAX_QUERY_TITLES)}).to_string()),
                &[],
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            h.send(
                "POST",
                "/metadata/title/query",
                Some(json!({"titles": titles(MAX_QUERY_TITLES + 1)}).to_string()),
                &[],
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );

        let mut unavailable = Harness::new();
        let body = json!({"writes":[{"k":"aaaaaaaaaaaaaaaa","base":0,"v":"c1"}]}).to_string();
        assert_eq!(
            unavailable
                .send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)],)
                .await
                .status(),
            StatusCode::OK
        );
        Arc::get_mut(&mut unavailable.state).unwrap().title_metadata_cache_dir = None;
        assert_eq!(put(&unavailable, json!({"rating":8.0})).await.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// Expiry and renewal share the writer transaction boundary. Whichever commits last, a fresh field survives.
    #[tokio::test]
    async fn the_sweep_expires_fields_independently_and_does_not_lose_a_concurrent_renewal() {
        let h = harness().await;
        h.clock.store(1_000, Ordering::Relaxed);
        assert_eq!(put(&h, json!({"rating":7.1})).await.status(), StatusCode::NO_CONTENT);
        h.clock.store(1_000 + RETENTION_MS + 1, Ordering::Relaxed);
        let ((), renewed) = tokio::join!(sweep(&h.state), put(&h, json!({"posterPath":"/renewed.jpg"})),);
        assert_eq!(renewed.status(), StatusCode::NO_CONTENT);
        let fields = get(&h).await["entries"][0]["fields"].clone();
        assert!(fields.get("rating").is_none());
        assert_eq!(fields["posterPath"]["value"], "/renewed.jpg");
    }

    #[test]
    fn legacy_json_is_imported_atomically_once_and_never_deleted() {
        let h = Harness::new();
        let dir = h.dir.join("legacy-title-metadata");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("movie-550-tmdb.json");
        let entry = json!({
            "type":"movie","id":550,"source":"tmdb",
            "fields":{"rating":{"value":8.4,"observedAt":1_000}}
        });
        std::fs::write(&legacy, entry.to_string()).unwrap();
        let misplaced = json!({
            "type":"movie","id":551,"source":"tmdb",
            "fields":{"rating":{"value":9.9,"observedAt":1_000}}
        });
        std::fs::write(dir.join("unexpected.json"), misplaced.to_string()).unwrap();
        let first = Store::open(&dir, 2_000).unwrap();
        let found = first.query_batch(vec![MediaRef { kind: "movie".into(), id: 550 }], 2_000).unwrap();
        assert_eq!(found[0].fields.rating.as_ref().unwrap().value, 8.4);
        assert!(
            first.query_batch(vec![MediaRef { kind: "movie".into(), id: 551 }], 2_000).unwrap().is_empty(),
            "a record under an invalid legacy path is ignored"
        );
        assert!(legacy.exists(), "migration keeps the rollback copy");
        drop(first);

        std::fs::write(&legacy, b"not-json").unwrap();
        let reopened = Store::open(&dir, 3_000).unwrap();
        let found = reopened.query_batch(vec![MediaRef { kind: "movie".into(), id: 550 }], 3_000).unwrap();
        assert_eq!(found[0].fields.rating.as_ref().unwrap().value, 8.4, "the import marker prevents replay");
    }
}
