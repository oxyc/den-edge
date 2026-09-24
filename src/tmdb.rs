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
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub type TmdbClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>;

/// https only, and the roots compiled in — no OS trust store to depend on in a `scratch` image.
///
/// HTTP/2 where the server offers it (ALPN), HTTP/1.1 where it does not. A page asks for a burst of titles at
/// once, and over HTTP/1.1 each question the pool has no idle connection for opens one of its own — a TCP and
/// TLS handshake apiece before TMDB is asked anything. Over HTTP/2 the burst shares one connection. The same
/// client asks OMDb (`ratings.rs`), doesthedogdie (`warnings.rs`) and SkipDB (`skipdb.rs`); none of them sets
/// a header HTTP/2 forbids, and a server that offers only HTTP/1.1 is still asked over it.
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
    // An idle connection is kept a while so the next page's questions skip the handshake; a server that closes
    // it first says so (GOAWAY), and the next question opens another.
    Client::builder(TokioExecutor::new()).pool_idle_timeout(Duration::from_secs(90)).build(https)
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

/// How long an answer stays fresh once TMDB has said what it is.
///
/// One record here is not a settled fact: a series that is not over. Its next episode, its latest air date and
/// its season list all still move, and the app reads a series' shape to decide which episode comes next — so
/// kept for six months like a finished title's details, Den goes on believing the season ended months ago and
/// withholds an episode that aired on Friday. An unfinished series is a list, not a record.
fn fresh_for_answer(path: &str, body: &[u8]) -> Duration {
    let fresh = fresh_for(path);
    if fresh == DETAILS_TTL && unfinished(path, body) {
        LIST_TTL
    } else {
        fresh
    }
}

/// Does this body describe a series that can still change?
///
/// The status decides it, not the next episode: a series BETWEEN seasons has `next_episode_to_air: null` and is
/// not finished, and the day its next season is announced is precisely the day this has to notice. Only "Ended"
/// and "Canceled" are over; returning, in production and planned are not. A body whose status cannot be read is
/// treated as unfinished, because an answer we don't recognise is no evidence that a series is done.
///
/// Matched on the text rather than parsed: the alternative is parsing a whole answer on every read to learn one
/// thing about it.
fn unfinished(path: &str, body: &[u8]) -> bool {
    if !(path.starts_with("/3/tv/") && is_entity(path)) {
        return false;
    }
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    let over = text.split_once("\"status\":").is_some_and(|(_, rest)| {
        let rest = rest.trim_start();
        rest.starts_with("\"Ended\"") || rest.starts_with("\"Canceled\"")
    });
    !over
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
    let escaped = |text: &str| text.replace('%', "%25").replace('&', "%26").replace('=', "%3D");
    let rest: String = params.iter().map(|(n, v)| format!("{}={}&", escaped(n), escaped(v))).collect();
    format!("{path}?{rest}")
}

/// Where that key lives on disk. The name is a digest, so a key can hold anything and the file name stays one
/// flat, safe token.
fn cache_path(dir: &Path, key: &str) -> PathBuf {
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

/// What the cache holds for a detail question.
enum Kept {
    /// Fresh, with how long it is fresh for, its age and when it was kept.
    Hit(Bytes, Duration, Duration, SystemTime),
    /// A remembered 404, still believed.
    Absent,
    /// Past its freshness but inside the six months, with when it was kept and how long it was fresh for.
    Stale(Bytes, SystemTime, Duration),
    Nothing,
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

    /// An answer holding more than was asked, cut to what was: a record for a library's poster should not carry a
    /// series' every guest actor. What it keeps is TMDB's own, so the narrower question gets the answer it would have.
    fn narrowed(&self, body: Bytes) -> Bytes {
        let Ok(serde_json::Value::Object(mut record)) = serde_json::from_slice(&body) else { return body };
        for append in self.all {
            if !self.asked.contains(*append) {
                record.remove(*append);
            }
        }
        serde_json::to_vec(&record).map_or(body, Bytes::from)
    }

    /// The freshest kept answer to this question, from any entry that holds it; else the first one past its
    /// freshness. Each is judged by its own age and what it says — an airing series stays fresh for hours.
    async fn kept(&self) -> Kept {
        let mut stale = Kept::Nothing;
        for (file, exact) in self.candidates() {
            let Some((body, age, modified)) = read(&file).await else { continue };
            if body == ABSENT {
                if age < ABSENT_TTL {
                    return Kept::Absent;
                }
                continue;
            }
            let fresh = fresh_for_answer(&self.path, &body);
            let body = if exact { body } else { self.narrowed(body) };
            if age < fresh {
                return Kept::Hit(body, fresh, age, modified);
            }
            if matches!(stale, Kept::Nothing) && age < RETENTION {
                stale = Kept::Stale(body, modified, fresh);
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
            return Ok((body.clone(), how, fresh_for_answer(&self.path, &body)));
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
                return Ok((body.clone(), how, fresh_for_answer(&self.path, &body)));
            }
        };
        let fresh = fresh_for_answer(&self.path, &body);
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
        fetch(state, path, query, key, rid).await.map(|(body, etag)| Fetched::Answer(body, etag))
    };
    match fetched {
        Ok(Fetched::Answer(body, etag)) => {
            keep(file, &body, etag.as_deref()).await;
            Ok((body, "miss"))
        }
        Ok(Fetched::Unchanged) => {
            renew(file).await;
            let Some((body, _, _)) = read(file).await else {
                return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_answer_unreadable"));
            };
            Ok((body, "revalidated"))
        }
        Err(response) => {
            if response.status() == StatusCode::NOT_FOUND {
                keep(file, &Bytes::from_static(ABSENT), None).await;
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
    if let Some(detail) = Detail::of(&path, query.as_deref(), state.tmdb_cache_dir.as_deref()) {
        let ip = crate::handler::client_ip(state, &req);
        return detail_answer(state, &ip, asked, &detail, key, rid).await;
    }
    let cached = cache_key(&path, query.as_deref());
    let file = state.tmdb_cache_dir.as_ref().map(|dir| cache_path(dir, &cached));

    // A hit never leaves the box, so it is not counted against anybody's budget: what the limits exist to
    // bound is what this origin asks TMDB, not what it already knows.
    if let Some(file) = &file {
        if let Some((body, age, modified)) = read(file).await {
            // What TMDB said narrows what the path alone could say: an airing series is kept for hours, not months.
            let fresh = fresh_for_answer(&path, &body);
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
                    return match revalidate(state, &path, query.as_deref(), key, rid, file).await {
                        Ok(Fetched::Answer(new, etag)) => {
                            keep(file, &new, etag.as_deref()).await;
                            crate::title_metadata::observe_tmdb(state, &path, &new);
                            // The series may have ended since it was last asked for, which gives it its months back.
                            let fresh = fresh_for_answer(&path, &new);
                            answer(new, &fresh_policy(fresh, fresh), "miss", SystemTime::now(), asked)
                        }
                        Ok(Fetched::Unchanged) => {
                            renew(file).await;
                            crate::title_metadata::observe_tmdb(state, &path, &body);
                            answer(body, &fresh_policy(fresh, fresh), "revalidated", SystemTime::now(), asked)
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
    if let Some(refusal) = over_allowance(state, &ip, asked).await {
        return refusal;
    }
    match fetch(state, &path, query.as_deref(), key, rid).await {
        Ok((body, etag)) => {
            if let Some(file) = &file {
                keep(file, &body, etag.as_deref()).await;
            }
            crate::title_metadata::observe_tmdb(state, &path, &body);
            let fresh = fresh_for_answer(&path, &body);
            answer(body, &fresh_policy(fresh, fresh), "miss", SystemTime::now(), asked)
        }
        Err(response) => {
            if response.status() == StatusCode::NOT_FOUND {
                if let Some(file) = &file {
                    keep(file, &Bytes::from_static(ABSENT), None).await;
                }
            }
            *response
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
    let _asking = match detail.kept().await {
        Kept::Hit(body, fresh, age, modified) => {
            return answer(body, &fresh_policy(fresh, fresh.saturating_sub(age)), "hit", modified, asked)
        }
        Kept::Absent => return *refused(StatusCode::NOT_FOUND, "not_found"),
        Kept::Stale(body, modified, fresh) if fresh != DETAILS_TTL => {
            let (query, file) = if detail.oversize().await { detail.exact() } else { detail.whole() };
            let cached = cache_key(&detail.path, query.as_deref());
            refresh_behind(
                state,
                Refresh { cached, path: detail.path.clone(), query, key: key.to_owned(), file },
            );
            return answer(body, "public, max-age=60", "stale", modified, asked);
        }
        // A settled record past its six months is asked again now, as it always was, without the allowance.
        Kept::Stale(..) => None,
        Kept::Nothing => {
            if let Some(refusal) = over_allowance(state, ip, asked).await {
                return refusal;
            }
            let asking = one_asking(&detail.whole().1).await;
            // A question about this title that got here first has kept its answer by now.
            match detail.kept().await {
                Kept::Hit(body, fresh, age, modified) => {
                    return answer(
                        body,
                        &fresh_policy(fresh, fresh.saturating_sub(age)),
                        "hit",
                        modified,
                        asked,
                    )
                }
                Kept::Absent => return *refused(StatusCode::NOT_FOUND, "not_found"),
                Kept::Stale(..) | Kept::Nothing => Some(asking),
            }
        }
    };
    match detail.ask(state, key, rid).await {
        Ok((whole, how, fresh)) => {
            // A 304 counts too: TMDB confirmed what is kept, and the observation's age starts over with it.
            crate::title_metadata::observe_tmdb(state, &detail.path, &whole);
            answer(detail.narrowed(whole), &fresh_policy(fresh, fresh), how, SystemTime::now(), asked)
        }
        Err(response) => *response,
    }
}

/// Questions being asked of an upstream right now, by the file their answer will be kept at.
static ASKING: std::sync::Mutex<std::collections::BTreeMap<PathBuf, Arc<tokio::sync::Mutex<()>>>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// The one question for `file` in flight, held until it is dropped. A cold question used to be asked once per
/// caller: a page opening a title in several tabs, or a burst of devices naming the same library, asked TMDB (or
/// OMDb, or doesthedogdie) that many times and spent that many units of the day's budget. Whoever holds this asks;
/// whoever waits for it looks at what was kept first. Shared by `ratings.rs` and `warnings.rs`, whose answers are
/// kept in files too.
pub(crate) async fn one_asking(file: &Path) -> Asking {
    let turn = Arc::clone(crate::lock(&ASKING).entry(file.to_owned()).or_default());
    Asking { file: file.to_owned(), _held: turn.lock_owned().await }
}

pub(crate) struct Asking {
    file: PathBuf,
    _held: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for Asking {
    fn drop(&mut self) {
        // The last one out takes the entry with it: two references are the map's and this guard's own.
        let mut asking = crate::lock(&ASKING);
        if asking.get(&self.file).is_some_and(|turn| Arc::strong_count(turn) == 2) {
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
        let body = match detail.kept().await {
            Kept::Hit(body, ..) => body,
            Kept::Absent => return None,
            Kept::Stale(..) | Kept::Nothing => {
                let _asking = one_asking(&detail.whole().1).await;
                match detail.kept().await {
                    Kept::Hit(body, ..) => body,
                    Kept::Absent => return None,
                    Kept::Stale(..) | Kept::Nothing => {
                        detail.narrowed(detail.ask(state, key, "meta").await.ok()?.0)
                    }
                }
            }
        };
        return serde_json::from_slice(&body).ok();
    }
    let file = state.tmdb_cache_dir.as_ref().map(|dir| cache_path(dir, &cache_key(path, query)));
    let mut stale = None;
    if let Some(file) = &file {
        if let Some((body, age, _)) = read(file).await {
            // A remembered 404 answers as "no such thing" without spending anything.
            if body == ABSENT {
                if age < ABSENT_TTL {
                    return None;
                }
            } else if age < fresh_for_answer(path, &body) {
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
    let fetched = match (&file, &stale) {
        (Some(file), Some(_)) => revalidate(state, path, query, key, "meta", file).await,
        _ => fetch(state, path, query, key, "meta").await.map(|(body, etag)| Fetched::Answer(body, etag)),
    };
    match fetched {
        Ok(Fetched::Answer(body, etag)) => {
            if let Some(file) = &file {
                keep(file, &body, etag.as_deref()).await;
            }
            serde_json::from_slice(&body).ok()
        }
        Ok(Fetched::Unchanged) => {
            if let Some(file) = &file {
                renew(file).await;
            }
            stale.and_then(|body| serde_json::from_slice(&body).ok())
        }
        Err(answer) => {
            if answer.status() == StatusCode::NOT_FOUND {
                if let Some(file) = &file {
                    keep(file, &Bytes::from_static(ABSENT), None).await;
                }
            }
            None
        }
    }
}

/// What TMDB said to a question.
enum Fetched {
    /// An answer, with the ETag TMDB gave it.
    Answer(Bytes, Option<String>),
    /// A 304: the kept answer is still TMDB's.
    Unchanged,
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
) -> Result<Fetched, Box<Response>> {
    let etag = tokio::fs::read_to_string(file.with_extension("etag")).await.ok();
    send(state, path, query, key, rid, etag.as_deref().filter(|t| !t.is_empty())).await
}

async fn send(
    state: &AppState,
    path: &str,
    query: Option<&str>,
    key: &str,
    rid: &str,
    etag: Option<&str>,
) -> Result<Fetched, Box<Response>> {
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
    let (status, headers, bytes) = match exchange(client, out, MAX_ANSWER_BYTES, TIMEOUT, "tmdb").await {
        Ok(answer) => answer,
        Err(Failed::Unreachable) => return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_unreachable")),
        Err(Failed::Timeout) => return Err(refused(StatusCode::GATEWAY_TIMEOUT, "tmdb_timeout")),
        Err(Failed::TooLarge) => return Err(refused(StatusCode::BAD_GATEWAY, TOO_LARGE)),
        Err(Failed::Unreadable) => return Err(refused(StatusCode::BAD_GATEWAY, "tmdb_answer_unreadable")),
    };
    if status == StatusCode::NOT_MODIFIED && etag.is_some() {
        refund(state);
        return Ok(Fetched::Unchanged);
    }
    let tag = headers.get(header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_owned);
    if !status.is_success() {
        return Err(refusal(state, status, &headers));
    }
    Ok(Fetched::Answer(bytes, tag))
}

/// TMDB's own refusal, passed on as ours without its body: it may name the key.
///
/// Anything but a 404 is said in the log, once a minute per status: a revoked `TMDB_KEY` (401), TMDB rate-limiting
/// the household (429) or TMDB down (5xx) otherwise showed only as a 502 to whoever asked next. A 429 is passed on
/// as a wait, with TMDB's own `Retry-After`, rather than as a failure.
fn refusal(state: &AppState, status: StatusCode, headers: &HeaderMap) -> Box<Response> {
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
                "tmdb: daily budget of {max} spent — guest browsing and link previews answer 503 until UTC                  midnight. A cached answer still serves; only new questions stop."
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

/// Written beside and renamed over, so a reader never sees half an answer. Ordinary caches may ignore a
/// failure; endpoints that promise persistence can surface it.
///
/// The temporary file is this write's own. With one shared name, two writes of the same key at once — two cold
/// questions for one title, now that a title's questions share one key — wrote into the same file, and the rename
/// could put a mix of both in place, to be served as a hit for months.
pub(crate) async fn write(file: &Path, body: &Bytes) -> bool {
    let Some(dir) = file.parent() else { return false };
    if tokio::fs::create_dir_all(dir).await.is_err() {
        return false;
    }
    let temp = file.with_extension(format!("{}.tmp", crate::hex(&crate::random_bytes::<8>())));
    if tokio::fs::write(&temp, body).await.is_ok() && tokio::fs::rename(&temp, file).await.is_ok() {
        return true;
    }
    let _ = tokio::fs::remove_file(&temp).await;
    false
}

/// An answer kept with the ETag TMDB gave it, beside it as `<name>.etag`, or with none — so a revalidation never
/// names the tag of a body that is no longer there, which TMDB would answer 304 for. The old tag goes first: a
/// reader in between asks without one rather than with the wrong one.
async fn keep(file: &Path, body: &Bytes, etag: Option<&str>) {
    let tag = file.with_extension("etag");
    let _ = tokio::fs::remove_file(&tag).await;
    write(file, body).await;
    if let Some(etag) = etag {
        let _ = tokio::fs::write(&tag, etag).await;
    }
}

/// TMDB said the kept answer is still its own, so it counts as fetched now, tag and all: freshness and TMDB's six
/// months start over from this confirmation, as they would from a download of the same bytes.
async fn renew(file: &Path) {
    for path in [file.to_path_buf(), file.with_extension("etag")] {
        if let Ok(f) = tokio::fs::File::options().write(true).open(&path).await {
            let _ = f.into_std().await.set_modified(SystemTime::now());
        }
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
        let _refreshing = Refreshing { set: &state.tmdb_refreshing, key: asking.cached.clone() };
        // Refused, over budget or unreachable: what is kept stays, and the next stale read asks again.
        let (path, query, key) = (&asking.path, asking.query.as_deref(), &asking.key);
        match revalidate(&state, path, query, key, "refresh", &asking.file).await {
            Ok(Fetched::Answer(body, etag)) => {
                keep(&asking.file, &body, etag.as_deref()).await;
                crate::title_metadata::observe_tmdb(&state, path, &body);
            }
            Ok(Fetched::Unchanged) => {
                renew(&asking.file).await;
                if let Some((body, _, _)) = read(&asking.file).await {
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

    /// A refused key, a rate limit and an outage were each a bare 502 with nothing in the log; a 429's own wait was
    /// dropped, and a spent day said to come back in an hour whatever the time until UTC midnight.
    #[tokio::test]
    async fn tmdbs_refusals_say_what_they_are_and_how_long_to_wait() {
        let h = Harness::in_dir_with(temp_dir(), |state| state.tmdb_daily_max = Some(0));
        let mut waits = HeaderMap::new();
        waits.insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
        let limited = refusal(&h.state, StatusCode::TOO_MANY_REQUESTS, &waits);
        assert_eq!(limited.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(limited.headers()[header::RETRY_AFTER], "7");
        let limited = refusal(&h.state, StatusCode::TOO_MANY_REQUESTS, &HeaderMap::new());
        assert_eq!(limited.headers()[header::RETRY_AFTER], "10", "a 429 without a wait still names one");
        assert_eq!(
            refusal(&h.state, StatusCode::UNAUTHORIZED, &HeaderMap::new()).status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            refusal(&h.state, StatusCode::NOT_FOUND, &HeaderMap::new()).status(),
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
        assert_eq!(fresh_for_answer("/3/tv/1399", airing), LIST_TTL);
        assert_eq!(fresh_for_answer("/3/tv/1399", between), LIST_TTL);
        assert_eq!(fresh_for_answer("/3/tv/1399", ended), DETAILS_TTL);
        assert_eq!(fresh_for_answer("/3/tv/1399", cancelled), DETAILS_TTL);
        // A series' own record and nothing else: a season's episodes are settled once they have aired, and a
        // film has no status to read.
        assert_eq!(fresh_for_answer("/3/tv/1399/season/2", airing), DETAILS_TTL);
        assert_eq!(fresh_for_answer("/3/movie/550", airing), DETAILS_TTL);
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

    /// A kept answer's ETag travels with it and leaves with it. An answer kept without one, or a 404 kept in its
    /// place, must never be revalidated with the tag of what was there before: TMDB would answer 304 for a body
    /// that is not the one on disk.
    #[tokio::test]
    async fn an_answer_is_kept_with_its_etag_and_a_304_renews_both() {
        let dir = temp_dir();
        let file = cache_path(&dir, &cache_key("/3/trending/all/week", None));
        let tag = file.with_extension("etag");
        keep(&file, &Bytes::from_static(b"{\"page\":1}"), Some("W/\"abc\"")).await;
        assert_eq!(std::fs::read_to_string(&tag).unwrap(), "W/\"abc\"");

        aged(&file, LIST_TTL + Duration::from_secs(60));
        aged(&tag, LIST_TTL + Duration::from_secs(60));
        renew(&file).await;
        assert!(read(&file).await.unwrap().1 < Duration::from_secs(5), "a 304 counts as fetched now");
        let tag_age = SystemTime::now().duration_since(std::fs::metadata(&tag).unwrap().modified().unwrap());
        assert!(tag_age.unwrap_or_default() < Duration::from_secs(5), "and so does its tag");

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
            let mut body =
                serde_json::json!({ "id": id, "title": "T", "status": status, "vote_average": 7.5 });
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
        let body = serde_json::json!({ "id": 550, "title": "Fight Club", "credits": {}, "videos": {} });
        write(&kept, &Bytes::from(body.to_string())).await;
        aged(&kept, Duration::from_secs(30 * 86_400));

        let web = format!("/tmdb/3/movie/550?append_to_response={}", WEB_MOVIE.replace(',', "%2C"));
        let resp = h.send("GET", &web, None, &[]).await;
        assert_eq!(resp.headers()["x-den-tmdb"], "hit");
        let policy = resp.headers()[header::CACHE_CONTROL].to_str().unwrap().to_owned();
        let left = (DETAILS_TTL - Duration::from_secs(30 * 86_400)).as_secs();
        let max_age: u64 = policy.trim_start_matches("public, max-age=").parse().unwrap();
        assert!(max_age <= left && max_age + 5 > left, "what is left of its own six months: {policy}");
        let (how, bare) = detail(&h, "/tmdb/3/movie/550").await;
        assert_eq!(how, "hit");
        assert_eq!(bare, serde_json::json!({ "id": 550, "title": "Fight Club" }));
        assert!(ask(&h.state, "/3/movie/550", None).await.is_some());
        assert!(crate::lock(&asked).is_empty(), "nothing was asked of TMDB");
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
        assert!(
            crate::lock(&ASKING).keys().all(|file| !file.starts_with(&cache)),
            "nothing is left in flight"
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
        let record = metadata.join("movie-550-tmdb.json");
        let recorded = || async {
            for _ in 0..200 {
                if record.exists() {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            false
        };

        assert_eq!(detail(&h, "/tmdb/3/movie/550?append_to_response=credits").await.0, "miss");
        assert!(recorded().await, "the miss was recorded");
        let kept: serde_json::Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        assert_eq!(kept["fields"]["rating"]["value"], 7.5);

        std::fs::remove_file(&record).unwrap();
        assert_eq!(detail(&h, "/tmdb/3/movie/550").await.0, "hit");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!record.exists(), "a hit is not recorded again");

        // A season's own id and rating are not a title's.
        h.send("GET", "/tmdb/3/tv/1399/season/1", None, &[]).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            std::fs::read_dir(&metadata).map(|d| d.count()).unwrap_or(0),
            0,
            "nothing else was recorded"
        );
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
            &Bytes::from_static(br#"{"id":550,"title":"Fight Club","vote_average":8.4}"#),
            Some("W/\"a\""),
        )
        .await;
        aged(&whole, DETAILS_TTL + Duration::from_secs(60));

        assert_eq!(detail(&h, "/tmdb/3/movie/550").await.0, "revalidated");
        let record = metadata.join("movie-550-tmdb.json");
        for _ in 0..200 {
            if record.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(record.exists(), "the confirmed answer was recorded");
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
