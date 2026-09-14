//! doesthedogdie's content warnings through this origin (`GET /warnings/imdb/<tt…>`), kept for everyone.
//!
//! A browser cannot ask doesthedogdie itself: the key travels in an `x-api-key` header, which makes the request
//! preflight, and they answer no preflight and send no `Access-Control-Allow-Origin`. The TV can, because a native
//! request is not CORS-checked.
//!
//! So den-edge asks, and keeps what it learns. A title's warnings are stored once, under its IMDb id, and served to
//! every browser that opens it — a visitor included. Who is asking decides only whether a question may leave the
//! box: a caller's own key is spent on its own question, and a member of a library here gets the household's (env
//! `DOESTHEDOGDIE_KEY`). Anyone else is answered from what is kept, or not at all, so a visitor never spends one.
//!
//! Their API terms (doesthedogdie.com/api/terms) set the rest. The key is never handed out, and only the warnings a
//! page shows are (§3). Nothing kept is served or held past the 30 days they allow before cached data must be
//! refreshed (§3): the next caller who may ask looks it up again, and until then nobody is shown it. Every page that
//! shows the warnings says "Powered by DoesTheDogDie.com" (§6). The free tier allows 30 questions a minute and 5,000 a month, so questions
//! leaving here stay under the first, and the household key is rested when their answer says the second is nearly
//! spent.

use crate::handler::{client_ip, error, raw_json, retry_after};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::Duration;

const API: &str = "https://www.doesthedogdie.com/api/v3";
/// The header their API takes a key in, and the only one that travels from the caller.
const KEY_HEADER: &str = "x-api-key";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Their largest answer here is one title's topic votes, or the topic list.
const MAX_ANSWER_BYTES: usize = 2 * 1024 * 1024;
/// Questions per address per minute, kept or not. A detail page asks one.
const PER_WINDOW: u32 = 60;
/// Questions that may leave the box in a minute, whoever's key they carry: under the free tier's 30.
const UPSTREAM_PER_MINUTE: u32 = 25;
const DAY: Duration = Duration::from_secs(86_400);
/// How long anything kept is served: the 30 days their terms allow before cached data must be refreshed.
const FRESH: Duration = Duration::from_secs(30 * 86_400);
/// How long "doesthedogdie has no such title" is believed. A week: titles are added to it all the time.
const ABSENT_TTL: Duration = Duration::from_secs(7 * 86_400);
/// A kept "no such title". No answer of theirs has this shape.
const ABSENT: &[u8] = b"{\"den_absent\":true}";
/// Below this many questions left in their month, the household key is rested for a day, so the last of the
/// month's allowance stays with the callers who bring their own.
const MONTH_RESERVE: u64 = 100;
/// The topic names and categories every title's votes are joined with.
const TOPICS_FILE: &str = "topics.json";

/// What a kept answer is worth right now.
#[derive(Debug, PartialEq, Eq)]
enum Kept {
    /// A remembered "no such title", still believed.
    Absent,
    Fresh,
    /// Nothing usable, including a title past its 30 days.
    Cold,
}

fn verdict(absent: bool, age: Duration) -> Kept {
    match (absent, age) {
        (true, age) if age < ABSENT_TTL => Kept::Absent,
        (false, age) if age < FRESH => Kept::Fresh,
        _ => Kept::Cold,
    }
}

/// `tt` and up to ten digits: the one thing a path here may carry, and the name a title is kept under.
fn valid_imdb(id: &str) -> bool {
    id.strip_prefix("tt")
        .is_some_and(|n| (1..=10).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
}

pub async fn handle(state: &AppState, req: Request, rid: &str) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let own = match req.headers().get(KEY_HEADER).map(|v| v.to_str().map(str::to_owned)) {
        None => None,
        Some(Ok(key)) if !key.is_empty() && key.len() <= 256 && key.bytes().all(|b| b.is_ascii_graphic()) => {
            Some(key)
        }
        Some(_) => return json(StatusCode::BAD_REQUEST, "bad_key"),
    };
    let member =
        req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let path = req.uri().path().trim_start_matches("/warnings").to_owned();
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_at(state, &format!("warnings:{ip}"), PER_WINDOW) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    if path == "/check" {
        return check(state, own, rid).await;
    }
    let Some(imdb) = path.strip_prefix("/imdb/").filter(|id| valid_imdb(id)).map(str::to_owned) else {
        return json(StatusCode::NOT_FOUND, "not_found");
    };

    let file = state.warnings_cache_dir.as_ref().map(|dir| dir.join(format!("{imdb}.json")));
    let kept = match &file {
        Some(file) => crate::tmdb::read(file).await,
        None => None,
    };
    if let Some((body, age)) = kept {
        match verdict(body.as_ref() == ABSENT, age) {
            Kept::Absent => return json(StatusCode::NOT_FOUND, "not_found"),
            Kept::Fresh => return answer(body, FRESH.saturating_sub(age), "hit"),
            Kept::Cold => {}
        }
    }
    // Nothing kept that may be served. Only a caller who may spend a question gets one asked; anyone else is told
    // there is nothing.
    let Some(key) = spendable(state, member.as_deref(), own).await else {
        return json(StatusCode::NOT_FOUND, "not_cached");
    };
    match lookup(state, &imdb, &key, rid).await {
        Ok(Some(fresh)) => keep(file.as_deref(), fresh, "miss").await,
        Ok(None) => forget(file.as_deref()).await,
        Err(refused) => *refused,
    }
}

/// A key this request may spend: the caller's own, or the household's for a member of a library here.
async fn spendable(state: &AppState, member: Option<&str>, own: Option<String>) -> Option<Key> {
    if let Some(key) = own {
        return Some(Key { value: key, household: false });
    }
    let household = state.warnings_key.as_ref()?;
    crate::library::is_member(state, member).await.then(|| Key { value: household.clone(), household: true })
}

struct Key {
    value: String,
    /// The household's, which is rested when doesthedogdie says so and never blamed on the caller.
    household: bool,
}

/// Settings' "Save & validate": the caller's key, asked their cheapest question. 204 when it works.
async fn check(state: &AppState, own: Option<String>, rid: &str) -> Response {
    let Some(value) = own else { return json(StatusCode::UNAUTHORIZED, "no_key") };
    match ask(state, "/itemtypes", &Key { value, household: false }, rid).await {
        Ok(_) => raw_json(StatusCode::NO_CONTENT, Body::empty(), true),
        Err(refused) => *refused,
    }
}

/// One title's warnings, joined with the topic names: `Some` body to keep, `None` when doesthedogdie has no title
/// with this IMDb id.
async fn lookup(state: &AppState, imdb: &str, key: &Key, rid: &str) -> Result<Option<Bytes>, Box<Response>> {
    let found = ask(state, &format!("/items?imdb={imdb}"), key, rid).await?;
    let Some(id) = item_id(&found, imdb) else { return Ok(None) };
    let topics = topics(state, key, rid).await?;
    let item = ask(state, &format!("/items/{id}"), key, rid).await?;
    if item.is_null() {
        return Ok(None);
    }
    Ok(Some(Bytes::from(normalize(id, &item, &topics).to_string())))
}

/// The search answer's item for exactly this IMDb id. Their search is an array; an `items` object is taken too.
fn item_id(found: &Value, imdb: &str) -> Option<u64> {
    let items = found.as_array().or_else(|| found.get("items").and_then(Value::as_array))?;
    items
        .iter()
        .find(|item| item.get("imdbId").and_then(Value::as_str) == Some(imdb))
        .and_then(|item| item.get("id").and_then(Value::as_u64))
        .filter(|id| *id > 0)
}

/// topic id → `{name, category, spoiler}`, kept for 30 days: every title's votes name their topics by id alone.
async fn topics(state: &AppState, key: &Key, rid: &str) -> Result<Value, Box<Response>> {
    let file = state.warnings_cache_dir.as_ref().map(|dir| dir.join(TOPICS_FILE));
    let kept = match &file {
        Some(file) => crate::tmdb::read(file).await,
        None => None,
    };
    if let Some((body, age)) = kept {
        if age < FRESH {
            if let Ok(table) = serde_json::from_slice(&body) {
                return Ok(table);
            }
        }
    }
    let topics = ask(state, "/topics", key, rid).await?;
    let categories = ask(state, "/topiccategories", key, rid).await?;
    let table = topic_table(&topics, &categories);
    if let Some(file) = &file {
        crate::tmdb::write(file, &Bytes::from(table.to_string())).await;
    }
    Ok(table)
}

fn topic_table(topics: &Value, categories: &Value) -> Value {
    let names: Map<String, Value> = categories
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c.get("id")?.as_u64()?.to_string(), c.get("name")?.clone())))
        .collect();
    let table: Map<String, Value> = topics
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let id = t.get("id")?.as_u64()?;
            let category =
                t.get("topicCategoryId").and_then(Value::as_u64).and_then(|c| names.get(&c.to_string()));
            Some((
                id.to_string(),
                json!({
                    "name": t.get("name")?,
                    "category": category,
                    "spoiler": t.get("isSpoiler").and_then(Value::as_bool).unwrap_or(false),
                }),
            ))
        })
        .collect();
    Value::Object(table)
}

/// What is kept and served for a title: its doesthedogdie id and each topic's votes, named. Nothing else of theirs.
fn normalize(id: u64, item: &Value, topics: &Value) -> Value {
    let warnings: Vec<Value> = item
        .get("topicItemStats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|stat| {
            let topic_id = stat.get("topicId").and_then(Value::as_u64)?;
            let topic = topics.get(topic_id.to_string());
            let name = topic
                .and_then(|t| t.get("name"))
                .or_else(|| stat.get("topicName"))
                .and_then(Value::as_str)
                .filter(|n| !n.trim().is_empty())?;
            Some(json!({
                "id": topic_id,
                "name": name,
                "category": topic.and_then(|t| t.get("category")).cloned().unwrap_or(Value::Null),
                "spoiler": topic.and_then(|t| t.get("spoiler")).and_then(Value::as_bool).unwrap_or(false),
                "yes": stat.get("yesSum").and_then(Value::as_u64).unwrap_or(0),
                "no": stat.get("noSum").and_then(Value::as_u64).unwrap_or(0),
            }))
        })
        .collect();
    json!({ "id": id, "warnings": warnings })
}

/// Ask doesthedogdie. A 404 is `Null` — "no such thing" is an answer — and every other refusal is already the
/// response to give, so a caller holding a kept copy can discard it and serve that instead.
async fn ask(state: &AppState, path: &str, key: &Key, rid: &str) -> Result<Value, Box<Response>> {
    let now = state.now();
    let rest_until = *crate::lock(&state.warnings_rest_until);
    if key.household && now < rest_until {
        return Err(Box::new(retry_after(
            StatusCode::SERVICE_UNAVAILABLE,
            &error("warnings_resting"),
            rest_until - now,
        )));
    }
    if let Some(wait) = crate::link::throttled_at(state, "warnings:upstream", UPSTREAM_PER_MINUTE) {
        return Err(Box::new(retry_after(StatusCode::SERVICE_UNAVAILABLE, &error("warnings_busy"), wait)));
    }
    let Some(client) = state.tmdb_client.as_ref() else {
        return Err(refused(StatusCode::NOT_FOUND, "warnings_off"));
    };
    let out = axum::http::Request::builder()
        .method(Method::GET)
        .uri(format!("{API}{path}"))
        .header(header::ACCEPT, "application/json")
        .header(KEY_HEADER, &key.value)
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()));
    let Ok(out) = out else { return Err(refused(StatusCode::BAD_REQUEST, "bad_request")) };
    let answer = match tokio::time::timeout(TIMEOUT, client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("warnings: {e}");
            return Err(refused(StatusCode::BAD_GATEWAY, "warnings_unreachable"));
        }
        Err(_) => return Err(refused(StatusCode::GATEWAY_TIMEOUT, "warnings_timeout")),
    };
    let status = answer.status();
    let number = |name: &str| {
        answer.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok())
    };
    let month_left = number("x-ratelimit-remaining-month");
    let wait_ms = number("retry-after").map_or(60_000, |secs| secs.saturating_mul(1000));
    if key.household && month_left.is_some_and(|left| left < MONTH_RESERVE) {
        rest(state, now + DAY.as_millis() as u64, "its month is nearly spent");
    }
    let Ok(bytes) = Limited::new(answer.into_body(), MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes())
    else {
        return Err(refused(StatusCode::BAD_GATEWAY, "warnings_answer_unreadable"));
    };
    match status {
        s if s.is_success() => serde_json::from_slice(&bytes)
            .map_err(|_| refused(StatusCode::BAD_GATEWAY, "warnings_answer_unreadable")),
        StatusCode::NOT_FOUND => Ok(Value::Null),
        // Their body never travels: it may name the key.
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN if !key.household => {
            Err(refused(StatusCode::UNAUTHORIZED, "key_refused"))
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            eprintln!(
                "warnings: doesthedogdie refused the household key ({status}) — check DOESTHEDOGDIE_KEY"
            );
            Err(refused(StatusCode::BAD_GATEWAY, "warnings_refused"))
        }
        StatusCode::TOO_MANY_REQUESTS => {
            if key.household {
                rest(state, now + wait_ms, "it is rate-limited");
            }
            Err(Box::new(retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &error("warnings_rate_limited"),
                wait_ms,
            )))
        }
        _ => Err(refused(StatusCode::BAD_GATEWAY, "warnings_refused")),
    }
}

/// Rest the household key until `until`, saying so once per rest rather than once per refused question.
fn rest(state: &AppState, until: u64, why: &str) {
    let mut rest_until = crate::lock(&state.warnings_rest_until);
    if *rest_until < state.now() {
        eprintln!("warnings: resting the household doesthedogdie key: {why}. Kept titles still serve.");
    }
    *rest_until = (*rest_until).max(until);
}

async fn keep(file: Option<&Path>, body: Bytes, how: &'static str) -> Response {
    if let Some(file) = file {
        crate::tmdb::write(file, &body).await;
    }
    answer(body, FRESH, how)
}

async fn forget(file: Option<&Path>) -> Response {
    if let Some(file) = file {
        crate::tmdb::write(file, &Bytes::from_static(ABSENT)).await;
    }
    json(StatusCode::NOT_FOUND, "not_found")
}

/// `remaining` is what is left of the 30 days; a browser keeps it for a day at most, and never past them.
fn answer(body: Bytes, remaining: Duration, how: &'static str) -> Response {
    let mut resp = raw_json(StatusCode::OK, Body::from(body), false);
    let headers = resp.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&format!("public, max-age={}", remaining.min(DAY).as_secs())) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert("x-den-warnings", HeaderValue::from_static(how));
    resp
}

/// Delete what is past the 30 days: their terms allow keeping cached data no longer than that without a refresh.
pub async fn sweep_forever(state: std::sync::Arc<AppState>) {
    let Some(dir) = state.warnings_cache_dir.clone() else { return };
    loop {
        tokio::time::sleep(DAY).await;
        crate::tmdb::sweep_older_than(&dir, FRESH).await;
    }
}

fn json(status: StatusCode, code: &str) -> Response {
    raw_json(status, Body::from(error(code).to_string()), true)
}

fn refused(status: StatusCode, code: &str) -> Box<Response> {
    Box::new(json(status, code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, temp_dir, Harness};
    use std::time::SystemTime;

    #[test]
    fn only_an_imdb_id_names_a_title() {
        assert!(valid_imdb("tt0050798"));
        assert!(!valid_imdb("tt"));
        assert!(!valid_imdb("nm0000001"));
        assert!(!valid_imdb("tt12345678901"));
        assert!(!valid_imdb("tt1/../topics"));
    }

    #[test]
    fn a_kept_title_is_served_for_30_days_and_no_longer() {
        assert_eq!(verdict(false, DAY), Kept::Fresh);
        assert_eq!(verdict(false, FRESH + DAY), Kept::Cold);
        assert_eq!(verdict(true, DAY), Kept::Absent);
        assert_eq!(verdict(true, ABSENT_TTL + DAY), Kept::Cold, "an old 'no such title' is asked again");
    }

    #[test]
    fn the_search_answer_is_taken_only_for_the_same_imdb_id() {
        let found = json!([{ "id": 2, "imdbId": "tt2" }, { "id": 10752, "imdbId": "tt0050798" }]);
        assert_eq!(item_id(&found, "tt0050798"), Some(10752));
        assert_eq!(item_id(&found, "tt9"), None, "a similar title is not this one");
        assert_eq!(item_id(&json!({ "items": [{ "id": 5, "imdbId": "tt5" }] }), "tt5"), Some(5));
        assert_eq!(item_id(&Value::Null, "tt5"), None);
    }

    #[test]
    fn votes_are_kept_with_their_topic_named_and_nothing_else() {
        let topics = topic_table(
            &json!([
                { "id": 153, "name": "a dog dies", "topicCategoryId": 56, "keywords": "…" },
                { "id": 9, "name": "a sad ending", "topicCategoryId": 22, "isSpoiler": true },
            ]),
            &json!([{ "id": 56, "name": "Animal Injury or Death" }, { "id": 22, "name": "Sad & Stressful Themes" }]),
        );
        let item = json!({
            "id": 10752,
            "overview": "…",
            "topicItemStats": [
                { "topicId": 153, "topicName": "a dog dies", "yesSum": 57, "noSum": 3, "numComments": 7 },
                { "topicId": 9, "yesSum": 4, "noSum": 0 },
                { "topicId": 777, "topicName": "a topic the table has not heard of", "yesSum": 2, "noSum": 1 },
                { "topicId": 778, "yesSum": 2, "noSum": 1 },
            ],
        });
        assert_eq!(
            normalize(10752, &item, &topics),
            json!({ "id": 10752, "warnings": [
                { "id": 153, "name": "a dog dies", "category": "Animal Injury or Death", "spoiler": false, "yes": 57, "no": 3 },
                { "id": 9, "name": "a sad ending", "category": "Sad & Stressful Themes", "spoiler": true, "yes": 4, "no": 0 },
                { "id": 777, "name": "a topic the table has not heard of", "category": null, "spoiler": false, "yes": 2, "no": 1 },
            ]})
        );
    }

    fn aged(file: &Path, age: Duration) {
        let handle = std::fs::File::options().write(true).open(file).unwrap();
        handle.set_modified(SystemTime::now() - age).unwrap();
    }

    /// A visitor spends nothing: what is kept is served to them, and what is not is simply not there.
    #[tokio::test]
    async fn a_visitor_is_served_what_is_kept_and_never_asks_doesthedogdie() {
        let cache = temp_dir();
        let h = Harness::in_dir_with(temp_dir(), |state| {
            state.warnings_cache_dir = Some(cache.clone());
            state.warnings_key = Some("household".into());
        });
        let get = || h.send("GET", "/warnings/imdb/tt0050798", None, &[]);

        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(resp).await, json!({ "error": "not_cached" }));

        let file = cache.join("tt0050798.json");
        let kept = json!({ "id": 10752, "warnings": [] });
        crate::tmdb::write(&file, &Bytes::from(kept.to_string())).await;
        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-den-warnings"], "hit");
        assert_eq!(body_json(resp).await, kept);

        aged(&file, FRESH + DAY);
        let resp = get().await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "nothing is served past 30 days");
        assert_eq!(body_json(resp).await, json!({ "error": "not_cached" }));

        crate::tmdb::write(&file, &Bytes::from_static(ABSENT)).await;
        let resp = get().await;
        assert_eq!(
            body_json(resp).await,
            json!({ "error": "not_found" }),
            "a kept 'no such title' answers as one"
        );

        let resp =
            h.send("GET", "/warnings/imdb/tt0050798", None, &[("x-den-library-member", "0123:forged")]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "a claim to membership is checked, not believed");
    }

    #[tokio::test]
    async fn only_a_title_or_the_key_check_is_asked_for() {
        let h = Harness::new();
        for path in ["/warnings/search?q=x", "/warnings/media/1", "/warnings/imdb/nm1", "/warnings/topics"] {
            assert_eq!(h.send("GET", path, None, &[]).await.status(), StatusCode::NOT_FOUND, "{path}");
        }
        let resp = h.send("GET", "/warnings/check", None, &[]).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "a key check needs a key");
        let resp = h.send("GET", "/warnings/check", None, &[("x-api-key", "has spaces")]).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
