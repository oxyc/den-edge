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
use crate::metrics::{
    ByteAdmission, BytePool, CacheAccess, CacheStore, Provider, ProviderUpstream, TmdbPrepared,
};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::{TokioExecutor, TokioTimer};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

pub type TmdbClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>;

/// https only, and the roots compiled in — no OS trust store to depend on in a `scratch` image.
///
/// HTTP/2 where the server offers it (ALPN), HTTP/1.1 where it does not. A page asks for a burst of titles at
/// once, and over HTTP/1.1 each question the pool has no idle connection for opens one of its own — a TCP and
/// TLS handshake apiece before TMDB is asked anything. Over HTTP/2 the burst shares one connection. The same
/// client asks OMDb (`ratings.rs`), doesthedogdie (`warnings.rs`) and SkipDB (`skipdb.rs`); none of them sets
/// a header HTTP/2 forbids, and a server that offers only HTTP/1.1 is still asked over it.
///
/// The connection is kept open for five idle minutes. Measured from the box on 2026-09-28: a new one costs
/// 0.3–0.45 s before TMDB is asked anything (a 140 ms round trip, then TLS; 1.4 s once with DNS), and a lookup on a
/// warm one takes 0.15–0.25 s. With 90 idle seconds the first search after a pause paid the setup on every title
/// (a lone lookup after two idle minutes took 1.04 s). HTTP/2 PINGs keep it open that long; one the server closes
/// anyway (GOAWAY) is replaced on the next question. Past a longer pause the page opens it again as someone
/// opens search (`warm`).
pub fn client() -> TmdbClient {
    // rustls needs a crypto provider chosen before any config is built. `ring` is the light one, and the only
    // one compiled in; installing it twice is not an error worth stopping for.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_only()
        .enable_http1()
        .enable_http2()
        .build();
    Client::builder(TokioExecutor::new())
        .timer(TokioTimer::new())
        .pool_timer(TokioTimer::new())
        .http2_keep_alive_interval(Duration::from_secs(30))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .pool_idle_timeout(Duration::from_secs(300))
        .build(https)
}

/// Why an upstream exchange gave no answer to read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Failed {
    /// No answer at all: the connection could not be made or was refused.
    Unreachable,
    /// The whole exchange, headers and body, took longer than it was given.
    Timeout,
    /// The body ran past the limit it was read with.
    TooLarge,
    /// The body broke off partway.
    Unreadable,
}

/// One question to an upstream on the shared client (`client`), answered whole — status, headers and the body read
/// to the end — inside `timeout`, or not at all.
///
/// The timeout covers the body as well as the headers. It used to cover only the headers, and a body read has no
/// timer of its own: an upstream that sent its headers and then stalled held its caller for as long as the socket
/// stayed open, and a background refresh left its key marked "refreshing" (`refresh_behind`), so that key was never
/// refreshed again until a restart. `who` names the upstream in the log; the error names the host, never the query
/// a key may be in.
pub(crate) async fn exchange<C>(
    client: &Client<C, Full<Bytes>>,
    out: axum::http::Request<Full<Bytes>>,
    limit: usize,
    timeout: Duration,
    who: &str,
) -> Result<(StatusCode, HeaderMap, Bytes), Failed>
where
    C: hyper_util::client::legacy::connect::Connect + Clone + Send + Sync + 'static,
{
    let whole = async {
        let answer = client.request(out).await.map_err(|e| {
            eprintln!("{who}: {e}");
            Failed::Unreachable
        })?;
        let (parts, body) = answer.into_parts();
        let bytes = Limited::new(body, limit).collect().await.map_err(|e| {
            if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() {
                Failed::TooLarge
            } else {
                eprintln!("{who}: the answer broke off: {e}");
                Failed::Unreadable
            }
        })?;
        Ok((parts.status, parts.headers, bytes.to_bytes()))
    };
    tokio::time::timeout(timeout, whole).await.unwrap_or(Err(Failed::Timeout))
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
const DAY_MS: u64 = 86_400_000;
/// TMDB's largest answers here — a series with every season's credits — are well under this.
const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024;
/// Proxied questions per address per minute. A detail page asks a handful; a crawl asks thousands.
/// A paired household gets room to name a large library; an anonymous visitor gets enough to browse.
const GUEST_PER_WINDOW: u32 = 120;
const MEMBER_PER_WINDOW: u32 = 600;
/// Questions a minute that link previews (`ask`) may send to TMDB, from everyone together. Every app-shell request
/// for `/movie/<id>` or `/person/<id>` builds a preview, unauthenticated and with no per-address limit of its own,
/// so any id not yet kept cost a unit of the household's budget — and the budget is unlimited unless
/// `TMDB_DAILY_MAX` is set. A kept title costs nothing and is not counted; past this a preview is the generic one.
const PREVIEWS_PER_MINUTE: u32 = 30;

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

/// How long an answer to `path` stays fresh by its path alone: a search an hour; a title's or a person's own record,
/// its credits, external ids and keywords, and a season's episodes, six months; anything else — lists, trending, and
/// a title's videos, where it streams and what is recommended beside it, each asked on its own path — six hours.
/// `fresh_for_answer` shortens a record by what it says and what was asked with it. The app keeps its own copy by
/// its own rule (`tmdbCache.ts`); this does not follow it.
fn fresh_for(path: &str) -> Duration {
    if path.starts_with("/3/search/") {
        return SEARCH_TTL;
    }
    let settled = path.ends_with("/credits")
        || path.ends_with("/external_ids")
        || path.ends_with("/keywords")
        || path.ends_with("/combined_credits")
        || path.contains("/season/")
        || is_entity(path);
    if settled {
        DETAILS_TTL
    } else {
        LIST_TTL
    }
}

/// How long an answer to `path?query` stays fresh once TMDB has said what it is.
///
/// One record here is not a settled fact: a series that is not over. Its next episode, its latest air date and
/// its season list all still move, and the app reads a series' shape to decide which episode comes next — so
/// kept for six months like a finished title's details, Den goes on believing the season ended months ago and
/// withholds an episode that aired on Friday. An unfinished series is a list, not a record.
///
/// Nor is a record that carries what moves beside it (`MOVING`): kept for six months with the title, a detail page
/// named services a film had long left and none it had joined.
fn fresh_for_answer(path: &str, query: Option<&str>, body: &[u8]) -> Duration {
    let fresh = fresh_for(path);
    if fresh == DETAILS_TTL && (unfinished(path, body) || carries_moving(query)) {
        LIST_TTL
    } else {
        fresh
    }
}

/// Sub-requests that change while the title stays what it is: where it can be watched, what TMDB recommends beside
/// it, and its trailers. Each is a list of its own when asked for on its own path (`fresh_for`).
const MOVING: [&str; 3] = ["watch/providers", "recommendations", "videos"];

fn carries_moving(query: Option<&str>) -> bool {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes()).any(|(name, value)| {
        name == "append_to_response" && value.split(',').any(|append| MOVING.contains(&append.trim()))
    })
}

/// How long after a film comes out, or an episode airs, TMDB goes on filling its record in: a runtime, the rest of
/// the cast, an episode's still and overview.
const SETTLING: Duration = Duration::from_secs(30 * 86_400);

/// Does this body describe something that can still change: a series that is not over, a season still airing, or
/// a film not yet out or only just out?
fn unfinished(path: &str, body: &[u8]) -> bool {
    let since =
        crate::cache::iso_date(SystemTime::now().checked_sub(SETTLING).unwrap_or(SystemTime::UNIX_EPOCH));
    unfinished_since(path, body, &since)
}

/// `unfinished`, with `since` the `YYYY-MM-DD` before which a date is settled.
///
/// A series: the status decides it, not the next episode. A series BETWEEN seasons has `next_episode_to_air: null`
/// and is not finished, and the day its next season is announced is precisely the day this has to notice. Only
/// "Ended" and "Canceled" are over; returning, in production and planned are not. A body whose status cannot be
/// read is treated as unfinished, because an answer we don't recognise is no evidence that a series is done.
///
/// A season (`/3/tv/1399/season/2`): kept for six months while it was still airing, its episode list stopped at
/// the episodes announced when it was first asked, without their titles, stills or overviews. It is unfinished while
/// any date in it — the season's own and each episode's — is missing or `since` or later, or it has none at all.
///
/// A film: unfinished until TMDB says "Released", and for `SETTLING` after its release date. Kept for six months
/// before it came out, its page went on naming a date that had moved and no runtime.
///
/// Matched on the text rather than parsed: the alternative is parsing a whole answer on every read to learn one
/// thing about it.
fn unfinished_since(path: &str, body: &[u8], since: &str) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    // The value after the first `"key":`, if it is a string.
    let first = |key: &str| {
        text.split_once(&format!("\"{key}\":")).and_then(|(_, rest)| {
            rest.trim_start().strip_prefix('"').and_then(|rest| rest.split_once('"')).map(|(value, _)| value)
        })
    };
    if path.starts_with("/3/tv/") && is_entity(path) {
        return !matches!(first("status"), Some("Ended" | "Canceled"));
    }
    if is_season(path) {
        let mut dates = text.split("\"air_date\":").skip(1).map(|rest| {
            rest.trim_start().strip_prefix('"').and_then(|rest| rest.split_once('"')).map(|(date, _)| date)
        });
        let mut any = false;
        return dates.any(|date| {
            any = true;
            date.is_none_or(|date| date.is_empty() || date >= since)
        }) || !any;
    }
    if path.starts_with("/3/movie/") && is_entity(path) {
        // Parsed for its own two fields: an appended list (recommendations, release dates) names dates of its own.
        #[derive(serde::Deserialize)]
        struct Film {
            status: Option<String>,
            release_date: Option<String>,
        }
        let Ok(film) = serde_json::from_str::<Film>(text) else { return true };
        return film.status.as_deref() != Some("Released")
            || film.release_date.as_deref().is_none_or(|date| date.is_empty() || date >= since);
    }
    false
}

/// `/3/tv/1399/season/2` — a season's own episode list, and nothing under it.
fn is_season(path: &str) -> bool {
    let digits =
        |part: Option<&str>| part.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let mut parts = path.split('/').skip(1);
    matches!(parts.next(), Some("3"))
        && matches!(parts.next(), Some("tv"))
        && digits(parts.next())
        && matches!(parts.next(), Some("season"))
        && digits(parts.next())
        && parts.next().is_none()
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
            // TMDB's own named lists sit where an id goes. `changes` is the ids edited in a date range, which
            // den-atlas reads to know whose credits to ask for again.
            const LISTS: [&str; 8] = [
                "popular",
                "top_rated",
                "now_playing",
                "upcoming",
                "airing_today",
                "on_the_air",
                "latest",
                "changes",
            ];
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
///
/// Each name and value is written with `%`, `&` and `=` escaped, so the key names exactly the pairs `upstream`
/// asks TMDB: joined as they were decoded, `a%3Db%26c=d` (one parameter) and `a=b&c=d` (two) were one key, and an
/// answer to the first was served for the second. Nothing else is escaped, so a question with none of those three
/// characters keeps the key it has always had and what is already kept still answers it.
pub(crate) fn cache_key(path: &str, query: Option<&str>) -> String {
    let mut params: Vec<(String, String)> = query
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .filter(|(name, _)| name != "api_key" && name != "session_id")
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default();
    params.sort();
    let escaped = |text: &str| text.replace('%', "%25").replace('&', "%26").replace('=', "%3D");
    let rest: String = params.iter().map(|(n, v)| format!("{}={}&", escaped(n), escaped(v))).collect();
    format!("{path}?{rest}")
}

/// Where that key lives on disk. The name is a digest, so a key can hold anything and the file name stays one
/// flat, safe token.
pub(crate) fn cache_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.json", crate::hex(&Sha256::digest(key.as_bytes()))))
}

/// What a title's details are asked of TMDB with, whoever asks: every sub-request any client appends to a film's or
/// a series' record — the web app's detail page and library naming (`web/src/lib/detail.ts`, `tmdb.ts`), the TV's
/// detail and title-screen requests (DenKit `TMDBClient`) and the link preview (`meta.rs`, which appends none). A
/// detail question the cache cannot answer is asked as all of them, once, and kept under that one key; every later
/// detail question for the title, from any client, is then answered from it (`Detail`). A client appending
/// something not listed here is asked for exactly as before. `web/src/lib/detail.test.ts` holds the web app's
/// requests to these lists.
const MOVIE_APPENDS: [&str; 6] =
    ["credits", "external_ids", "recommendations", "release_dates", "videos", "watch/providers"];
const TV_APPENDS: [&str; 7] = [
    "aggregate_credits",
    "content_ratings",
    "credits",
    "external_ids",
    "recommendations",
    "videos",
    "watch/providers",
];

/// The `append_to_response` values clients sent before every detail question was asked as the whole set, spelled
/// exactly as they send them: a key keeps the value in its own order, so this is the only way to find what they
/// left in the cache. An answer kept under one of these still answers any question it holds all of, so a title
/// already kept is not asked for again. `""` is the bare record, the link preview's.
const KEPT_MOVIE_APPENDS: [&str; 5] = [
    "credits,recommendations,videos,external_ids,release_dates,watch/providers", // web detail page
    "release_dates,watch/providers,credits,recommendations,videos",              // TV title screen
    "release_dates,watch/providers",                                             // TV detail
    "credits",                                                                   // web library naming
    "",
];
const KEPT_TV_APPENDS: [&str; 5] = [
    "aggregate_credits,recommendations,videos,external_ids,content_ratings,watch/providers", // web detail page
    "content_ratings,watch/providers,external_ids,credits,recommendations,videos", // TV title screen
    "content_ratings,watch/providers,external_ids",                                // TV detail
    "credits,external_ids",                                                        // web library naming
    "",
];

/// A question for a film's or a series' own record (`/3/movie/550?append_to_response=credits`) whose sub-requests
/// are all among the ones the whole detail carries.
struct Detail {
    path: String,
    /// Every sub-request the whole detail carries for this kind of title, and what was kept before it existed.
    all: &'static [&'static str],
    kept: &'static [&'static str],
    asked: BTreeSet<String>,
    /// The question's other parameters (`language`, …): part of the key as they always were.
    rest: Vec<(String, String)>,
    /// The question exactly as asked, which is what an answer kept before the whole set existed is under.
    exact: Option<String>,
    dir: PathBuf,
}

/// Below this an answer is cut (`Detail::narrowed`) where it is: well under a millisecond, less than the hop to the
/// blocking pool is worth.
const NARROW_INLINE_BYTES: usize = 64 * 1024;

fn narrowed(all: &[&str], asked: &BTreeSet<String>, body: Bytes) -> Bytes {
    let Ok(serde_json::Value::Object(mut record)) = serde_json::from_slice(&body) else { return body };
    for append in all {
        if !asked.contains(*append) {
            record.remove(*append);
        }
    }
    serde_json::to_vec(&record).map_or(body, Bytes::from)
}

/// What the cache holds for a detail question.
enum Kept {
    /// Fresh, with how long it is fresh for, its age and when it was kept.
    Hit(Prepared, Duration, Duration, SystemTime),
    /// A remembered 404, still believed.
    Absent,
    /// Past its freshness but inside the six months, with when it was kept and how long it was fresh for.
    Stale(Prepared, SystemTime, Duration),
    Nothing,
}

/// What the cache holds when an internal caller will parse the answer itself. Link previews do not benefit from a
/// prepared HTTP representation: entering the globally bounded representation builder here could make an otherwise
/// hot preview miss its deadline behind unrelated response work, only to parse the prepared bytes immediately.
enum KeptBytes {
    Hit(Bytes),
    Absent,
    Stale(Bytes),
    Nothing,
}

enum Prepared {
    Bytes(Bytes),
    File(crate::cache::JsonFile),
}

impl Prepared {
    #[cfg(test)]
    async fn bytes(self) -> Option<Bytes> {
        match self {
            Self::Bytes(bytes) => Some(bytes),
            Self::File(file) => file.bytes().await,
        }
    }
}

fn detail_builds() -> &'static Arc<tokio::sync::Semaphore> {
    static BUILDS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    BUILDS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

/// A derived response which cannot be streamed from a prepared file is charged as the largest body it could own,
/// not merely its current length: `serde_json` may retain spare `Vec` capacity which `Bytes` keeps alive. A cold
/// question reserves its charge before asking TMDB, so this is also how many cold questions are asked at once. It
/// was four: fifteen cold search results then went to TMDB in four waves, 11 of 15 waiting on this pool (measured on
/// the box: its high water at the whole 16 MiB), 1.7 s a poster where TMDB answers one in 150-450 ms. Thirty-two
/// covers a screen of results in one wave; with the single builder's buffers this path stays below 136 MiB even
/// when every body is at the provider's 4 MiB ceiling, inside the container's 256 MiB.
const DERIVED_RESPONSE_BUDGET_BYTES: usize = 32 * MAX_ANSWER_BYTES;
const DERIVED_RESPONSE_CHARGE: u32 = MAX_ANSWER_BYTES as u32;

fn derived_response_budget() -> &'static Arc<tokio::sync::Semaphore> {
    static BUDGET: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    BUDGET.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(DERIVED_RESPONSE_BUDGET_BYTES)))
}

struct ChargedDerived {
    body: Bytes,
    _charge: DerivedCharge,
}

struct DerivedCharge {
    _permit: tokio::sync::OwnedSemaphorePermit,
    _admission: Option<ByteAdmission>,
}

impl AsRef<[u8]> for ChargedDerived {
    fn as_ref(&self) -> &[u8] {
        &self.body
    }
}

/// Attach the memory charge to the allocation itself. Hyper may clone or slice `Bytes` after the response future
/// is gone; `from_owner` keeps the permit until the final view of those bytes is dropped.
async fn derived_response_charge(metrics: Option<&Arc<crate::metrics::Metrics>>) -> Option<DerivedCharge> {
    let budget = Arc::clone(derived_response_budget());
    let (permit, waited) = match Arc::clone(&budget).try_acquire_many_owned(DERIVED_RESPONSE_CHARGE) {
        Ok(permit) => (permit, false),
        Err(_) => match budget.acquire_many_owned(DERIVED_RESPONSE_CHARGE).await {
            Ok(permit) => (permit, true),
            Err(_) => {
                if let Some(metrics) = metrics {
                    metrics.byte_refused(BytePool::TmdbDerived);
                }
                return None;
            }
        },
    };
    let admission = metrics.map(|metrics| {
        metrics.byte_admitted(BytePool::TmdbDerived, DERIVED_RESPONSE_CHARGE as usize, waited)
    });
    Some(DerivedCharge { _permit: permit, _admission: admission })
}

fn charged_derived(body: Bytes, charge: DerivedCharge) -> Bytes {
    Bytes::from_owner(ChargedDerived { body, _charge: charge })
}

#[cfg(test)]
static VARIANT_WATCHES: OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, tokio::sync::oneshot::Sender<()>>>,
> = OnceLock::new();

#[cfg(test)]
fn watch_variant_owner(source: &Path) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    crate::lock(VARIANT_WATCHES.get_or_init(Default::default)).insert(source.to_owned(), tx);
    rx
}

#[cfg(test)]
fn note_variant_owner(source: &Path) {
    if let Some(tx) = crate::lock(VARIANT_WATCHES.get_or_init(Default::default)).remove(source) {
        let _ = tx.send(());
    }
}

fn response_sidecar(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(".response");
    PathBuf::from(name)
}

async fn remove_variant(file: &Path) {
    let _ = tokio::fs::remove_file(file).await;
    let _ = tokio::fs::remove_file(response_sidecar(file)).await;
}

fn variants_dir(source: &Path) -> PathBuf {
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    let stem = source.file_stem().unwrap_or_default();
    parent.join(".tmdb-prepared").join(stem)
}

/// Keep at most the current source generation's prepared representations. Builds are globally serialized, so no
/// newer variant publisher can race this pass; a concurrent canonical replacement can at worst leave the just-built
/// digest orphaned until the next successful build, never make it answer for the replacement.
async fn retire_obsolete_variants(source: &Path, keep_digest: &[u8; 16]) {
    let keep = crate::hex(keep_digest);
    let Ok(mut entries) = tokio::fs::read_dir(variants_dir(source)).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(record) = name.strip_suffix(".tmdb.json") else {
            continue;
        };
        let mut parts = record.split('.');
        let (Some(question), Some(digest), Some(fresh), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let hex = |value: &str| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        let known_fresh =
            fresh == LIST_TTL.as_secs().to_string() || fresh == DETAILS_TTL.as_secs().to_string();
        if hex(question) && hex(digest) && known_fresh && digest != keep {
            remove_variant(&entry.path()).await;
        }
    }
}

impl Detail {
    fn of(path: &str, query: Option<&str>, dir: Option<&Path>) -> Option<Detail> {
        let dir = dir?;
        let mut parts = path.split('/').skip(1);
        let (Some("3"), Some(kind), Some(id), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let (all, kept): (&'static [&'static str], &'static [&'static str]) = match kind {
            "movie" => (&MOVIE_APPENDS, &KEPT_MOVIE_APPENDS),
            "tv" => (&TV_APPENDS, &KEPT_TV_APPENDS),
            _ => return None,
        };
        let (mut asked, mut rest) = (BTreeSet::new(), Vec::new());
        for (name, value) in url::form_urlencoded::parse(query.unwrap_or("").as_bytes()) {
            match name.as_ref() {
                "api_key" | "session_id" => {}
                "append_to_response" => {
                    asked.extend(value.split(',').map(str::trim).filter(|a| !a.is_empty()).map(str::to_owned))
                }
                _ => rest.push((name.into_owned(), value.into_owned())),
            }
        }
        asked.iter().all(|a| all.contains(&a.as_str())).then(|| Detail {
            path: path.to_owned(),
            all,
            kept,
            asked,
            rest,
            exact: query.map(str::to_owned),
            dir: dir.to_owned(),
        })
    }

    /// This question's other parameters with `appends` as its sub-requests.
    fn query(&self, appends: &str) -> Option<String> {
        let mut out = url::form_urlencoded::Serializer::new(String::new());
        out.extend_pairs(&self.rest);
        if !appends.is_empty() {
            out.append_pair("append_to_response", appends);
        }
        Some(out.finish()).filter(|q| !q.is_empty())
    }

    /// The whole detail: the question TMDB is asked, and the key its answer is kept under.
    fn whole(&self) -> (Option<String>, PathBuf) {
        let query = self.query(&self.all.join(","));
        let file = cache_path(&self.dir, &cache_key(&self.path, query.as_deref()));
        (query, file)
    }

    /// Where a kept answer to this question may be, and whether it is the question exactly: the question as asked,
    /// then the whole detail, then what clients kept before it existed that holds everything asked.
    fn candidates(&self) -> Vec<(PathBuf, bool)> {
        let exact = cache_path(&self.dir, &cache_key(&self.path, self.exact.as_deref()));
        let mut files = vec![(exact, true), (self.whole().1, false)];
        for appends in self.kept {
            let holds: BTreeSet<&str> = appends.split(',').filter(|a| !a.is_empty()).collect();
            if self.asked.iter().all(|a| holds.contains(a.as_str())) {
                files.push((
                    cache_path(&self.dir, &cache_key(&self.path, self.query(appends).as_deref())),
                    false,
                ));
            }
        }
        let mut seen = std::collections::HashSet::new();
        files.retain(|(file, _)| seen.insert(file.clone()));
        files
    }

    fn variant(&self, source: &Path, source_digest: &[u8; 16], fresh: Duration) -> PathBuf {
        let appends = self.asked.iter().map(String::as_str).collect::<Vec<_>>().join(",");
        let question = cache_key(&self.path, self.query(&appends).as_deref());
        let suffix = crate::hex(&Sha256::digest(question.as_bytes())[..16]);
        variants_dir(source).join(format!(
            "{suffix}.{}.{}.tmdb.json",
            crate::hex(source_digest),
            fresh.as_secs()
        ))
    }

    /// Only representations used by a checked-in client become durable. An arbitrary public subset is still
    /// answered, but reparsed on its next ask rather than multiplying files beside every canonical title.
    fn durable_variant(&self) -> bool {
        self.rest.is_empty()
            && self.kept.iter().any(|appends| {
                let known: BTreeSet<&str> = appends.split(',').filter(|a| !a.is_empty()).collect();
                self.asked.len() == known.len() && self.asked.iter().all(|a| known.contains(a.as_str()))
            })
    }

    async fn existing_variant(
        &self,
        source: &Path,
        source_digest: &[u8; 16],
    ) -> Option<(Prepared, Duration)> {
        // Prefer the conservative short freshness if a cache from an interrupted/older build somehow contains both.
        for fresh in [LIST_TTL, DETAILS_TTL] {
            if let Some(file) =
                crate::cache::open_json(&self.variant(source, source_digest, fresh), MAX_ANSWER_BYTES).await
            {
                // One fixed counter distinguishes the cheap repeat path from a rebuild without exposing a title.
                // This method has no state, so the caller records the hit after receiving the file.
                return Some((Prepared::File(file), fresh));
            }
        }
        None
    }

    #[cfg(test)]
    async fn prepared_variant(
        &self,
        source_path: &Path,
        source: crate::cache::JsonFile,
    ) -> Option<(Prepared, Duration)> {
        self.prepared_variant_with(source_path, source, self.durable_variant(), None).await
    }

    async fn prepared_variant_with(
        &self,
        source_path: &Path,
        source: crate::cache::JsonFile,
        durable: bool,
        metrics: Option<Arc<crate::metrics::Metrics>>,
    ) -> Option<(Prepared, Duration)> {
        let source_digest = source.digest();
        if durable {
            if let Some(found) = self.existing_variant(source_path, &source_digest).await {
                if let Some(metrics) = &metrics {
                    metrics.tmdb_prepared(TmdbPrepared::FileHit);
                }
                return Some(found);
            }
        }

        // Waiters remain ordinary request futures: cancellation drops their open source FD and queue position.
        // Only the strict permit holder becomes a detached owner, so abandoned requests cannot accumulate queued
        // tasks while a multi-megabyte parse is in progress.
        // Reserve the worst-case response before allocating or taking the one build permit. Waiting slow clients
        // therefore cannot leave completed, uncharged bodies queued behind the budget, and a budget wait never
        // prevents an exact file-only inspection from using the builder.
        let charge = derived_response_charge(metrics.as_ref()).await?;
        let permit = Arc::clone(detail_builds()).acquire_owned().await.ok()?;
        let appends = self.asked.iter().map(String::as_str).collect::<Vec<_>>().join(",");
        let question = cache_key(&self.path, self.query(&appends).as_deref());
        let suffix = crate::hex(&Sha256::digest(question.as_bytes())[..16]);
        let (all, asked, path, exact, source_path, durable, modified) = (
            self.all,
            self.asked.clone(),
            self.path.clone(),
            self.exact.clone(),
            source_path.to_owned(),
            durable,
            source.modified(),
        );
        let task = tokio::spawn(async move {
            let _permit = permit;
            #[cfg(test)]
            note_variant_owner(&source_path);
            if durable {
                for fresh in [LIST_TTL, DETAILS_TTL] {
                    let variant = variants_dir(&source_path).join(format!(
                        "{suffix}.{}.{}.tmdb.json",
                        crate::hex(&source_digest),
                        fresh.as_secs()
                    ));
                    if let Some(prepared) = crate::cache::open_json(&variant, MAX_ANSWER_BYTES).await {
                        if let Some(metrics) = &metrics {
                            metrics.tmdb_prepared(TmdbPrepared::FileHit);
                        }
                        return Some((Prepared::File(prepared), fresh));
                    }
                }
            }
            let body = source.bytes().await?;
            let fresh = fresh_for_answer(&path, exact.as_deref(), &body).min(RETENTION);
            let narrowed = if all.iter().all(|append| asked.contains(*append)) {
                body
            } else if body.len() < NARROW_INLINE_BYTES {
                narrowed(all, &asked, body)
            } else {
                let kept = body.clone();
                tokio::task::spawn_blocking(move || narrowed(all, &asked, body)).await.unwrap_or(kept)
            };
            if !durable {
                if let Some(metrics) = &metrics {
                    metrics.tmdb_prepared(TmdbPrepared::TransientBuilt);
                }
                return Some((Prepared::Bytes(charged_derived(narrowed, charge)), fresh));
            }
            let variant = variants_dir(&source_path).join(format!(
                "{suffix}.{}.{}.tmdb.json",
                crate::hex(&source_digest),
                fresh.as_secs()
            ));
            // Publication is useful only while this digest remains canonical. The digest-qualified pathname makes a
            // replacement safe even across the final check; the post-check removes the now-orphaned generation.
            let current = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await?;
            if current.digest() != source_digest {
                if let Some(metrics) = &metrics {
                    metrics.tmdb_prepared(TmdbPrepared::PublishFailed);
                }
                return Some((Prepared::Bytes(charged_derived(narrowed, charge)), fresh));
            }
            if !crate::cache::write_json_at(&variant, &narrowed, Some(modified)).await {
                if let Some(metrics) = &metrics {
                    metrics.tmdb_prepared(TmdbPrepared::PublishFailed);
                }
                return Some((Prepared::Bytes(charged_derived(narrowed, charge)), fresh));
            }
            let still_current = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES)
                .await
                .is_some_and(|current| current.digest() == source_digest);
            if !still_current {
                remove_variant(&variant).await;
                if let Some(metrics) = &metrics {
                    metrics.tmdb_prepared(TmdbPrepared::PublishFailed);
                }
                return Some((Prepared::Bytes(charged_derived(narrowed, charge)), fresh));
            }
            retire_obsolete_variants(&source_path, &source_digest).await;
            let prepared = match crate::cache::open_json(&variant, MAX_ANSWER_BYTES).await {
                Some(prepared) => {
                    if let Some(metrics) = &metrics {
                        metrics.tmdb_prepared(TmdbPrepared::FileBuilt);
                    }
                    Prepared::File(prepared)
                }
                None => {
                    if let Some(metrics) = &metrics {
                        metrics.tmdb_prepared(TmdbPrepared::PublishFailed);
                    }
                    Prepared::Bytes(charged_derived(narrowed, charge))
                }
            };
            Some((prepared, fresh))
        });
        task.await.ok()?
    }

    /// Inspect an exact cache generation under the same single-owner bound as a derived representation, then stream
    /// its still-open inode. Known client shapes take the durable variant path so legacy exact entries are migrated
    /// lazily; arbitrary exact questions keep no second file and retain no body-sized response buffer.
    async fn prepared_exact(
        &self,
        source_path: &Path,
        source: crate::cache::JsonFile,
        metrics: Option<Arc<crate::metrics::Metrics>>,
    ) -> Option<(Prepared, Duration)> {
        if self.durable_variant() {
            return self.prepared_variant_with(source_path, source, true, metrics).await;
        }
        let permit = Arc::clone(detail_builds()).acquire_owned().await.ok()?;
        let (path, exact) = (self.path.clone(), self.exact.clone());
        let task = tokio::spawn(async move {
            let _permit = permit;
            let (source, body) = source.with_bytes().await?;
            let fresh = fresh_for_answer(&path, exact.as_deref(), &body).min(RETENTION);
            Some((Prepared::File(source), fresh))
        });
        task.await.ok()?
    }

    /// An answer holding more than was asked, cut to what was: a record for a library's poster should not carry a
    /// series' every guest actor. What it keeps is TMDB's own, so the narrower question gets the answer it would have.
    ///
    /// Cutting is a parse and a re-serialization of the whole record: measured at 18 ms for a 2 MB series detail
    /// (6,000 aggregate cast, release build), time an async worker spent serving nothing else, once per library
    /// title on a hit. A large answer is cut on the blocking pool; a question asking for everything is not cut at all.
    async fn narrowed(&self, body: Bytes) -> Bytes {
        if self.all.iter().all(|append| self.asked.contains(*append)) {
            return body;
        }
        if body.len() < NARROW_INLINE_BYTES {
            return narrowed(self.all, &self.asked, body);
        }
        let (all, asked, kept) = (self.all, self.asked.clone(), body.clone());
        tokio::task::spawn_blocking(move || narrowed(all, &asked, body)).await.unwrap_or(kept)
    }

    /// Build an in-memory derived response under both bounds: only one parse at a time, and a fixed charge which
    /// follows the returned bytes through the response's lifetime. The caller reserves the charge before fetching
    /// or taking the build permit, so completed bodies cannot pile up unaccounted while the response budget waits.
    async fn prepared_narrowed(
        &self,
        state: &AppState,
        body: Bytes,
        charge: DerivedCharge,
    ) -> Option<Prepared> {
        let permit = Arc::clone(detail_builds()).acquire_owned().await.ok()?;
        let metrics = Arc::clone(&state.metrics);
        let (all, asked) = (self.all, self.asked.clone());
        let task = tokio::spawn(async move {
            let _permit = permit;
            let narrowed = if all.iter().all(|append| asked.contains(*append)) {
                body
            } else if body.len() < NARROW_INLINE_BYTES {
                narrowed(all, &asked, body)
            } else {
                let kept = body.clone();
                tokio::task::spawn_blocking(move || narrowed(all, &asked, body)).await.unwrap_or(kept)
            };
            metrics.tmdb_prepared(TmdbPrepared::TransientBuilt);
            Some(Prepared::Bytes(charged_derived(narrowed, charge)))
        });
        task.await.ok()?
    }

    /// The freshest kept answer to this question, from any entry that holds it; else the first one past its
    /// freshness. Each is judged by its own age and what it says — an airing series stays fresh for hours.
    #[cfg(test)]
    async fn kept(&self) -> Kept {
        self.kept_with_metrics(None).await
    }

    async fn kept_counted(&self, state: &AppState) -> Kept {
        self.kept_with_metrics(Some(Arc::clone(&state.metrics))).await
    }

    async fn kept_with_metrics(&self, metrics: Option<Arc<crate::metrics::Metrics>>) -> Kept {
        let mut stale = Kept::Nothing;
        for (file, exact) in self.candidates() {
            let Some(source) = crate::cache::open_json(&file, MAX_ANSWER_BYTES).await else { continue };
            let (age, modified) = (source.age(), source.modified());
            if source.matches(ABSENT) {
                if age < ABSENT_TTL {
                    return Kept::Absent;
                }
                continue;
            }
            let (prepared, fresh) = if exact {
                let Some(found) = self.prepared_exact(&file, source, metrics.clone()).await else {
                    continue;
                };
                found
            } else {
                let Some(found) =
                    self.prepared_variant_with(&file, source, self.durable_variant(), metrics.clone()).await
                else {
                    continue;
                };
                found
            };
            if age < fresh {
                return Kept::Hit(prepared, fresh, age, modified);
            }
            if matches!(stale, Kept::Nothing) && age < RETENTION {
                stale = Kept::Stale(prepared, modified, fresh);
            }
        }
        stale
    }

    /// The same lookup semantics as `kept`, without publication or the prepared-response queue. This is reserved for
    /// internal consumers which need a JSON value rather than an HTTP body.
    async fn kept_bytes(&self) -> KeptBytes {
        let mut stale = KeptBytes::Nothing;
        for (file, exact) in self.candidates() {
            let Some((body, age, _)) = read_answer(&file).await else { continue };
            if body == ABSENT {
                if age < ABSENT_TTL {
                    return KeptBytes::Absent;
                }
                continue;
            }
            let fresh = fresh_for_answer(&self.path, self.exact.as_deref(), &body);
            let body = if exact { body } else { self.narrowed(body).await };
            if age < fresh {
                return KeptBytes::Hit(body);
            }
            if matches!(stale, KeptBytes::Nothing) && age < RETENTION {
                stale = KeptBytes::Stale(body);
            }
        }
        stale
    }

    /// The question exactly as asked, and where its answer is kept: what a title too large to fetch whole is asked
    /// as instead.
    fn exact(&self) -> (Option<String>, PathBuf) {
        let file = cache_path(&self.dir, &cache_key(&self.path, self.exact.as_deref()));
        (self.exact.clone(), file)
    }

    /// Marks a title whose whole detail did not fit `MAX_ANSWER_BYTES` — a long series with every season's credits
    /// can run past it — so its questions are asked one by one for a while rather than the whole again each time.
    fn oversize_mark(&self) -> PathBuf {
        self.whole().1.with_extension("oversize")
    }

    async fn oversize(&self) -> bool {
        read(&self.oversize_mark()).await.is_some_and(|(_, age, _)| age < OVERSIZE_TTL)
    }

    /// Ask TMDB for the whole detail — again, naming its ETag, when one is kept — and keep it: the whole body, which
    /// `narrowed` cuts to this question, whether it was a `miss` or `revalidated`, and how long it is fresh for.
    ///
    /// When the whole is too large to take, the question is asked exactly as it was, as it was before the whole
    /// existed: one title's size must not fail every question about it. Any other failure — TMDB down, slow or
    /// refusing, the day spent — is the answer: asking again for less would fail the same way and spend twice.
    async fn ask(
        &self,
        state: &AppState,
        key: &str,
        rid: &str,
    ) -> Result<(Bytes, &'static str, Duration), Box<Response>> {
        if self.oversize().await {
            let (query, file) = self.exact();
            let (body, how) = ask_kept(state, &self.path, query.as_deref(), key, rid, &file).await?;
            return Ok((body.clone(), how, fresh_for_answer(&self.path, self.exact.as_deref(), &body)));
        }
        let (query, file) = self.whole();
        let (body, how) = match ask_kept(state, &self.path, query.as_deref(), key, rid, &file).await {
            Ok(answer) => answer,
            Err(response) => {
                if !too_large(&response) {
                    return Err(response);
                }
                write(&self.oversize_mark(), &Bytes::new()).await;
                let (query, file) = self.exact();
                let (body, how) = ask_kept(state, &self.path, query.as_deref(), key, rid, &file).await?;
                return Ok((body.clone(), how, fresh_for_answer(&self.path, self.exact.as_deref(), &body)));
            }
        };
        let fresh = fresh_for_answer(&self.path, self.exact.as_deref(), &body);
        Ok((body, how, fresh))
    }
}

/// The refusal for an answer past `MAX_ANSWER_BYTES`, which alone marks a title's whole detail as too large to ask
/// for. A body that broke off partway is `tmdb_answer_unreadable`: marked as too large, a network error kept a
/// title's questions one by one for a week.
const TOO_LARGE: &str = "tmdb_answer_too_large";

fn too_large(response: &Response) -> bool {
    response.extensions().get::<crate::handler::ErrorCode>().is_some_and(|c| c.0 == TOO_LARGE)
}

/// How long a title whose whole detail was too large is asked one question at a time before the whole is tried
/// again.
const OVERSIZE_TTL: Duration = Duration::from_secs(7 * 86_400);

/// Ask TMDB `query` — again, naming its ETag, when an answer is kept at `file` — and keep what it says there: the
/// body, and whether it was a `miss` or `revalidated`. A 404 is kept as one.
async fn ask_kept(
    state: &AppState,
    path: &str,
    query: Option<&str>,
    key: &str,
    rid: &str,
    file: &Path,
) -> Result<(Bytes, &'static str), Box<Response>> {
    let fetched = if tokio::fs::try_exists(file).await.unwrap_or(false) {
        revalidate(state, path, query, key, rid, file).await
    } else {
        fetch(state, path, query, key, rid).await.map(|(body, etag)| Revalidated::Answer(body, etag))
    };
    match fetched {
        Ok(Revalidated::Answer(body, etag)) => {
            keep_counted(state, file, &body, etag.as_deref()).await;
            Ok((body, "miss"))
        }
        Ok(Revalidated::Unchanged(confirmed)) => {
            let generation = renew_generation(confirmed, file).await;
            let Some(body) = generation.bytes().await else {
                return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_answer_unreadable"));
            };
            Ok((body, "revalidated"))
        }
        Err(response) => {
            if response.status() == StatusCode::NOT_FOUND {
                keep_counted(state, file, &Bytes::from_static(ABSENT), None).await;
            }
            Err(response)
        }
    }
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

/// When `warm` last reached for TMDB, in seconds since the epoch.
static WARMED_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Open the connection to TMDB before a search needs it: the page asks as someone opens search. It asks for the
/// API root with no key (TMDB answers a 301), so nothing is spent of the day's budget or the key's; what it leaves
/// behind is the pooled connection (`client`). Once a minute at most, however many pages ask.
fn warm(state: &Arc<AppState>) {
    let Some(client) = state.tmdb_client.clone() else { return };
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    use std::sync::atomic::Ordering::Relaxed;
    let last = WARMED_AT.load(Relaxed);
    if now.saturating_sub(last) < 60 || WARMED_AT.compare_exchange(last, now, Relaxed, Relaxed).is_err() {
        return;
    }
    tokio::spawn(async move {
        let Ok(uri) = HOST.parse::<axum::http::Uri>() else { return };
        let Ok(request) = axum::http::Request::head(uri).body(Full::new(Bytes::new())) else { return };
        if let Err(error) = client.request(request).await {
            eprintln!("tmdb: warm failed: {error}");
        }
    });
}

/// What a waiter finds after the caller ahead of it finished an exact (non-`Detail`) question.
enum Reopened {
    Absent,
    Fresh(Box<crate::cache::JsonFile>, Duration, Duration, SystemTime),
    StillMissing,
}

async fn reopen_exact(file: &Path, path: &str, query: Option<&str>) -> Reopened {
    let opened = match crate::cache::open_json(file, MAX_ANSWER_BYTES).await {
        Some(prepared) if is_season(path) => {
            prepared.with_bytes().await.map(|(prepared, body)| (prepared, Some(body)))
        }
        other => other.map(|prepared| (prepared, None)),
    };
    let Some((prepared, body)) = opened else {
        return Reopened::StillMissing;
    };
    let (age, modified) = (prepared.age(), prepared.modified());
    let fresh = if carries_moving(query) || body.is_some_and(|body| unfinished(path, &body)) {
        LIST_TTL
    } else {
        fresh_for(path)
    };
    match verdict(prepared.matches(ABSENT), age, fresh) {
        Cached::Absent => Reopened::Absent,
        Cached::Fresh => Reopened::Fresh(Box::new(prepared), fresh, age, modified),
        Cached::Refresh | Cached::Cold => Reopened::StillMissing,
    }
}

fn reopened_answer(state: &AppState, reopened: Reopened, asked: &HeaderMap) -> Option<Response> {
    match reopened {
        Reopened::Absent => {
            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Negative);
            Some(*refused(StatusCode::NOT_FOUND, "not_found"))
        }
        Reopened::Fresh(prepared, fresh, age, modified) => {
            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
            Some(answer_prepared(
                Prepared::File(*prepared),
                &fresh_policy(fresh, fresh.saturating_sub(age)),
                "hit",
                modified,
                asked,
                &state.mmaps,
            ))
        }
        Reopened::StillMissing => None,
    }
}

pub async fn handle(state: &Arc<AppState>, req: Request, rid: &str) -> Response {
    let Some(key) = state.tmdb_key.as_deref() else {
        return json(StatusCode::NOT_FOUND, "tmdb_proxy_off");
    };
    if req.uri().path() == "/tmdb/warm" {
        warm(state);
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap_or_default();
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let path = req.uri().path().trim_start_matches("/tmdb").to_owned();
    if !allowed(&path) {
        return json(StatusCode::NOT_FOUND, "not_found");
    }
    let asked = req.headers();
    let query = req.uri().query().map(str::to_owned);
    if let Some(detail) = Detail::of(&path, query.as_deref(), state.tmdb_cache_dir.as_deref()) {
        let ip = crate::handler::client_ip(state, &req);
        return detail_answer(state, &ip, asked, &detail, key, rid).await;
    }
    let cached = cache_key(&path, query.as_deref());
    let file = state.tmdb_cache_dir.as_ref().map(|dir| cache_path(dir, &cached));

    // A hit never leaves the box, so it is not counted against anybody's budget: what the limits exist to
    // bound is what this origin asks TMDB, not what it already knows.
    if let Some(file) = &file {
        // A season's episode list is read for whether it is still airing (`unfinished`); nothing else here is.
        let opened = match crate::cache::open_json(file, MAX_ANSWER_BYTES).await {
            Some(prepared) if is_season(&path) => {
                prepared.with_bytes().await.map(|(p, body)| (p, Some(body)))
            }
            other => other.map(|prepared| (prepared, None)),
        };
        if let Some((prepared, body)) = opened {
            let (age, modified) = (prepared.age(), prepared.modified());
            // Movie and TV records are handled by `Detail`; every remaining exact endpoint's freshness is path-based,
            // so a hot list/search/subresource hit need not read JSON to rediscover it. A season is the exception.
            let fresh =
                if carries_moving(query.as_deref()) || body.is_some_and(|body| unfinished(&path, &body)) {
                    LIST_TTL
                } else {
                    fresh_for(&path)
                };
            // A remembered 404, answered without spending. Same reasoning as `ask`: this path is per-IP
            // limited so it could not be drained as freely, but it shares the one daily budget.
            //
            // An EXPIRED sentinel must leave this block entirely rather than fall into the refresh below.
            // The stale arm serves the cached body as it is, which for a sentinel means returning
            // `{"den_absent":true}` as a 200 — and a refresh that fails never rewrites the file, so the mtime
            // stays old and every later request repeats it, spending a budget unit each time, for as long as
            // RETENTION allows. It is also ahead of the per-IP bucket, so that is the unthrottled drain again.
            // Falling through to the cold path gets the bucket, the fetch, and a rewritten sentinel.
            match verdict(prepared.matches(ABSENT), age, fresh) {
                Cached::Absent => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Negative);
                    return *refused(StatusCode::NOT_FOUND, "not_found");
                }
                Cached::Fresh => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
                    return answer_prepared(
                        Prepared::File(prepared),
                        &fresh_policy(fresh, fresh.saturating_sub(age)),
                        "hit",
                        modified,
                        asked,
                        &state.mmaps,
                    );
                }
                // A list or a search moves, but the one kept is a better page than a wait on TMDB: served at
                // once, and asked again behind it. A title's details are never here inside the six months.
                Cached::Refresh if fresh != DETAILS_TTL && age < RETENTION => {
                    let asking = Refresh { cached, path, query, key: key.to_owned(), file: file.clone() };
                    refresh_behind(state, asking);
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Stale);
                    return answer_prepared(
                        Prepared::File(prepared),
                        "public, max-age=60",
                        "stale",
                        modified,
                        asked,
                        &state.mmaps,
                    );
                }
                Cached::Refresh => {
                    let mut asking = match one_tmdb_asking(file, key).await {
                        Ok(asking) => asking,
                        Err(refusal) => {
                            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
                            return *refusal;
                        }
                    };
                    // The exact question ahead of this one kept its answer before releasing the turn.
                    if let Some(response) =
                        reopened_answer(state, reopen_exact(file, &path, query.as_deref()).await, asked)
                    {
                        return response;
                    }
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
                    return match revalidate(state, &path, query.as_deref(), key, rid, file).await {
                        Ok(Revalidated::Answer(new, etag)) => {
                            keep_counted(state, file, &new, etag.as_deref()).await;
                            crate::title_metadata::observe_tmdb(state, &path, &new);
                            // The series may have ended since it was last asked for, which gives it its months back.
                            let fresh = fresh_for_answer(&path, query.as_deref(), &new);
                            answer(new, &fresh_policy(fresh, fresh), "miss", SystemTime::now(), asked)
                        }
                        Ok(Revalidated::Unchanged(confirmed)) => {
                            let generation = renew_generation(confirmed, file).await;
                            let Some(body) = generation.bytes().await else {
                                return *refused(StatusCode::BAD_GATEWAY, "tmdb_answer_unreadable");
                            };
                            crate::title_metadata::observe_tmdb(state, &path, &body);
                            answer(body, &fresh_policy(fresh, fresh), "revalidated", SystemTime::now(), asked)
                        }
                        Err(response) => *asking.failed(response).await,
                    };
                }
                // Falls out to the cold path below: the per-IP bucket, a fetch, and a rewritten sentinel.
                Cached::Cold => {}
            }
        }
    }
    let ip = crate::handler::client_ip(state, &req);
    let mut asking = match &file {
        Some(file) => {
            let asking = match one_tmdb_asking(file, key).await {
                Ok(asking) => asking,
                Err(refusal) => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
                    return *refusal;
                }
            };
            // A caller that held this exact turn first has finished its write. Read that answer instead of spending
            // a second upstream question; a failed turn was returned by `one_asking` above.
            if let Some(response) =
                reopened_answer(state, reopen_exact(file, &path, query.as_deref()).await, asked)
            {
                return response;
            }
            Some(asking)
        }
        None => None,
    };
    // Only the elected caller has a cold question left. Callers that waited for the same file reopened the answer
    // above, so charging their address too would spend N visitor claims for the one upstream request they shared.
    if let Some(refusal) = over_allowance(state, &ip, asked).await {
        state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
        return refusal;
    }
    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
    match fetch(state, &path, query.as_deref(), key, rid).await {
        Ok((body, etag)) => {
            if let Some(file) = &file {
                keep_counted(state, file, &body, etag.as_deref()).await;
            } else {
                state.metrics.provider_cache_store(Provider::Tmdb, CacheStore::Skipped);
            }
            crate::title_metadata::observe_tmdb(state, &path, &body);
            let fresh = fresh_for_answer(&path, query.as_deref(), &body);
            answer(body, &fresh_policy(fresh, fresh), "miss", SystemTime::now(), asked)
        }
        Err(response) => {
            if response.status() == StatusCode::NOT_FOUND {
                if let Some(file) = &file {
                    keep_counted(state, file, &Bytes::from_static(ABSENT), None).await;
                } else {
                    state.metrics.provider_cache_store(Provider::Tmdb, CacheStore::Skipped);
                }
            }
            match &mut asking {
                Some(asking) => *asking.failed(response).await,
                None => *response,
            }
        }
    }
}

/// The refusal for a question that has to go to TMDB once this address's allowance is spent; `None` to ask.
async fn over_allowance(state: &AppState, ip: &str, asked: &HeaderMap) -> Option<Response> {
    let visitor_wait = crate::link::throttled_per_minute(state, &format!("tmdb:{ip}"), GUEST_PER_WINDOW)?;
    // Verify the more expensive membership claim only after the visitor allowance is spent. A forged
    // header therefore buys nothing, while a paired household can finish naming a large library.
    let member = asked.get(crate::library::MEMBER_HEADER).and_then(|value| value.to_str().ok());
    if !crate::library::is_member(state, member).await {
        return Some(retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), visitor_wait));
    }
    let wait = crate::link::throttled_per_minute(state, &format!("tmdb-member:{ip}"), MEMBER_PER_WINDOW)?;
    Some(retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait))
}

/// A detail question (`Detail`), answered from whatever kept answer holds it, else by asking TMDB for the whole
/// detail once. Freshness is the served answer's own: a kept film is good for its six months from when it was
/// fetched, an airing series for hours, and a stale series is shown at once while the whole detail is asked again
/// behind it, as a stale list is.
async fn detail_answer(
    state: &Arc<AppState>,
    ip: &str,
    asked: &HeaderMap,
    detail: &Detail,
    key: &str,
    rid: &str,
) -> Response {
    let mut asking = match detail.kept_counted(state).await {
        Kept::Hit(body, fresh, age, modified) => {
            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
            return answer_prepared(
                body,
                &fresh_policy(fresh, fresh.saturating_sub(age)),
                "hit",
                modified,
                asked,
                &state.mmaps,
            );
        }
        Kept::Absent => {
            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Negative);
            return *refused(StatusCode::NOT_FOUND, "not_found");
        }
        Kept::Stale(body, modified, fresh) if fresh != DETAILS_TTL => {
            let (query, file) = if detail.oversize().await { detail.exact() } else { detail.whole() };
            let cached = cache_key(&detail.path, query.as_deref());
            refresh_behind(
                state,
                Refresh { cached, path: detail.path.clone(), query, key: key.to_owned(), file },
            );
            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Stale);
            return answer_prepared(body, "public, max-age=60", "stale", modified, asked, &state.mmaps);
        }
        // A settled record past its six months is asked again now, as it always was, without the allowance.
        Kept::Stale(..) => None,
        Kept::Nothing => {
            let asking = match one_tmdb_asking(&detail.whole().1, key).await {
                Ok(asking) => asking,
                Err(refusal) => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
                    return *refusal;
                }
            };
            // A question about this title that got here first has kept its answer by now.
            match detail.kept_counted(state).await {
                Kept::Hit(body, fresh, age, modified) => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
                    return answer_prepared(
                        body,
                        &fresh_policy(fresh, fresh.saturating_sub(age)),
                        "hit",
                        modified,
                        asked,
                        &state.mmaps,
                    );
                }
                Kept::Absent => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Negative);
                    return *refused(StatusCode::NOT_FOUND, "not_found");
                }
                Kept::Stale(..) | Kept::Nothing => {
                    // Only this elected caller still has an upstream question. Waiters that reopened the title
                    // above are cache hits and must not each consume another visitor allowance claim.
                    if let Some(refusal) = over_allowance(state, ip, asked).await {
                        return refusal;
                    }
                    Some(asking)
                }
            }
        }
    };
    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
    // Reserve the eventual response before the upstream may allocate it. Without this ordering, many cold asks
    // could each finish with a 4 MiB body and then retain it while waiting behind slow derived responses.
    let Some(charge) = derived_response_charge(Some(&state.metrics)).await else {
        return *refused(StatusCode::SERVICE_UNAVAILABLE, "tmdb_busy");
    };
    match detail.ask(state, key, rid).await {
        Ok((whole, how, fresh)) => {
            // A 304 counts too: TMDB confirmed what is kept, and the observation's age starts over with it.
            crate::title_metadata::observe_tmdb(state, &detail.path, &whole);
            let Some(body) = detail.prepared_narrowed(state, whole, charge).await else {
                return *refused(StatusCode::SERVICE_UNAVAILABLE, "tmdb_busy");
            };
            answer_prepared(body, &fresh_policy(fresh, fresh), how, SystemTime::now(), asked, &state.mmaps)
        }
        Err(response) => match &mut asking {
            Some(asking) => *asking.failed(response).await,
            None => *response,
        },
    }
}

/// Questions being asked of an upstream right now, by the file their answer will be kept at.
static ASKING: std::sync::Mutex<std::collections::BTreeMap<PathBuf, Arc<Turn>>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// Until when each configured TMDB identity is resting after TMDB answered 429, in the app clock's milliseconds.
///
/// The key itself must never become process metadata or a log field, so the map holds only its digest. Keeping the
/// deadline per identity matters in tests and during a key rotation: one credential's refusal says nothing about a
/// different one. In production there is one configured identity and this process-local memory deliberately clears
/// on restart, just as an upstream connection does.
static RESTING: std::sync::Mutex<std::collections::BTreeMap<[u8; 32], u64>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

fn provider_identity(key: &str) -> [u8; 32] {
    Sha256::digest(key.as_bytes()).into()
}

fn provider_turn_identity(key: &str) -> String {
    crate::hex(&provider_identity(key))
}

/// Join only a question made with this configured credential. During key rotation, a refusal for the old key says
/// nothing about the new one even though both questions map to the same cache file.
async fn one_tmdb_asking(file: &Path, key: &str) -> Result<Asking, Box<Response>> {
    one_asking(file, &provider_turn_identity(key)).await
}

/// Milliseconds left in TMDB's requested rest, if any. An expired deadline removes itself on the next question.
fn resting(state: &AppState, key: &str) -> Option<u64> {
    let identity = provider_identity(key);
    let now = state.now();
    let mut resting = crate::lock(&RESTING);
    match resting.get(&identity).copied() {
        Some(until) if until > now => Some(until - now),
        Some(_) => {
            resting.remove(&identity);
            None
        }
        None => None,
    }
}

fn remember_rest(state: &AppState, key: &str, wait_ms: u64) {
    let until = state.now().saturating_add(wait_ms);
    let mut resting = crate::lock(&RESTING);
    let remembered = resting.entry(provider_identity(key)).or_default();
    *remembered = (*remembered).max(until);
}

/// One file's question: whose turn it is to ask, and how the last ask ended.
#[derive(Default)]
struct Turn {
    ask: Arc<tokio::sync::Mutex<()>>,
    /// How many asks have ended since the entry was made, and the last one's refusal with whose key it was asked
    /// on; `None` when it did not fail.
    ended: std::sync::Mutex<(u64, Option<(String, Failure)>)>,
}

/// An upstream's refusal as a caller was answered it, kept to be given again to the callers that waited on it.
#[derive(Clone)]
struct Failure {
    status: StatusCode,
    headers: HeaderMap,
    code: Option<crate::handler::ErrorCode>,
    body: Bytes,
}

impl Failure {
    fn response(&self) -> Box<Response> {
        let mut resp = Response::new(Body::from(self.body.clone()));
        *resp.status_mut() = self.status;
        *resp.headers_mut() = self.headers.clone();
        if let Some(code) = &self.code {
            resp.extensions_mut().insert(code.clone());
        }
        Box::new(resp)
    }
}

/// The one question for `file` in flight, held until it is dropped. A cold question used to be asked once per
/// caller: a page opening a title in several tabs, or a burst of devices naming the same library, asked TMDB (or
/// OMDb, or doesthedogdie) that many times and spent that many units of the day's budget. Whoever holds this asks;
/// whoever waits for it looks at what was kept first. Shared by `ratings.rs` and `warnings.rs`, whose answers are
/// kept in files too.
///
/// A caller that waited on an ask that failed is given that failure (`Err`) rather than asking again: each asked in
/// turn, so the k-th caller behind an upstream that was down waited k timeouts, and spent k questions. Only an ask
/// on the same key (`whose`) answers for it — one key refused, rested or spent says nothing about another — and
/// only an ask that ended after this caller joined, so whoever comes later asks afresh.
pub(crate) async fn one_asking(file: &Path, whose: &str) -> Result<Asking, Box<Response>> {
    let (place, joined) = {
        let mut asking = crate::lock(&ASKING);
        let turn = Arc::clone(asking.entry(file.to_owned()).or_default());
        let joined = crate::lock(&turn.ended).0;
        (Place { file: file.to_owned(), turn: Some(turn) }, joined)
    };
    let ask = Arc::clone(&place.turn().ask);
    let held = ask.lock_owned().await;
    let ended = crate::lock(&place.turn().ended).clone();
    if let (true, Some((asker, failure))) = (ended.0 > joined, ended.1) {
        if asker == whose {
            return Err(failure.response());
        }
    }
    Ok(Asking { _held: held, place, whose: whose.to_owned(), failure: None })
}

pub(crate) struct Asking {
    // Let go of first, so the turn passes on before the place is given up.
    _held: tokio::sync::OwnedMutexGuard<()>,
    place: Place,
    whose: String,
    failure: Option<Failure>,
}

impl Asking {
    /// This ask failed with `refusal`: kept for the callers waiting on it, and handed back to answer this one.
    pub(crate) async fn failed(&mut self, refusal: Box<Response>) -> Box<Response> {
        let (parts, body) = refusal.into_parts();
        // A refusal is a line of JSON; one that cannot be read whole is given on, and not kept.
        let Ok(body) = axum::body::to_bytes(body, 64 * 1024).await else {
            return Box::new(Response::from_parts(parts, Body::empty()));
        };
        let code = parts.extensions.get::<crate::handler::ErrorCode>().cloned();
        let failure = Failure { status: parts.status, headers: parts.headers, code, body };
        let refusal = failure.response();
        self.failure = Some(failure);
        refusal
    }
}

impl Drop for Asking {
    fn drop(&mut self) {
        let mut ended = crate::lock(&self.place.turn().ended);
        *ended = (ended.0 + 1, self.failure.take().map(|failure| (std::mem::take(&mut self.whose), failure)));
    }
}

/// A caller's place in a file's turn, from joining it to leaving it however it leaves: with its answer, or
/// dropped while it still waited.
struct Place {
    file: PathBuf,
    turn: Option<Arc<Turn>>,
}

impl Place {
    fn turn(&self) -> &Turn {
        self.turn.as_deref().expect("a place holds its turn until it is dropped")
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        // The last one out takes the entry with it. Every reference is taken and let go under the map's lock, so the
        // count is exact: one left is the map's own. Counted from the guard alone, a waiter dropped before its first
        // look held a reference nobody counted down, and the entry stayed for good.
        let mut asking = crate::lock(&ASKING);
        drop(self.turn.take());
        if asking.get(&self.file).is_some_and(|turn| Arc::strong_count(turn) == 1) {
            asking.remove(&self.file);
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
    // A title's record is the same question the app asks next (`Detail`): answered from what the app keeps, and a
    // cold one fetched whole, so the page this preview was built for opens on a hit.
    if let Some(detail) = Detail::of(path, query, state.tmdb_cache_dir.as_deref()) {
        let stale = match detail.kept_bytes().await {
            KeptBytes::Hit(body) => {
                state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
                return serde_json::from_slice(&body).ok();
            }
            KeptBytes::Absent => {
                state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Negative);
                return None;
            }
            KeptBytes::Stale(body) => Some(body),
            KeptBytes::Nothing => None,
        };
        // Past the minute's questions, or TMDB failing, a title kept past its freshness is still the better preview.
        let asked = 'asked: {
            let mut asking = match one_tmdb_asking(&detail.whole().1, key).await {
                Ok(asking) => asking,
                Err(refusal) if refusal.status() == StatusCode::NOT_FOUND => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
                    return None;
                }
                Err(_) => break 'asked None,
            };
            match detail.kept_bytes().await {
                KeptBytes::Hit(body) => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
                    return serde_json::from_slice(&body).ok();
                }
                KeptBytes::Absent => {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Negative);
                    return None;
                }
                KeptBytes::Stale(..) | KeptBytes::Nothing => {
                    if preview_allowed(state).is_none() {
                        break 'asked None;
                    }
                    match detail.ask(state, key, "meta").await {
                        Ok((whole, ..)) => Some(detail.narrowed(whole).await),
                        Err(refusal) => {
                            let absent = refusal.status() == StatusCode::NOT_FOUND;
                            asking.failed(refusal).await;
                            if absent {
                                state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
                                return None;
                            }
                            break 'asked None;
                        }
                    }
                }
            }
        };
        let access = if asked.is_some() {
            CacheAccess::Cold
        } else if stale.is_some() {
            CacheAccess::Stale
        } else {
            CacheAccess::Cold
        };
        state.metrics.provider_cache_access(Provider::Tmdb, access);
        let body = asked.or(stale)?;
        return serde_json::from_slice(&body).ok();
    }
    let file = state.tmdb_cache_dir.as_ref().map(|dir| cache_path(dir, &cache_key(path, query)));
    let mut stale = None;
    if let Some(file) = &file {
        if let Some((body, age, _)) = read_answer(file).await {
            // A remembered 404 answers as "no such thing" without spending anything.
            if body == ABSENT {
                if age < ABSENT_TTL {
                    state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Negative);
                    return None;
                }
            } else if age < fresh_for_answer(path, query, &body) {
                state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
                return serde_json::from_slice(&body).ok();
            } else {
                stale = Some(body);
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
    if preview_allowed(state).is_none() {
        state.metrics.provider_cache_access(
            Provider::Tmdb,
            if stale.is_some() { CacheAccess::Stale } else { CacheAccess::Cold },
        );
        return stale.and_then(|body| serde_json::from_slice(&body).ok());
    }
    let fetched = match (&file, &stale) {
        (Some(file), Some(_)) => revalidate(state, path, query, key, "meta", file).await,
        _ => fetch(state, path, query, key, "meta").await.map(|(body, etag)| Revalidated::Answer(body, etag)),
    };
    match fetched {
        Ok(Revalidated::Answer(body, etag)) => {
            if let Some(file) = &file {
                keep_counted(state, file, &body, etag.as_deref()).await;
            } else {
                state.metrics.provider_cache_store(Provider::Tmdb, CacheStore::Skipped);
            }
            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
            serde_json::from_slice(&body).ok()
        }
        Ok(Revalidated::Unchanged(confirmed)) => {
            let generation = match &file {
                Some(file) => renew_generation(confirmed, file).await,
                None => confirmed.generation,
            };
            state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
            generation.bytes().await.and_then(|body| serde_json::from_slice(&body).ok())
        }
        Err(answer) => {
            if answer.status() == StatusCode::NOT_FOUND {
                if let Some(file) = &file {
                    keep_counted(state, file, &Bytes::from_static(ABSENT), None).await;
                } else {
                    state.metrics.provider_cache_store(Provider::Tmdb, CacheStore::Skipped);
                }
                state.metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Cold);
                return None;
            }
            state.metrics.provider_cache_access(
                Provider::Tmdb,
                if stale.is_some() { CacheAccess::Stale } else { CacheAccess::Cold },
            );
            stale.and_then(|body| serde_json::from_slice(&body).ok())
        }
    }
}

/// `Some` while link previews may ask TMDB this minute (`PREVIEWS_PER_MINUTE`), counting the question.
fn preview_allowed(state: &AppState) -> Option<()> {
    crate::link::throttled_per_minute(state, "tmdb:preview", PREVIEWS_PER_MINUTE).is_none().then_some(())
}

/// What TMDB said to a question.
enum Fetched {
    /// An answer, with the ETag TMDB gave it.
    Answer(Bytes, Option<String>),
    /// A 304: the kept answer is still TMDB's.
    Unchanged,
}

enum Revalidated {
    Answer(Bytes, Option<String>),
    /// The exact open body generation whose bound upstream tag TMDB confirmed.
    Unchanged(Box<Confirmed>),
}

struct Confirmed {
    generation: crate::cache::JsonFile,
    etag: BoundEtag,
}

const ETAG_MAGIC: &[u8; 8] = b"DENTAG2\0";
const MAX_ETAG_BYTES: usize = 1024;

struct BoundEtag {
    value: String,
    file: tokio::fs::File,
}

impl BoundEtag {
    async fn renew(self, modified: SystemTime) {
        let file = self.file.into_std().await;
        let _ = tokio::task::spawn_blocking(move || file.set_modified(modified)).await;
    }
}

async fn bound_etag(file: &Path, digest: &[u8; 16]) -> Option<BoundEtag> {
    let opened = tokio::fs::File::open(file.with_extension("etag")).await.ok()?;
    let len = usize::try_from(opened.metadata().await.ok()?.len()).ok()?;
    if !(24..=24 + MAX_ETAG_BYTES).contains(&len) {
        return None;
    }
    let mut bytes = vec![0; len];
    let mut opened = opened;
    use tokio::io::AsyncReadExt as _;
    opened.read_exact(&mut bytes).await.ok()?;
    if &bytes[..8] != ETAG_MAGIC || &bytes[8..24] != digest {
        return None;
    }
    let value = String::from_utf8(bytes[24..].to_vec()).ok().filter(|tag| !tag.is_empty())?;
    Some(BoundEtag { value, file: opened })
}

async fn renew_generation(confirmed: Box<Confirmed>, file: &Path) -> crate::cache::JsonFile {
    let Confirmed { generation, etag } = *confirmed;
    let modified = SystemTime::now();
    let (generation, ()) = tokio::join!(generation.renew(file, modified), etag.renew(modified));
    generation
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
) -> Result<(Bytes, Option<String>), Box<Response>> {
    match send(state, path, query, key, rid, None).await? {
        Fetched::Answer(body, etag) => Ok((body, etag)),
        // Only a question that names a tag is answered 304.
        Fetched::Unchanged => Err(refused(StatusCode::BAD_GATEWAY, "tmdb_refused")),
    }
}

/// Ask again for the answer kept at `file`, naming the ETag it was kept with, so TMDB can say it is unchanged
/// rather than send all of it again. An answer kept without a tag is simply asked for.
async fn revalidate(
    state: &AppState,
    path: &str,
    query: Option<&str>,
    key: &str,
    rid: &str,
    file: &Path,
) -> Result<Revalidated, Box<Response>> {
    let Some(generation) = crate::cache::open_json(file, MAX_ANSWER_BYTES).await else {
        return send(state, path, query, key, rid, None).await.map(|fetched| match fetched {
            Fetched::Answer(body, etag) => Revalidated::Answer(body, etag),
            Fetched::Unchanged => unreachable!("no validator was sent"),
        });
    };
    let etag = bound_etag(file, &generation.digest()).await;
    match send(state, path, query, key, rid, etag.as_ref().map(|etag| etag.value.as_str())).await? {
        Fetched::Answer(body, etag) => Ok(Revalidated::Answer(body, etag)),
        Fetched::Unchanged => Ok(Revalidated::Unchanged(Box::new(Confirmed {
            generation,
            etag: etag.expect("TMDB cannot answer 304 without the bound ETag we sent"),
        }))),
    }
}

async fn send(
    state: &AppState,
    path: &str,
    query: Option<&str>,
    key: &str,
    rid: &str,
    etag: Option<&str>,
) -> Result<Fetched, Box<Response>> {
    // TMDB's Retry-After applies to the configured credential, not only to the question it refused. Remember it
    // ahead of the daily spend so a cold miss and every stale refresh during the rest neither leave the box nor use
    // another unit of the household's budget.
    if let Some(wait) = resting(state, key) {
        return Err(Box::new(retry_after(
            StatusCode::SERVICE_UNAVAILABLE,
            &error("tmdb_rate_limited"),
            wait,
        )));
    }
    // The whole point of the daily ceiling: a key that is lent out can be spent by anyone who finds the route,
    // and the household would be the one rate-limited by TMDB afterwards.
    if !spend(state) {
        return Err(Box::new(retry_after(
            StatusCode::SERVICE_UNAVAILABLE,
            &error("tmdb_budget_spent"),
            // The day starts over at UTC midnight (`spend`), not an hour from now.
            DAY_MS - state.now() % DAY_MS,
        )));
    }
    #[cfg(test)]
    if let Some(tmdb) = tests::stand_in(key) {
        return tmdb(&upstream(path, query, key));
    }
    let Some(client) = state.tmdb_client.as_ref() else {
        return Err(refused(StatusCode::NOT_FOUND, "tmdb_proxy_off"));
    };
    let mut out = axum::http::Request::builder()
        .method(Method::GET)
        .uri(upstream(path, query, key))
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid);
    if let Some(tag) = etag.and_then(|t| HeaderValue::from_str(t).ok()) {
        out = out.header(header::IF_NONE_MATCH, tag);
    }
    let Ok(out) = out.body(Full::new(Bytes::new())) else {
        return Err(refused(StatusCode::BAD_REQUEST, "bad_request"));
    };
    let attempt = state.metrics.provider_upstream_started(Provider::Tmdb);
    let (status, headers, bytes) = match exchange(client, out, MAX_ANSWER_BYTES, TIMEOUT, "tmdb").await {
        Ok(answer) => answer,
        Err(Failed::Unreachable) => {
            attempt.finished(ProviderUpstream::Failed);
            return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_unreachable"));
        }
        Err(Failed::Timeout) => {
            attempt.finished(ProviderUpstream::Failed);
            return Err(refused(StatusCode::GATEWAY_TIMEOUT, "tmdb_timeout"));
        }
        Err(Failed::TooLarge) => {
            attempt.finished(ProviderUpstream::Failed);
            return Err(refused(StatusCode::BAD_GATEWAY, TOO_LARGE));
        }
        Err(Failed::Unreadable) => {
            attempt.finished(ProviderUpstream::Failed);
            return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_answer_unreadable"));
        }
    };
    if status == StatusCode::NOT_MODIFIED && etag.is_some() {
        refund(state);
        attempt.finished(ProviderUpstream::NotModified);
        return Ok(Fetched::Unchanged);
    }
    let tag = headers.get(header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_owned);
    if !status.is_success() {
        attempt.finished(if status == StatusCode::NOT_FOUND {
            ProviderUpstream::Negative
        } else {
            ProviderUpstream::Failed
        });
        return Err(refusal(state, key, status, &headers));
    }
    attempt.finished(ProviderUpstream::Updated);
    Ok(Fetched::Answer(bytes, tag))
}

/// TMDB's own refusal, passed on as ours without its body: it may name the key.
///
/// Anything but a 404 is said in the log, once a minute per status: a revoked `TMDB_KEY` (401), TMDB rate-limiting
/// the household (429) or TMDB down (5xx) otherwise showed only as a 502 to whoever asked next. A 429 is passed on
/// as a wait, with TMDB's own `Retry-After`, rather than as a failure.
fn refusal(state: &AppState, key: &str, status: StatusCode, headers: &HeaderMap) -> Box<Response> {
    if status == StatusCode::NOT_FOUND {
        return refused(StatusCode::NOT_FOUND, "not_found");
    }
    if crate::link::throttled_per_minute(state, &format!("tmdb-refused:{}", status.as_u16()), 1).is_none() {
        let check = if status == StatusCode::UNAUTHORIZED { " - check TMDB_KEY" } else { "" };
        eprintln!("tmdb: TMDB answered {status}{check}");
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        let secs = headers
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(10);
        remember_rest(state, key, secs.saturating_mul(1000));
        return Box::new(retry_after(
            StatusCode::SERVICE_UNAVAILABLE,
            &error("tmdb_rate_limited"),
            secs.saturating_mul(1000),
        ));
    }
    refused(StatusCode::BAD_GATEWAY, "tmdb_refused")
}

/// Take one from today's allowance (env `TMDB_DAILY_MAX`), or refuse. Only questions that actually leave the
/// box count: a cache hit costs the household nothing and is never charged.
///
/// This is the kill switch the lending rests on. Without a ceiling, one crawler that finds this route spends
/// the household's quota and it is the household TMDB rate-limits afterwards, on every device it owns.
fn spend(state: &AppState) -> bool {
    let Some(max) = state.tmdb_daily_max else { return true };
    let day = state.now() / DAY_MS;
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
                "tmdb: daily budget of {max} spent — guest browsing and link previews answer 503 until UTC midnight. A cached answer still serves; only new questions stop."
            );
        }
        return false;
    }
    spent.1 += 1;
    true
}

/// Give back what `spend` took for a question TMDB answered 304. The ceiling bounds what the lent key fetches, and
/// a 304 carries nothing: it only says the answer already kept is still TMDB's.
fn refund(state: &AppState) {
    if state.tmdb_daily_max.is_some() {
        let mut spent = crate::lock(&state.tmdb_spent);
        spent.1 = spent.1.saturating_sub(1);
    }
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

async fn read_answer(file: &Path) -> Option<(Bytes, Duration, SystemTime)> {
    let opened = crate::cache::open_json(file, MAX_ANSWER_BYTES).await?;
    let (age, modified) = (opened.age(), opened.modified());
    Some((opened.bytes().await?, age, modified))
}

/// Written beside and renamed over, so a reader never sees half an answer. Ordinary caches may ignore a
/// failure; endpoints that promise persistence can surface it.
///
/// The temporary file is this write's own. With one shared name, two writes of the same key at once — two cold
/// questions for one title, now that a title's questions share one key — wrote into the same file, and the rename
/// could put a mix of both in place, to be served as a hit for months.
///
/// One blocking task, from the directory to the rename. As separate awaits, a caller that stopped waiting between
/// them — a link preview past its `meta::BUDGET` — left the temporary file behind: the blocking write it had started ran
/// on, and nothing renamed or removed what it wrote. A blocking task runs to its end whoever is still waiting.
pub(crate) async fn write(file: &Path, body: &Bytes) -> bool {
    let (file, body) = (file.to_owned(), body.clone());
    let temp = file.with_extension(format!("{}.tmp", crate::hex(&crate::random_bytes::<8>())));
    tokio::task::spawn_blocking(move || {
        let Some(dir) = file.parent() else { return false };
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
        if std::fs::write(&temp, &body).is_ok() && std::fs::rename(&temp, &file).is_ok() {
            return true;
        }
        let _ = std::fs::remove_file(&temp);
        false
    })
    .await
    .unwrap_or(false)
}

/// An answer kept with the ETag TMDB gave it, beside it as `<name>.etag`, or with none — so a revalidation never
/// names the tag of a body that is no longer there, which TMDB would answer 304 for. The old tag goes first: a
/// reader in between asks without one rather than with the wrong one.
async fn keep(file: &Path, body: &Bytes, etag: Option<&str>) -> bool {
    let tag = file.with_extension("etag");
    let _ = tokio::fs::remove_file(&tag).await;
    if !crate::cache::write_json(file, body).await {
        return false;
    }
    if let Some(etag) = etag.filter(|etag| !etag.is_empty() && etag.len() <= MAX_ETAG_BYTES) {
        let mut record = Vec::with_capacity(24 + etag.len());
        record.extend_from_slice(ETAG_MAGIC);
        record.extend_from_slice(&Sha256::digest(body)[..16]);
        record.extend_from_slice(etag.as_bytes());
        write(&tag, &Bytes::from(record)).await;
    }
    true
}

async fn keep_counted(state: &AppState, file: &Path, body: &Bytes, etag: Option<&str>) {
    let attempt = state.metrics.provider_store_started(Provider::Tmdb);
    let stored = keep(file, body, etag).await;
    attempt.finished(if stored { CacheStore::Stored } else { CacheStore::Failed });
}

/// Drop what is past TMDB's six-month ceiling. Runs on a timer rather than on a request: a sweep is a
/// directory scan, and no one waiting for a page should pay for it.
pub async fn sweep(dir: &Path, metrics: &crate::metrics::Metrics) {
    let Some(mut inventory) = sweep_older_than(dir, RETENTION, metrics, Provider::Tmdb).await else {
        metrics.provider_cache_scan(Provider::Tmdb, false);
        return;
    };
    let Some(prepared) = sweep_prepared(dir, RETENTION, metrics).await else {
        metrics.provider_cache_scan(Provider::Tmdb, false);
        return;
    };
    inventory.add(prepared);
    metrics.provider_cache_inventory(
        Provider::Tmdb,
        inventory.bytes,
        inventory.entries,
        inventory.oldest_age_seconds(),
    );
    metrics.provider_cache_scan(Provider::Tmdb, inventory.successful);
}

#[derive(Clone, Copy, Default)]
pub(crate) struct CacheInventory {
    bytes: u64,
    entries: u64,
    oldest_modified: Option<SystemTime>,
    successful: bool,
}

impl CacheInventory {
    fn empty() -> Self {
        Self { successful: true, ..Self::default() }
    }

    fn add(&mut self, other: CacheInventory) {
        self.bytes = self.bytes.saturating_add(other.bytes);
        self.entries = self.entries.saturating_add(other.entries);
        self.oldest_modified = match (self.oldest_modified, other.oldest_modified) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        };
        self.successful &= other.successful;
    }

    fn record_bytes(&mut self, len: u64) {
        self.bytes = self.bytes.saturating_add(len);
    }

    fn record(&mut self, path: &Path, metadata: &std::fs::Metadata, provider: Provider) {
        let excluded = match provider {
            Provider::Warnings => path.file_name().is_some_and(|name| name == "topics.json"),
            _ => false,
        };
        let serveable = path.extension().is_some_and(|extension| extension == "json") && !excluded;
        self.record_file(metadata, serveable);
    }

    fn record_prepared(&mut self, path: &Path, metadata: &std::fs::Metadata) {
        let serveable =
            path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(".tmdb.json"));
        self.record_file(metadata, serveable);
    }

    fn record_file(&mut self, metadata: &std::fs::Metadata, serveable: bool) {
        self.record_bytes(metadata.len());
        self.entries = self.entries.saturating_add(u64::from(serveable));
        if serveable {
            if let Ok(modified) = metadata.modified() {
                self.oldest_modified =
                    Some(self.oldest_modified.map_or(modified, |oldest| oldest.min(modified)));
            }
        }
    }

    fn oldest_age_seconds(&self) -> u64 {
        self.oldest_modified
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .unwrap_or_default()
            .as_secs()
    }

    fn deletion_failed(&mut self, provider: Provider, path: &Path, error: &std::io::Error) {
        self.successful = false;
        eprintln!("{} cache sweep: could not remove {}: {error}", provider_name(provider), path.display());
    }
}

fn provider_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Tmdb => "tmdb",
        Provider::Ratings => "ratings",
        Provider::Warnings => "warnings",
        Provider::Skipdb => "skipdb",
    }
}

fn scan_failed(provider: Provider, path: &Path, error: &std::io::Error) {
    eprintln!("{} cache inventory: could not scan {}: {error}", provider_name(provider), path.display());
}

async fn sweep_prepared(
    dir: &Path,
    max_age: Duration,
    metrics: &crate::metrics::Metrics,
) -> Option<CacheInventory> {
    let root = dir.join(".tmdb-prepared");
    let mut inventory = CacheInventory::empty();
    let mut sources = match tokio::fs::read_dir(&root).await {
        Ok(sources) => sources,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(inventory),
        Err(error) => {
            scan_failed(Provider::Tmdb, &root, &error);
            return None;
        }
    };
    loop {
        let source = match sources.next_entry().await {
            Ok(Some(source)) => source,
            Ok(None) => break,
            Err(error) => {
                scan_failed(Provider::Tmdb, &root, &error);
                return None;
            }
        };
        let kind = match source.file_type().await {
            Ok(kind) => kind,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                scan_failed(Provider::Tmdb, &source.path(), &error);
                return None;
            }
        };
        if kind.is_file() {
            let metadata = match source.metadata().await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    scan_failed(Provider::Tmdb, &source.path(), &error);
                    return None;
                }
            };
            // Files directly under `.tmdb-prepared` are artifacts, never representations the serving path opens.
            inventory.record_bytes(metadata.len());
            continue;
        }
        if !kind.is_dir() {
            continue;
        }
        let mut entries = match tokio::fs::read_dir(source.path()).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                scan_failed(Provider::Tmdb, &source.path(), &error);
                return None;
            }
        };
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(error) => {
                    scan_failed(Provider::Tmdb, &source.path(), &error);
                    return None;
                }
            };
            let kind = match entry.file_type().await {
                Ok(kind) => kind,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    scan_failed(Provider::Tmdb, &entry.path(), &error);
                    return None;
                }
            };
            if !kind.is_file() {
                continue;
            }
            let metadata = match entry.metadata().await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    scan_failed(Provider::Tmdb, &entry.path(), &error);
                    return None;
                }
            };
            let expired = metadata
                .modified()
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > max_age);
            if expired {
                let path = entry.path();
                match tokio::fs::remove_file(&path).await {
                    Ok(()) if path.extension().is_some_and(|extension| extension == "json") => {
                        metrics.provider_cache_store(Provider::Tmdb, CacheStore::Expired);
                    }
                    Ok(()) => {}
                    Err(error) => {
                        inventory.deletion_failed(Provider::Tmdb, &path, &error);
                        inventory.record_prepared(&path, &metadata);
                    }
                }
            } else {
                inventory.record_prepared(&entry.path(), &metadata);
            }
        }
        let _ = tokio::fs::remove_dir(source.path()).await;
    }
    let _ = tokio::fs::remove_dir(root).await;
    Some(inventory)
}

/// The same sweep for another cache with its own ceiling (`warnings.rs`).
pub(crate) async fn sweep_older_than(
    dir: &Path,
    max_age: Duration,
    metrics: &crate::metrics::Metrics,
    provider: Provider,
) -> Option<CacheInventory> {
    let mut inventory = CacheInventory::empty();
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(inventory),
        Err(error) => {
            scan_failed(provider, dir, &error);
            return None;
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(error) => {
                scan_failed(provider, dir, &error);
                return None;
            }
        };
        let kind = match entry.file_type().await {
            Ok(kind) => kind,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                scan_failed(provider, &entry.path(), &error);
                return None;
            }
        };
        if !kind.is_file() {
            continue;
        }
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                scan_failed(provider, &entry.path(), &error);
                return None;
            }
        };
        let expired = metadata
            .modified()
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        if expired {
            let path = entry.path();
            match tokio::fs::remove_file(&path).await {
                Ok(()) if path.extension().is_some_and(|extension| extension == "json") => {
                    metrics.provider_cache_store(provider, CacheStore::Expired);
                }
                Ok(()) => {}
                Err(error) => {
                    inventory.deletion_failed(provider, &path, &error);
                    inventory.record(&path, &metadata, provider);
                }
            }
        } else {
            inventory.record(&entry.path(), &metadata, provider);
        }
    }
    Some(inventory)
}

pub(crate) async fn sweep_provider_cache(
    dir: &Path,
    max_age: Duration,
    metrics: &crate::metrics::Metrics,
    provider: Provider,
) {
    if let Some(inventory) = sweep_older_than(dir, max_age, metrics, provider).await {
        metrics.provider_cache_inventory(
            provider,
            inventory.bytes,
            inventory.entries,
            inventory.oldest_age_seconds(),
        );
        metrics.provider_cache_scan(provider, inventory.successful);
    } else {
        metrics.provider_cache_scan(provider, false);
    }
}

pub async fn sweep_forever(state: std::sync::Arc<AppState>) {
    let Some(dir) = state.tmdb_cache_dir.clone() else { return };
    loop {
        sweep(&dir, &state.metrics).await;
        tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
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
    // A stale answer is already being served. During TMDB's requested rest there is nothing useful for a task to do,
    // and starting one per stale read would only churn the executor before `send` refused it locally.
    if resting(state, &asking.key).is_some() {
        return;
    }
    if !crate::lock(&state.tmdb_refreshing).insert(asking.cached.clone()) {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        let _refreshing = Refreshing { set: &state.tmdb_refreshing, key: asking.cached.clone() };
        // Refused, over budget or unreachable: what is kept stays, and the next stale read asks again.
        let (path, query, key) = (&asking.path, asking.query.as_deref(), &asking.key);
        match revalidate(&state, path, query, key, "refresh", &asking.file).await {
            Ok(Revalidated::Answer(body, etag)) => {
                keep_counted(&state, &asking.file, &body, etag.as_deref()).await;
                crate::title_metadata::observe_tmdb(&state, path, &body);
            }
            Ok(Revalidated::Unchanged(confirmed)) => {
                let generation = renew_generation(confirmed, &asking.file).await;
                if let Some(body) = generation.bytes().await {
                    crate::title_metadata::observe_tmdb(&state, path, &body);
                }
            }
            // A whole detail too large to take (`Detail::oversize_mark`): its questions are asked one by one next.
            Err(response) if too_large(&response) => {
                write(&asking.file.with_extension("oversize"), &Bytes::new()).await;
            }
            Err(_) => {}
        }
    });
}

/// A refresh's mark in its `*_refreshing` set, cleared when the refresh ends however it ends, a panic included:
/// a key left marked is never refreshed again until a restart.
pub(crate) struct Refreshing<'a> {
    pub(crate) set: &'a std::sync::Mutex<std::collections::HashSet<String>>,
    pub(crate) key: String,
}

impl Drop for Refreshing<'_> {
    fn drop(&mut self) {
        crate::lock(self.set).remove(&self.key);
    }
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

fn answer_prepared(
    body: Prepared,
    policy: &str,
    how: &'static str,
    modified: SystemTime,
    asked: &HeaderMap,
    mmaps: &crate::mmap::Cache,
) -> Response {
    match body {
        Prepared::Bytes(body) => answer(body, policy, how, modified, asked),
        Prepared::File(body) => {
            let mut response = body.response_at(modified, mmaps);
            if let Ok(value) = HeaderValue::from_str(policy) {
                response.headers_mut().insert(header::CACHE_CONTROL, value);
            }
            response.headers_mut().insert("x-den-tmdb", HeaderValue::from_static(how));
            crate::cache::revalidate(response, asked)
        }
    }
}

fn json(status: StatusCode, code: &str) -> Response {
    crate::handler::json_reply(status, &error(code))
}

/// The same refusal, boxed for `fetch`'s error variant.
fn refused(status: StatusCode, code: &str) -> Box<Response> {
    Box::new(json(status, code))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one builder and the response pool are process-wide, so tests that hold them take turns: filling the pool
    /// (32 slow responses through the one builder) kept it from a test waiting 2 s for it, when both ran at once.
    static SHARED_BUILDER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

    /// Opening search asks den-edge to warm its connection: a POST, answered at once and never cached, since a copy
    /// Cloudflare kept would stop the next one reaching the box. Nothing else about `/tmdb/` takes a POST.
    #[tokio::test]
    async fn a_warm_is_a_post_answered_at_once_and_never_kept() {
        let h = Harness::in_dir_with(temp_dir(), |state| state.tmdb_key = Some("k".into()));
        let warmed = h.send("POST", "/tmdb/warm", None, &[]).await;
        assert_eq!(warmed.status(), StatusCode::NO_CONTENT);
        assert_eq!(warmed.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(h.send("GET", "/tmdb/warm", None, &[]).await.status(), StatusCode::METHOD_NOT_ALLOWED);
        let posted = h.send("POST", "/tmdb/3/movie/550", None, &[]).await;
        assert_eq!(posted.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    /// A refused key, a rate limit and an outage were each a bare 502 with nothing in the log; a 429's own wait was
    /// dropped, and a spent day said to come back in an hour whatever the time until UTC midnight.
    #[tokio::test]
    async fn tmdbs_refusals_say_what_they_are_and_how_long_to_wait() {
        let h = Harness::in_dir_with(temp_dir(), |state| state.tmdb_daily_max = Some(0));
        let mut waits = HeaderMap::new();
        waits.insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
        let limited = refusal(&h.state, "refusal-waits", StatusCode::TOO_MANY_REQUESTS, &waits);
        assert_eq!(limited.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(limited.headers()[header::RETRY_AFTER], "7");
        let limited = refusal(&h.state, "refusal-default", StatusCode::TOO_MANY_REQUESTS, &HeaderMap::new());
        assert_eq!(limited.headers()[header::RETRY_AFTER], "10", "a 429 without a wait still names one");
        assert_eq!(
            refusal(&h.state, "refusal-other", StatusCode::UNAUTHORIZED, &HeaderMap::new()).status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            refusal(&h.state, "refusal-other", StatusCode::NOT_FOUND, &HeaderMap::new()).status(),
            StatusCode::NOT_FOUND
        );

        // The harness's clock starts at a known time of day; a spent day waits until the next UTC midnight.
        let spent = send(&h.state, "/3/movie/550", None, "k", "t", None).await.err().unwrap();
        assert_eq!(spent.status(), StatusCode::SERVICE_UNAVAILABLE);
        let wait: u64 = spent.headers()[header::RETRY_AFTER].to_str().unwrap().parse().unwrap();
        assert_eq!(wait, (DAY_MS - h.state.now() % DAY_MS).div_ceil(1000));
        h.advance(DAY_MS - h.state.now() % DAY_MS - 5_000);
        let spent = send(&h.state, "/3/movie/550", None, "k", "t", None).await.err().unwrap();
        assert_eq!(spent.headers()[header::RETRY_AFTER], "5", "five seconds before midnight");
    }

    #[tokio::test]
    async fn an_upstream_retry_after_rests_cold_questions_and_stale_refreshes() {
        let cache = temp_dir();
        let key = "remembered-upstream-rest";
        let kept_in = cache.clone();
        let h = Harness::in_dir_with(temp_dir(), |state| {
            state.tmdb_key = Some(key.into());
            state.tmdb_cache_dir = Some(kept_in);
            state.tmdb_daily_max = Some(5);
        });
        let asked = Arc::new(std::sync::Mutex::new(0));
        let seen = Arc::clone(&asked);
        let tmdb: Upstream = Arc::new(move |_| {
            *crate::lock(&seen) += 1;
            Ok(Fetched::Answer(Bytes::from_static(b"{\"results\":[]}"), None))
        });
        crate::lock(&UPSTREAMS).push((key.to_owned(), tmdb));

        let mut headers = HeaderMap::new();
        headers.insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
        drop(refusal(&h.state, key, StatusCode::TOO_MANY_REQUESTS, &headers));

        let cold = h.send("GET", "/tmdb/3/search/movie?query=rested", None, &[]).await;
        assert_eq!(cold.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(cold.headers()[header::RETRY_AFTER], "7");
        assert_eq!(*crate::lock(&asked), 0, "the cold question stayed inside the box");
        assert_eq!(crate::lock(&h.state.tmdb_spent).1, 0, "and spent no daily allowance");

        let list = cache_path(&cache, &cache_key("/3/trending/all/week", None));
        write(&list, &Bytes::from_static(b"{\"page\":1}")).await;
        aged(&list, LIST_TTL + Duration::from_secs(1));
        let stale = h.send("GET", "/tmdb/3/trending/all/week", None, &[]).await;
        assert_eq!(stale.headers()["x-den-tmdb"], "stale");
        assert!(crate::lock(&h.state.tmdb_refreshing).is_empty(), "no queued refresh during the rest");
        assert_eq!(*crate::lock(&asked), 0);

        h.advance(7_000);
        assert_eq!(
            h.send("GET", "/tmdb/3/search/movie?query=rested", None, &[]).await.status(),
            StatusCode::OK
        );
        assert_eq!(*crate::lock(&asked), 1, "the deadline, not a permanent latch, ended the rest");
        assert_eq!(crate::lock(&h.state.tmdb_spent).1, 1);
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
            // den-atlas's refresh: which titles were edited, and a series' credits across its seasons.
            "/3/movie/changes",
            "/3/tv/changes",
            "/3/tv/1399/aggregate_credits",
        ] {
            assert!(allowed(path), "{path}");
        }
        assert!(!allowed("/3/collection/changes"), "a collection has no changes list");
        assert_eq!(fresh_for("/3/movie/changes"), LIST_TTL, "a list, not a settled record");
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

    /// A series that is not over is the one record here that does not settle. The app reads its shape to decide
    /// which episode comes next, so kept for six months it withholds an episode that aired weeks ago.
    #[test]
    fn a_series_that_is_not_over_is_kept_for_hours_not_months() {
        let airing: &[u8] = br#"{"id":1399,"status":"Returning Series","next_episode_to_air":{"id":1}}"#;
        // Between seasons: nothing scheduled, and the announcement of the next season is what must be noticed.
        let between: &[u8] = br#"{"id":1399,"status":"Returning Series","next_episode_to_air":null}"#;
        let ended: &[u8] = br#"{"id":1399,"status":"Ended","next_episode_to_air":null}"#;
        let cancelled: &[u8] = br#"{"id":1399,"status":"Canceled","next_episode_to_air":null}"#;
        assert_eq!(fresh_for_answer("/3/tv/1399", None, airing), LIST_TTL);
        assert_eq!(fresh_for_answer("/3/tv/1399", None, between), LIST_TTL);
        assert_eq!(fresh_for_answer("/3/tv/1399", None, ended), DETAILS_TTL);
        assert_eq!(fresh_for_answer("/3/tv/1399", None, cancelled), DETAILS_TTL);
        // A series' status speaks for its own record only: a season is judged by its dates, a film by its release.
        let aired: &[u8] = br#"{"air_date":"2011-04-17","episodes":[{"air_date":"2011-04-17"}]}"#;
        assert_eq!(fresh_for_answer("/3/tv/1399/season/1", None, aired), DETAILS_TTL);
        let released: &[u8] = br#"{"id":550,"release_date":"1999-10-15","status":"Released"}"#;
        assert_eq!(fresh_for_answer("/3/movie/550", None, released), DETAILS_TTL);
    }

    /// A season still airing, and a film not yet out or only just out, are still being filled in: kept for six
    /// months, a season stopped at the episodes announced when it was first asked, and a film went on naming a
    /// release date that had moved.
    #[test]
    fn a_season_still_airing_and_a_film_not_yet_settled_are_kept_for_hours() {
        let since = "2026-08-29";
        let season = |body: &str| unfinished_since("/3/tv/1399/season/3", body.as_bytes(), since);
        assert!(!season(
            r#"{"air_date":"2013-03-31","episodes":[{"air_date":"2013-03-31"},{"air_date":"2013-06-02"}]}"#
        ));
        assert!(season(
            r#"{"air_date":"2026-09-01","episodes":[{"air_date":"2026-09-01"},{"air_date":"2026-10-06"}]}"#
        ));
        assert!(season(
            r#"{"air_date":"2026-01-01","episodes":[{"air_date":"2026-01-01"},{"air_date":null}]}"#
        ));
        assert!(
            season(r#"{"air_date":"2026-01-01","episodes":[{"air_date":"2026-09-10"}]}"#),
            "aired inside the month"
        );
        assert!(season(r#"{"air_date":null,"episodes":[]}"#), "announced, nothing scheduled");
        assert!(season(r#"{"episodes":[]}"#), "no date at all is no evidence it is done");

        let film = |body: &str| unfinished_since("/3/movie/550", body.as_bytes(), since);
        assert!(!film(r#"{"release_date":"1999-10-15","status":"Released"}"#));
        assert!(film(r#"{"release_date":"2027-03-05","status":"Post Production"}"#));
        assert!(film(r#"{"release_date":"2026-09-18","status":"Released"}"#), "out inside the month");
        assert!(film(r#"{"release_date":"","status":"Planned"}"#));
        // An appended list names dates of its own, which say nothing about this film.
        assert!(!film(
            r#"{"recommendations":{"results":[{"release_date":"2026-09-20"}]},"release_date":"1999-10-15","status":"Released"}"#
        ));

        // Neither the routes under a season nor a person's record is judged this way.
        assert!(!unfinished_since("/3/tv/1399/season/3/credits", br#"{"cast":[]}"#, since));
        assert!(!unfinished_since("/3/person/287", br#"{"birthday":"1963-12-18"}"#, since));
        assert!(is_season("/3/tv/1399/season/0"));
        assert!(!is_season("/3/tv/1399/season/3/episode/1"));
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

    /// A key is the question TMDB is asked, and nothing else is. Pairs were joined unescaped, so one parameter
    /// whose value carried `=` and `&` keyed as two: `sort_by%3Dpopularity.desc%26with_genres=18` reaches TMDB as a
    /// single unknown parameter (an unfiltered list) and was kept under the real filter's key, served to everyone
    /// who asked for dramas.
    #[test]
    fn a_question_is_kept_under_its_own_key_and_no_other() {
        let real = cache_key("/3/discover/movie", Some("sort_by=popularity.desc&with_genres=18"));
        let planted = cache_key("/3/discover/movie", Some("sort_by%3Dpopularity.desc%26with_genres=18"));
        assert_ne!(real, planted);
        assert_ne!(
            upstream("/3/discover/movie", Some("sort_by=popularity.desc&with_genres=18"), "k"),
            upstream("/3/discover/movie", Some("sort_by%3Dpopularity.desc%26with_genres=18"), "k"),
            "and TMDB is asked two different questions"
        );
        assert_ne!(
            cache_key("/3/search/multi", Some("query=a%26b%3Dc")),
            cache_key("/3/search/multi", Some("b=c&query=a")),
        );
        // An escape in a value is not the character it escapes.
        assert_ne!(
            cache_key("/3/search/multi", Some("query=%2526")),
            cache_key("/3/search/multi", Some("query=%26"))
        );
        // What is on disk stays where it is: a question with nothing to escape keeps the key it always had.
        assert_eq!(
            cache_key("/3/movie/550", Some("append_to_response=credits,watch/providers&language=en-US")),
            "/3/movie/550?append_to_response=credits,watch/providers&language=en-US&"
        );
        assert_eq!(
            cache_key("/3/search/multi", Some("query=blade+runner")),
            "/3/search/multi?query=blade runner&"
        );
    }

    /// An upstream that sends its headers and then stalls used to hold the exchange for as long as the socket stayed
    /// open: the timeout covered only the headers. It covers the whole answer now, and a body that is too large is
    /// told apart from one that broke off.
    #[tokio::test]
    async fn a_stalled_body_times_out_with_the_exchange() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // Each connection is answered by what its request asks for: a stalled body, one too large, one cut off.
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut asked = vec![0; 1024];
                    let n = socket.read(&mut asked).await.unwrap_or(0);
                    let asked = String::from_utf8_lossy(&asked[..n]).into_owned();
                    let head = |length: usize| format!("HTTP/1.1 200 OK\r\ncontent-length: {length}\r\n\r\n");
                    if asked.starts_with("GET /stall") {
                        let _ = socket.write_all(format!("{}ab", head(100)).as_bytes()).await;
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    } else if asked.starts_with("GET /large") {
                        let _ = socket.write_all(format!("{}{}", head(64), "x".repeat(64)).as_bytes()).await;
                    } else {
                        let _ = socket.write_all(format!("{}ab", head(100)).as_bytes()).await;
                    }
                });
            }
        });
        let client: Client<HttpConnector, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
        let ask = |path: &str| {
            let out = axum::http::Request::get(format!("http://{addr}{path}"))
                .body(Full::new(Bytes::new()))
                .unwrap();
            exchange(&client, out, 32, Duration::from_millis(300), "test")
        };
        let started = std::time::Instant::now();
        assert_eq!(ask("/stall").await.unwrap_err(), Failed::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        assert_eq!(ask("/large").await.unwrap_err(), Failed::TooLarge);
        assert_eq!(ask("/cut").await.unwrap_err(), Failed::Unreadable);
    }

    #[test]
    fn the_callers_key_is_thrown_away_and_ours_substituted() {
        let url = upstream("/3/movie/550", Some("api_key=theirs&language=en-US"), "ours");
        assert!(url.starts_with("https://api.themoviedb.org/3/movie/550?"), "{url}");
        assert!(url.contains("api_key=ours"), "{url}");
        assert!(!url.contains("theirs"), "{url}");
        assert!(url.contains("language=en-US"), "{url}");
    }

    use crate::handler::tests::{body_json, body_text, temp_dir, Harness};

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
        write(
            &cache_path(&cache, &cache_key("/3/movie/550", None)),
            &Bytes::from_static(br#"{"id":550,"status":"Released","release_date":"1999-10-15"}"#),
        )
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

    /// A kept answer's ETag is bound to its digest and leaves with it. An answer kept without one, or a 404 kept in
    /// its place, must never be revalidated with the tag of what was there before: TMDB would answer 304 for a body
    /// that is not the one on disk.
    #[tokio::test]
    async fn an_answer_is_kept_with_a_bound_etag_and_a_304_renews_its_body() {
        let dir = temp_dir();
        let file = cache_path(&dir, &cache_key("/3/trending/all/week", None));
        let tag = file.with_extension("etag");
        keep(&file, &Bytes::from_static(b"{\"page\":1}"), Some("W/\"abc\"")).await;
        let digest = crate::cache::open_json(&file, MAX_ANSWER_BYTES).await.unwrap().digest();
        assert_eq!(bound_etag(&file, &digest).await.map(|etag| etag.value).as_deref(), Some("W/\"abc\""));

        aged(&file, LIST_TTL + Duration::from_secs(60));
        aged(&tag, LIST_TTL + Duration::from_secs(60));
        let generation = crate::cache::open_json(&file, MAX_ANSWER_BYTES).await.unwrap();
        let etag = bound_etag(&file, &digest).await.unwrap();
        let _ = renew_generation(Box::new(Confirmed { generation, etag }), &file).await;
        assert!(read(&file).await.unwrap().1 < Duration::from_secs(5), "a 304 counts as fetched now");
        let tag_age =
            SystemTime::now().duration_since(std::fs::metadata(&tag).unwrap().modified().unwrap()).unwrap();
        assert!(tag_age < Duration::from_secs(5), "the exact digest-bound ETag was not renewed");
        assert_eq!(bound_etag(&file, &digest).await.map(|etag| etag.value).as_deref(), Some("W/\"abc\""));

        keep(&file, &Bytes::from_static(b"{\"page\":2}"), None).await;
        assert!(!tag.exists(), "an answer kept without a tag drops the old one");
        keep(&file, &Bytes::from_static(b"{\"page\":3}"), Some("W/\"def\"")).await;
        keep(&file, &Bytes::from_static(ABSENT), None).await;
        assert!(!tag.exists(), "and so does a 404 kept in its place");
    }

    /// A 304 carries nothing, so the question it answered is given back to the day's budget.
    #[test]
    fn a_304_is_given_back_to_the_days_budget() {
        let h = Harness::in_dir_with(temp_dir(), |state| state.tmdb_daily_max = Some(3));
        assert!(spend(&h.state) && spend(&h.state));
        refund(&h.state);
        assert_eq!(crate::lock(&h.state.tmdb_spent).1, 1);
        let unlimited = Harness::in_dir_with(temp_dir(), |_| {});
        refund(&unlimited.state);
        assert_eq!(crate::lock(&unlimited.state.tmdb_spent).1, 0, "nothing to give back without a ceiling");
    }

    #[test]
    fn provider_attempt_guards_count_cancellation_and_completion_once() {
        let metrics = Arc::new(crate::metrics::Metrics::default());
        drop(metrics.provider_upstream_started(Provider::Tmdb));
        metrics.provider_upstream_started(Provider::Tmdb).finished(ProviderUpstream::Updated);
        drop(metrics.provider_store_started(Provider::Tmdb));
        metrics.provider_store_started(Provider::Tmdb).finished(CacheStore::Stored);

        let rendered = metrics.render();
        for row in [
            r#"den_edge_provider_upstream_total{provider="tmdb",result="cancelled"} 1"#,
            r#"den_edge_provider_upstream_total{provider="tmdb",result="updated"} 1"#,
            r#"den_edge_provider_cache_store_total{provider="tmdb",result="cancelled"} 1"#,
            r#"den_edge_provider_cache_store_total{provider="tmdb",result="stored"} 1"#,
        ] {
            assert!(rendered.contains(row), "missing {row}");
        }
    }

    type Upstream = Arc<dyn Fn(&str) -> Result<Fetched, Box<Response>> + Send + Sync>;
    /// A stand-in TMDB per lent key, so tests running at once each get their own.
    static UPSTREAMS: std::sync::Mutex<Vec<(String, Upstream)>> = std::sync::Mutex::new(Vec::new());

    pub(super) fn stand_in(key: &str) -> Option<Upstream> {
        crate::lock(&UPSTREAMS).iter().find(|(k, _)| k == key).map(|(_, tmdb)| Arc::clone(tmdb))
    }

    /// A TMDB for the test lending `key`: a title's record, with each sub-request asked for as a field of its own,
    /// and `status` for a series. It records every question it is asked, without the key.
    fn tmdb_answering(key: &str, status: &'static str) -> Arc<std::sync::Mutex<Vec<String>>> {
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = Arc::clone(&asked);
        let tmdb: Upstream = Arc::new(move |url: &str| {
            let url = url::Url::parse(url).unwrap();
            let id: u64 = url.path().rsplit('/').next().unwrap().parse().unwrap();
            // `status` is a series'; a film is one long out, which is what settles it (`unfinished`).
            let mut body = if url.path().starts_with("/3/movie/") {
                serde_json::json!({ "id": id, "title": "T", "status": "Released", "release_date": "1999-10-15", "vote_average": 7.5 })
            } else {
                serde_json::json!({ "id": id, "title": "T", "status": status, "vote_average": 7.5 })
            };
            let mut appends = String::new();
            for (name, value) in url.query_pairs().filter(|(name, _)| name != "api_key") {
                if name == "append_to_response" {
                    for append in value.split(',') {
                        body[append] = serde_json::json!({ "from": append });
                    }
                }
                appends.push_str(&format!("{name}={value}&"));
            }
            crate::lock(&seen).push(format!("{}?{appends}", url.path()));
            Ok(Fetched::Answer(Bytes::from(body.to_string()), None))
        });
        crate::lock(&UPSTREAMS).push((key.to_owned(), tmdb));
        asked
    }

    #[tokio::test]
    async fn a_cold_preview_404_is_counted_before_its_early_return() {
        let h = lending_as(&temp_dir(), "missing-preview");
        let tmdb: Upstream = Arc::new(|_| Err(refused(StatusCode::NOT_FOUND, "not_found")));
        crate::lock(&UPSTREAMS).push(("missing-preview".to_owned(), tmdb));

        assert!(ask(&h.state, "/3/movie/999999999", None).await.is_none());

        assert!(h
            .state
            .metrics
            .render()
            .contains(r#"den_edge_provider_cache_access_total{provider="tmdb",result="cold"} 1"#));
    }

    /// A TMDB whose whole series detail is too large to take (`MAX_ANSWER_BYTES`), as a long series' every-season
    /// credits can be, answering every other question as `tmdb_answering` does.
    fn tmdb_too_large_whole(key: &str) -> Arc<std::sync::Mutex<Vec<String>>> {
        tmdb_answering(&format!("{key}-inner"), "Ended");
        let inner = stand_in(&format!("{key}-inner")).unwrap();
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = Arc::clone(&asked);
        let tmdb: Upstream = Arc::new(move |url: &str| {
            let whole = url.contains("aggregate_credits");
            crate::lock(&seen).push(if whole {
                "whole".to_owned()
            } else {
                url.split("api_key").next().unwrap().to_owned()
            });
            if whole {
                return Err(refused(StatusCode::BAD_GATEWAY, TOO_LARGE));
            }
            inner(url)
        });
        crate::lock(&UPSTREAMS).push((key.to_owned(), tmdb));
        asked
    }

    /// A series whose whole detail is too large used to 502 every question about it, spending the day's budget each
    /// time. The question is asked as it was instead, and the whole is not tried again for a while.
    #[tokio::test]
    async fn a_title_too_large_to_fetch_whole_is_asked_one_question_at_a_time() {
        let cache = temp_dir();
        let h = lending_as(&cache, "too-large");
        let asked = tmdb_too_large_whole("too-large");

        let (how, named) = detail(&h, "/tmdb/3/tv/1399?append_to_response=credits").await;
        assert_eq!(how, "miss");
        assert!(named.get("credits").is_some(), "{named}");
        assert_eq!(crate::lock(&asked).len(), 2, "the whole, refused, then the question itself");
        assert_eq!(crate::lock(&asked)[0], "whole");

        assert_eq!(detail(&h, "/tmdb/3/tv/1399").await.0, "miss");
        assert_eq!(detail(&h, "/tmdb/3/tv/1399?append_to_response=credits").await.0, "hit");
        let asked = crate::lock(&asked).clone();
        assert_eq!(asked.len(), 3, "{asked:?}");
        assert_ne!(asked[2], "whole", "the whole is not tried again");
    }

    /// Only an answer too large to take sends a title's questions one by one. TMDB down or refusing used to ask the
    /// question a second time, exactly, which failed the same way and spent twice; and a body that broke off partway
    /// was taken for a large one, and marked the title for a week.
    #[tokio::test]
    async fn a_whole_detail_that_fails_for_any_other_reason_is_asked_once() {
        for (key, code) in [("broke-off", "tmdb_answer_unreadable"), ("refusing", "tmdb_refused")] {
            let cache = temp_dir();
            let h = lending_as(&cache, key);
            let asked = Arc::new(std::sync::Mutex::new(0));
            let seen = Arc::clone(&asked);
            let tmdb: Upstream = Arc::new(move |_: &str| {
                *crate::lock(&seen) += 1;
                Err(refused(StatusCode::BAD_GATEWAY, code))
            });
            crate::lock(&UPSTREAMS).push((key.to_owned(), tmdb));

            let resp = h.send("GET", "/tmdb/3/tv/1399?append_to_response=credits", None, &[]).await;
            assert_eq!(resp.status(), StatusCode::BAD_GATEWAY, "{code}");
            assert_eq!(*crate::lock(&asked), 1, "{code}: asked once");
            let detail = Detail::of("/3/tv/1399", None, Some(&cache)).unwrap();
            assert!(!detail.oversize_mark().exists(), "{code}: not marked as too large");
        }
    }

    /// Two writes of one key at once each write their own temporary file, so what ends up in place is one of them
    /// whole, never a mix.
    #[tokio::test]
    async fn writes_of_one_key_at_once_leave_one_of_them_whole() {
        let file = cache_path(&temp_dir(), "/3/tv/1399?");
        let bodies: Vec<Bytes> = (0..16u8).map(|n| Bytes::from(vec![b'a' + n; 256 * 1024])).collect();
        let writes: Vec<_> = bodies
            .iter()
            .map(|body| {
                let (file, body) = (file.clone(), body.clone());
                tokio::spawn(async move { write(&file, &body).await })
            })
            .collect();
        for w in writes {
            assert!(w.await.unwrap(), "every write is kept whole or not at all");
        }
        let kept = read(&file).await.unwrap().0;
        assert!(bodies.contains(&kept), "what is in place is one write, whole");
        let strays = std::fs::read_dir(file.parent().unwrap()).unwrap().count();
        assert_eq!(strays, 1, "no temporary file is left behind");
    }

    fn lending_as(cache: &Path, key: &str) -> Harness {
        let (cache, key) = (cache.to_path_buf(), key.to_owned());
        Harness::in_dir_with(temp_dir(), |state| {
            state.tmdb_key = Some(key);
            state.tmdb_cache_dir = Some(cache);
        })
    }

    async fn detail(h: &Harness, url: &str) -> (String, serde_json::Value) {
        let resp = h.send("GET", url, None, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK, "{url}");
        let how = resp.headers()["x-den-tmdb"].to_str().unwrap().to_owned();
        (how, serde_json::from_str(&body_text(resp).await).unwrap())
    }

    const WEB_MOVIE: &str = "credits,recommendations,videos,external_ids,release_dates,watch/providers";

    /// A title used to be asked for once per client and question — the preview, the library's naming, the detail
    /// page, the TV — each its own miss. Now the first question fetches the whole detail and the rest are hits.
    #[tokio::test]
    async fn every_detail_question_for_a_title_is_one_upstream_fetch() {
        let cache = temp_dir();
        let h = lending_as(&cache, "one-fetch");
        let asked = tmdb_answering("one-fetch", "Ended");

        let (how, bare) = detail(&h, "/tmdb/3/movie/550").await;
        assert_eq!(how, "miss");
        assert!(bare.get("credits").is_none(), "a bare question gets the bare record: {bare}");
        let (how, named) = detail(&h, "/tmdb/3/movie/550?append_to_response=credits").await;
        assert_eq!(how, "hit");
        assert!(named.get("credits").is_some() && named.get("videos").is_none(), "{named}");
        let web = format!("/tmdb/3/movie/550?append_to_response={}", WEB_MOVIE.replace('/', "%2F"));
        let (how, page) = detail(&h, &web).await;
        assert_eq!(how, "hit");
        for append in MOVIE_APPENDS {
            assert!(page.get(append).is_some(), "{append} in {page}");
        }
        let tv_screen = "/tmdb/3/movie/550?append_to_response=release_dates,watch/providers,credits,recommendations,videos";
        assert_eq!(detail(&h, tv_screen).await.0, "hit");
        assert_eq!(ask(&h.state, "/3/movie/550", None).await.unwrap()["id"], 550, "the link preview");
        assert_eq!(
            *crate::lock(&asked),
            [format!("/3/movie/550?append_to_response={}&", MOVIE_APPENDS.join(","))],
            "one question, for the whole detail"
        );

        // The other parameters are still the question's own.
        assert_eq!(detail(&h, "/tmdb/3/movie/550?language=fi").await.0, "miss");
        assert_eq!(crate::lock(&asked).len(), 2);

        // A series likewise, from the library's naming to the detail page.
        assert_eq!(detail(&h, "/tmdb/3/tv/1399?append_to_response=credits,external_ids").await.0, "miss");
        let tv_page = "/tmdb/3/tv/1399?append_to_response=aggregate_credits,recommendations,videos,external_ids,content_ratings,watch/providers";
        assert_eq!(detail(&h, tv_page).await.0, "hit");
        assert_eq!(crate::lock(&asked).len(), 3);
    }

    #[tokio::test]
    async fn a_narrow_detail_is_prepared_once_and_bound_to_the_whole_generation() {
        let cache = temp_dir();
        let h = lending_as(&cache, "prepared-detail");
        let asked = tmdb_answering("prepared-detail", "Ended");
        assert_eq!(detail(&h, "/tmdb/3/movie/550?append_to_response=credits").await.0, "miss");

        let detail = Detail::of("/3/movie/550", Some("append_to_response=credits"), Some(&cache)).unwrap();
        let source = detail.whole().1;
        let source_digest = crate::cache::open_json(&source, MAX_ANSWER_BYTES).await.unwrap().digest();
        let variant = detail.variant(&source, &source_digest, DETAILS_TTL);
        assert!(!variant.exists(), "the miss response is already resident and needs no second write");

        let first = h.send("GET", "/tmdb/3/movie/550?append_to_response=credits", None, &[]).await;
        assert_eq!(first.headers()["x-den-tmdb"], "hit");
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
        assert!(variant.exists());
        assert_eq!(body_json(first).await["credits"]["from"], "credits");

        let repeated = h
            .send("GET", "/tmdb/3/movie/550?append_to_response=credits", None, &[("if-none-match", &etag)])
            .await;
        assert_eq!(repeated.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(crate::lock(&asked).len(), 1, "a prepared representation never asks TMDB");
        let metrics = h.state.metrics.render();
        assert!(metrics.contains(r#"den_edge_tmdb_prepared_total{result="transient_built"} 1"#));
        assert!(metrics.contains(r#"den_edge_tmdb_prepared_total{result="file_built"} 1"#));
        assert!(metrics.contains(r#"den_edge_tmdb_prepared_total{result="file_hit"} 1"#));
        assert!(metrics.contains(r#"den_edge_provider_cache_access_total{provider="tmdb",result="cold"} 1"#));
        assert!(metrics.contains(r#"den_edge_provider_cache_access_total{provider="tmdb",result="fresh"} 2"#));

        let replacement = Bytes::from_static(
            br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"changed","credits":{"from":"new"},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
        );
        keep(&source, &replacement, None).await;
        let changed = h.send("GET", "/tmdb/3/movie/550?append_to_response=credits", None, &[]).await;
        assert_ne!(changed.headers()[header::ETAG], etag.as_str());
        assert_eq!(body_json(changed).await["credits"]["from"], "new");
    }

    #[tokio::test]
    async fn derived_byte_metrics_follow_the_response_owner() {
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let charge = derived_response_charge(Some(&metrics)).await.unwrap();
        let body = charged_derived(Bytes::from_static(b"{}"), charge);
        assert!(metrics
            .render()
            .contains(r#"den_edge_byte_admission_used_bytes{pool="tmdb_derived"} 4194304"#));
        drop(body);
        assert!(metrics.render().contains(r#"den_edge_byte_admission_used_bytes{pool="tmdb_derived"} 0"#));
    }

    #[tokio::test]
    async fn slow_exact_hits_keep_open_files_not_body_sized_buffers() {
        let dir = temp_dir();
        let detail =
            Arc::new(Detail::of("/3/movie/550", Some("append_to_response=credits"), Some(&dir)).unwrap());
        let exact = detail.exact().1;
        let cast: Vec<_> = (0..7000)
            .map(|id| serde_json::json!({"id":id,"name":format!("actor-{id}"),"character":"x".repeat(260)}))
            .collect();
        let body = Bytes::from(
            serde_json::to_vec(&serde_json::json!({"id":550,"status":"Released","release_date":"1999-10-15","title":"legacy","credits":{"cast":cast}}))
                .unwrap(),
        );
        assert!(body.len() > 2 * 1024 * 1024 && body.len() < MAX_ANSWER_BYTES);
        crate::cache::write_json(&exact, &body).await;
        let digest = crate::cache::open_json(&exact, MAX_ANSWER_BYTES).await.unwrap().digest();
        let variant = detail.variant(&exact, &digest, DETAILS_TTL);

        // Model the 48 slow bulk responses the server admits at once. Each result remains alive and unread: a
        // Bytes-backed response would retain more than 96 MiB here; prepared hits retain only open descriptors.
        let mut requests = Vec::new();
        for _ in 0..crate::handler::BULK_REQUESTS {
            let detail = Arc::clone(&detail);
            requests.push(tokio::spawn(async move { detail.kept().await }));
        }
        let mut held = Vec::new();
        for request in requests {
            match request.await.unwrap() {
                Kept::Hit(prepared @ Prepared::File(_), fresh, _, _) => {
                    assert_eq!(fresh, DETAILS_TTL);
                    held.push(prepared);
                }
                _ => panic!("an exact hit retained an allocated body instead of an open prepared file"),
            }
        }
        assert_eq!(held.len(), crate::handler::BULK_REQUESTS);
        assert!(variant.exists(), "the legacy exact shape was not migrated lazily");
        let bodies = std::fs::read_dir(variants_dir(&exact))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmdb.json"))
            .count();
        assert_eq!(bodies, 1, "concurrent owners published duplicate prepared generations");

        // The internal canonical TV shape contains both credit forms and is intentionally not one of KEPT_TV's
        // external client shapes. It is nevertheless a fixed shape and must not fall back to retained Bytes when a
        // caller asks that exact question.
        let canonical_query = format!("append_to_response={}", TV_APPENDS.join(","));
        let canonical = Detail::of("/3/tv/1399", Some(&canonical_query), Some(&dir)).unwrap();
        assert!(!canonical.durable_variant());
        assert_eq!(canonical.exact().1, canonical.whole().1);
        let canonical_file = canonical.whole().1;
        let canonical_body = Bytes::from_static(
            br#"{"id":1399,"status":"Ended","aggregate_credits":{},"content_ratings":{},"credits":{},"external_ids":{},"recommendations":{},"videos":{},"watch/providers":{}}"#,
        );
        crate::cache::write_json(&canonical_file, &canonical_body).await;
        let canonical_digest =
            crate::cache::open_json(&canonical_file, MAX_ANSWER_BYTES).await.unwrap().digest();
        match canonical.kept().await {
            Kept::Hit(Prepared::File(_), fresh, _, _) => assert_eq!(fresh, LIST_TTL),
            _ => panic!("the exact canonical shape was not prepared as a streamed file"),
        }
        assert!(
            !canonical.variant(&canonical_file, &canonical_digest, LIST_TTL).exists(),
            "the canonical file itself is the prepared representation"
        );
    }

    async fn assert_slow_derived_responses_are_bounded(detail: Arc<Detail>, source_path: PathBuf) {
        let capacity = DERIVED_RESPONSE_BUDGET_BYTES / MAX_ANSWER_BYTES;
        assert_eq!(capacity, 32, "keep this test's expected response ceiling explicit");
        assert!(crate::handler::BULK_REQUESTS > capacity, "more requests than the ceiling, so one must wait");
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..crate::handler::BULK_REQUESTS {
            let detail = Arc::clone(&detail);
            let source_path = source_path.clone();
            requests.spawn(async move {
                let source = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap();
                detail.prepared_variant(&source_path, source).await.unwrap()
            });
        }

        let mut held = Vec::new();
        let mmaps = crate::mmap::Cache::new(Arc::new(crate::metrics::Metrics::default()));
        for _ in 0..capacity {
            let (prepared, _) = tokio::time::timeout(Duration::from_secs(5), requests.join_next())
                .await
                .expect("a derived response never acquired its bounded charge")
                .expect("a derived response task vanished")
                .unwrap();
            assert!(matches!(prepared, Prepared::Bytes(_)));
            held.push(answer_prepared(
                prepared,
                "public, max-age=60",
                "hit",
                SystemTime::now(),
                &HeaderMap::new(),
                &mmaps,
            ));
        }
        assert_eq!(derived_response_budget().available_permits(), 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), requests.join_next()).await.is_err(),
            "a slow response past the ceiling retained an uncharged derived body"
        );

        // The charge follows the response body: releasing one unread response lets exactly one waiting builder
        // finish. The remaining waiters are request-owned and cancellation removes them from the build queue.
        drop(held.pop());
        let (next, _) = tokio::time::timeout(Duration::from_secs(5), requests.join_next())
            .await
            .expect("dropping a response did not release its charge")
            .expect("the next derived response task vanished")
            .unwrap();
        assert!(matches!(next, Prepared::Bytes(_)));
        drop(next);
        requests.abort_all();
        while requests.join_next().await.is_some() {}
        drop(held);

        // An owner detached between taking the build permit and observing cancellation may finish once the held
        // responses leave. Reacquiring the whole budget proves it did not leak either its task or its charge.
        let all = tokio::time::timeout(
            Duration::from_secs(5),
            Arc::clone(derived_response_budget()).acquire_many_owned(DERIVED_RESPONSE_BUDGET_BYTES as u32),
        )
        .await
        .expect("cancelled derived responses retained their memory charge")
        .unwrap();
        drop(all);
    }

    #[tokio::test]
    async fn forty_eight_slow_arbitrary_and_failed_publication_responses_stay_bounded() {
        let _turn = SHARED_BUILDER.lock().await;
        let body = Bytes::from(
            serde_json::to_vec(&serde_json::json!({
                "id": 550,
                "title": "large",
                "credits": {"cast": (0..7000).map(|id| serde_json::json!({
                    "id": id,
                    "name": format!("actor-{id}"),
                    "character": "x".repeat(260)
                })).collect::<Vec<_>>()},
                "external_ids": {},
                "recommendations": {},
                "release_dates": {},
                "videos": {},
                "watch/providers": {}
            }))
            .unwrap(),
        );
        assert!(body.len() > 2 * 1024 * 1024 && body.len() < MAX_ANSWER_BYTES);

        // An unknown subset is intentionally not durable, but its slow response still owns a large allocation.
        let arbitrary_dir = temp_dir();
        let arbitrary = Arc::new(
            Detail::of("/3/movie/550", Some("append_to_response=credits,videos"), Some(&arbitrary_dir))
                .unwrap(),
        );
        assert!(!arbitrary.durable_variant());
        let arbitrary_source = arbitrary.whole().1;
        crate::cache::write_json(&arbitrary_source, &body).await;
        assert_slow_derived_responses_are_bounded(arbitrary, arbitrary_source).await;

        // A normal durable shape must take the same bounded fallback when its prepared directory cannot be made.
        let failed_dir = temp_dir();
        std::fs::create_dir_all(&failed_dir).unwrap();
        std::fs::write(failed_dir.join(".tmdb-prepared"), b"not a directory").unwrap();
        let failed = Arc::new(
            Detail::of("/3/movie/550", Some("append_to_response=credits"), Some(&failed_dir)).unwrap(),
        );
        assert!(failed.durable_variant());
        let failed_source = failed.whole().1;
        crate::cache::write_json(&failed_source, &body).await;
        assert_slow_derived_responses_are_bounded(failed, failed_source).await;
    }

    #[tokio::test]
    async fn a_late_old_generation_build_cannot_publish_for_a_new_source() {
        let dir = temp_dir();
        let detail = Detail::of("/3/movie/550", Some("append_to_response=credits"), Some(&dir)).unwrap();
        let source_path = detail.whole().1;
        let old = Bytes::from_static(
            br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"old","credits":{"from":"old"},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
        );
        keep(&source_path, &old, None).await;
        let old_source = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap();
        let old_digest = old_source.digest();
        let old_variant = detail.variant(&source_path, &old_digest, DETAILS_TTL);

        let new = Bytes::from_static(
            br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"new","credits":{"from":"new"},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
        );
        keep(&source_path, &new, None).await;
        let new_source = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap();
        let new_digest = new_source.digest();
        let new_variant = detail.variant(&source_path, &new_digest, DETAILS_TTL);
        assert_ne!(old_variant, new_variant);

        let (old_answer, _) = detail.prepared_variant(&source_path, old_source).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&old_answer.bytes().await.unwrap()).unwrap()["title"],
            "old"
        );
        assert!(!old_variant.exists(), "a displaced generation was published late");

        let (new_answer, _) = detail.prepared_variant(&source_path, new_source).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&new_answer.bytes().await.unwrap()).unwrap()["title"],
            "new"
        );
        assert!(new_variant.exists());
    }

    #[tokio::test]
    async fn prepared_detail_replacements_keep_only_one_bounded_generation() {
        let dir = temp_dir();
        let detail = Detail::of("/3/movie/550", Some("append_to_response=credits"), Some(&dir)).unwrap();
        let source_path = detail.whole().1;
        let mut expected_len = 0;

        for generation in 0..24 {
            let body = Bytes::from(
                serde_json::to_vec(&serde_json::json!({
                    "id": 550,
                    "title": format!("generation-{generation}"),
                    "credits": {"cast": [{"id": generation, "name": "actor"}]},
                    "external_ids": {},
                    "recommendations": {},
                    "release_dates": {},
                    "videos": {},
                    "watch/providers": {}
                }))
                .unwrap(),
            );
            assert!(crate::cache::write_json(&source_path, &body).await);
            let source = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap();
            let (prepared, _) = detail.prepared_variant(&source_path, source).await.unwrap();
            expected_len = prepared.bytes().await.unwrap().len() as u64;

            let derived: Vec<_> = std::fs::read_dir(variants_dir(&source_path))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmdb.json"))
                .collect();
            assert_eq!(derived.len(), 1, "generation {generation} left obsolete prepared bodies");
            assert_eq!(derived[0].metadata().unwrap().len(), expected_len);
        }

        let derived_bytes: u64 = std::fs::read_dir(variants_dir(&source_path))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmdb.json"))
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        assert_eq!(derived_bytes, expected_len + 64, "one body and its fixed metadata sidecar are the bound");

        let metrics = crate::metrics::Metrics::default();
        let _ = sweep_prepared(&dir, Duration::ZERO, &metrics).await;
        assert!(
            !variants_dir(&source_path).exists(),
            "retention cleanup left the per-source directory behind"
        );
        assert!(metrics
            .render()
            .contains(r#"den_edge_provider_cache_store_total{provider="tmdb",result="expired"} 1"#));
    }

    #[tokio::test]
    async fn provider_inventory_counts_only_regular_serveable_bodies_without_following_links() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("canonical.json"), b"body").unwrap();
        aged(&dir.join("canonical.json"), Duration::from_secs(2 * 3600));
        std::fs::write(dir.join("canonical.response"), b"meta").unwrap();
        std::fs::write(dir.join("canonical.etag"), b"tag").unwrap();
        std::fs::write(dir.join("write.tmp"), b"temporary").unwrap();
        std::fs::write(dir.join("title.oversize"), b"x").unwrap();

        let prepared = dir.join(".tmdb-prepared");
        let source = prepared.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("variant.tmdb.json"), b"variant").unwrap();
        std::fs::write(source.join("marker.json"), b"marker").unwrap();
        std::fs::write(source.join("variant.tmdb.json.response"), b"sidecar").unwrap();
        std::fs::write(prepared.join("orphan.response"), b"orphan").unwrap();
        std::fs::write(prepared.join("orphan.json"), b"root-json").unwrap();

        let outside = temp_dir();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("outside.json"), b"not counted").unwrap();
        std::os::unix::fs::symlink(outside.join("outside.json"), dir.join("linked.json")).unwrap();
        std::os::unix::fs::symlink(&outside, prepared.join("linked-source")).unwrap();

        let metrics = crate::metrics::Metrics::default();
        sweep(&dir, &metrics).await;
        let rendered = metrics.render();
        let expected_bytes = 4 + 4 + 3 + 9 + 1 + 7 + 6 + 7 + 6 + 9;
        assert!(rendered
            .contains(&format!(r#"den_edge_provider_cache_bytes{{provider="tmdb"}} {expected_bytes}"#)));
        assert!(rendered.contains(r#"den_edge_provider_cache_entries{provider="tmdb"} 2"#));
        let oldest = rendered
            .lines()
            .find_map(|line| {
                line.strip_prefix(r#"den_edge_provider_cache_oldest_age_seconds{provider="tmdb"} "#)
            })
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!((7100..=7300).contains(&oldest), "unexpected oldest age: {oldest}");
        assert!(
            rendered.contains(r#"den_edge_provider_cache_scan_total{provider="tmdb",outcome="success"} 1"#)
        );

        let warnings = temp_dir();
        std::fs::create_dir_all(&warnings).unwrap();
        std::fs::write(warnings.join("tt1.json"), b"warnings").unwrap();
        std::fs::write(warnings.join("topics.json"), b"topics").unwrap();
        std::fs::write(warnings.join("tt1.response"), b"metadata").unwrap();
        sweep_provider_cache(&warnings, RETENTION, &metrics, Provider::Warnings).await;
        let rendered = metrics.render();
        assert!(rendered.contains(r#"den_edge_provider_cache_bytes{provider="warnings"} 22"#));
        assert!(rendered.contains(r#"den_edge_provider_cache_entries{provider="warnings"} 1"#));
        assert!(rendered
            .contains(r#"den_edge_provider_cache_scan_total{provider="warnings",outcome="success"} 1"#));
    }

    #[tokio::test]
    async fn an_incomplete_inventory_is_reported_and_does_not_publish_partial_totals() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("canonical.json"), b"body").unwrap();
        std::fs::write(dir.join(".tmdb-prepared"), b"not a directory").unwrap();
        let metrics = crate::metrics::Metrics::default();

        sweep(&dir, &metrics).await;

        let rendered = metrics.render();
        assert!(rendered.contains(r#"den_edge_provider_cache_entries{provider="tmdb"} 0"#));
        assert!(
            rendered.contains(r#"den_edge_provider_cache_scan_total{provider="tmdb",outcome="failed"} 1"#)
        );
    }

    #[tokio::test]
    async fn cancelling_a_variant_request_does_not_release_its_build_owner() {
        let _turn = SHARED_BUILDER.lock().await;
        let dir = temp_dir();
        let detail =
            Detail::of("/3/tv/1399", Some("append_to_response=credits,external_ids"), Some(&dir)).unwrap();
        let source_path = detail.whole().1;
        let cast: Vec<_> = (0..9000)
            .map(|id| serde_json::json!({"id":id,"name":format!("actor-{id}"),"character":"x".repeat(260)}))
            .collect();
        let mut record = serde_json::json!({"id":1399,"status":"Ended","credits":{"cast":cast}});
        for append in TV_APPENDS {
            if append != "credits" {
                record[append] = serde_json::json!({"results":[]});
            }
        }
        let body = Bytes::from(serde_json::to_vec(&record).unwrap());
        assert!(body.len() < MAX_ANSWER_BYTES);
        crate::cache::write_json(&source_path, &body).await;
        let source = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap();
        let digest = source.digest();
        let variant = detail.variant(&source_path, &digest, DETAILS_TTL);

        let held = Arc::clone(detail_builds()).acquire_owned().await.unwrap();
        let owner_started = watch_variant_owner(&source_path);
        let build = tokio::spawn(async move { detail.prepared_variant(&source_path, source).await });
        drop(held);
        tokio::time::timeout(Duration::from_secs(2), owner_started)
            .await
            .expect("the owner task never took its build permit")
            .expect("the owner task dropped its start signal");
        build.abort();
        for _ in 0..200 {
            if variant.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(variant.exists(), "the requester owned and cancelled parse/publication");
        let permit =
            tokio::time::timeout(Duration::from_secs(2), Arc::clone(detail_builds()).acquire_owned())
                .await
                .expect("the build owner retained its permit forever")
                .unwrap();
        drop(permit);
    }

    #[tokio::test]
    async fn cancelled_variant_waiters_never_become_detached_builds() {
        let _turn = SHARED_BUILDER.lock().await;
        let dir = temp_dir();
        let detail =
            Arc::new(Detail::of("/3/movie/550", Some("append_to_response=credits"), Some(&dir)).unwrap());
        let source_path = detail.whole().1;
        let body = Bytes::from_static(
            br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"x","credits":{},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
        );
        assert!(crate::cache::write_json(&source_path, &body).await);
        let digest = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap().digest();
        let variant = detail.variant(&source_path, &digest, DETAILS_TTL);
        let held = Arc::clone(detail_builds()).acquire_owned().await.unwrap();

        let mut waiters = Vec::new();
        for _ in 0..64 {
            let detail = Arc::clone(&detail);
            let path = source_path.clone();
            let source = crate::cache::open_json(&path, MAX_ANSWER_BYTES).await.unwrap();
            waiters.push(tokio::spawn(async move { detail.prepared_variant(&path, source).await }));
        }
        tokio::task::yield_now().await;
        for waiter in &waiters {
            waiter.abort();
        }
        for waiter in waiters {
            let _ = waiter.await;
        }
        drop(held);

        let permit =
            tokio::time::timeout(Duration::from_secs(2), Arc::clone(detail_builds()).acquire_owned())
                .await
                .expect("cancelled waiters left detached owners queued")
                .unwrap();
        assert!(!variant.exists(), "a cancelled waiter published after its request ended");
        drop(permit);
    }

    #[tokio::test]
    async fn arbitrary_append_subset_churn_does_not_create_derived_files() {
        let dir = temp_dir();
        let whole = Detail::of("/3/movie/550", None, Some(&dir)).unwrap();
        let source_path = whole.whole().1;
        let body = Bytes::from_static(
            br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"x","credits":{},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
        );
        crate::cache::write_json(&source_path, &body).await;
        for query in [
            "append_to_response=credits,videos",
            "append_to_response=external_ids,videos",
            "append_to_response=credits,external_ids,videos",
            "append_to_response=recommendations,release_dates",
        ] {
            let detail = Detail::of("/3/movie/550", Some(query), Some(&dir)).unwrap();
            assert!(!detail.durable_variant(), "the test accidentally named a checked-in client shape");
            let source = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap();
            assert!(detail.prepared_variant(&source_path, source).await.is_some());
        }
        let derived = std::fs::read_dir(variants_dir(&source_path))
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmdb.json"))
            .count();
        assert_eq!(derived, 0, "public subset churn amplified the durable cache");
    }

    #[tokio::test]
    async fn checked_in_appends_with_arbitrary_rest_do_not_create_derived_files() {
        let dir = temp_dir();
        let body = Bytes::from_static(
            br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"x","credits":{},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
        );
        for n in 0..32 {
            let query = format!("append_to_response=credits&language=x-private-{n}");
            let detail = Detail::of("/3/movie/550", Some(&query), Some(&dir)).unwrap();
            assert!(!detail.durable_variant(), "an arbitrary complete query was called a checked-in shape");
            let source_path = detail.whole().1;
            crate::cache::write_json(&source_path, &body).await;
            let source = crate::cache::open_json(&source_path, MAX_ANSWER_BYTES).await.unwrap();
            let (prepared, _) = detail.prepared_variant(&source_path, source).await.unwrap();
            assert!(matches!(prepared, Prepared::Bytes(_)));
            drop(prepared);
        }
        assert!(
            !dir.join(".tmdb-prepared").exists(),
            "arbitrary rest parameters amplified the durable cache"
        );
    }

    #[tokio::test]
    async fn a_304_renews_and_returns_only_the_generation_whose_tag_was_sent() {
        let cache = temp_dir();
        let file = Detail::of("/3/movie/550", None, Some(&cache)).unwrap().whole().1;
        let old = Bytes::from_static(
            br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"old","credits":{},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
        );
        keep(&file, &old, Some("W/\"old\"")).await;
        aged(&file, DETAILS_TTL + Duration::from_secs(60));

        let replacement = file.with_extension("replacement");
        let current = file.clone();
        crate::lock(&UPSTREAMS).push((
            "304-generation-race".to_owned(),
            Arc::new(move |_: &str| {
                std::fs::write(
                    &replacement,
                    br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"new","credits":{},"external_ids":{},"recommendations":{},"release_dates":{},"videos":{},"watch/providers":{}}"#,
                )
                .unwrap();
                std::fs::rename(&replacement, &current).unwrap();
                Ok(Fetched::Unchanged)
            }) as Upstream,
        ));
        let kept_in = cache.clone();
        let h = Harness::in_dir_with(temp_dir(), move |state| {
            state.tmdb_key = Some("304-generation-race".into());
            state.tmdb_cache_dir = Some(kept_in);
        });

        let response = h.send("GET", "/tmdb/3/movie/550", None, &[]).await;
        assert_eq!(response.headers()["x-den-tmdb"], "revalidated");
        assert_eq!(body_json(response).await["title"], "old", "304 returned bytes from another generation");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&file).unwrap()).unwrap()["title"],
            "new"
        );
    }

    #[tokio::test]
    async fn an_exact_tmdb_hit_streams_and_validates_from_fixed_metadata() {
        let cache = temp_dir();
        let h = lending_as(&cache, "exact-stream");
        let file = cache_path(&cache, &cache_key("/3/trending/all/week", None));
        let body = Bytes::from(vec![b'x'; 2 * NARROW_INLINE_BYTES + 17]);
        keep(&file, &body, None).await;

        let first = h.send("GET", "/tmdb/3/trending/all/week", None, &[]).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.headers()["x-den-tmdb"], "hit");
        assert_eq!(first.headers()[header::CONTENT_LENGTH], body.len().to_string());
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
        assert_eq!(first.into_body().collect().await.unwrap().to_bytes(), body);

        let repeated = h.send("HEAD", "/tmdb/3/trending/all/week", None, &[("if-none-match", &etag)]).await;
        assert_eq!(repeated.status(), StatusCode::NOT_MODIFIED);
        assert!(repeated.into_body().collect().await.unwrap().to_bytes().is_empty());
    }

    /// Manual release-mode probe for the expensive real-world shape this cache is meant to remove. Ignored in CI:
    /// run with `cargo test --release tmdb_detail_variant_benchmark -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn tmdb_detail_variant_benchmark() {
        let dir = temp_dir();
        let detail =
            Detail::of("/3/tv/1399", Some("append_to_response=credits,external_ids"), Some(&dir)).unwrap();
        let source = detail.whole().1;
        let cast: Vec<_> = (0..6000)
            .map(|id| serde_json::json!({"id":id,"name":format!("actor-{id}"),"character":"x".repeat(240)}))
            .collect();
        let mut record = serde_json::json!({"id":1399,"status":"Ended","credits":{"cast":cast}});
        for append in TV_APPENDS {
            if append != "credits" {
                record[append] = serde_json::json!({"results":[]});
            }
        }
        let body = Bytes::from(serde_json::to_vec(&record).unwrap());
        assert!(body.len() > 1024 * 1024 && body.len() < MAX_ANSWER_BYTES, "{} bytes", body.len());
        crate::cache::write_json(&source, &body).await;

        let old_started = std::time::Instant::now();
        for _ in 0..10 {
            std::hint::black_box(detail.narrowed(body.clone()).await);
        }
        let old = old_started.elapsed() / 10;

        let first_started = std::time::Instant::now();
        let canonical = crate::cache::open_json(&source, MAX_ANSWER_BYTES).await.unwrap();
        std::hint::black_box(detail.prepared_variant(&source, canonical).await.unwrap());
        let first = first_started.elapsed();

        let repeat_started = std::time::Instant::now();
        for _ in 0..1000 {
            let canonical = crate::cache::open_json(&source, MAX_ANSWER_BYTES).await.unwrap();
            std::hint::black_box(detail.prepared_variant(&source, canonical).await.unwrap());
        }
        let repeat = repeat_started.elapsed() / 1000;
        eprintln!(
            "{} bytes: prior reparse {old:?}; first prepared {first:?}; repeat metadata hit {repeat:?}",
            body.len()
        );
    }

    /// The cache on the box is not started over: an answer kept under the question a client asked before the whole
    /// detail existed answers that question, and any narrower one, with no call to TMDB — and keeps the age it was
    /// kept with.
    #[tokio::test]
    async fn a_title_kept_before_the_upgrade_is_a_hit_without_asking() {
        let cache = temp_dir();
        let h = lending_as(&cache, "kept-before");
        let asked = tmdb_answering("kept-before", "Ended");
        let kept =
            cache_path(&cache, &cache_key("/3/movie/550", Some(&format!("append_to_response={WEB_MOVIE}"))));
        let body = serde_json::json!({
            "id": 550, "title": "Fight Club", "status": "Released", "release_date": "1999-10-15", "credits": {}, "videos": {}
        });
        write(&kept, &Bytes::from(body.to_string())).await;
        aged(&kept, Duration::from_secs(30 * 86_400));

        // Asked for without what moves (`MOVING`), which keeps the months of the title itself.
        let resp =
            h.send("GET", "/tmdb/3/movie/550?append_to_response=credits%2Crelease_dates", None, &[]).await;
        assert_eq!(resp.headers()["x-den-tmdb"], "hit");
        let policy = resp.headers()[header::CACHE_CONTROL].to_str().unwrap().to_owned();
        let left = (DETAILS_TTL - Duration::from_secs(30 * 86_400)).as_secs();
        let max_age: u64 = policy.trim_start_matches("public, max-age=").parse().unwrap();
        assert!(max_age <= left && max_age + 5 > left, "what is left of its own six months: {policy}");
        let (how, bare) = detail(&h, "/tmdb/3/movie/550").await;
        assert_eq!(how, "hit");
        assert_eq!(
            bare,
            serde_json::json!({ "id": 550, "title": "Fight Club", "status": "Released", "release_date": "1999-10-15" })
        );
        assert!(ask(&h.state, "/3/movie/550", None).await.is_some());
        assert!(crate::lock(&asked).is_empty(), "nothing was asked of TMDB");
    }

    /// A detail answer carrying where a title streams was kept, and served, for the six months of the title itself:
    /// the page named services a film had left months before. What moves makes the answer a list; the title's own
    /// record, from the same kept detail, keeps its months.
    #[tokio::test]
    async fn where_to_watch_is_kept_for_hours_and_the_title_for_months() {
        let cache = temp_dir();
        let h = lending_as(&cache, "moving");
        let asked = tmdb_answering("moving", "Ended");
        assert_eq!(detail(&h, "/tmdb/3/movie/550").await.0, "miss");
        let whole = Detail::of("/3/movie/550", None, Some(&cache)).unwrap().whole().1;
        aged(&whole, LIST_TTL + Duration::from_secs(60));

        assert_eq!(detail(&h, "/tmdb/3/movie/550?append_to_response=credits").await.0, "hit");
        let web = format!("/tmdb/3/movie/550?append_to_response={WEB_MOVIE}");
        let resp = h.send("GET", &web, None, &[]).await;
        assert_eq!(resp.headers()["x-den-tmdb"], "stale", "shown at once, and asked again behind it");
        for _ in 0..200 {
            if crate::lock(&h.state.tmdb_refreshing).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(crate::lock(&asked).len(), 2);
        let resp = h.send("GET", &web, None, &[]).await;
        assert_eq!(resp.headers()["x-den-tmdb"], "hit");
        let policy = resp.headers()[header::CACHE_CONTROL].to_str().unwrap().to_owned();
        assert!(policy.contains("stale-while-revalidate"), "a list's policy: {policy}");

        for append in MOVING {
            let query = format!("append_to_response=credits,{append}");
            assert_eq!(
                fresh_for_answer("/3/tv/1396", Some(&query), br#"{"status":"Ended"}"#),
                LIST_TTL,
                "{append}"
            );
        }
        assert_eq!(fresh_for("/3/movie/550/videos"), LIST_TTL);
    }

    /// A large record is cut on the blocking pool to the same answer as a small one is cut in place, and a question
    /// for everything the whole detail holds is served its bytes as kept.
    #[tokio::test]
    async fn a_record_is_cut_to_the_question_wherever_it_is_cut() {
        let dir = temp_dir();
        let cast: Vec<_> =
            (0..4000).map(|i| serde_json::json!({ "id": i, "name": format!("Actor {i}") })).collect();
        let whole =
            serde_json::json!({ "id": 1, "status": "Ended", "credits": { "cast": cast }, "videos": {} });
        let whole = Bytes::from(whole.to_string());
        assert!(whole.len() > NARROW_INLINE_BYTES);
        let bare = Detail::of("/3/tv/1", None, Some(&dir)).unwrap();
        let cut: serde_json::Value = serde_json::from_slice(&bare.narrowed(whole.clone()).await).unwrap();
        assert_eq!(cut, serde_json::json!({ "id": 1, "status": "Ended" }));
        let everything =
            Detail::of("/3/tv/1", Some(&format!("append_to_response={}", TV_APPENDS.join(","))), Some(&dir));
        assert_eq!(everything.unwrap().narrowed(whole.clone()).await, whole, "not parsed at all");
    }

    /// A cold title asked for by several callers at once was asked of TMDB once per caller.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn callers_asking_for_one_cold_title_at_once_ask_tmdb_once() {
        let cache = temp_dir();
        let h = Arc::new(lending_as(&cache, "at-once"));
        let asked = tmdb_answering("at-once-inner", "Ended");
        let inner = stand_in("at-once-inner").unwrap();
        // TMDB taking a moment, as it does, so every caller finds the cache cold.
        let slow: Upstream = Arc::new(move |url: &str| {
            std::thread::sleep(Duration::from_millis(100));
            inner(url)
        });
        crate::lock(&UPSTREAMS).push(("at-once".to_owned(), slow));
        let callers: Vec<_> = ["", "?append_to_response=credits", "?append_to_response=videos", ""]
            .into_iter()
            .map(|q| {
                let h = Arc::clone(&h);
                tokio::spawn(async move {
                    h.send("GET", &format!("/tmdb/3/movie/550{q}"), None, &[]).await.status()
                })
            })
            .collect();
        for caller in callers {
            assert_eq!(caller.await.unwrap(), StatusCode::OK);
        }
        let _ = ask(&h.state, "/3/movie/550", None).await.unwrap();
        let asked = crate::lock(&asked).clone();
        assert_eq!(asked.len(), 1, "{asked:?}");
        const IP: &str = "192.168.1.9";
        for _ in 1..GUEST_PER_WINDOW {
            assert!(
                crate::link::throttled_per_minute(&h.state, &format!("tmdb:{IP}"), GUEST_PER_WINDOW)
                    .is_none(),
                "one detail upstream question consumed one visitor claim"
            );
        }
        assert!(
            crate::link::throttled_per_minute(&h.state, &format!("tmdb:{IP}"), GUEST_PER_WINDOW).is_some(),
            "coalesced detail waiters did not consume visitor claims"
        );
        assert!(
            crate::lock(&ASKING).keys().all(|file| !file.starts_with(&cache)),
            "nothing is left in flight"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn callers_asking_for_one_cold_list_at_once_ask_tmdb_once() {
        let cache = temp_dir();
        let h = Arc::new(lending_as(&cache, "list-at-once"));
        let asked = Arc::new(std::sync::Mutex::new(0));
        let seen = Arc::clone(&asked);
        let slow: Upstream = Arc::new(move |_| {
            *crate::lock(&seen) += 1;
            std::thread::sleep(Duration::from_millis(100));
            Ok(Fetched::Answer(Bytes::from_static(b"{\"page\":1,\"results\":[]}"), None))
        });
        crate::lock(&UPSTREAMS).push(("list-at-once".to_owned(), slow));

        let callers: Vec<_> = (0..4)
            .map(|_| {
                let h = Arc::clone(&h);
                tokio::spawn(async move { h.send("GET", "/tmdb/3/trending/all/week", None, &[]).await })
            })
            .collect();
        for caller in callers {
            let response = caller.await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(body_json(response).await["page"], 1);
        }
        assert_eq!(*crate::lock(&asked), 1, "the non-detail cold miss was coalesced");
        const IP: &str = "192.168.1.9";
        for allowed in 1..GUEST_PER_WINDOW {
            assert!(
                crate::link::throttled_per_minute(&h.state, &format!("tmdb:{IP}"), GUEST_PER_WINDOW)
                    .is_none(),
                "the one upstream question plus {allowed} later claims fit"
            );
        }
        assert!(
            crate::link::throttled_per_minute(&h.state, &format!("tmdb:{IP}"), GUEST_PER_WINDOW).is_some(),
            "the coalesced waiters did not each debit the visitor allowance"
        );
        assert!(
            crate::lock(&ASKING).keys().all(|file| !file.starts_with(&cache)),
            "nothing is left in flight"
        );
    }

    /// When the one asking failed, each caller behind it asked TMDB again in turn, so the k-th waited k timeouts. A
    /// caller that waited behind a failed ask is given its answer, a link preview's included.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn callers_behind_a_failed_ask_are_given_its_answer() {
        let cache = temp_dir();
        let h = Arc::new(lending_as(&cache, "failing-slowly"));
        let asked = Arc::new(std::sync::Mutex::new(0));
        let seen = Arc::clone(&asked);
        let slow: Upstream = Arc::new(move |_: &str| {
            *crate::lock(&seen) += 1;
            std::thread::sleep(Duration::from_millis(300));
            Err(refused(StatusCode::GATEWAY_TIMEOUT, "tmdb_timeout"))
        });
        crate::lock(&UPSTREAMS).push(("failing-slowly".to_owned(), slow));
        let started = std::time::Instant::now();
        let callers: Vec<_> = (0..3)
            .map(|_| {
                let h = Arc::clone(&h);
                tokio::spawn(async move { h.send("GET", "/tmdb/3/movie/551", None, &[]).await })
            })
            .collect();
        let preview = {
            let h = Arc::clone(&h);
            tokio::spawn(async move { ask(&h.state, "/3/movie/551", None).await })
        };
        for caller in callers {
            let resp = caller.await.unwrap();
            assert_eq!(resp.status(), StatusCode::GATEWAY_TIMEOUT);
            assert_eq!(body_json(resp).await["error"], "tmdb_timeout");
        }
        assert!(preview.await.unwrap().is_none());
        assert_eq!(*crate::lock(&asked), 1, "asked once");
        assert!(started.elapsed() < Duration::from_millis(550), "one ask's wait: {:?}", started.elapsed());

        // A caller arriving after the failure asks again.
        assert_eq!(h.send("GET", "/tmdb/3/movie/551", None, &[]).await.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(*crate::lock(&asked), 2);
    }

    /// A failed ask answers only for the callers that waited on it with the same key: a made-up key refused says
    /// nothing about the household's, and whoever comes after the failure asks again.
    #[tokio::test]
    async fn a_failed_ask_answers_only_for_its_own_key_and_its_own_waiters() {
        let file = cache_path(&temp_dir(), "/3/movie/552?");
        let mut holder = one_tmdb_asking(&file, "old-key").await.ok().unwrap();
        let waiter = |whose: &'static str| {
            let file = file.clone();
            tokio::spawn(async move { one_tmdb_asking(&file, whose).await.map(drop).map_err(|r| r.status()) })
        };
        let (same, other) = (waiter("old-key"), waiter("rotated-key"));
        tokio::task::yield_now().await;
        let _ = holder.failed(refused(StatusCode::UNAUTHORIZED, "key_refused")).await;
        drop(holder);
        assert_eq!(same.await.unwrap(), Err(StatusCode::UNAUTHORIZED));
        assert_eq!(other.await.unwrap(), Ok(()), "another key asks for itself");
        assert!(one_tmdb_asking(&file, "old-key").await.is_ok(), "a caller after the failure asks again");
    }

    /// A waiter dropped between the holder letting go and its own first look — a preview past its budget, a page
    /// closed — held the entry's last reference but no turn, so the holder saw one reference too many and the file
    /// stayed in `ASKING` for good.
    #[tokio::test]
    async fn a_waiter_that_stops_waiting_leaves_nothing_in_flight() {
        let file = cache_path(&temp_dir(), "/3/movie/550?");
        let holder = one_asking(&file, "tmdb").await;
        let waiter = {
            let file = file.clone();
            tokio::spawn(async move { drop(one_asking(&file, "tmdb").await) })
        };
        tokio::task::yield_now().await;
        // The turn passes to the waiter, which is stopped before it is run again.
        drop(holder);
        waiter.abort();
        let _ = waiter.await;
        assert!(!crate::lock(&ASKING).contains_key(&file), "nothing is left in flight");
    }

    /// A link preview gives up on TMDB after its budget, and the question used to be dropped with it after it was
    /// paid for, so a title TMDB was slow to answer cost a unit on every preview and was never kept.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_preview_that_stops_waiting_still_keeps_what_it_paid_for() {
        let cache = temp_dir();
        let h = lending_as(&cache, "slow-preview");
        let asked = tmdb_answering("slow-preview-inner", "Ended");
        let inner = stand_in("slow-preview-inner").unwrap();
        let slow: Upstream = Arc::new(move |url: &str| {
            std::thread::sleep(Duration::from_millis(600));
            inner(url)
        });
        crate::lock(&UPSTREAMS).push(("slow-preview".to_owned(), slow));
        let shell = b"<head><!--den:meta--><title>Den</title><!--/den:meta--></head>";
        let mut host = HeaderMap::new();
        host.insert(header::HOST, HeaderValue::from_static("d.oxy.fi"));

        let preview = crate::meta::rewrite(&h.state, shell, "/movie/550", None, &host).await;
        assert!(preview.is_none(), "the page went out with the generic block");
        tokio::time::sleep(Duration::from_millis(900)).await;
        let preview = crate::meta::rewrite(&h.state, shell, "/movie/550", None, &host).await;
        assert!(preview.expect("kept, so a hit").contains("<title>T (1999) · Den</title>"));
        assert_eq!(crate::lock(&asked).len(), 1, "paid for once");
    }

    /// Every app-shell request for a title builds a preview, with no limit of its own, so a crawl of ids spent the
    /// household's budget without end. A kept title costs nothing and is still described.
    #[tokio::test]
    async fn previews_ask_tmdb_only_so_often() {
        let h = lending_as(&temp_dir(), "previews");
        let asked = tmdb_answering("previews", "Ended");
        for id in 1..=PREVIEWS_PER_MINUTE {
            assert!(ask(&h.state, &format!("/3/movie/{id}"), None).await.is_some(), "{id}");
        }
        assert!(ask(&h.state, "/3/movie/9999", None).await.is_none(), "past the minute's questions");
        assert!(ask(&h.state, "/3/person/9999", None).await.is_none());
        assert_eq!(crate::lock(&asked).len(), PREVIEWS_PER_MINUTE as usize);
        assert!(ask(&h.state, "/3/movie/1", None).await.is_some(), "a kept title is still described");
        h.advance(60_001);
        assert!(ask(&h.state, "/3/movie/9999", None).await.is_some(), "and the next minute asks again");
    }

    /// A title kept past its freshness was thrown away once the minute's preview questions were spent, or TMDB
    /// failed, and the page went out with the generic block. What is kept is still the better preview.
    #[tokio::test]
    async fn a_preview_past_the_minutes_questions_or_a_failing_tmdb_is_what_is_kept() {
        let cache = temp_dir();
        let h = lending_as(&cache, "stale-preview");
        let refusing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let asked = Arc::new(std::sync::Mutex::new(0));
        let (seen, refuses) = (Arc::clone(&asked), Arc::clone(&refusing));
        let tmdb: Upstream = Arc::new(move |_: &str| {
            *crate::lock(&seen) += 1;
            if refuses.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_refused"));
            }
            let body = serde_json::json!({ "id": 1399, "name": "New", "status": "Returning Series" });
            Ok(Fetched::Answer(Bytes::from(body.to_string()), None))
        });
        crate::lock(&UPSTREAMS).push(("stale-preview".to_owned(), tmdb));
        let whole = Detail::of("/3/tv/1399", None, Some(&cache)).unwrap().whole().1;
        let kept = serde_json::json!({ "id": 1399, "name": "Kept", "status": "Returning Series" });
        write(&whole, &Bytes::from(kept.to_string())).await;
        aged(&whole, LIST_TTL + Duration::from_secs(60));

        for _ in 0..PREVIEWS_PER_MINUTE {
            assert!(preview_allowed(&h.state).is_some());
        }
        let preview = ask(&h.state, "/3/tv/1399", None).await;
        assert_eq!(preview.expect("the kept one")["name"], "Kept", "past the minute's questions");
        assert_eq!(*crate::lock(&asked), 0);

        h.advance(60_001);
        refusing.store(true, std::sync::atomic::Ordering::SeqCst);
        let preview = ask(&h.state, "/3/tv/1399", None).await;
        assert_eq!(preview.expect("the kept one")["name"], "Kept", "TMDB refusing");
        assert_eq!(*crate::lock(&asked), 1);
    }

    /// A write its caller stopped waiting for — a preview past its budget — left its temporary file behind.
    #[tokio::test]
    async fn a_write_nobody_waits_for_still_finishes_and_leaves_nothing_behind() {
        let dir = temp_dir();
        let file = cache_path(&dir, "/3/tv/1399?");
        let body = Bytes::from(vec![b'x'; 64 * 1024 * 1024]);
        let writing = {
            let (file, body) = (file.clone(), body.clone());
            tokio::spawn(async move { write(&file, &body).await })
        };
        let temp = || {
            std::fs::read_dir(&dir)
                .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().ends_with(".tmp")))
                .unwrap_or(false)
        };
        for _ in 0..5000 {
            if temp() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        writing.abort();
        for _ in 0..500 {
            if file.exists() && !temp() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!temp(), "no temporary file is left behind");
        assert_eq!(
            std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0),
            body.len() as u64,
            "the write finished"
        );
    }

    /// A kept answer holding less than was asked is no answer to it: the whole detail is fetched. And a sub-request
    /// the whole detail does not carry is asked for as it always was.
    #[tokio::test]
    async fn a_question_for_more_than_a_kept_answer_holds_is_not_served_from_it() {
        let cache = temp_dir();
        let h = lending_as(&cache, "narrower");
        let asked = tmdb_answering("narrower", "Ended");
        let kept = cache_path(&cache, &cache_key("/3/movie/603", Some("append_to_response=credits")));
        write(&kept, &Bytes::from_static(br#"{"id":603,"title":"The Matrix","credits":{}}"#)).await;

        assert_eq!(detail(&h, "/tmdb/3/movie/603?append_to_response=credits").await.0, "hit");
        assert_eq!(detail(&h, "/tmdb/3/movie/603").await.0, "hit");
        assert!(crate::lock(&asked).is_empty());
        let (how, more) = detail(&h, "/tmdb/3/movie/603?append_to_response=credits,videos").await;
        assert_eq!(how, "miss");
        assert!(more.get("videos").is_some() && more.get("recommendations").is_none(), "{more}");
        assert_eq!(crate::lock(&asked).len(), 1);

        assert_eq!(detail(&h, "/tmdb/3/movie/603?append_to_response=keywords").await.0, "miss");
        assert_eq!(crate::lock(&asked)[1], "/3/movie/603?append_to_response=keywords&");
    }

    /// A series that is not over keeps its hours, whichever client's question finds it: shown at once, and the
    /// whole detail asked again behind it. A finished one keeps its months.
    #[tokio::test]
    async fn an_airing_series_is_asked_again_on_its_shorter_rule() {
        let cache = temp_dir();
        let h = lending_as(&cache, "airing");
        let asked = tmdb_answering("airing", "Returning Series");
        assert_eq!(detail(&h, "/tmdb/3/tv/1399").await.0, "miss");
        let whole = Detail::of("/3/tv/1399", None, Some(&cache)).unwrap().whole().1;
        aged(&whole, LIST_TTL + Duration::from_secs(60));

        assert_eq!(detail(&h, "/tmdb/3/tv/1399?append_to_response=credits").await.0, "stale");
        for _ in 0..200 {
            if crate::lock(&h.state.tmdb_refreshing).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(crate::lock(&asked).len(), 2, "asked again behind the stale answer");
        assert_eq!(detail(&h, "/tmdb/3/tv/1399?append_to_response=credits").await.0, "hit");

        let ended = cache_path(&cache, &cache_key("/3/tv/1396", None));
        write(&ended, &Bytes::from_static(br#"{"id":1396,"name":"Breaking Bad","status":"Ended"}"#)).await;
        aged(&ended, LIST_TTL + Duration::from_secs(60));
        assert_eq!(detail(&h, "/tmdb/3/tv/1396").await.0, "hit");
        assert_eq!(crate::lock(&asked).len(), 2);
    }

    /// What a browser used to `PUT` after each TMDB answer is kept here as the answer is fetched: a miss is
    /// recorded with no client asking, a hit is not recorded again, and an answer about no title records nothing.
    #[tokio::test]
    async fn a_fetched_answer_is_kept_as_title_metadata_and_a_hit_is_not_observed_again() {
        let (cache, metadata) = (temp_dir(), temp_dir());
        let (kept_in, meta) = (cache.clone(), metadata.clone());
        let h = Harness::in_dir_with(temp_dir(), move |state| {
            state.tmdb_key = Some("observed".into());
            state.tmdb_cache_dir = Some(kept_in);
            state.title_metadata_cache_dir = Some(meta);
        });
        let asked = tmdb_answering("observed", "Ended");
        let recorded = || async {
            for _ in 0..200 {
                let response = h
                    .send(
                        "POST",
                        "/metadata/title/query",
                        Some(serde_json::json!({"titles":[{"type":"movie","id":550}]}).to_string()),
                        &[],
                    )
                    .await;
                let body = crate::handler::tests::body_json(response).await;
                if body["entries"].as_array().is_some_and(|entries| !entries.is_empty()) {
                    return Some(body);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            None
        };

        assert_eq!(detail(&h, "/tmdb/3/movie/550?append_to_response=credits").await.0, "miss");
        let kept = recorded().await.expect("the miss was recorded");
        assert_eq!(kept["entries"][0]["fields"]["rating"]["value"], 7.5);
        let observed_at = kept["entries"][0]["fields"]["rating"]["observedAt"].clone();

        assert_eq!(detail(&h, "/tmdb/3/movie/550").await.0, "hit");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let kept = recorded().await.expect("the original observation remains");
        assert_eq!(
            kept["entries"][0]["fields"]["rating"]["observedAt"], observed_at,
            "a hit is not recorded again"
        );

        // A season's own id and rating are not a title's.
        h.send("GET", "/tmdb/3/tv/1399/season/1", None, &[]).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let season = h
            .send(
                "POST",
                "/metadata/title/query",
                Some(serde_json::json!({"titles":[{"type":"tv","id":3624}]}).to_string()),
                &[],
            )
            .await;
        assert_eq!(crate::handler::tests::body_json(season).await, serde_json::json!({"entries":[]}));
        assert_eq!(crate::lock(&asked).len(), 2);
    }

    /// A title seen only through a kept detail would otherwise age out of the shared metadata after its 180 days:
    /// TMDB confirming the kept answer (a 304) records it again.
    #[tokio::test]
    async fn a_confirmed_answer_is_recorded_again() {
        let (cache, metadata) = (temp_dir(), temp_dir());
        let (kept_in, meta) = (cache.clone(), metadata.clone());
        let h = Harness::in_dir_with(temp_dir(), move |state| {
            state.tmdb_key = Some("confirmed".into());
            state.tmdb_cache_dir = Some(kept_in);
            state.title_metadata_cache_dir = Some(meta);
        });
        crate::lock(&UPSTREAMS)
            .push(("confirmed".to_owned(), Arc::new(|_: &str| Ok(Fetched::Unchanged)) as Upstream));
        let whole = Detail::of("/3/movie/550", None, Some(&cache)).unwrap().whole().1;
        keep(
            &whole,
            &Bytes::from_static(br#"{"id":550,"status":"Released","release_date":"1999-10-15","title":"Fight Club","vote_average":8.4}"#),
            Some("W/\"a\""),
        )
        .await;
        aged(&whole, DETAILS_TTL + Duration::from_secs(60));

        assert_eq!(detail(&h, "/tmdb/3/movie/550").await.0, "revalidated");
        for _ in 0..200 {
            let response = h
                .send(
                    "POST",
                    "/metadata/title/query",
                    Some(serde_json::json!({"titles":[{"type":"movie","id":550}]}).to_string()),
                    &[],
                )
                .await;
            let body = crate::handler::tests::body_json(response).await;
            if body["entries"].as_array().is_some_and(|entries| !entries.is_empty()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the confirmed answer was recorded");
    }

    #[tokio::test]
    async fn a_library_member_can_name_titles_past_the_visitor_allowance() {
        const LIB: &str = "0123456789abcdef";
        const TOKEN: &str = "the-library-token";
        const IP: &str = "192.168.1.9";

        let h = lending(&temp_dir(), None);
        let body = serde_json::json!({
            "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }]
        })
        .to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK);

        for _ in 0..GUEST_PER_WINDOW {
            assert!(crate::link::throttled_per_minute(&h.state, &format!("tmdb:{IP}"), GUEST_PER_WINDOW)
                .is_none());
        }

        let forged = format!("{LIB}:wrong");
        let refused =
            h.send("GET", "/tmdb/3/movie/550", None, &[(crate::library::MEMBER_HEADER, &forged)]).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(refused.headers().contains_key(header::RETRY_AFTER));

        let member = format!("{LIB}:{TOKEN}");
        let admitted =
            h.send("GET", "/tmdb/3/movie/550", None, &[(crate::library::MEMBER_HEADER, &member)]).await;
        assert_ne!(admitted.status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
