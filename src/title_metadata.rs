//! Shared title metadata observed by household clients.
//!
//! Provenance stays explicit: direct TMDB responses and Atlas's JustWatch-sourced IMDb score are stored as
//! separate observations. Each allowlisted field carries its own server timestamp so partial observations
//! merge and expire independently.
//!
//! Most of it is recorded here, not sent: every TMDB answer the proxy fetches (`observe_tmdb`, from `tmdb.rs`) and
//! every atlas chart the relay passes on (`observe_atlas`, from `relay.rs`) is read for its titles behind the answer.
//! `PUT /metadata/title` remains for what never passes through here — a client asking TMDB with its own key, or an
//! atlas it reaches directly — and `POST /metadata/title/query` is how every client reads it back.

use crate::handler::{client_ip, error, json_reply, read_json, retry_after};
use crate::AppState;
use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const MAX_ENTRIES: usize = 100;
const MAX_BODY: usize = 32 * 1024;
const PER_WINDOW: u32 = 60;
const RETENTION_MS: u64 = 180 * 86_400_000;
const RETENTION: Duration = Duration::from_secs(180 * 86_400);
const SOURCES: [&str; 2] = ["tmdb", "justwatch-imdb"];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaRef {
    #[serde(rename = "type")]
    kind: String,
    id: u32,
}

#[derive(Deserialize)]
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

fn file(state: &AppState, kind: &str, id: u32, source: &str) -> Option<std::path::PathBuf> {
    state.title_metadata_cache_dir.as_ref().map(|dir| dir.join(format!("{kind}-{id}-{source}.json")))
}

pub async fn handle(state: &Arc<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_at(state, &format!("title-metadata:{ip}"), PER_WINDOW) {
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
        || body.titles.len() > MAX_ENTRIES
        || body.titles.iter().any(|r| !valid_ref(&r.kind, r.id))
    {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_metadata_query"));
    }
    let now = state.now();
    let mut entries = Vec::new();
    for r in body.titles {
        for source in SOURCES {
            let Some(path) = file(state, &r.kind, r.id, source) else {
                continue;
            };
            let Some((bytes, _, _)) = crate::tmdb::read(&path).await else {
                continue;
            };
            let Ok(mut entry) = serde_json::from_slice::<Entry>(&bytes) else { continue };
            if entry.kind != r.kind || entry.id != r.id || entry.source != source {
                continue;
            }
            sanitize(&mut entry.fields, source, now);
            if !empty(&entry.fields) {
                entries.push(entry);
            }
        }
    }
    json_reply(StatusCode::OK, &json!({ "entries": entries }))
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
        || body.entries.len() > MAX_ENTRIES
        || body.entries.iter().any(|o| !valid_observation(o))
    {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_metadata"));
    }
    match merge(state, body.entries).await {
        Ok(()) => json_reply(StatusCode::NO_CONTENT, &Value::Null),
        Err(Unstored::Unavailable) => {
            json_reply(StatusCode::SERVICE_UNAVAILABLE, &error("metadata_store_unavailable"))
        }
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
    /// A record could not be written.
    Failed,
}

/// Each observation merged into what is kept for its title and source, field by field, every field stamped now.
/// Under the write lock, which the sweep also takes, so an expired record is never removed after a fresh one
/// replaced it.
async fn merge(state: &AppState, entries: Vec<Observation>) -> Result<(), Unstored> {
    let _write = state.title_metadata_writes.lock().await;
    let now = state.now();
    for o in entries {
        let Some(path) = file(state, &o.kind, o.id, &o.source) else {
            return Err(Unstored::Unavailable);
        };
        let mut fields = if let Some((bytes, _, _)) = crate::tmdb::read(&path).await {
            serde_json::from_slice::<Entry>(&bytes)
                .ok()
                .filter(|e| e.kind == o.kind && e.id == o.id && e.source == o.source)
                .map(|e| e.fields)
                .unwrap_or_default()
        } else {
            StoredFields::default()
        };
        sanitize(&mut fields, &o.source, now);
        if let Some(value) = o.fields.rating {
            fields.rating = Some(Observed { value, observed_at: now });
        }
        if let Some(value) = o.fields.vote_count {
            fields.vote_count = Some(Observed { value, observed_at: now });
        }
        if let Some(value) = o.fields.poster_path {
            fields.poster_path = Some(Observed { value, observed_at: now });
        }
        let entry = Entry { kind: o.kind, id: o.id, source: o.source, fields };
        let Ok(bytes) = serde_json::to_vec(&entry) else {
            return Err(Unstored::Failed);
        };
        if !crate::tmdb::write(&path, &bytes.into()).await {
            return Err(Unstored::Failed);
        }
    }
    Ok(())
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

/// The same for an atlas catalog answer relayed here (`relay.rs`): each title's JustWatch IMDb score, as source
/// `justwatch-imdb`, only where it is a valid rating. `gzipped` when atlas sent it so. False when it was not taken
/// — no store, or `OBSERVING` already at work — so the answer does not claim it was kept.
pub fn observe_atlas(state: &Arc<AppState>, body: &Bytes, gzipped: bool) -> bool {
    record(state, body, move |body| {
        if !gzipped {
            return atlas_observations(body);
        }
        use std::io::Read as _;
        let mut plain = Vec::new();
        let limit = 8 * 1024 * 1024;
        match flate2::read::GzDecoder::new(body).take(limit).read_to_end(&mut plain) {
            Ok(_) => atlas_observations(&plain),
            Err(_) => Vec::new(),
        }
    })
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
    found.truncate(MAX_ENTRIES);
    found
}

/// Each title in an atlas catalog answer (`{metas: [{type, moviedb_id, name, imdbRating}]}`) with a valid IMDb
/// score, as `services.ts` read them for the web app's `rememberAtlasMetadata`.
fn atlas_observations(body: &[u8]) -> Vec<Observation> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else { return Vec::new() };
    let Some(metas) = value.get("metas").and_then(Value::as_array) else { return Vec::new() };
    let mut found: Vec<Observation> = metas
        .iter()
        .filter_map(|meta| {
            let kind = match meta.get("type").and_then(Value::as_str)? {
                "movie" => "movie",
                "series" => "tv",
                _ => return None,
            };
            let id = u32::try_from(meta.get("moviedb_id")?.as_u64()?).ok()?;
            meta.get("name")?.as_str()?;
            let rating = match meta.get("imdbRating")? {
                Value::String(text) => text.trim().parse().ok()?,
                other => other.as_f64()?,
            };
            let fields = InputFields { rating: Some(rating), ..InputFields::default() };
            let o = Observation { kind: kind.to_owned(), id, source: "justwatch-imdb".to_owned(), fields };
            valid_observation(&o).then_some(o)
        })
        .collect();
    found.truncate(MAX_ENTRIES);
    found
}

pub async fn sweep_forever(state: Arc<AppState>) {
    let Some(dir) = state.title_metadata_cache_dir.clone() else {
        return;
    };
    loop {
        // A sweep decides from the file's old mtime and then removes it. Serialize that decision with
        // publication, otherwise a writer can atomically replace an expired file between those two steps and
        // the sweep will delete the fresh observation.
        let _write = state.title_metadata_writes.lock().await;
        crate::tmdb::sweep_older_than(&dir, RETENTION).await;
        drop(_write);
        tokio::time::sleep(Duration::from_secs(86_400)).await;
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
        let dir = h.state.title_metadata_cache_dir.as_ref().unwrap();
        tokio::fs::write(dir.join("movie-550-tmdb.json"), b"not-json").await.unwrap();
        assert_eq!(get(&h).await, json!({"entries":[]}));

        let future = json!({
            "type":"movie","id":550,"source":"tmdb",
            "fields":{"rating":{"value":9.9,"observedAt":h.state.now() + 1}}
        });
        tokio::fs::write(dir.join("movie-550-tmdb.json"), future.to_string()).await.unwrap();
        assert_eq!(get(&h).await, json!({"entries":[]}));

        let wrong_source_fields = json!({
            "type":"movie","id":550,"source":"justwatch-imdb",
            "fields":{
                "rating":{"value":7.4,"observedAt":h.state.now()},
                "posterPath":{"value":"/not-from-justwatch.jpg","observedAt":h.state.now()}
            }
        });
        tokio::fs::write(dir.join("movie-550-justwatch-imdb.json"), wrong_source_fields.to_string())
            .await
            .unwrap();
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

    /// What `services.ts` read from an atlas chart for `rememberAtlasMetadata`: a valid IMDb score, per title.
    #[test]
    fn an_atlas_chart_is_read_for_valid_imdb_scores_only() {
        let chart = br#"{"metas":[
            {"type":"movie","moviedb_id":550,"name":"Fight Club","imdbRating":"8.8"},
            {"type":"series","moviedb_id":1399,"name":"GoT","imdbRating":9.2},
            {"type":"movie","moviedb_id":1,"name":"Unrated","imdbRating":"N/A"},
            {"type":"movie","moviedb_id":2,"name":"Zero","imdbRating":"0"},
            {"type":"movie","moviedb_id":3,"imdbRating":"7"},
            {"type":"channel","moviedb_id":4,"name":"x","imdbRating":"7"}
        ]}"#;
        assert_eq!(
            observed(&atlas_observations(chart)),
            [
                ("movie".into(), 550, "justwatch-imdb", Some(8.8), None, None),
                ("tv".into(), 1399, "justwatch-imdb", Some(9.2), None, None)
            ]
        );
        assert!(atlas_observations(b"{}").is_empty());
    }

    async fn kept(h: &Harness, kind: &str, id: u32) -> Value {
        for _ in 0..200 {
            let found = body_json(
                h.send(
                    "POST",
                    "/metadata/title/query",
                    Some(json!({"titles":[{"type":kind,"id":id}]}).to_string()),
                    &[],
                )
                .await,
            )
            .await;
            if found["entries"].as_array().is_some_and(|e| !e.is_empty()) {
                return found["entries"][0].clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        Value::Null
    }

    /// An atlas chart relayed here is kept with no browser sending it back, and says so. What atlas answers directly
    /// (the tailnet's `/atlas`) never passes here, and carries no such word.
    #[tokio::test]
    async fn a_relayed_atlas_chart_is_kept_and_says_so() {
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
        assert_eq!(chart.headers()["x-den-title-metadata"], "kept");
        let entry = kept(&h, "movie", 550).await;
        assert_eq!(
            (entry["source"].clone(), entry["fields"]["rating"]["value"].clone()),
            (json!("justwatch-imdb"), json!(8.8))
        );
        let other = h.send("GET", "/atlas/recommend", None, &[]).await;
        assert!(!other.headers().contains_key("x-den-title-metadata"));

        // Not taken on — every observer busy — is not claimed: the browser sends it instead.
        let busy =
            Arc::clone(&h.state.title_metadata_observing).try_acquire_many_owned(OBSERVING as u32).unwrap();
        let chart = h.send("GET", "/atlas/catalog/movie/jw-nfx/country=US.json", None, &[]).await;
        assert!(!chart.headers().contains_key("x-den-title-metadata"), "all {OBSERVING} busy");
        drop(busy);
        while Arc::strong_count(&h.state) > 1 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await; // the first observation finishing
        }
        Arc::get_mut(&mut h.state).unwrap().title_metadata_cache_dir = None;
        let chart = h.send("GET", "/atlas/catalog/movie/jw-nfx/country=US.json", None, &[]).await;
        assert!(!chart.headers().contains_key("x-den-title-metadata"), "no store");
    }

    #[tokio::test]
    async fn batches_and_storage_are_bounded_and_failed_storage_is_reported() {
        let h = harness().await;
        let member = format!("{LIB}:{TOKEN}");
        let entries: Vec<Value> = (1..=MAX_ENTRIES + 1)
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
}
