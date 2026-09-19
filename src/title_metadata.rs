//! Shared title metadata observed by household clients.
//!
//! Provenance stays explicit: direct TMDB responses and Atlas's JustWatch-sourced IMDb score are stored as
//! separate observations. Each allowlisted field carries its own server timestamp so partial observations
//! merge and expire independently.

use crate::handler::{client_ip, error, json_reply, read_json, retry_after};
use crate::AppState;
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
    let _write = state.title_metadata_writes.lock().await;
    let now = state.now();
    for o in body.entries {
        let Some(path) = file(state, &o.kind, o.id, &o.source) else {
            return json_reply(StatusCode::SERVICE_UNAVAILABLE, &error("metadata_store_unavailable"));
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
            return json_reply(StatusCode::INTERNAL_SERVER_ERROR, &error("metadata_store_failed"));
        };
        if !crate::tmdb::write(&path, &bytes.into()).await {
            return json_reply(StatusCode::INTERNAL_SERVER_ERROR, &error("metadata_store_failed"));
        }
    }
    json_reply(StatusCode::NO_CONTENT, &Value::Null)
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
