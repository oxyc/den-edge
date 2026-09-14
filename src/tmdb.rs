//! TMDB through this origin, for a device that has no key of its own (`/tmdb/3/…`, env `TMDB_KEY`).
//!
//! Den is bring-your-own-key: a household puts its TMDB key in Settings and every device reads titles with it.
//! A visitor to the public name has no library and so no key, and without one the app can name nothing — no
//! posters, no titles, an empty page. This lends them the household's key without ever handing it over: the
//! key is substituted here, and whatever key the caller sent is thrown away.
//!
//! What makes it worth having at all is the cache, which is why it is on disk rather than in memory. It is
//! keyed by the question and nothing else, so one answer serves every device that asks it — the web app, a
//! phone, and the TVs when they are pointed here — and it survives a restart, which matters when a title's
//! details are good for six months and this box redeploys every week. A hit is a local file read: faster than
//! the TV's own call to TMDB across the internet, and it spends none of the household's quota.
//!
//! TMDB's terms are what set the ceiling: cached content may be kept for six months, so nothing here outlives
//! that, and the attribution the app already shows is what licenses the rest.

use crate::handler::{error, raw_json, retry_after};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub type TmdbClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>;

/// https only, http1, and the roots compiled in — no OS trust store to depend on in a `scratch` image.
pub fn client() -> TmdbClient {
    // rustls needs a crypto provider chosen before any config is built. `ring` is the light one, and the only
    // one compiled in; installing it twice is not an error worth stopping for.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let https =
        hyper_rustls::HttpsConnectorBuilder::new().with_webpki_roots().https_only().enable_http1().build();
    Client::builder(TokioExecutor::new()).build(https)
}

const HOST: &str = "https://api.themoviedb.org";
/// TMDB's terms cap cached content at six months. Nothing here is kept past it, fresh or not.
const RETENTION: Duration = Duration::from_secs(180 * 86_400);
/// A title's own details, its credits and a season's episodes: settled facts, kept for as long as allowed.
const DETAILS_TTL: Duration = Duration::from_secs(180 * 86_400);
/// Lists and trending move as TMDB re-ranks them.
const LIST_TTL: Duration = Duration::from_secs(6 * 3600);
/// A search is asked once per keystroke by a person who is still typing.
const SEARCH_TTL: Duration = Duration::from_secs(3600);
const TIMEOUT: Duration = Duration::from_secs(15);
/// TMDB's largest answers here — a series with every season's credits — are well under this.
const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024;
/// Proxied questions per address per minute. A detail page asks a handful; a crawl asks thousands.
const PER_WINDOW: u32 = 120;

/// How long an answer to `path` stays fresh — the same split the app makes in `tmdbCache.ts`.
/// A body this exact size and shape means "TMDB says there is no such thing". It is stored like any other
/// answer so the existing read path finds it, and is distinguishable from a real answer because no TMDB
/// response is this.
const ABSENT: &[u8] = b"{\"den_absent\":true}";
/// How long a 404 is believed. Short, because a title can be added to TMDB at any time — but long enough
/// that repeating the same missing id costs nothing after the first ask.
const ABSENT_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// What a cached body is worth right now.
#[derive(Debug, PartialEq, Eq)]
enum Cached {
    /// A remembered 404, still believed: answer "no such thing" without spending.
    Absent,
    /// A real answer, still fresh.
    Fresh,
    /// A real answer past its freshness: re-ask, and fall back to this body if TMDB refuses.
    Refresh,
    /// Nothing usable: take the per-IP bucket and ask.
    Cold,
}

/// Kept apart from the handler so the one case that matters can be tested without a clock or a filesystem:
/// an expired SENTINEL must be `Cold`, never `Refresh`, or the refresh arm serves it as an answer.
fn verdict(is_absent: bool, age: Duration, fresh: Duration) -> Cached {
    if is_absent {
        if age < ABSENT_TTL {
            Cached::Absent
        } else {
            Cached::Cold
        }
    } else if age < fresh {
        Cached::Fresh
    } else {
        Cached::Refresh
    }
}

fn fresh_for(path: &str) -> Duration {
    if path.starts_with("/3/search/") {
        return SEARCH_TTL;
    }
    let settled = path.ends_with("/credits")
        || path.ends_with("/external_ids")
        || path.ends_with("/keywords")
        || path.ends_with("/videos")
        || path.ends_with("/combined_credits")
        || path.contains("/season/")
        || is_entity(path);
    if settled {
        DETAILS_TTL
    } else {
        LIST_TTL
    }
}

/// `/3/movie/550`, `/3/tv/1399`, `/3/person/287` — a title or a person's own record, and nothing else.
fn is_entity(path: &str) -> bool {
    let mut parts = path.split('/').skip(1);
    matches!(parts.next(), Some("3"))
        && matches!(parts.next(), Some("movie" | "tv" | "person"))
        && parts.next().is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}

/// The read endpoints the app actually asks for. An allow-list rather than a block-list: this route lends out
/// the household's key, so anything not named here — writes, account and session routes, guest sessions — is
/// not something it can be used for.
fn allowed(path: &str) -> bool {
    // No traversal, no escaping the host, nothing but the characters TMDB's own paths use.
    let plain = !path.contains("..")
        && !path.contains("//")
        && path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.'));
    if !plain {
        return false;
    }
    let mut parts = path.split('/').skip(1);
    if parts.next() != Some("3") {
        return false;
    }
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match parts.next() {
        // Queries rather than records: what follows is parameters. `watch` is the provider lists Settings'
        // My Services reads, and `configuration` the countries and image sizes.
        Some("search" | "discover" | "trending" | "find" | "genre" | "watch" | "configuration") => true,
        Some(kind @ ("movie" | "tv" | "person" | "collection")) => {
            let Some(id) = parts.next() else { return false };
            // TMDB's own named lists sit where an id goes.
            const LISTS: [&str; 7] =
                ["popular", "top_rated", "now_playing", "upcoming", "airing_today", "on_the_air", "latest"];
            let named_list = kind != "collection" && LISTS.contains(&id);
            if !(numeric(id) || named_list) {
                return false;
            }
            // Named one at a time, because the interesting thing about a record's sub-resources is that some
            // of them write: `/3/movie/550/rating` is a POST, and it is under the same prefix as the title.
            const SUFFIXES: [&str; 12] = [
                "credits",
                "aggregate_credits",
                "combined_credits",
                "external_ids",
                "videos",
                "images",
                "keywords",
                "recommendations",
                "similar",
                "release_dates",
                "content_ratings",
                "translations",
            ];
            let rest: Vec<&str> = parts.collect();
            match rest.as_slice() {
                [] => true,
                [one] => SUFFIXES.contains(one),
                ["watch", "providers"] => true,
                ["season", season] => numeric(season),
                ["season", season, "episode", episode] => numeric(season) && numeric(episode),
                _ => false,
            }
        }
        _ => false,
    }
}

/// What an answer is kept under: the question without its key, parameters in order. The same question from a
/// TV, a browser and a phone is one entry.
fn cache_key(path: &str, query: Option<&str>) -> String {
    let mut params: Vec<(String, String)> = query
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .filter(|(name, _)| name != "api_key" && name != "session_id")
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default();
    params.sort();
    let rest: String = params.iter().map(|(n, v)| format!("{n}={v}&")).collect();
    format!("{path}?{rest}")
}

/// Where that key lives on disk. The name is a digest, so a key can hold anything and the file name stays one
/// flat, safe token.
fn cache_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.json", crate::hex(&Sha256::digest(key.as_bytes()))))
}

/// The upstream question, with our key substituted for whatever the caller sent.
fn upstream(path: &str, query: Option<&str>, key: &str) -> String {
    let mut params: Vec<(String, String)> = query
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .filter(|(name, _)| name != "api_key" && name != "session_id")
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default();
    params.push(("api_key".to_owned(), key.to_owned()));
    let query: String = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish();
    format!("{HOST}{path}?{query}")
}

pub async fn handle(state: &Arc<AppState>, req: Request, rid: &str) -> Response {
    let Some(key) = state.tmdb_key.as_deref() else {
        return json(StatusCode::NOT_FOUND, "tmdb_proxy_off");
    };
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let path = req.uri().path().trim_start_matches("/tmdb").to_owned();
    if !allowed(&path) {
        return json(StatusCode::NOT_FOUND, "not_found");
    }
    let asked = req.headers();
    let query = req.uri().query().map(str::to_owned);
    let cached = cache_key(&path, query.as_deref());
    let file = state.tmdb_cache_dir.as_ref().map(|dir| cache_path(dir, &cached));
    let fresh = fresh_for(&path);

    // A hit never leaves the box, so it is not counted against anybody's budget: what the limits exist to
    // bound is what this origin asks TMDB, not what it already knows.
    if let Some(file) = &file {
        if let Some((body, age, modified)) = read(file).await {
            // A remembered 404, answered without spending. Same reasoning as `ask`: this path is per-IP
            // limited so it could not be drained as freely, but it shares the one daily budget.
            //
            // An EXPIRED sentinel must leave this block entirely rather than fall into the refresh below.
            // The stale arm serves the cached body as it is, which for a sentinel means returning
            // `{"den_absent":true}` as a 200 — and a refresh that fails never rewrites the file, so the mtime
            // stays old and every later request repeats it, spending a budget unit each time, for as long as
            // RETENTION allows. It is also ahead of the per-IP bucket, so that is the unthrottled drain again.
            // Falling through to the cold path gets the bucket, the fetch, and a rewritten sentinel.
            match verdict(body == ABSENT, age, fresh) {
                Cached::Absent => return *refused(StatusCode::NOT_FOUND, "not_found"),
                Cached::Fresh => {
                    return answer(
                        body,
                        &fresh_policy(fresh, fresh.saturating_sub(age)),
                        "hit",
                        modified,
                        asked,
                    )
                }
                // A list or a search moves, but the one kept is a better page than a wait on TMDB: served at
                // once, and asked again behind it. A title's details are never here inside the six months.
                Cached::Refresh if fresh != DETAILS_TTL && age < RETENTION => {
                    let asking = Refresh { cached, path, query, key: key.to_owned(), file: file.clone() };
                    refresh_behind(state, asking);
                    return answer(body, "public, max-age=60", "stale", modified, asked);
                }
                Cached::Refresh => {
                    return match fetch(state, &path, query.as_deref(), key, rid).await {
                        Ok(body) => {
                            write(file, &body).await;
                            answer(body, &fresh_policy(fresh, fresh), "miss", SystemTime::now(), asked)
                        }
                        Err(response) => *response,
                    };
                }
                // Falls out to the cold path below: the per-IP bucket, a fetch, and a rewritten sentinel.
                Cached::Cold => {}
            }
        }
    }
    let ip = crate::handler::client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_at(state, &format!("tmdb:{ip}"), PER_WINDOW) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    match fetch(state, &path, query.as_deref(), key, rid).await {
        Ok(body) => {
            if let Some(file) = &file {
                write(file, &body).await;
            }
            answer(body, &fresh_policy(fresh, fresh), "miss", SystemTime::now(), asked)
        }
        Err(response) => {
            if response.status() == StatusCode::NOT_FOUND {
                if let Some(file) = &file {
                    write(file, &Bytes::from_static(ABSENT)).await;
                }
            }
            *response
        }
    }
}

/// A TMDB answer as JSON, for den-edge asking on its own behalf rather than relaying somebody's request
/// (`meta.rs`). The same allow-list, the same daily ceiling and the same cache: a question already asked by a
/// device costs a local file read here too, and one asked here warms it for them.
pub(crate) async fn ask(state: &AppState, path: &str, query: Option<&str>) -> Option<serde_json::Value> {
    let key = state.tmdb_key.as_deref()?;
    if !allowed(path) {
        return None;
    }
    let file = state.tmdb_cache_dir.as_ref().map(|dir| cache_path(dir, &cache_key(path, query)));
    if let Some(file) = &file {
        if let Some((body, age, _)) = read(file).await {
            // A remembered 404 answers as "no such thing" without spending anything.
            if body == ABSENT {
                if age < ABSENT_TTL {
                    return None;
                }
            } else if age < fresh_for(path) {
                return serde_json::from_slice(&body).ok();
            }
        }
    }
    // A MISSING TITLE MUST BE REMEMBERED TOO.
    //
    // `fetch` spends a budget unit before it asks, and a 404 comes back as Err, so nothing was written and
    // the next identical request paid again. `/movie/999999999` is a valid route — meta accepts any u32 — so
    // one URL, requested in a loop by anyone, drained TMDB_DAILY_MAX at one unit per request, unauthenticated
    // and unthrottled, and that budget is shared with the /tmdb proxy the app browses through. Draining it
    // took out browsing, not just link previews.
    match fetch(state, path, query, key, "meta").await {
        Ok(body) => {
            if let Some(file) = &file {
                write(file, &body).await;
            }
            serde_json::from_slice(&body).ok()
        }
        Err(answer) => {
            if answer.status() == StatusCode::NOT_FOUND {
                if let Some(file) = &file {
                    write(file, &Bytes::from_static(ABSENT)).await;
                }
            }
            None
        }
    }
}

/// Ask TMDB. The error case is already a response, so a caller holding a kept copy can discard it and serve
/// that instead. Boxed: a whole `Response` in the error variant would make every `Result` here as large as
/// one, answers included.
async fn fetch(
    state: &AppState,
    path: &str,
    query: Option<&str>,
    key: &str,
    rid: &str,
) -> Result<Bytes, Box<Response>> {
    // The whole point of the daily ceiling: a key that is lent out can be spent by anyone who finds the route,
    // and the household would be the one rate-limited by TMDB afterwards.
    if !spend(state) {
        return Err(Box::new(retry_after(
            StatusCode::SERVICE_UNAVAILABLE,
            &error("tmdb_budget_spent"),
            3_600_000,
        )));
    }
    let Some(client) = state.tmdb_client.as_ref() else {
        return Err(refused(StatusCode::NOT_FOUND, "tmdb_proxy_off"));
    };
    let out = axum::http::Request::builder()
        .method(Method::GET)
        .uri(upstream(path, query, key))
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()));
    let Ok(out) = out else { return Err(refused(StatusCode::BAD_REQUEST, "bad_request")) };
    let answer = match tokio::time::timeout(TIMEOUT, client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("tmdb: {e}");
            return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_unreachable"));
        }
        Err(_) => return Err(refused(StatusCode::GATEWAY_TIMEOUT, "tmdb_timeout")),
    };
    let status = answer.status();
    let Ok(bytes) = Limited::new(answer.into_body(), MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes())
    else {
        return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_answer_unreadable"));
    };
    if !status.is_success() {
        // TMDB's own refusal, passed on as ours without its body: it may name the key.
        return Err(refused(
            if status == StatusCode::NOT_FOUND { StatusCode::NOT_FOUND } else { StatusCode::BAD_GATEWAY },
            if status == StatusCode::NOT_FOUND { "not_found" } else { "tmdb_refused" },
        ));
    }
    Ok(bytes)
}

/// Take one from today's allowance (env `TMDB_DAILY_MAX`), or refuse. Only questions that actually leave the
/// box count: a cache hit costs the household nothing and is never charged.
///
/// This is the kill switch the lending rests on. Without a ceiling, one crawler that finds this route spends
/// the household's quota and it is the household TMDB rate-limits afterwards, on every device it owns.
fn spend(state: &AppState) -> bool {
    let Some(max) = state.tmdb_daily_max else { return true };
    let day = state.now() / 86_400_000;
    let mut spent = crate::lock(&state.tmdb_spent);
    if spent.0 != day {
        *spent = (day, 0);
    }
    if spent.1 >= max {
        // SAY SO, ONCE. Running out is a real outage for guests — meta and the /tmdb proxy share this one
        // budget, so browsing stops, not just link previews — and it announced itself only as a 503 to
        // whoever asked next. A drain was therefore invisible unless someone happened to be watching a
        // request fail. Counting one past `max` makes this the single line for the day rather than one per
        // refused request.
        if spent.1 == max {
            spent.1 = max + 1;
            eprintln!(
                "tmdb: daily budget of {max} spent — guest browsing and link previews answer 503 until UTC                  midnight. A cached answer still serves; only new questions stop."
            );
        }
        return false;
    }
    spent.1 += 1;
    true
}

/// A kept answer, how old it is, and when it was kept. The file's own timestamp is when it was fetched, so there
/// is no header to write, parse or keep in step — and it is the `Last-Modified` a revalidation is checked against.
pub(crate) async fn read(file: &Path) -> Option<(Bytes, Duration, SystemTime)> {
    let bytes = tokio::fs::read(file).await.ok()?;
    let now = SystemTime::now();
    let modified =
        tokio::fs::metadata(file).await.ok().and_then(|m| m.modified().ok()).map_or(now, |t| t.min(now));
    let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
    Some((Bytes::from(bytes), age, modified))
}

/// Written beside and renamed over, so a reader never sees half an answer. A cache that cannot be written is
/// not a failure worth refusing a request for.
pub(crate) async fn write(file: &Path, body: &Bytes) {
    let Some(dir) = file.parent() else { return };
    if tokio::fs::create_dir_all(dir).await.is_err() {
        return;
    }
    let temp = file.with_extension("tmp");
    if tokio::fs::write(&temp, body).await.is_ok() {
        let _ = tokio::fs::rename(&temp, file).await;
    }
}

/// Drop what is past TMDB's six-month ceiling. Runs on a timer rather than on a request: a sweep is a
/// directory scan, and no one waiting for a page should pay for it.
pub async fn sweep(dir: &Path) {
    sweep_older_than(dir, RETENTION).await;
}

/// The same sweep for another cache with its own ceiling (`warnings.rs`).
pub(crate) async fn sweep_older_than(dir: &Path, max_age: Duration) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let expired = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        if expired {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

pub async fn sweep_forever(state: std::sync::Arc<AppState>) {
    let Some(dir) = state.tmdb_cache_dir.clone() else { return };
    loop {
        tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        sweep(&dir).await;
    }
}

/// A stale list or search to ask TMDB again (`refresh_behind`).
struct Refresh {
    cached: String,
    path: String,
    query: Option<String>,
    key: String,
    file: PathBuf,
}

/// Ask again for a stale list or search without holding up the request that found it stale. One refresh per
/// question at a time — every page open in the seconds a refresh takes would otherwise start another — and each
/// still spends from the daily budget, which `fetch` takes.
fn refresh_behind(state: &Arc<AppState>, asking: Refresh) {
    if !crate::lock(&state.tmdb_refreshing).insert(asking.cached.clone()) {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        // Refused, over budget or unreachable: what is kept stays, and the next stale read asks again.
        if let Ok(body) = fetch(&state, &asking.path, asking.query.as_deref(), &asking.key, "refresh").await {
            write(&asking.file, &body).await;
        }
        crate::lock(&state.tmdb_refreshing).remove(&asking.cached);
    });
}

/// How long a browser may keep a fresh answer. A title's details: exactly what is left of the six months, and not
/// a moment past. A list or a search is fresh for hours, so it may also be shown for an hour past that while it is
/// asked again, or a day when this box cannot be reached — still far inside the six months.
fn fresh_policy(fresh: Duration, remaining: Duration) -> String {
    if fresh == DETAILS_TTL {
        format!("public, max-age={}", remaining.as_secs())
    } else {
        format!("public, max-age={}, stale-while-revalidate=3600, stale-if-error=86400", remaining.as_secs())
    }
}

/// `modified` is when the answer was kept, which is what the browser counts TMDB's six months from.
fn answer(body: Bytes, policy: &str, how: &'static str, modified: SystemTime, asked: &HeaderMap) -> Response {
    let mut resp = raw_json(StatusCode::OK, Body::from(body.clone()), false);
    let headers = resp.headers_mut();
    // The browser keeps its own copy too (`tmdbCache.ts`), so this mostly spares the box a repeat question
    // from the same page.
    if let Ok(value) = HeaderValue::from_str(policy) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert("x-den-tmdb", HeaderValue::from_static(how));
    crate::cache::validated(resp, &body, Some(modified), asked)
}

fn json(status: StatusCode, code: &str) -> Response {
    raw_json(status, Body::from(error(code).to_string()), true)
}

/// The same refusal, boxed for `fetch`'s error variant.
fn refused(status: StatusCode, code: &str) -> Box<Response> {
    Box::new(json(status, code))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A missing title was never remembered, so asking for one cost a budget unit EVERY time.
    ///
    /// `fetch` spends before it asks and a 404 returns Err, so nothing reached the cache. `/movie/999999999`
    /// is a valid route — meta accepts any u32 — which made one URL, requested in a loop, a way to drain
    /// TMDB_DAILY_MAX unauthenticated and unthrottled. That budget is shared with the /tmdb proxy, so it
    /// took out guest browsing too, not only link previews.
    #[tokio::test]
    async fn a_missing_title_is_remembered_so_it_is_asked_for_once() {
        let dir = crate::handler::tests::temp_dir();
        let file = cache_path(&dir, &cache_key("/3/movie/999999999", None));

        // Nothing known yet.
        assert!(read(&file).await.is_none());

        // What the 404 path now writes.
        write(&file, &Bytes::from_static(ABSENT)).await;
        let (body, age, _) = read(&file).await.expect("remembered");
        assert_eq!(body, ABSENT, "the sentinel round-trips");
        assert!(age < ABSENT_TTL, "and is believed for a while");

        // It must not be mistaken for an answer: every real body parses as an object with fields.
        assert!(serde_json::from_slice::<serde_json::Value>(&body).is_ok(), "still valid JSON on disk");
        assert_ne!(ABSENT, br#"{"id":550}"#, "and is not a shape TMDB returns");
    }

    /// Running out is a real outage — meta and the /tmdb proxy share this budget, so guest BROWSING stops,
    /// not just link previews — and it used to announce itself only as a 503 to whoever asked next.
    #[test]
    fn the_daily_budget_is_spent_exactly_once_and_resets_the_next_day() {
        let dir = crate::handler::tests::temp_dir();
        let harness =
            crate::handler::tests::Harness::in_dir_with(dir, |state| state.tmdb_daily_max = Some(3));
        let state = &harness.state;

        assert!(spend(state) && spend(state) && spend(state), "three questions allowed");
        assert!(!spend(state), "the fourth is refused");
        assert!(!spend(state), "and stays refused");

        // Counted one past the max so the log line fires once rather than per refused request; nothing else
        // reads this counter, so the overshoot costs nothing.
        assert_eq!(crate::lock(&state.tmdb_spent).1, 4);

        // A new UTC day starts the budget over.
        harness.advance(86_400_000);
        assert!(spend(state), "tomorrow asks again");
    }

    /// What a cached body is worth, decided without a clock or a filesystem.
    ///
    /// An EXPIRED sentinel must reach `Cold`, not `Refresh`. The refresh arm serves the cached body when
    /// TMDB refuses, which for a sentinel meant a 200 carrying `{"den_absent":true}`; it never rewrote the
    /// file, so the mtime stayed old and every later request repeated it at one budget unit each for as long
    /// as RETENTION allows — and it sits ahead of the per-IP bucket, so it reopened, on the proxy route, the
    /// very drain the sentinel was added to close.
    #[test]
    fn an_expired_sentinel_is_cold_not_stale() {
        let fresh = Duration::from_secs(600);
        let hour = Duration::from_secs(3600);

        assert_eq!(verdict(true, Duration::ZERO, fresh), Cached::Absent, "a fresh 404 answers as one");
        assert_eq!(verdict(true, ABSENT_TTL + hour, fresh), Cached::Cold, "an expired one is asked again");

        assert_eq!(verdict(false, Duration::ZERO, fresh), Cached::Fresh);
        assert_eq!(verdict(false, fresh + hour, fresh), Cached::Refresh, "a real body may be served stale");
    }

    #[test]
    fn only_the_read_endpoints_the_app_asks_for() {
        for path in [
            "/3/movie/550",
            "/3/tv/1399/season/1",
            "/3/person/287/combined_credits",
            "/3/search/multi",
            "/3/discover/movie",
            "/3/trending/all/week",
            "/3/configuration",
            // Everything the app actually asks for, including the ones a keyless Settings needs.
            "/3/collection/230",
            "/3/watch/providers/regions",
            "/3/movie/550/watch/providers",
        ] {
            assert!(allowed(path), "{path}");
        }
        // A lent key must not reach anything that writes, or that names the account it belongs to.
        for path in [
            "/3/account/1/watchlist",
            "/3/authentication/token/new",
            "/3/list/1/add_item",
            "/3/movie/550/rating",
            "/4/account/x/lists",
            "/3/movie/../../authentication",
            "/3/movie/550?x=1",
        ] {
            assert!(!allowed(path), "{path}");
        }
    }

    #[test]
    fn a_title_is_kept_for_as_long_as_tmdb_allows_and_a_list_is_not() {
        assert_eq!(fresh_for("/3/movie/550"), DETAILS_TTL);
        assert_eq!(fresh_for("/3/tv/1399/season/2"), DETAILS_TTL);
        assert_eq!(fresh_for("/3/movie/550/credits"), DETAILS_TTL);
        assert_eq!(fresh_for("/3/trending/all/week"), LIST_TTL);
        assert_eq!(fresh_for("/3/discover/movie"), LIST_TTL);
        assert_eq!(fresh_for("/3/search/multi"), SEARCH_TTL);
        assert!(DETAILS_TTL <= RETENTION, "nothing may be kept past TMDB's six months");
    }

    /// The same question from a TV and from a browser is one entry, whatever key either of them sent.
    #[test]
    fn the_key_is_no_part_of_what_an_answer_is_kept_under() {
        let a = cache_key("/3/movie/550", Some("api_key=aaa&language=en-US"));
        let b = cache_key("/3/movie/550", Some("language=en-US&api_key=bbb"));
        assert_eq!(a, b);
        assert!(!a.contains("aaa"), "{a}");
        assert_ne!(a, cache_key("/3/movie/550", Some("language=fi")));
    }

    #[test]
    fn the_callers_key_is_thrown_away_and_ours_substituted() {
        let url = upstream("/3/movie/550", Some("api_key=theirs&language=en-US"), "ours");
        assert!(url.starts_with("https://api.themoviedb.org/3/movie/550?"), "{url}");
        assert!(url.contains("api_key=ours"), "{url}");
        assert!(!url.contains("theirs"), "{url}");
        assert!(url.contains("language=en-US"), "{url}");
    }

    use crate::handler::tests::{body_text, temp_dir, Harness};

    fn lending(cache: &Path, daily_max: Option<u32>) -> Harness {
        let cache = cache.to_path_buf();
        Harness::in_dir_with(temp_dir(), |state| {
            state.tmdb_key = Some("household".into());
            state.tmdb_cache_dir = Some(cache);
            state.tmdb_daily_max = daily_max;
        })
    }

    fn aged(file: &Path, age: Duration) {
        std::fs::File::options()
            .write(true)
            .open(file)
            .unwrap()
            .set_modified(SystemTime::now() - age)
            .unwrap();
    }

    /// A browser counts TMDB's six months from `Last-Modified`, so a title's details carry it and no allowance to
    /// be shown past what is left of them. Holding the same bytes is a 304 under the same policy.
    #[tokio::test]
    async fn a_kept_answer_carries_its_validators_and_a_title_no_stale_allowance() {
        let cache = temp_dir();
        let h = lending(&cache, None);
        write(&cache_path(&cache, &cache_key("/3/movie/550", None)), &Bytes::from_static(b"{\"id\":550}"))
            .await;
        let resp = h.send("GET", "/tmdb/3/movie/550", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let policy = resp.headers()[header::CACHE_CONTROL].to_str().unwrap().to_owned();
        assert!(policy.starts_with("public, max-age=1555") && !policy.contains("stale"), "{policy}");
        let etag = resp.headers()[header::ETAG].to_str().unwrap().to_owned();
        let modified = resp.headers()[header::LAST_MODIFIED].to_str().unwrap().to_owned();
        for (name, value) in [("if-none-match", &etag), ("if-modified-since", &modified)] {
            let again = h.send("GET", "/tmdb/3/movie/550", None, &[(name, value)]).await;
            assert_eq!(again.status(), StatusCode::NOT_MODIFIED, "{name}");
            assert_eq!(again.headers()[header::CACHE_CONTROL], policy.as_str());
            assert_eq!(again.headers()[header::ETAG], etag.as_str());
            assert!(body_text(again).await.is_empty());
        }

        // A list is fresh for hours, so a browser may show it a while longer, still far inside the six months.
        let list = cache_path(&cache, &cache_key("/3/trending/all/week", None));
        write(&list, &Bytes::from_static(b"{\"page\":1}")).await;
        let resp = h.send("GET", "/tmdb/3/trending/all/week", None, &[]).await;
        let policy = resp.headers()[header::CACHE_CONTROL].to_str().unwrap().to_owned();
        assert!(policy.ends_with(", stale-while-revalidate=3600, stale-if-error=86400"), "{policy}");
    }

    /// A stale list used to hold the page while TMDB was asked. It is served at once now, and asked again behind
    /// it — once per question at a time, and paid for from the day's budget like any other question.
    #[tokio::test]
    async fn a_stale_list_is_served_at_once_and_refreshed_behind_it() {
        let cache = temp_dir();
        let h = lending(&cache, Some(5));
        let key = cache_key("/3/trending/all/week", None);
        let file = cache_path(&cache, &key);
        write(&file, &Bytes::from_static(b"{\"page\":1}")).await;
        aged(&file, LIST_TTL + Duration::from_secs(60));

        crate::lock(&h.state.tmdb_refreshing).insert(key.clone());
        let resp = h.send("GET", "/tmdb/3/trending/all/week", None, &[]).await;
        assert_eq!(resp.headers()["x-den-tmdb"], "stale");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=60");
        assert_eq!(body_text(resp).await, "{\"page\":1}");
        assert_eq!(crate::lock(&h.state.tmdb_spent).1, 0, "a refresh already under way is not started twice");
        crate::lock(&h.state.tmdb_refreshing).remove(&key);

        let resp = h.send("GET", "/tmdb/3/trending/all/week", None, &[]).await;
        assert_eq!(resp.headers()["x-den-tmdb"], "stale");
        for _ in 0..200 {
            if crate::lock(&h.state.tmdb_refreshing).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(crate::lock(&h.state.tmdb_refreshing).is_empty(), "the refresh finished");
        assert_eq!(crate::lock(&h.state.tmdb_spent).1, 1, "and spent from the day's budget");
        // There is no TMDB here to answer it, so what is kept stays.
        assert_eq!(read(&file).await.unwrap().0.as_ref(), b"{\"page\":1}");
    }

    #[tokio::test]
    async fn a_kept_answer_is_read_back_and_a_torn_write_is_never_seen() {
        let dir = crate::handler::tests::temp_dir();
        let file = cache_path(&dir, "/3/movie/550?");
        assert!(read(&file).await.is_none(), "nothing is kept yet");
        write(&file, &Bytes::from_static(b"{\"id\":550}")).await;
        let (body, age, _) = read(&file).await.expect("the answer was kept");
        assert_eq!(body.as_ref(), b"{\"id\":550}");
        assert!(age < Duration::from_secs(5));
        assert!(!file.with_extension("tmp").exists(), "the temporary file was left behind");
    }
}
