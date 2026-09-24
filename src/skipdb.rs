//! SkipDB's skip segments through this origin (`GET /skipdb/<tt…>[/<season>/<episode>]?duration=<secs>`), kept
//! for everyone.
//!
//! The arrangement the ratings and the content warnings have (`ratings.rs`, `warnings.rs`): asked for once,
//! kept, and served to every browser that opens the title. Two reasons it is a proxy rather than a direct call
//! from the page. The policy served with the app names no third-party origin in `connect-src` (`web.rs`), and
//! widening it to a community API for one feature is a poor trade. And a segment is the same answer for
//! everyone, so keeping it here means one household's first play warms it for every later viewer and every
//! other device — the Apple TV asks SkipDB directly and has its own on-device cache, which is why this exists
//! only for the web.
//!
//! SkipDB's read API is open and takes no key, so unlike ratings and warnings there is nothing to spend, no
//! household key, and no daily ceiling — every caller may cause a lookup, bounded only per address.
//!
//! `duration` is part of the key, not an afterthought. SkipDB aligns its community times to the encode you
//! name: an exact runtime scores highest, one within about ten seconds is shifted to fit, and further out it
//! answers `out-of-range` with the times deliberately unadjusted. So the answer genuinely differs per release,
//! and caching without the runtime would serve one release's alignment to another. Most releases of a title
//! share a runtime to the second, so this fragments into a handful of entries per title rather than one per
//! viewer.

use crate::handler::{client_ip, error, raw_json, retry_after};
use crate::warnings::valid_imdb;
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const API: &str = "https://api.skipdb.tv/api/segments";
const TIMEOUT: Duration = Duration::from_secs(15);
/// One title's segments are a few hundred bytes.
const MAX_ANSWER_BYTES: usize = 64 * 1024;
/// Questions per address per minute. A play asks one.
const PER_WINDOW: u32 = 60;
const DAY: u64 = 86_400;
/// How long a kept answer is served as it is. Community segments are added and corrected over time, so this is
/// days rather than the months a title's own facts get.
const FRESH: Duration = Duration::from_secs(7 * DAY);
/// How long a kept answer may still be served while nobody has refreshed it. The sweep deletes what is older.
const RETENTION: Duration = Duration::from_secs(90 * DAY);
/// How long "SkipDB has nothing for this" is believed. Short: a title gains segments when someone times it.
const ABSENT_TTL: Duration = Duration::from_secs(DAY);
/// A kept "nothing here". No answer of SkipDB's has this shape.
const ABSENT: &[u8] = b"{\"den_absent\":true}";
/// The longest runtime worth asking about, in seconds — past this the caller is naming something absurd.
const MAX_DURATION: u64 = 24 * 3600;

pub async fn handle(state: &Arc<AppState>, req: Request, rid: &str) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_per_minute(state, &format!("skipdb:{ip}"), PER_WINDOW) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let Some(asked_for) = Ask::parse(req.uri()) else {
        return json(StatusCode::NOT_FOUND, "not_found");
    };

    let asked = req.headers();
    let file = state.skipdb_cache_dir.as_ref().map(|dir| dir.join(asked_for.file_name()));
    if let Some((body, age, modified)) = match &file {
        Some(file) => crate::tmdb::read(file).await,
        None => None,
    } {
        let absent = body.as_ref() == ABSENT;
        if absent && age < ABSENT_TTL {
            return crate::warnings::absent();
        }
        if !absent && age < FRESH {
            return answer(body, FRESH.saturating_sub(age), "hit", modified, asked);
        }
    }
    match lookup(state, &asked_for, rid).await {
        Ok(Some(body)) => {
            if let Some(file) = &file {
                crate::tmdb::write(file, &body).await;
            }
            answer(body, FRESH, "miss", SystemTime::now(), asked)
        }
        Ok(None) => {
            if let Some(file) = &file {
                crate::tmdb::write(file, &Bytes::from_static(ABSENT)).await;
            }
            crate::warnings::absent()
        }
        Err(refused) => *refused,
    }
}

/// One question for SkipDB: a title, optionally an episode of it, and the runtime of the release being played.
struct Ask {
    imdb: String,
    season: Option<u32>,
    episode: Option<u32>,
    duration: Option<u64>,
}

impl Ask {
    /// `/skipdb/<tt…>` or `/skipdb/<tt…>/<season>/<episode>`, with an optional `?duration=<secs>`. Anything
    /// else is a 404 rather than a guess: a malformed ask must not reach SkipDB as a different question.
    fn parse(uri: &axum::http::Uri) -> Option<Ask> {
        let rest = uri.path().strip_prefix("/skipdb/")?;
        let mut parts = rest.split('/');
        let imdb = parts.next().filter(|id| valid_imdb(id))?.to_owned();
        let (season, episode) = match (parts.next(), parts.next(), parts.next()) {
            (None, _, _) => (None, None),
            (Some(s), Some(e), None) => (Some(s.parse().ok()?), Some(e.parse().ok()?)),
            _ => return None,
        };
        let duration = uri
            .query()
            .and_then(|q| {
                url::form_urlencoded::parse(q.as_bytes())
                    .find(|(k, _)| k == "duration")
                    .map(|(_, v)| v.into_owned())
            })
            .map(|v| v.parse::<u64>())
            // A runtime that cannot be read refuses the whole ask rather than being dropped. Dropping it
            // would quietly ask SkipDB a different question and then keep the answer under this one's name.
            .transpose()
            .ok()?
            .filter(|secs| *secs > 0 && *secs <= MAX_DURATION);
        Some(Ask { imdb, season, episode, duration })
    }

    /// What this exact question is kept under. Every part that changes SkipDB's answer is in the name, and
    /// nothing else is, so two viewers of the same release share one entry.
    fn file_name(&self) -> String {
        let mut name = self.imdb.clone();
        if let (Some(season), Some(episode)) = (self.season, self.episode) {
            name.push_str(&format!("-s{season}e{episode}"));
        }
        if let Some(duration) = self.duration {
            name.push_str(&format!("-d{duration}"));
        }
        name.push_str(".json");
        name
    }

    fn query(&self) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("imdb_id", &self.imdb);
        if let (Some(season), Some(episode)) = (self.season, self.episode) {
            query.append_pair("season", &season.to_string());
            query.append_pair("episode", &episode.to_string());
        }
        if let Some(duration) = self.duration {
            query.append_pair("duration", &duration.to_string());
        }
        query.finish()
    }
}

/// SkipDB's answer as it is kept: `Some` body, or `None` where it names no segment at all. Every other refusal
/// is already the response to give.
async fn lookup(state: &AppState, ask: &Ask, rid: &str) -> Result<Option<Bytes>, Box<Response>> {
    let Some(client) = state.tmdb_client.as_ref() else {
        return Err(refused(StatusCode::NOT_FOUND, "skipdb_off"));
    };
    let out = axum::http::Request::builder()
        .method(Method::GET)
        .uri(format!("{API}?{}", ask.query()))
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()));
    let Ok(out) = out else { return Err(refused(StatusCode::BAD_REQUEST, "bad_request")) };
    let answer = match tokio::time::timeout(TIMEOUT, client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("skipdb: {e}");
            return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_unreachable"));
        }
        Err(_) => return Err(refused(StatusCode::GATEWAY_TIMEOUT, "skipdb_timeout")),
    };
    let status = answer.status();
    let Ok(bytes) = Limited::new(answer.into_body(), MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes())
    else {
        return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_answer_unreadable"));
    };
    if !status.is_success() {
        // A 404 means SkipDB has nothing for this title, which is an answer worth keeping rather than an error
        // to repeat on every play.
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_refused"));
    }
    // Kept verbatim, unlike the ratings: every field SkipDB names about a segment — the match, the offset, the
    // confidence — is something the client reads to decide whether it may act on the times unasked.
    let body: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_answer_unreadable")),
    };
    let named_any = body
        .get("segments")
        .and_then(|segments| segments.as_object())
        .is_some_and(|segments| segments.values().any(|segment| !segment.is_null()));
    if !named_any {
        return Ok(None);
    }
    Ok(Some(bytes))
}

/// `remaining` is what is left of the freshness window; a browser keeps it a day at most.
fn answer(
    body: Bytes,
    remaining: Duration,
    how: &'static str,
    modified: SystemTime,
    asked: &HeaderMap,
) -> Response {
    let mut resp = raw_json(StatusCode::OK, Body::from(body.clone()), false);
    let headers = resp.headers_mut();
    let max_age = remaining.min(Duration::from_secs(DAY)).as_secs();
    if let Ok(value) = HeaderValue::from_str(&format!("public, max-age={max_age}")) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert("x-den-skipdb", HeaderValue::from_static(how));
    crate::cache::validated(resp, &body, Some(modified), asked)
}

/// Delete what is past `RETENTION`, so the directory holds only what may still be served.
pub async fn sweep_forever(state: Arc<AppState>) {
    let Some(dir) = state.skipdb_cache_dir.clone() else { return };
    loop {
        tokio::time::sleep(Duration::from_secs(DAY)).await;
        crate::tmdb::sweep_older_than(&dir, RETENTION).await;
    }
}

fn json(status: StatusCode, code: &str) -> Response {
    crate::handler::json_reply(status, &error(code))
}

fn refused(status: StatusCode, code: &str) -> Box<Response> {
    Box::new(json(status, code))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(path: &str) -> Option<Ask> {
        Ask::parse(&path.parse::<axum::http::Uri>().unwrap())
    }

    /// Everything that changes SkipDB's answer belongs in the name, and nothing that does not — so two viewers
    /// of the same release share one entry while two different encodes of it do not.
    #[test]
    fn a_question_is_kept_under_every_part_that_changes_the_answer() {
        assert_eq!(ask("/skipdb/tt0111161").unwrap().file_name(), "tt0111161.json");
        assert_eq!(ask("/skipdb/tt0111161?duration=8553").unwrap().file_name(), "tt0111161-d8553.json");
        assert_eq!(
            ask("/skipdb/tt0903747/1/1?duration=3500").unwrap().file_name(),
            "tt0903747-s1e1-d3500.json"
        );
        // The runtime reaches SkipDB, which aligns its times to it.
        assert!(ask("/skipdb/tt0903747/1/1?duration=3500").unwrap().query().contains("duration=3500"));
        assert!(ask("/skipdb/tt0903747/1/1").unwrap().query().contains("episode=1"));
    }

    /// A malformed ask is a 404 here rather than a different question at SkipDB.
    #[test]
    fn only_a_well_formed_ask_is_taken() {
        assert!(ask("/skipdb/tt0111161").is_some());
        assert!(ask("/skipdb/notanid").is_none());
        assert!(ask("/skipdb/tt0111161/1").is_none(), "a season without an episode names nothing");
        assert!(ask("/skipdb/tt0111161/1/2/3").is_none());
        assert!(ask("/skipdb/tt0111161/x/1").is_none());
        // A runtime that cannot be read is refused rather than dropped: dropping it would silently ask a
        // different question and cache the answer under this one.
        assert!(ask("/skipdb/tt0111161?duration=abc").is_none());
        // Absurd or empty runtimes are simply not sent.
        assert!(ask("/skipdb/tt0111161?duration=0").unwrap().duration.is_none());
        assert!(ask("/skipdb/tt0111161?duration=999999").unwrap().duration.is_none());
    }
}
