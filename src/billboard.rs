//! TMDB's current-release and trending lists, added to a relayed `POST /recommend` (den-atlas) as candidates.
//!
//! atlas ranks its own lists and the household's taste, but a title only TMDB has pushed yet (a series whose new
//! season aired this week) is on none of them, and so could never lead the billboard. The browser used to fetch these
//! lists itself and send them along; den-edge asks for them instead, through the same cache as `/tmdb`
//! (`tmdb::ask`), once per UTC day, so a member's page sends only its library.

use crate::AppState;
use axum::body::Bytes;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// The lists, and whether each is itself a ranking, so a place in it says something (atlas's `rank`/`of`).
const LISTS: [(&str, bool); 5] = [
    ("/3/trending/movie/week", true),
    ("/3/trending/tv/week", true),
    ("/3/movie/now_playing", false),
    ("/3/movie/upcoming", false),
    ("/3/tv/on_the_air", false),
];
/// atlas refuses a request naming more candidates than this (den-atlas `recommend.rs` `MAX_CANDIDATES`).
const MAX_CANDIDATES: usize = 2000;

/// Today's candidates, by UTC day. Kept only when every list answered, so a failed list is asked again.
static TODAY: Mutex<Option<(String, Arc<Vec<Value>>)>> = Mutex::new(None);

/// `body` with today's TMDB lists appended to its `candidates`. A body that is not a JSON object, or a day with
/// no list to offer, goes on as it came: atlas answers it as it would have.
pub(crate) async fn with_tmdb_lists(state: &AppState, body: Bytes) -> Bytes {
    let Ok(mut request) = serde_json::from_slice::<Map<String, Value>>(&body) else { return body };
    let offered = today(state).await;
    let Some(candidates) =
        request.entry("candidates").or_insert_with(|| Value::Array(Vec::new())).as_array_mut()
    else {
        return body;
    };
    let room = MAX_CANDIDATES.saturating_sub(candidates.len());
    if offered.is_empty() || room == 0 {
        return body;
    }
    candidates.extend(offered.iter().take(room).cloned());
    serde_json::to_vec(&request).map(Bytes::from).unwrap_or(body)
}

async fn today(state: &AppState) -> Arc<Vec<Value>> {
    let day = crate::cache::iso_date(SystemTime::now());
    if let Some((kept, offered)) = crate::lock(&TODAY).as_ref() {
        if *kept == day {
            return Arc::clone(offered);
        }
    }
    let ask = |path| crate::tmdb::ask(state, path, None);
    let answers =
        tokio::join!(ask(LISTS[0].0), ask(LISTS[1].0), ask(LISTS[2].0), ask(LISTS[3].0), ask(LISTS[4].0));
    let answers = [answers.0, answers.1, answers.2, answers.3, answers.4];
    let complete = answers.iter().all(Option::is_some);
    let offered: Vec<Value> = LISTS
        .iter()
        .zip(&answers)
        .flat_map(|(&(path, ranked), answer)| candidates(path, ranked, answer.as_ref()))
        .collect();
    let offered = Arc::new(offered);
    if complete {
        *crate::lock(&TODAY) = Some((day, Arc::clone(&offered)));
    }
    offered
}

/// One TMDB list page as atlas's candidates (`Offered`): the title, its place where the list is a ranking, and what
/// TMDB said about it as a `hint`, which atlas reads only where it knows nothing itself and never keeps.
fn candidates(path: &str, ranked: bool, answer: Option<&Value>) -> Vec<Value> {
    let series = path.contains("/tv/");
    let results = answer.and_then(|a| a["results"].as_array()).map(Vec::as_slice).unwrap_or_default();
    let of = results.len();
    results
        .iter()
        .enumerate()
        .filter_map(|(rank, item)| {
            let id = item["id"].as_u64()?;
            let date = item[if series { "first_air_date" } else { "release_date" }]
                .as_str()
                .filter(|d| !d.is_empty());
            let mut hint = json!({
                "title": item[if series { "name" } else { "title" }],
                "releaseDate": date,
                "year": date.and_then(|d| d.get(..4)?.parse::<i32>().ok()),
                "genreIds": item["genre_ids"],
                "originalLanguage": item["original_language"],
                "countries": item["origin_country"],
                "popularity": item["popularity"],
                "adult": item["adult"],
            });
            let rating = item["vote_average"].as_f64().filter(|r| *r > 0.0 && *r <= 10.0);
            if let Some(rating) = rating {
                hint["rating"] = json!(rating);
                hint["votes"] = item["vote_count"].clone();
            }
            // atlas reads an absent field and a null one alike; nulls are dropped so the body stays small.
            hint.as_object_mut()?.retain(|_, v| !v.is_null());
            let mut offered =
                json!({ "type": if series { "series" } else { "movie" }, "id": id, "hint": hint });
            if ranked {
                offered["rank"] = json!(rank);
                offered["of"] = json!(of);
            }
            Some(offered)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{temp_dir, Harness};
    use crate::tmdb::{cache_key, cache_path, write};

    /// The only test that reads `TODAY`, so no other test's day can be the one it finds.
    #[tokio::test]
    async fn a_ranking_request_gets_todays_lists_and_anything_else_goes_on_as_it_came() {
        let cache = temp_dir();
        let kept = cache.clone();
        let h = Harness::in_dir_with(temp_dir(), move |state| {
            state.tmdb_key = Some("household".into());
            state.tmdb_cache_dir = Some(kept);
        });
        for (at, (path, _)) in LISTS.iter().enumerate() {
            let page = json!({ "results": [{ "id": 100 + at, "title": "A", "name": "A" }] });
            write(&cache_path(&cache, &cache_key(path, None)), &Bytes::from(page.to_string())).await;
        }

        let body = br#"{"surface":"home","library":[{"type":"movie","id":7,"weight":1}],"candidates":[{"type":"movie","id":8}]}"#;
        let sent: Value =
            serde_json::from_slice(&with_tmdb_lists(&h.state, Bytes::from_static(body)).await).unwrap();
        assert_eq!(sent["surface"], "home");
        assert_eq!(sent["library"], json!([{ "type": "movie", "id": 7, "weight": 1 }]));
        let ids: Vec<_> = sent["candidates"].as_array().unwrap().iter().map(|c| c["id"].clone()).collect();
        assert_eq!(
            ids,
            [8, 100, 101, 102, 103, 104],
            "the page's own first, then trending and current releases"
        );
        assert_eq!(sent["candidates"][2]["type"], "series");

        // A library sending no candidates gets the lists alone.
        let sent: Value =
            serde_json::from_slice(&with_tmdb_lists(&h.state, Bytes::from_static(b"{}")).await).unwrap();
        assert_eq!(sent["candidates"].as_array().unwrap().len(), LISTS.len());
        // Not a JSON object: atlas refuses it as it always has.
        assert_eq!(&with_tmdb_lists(&h.state, Bytes::from_static(b"not json")).await[..], b"not json");
    }

    #[test]
    fn a_list_becomes_candidates_with_their_place_and_what_tmdb_said() {
        let page = json!({ "results": [
            { "id": 1, "title": "One", "release_date": "2026-09-01", "genre_ids": [18], "original_language": "en",
              "popularity": 90.5, "vote_average": 7.5, "vote_count": 200, "adult": false },
            { "id": 2, "title": "Two", "release_date": "", "vote_average": 0 },
            { "title": "no id" },
        ]});
        let offered = candidates("/3/trending/movie/week", true, Some(&page));
        assert_eq!(offered.len(), 2);
        assert_eq!(
            offered[0],
            json!({ "type": "movie", "id": 1, "rank": 0, "of": 3, "hint": {
                "title": "One", "releaseDate": "2026-09-01", "year": 2026, "genreIds": [18], "originalLanguage": "en",
                "popularity": 90.5, "adult": false, "rating": 7.5, "votes": 200 } })
        );
        // A TMDB score of 0 is "no votes", not a score.
        assert!(offered[1]["hint"].get("rating").is_none());
        assert_eq!(offered[1]["hint"], json!({ "title": "Two" }), "no date is sent for an empty one");

        let series = json!({ "results": [{ "id": 9, "name": "Nine", "first_air_date": "2025-01-02",
                                           "origin_country": ["US"] }] });
        let offered = candidates("/3/tv/on_the_air", false, Some(&series));
        assert_eq!(
            offered,
            [json!({ "type": "series", "id": 9, "hint": {
                "title": "Nine", "releaseDate": "2025-01-02", "year": 2025, "countries": ["US"] } })]
        );
        assert!(candidates("/3/movie/upcoming", false, None).is_empty());
    }
}
