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
//!
//! For an episode SkipDB has nothing for (or cannot be asked about just now), den-remux's own detection is
//! asked (`/remux/segments/…`, through the `/remux` relay) and answered in SkipDB's shape with `match: "detected"`.
//! An episode remux does not know is asked of it to scan (`SEGMENTS_KEY`), and the miss given meanwhile is kept
//! for seconds, not the hour a settled miss is.

use crate::handler::{client_ip, error, raw_json, retry_after};
use crate::metrics::{CacheAccess, CacheStore, Provider, ProviderUpstream};
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
/// One address's share of `UPSTREAM_PER_MINUTE`: a third, so no one address spends the minute for everyone. A play
/// asks one question; ten a minute is a viewer skipping through a season.
const UPSTREAM_PER_ADDRESS: u32 = 10;
/// Answers kept a day under a name not kept before. Each runtime, season and episode is a name, and each is kept
/// for `RETENTION`; without a ceiling, asking for made-up ones filled the disk with files for three months. Past it
/// an answer is still given, and is not kept.
const NEW_PER_DAY: u32 = 1000;

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
    match from_skipdb(state, &asked_for, asked, &ip, rid).await {
        Outcome::Done(resp) => resp,
        // Episodes only: a title's own segments are not something remux detects.
        Outcome::Miss(miss) if asked_for.season.is_some() => {
            detected(state, &asked_for, asked, rid, miss).await
        }
        Outcome::Miss(miss) => miss,
    }
}

/// What SkipDB (or what is kept of it) had to say. A `Miss` carries the answer to give when nothing else turns
/// up: SkipDB has no segment, or could not be asked right now.
enum Outcome {
    Done(Response),
    Miss(Response),
}

async fn from_skipdb(
    state: &Arc<AppState>,
    asked_for: &Ask,
    asked: &HeaderMap,
    ip: &str,
    rid: &str,
) -> Outcome {
    let file = state.skipdb_cache_dir.as_ref().map(|dir| dir.join(asked_for.file_name()));
    // Segments past their freshness but inside `RETENTION`: asked for again, and served when SkipDB cannot say.
    let mut stale = None;
    let kept = match &file {
        Some(file) => crate::cache::open_json(file, MAX_ANSWER_BYTES).await,
        None => None,
    };
    // Where an answer to this may be written: over what is kept, or under a new name while today allows one. Asked
    // only once there is an answer to write: counted before SkipDB was asked, questions refused as busy or failed
    // spent the day's new names and kept nothing.
    let known = kept.is_some();
    let keep = || file.as_ref().filter(|_| known || new_name(state));
    if let Some(body) = kept {
        let age = body.age();
        let absent = body.matches(ABSENT);
        if absent && age < ABSENT_TTL {
            state.metrics.provider_cache_access(Provider::Skipdb, CacheAccess::Negative);
            return Outcome::Miss(crate::warnings::absent());
        }
        if !absent && age < FRESH {
            state.metrics.provider_cache_access(Provider::Skipdb, CacheAccess::Fresh);
            return Outcome::Done(answer_file(state, body, FRESH.saturating_sub(age), "hit", asked));
        }
        if !absent && age < RETENTION {
            stale = Some(body);
        }
    }
    match lookup(state, asked_for, ip, rid).await {
        Ok(Some(body)) => {
            state.metrics.provider_cache_access(Provider::Skipdb, CacheAccess::Cold);
            let target = keep();
            store(state, target.map(|file| file.as_path()), &body).await;
            if let Some(file) = target {
                let _ = tokio::fs::remove_file(file.with_extension("empty")).await;
            }
            Outcome::Done(answer(body, FRESH, "miss", SystemTime::now(), asked))
        }
        Ok(None) => {
            if let (Some(file), Some(body)) = (&file, stale) {
                if !gone(file).await {
                    state.metrics.provider_cache_access(Provider::Skipdb, CacheAccess::Stale);
                    return Outcome::Done(answer_file(state, body, STALE_MAX_AGE, "stale", asked));
                }
            }
            state.metrics.provider_cache_access(Provider::Skipdb, CacheAccess::Cold);
            store(state, keep().map(|file| file.as_path()), &Bytes::from_static(ABSENT)).await;
            Outcome::Miss(crate::warnings::absent())
        }
        // SkipDB down, slow or refusing: the segments kept are still the best answer there is.
        Err(refused) => match stale {
            Some(body) => {
                state.metrics.provider_cache_access(Provider::Skipdb, CacheAccess::Stale);
                Outcome::Done(answer_file(state, body, STALE_MAX_AGE, "stale", asked))
            }
            None => {
                state.metrics.provider_cache_access(Provider::Skipdb, CacheAccess::Cold);
                // Only the wait for SkipDB (this box's own limit, or SkipDB asking for one) is a miss remux may
                // fill; a SkipDB that is down or broken is passed on as it is.
                if refused.status() == StatusCode::SERVICE_UNAVAILABLE {
                    Outcome::Miss(*refused)
                } else {
                    Outcome::Done(*refused)
                }
            }
        },
    }
}

/// How long a browser or the edge keeps "no segments yet" for an episode remux may be about to detect: short, so
/// the TV asking again a minute later sees the result. Nothing in-process holds this answer: remux is asked every time.
const MISS_MAX_AGE: Duration = Duration::from_secs(30);
/// How long a detected answer is kept by a browser or the edge. Remux's times for a release do not change.
const DETECTED_FRESH: Duration = Duration::from_secs(3600);
/// Remux's answer is a few hundred bytes.
const REMUX_ANSWER_BYTES: usize = 16 * 1024;
const REMUX_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an episode that was asked of remux to scan is left alone, so a public route cannot make remux's scan
/// queue (or its daily cap) its own.
const SCAN_EVERY: Duration = Duration::from_secs(600);
/// Episodes remembered as lately asked for; past it no further scan is asked until some expire.
const SCANS_TRACKED: usize = 4096;

/// What den-remux knows of an episode.
enum Remux {
    Found(serde_json::Value),
    Pending,
    Unknown,
    /// Not configured, unreachable, or an answer that is none of the above.
    Unavailable,
}

/// The answer for an episode SkipDB has nothing for: remux's detected segments, or `miss` (kept short while a scan
/// may be under way).
async fn detected(
    state: &Arc<AppState>,
    ask: &Ask,
    asked: &HeaderMap,
    rid: &str,
    miss: Response,
) -> Response {
    let (Some(season), Some(episode)) = (ask.season, ask.episode) else { return miss };
    let Some(url) =
        crate::relay::target(&state.relays, &format!("/remux/segments/{}/{season}/{episode}", ask.imdb))
    else {
        return miss;
    };
    let tag = match remux_segments(state, &url, rid).await {
        Remux::Found(found) => {
            if let Some(body) = map_detected(&found, ask.duration) {
                let mut resp = answer(
                    Bytes::from(body.to_string()),
                    DETECTED_FRESH,
                    "detected",
                    SystemTime::now(),
                    asked,
                );
                resp.extensions_mut().insert(crate::handler::SrcTag("detected"));
                return resp;
            }
            // Scanned, and nothing found (or nothing that fits this runtime): no scan will change that.
            "none"
        }
        Remux::Pending => "pending",
        Remux::Unknown => {
            ask_scan(state, ask, season, episode, rid);
            "unknown"
        }
        Remux::Unavailable => "unavailable",
    };
    let mut miss = miss;
    if miss.status() == StatusCode::NOT_FOUND {
        if let Ok(value) = HeaderValue::from_str(&format!("public, max-age={}", MISS_MAX_AGE.as_secs())) {
            miss.headers_mut().insert(header::CACHE_CONTROL, value);
        }
    }
    miss.extensions_mut().insert(crate::handler::SrcTag(tag));
    miss
}

async fn remux_segments(state: &AppState, url: &str, rid: &str) -> Remux {
    let Ok(out) = axum::http::Request::builder()
        .method(Method::GET)
        .uri(url)
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()))
    else {
        return Remux::Unavailable;
    };
    match crate::tmdb::exchange(&state.relay_client, out, REMUX_ANSWER_BYTES, REMUX_TIMEOUT, "remux segments")
        .await
    {
        Ok((StatusCode::OK, _, bytes)) => {
            serde_json::from_slice(&bytes).map_or(Remux::Unavailable, Remux::Found)
        }
        Ok((StatusCode::ACCEPTED, _, _)) => Remux::Pending,
        Ok((StatusCode::NOT_FOUND, _, _)) => Remux::Unknown,
        _ => Remux::Unavailable,
    }
}

/// Ask remux to scan an episode it has not heard of, without making the caller wait for it. Not at all without a
/// key, and an episode at most once per `SCAN_EVERY` from here.
fn ask_scan(state: &Arc<AppState>, ask: &Ask, season: u32, episode: u32, rid: &str) {
    let Some(key) = state.segments_key.clone() else { return };
    let Some(url) = crate::relay::target(&state.relays, "/remux/segments/scan") else { return };
    let name = format!("{}-s{season}e{episode}", ask.imdb);
    if !may_scan(state, &name) {
        return;
    }
    let body = serde_json::json!({ "imdb": ask.imdb, "season": season, "episode": episode }).to_string();
    let Ok(out) = axum::http::Request::builder()
        .method(Method::POST)
        .uri(url)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-den-segments-key", key)
        .header("x-request-id", rid)
        .body(Full::new(Bytes::from(body)))
    else {
        return;
    };
    let state = Arc::clone(state);
    tokio::spawn(async move {
        match crate::tmdb::exchange(&state.relay_client, out, REMUX_ANSWER_BYTES, REMUX_TIMEOUT, "remux scan")
            .await
        {
            Ok((status, _, _)) if status.is_success() => {}
            Ok((status, _, _)) => {
                // Busy is not a scan done: let the next ask try again instead of waiting out the ten minutes.
                if status == StatusCode::SERVICE_UNAVAILABLE {
                    crate::lock(&state.segments_scans).remove(&name);
                }
                eprintln!("skipdb: remux scan request: {status}");
            }
            Err(_) => {
                crate::lock(&state.segments_scans).remove(&name);
            }
        }
    });
}

/// Whether `name` may be asked of remux now, noting it if so.
fn may_scan(state: &AppState, name: &str) -> bool {
    let now = state.now();
    let every = SCAN_EVERY.as_millis() as u64;
    let mut asked = crate::lock(&state.segments_scans);
    asked.retain(|_, at| now.saturating_sub(*at) < every);
    if asked.contains_key(name) || asked.len() >= SCANS_TRACKED {
        return false;
    }
    asked.insert(name.to_owned(), now);
    true
}

/// How near the runtimes of two releases must be for remux's times to be used as they are.
const SAME_RELEASE_SECS: f64 = 2.0;

/// Remux's detected segments in SkipDB's wire shape, or `None` where none is left to give. Times are seconds.
/// A runtime within `SAME_RELEASE_SECS` of the scanned one takes the times as they are; otherwise the intro stays
/// anchored to the start, the credits are shifted by the difference in runtime and both are offered with less
/// confidence than the client may auto-skip on. A shifted segment outside the release is dropped.
fn map_detected(found: &serde_json::Value, duration: Option<u64>) -> Option<serde_json::Value> {
    let scanned = found.get("duration").and_then(|d| d.as_f64()).filter(|d| *d > 0.0);
    let asked = duration.map(|d| d as f64);
    let same = matches!((scanned, asked), (Some(s), Some(a)) if (a - s).abs() <= SAME_RELEASE_SECS);
    let confidence = if same { 0.9 } else { 0.6 };
    let shift = match (scanned, asked) {
        (Some(s), Some(a)) if !same => a - s,
        _ => 0.0,
    };
    let segment = |name: &str, shift: f64| {
        let part = found.get(name)?;
        let (start, end) = (part.get("start")?.as_f64()? + shift, part.get("end")?.as_f64()? + shift);
        // Times taken as they are were detected in this runtime; only a shifted one can land outside the file.
        if start < 0.0 || end <= start || (shift != 0.0 && asked.is_some_and(|a| end > a)) {
            return None;
        }
        Some(serde_json::json!({
            "start_ms": (start * 1000.0).round() as u64,
            "end_ms": (end * 1000.0).round() as u64,
            "match": "detected",
            "confidence": confidence,
        }))
    };
    let (intro, outro) = (segment("intro", 0.0), segment("credits", shift));
    if intro.is_none() && outro.is_none() {
        return None;
    }
    Some(
        serde_json::json!({ "segments": { "intro": intro, "recap": null, "outro": outro, "preview": null } }),
    )
}

async fn store(state: &AppState, file: Option<&std::path::Path>, body: &Bytes) {
    let result = match file {
        Some(file) => {
            let attempt = state.metrics.provider_store_started(Provider::Skipdb);
            let result = if crate::cache::write_json(file, body).await {
                CacheStore::Stored
            } else {
                CacheStore::Failed
            };
            attempt.finished(result);
            return;
        }
        None => CacheStore::Skipped,
    };
    state.metrics.provider_cache_store(Provider::Skipdb, result);
}

/// Whether today allows one more answer kept under a new name (`NEW_PER_DAY`), counting it if so.
fn new_name(state: &AppState) -> bool {
    let day = state.now() / (DAY * 1000);
    let mut kept = crate::lock(&state.skipdb_kept_new);
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
async fn lookup(state: &AppState, ask: &Ask, ip: &str, rid: &str) -> Result<Option<Bytes>, Box<Response>> {
    let busy =
        crate::link::throttled_per_minute(state, &format!("skipdb:upstream:{ip}"), UPSTREAM_PER_ADDRESS)
            .or_else(|| crate::link::throttled_per_minute(state, "skipdb:upstream", UPSTREAM_PER_MINUTE));
    if let Some(wait) = busy {
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
    let attempt = state.metrics.provider_upstream_started(Provider::Skipdb);
    let (status, headers, bytes) =
        match crate::tmdb::exchange(client, out, MAX_ANSWER_BYTES, TIMEOUT, "skipdb").await {
            Ok(answer) => answer,
            Err(Failed::Unreachable) => {
                attempt.finished(ProviderUpstream::Failed);
                return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_unreachable"));
            }
            Err(Failed::Timeout) => {
                attempt.finished(ProviderUpstream::Failed);
                return Err(refused(StatusCode::GATEWAY_TIMEOUT, "skipdb_timeout"));
            }
            Err(Failed::TooLarge | Failed::Unreadable) => {
                attempt.finished(ProviderUpstream::Failed);
                return Err(refused(StatusCode::BAD_GATEWAY, "skipdb_answer_unreadable"));
            }
        };
    let answer = said(status, &headers, &bytes);
    let outcome = match &answer {
        Ok(Some(_)) => ProviderUpstream::Updated,
        Ok(None) => ProviderUpstream::Negative,
        Err(_) => ProviderUpstream::Failed,
    };
    attempt.finished(outcome);
    answer
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

fn answer_file(
    state: &AppState,
    body: crate::cache::JsonFile,
    remaining: Duration,
    how: &'static str,
    asked: &HeaderMap,
) -> Response {
    let mut resp = body.response(&state.mmaps);
    let headers = resp.headers_mut();
    let max_age = remaining.min(Duration::from_secs(DAY)).as_secs();
    if let Ok(value) = HeaderValue::from_str(&format!("public, max-age={max_age}")) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert("x-den-skipdb", HeaderValue::from_static(how));
    crate::cache::revalidate(resp, asked)
}

/// Delete what is past `RETENTION`, so the directory holds only what may still be served.
pub async fn sweep_forever(state: Arc<AppState>) {
    let Some(dir) = state.skipdb_cache_dir.clone() else { return };
    loop {
        crate::tmdb::sweep_provider_cache(&dir, RETENTION, &state.metrics, Provider::Skipdb).await;
        tokio::time::sleep(Duration::from_secs(DAY)).await;
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
        let metrics = h.state.metrics.render();
        assert!(
            metrics.contains(r#"den_edge_provider_cache_access_total{provider="skipdb",result="cold"} 2"#)
        );
        assert!(
            metrics.contains(r#"den_edge_provider_cache_access_total{provider="skipdb",result="stale"} 2"#)
        );
        assert!(
            metrics.contains(r#"den_edge_provider_cache_store_total{provider="skipdb",result="stored"} 2"#)
        );
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
                state.trusted_proxies = vec![std::net::IpAddr::from([192, 168, 1, 9])];
            });
        let (answers, asked) = skipdb("tt0000202");
        // Several addresses, each within its own share.
        let addresses = ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"];
        for n in 1..=UPSTREAM_PER_MINUTE {
            let from = [("x-forwarded-for", addresses[(n % 3) as usize])];
            let resp = h.send("GET", &format!("/skipdb/tt0000202/1/{n}"), None, &from).await;
            assert_eq!(resp.status(), StatusCode::OK, "{n}");
        }
        let from = [("x-forwarded-for", addresses[3])];
        let resp = h.send("GET", "/skipdb/tt0000202/1/999", None, &from).await;
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
        *crate::lock(&h.state.skipdb_kept_new) = (today, NEW_PER_DAY - 1);
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

    /// The minute's SkipDB questions were one allowance for everyone, so one address asking made-up questions spent
    /// it and every other viewer's uncached title was `skipdb_busy` behind it.
    #[tokio::test]
    async fn one_address_cannot_spend_everyones_skipdb_minute() {
        let h = crate::handler::tests::Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
            state.skipdb_cache_dir = Some(crate::handler::tests::temp_dir());
            state.trusted_proxies = vec![std::net::IpAddr::from([192, 168, 1, 9])];
        });
        let (_answers, asked) = skipdb("tt0000404");
        let from = |ip: &'static str| [("x-forwarded-for", ip)];
        let mut answered = 0;
        for n in 1..=UPSTREAM_PER_MINUTE {
            let resp = h.send("GET", &format!("/skipdb/tt0000404/1/{n}"), None, &from("203.0.113.7")).await;
            if resp.status() == StatusCode::OK {
                answered += 1;
            }
        }
        assert_eq!(answered, UPSTREAM_PER_ADDRESS, "one address's share");
        let resp = h.send("GET", "/skipdb/tt0000404/9/9", None, &from("198.51.100.20")).await;
        assert_eq!(resp.status(), StatusCode::OK, "another viewer is still asked for");
        assert_eq!(*crate::lock(&asked), UPSTREAM_PER_ADDRESS + 1);
    }

    /// A new name was counted against the day before SkipDB was asked, so questions refused as busy, or failed,
    /// spent the day's new names with nothing kept.
    #[tokio::test]
    async fn only_an_answer_kept_spends_a_new_name() {
        let cache = crate::handler::tests::temp_dir();
        let dir = cache.clone();
        let h =
            crate::handler::tests::Harness::in_dir_with(crate::handler::tests::temp_dir(), move |state| {
                state.skipdb_cache_dir = Some(dir);
            });
        let (answers, _asked) = skipdb("tt0000303");
        *crate::lock(&answers) = (StatusCode::BAD_GATEWAY, "");
        for n in 1..=UPSTREAM_PER_MINUTE + 10 {
            let resp = h.send("GET", &format!("/skipdb/tt0000303/1/{n}"), None, &[]).await;
            assert!(resp.status().is_server_error(), "{n}");
        }
        assert_eq!(crate::lock(&h.state.skipdb_kept_new).1, 0, "nothing kept, nothing spent");
        h.advance(61_000);
        *crate::lock(&answers) = (StatusCode::OK, NAMED);
        assert_eq!(h.send("GET", "/skipdb/tt0000303/2/1", None, &[]).await.status(), StatusCode::OK);
        assert_eq!(crate::lock(&h.state.skipdb_kept_new).1, 1);
        assert!(cache.join("tt0000303-s2e1.json").exists());
    }

    /// A stand-in den-remux: answers `/remux/segments/…` with whatever `answer` holds and records each scan
    /// request as (key header, body).
    struct StandIn {
        base: String,
        answer: Shared<(StatusCode, &'static str)>,
        gets: Shared<u32>,
        scans: Shared<Vec<(Option<String>, String)>>,
    }

    async fn remux(answer: (StatusCode, &'static str)) -> StandIn {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let answer = std::sync::Arc::new(std::sync::Mutex::new(answer));
        let gets = std::sync::Arc::new(std::sync::Mutex::new(0));
        let scans = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (a, g, s) = (answer.clone(), gets.clone(), scans.clone());
        let app = axum::Router::new().fallback(move |req: Request| {
            let (a, g, s) = (a.clone(), g.clone(), s.clone());
            async move {
                if req.method() == Method::POST {
                    assert_eq!(req.uri().path(), "/remux/segments/scan");
                    let key = req.headers().get("x-den-segments-key").map(|v| v.to_str().unwrap().to_owned());
                    let body = axum::body::to_bytes(req.into_body(), 4096).await.unwrap();
                    crate::lock(&s).push((key, String::from_utf8(body.to_vec()).unwrap()));
                    return (StatusCode::ACCEPTED, "{\"status\":\"queued\"}").into_response();
                }
                assert!(req.uri().path().starts_with("/remux/segments/tt"), "{}", req.uri());
                *crate::lock(&g) += 1;
                let (status, body) = *crate::lock(&a);
                (status, body).into_response()
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        StandIn { base, answer, gets, scans }
    }

    use axum::response::IntoResponse;

    const DETECTED: &str = r#"{"duration":2700.0,"intro":{"start":60.0,"end":150.5},"credits":{"start":2600.0,"end":2700.0},"method":"fingerprint","scanned_at":1}"#;
    const UNKNOWN: (StatusCode, &str) = (StatusCode::NOT_FOUND, "{\"status\":\"unknown\"}");
    const PENDING: (StatusCode, &str) = (StatusCode::ACCEPTED, "{\"status\":\"pending\"}");

    fn harness(remux: &StandIn, key: Option<&str>) -> crate::handler::tests::Harness {
        let base = remux.base.clone();
        let key = key.map(str::to_owned);
        crate::handler::tests::Harness::in_dir_with(crate::handler::tests::temp_dir(), move |state| {
            state.skipdb_cache_dir = Some(crate::handler::tests::temp_dir());
            state.relays = crate::parse_relays(&format!("/remux={base}"));
            state.segments_key = key;
        })
    }

    async fn settled() {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    async fn scans(remux: &StandIn, n: usize) {
        for _ in 0..40 {
            if crate::lock(&remux.scans).len() >= n {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        settled().await;
        assert_eq!(crate::lock(&remux.scans).len(), n);
    }

    /// Segments SkipDB has are served as before, and remux is not asked.
    #[tokio::test]
    async fn a_skipdb_hit_never_asks_remux() {
        let remux = remux((StatusCode::OK, DETECTED)).await;
        let h = harness(&remux, Some("k"));
        let _ = skipdb("tt0000501");
        let resp = h.send("GET", "/skipdb/tt0000501/1/1?duration=2700", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-den-skipdb"], "miss");
        assert_eq!(crate::handler::tests::body_json(resp).await["segments"]["intro"]["match"], "agnostic");
        assert_eq!(*crate::lock(&remux.gets), 0);
    }

    /// SkipDB with nothing for an episode is answered from remux, in SkipDB's shape: as-is and sure when the runtime
    /// is the scanned one's, shifted and less sure when it is not.
    #[tokio::test]
    async fn an_episode_skipdb_lacks_is_answered_from_remux() {
        let remux = remux((StatusCode::OK, DETECTED)).await;
        let h = harness(&remux, Some("k"));
        let (answers, _) = skipdb("tt0000502");
        *crate::lock(&answers) = (StatusCode::OK, NOTHING);

        let resp = h.send("GET", "/skipdb/tt0000502/1/1?duration=2701", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-den-skipdb"], "detected");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=3600");
        assert_eq!(resp.extensions().get::<crate::handler::SrcTag>().unwrap().0, "detected");
        let body = crate::handler::tests::body_json(resp).await;
        assert_eq!(
            body["segments"]["intro"],
            serde_json::json!({"start_ms":60000,"end_ms":150500,"match":"detected","confidence":0.9})
        );
        assert_eq!(body["segments"]["outro"]["start_ms"], 2_600_000);
        assert_eq!(body["segments"]["outro"]["confidence"], 0.9);

        let resp = h.send("GET", "/skipdb/tt0000502/1/2?duration=2760", None, &[]).await;
        let body = crate::handler::tests::body_json(resp).await;
        assert_eq!(body["segments"]["intro"]["start_ms"], 60000);
        assert_eq!(body["segments"]["intro"]["confidence"], 0.6);
        assert_eq!(body["segments"]["outro"]["start_ms"], 2_660_000);
        assert_eq!(body["segments"]["outro"]["end_ms"], 2_760_000);

        // A title (no episode) is never sent to remux.
        let gets = *crate::lock(&remux.gets);
        assert_eq!(h.send("GET", "/skipdb/tt0000502", None, &[]).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(*crate::lock(&remux.gets), gets);
    }

    #[test]
    fn detected_times_follow_the_runtime_asked_about() {
        let scanned = serde_json::from_str::<serde_json::Value>(DETECTED).unwrap();
        let at = |body: &serde_json::Value, name: &str, field: &str| body["segments"][name][field].clone();

        // Within two seconds either way: as they are.
        for secs in [2698, 2700, 2702] {
            let body = map_detected(&scanned, Some(secs)).unwrap();
            assert_eq!(at(&body, "outro", "start_ms"), 2_600_000, "{secs}");
            assert_eq!(at(&body, "outro", "confidence"), 0.9, "{secs}");
        }
        // Three seconds out is another encode: credits move with the end of the file, the intro does not.
        let body = map_detected(&scanned, Some(2703)).unwrap();
        assert_eq!(at(&body, "outro", "start_ms"), 2_603_000);
        assert_eq!(at(&body, "intro", "start_ms"), 60_000);
        assert_eq!(at(&body, "intro", "confidence"), 0.6);
        // No runtime named: nothing to shift by, and less sure.
        let body = map_detected(&scanned, None).unwrap();
        assert_eq!(at(&body, "outro", "start_ms"), 2_600_000);
        assert_eq!(at(&body, "outro", "confidence"), 0.6);

        // Shifted before the start of the file: dropped, the intro stays.
        let short = serde_json::json!({"duration":2700.0,"intro":{"start":60.0,"end":150.0},"credits":{"start":50.0,"end":100.0}});
        let body = map_detected(&short, Some(2600)).unwrap();
        assert!(body["segments"]["outro"].is_null());
        assert!(!body["segments"]["intro"].is_null());
        // Past its end: dropped.
        let long = serde_json::json!({"duration":2700.0,"credits":{"start":2650.0,"end":2705.0}});
        assert!(map_detected(&long, Some(2800)).is_none(), "nothing else was found");
        assert!(
            map_detected(&serde_json::json!({"duration":2700.0,"intro":null,"credits":null}), None).is_none()
        );
    }

    /// An episode remux does not know is asked of it once, with the key, and not again for ten minutes; the miss
    /// given meanwhile is kept for seconds, not the hour a settled miss is.
    #[tokio::test]
    async fn an_unknown_episode_is_asked_for_once_per_ten_minutes() {
        let remux = remux(UNKNOWN).await;
        let h = harness(&remux, Some("segkey"));
        let (answers, _) = skipdb("tt0000503");
        *crate::lock(&answers) = (StatusCode::OK, NOTHING);

        let resp = h.send("GET", "/skipdb/tt0000503/1/1?duration=2700", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=30");
        assert_eq!(resp.extensions().get::<crate::handler::SrcTag>().unwrap().0, "unknown");
        scans(&remux, 1).await;
        let (key, body) = crate::lock(&remux.scans)[0].clone();
        assert_eq!(key.as_deref(), Some("segkey"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"imdb":"tt0000503","season":1,"episode":1})
        );

        // The same episode again, from the kept "nothing" and with another runtime: no second request.
        assert_eq!(h.send("GET", "/skipdb/tt0000503/1/1?duration=2700", None, &[]).await.status(), 404);
        assert_eq!(h.send("GET", "/skipdb/tt0000503/1/1?duration=2710", None, &[]).await.status(), 404);
        scans(&remux, 1).await;
        // Another episode is its own.
        h.send("GET", "/skipdb/tt0000503/1/2", None, &[]).await;
        scans(&remux, 2).await;

        h.advance(601_000);
        h.send("GET", "/skipdb/tt0000503/1/1?duration=2700", None, &[]).await;
        scans(&remux, 3).await;
    }

    #[tokio::test]
    async fn a_pending_scan_or_no_key_asks_for_nothing() {
        let remux = remux(PENDING).await;
        let h = harness(&remux, Some("segkey"));
        let (answers, _) = skipdb("tt0000504");
        *crate::lock(&answers) = (StatusCode::OK, NOTHING);
        let resp = h.send("GET", "/skipdb/tt0000504/1/1", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=30");
        assert_eq!(resp.extensions().get::<crate::handler::SrcTag>().unwrap().0, "pending");
        scans(&remux, 0).await;

        // No key: remux is read, never asked to scan.
        *crate::lock(&remux.answer) = UNKNOWN;
        let keyless = harness(&remux, None);
        let (answers, _) = skipdb("tt0000505");
        *crate::lock(&answers) = (StatusCode::OK, NOTHING);
        let resp = keyless.send("GET", "/skipdb/tt0000505/1/1", None, &[]).await;
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=30");
        scans(&remux, 0).await;
    }

    /// Without remux configured a miss is the hour it always was.
    #[tokio::test]
    async fn without_remux_a_miss_is_unchanged() {
        let h = crate::handler::tests::Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
            state.skipdb_cache_dir = Some(crate::handler::tests::temp_dir());
        });
        let (answers, _) = skipdb("tt0000506");
        *crate::lock(&answers) = (StatusCode::OK, NOTHING);
        let resp = h.send("GET", "/skipdb/tt0000506/1/1", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=3600");
    }

    /// This box's own limit on asking SkipDB is not a reason to leave an episode without segments remux has.
    #[tokio::test]
    async fn busy_skipdb_falls_back_to_remux() {
        let remux = remux((StatusCode::OK, DETECTED)).await;
        let h = harness(&remux, Some("k"));
        let _ = skipdb("tt0000507");
        for n in 1..=UPSTREAM_PER_ADDRESS {
            let resp = h.send("GET", &format!("/skipdb/tt0000507/1/{n}"), None, &[]).await;
            assert_eq!(resp.headers()["x-den-skipdb"], "miss", "{n}");
        }
        let resp = h.send("GET", "/skipdb/tt0000507/2/1?duration=2700", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-den-skipdb"], "detected");
        // And where remux has nothing either, the wait is still what is said.
        *crate::lock(&remux.answer) = UNKNOWN;
        let resp = h.send("GET", "/skipdb/tt0000507/2/2?duration=2700", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(resp.headers().contains_key(header::RETRY_AFTER));
    }
}
