//! OMDb's ratings through this origin (`GET /ratings/imdb/<tt…>`) — IMDb, Rotten Tomatoes and Metacritic — kept for
//! everyone.
//!
//! The arrangement the content warnings have (`warnings.rs`). A title's ratings are asked for once, kept, and served
//! to every TV and browser that opens it, a visitor included. A question leaves the box only for a caller's own OMDb
//! key or, for a member of a library here, the household's (env `OMDB_KEY`); anyone else gets what is kept, or
//! nothing.
//!
//! OMDb licenses its data CC BY-NC 4.0, which the credit in About covers, and a free key gets 1,000 questions a day.
//! So the household key has a daily ceiling of its own (env `OMDB_DAILY_MAX`), and rests for the rest of the UTC day
//! when OMDb says its limit is reached.
//!
//! Ratings move, but slowly, so a kept title is fresh for 30 days. After that it is served as it is, at once, and
//! the first caller who may ask has it fetched again in the background — nobody waits on OMDb for a title that is
//! already kept, and nobody is shown nothing because a refresh failed.

use crate::handler::{client_ip, error, raw_json, retry_after};
use crate::warnings::{callers_key, spendable, valid_imdb, Key};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const API: &str = "https://www.omdbapi.com/";
const TIMEOUT: Duration = Duration::from_secs(15);
/// One title's record is a few kilobytes.
const MAX_ANSWER_BYTES: usize = 256 * 1024;
/// Questions per address per minute, kept or not. A detail page asks one.
const PER_WINDOW: u32 = 60;
const DAY_MS: u64 = 86_400_000;
/// How long a kept title's ratings are served as they are, with nothing asked.
const FRESH: Duration = Duration::from_secs(30 * 86_400);
/// How long a kept title is still served while its refresh waits for a caller who may ask for one. The sweep
/// deletes what is older.
const RETENTION: Duration = Duration::from_secs(180 * 86_400);
/// How long a browser keeps an answer served stale: a refresh is under way.
const STALE_MAX_AGE: Duration = Duration::from_secs(60);
/// How long "OMDb has no such title" is believed.
const ABSENT_TTL: Duration = Duration::from_secs(7 * 86_400);
/// A kept "no such title". No answer of theirs has this shape.
const ABSENT: &[u8] = b"{\"den_absent\":true}";
/// The Shawshank Redemption: a title every working key resolves, for Settings' check.
const PROBE: &str = "tt0111161";
/// What is kept of OMDb's answer: the fields the TV and the web app read, in OMDb's own shape, and nothing else.
const KEPT_FIELDS: [&str; 5] = ["Response", "imdbRating", "imdbVotes", "Awards", "Ratings"];

pub async fn handle(state: &Arc<AppState>, req: Request, rid: &str) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let own = match callers_key(&req) {
        Ok(key) => key,
        Err(refused) => return *refused,
    };
    let member =
        req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let path = req.uri().path().trim_start_matches("/ratings").to_owned();
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_at(state, &format!("ratings:{ip}"), PER_WINDOW) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    // Settings' "Save & validate": the caller's key, asked for a title it would find if it worked.
    if path == "/check" {
        let Some(value) = own else { return json(StatusCode::UNAUTHORIZED, "no_key") };
        return match lookup(state, PROBE, &Key { value, household: false }, rid).await {
            Ok(Some(_)) => raw_json(StatusCode::NO_CONTENT, Body::empty(), true),
            Ok(None) => json(StatusCode::UNAUTHORIZED, "key_refused"),
            Err(refused) => *refused,
        };
    }
    let Some(imdb) = path.strip_prefix("/imdb/").filter(|id| valid_imdb(id)).map(str::to_owned) else {
        return json(StatusCode::NOT_FOUND, "not_found");
    };

    let asked = req.headers();
    let file = state.ratings_cache_dir.as_ref().map(|dir| dir.join(format!("{imdb}.json")));
    let kept = match &file {
        Some(file) => crate::tmdb::read(file).await,
        None => None,
    };
    if let Some((body, age, modified)) = kept {
        let absent = body.as_ref() == ABSENT;
        if absent && age < ABSENT_TTL {
            return crate::warnings::absent();
        }
        if !absent && age < FRESH {
            return answer(body, FRESH.saturating_sub(age), "hit", modified, asked);
        }
        if !absent && age < RETENTION {
            // Served as it is, now. A caller who may ask starts the refresh; the next one sees its answer.
            if let (Some(key), Some(file)) =
                (spendable(state, member.as_deref(), own, state.ratings_key.as_ref()).await, file)
            {
                refresh_behind(state, imdb, key, file);
            }
            return answer(body, STALE_MAX_AGE, "stale", modified, asked);
        }
    }
    // Nothing kept that may be served. Only a caller who may spend a question gets one asked.
    let Some(key) = spendable(state, member.as_deref(), own, state.ratings_key.as_ref()).await else {
        return json(StatusCode::NOT_FOUND, "not_cached");
    };
    match lookup(state, &imdb, &key, rid).await {
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

/// Fetch a stale title again without holding up the request that found it stale. One refresh per title at a time:
/// every page open of a popular title in the minute a refresh takes would otherwise start another.
fn refresh_behind(state: &Arc<AppState>, imdb: String, key: Key, file: PathBuf) {
    if !crate::lock(&state.ratings_refreshing).insert(imdb.clone()) {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        match lookup(&state, &imdb, &key, "refresh").await {
            Ok(Some(body)) => {
                crate::tmdb::write(&file, &body).await;
            }
            Ok(None) => {
                crate::tmdb::write(&file, &Bytes::from_static(ABSENT)).await;
            }
            // Refused, rested or unreachable, and already said so: what is kept stays, and is asked again later.
            Err(_) => {}
        }
        crate::lock(&state.ratings_refreshing).remove(&imdb);
    });
}

/// One title's ratings as they are kept: `Some` body, or `None` when OMDb has no title with this IMDb id. Every
/// other refusal is already the response to give.
async fn lookup(state: &AppState, imdb: &str, key: &Key, rid: &str) -> Result<Option<Bytes>, Box<Response>> {
    if key.household && !spend(state) {
        return Err(Box::new(retry_after(
            StatusCode::SERVICE_UNAVAILABLE,
            &error("ratings_budget_spent"),
            until_tomorrow(state),
        )));
    }
    let Some(client) = state.tmdb_client.as_ref() else {
        return Err(refused(StatusCode::NOT_FOUND, "ratings_off"));
    };
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("i", imdb)
        .append_pair("apikey", &key.value)
        .finish();
    let out = axum::http::Request::builder()
        .method(Method::GET)
        .uri(format!("{API}?{query}"))
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()));
    let Ok(out) = out else { return Err(refused(StatusCode::BAD_REQUEST, "bad_request")) };
    let answer = match tokio::time::timeout(TIMEOUT, client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            // The error names the host, never the query the key is in.
            eprintln!("ratings: {e}");
            return Err(refused(StatusCode::BAD_GATEWAY, "ratings_unreachable"));
        }
        Err(_) => return Err(refused(StatusCode::GATEWAY_TIMEOUT, "ratings_timeout")),
    };
    let status = answer.status();
    let Ok(bytes) = Limited::new(answer.into_body(), MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes())
    else {
        return Err(refused(StatusCode::BAD_GATEWAY, "ratings_answer_unreadable"));
    };
    // OMDb says why in its body: a refused key or a spent day as a 401, a title it doesn't have as a 200. The
    // body itself never travels.
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let why = body.get("Error").and_then(Value::as_str).unwrap_or("");
    if status.is_success() && body.get("Response").and_then(Value::as_str) == Some("True") {
        return Ok(Some(Bytes::from(kept(&body).to_string())));
    }
    if status.is_success() && (why.contains("not found") || why.contains("Incorrect IMDb ID")) {
        return Ok(None);
    }
    if why.contains("limit") {
        if key.household {
            rest(state);
        }
        return Err(Box::new(retry_after(
            StatusCode::SERVICE_UNAVAILABLE,
            &error("ratings_rate_limited"),
            until_tomorrow(state),
        )));
    }
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN if !key.household => {
            Err(refused(StatusCode::UNAUTHORIZED, "key_refused"))
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            eprintln!("ratings: OMDb refused the household key ({why}) — check OMDB_KEY");
            Err(refused(StatusCode::BAD_GATEWAY, "ratings_refused"))
        }
        _ => Err(refused(StatusCode::BAD_GATEWAY, "ratings_refused")),
    }
}

fn kept(body: &Value) -> Value {
    let fields: Map<String, Value> = KEPT_FIELDS
        .iter()
        .filter_map(|field| Some(((*field).to_owned(), body.get(*field)?.clone())))
        .collect();
    Value::Object(fields)
}

/// Take one of today's questions for the household key (env `OMDB_DAILY_MAX`), or refuse — saying so once a day.
fn spend(state: &AppState) -> bool {
    let day = state.now() / DAY_MS;
    let mut spent = crate::lock(&state.ratings_spent);
    if spent.0 != day {
        *spent = (day, 0);
    }
    let max = state.ratings_daily_max.unwrap_or(u32::MAX - 1);
    if spent.1 >= max {
        if spent.1 == max {
            spent.1 = max + 1;
            eprintln!("ratings: the household OMDb key's {max} questions for today are spent — kept titles still serve.");
        }
        return false;
    }
    spent.1 += 1;
    true
}

/// OMDb says the household key's limit is reached: rest it until the next UTC day.
fn rest(state: &AppState) {
    let day = state.now() / DAY_MS;
    let mut spent = crate::lock(&state.ratings_spent);
    if *spent != (day, u32::MAX) {
        eprintln!(
            "ratings: OMDb says the household key's daily limit is reached — resting it until UTC midnight."
        );
    }
    *spent = (day, u32::MAX);
}

fn until_tomorrow(state: &AppState) -> u64 {
    DAY_MS - state.now() % DAY_MS
}

/// `remaining` is what is left of the 30 days, or a minute for a stale answer; a browser keeps it a day at most.
fn answer(
    body: Bytes,
    remaining: Duration,
    how: &'static str,
    modified: SystemTime,
    asked: &HeaderMap,
) -> Response {
    let mut resp = raw_json(StatusCode::OK, Body::from(body.clone()), false);
    let headers = resp.headers_mut();
    let max_age = remaining.min(Duration::from_millis(DAY_MS)).as_secs();
    if let Ok(value) = HeaderValue::from_str(&format!("public, max-age={max_age}")) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert("x-den-ratings", HeaderValue::from_static(how));
    crate::cache::validated(resp, &body, Some(modified), asked)
}

/// Delete what is past `RETENTION`, so the directory holds only what may still be served.
pub async fn sweep_forever(state: Arc<AppState>) {
    let Some(dir) = state.ratings_cache_dir.clone() else { return };
    loop {
        tokio::time::sleep(Duration::from_millis(DAY_MS)).await;
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
    use crate::handler::tests::{body_json, temp_dir, Harness};
    use serde_json::json;

    #[test]
    fn only_what_the_apps_read_is_kept() {
        let omdb = json!({
            "Title": "Fight Club", "Plot": "…", "Poster": "https://…",
            "Response": "True", "imdbRating": "8.8", "imdbVotes": "2,400,123", "Awards": "Nominated for 1 Oscar.",
            "Ratings": [{ "Source": "Rotten Tomatoes", "Value": "79%" }],
        });
        assert_eq!(
            kept(&omdb),
            json!({
                "Response": "True", "imdbRating": "8.8", "imdbVotes": "2,400,123", "Awards": "Nominated for 1 Oscar.",
                "Ratings": [{ "Source": "Rotten Tomatoes", "Value": "79%" }],
            })
        );
    }

    #[test]
    fn the_household_key_stops_at_its_daily_ceiling_and_when_omdb_says_so() {
        let h = Harness::in_dir_with(temp_dir(), |state| state.ratings_daily_max = Some(2));
        let state = &h.state;
        assert!(spend(state) && spend(state), "two questions allowed");
        assert!(!spend(state), "the third is refused");
        h.advance(DAY_MS);
        assert!(spend(state), "a new UTC day starts over");
        rest(state);
        assert!(!spend(state), "OMDb's own word rests it for the day");
        h.advance(DAY_MS);
        assert!(spend(state), "and tomorrow it asks again");
    }

    /// A visitor spends nothing: what is kept is served to them, and what is not is simply not there.
    #[tokio::test]
    async fn a_visitor_is_served_what_is_kept_and_never_asks_omdb() {
        let cache = temp_dir();
        let h = Harness::in_dir_with(temp_dir(), |state| {
            state.ratings_cache_dir = Some(cache.clone());
            state.ratings_key = Some("household".into());
        });
        let get = || h.send("GET", "/ratings/imdb/tt0137523", None, &[]);

        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(resp).await, json!({ "error": "not_cached" }));

        let kept = json!({ "Response": "True", "imdbRating": "8.8" });
        crate::tmdb::write(&cache.join("tt0137523.json"), &Bytes::from(kept.to_string())).await;
        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-den-ratings"], "hit");
        assert_eq!(body_json(resp).await, kept);

        // Past its 30 days a visitor is still served it at once, and starts no refresh: it has no key to spend.
        let file = cache.join("tt0137523.json");
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - FRESH - Duration::from_secs(86_400))
            .unwrap();
        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-den-ratings"], "stale");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "public, max-age=60");
        assert!(crate::lock(&h.state.ratings_refreshing).is_empty(), "a visitor starts no refresh");
        // Stale or not, a browser holding these bytes is told so rather than sent them again.
        let etag = resp.headers()[header::ETAG].to_str().unwrap().to_owned();
        let again = h.send("GET", "/ratings/imdb/tt0137523", None, &[("if-none-match", &etag)]).await;
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(again.headers()[header::CACHE_CONTROL], "public, max-age=60");
        assert!(again.headers().contains_key(header::LAST_MODIFIED));

        crate::tmdb::write(&file, &Bytes::from_static(ABSENT)).await;
        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            resp.headers()[header::CACHE_CONTROL],
            "public, max-age=3600",
            "a known absence may be kept"
        );

        assert_eq!(h.send("GET", "/ratings/check", None, &[]).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(h.send("GET", "/ratings/imdb/nm1", None, &[]).await.status(), StatusCode::NOT_FOUND);
    }
}
