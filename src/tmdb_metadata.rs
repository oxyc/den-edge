//! Shared poster-card metadata observed in direct TMDB responses.
//!
//! Atlas never transports these values. Paired clients may publish a small allowlisted set and all clients
//! may query it. Each field carries its own server timestamp so partial observations merge and expire
//! independently.

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
    path.len() <= 256 && path.starts_with('/') && path.len() > 1
        && path[1..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
        && !path.contains("..")
}
fn nonempty(fields: &InputFields) -> bool {
    fields.rating.is_some() || fields.vote_count.is_some() || fields.poster_path.is_some()
}
fn valid_observation(o: &Observation) -> bool {
    valid_ref(&o.kind, o.id) && nonempty(&o.fields)
        && o.fields.rating.map_or(true, valid_rating)
        && o.fields.poster_path.as_deref().map_or(true, valid_poster)
}
fn fresh(at: u64, now: u64) -> bool {
    at <= now && now - at < RETENTION_MS
}

fn sanitize(fields: &mut StoredFields, now: u64) {
    if fields
        .rating
        .as_ref()
        .map_or(false, |v| !fresh(v.observed_at, now) || !valid_rating(v.value))
    {
        fields.rating = None;
    }
    if fields
        .vote_count
        .as_ref()
        .map_or(false, |v| !fresh(v.observed_at, now))
    {
        fields.vote_count = None;
    }
    if fields
        .poster_path
        .as_ref()
        .map_or(false, |v| !fresh(v.observed_at, now) || !valid_poster(&v.value))
    {
        fields.poster_path = None;
    }
}

fn empty(fields: &StoredFields) -> bool {
    fields.rating.is_none() && fields.vote_count.is_none() && fields.poster_path.is_none()
}

fn file(state: &AppState, kind: &str, id: u32) -> Option<std::path::PathBuf> {
    state
        .tmdb_metadata_cache_dir
        .as_ref()
        .map(|dir| dir.join(format!("{kind}-{id}.json")))
}

pub async fn handle(state: &Arc<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let ip = client_ip(state, &req);
    if let Some(wait) =
        crate::link::throttled_at(state, &format!("tmdb-metadata:{ip}"), PER_WINDOW)
    {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    match (req.method().clone(), path.as_str()) {
        (Method::POST, "/metadata/tmdb/query") => query(state, req).await,
        (Method::PUT, "/metadata/tmdb") => publish(state, req).await,
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
        let Some(path) = file(state, &r.kind, r.id) else {
            continue;
        };
        let Some((bytes, _, _)) = crate::tmdb::read(&path).await else {
            continue;
        };
        let Ok(mut entry) = serde_json::from_slice::<Entry>(&bytes) else {
            let _ = tokio::fs::remove_file(path).await;
            continue;
        };
        if entry.kind != r.kind || entry.id != r.id || entry.source != "tmdb" {
            let _ = tokio::fs::remove_file(path).await;
            continue;
        }
        sanitize(&mut entry.fields, now);
        if !empty(&entry.fields) {
            entries.push(entry);
        }
    }
    json_reply(StatusCode::OK, &json!({ "entries": entries }))
}

async fn publish(state: &AppState, req: Request) -> Response {
    let member = req
        .headers()
        .get(crate::library::MEMBER_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
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
    let _write = state.tmdb_metadata_writes.lock().await;
    let now = state.now();
    for o in body.entries {
        let Some(path) = file(state, &o.kind, o.id) else {
            continue;
        };
        let mut fields = if let Some((bytes, _, _)) = crate::tmdb::read(&path).await {
            serde_json::from_slice::<Entry>(&bytes)
                .ok()
                .filter(|e| e.kind == o.kind && e.id == o.id && e.source == "tmdb")
                .map(|e| e.fields)
                .unwrap_or_default()
        } else {
            StoredFields::default()
        };
        sanitize(&mut fields, now);
        if let Some(value) = o.fields.rating {
            fields.rating = Some(Observed {
                value,
                observed_at: now,
            });
        }
        if let Some(value) = o.fields.vote_count {
            fields.vote_count = Some(Observed {
                value,
                observed_at: now,
            });
        }
        if let Some(value) = o.fields.poster_path {
            fields.poster_path = Some(Observed {
                value,
                observed_at: now,
            });
        }
        let entry = Entry {
            kind: o.kind,
            id: o.id,
            source: "tmdb".into(),
            fields,
        };
        if let Ok(bytes) = serde_json::to_vec(&entry) {
            crate::tmdb::write(&path, &bytes.into()).await;
        }
    }
    json_reply(StatusCode::NO_CONTENT, &Value::Null)
}

pub async fn sweep_forever(state: Arc<AppState>) {
    let Some(dir) = state.tmdb_metadata_cache_dir.clone() else {
        return;
    };
    loop {
        crate::tmdb::sweep_older_than(&dir, RETENTION).await;
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
        Arc::get_mut(&mut h.state)
            .unwrap()
            .tmdb_metadata_cache_dir = Some(h.dir.join("tmdb-metadata"));
        let body = json!({"writes":[{"k":"aaaaaaaaaaaaaaaa","base":0,"v":"c1"}]}).to_string();
        let started = h
            .send(
                "POST",
                &format!("/lib/{LIB}/batch"),
                Some(body),
                &[("x-den-library-token", TOKEN)],
            )
            .await;
        assert_eq!(started.status(), StatusCode::OK);
        h
    }

    async fn put(h: &Harness, fields: Value) -> Response {
        let member = format!("{LIB}:{TOKEN}");
        h.send(
            "PUT",
            "/metadata/tmdb",
            Some(
                json!({"entries":[{"type":"movie","id":550,"fields":fields}]}).to_string(),
            ),
            &[(crate::library::MEMBER_HEADER, &member)],
        )
        .await
    }

    async fn get(h: &Harness) -> Value {
        body_json(
            h.send(
                "POST",
                "/metadata/tmdb/query",
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
        assert_eq!(
            put(&h, json!({"rating":8.4,"voteCount":31000}))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        h.clock.store(1_000_100, Ordering::Relaxed);
        assert_eq!(
            put(&h, json!({"posterPath":"/fight-club.jpg"}))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        let body = get(&h).await;
        assert_eq!(
            body["entries"][0]["fields"]["rating"],
            json!({"value":8.4,"observedAt":1_000_000})
        );
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
    async fn writes_require_membership_and_reject_unknown_or_invalid_fields() {
        let h = harness().await;
        let body = Some(
            json!({"entries":[{"type":"movie","id":550,"fields":{"rating":8,"overview":"no"}}]})
                .to_string(),
        );
        assert_eq!(
            h.send("PUT", "/metadata/tmdb", body.clone(), &[])
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let member = format!("{LIB}:{TOKEN}");
        assert_eq!(
            h.send(
                "PUT",
                "/metadata/tmdb",
                body,
                &[(crate::library::MEMBER_HEADER, &member)],
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            put(&h, json!({"posterPath":"https://bad.example/x.jpg"}))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn fields_expire_independently_and_malformed_records_are_not_served() {
        let h = harness().await;
        h.clock.store(1_000, Ordering::Relaxed);
        assert_eq!(put(&h, json!({"rating":7.1})).await.status(), StatusCode::NO_CONTENT);
        h.clock.store(1_000 + RETENTION_MS - 10, Ordering::Relaxed);
        assert_eq!(
            put(&h, json!({"posterPath":"/fresh.jpg"}))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        h.clock.store(1_000 + RETENTION_MS + 20, Ordering::Relaxed);
        let body = get(&h).await;
        assert!(body["entries"][0]["fields"].get("rating").is_none());
        assert_eq!(body["entries"][0]["fields"]["posterPath"]["value"], "/fresh.jpg");
        let dir = h.state.tmdb_metadata_cache_dir.as_ref().unwrap();
        tokio::fs::write(dir.join("movie-550.json"), b"not-json").await.unwrap();
        assert_eq!(get(&h).await, json!({"entries":[]}));
    }
}
