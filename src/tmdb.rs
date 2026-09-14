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
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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
            if !numeric(id) && !(kind != "collection" && LISTS.contains(&id)) {
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

pub async fn handle(state: &AppState, req: Request, rid: &str) -> Response {
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
    let query = req.uri().query().map(str::to_owned);
    let cached = cache_key(&path, query.as_deref());
    let file = state.tmdb_cache_dir.as_ref().map(|dir| cache_path(dir, &cached));
    let fresh = fresh_for(&path);

    // A hit never leaves the box, so it is not counted against anybody's budget: what the limits exist to
    // bound is what this origin asks TMDB, not what it already knows.
    if let Some(file) = &file {
        if let Some((body, age)) = read(file).await {
            if age < fresh {
                return answer(body, fresh.saturating_sub(age), "hit");
            }
            // Held while the refresh is attempted: if TMDB refuses or is unreachable, a slightly old answer is
            // a better page than an empty one.
            return match fetch(state, &path, query.as_deref(), key, rid).await {
                Ok(body) => {
                    write(file, &body).await;
                    answer(body, fresh, "miss")
                }
                Err(_) if age < RETENTION => answer(body, Duration::from_secs(60), "stale"),
                Err(response) => response,
            };
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
            answer(body, fresh, "miss")
        }
        Err(response) => response,
    }
}

/// Ask TMDB. The error case is already a response, so a caller holding a kept copy can discard it and serve
/// that instead.
async fn fetch(
    state: &AppState,
    path: &str,
    query: Option<&str>,
    key: &str,
    rid: &str,
) -> Result<Bytes, Response> {
    // The whole point of the daily ceiling: a key that is lent out can be spent by anyone who finds the route,
    // and the household would be the one rate-limited by TMDB afterwards.
    if !spend(state) {
        return Err(retry_after(StatusCode::SERVICE_UNAVAILABLE, &error("tmdb_budget_spent"), 3_600_000));
    }
    let Some(client) = state.tmdb_client.as_ref() else {
        return Err(json(StatusCode::NOT_FOUND, "tmdb_proxy_off"));
    };
    let out = axum::http::Request::builder()
        .method(Method::GET)
        .uri(upstream(path, query, key))
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()));
    let Ok(out) = out else { return Err(json(StatusCode::BAD_REQUEST, "bad_request")) };
    let answer = match tokio::time::timeout(TIMEOUT, client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("tmdb: {e}");
            return Err(json(StatusCode::BAD_GATEWAY, "tmdb_unreachable"));
        }
        Err(_) => return Err(json(StatusCode::GATEWAY_TIMEOUT, "tmdb_timeout")),
    };
    let status = answer.status();
    let Ok(bytes) = Limited::new(answer.into_body(), MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes())
    else {
        return Err(json(StatusCode::BAD_GATEWAY, "tmdb_answer_unreadable"));
    };
    if !status.is_success() {
        // TMDB's own refusal, passed on as ours without its body: it may name the key.
        return Err(json(
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
        return false;
    }
    spent.1 += 1;
    true
}

/// A kept answer and how old it is. The file's own timestamp is when it was fetched, so there is no header to
/// write, parse or keep in step.
async fn read(file: &Path) -> Option<(Bytes, Duration)> {
    let bytes = tokio::fs::read(file).await.ok()?;
    let age = tokio::fs::metadata(file)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .unwrap_or(Duration::ZERO);
    Some((Bytes::from(bytes), age))
}

/// Written beside and renamed over, so a reader never sees half an answer. A cache that cannot be written is
/// not a failure worth refusing a request for.
async fn write(file: &Path, body: &Bytes) {
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
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let expired = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > RETENTION);
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

fn answer(body: Bytes, remaining: Duration, how: &'static str) -> Response {
    let mut resp = raw_json(StatusCode::OK, Body::from(body), false);
    let headers = resp.headers_mut();
    // The browser keeps its own copy too (`tmdbCache.ts`), so this mostly spares the box a repeat question
    // from the same page.
    if let Ok(value) = HeaderValue::from_str(&format!("public, max-age={}", remaining.as_secs())) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert("x-den-tmdb", HeaderValue::from_static(how));
    resp
}

fn json(status: StatusCode, code: &str) -> Response {
    raw_json(status, Body::from(error(code).to_string()), true)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn a_kept_answer_is_read_back_and_a_torn_write_is_never_seen() {
        let dir = crate::handler::tests::temp_dir();
        let file = cache_path(&dir, "/3/movie/550?");
        assert!(read(&file).await.is_none(), "nothing is kept yet");
        write(&file, &Bytes::from_static(b"{\"id\":550}")).await;
        let (body, age) = read(&file).await.expect("the answer was kept");
        assert_eq!(body.as_ref(), b"{\"id\":550}");
        assert!(age < Duration::from_secs(5));
        assert!(!file.with_extension("tmp").exists(), "the temporary file was left behind");
    }
}
