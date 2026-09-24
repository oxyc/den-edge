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
use crate::tmdb::Failed;
use crate::warnings::valid_imdb;
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::Full;
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
/// How long a browser keeps segments served past their freshness: they are asked for again on the next play.
const STALE_MAX_AGE: Duration = Duration::from_secs(60);
/// How long "SkipDB has nothing for this" is believed. Short: a title gains segments when someone times it.
const ABSENT_TTL: Duration = Duration::from_secs(DAY);
/// A kept "nothing here". No answer of SkipDB's has this shape.
const ABSENT: &[u8] = b"{\"den_absent\":true}";
/// The longest runtime worth asking about, in seconds — past this the caller is naming something absurd.
const MAX_DURATION: u64 = 24 * 3600;
/// Questions that may leave for SkipDB in a minute, from every caller together: half what one address may ask here.
/// A play asks one, and every runtime, season and episode is a question of its own, so the per-address limit alone
/// let a few addresses make this box ask SkipDB as fast as they liked.
const UPSTREAM_PER_MINUTE: u32 = 30;
/// Answers kept a day under a name not kept before. Each runtime, season and episode is a name, and each is kept
/// for `RETENTION`; without a ceiling, asking for made-up ones filled the disk with files for three months. Past it
/// an answer is still given, and is not kept.
const NEW_PER_DAY: u32 = 1000;
/// Today (UTC day number) and how many new names have been kept in it. For the whole process, as the cache
/// directory is.
static KEPT_NEW: std::sync::Mutex<(u64, u32)> = std::sync::Mutex::new((0, 0));

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
    // Segments past their freshness but inside `RETENTION`: asked for again, and served when SkipDB cannot say.
    let mut stale = None;
    let kept = match &file {
        Some(file) => crate::tmdb::read(file).await,
        None => None,
    };
    // Where an answer to this may be written: over what is kept, or under a new name while today allows one.
    let keep = file.filter(|_| kept.is_some() || new_name(state));
    if let Some((body, age, modified)) = kept {
        let absent = body.as_ref() == ABSENT;
        if absent && age < ABSENT_TTL {
            return crate::warnings::absent();
        }
        if !absent && age < FRESH {
            return answer(body, FRESH.saturating_sub(age), "hit", modified, asked);
        }
        if !absent && age < RETENTION {
            stale = Some((body, modified));
        }
    }
    match lookup(state, &asked_for, rid).await {
        Ok(Some(body)) => {
            if let Some(file) = &keep {
                crate::tmdb::write(file, &body).await;
                let _ = tokio::fs::remove_file(file.with_extension("empty")).await;
            }
            answer(body, FRESH, "miss", SystemTime::now(), asked)
        }
        Ok(None) => {
            if let (Some(file), Some((body, modified))) = (&keep, stale) {
                if !gone(file).await {
                    return answer(body, STALE_MAX_AGE, "stale", modified, asked);
                }
            }
            if let Some(file) = &keep {
                crate::tmdb::write(file, &Bytes::from_static(ABSENT)).await;
            }
            crate::warnings::absent()
        }
        // SkipDB down, slow or refusing: the segments kept are still the best answer there is.
        Err(refused) => match stale {
            Some((body, modified)) => answer(body, STALE_MAX_AGE, "stale", modified, asked),
            None => *refused,
        },
    }
}

/// Whether today allows one more answer kept under a new name (`NEW_PER_DAY`), counting it if so.
fn new_name(state: &AppState) -> bool {
    let day = state.now() / (DAY * 1000);
    let mut kept = crate::lock(&KEPT_NEW);
    if kept.0 != day {
        *kept = (day, 0);
    }
    if kept.1 >= NEW_PER_DAY {
        return false;
    }
    kept.1 += 1;
    true
}

/// SkipDB answering "nothing" for segments it named before. It answers every title it has never heard of the same
/// way (200, every segment `null`), so one such answer cannot say whether the segments were taken down or the answer
/// is wrong, and a wrong one used to replace good segments for as long as "nothing" is believed. The first is noted
/// beside the kept segments (`<name>.empty`) and they go on being served; only SkipDB still saying so `ABSENT_TTL`
/// later lets it replace them.
async fn gone(file: &std::path::Path) -> bool {
    let mark = file.with_extension("empty");
    match crate::tmdb::read(&mark).await {
        Some((_, age, _)) if age >= ABSENT_TTL => {
            let _ = tokio::fs::remove_file(&mark).await;
            true
        }
        Some(_) => false,
        None => {
            crate::tmdb::write(&mark, &Bytes::new()).await;
            false
        }
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
    if let Some(wait) = crate::link::throttled_per_minute(state, "skipdb:upstream", UPSTREAM_PER_MINUTE) {
        return Err(Box::new(retry_after(StatusCode::SERVICE_UNAVAILABLE, &error("skipdb_busy"), wait)));
    }
    #[cfg(test)]
    if let Some(skipdb) = tests::stand_in(&ask.imdb) {
        let (status, bytes) = skipdb();
        return said(status, &HeaderMap::new(), &bytes);
    }
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
    let (status, headers, bytes) =
        match crate::tmdb::exchange(client, out, MAX_ANSWER_BYTES, TIMEOUT, "skipdb").await {
            Ok(answer) => answer,
            Err(Failed::Unreachable) => return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_unreachable")),
            Err(Failed::Timeout) => return Err(refused(StatusCode::GATEWAY_TIMEOUT, "skipdb_timeout")),
            Err(Failed::TooLarge | Failed::Unreadable) => {
                return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_answer_unreadable"))
            }
        };
    said(status, &headers, &bytes)
}

/// What SkipDB's answer says: `Some` body to keep, `None` where it names no segment at all, or the refusal to give.
fn said(status: StatusCode, headers: &HeaderMap, bytes: &Bytes) -> Result<Option<Bytes>, Box<Response>> {
    if !status.is_success() {
        // A 404 means SkipDB has nothing for this title, which is an answer worth keeping rather than an error
        // to repeat on every play.
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        // SkipDB asking this box to wait is passed on as a wait, with its own `Retry-After` (a minute when it names
        // none), not as a failure.
        if status == StatusCode::TOO_MANY_REQUESTS {
            let secs = headers
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(60);
            return Err(Box::new(retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &error("skipdb_rate_limited"),
                secs.saturating_mul(1000),
            )));
        }
        return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_refused"));
    }
    // Kept verbatim, unlike the ratings: every field SkipDB names about a segment — the match, the offset, the
    // confidence — is something the client reads to decide whether it may act on the times unasked.
    let body: serde_json::Value = match serde_json::from_slice(bytes) {
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
    Ok(Some(bytes.clone()))
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

    type SkipDb = std::sync::Arc<dyn Fn() -> (StatusCode, Bytes) + Send + Sync>;
    /// A stand-in SkipDB per IMDb id, so tests running at once each get their own.
    static SKIPDBS: std::sync::Mutex<Vec<(String, SkipDb)>> = std::sync::Mutex::new(Vec::new());

    pub(super) fn stand_in(imdb: &str) -> Option<SkipDb> {
        crate::lock(&SKIPDBS)
            .iter()
            .find(|(id, _)| id == imdb)
            .map(|(_, skipdb)| std::sync::Arc::clone(skipdb))
    }

    type Shared<T> = std::sync::Arc<std::sync::Mutex<T>>;

    /// A SkipDB for `imdb` answering whatever `answers` holds at the time, counting its questions.
    fn skipdb(imdb: &str) -> (Shared<(StatusCode, &'static str)>, Shared<u32>) {
        let answers = std::sync::Arc::new(std::sync::Mutex::new((StatusCode::OK, NAMED)));
        let asked = std::sync::Arc::new(std::sync::Mutex::new(0));
        let (a, n) = (std::sync::Arc::clone(&answers), std::sync::Arc::clone(&asked));
        let tmdb: SkipDb = std::sync::Arc::new(move || {
            *crate::lock(&n) += 1;
            let (status, body) = *crate::lock(&a);
            (status, Bytes::from_static(body.as_bytes()))
        });
        crate::lock(&SKIPDBS).push((imdb.to_owned(), tmdb));
        (answers, asked)
    }

    const NAMED: &str =
        r#"{"segments":{"intro":{"start_ms":229500,"end_ms":246500,"match":"agnostic"},"outro":null}}"#;
    /// What SkipDB answers for a title it has nothing for, measured: a 200 with every segment null.
    const NOTHING: &str = r#"{"segments":{"intro":null,"recap":null,"outro":null,"preview":null}}"#;

    fn aged(file: &std::path::Path, age: Duration) {
        let handle = std::fs::File::options().write(true).open(file).unwrap();
        handle.set_modified(SystemTime::now() - age).unwrap();
    }

    /// Kept segments past their week were a 502 the moment SkipDB could not be reached, although the comment on
    /// `RETENTION` said they would be served; and one "nothing" answer replaced them for a day at a time.
    #[tokio::test]
    async fn kept_segments_outlast_an_outage_and_a_single_empty_answer() {
        let cache = crate::handler::tests::temp_dir();
        let dir = cache.clone();
        let h =
            crate::handler::tests::Harness::in_dir_with(crate::handler::tests::temp_dir(), move |state| {
                state.skipdb_cache_dir = Some(dir);
            });
        let (answers, asked) = skipdb("tt0000101");
        let get = || h.send("GET", "/skipdb/tt0000101", None, &[]);
        let file = cache.join("tt0000101.json");

        assert_eq!(get().await.headers()["x-den-skipdb"], "miss");
        aged(&file, FRESH + Duration::from_secs(DAY));

        *crate::lock(&answers) = (StatusCode::SERVICE_UNAVAILABLE, "");
        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::OK, "served through the outage");
        assert_eq!(resp.headers()["x-den-skipdb"], "stale");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=60");

        *crate::lock(&answers) = (StatusCode::OK, NOTHING);
        let resp = get().await;
        assert_eq!(resp.headers()["x-den-skipdb"], "stale", "one empty answer does not replace them");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), NAMED);
        // SkipDB still saying so a day later is believed.
        aged(&file.with_extension("empty"), ABSENT_TTL + Duration::from_secs(60));
        assert_eq!(get().await.status(), StatusCode::NOT_FOUND);
        assert_eq!(std::fs::read(&file).unwrap(), ABSENT);
        assert_eq!(*crate::lock(&asked), 4);
    }

    /// Every runtime, season and episode is a question of its own and a file kept for 90 days, so made-up ones
    /// made this box ask SkipDB, and fill its disk, as fast as the per-address limit let a caller ask. And SkipDB
    /// asking to wait was a 502 without saying how long.
    #[tokio::test]
    async fn made_up_questions_are_bounded_and_a_429_says_how_long() {
        let cache = crate::handler::tests::temp_dir();
        let dir = cache.clone();
        let h =
            crate::handler::tests::Harness::in_dir_with(crate::handler::tests::temp_dir(), move |state| {
                state.skipdb_cache_dir = Some(dir);
            });
        let (answers, asked) = skipdb("tt0000202");
        for n in 1..=UPSTREAM_PER_MINUTE {
            let resp = h.send("GET", &format!("/skipdb/tt0000202/1/{n}"), None, &[]).await;
            assert_eq!(resp.status(), StatusCode::OK, "{n}");
        }
        let resp = h.send("GET", "/skipdb/tt0000202/1/999", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(resp.headers().contains_key(header::RETRY_AFTER));
        assert_eq!(
            *crate::lock(&asked),
            UPSTREAM_PER_MINUTE,
            "SkipDB was not asked past the minute's allowance"
        );

        h.advance(61_000);
        *crate::lock(&answers) = (StatusCode::TOO_MANY_REQUESTS, "");
        let resp = h.send("GET", "/skipdb/tt0000202/2/1", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(resp.headers()[header::RETRY_AFTER], "60");

        // A day's new names run out; what is already kept is still written over.
        h.advance(DAY * 1000);
        let today = h.state.now() / (DAY * 1000);
        *crate::lock(&KEPT_NEW) = (today, NEW_PER_DAY - 1);
        assert!(new_name(&h.state), "the last one today");
        assert!(!new_name(&h.state), "and no more");
        *crate::lock(&answers) = (StatusCode::OK, NAMED);
        let resp = h.send("GET", "/skipdb/tt0000202/3/1", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK, "still answered");
        assert!(!cache.join("tt0000202-s3e1.json").exists(), "but not kept");
        let kept = cache.join("tt0000202-s1e1.json");
        aged(&kept, FRESH + Duration::from_secs(DAY));
        assert_eq!(h.send("GET", "/skipdb/tt0000202/1/1", None, &[]).await.headers()["x-den-skipdb"], "miss");
        assert!(crate::tmdb::read(&kept).await.unwrap().1 < Duration::from_secs(60), "written over");
        h.advance(DAY * 1000);
        assert!(new_name(&h.state), "tomorrow starts over");
    }
}
