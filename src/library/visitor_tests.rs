//! `NEW_LIBRARIES=visitors`, through the real router: who is a visitor, what a visitor may not reach, and the limits
//! on starting and filling a visitor's library.

use super::{NewLibraries, DAY_MS};
use crate::handler::tests::{body_json, Harness};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};

const MEMBER_LIB: &str = "0123456789abcdef0123456789abcdef";
const TOKEN: &str = "the-write-token";
const SCOUT: &str = "c2NvdXQtY29uZmlnLXNlZ21lbnQ";
const ATLAS: &str = "YXRsYXMtY29uZmln";
const LOC: &str = "df858499eebc4d6ea5736d45e3019632";
const SEALED: &str = "AAECAwQFBgcICQoLlCJZe4Oyvi9z_AUppqfkMI4h8K6p9ZVLCC4DQL7Ovh9eOx3IEdTxSjbYneBl4oHxJhOwhkA_Mjsu_sfPhf7unhVCJeaeO29P6YgG4SWX7YC7b8D8h_YA_LTThorPNOr43Kp8wP5nvv8ikkCz";

fn id(n: u32) -> String {
    format!("{:032x}", 0x1000 + n)
}

fn key(n: u32) -> String {
    format!("{n:016x}")
}

/// The store as `NEW_LIBRARIES=visitors` runs it, with the relays a visitor must not reach. Peers reach it through a
/// trusted proxy so a test can be several addresses.
fn configure(state: &mut crate::AppState) {
    state.new_libraries = NewLibraries::Visitors;
    state.relays = crate::parse_relays("/scout=http://127.0.0.1:9, /remux=http://127.0.0.1:9");
    state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
    state.trusted_proxies = vec!["192.168.1.9".parse().unwrap()];
}

fn visitors() -> Harness {
    Harness::in_dir_with(crate::handler::tests::temp_dir(), configure)
}

/// A store that already holds a household's library, started before visitors were let in.
async fn visitors_with_a_member_library(tune: impl FnOnce(&mut crate::AppState)) -> Harness {
    let before = Harness::new();
    let dir = before.dir.clone();
    assert_eq!(start(&before, MEMBER_LIB, TOKEN, None, "10.0.0.1", rows(1)).await, StatusCode::OK);
    drop(before);
    Harness::in_dir_with(dir, |state| {
        configure(state);
        tune(state);
    })
}

fn rows(n: u32) -> Value {
    Value::Array((0..n).map(|i| json!({ "k": key(i), "base": 0, "v": "v" })).collect())
}

async fn send(
    h: &Harness,
    id: &str,
    token: &str,
    member: Option<&str>,
    from: &str,
    writes: Value,
) -> Response {
    let body = json!({ "writes": writes }).to_string();
    let mut headers = vec![("x-den-library-token", token), ("x-forwarded-for", from)];
    if let Some(member) = member {
        headers.push(("x-den-library-member", member));
    }
    h.send("POST", &format!("/lib/{id}/batch"), Some(body), &headers).await
}

async fn start(
    h: &Harness,
    id: &str,
    token: &str,
    member: Option<&str>,
    from: &str,
    writes: Value,
) -> StatusCode {
    send(h, id, token, member, from, writes).await.status()
}

async fn anonymous(h: &Harness, n: u32, from: &str) -> StatusCode {
    start(h, &id(n), TOKEN, None, from, rows(1)).await
}

fn retry_after(response: &Response) -> u64 {
    response.headers()["retry-after"].to_str().unwrap().parse().unwrap()
}

async fn is_visitor(h: &Harness, id: &str) -> bool {
    super::library_is_visitor(&h.state, id).await.unwrap()
}

fn claim(id: &str) -> String {
    format!("{id}:{TOKEN}")
}

async fn relay(h: &Harness, path: &str, claim: &str) -> StatusCode {
    h.send("GET", path, None, &[("host", "d.oxy.fi"), ("x-den-library-member", claim)]).await.status()
}

/// Under `visitors` anyone may start a library, and it is marked a visitor's by its first write, durably.
#[tokio::test]
async fn an_anonymous_first_write_starts_a_visitor_library_and_it_stays_one() {
    let h = visitors();
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK);
    assert!(is_visitor(&h, &id(1)).await);
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK, "and it takes its writes as before");

    let dir = h.dir.clone();
    drop(h);
    let restarted = Harness::in_dir_with(dir, configure);
    assert!(is_visitor(&restarted, &id(1)).await, "the tier is on disk, not in memory");
}

/// A first write refused after the library's file exists leaves it empty and unmarked. The next first write is still
/// a start, so it is decided as one: otherwise the library would begin life as a member's.
#[tokio::test]
async fn a_refused_first_write_cannot_leave_a_library_that_starts_as_a_member() {
    let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
        configure(state);
        state.visitor_library_max_rows = 2;
    });
    assert_eq!(start(&h, &id(1), TOKEN, None, "1.1.1.1", rows(3)).await, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(start(&h, &id(1), TOKEN, None, "1.1.1.1", rows(1)).await, StatusCode::OK);
    assert!(is_visitor(&h, &id(1)).await);
    assert_eq!(relay(&h, "/scout/manifest.json", &claim(&id(1))).await, StatusCode::NOT_FOUND);
}

/// What is private to a household is not reached by holding a visitor's library, and what a visitor needs is.
#[tokio::test]
async fn a_visitor_library_reaches_no_relay_and_no_grants_but_keeps_its_recovery_codes() {
    let h = visitors_with_a_member_library(|_| {}).await;
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK);
    let (visitor, member) = (claim(&id(1)), claim(MEMBER_LIB));
    assert!(super::is_member(&h.state, Some(&visitor)).await, "it is a member in the sense recovery needs");
    assert!(!super::is_household_member(&h.state, Some(&visitor)).await);
    assert!(
        super::is_household_member(&h.state, Some(&member)).await,
        "a library from before is a household's"
    );

    for path in ["/scout/manifest.json", "/remux/health"] {
        assert_eq!(
            relay(&h, path, &member).await,
            StatusCode::BAD_GATEWAY,
            "{path}: the household reaches it"
        );
        assert_eq!(relay(&h, path, &visitor).await, StatusCode::NOT_FOUND, "{path}: a visitor does not");
    }

    assert_eq!(grants(&h, MEMBER_LIB, &member).await, StatusCode::CREATED);
    assert_eq!(grants(&h, &id(1), &visitor).await, StatusCode::FORBIDDEN);

    assert_eq!(
        recovery(&h, &visitor).await,
        StatusCode::CREATED,
        "recovery is why a visitor household has a code"
    );

    assert_ne!(
        publish(&h, &member).await,
        StatusCode::UNAUTHORIZED,
        "a household may publish title metadata"
    );
    assert_eq!(publish(&h, &visitor).await, StatusCode::UNAUTHORIZED, "a visitor may not");
}

async fn grants(h: &Harness, library: &str, claim: &str) -> StatusCode {
    let invite = json!({ "name": "Sam", "addons": ["scout", "atlas"], "installs": { "scout": SCOUT, "atlas": ATLAS } });
    h.send(
        "POST",
        &format!("/lib/{library}/grants"),
        Some(invite.to_string()),
        &[("x-den-library-member", claim), ("content-type", "application/json")],
    )
    .await
    .status()
}

async fn recovery(h: &Harness, claim: &str) -> StatusCode {
    h.send(
        "POST",
        "/recovery",
        Some(json!({ "locator": LOC, "sealed": SEALED }).to_string()),
        &[("x-den-library-member", claim), ("content-type", "application/json")],
    )
    .await
    .status()
}

async fn publish(h: &Harness, claim: &str) -> StatusCode {
    h.send("PUT", "/metadata/title", Some("{}".into()), &[("x-den-library-member", claim)]).await.status()
}

/// A proof of a visitor's library starts a visitor's (a visitor household's profile libraries), a proof of a
/// household's starts a household's, and a visitor's limits follow the tier.
#[tokio::test]
async fn a_proof_decides_the_tier_of_the_library_it_starts() {
    let h = visitors_with_a_member_library(|state| state.visitor_library_max_rows = 2).await;
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK);

    let of_visitor = claim(&id(1));
    assert_eq!(start(&h, &id(2), TOKEN, Some(&of_visitor), "1.1.1.1", rows(1)).await, StatusCode::OK);
    assert!(is_visitor(&h, &id(2)).await, "a visitor household's profile library is a visitor's");

    let of_member = claim(MEMBER_LIB);
    assert_eq!(start(&h, &id(3), TOKEN, Some(&of_member), "1.1.1.1", rows(3)).await, StatusCode::OK);
    assert!(!is_visitor(&h, &id(3)).await, "a household's proof starts a household's");
    assert_eq!(relay(&h, "/scout/manifest.json", &claim(&id(3))).await, StatusCode::BAD_GATEWAY);
    assert_eq!(relay(&h, "/scout/manifest.json", &claim(&id(2))).await, StatusCode::NOT_FOUND);

    let wrong = format!("{MEMBER_LIB}:not-its-token");
    assert_eq!(start(&h, &id(4), TOKEN, Some(&wrong), "1.1.1.1", rows(1)).await, StatusCode::OK);
    assert!(is_visitor(&h, &id(4)).await, "a proof that does not hold proves nothing");

    assert_eq!(
        start(&h, &id(5), TOKEN, Some(&of_visitor), "1.1.1.1", rows(3)).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        "the inherited tier has the visitor's cap"
    );
}

/// The per-address minute limit every mode has, now counting visitors' libraries.
#[tokio::test]
async fn starting_visitor_libraries_is_limited_per_address_a_minute() {
    let h = visitors();
    for n in 0..super::NEW_PER_WINDOW {
        assert_eq!(anonymous(&h, n, "1.1.1.1").await, StatusCode::OK, "{n}");
    }
    let over = send(&h, &id(99), TOKEN, None, "1.1.1.1", rows(1)).await;
    assert_eq!(over.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(retry_after(&over) <= 60);
    assert_eq!(body_json(over).await, json!({ "error": "rate_limited" }));
    assert_eq!(anonymous(&h, 99, "2.2.2.2").await, StatusCode::OK, "another address has its own");
    assert_eq!(anonymous(&h, 0, "1.1.1.1").await, StatusCode::OK, "a library that exists takes writes");
    h.advance(60_000);
    assert_eq!(anonymous(&h, 98, "1.1.1.1").await, StatusCode::OK, "the window clears");
}

/// One address cannot start more than its day's share, however slowly, and the wait it is told runs to the end of
/// its own day's window.
#[tokio::test]
async fn an_address_starts_only_so_many_visitor_libraries_a_day() {
    let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
        configure(state);
        state.visitor_libraries_per_address_daily = 3;
    });
    for n in 0..3 {
        assert_eq!(anonymous(&h, n, "1.1.1.1").await, StatusCode::OK, "{n}");
    }
    let over = send(&h, &id(3), TOKEN, None, "1.1.1.1", rows(1)).await;
    assert_eq!(over.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(retry_after(&over) > 80_000, "to the end of the day's window, not a minute");
    assert_eq!(body_json(over).await, json!({ "error": "rate_limited" }));
    assert_eq!(anonymous(&h, 3, "2.2.2.2").await, StatusCode::OK, "another address has its own day");
    assert_eq!(anonymous(&h, 0, "1.1.1.1").await, StatusCode::OK, "a library that exists takes writes");
    h.advance(DAY_MS);
    assert_eq!(anonymous(&h, 4, "1.1.1.1").await, StatusCode::OK, "a new day");
}

/// The whole store starts only so many a day. An address over its own limit spends none of it, and a household's
/// proof is not stopped by a day the visitors have used up.
#[tokio::test]
async fn the_store_starts_only_so_many_visitor_libraries_a_day() {
    let h = visitors_with_a_member_library(|state| {
        state.visitor_libraries_daily_max = 2;
        state.visitor_libraries_per_address_daily = 1;
    })
    .await;
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK);
    assert_eq!(anonymous(&h, 2, "1.1.1.1").await, StatusCode::TOO_MANY_REQUESTS, "over its own limit");
    assert_eq!(anonymous(&h, 3, "2.2.2.2").await, StatusCode::OK, "so that one cost the day nothing");

    let full = send(&h, &id(4), TOKEN, None, "3.3.3.3", rows(1)).await;
    assert_eq!(full.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(retry_after(&full), (DAY_MS - 1_000_000).div_ceil(1000), "to UTC midnight");
    assert_eq!(body_json(full).await, json!({ "error": "visitor_libraries_full" }));
    assert_eq!(anonymous(&h, 1, "3.3.3.3").await, StatusCode::OK, "libraries that exist keep working");

    let proof = claim(MEMBER_LIB);
    assert_eq!(start(&h, &id(5), TOKEN, Some(&proof), "3.3.3.3", rows(1)).await, StatusCode::OK);
    assert!(!is_visitor(&h, &id(5)).await);

    let text = h.state.metrics.render() + &super::visitor_metrics(&h.state);
    for line in [
        r#"den_edge_library_creations_total{tier="visitor",outcome="created"} 2"#,
        r#"den_edge_library_creations_total{tier="visitor",outcome="address_day"} 1"#,
        r#"den_edge_library_creations_total{tier="visitor",outcome="day_cap"} 1"#,
        r#"den_edge_library_creations_total{tier="member",outcome="created"} 1"#,
        "den_edge_visitor_libraries_today 2",
    ] {
        assert!(text.contains(line), "{line}\n{text}");
    }

    h.advance(DAY_MS);
    assert_eq!(anonymous(&h, 4, "3.3.3.3").await, StatusCode::OK, "tomorrow");
}

#[tokio::test]
async fn a_daily_cap_of_zero_closes_visitor_libraries() {
    let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
        configure(state);
        state.visitor_libraries_daily_max = 0;
    });
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::SERVICE_UNAVAILABLE);
    assert!(h.state.library_v3.credentials(&id(1)).unwrap().is_none(), "a refusal starts no library");
}

/// A retried first write whose answer was lost finds the library started, and spends nothing of the allowances.
#[tokio::test]
async fn a_retried_first_write_is_not_counted_twice() {
    let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
        configure(state);
        state.visitor_libraries_per_address_daily = 1;
    });
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK);
    for _ in 0..3 {
        let again = json!([{ "k": key(0), "base": 0, "v": "v" }]);
        let resp = send(&h, &id(1), TOKEN, None, "1.1.1.1", again).await;
        assert_eq!(resp.status(), StatusCode::OK, "a conflict is a 200 with the row");
    }
    assert!(super::visitor_metrics(&h.state).contains("den_edge_visitor_libraries_today 1"));
}

/// A visitor's library holds fewer rows and bytes than a household's, and a refused first write starts nothing.
#[tokio::test]
async fn a_visitor_library_is_full_sooner_than_a_household_library() {
    let h = visitors_with_a_member_library(|state| {
        state.visitor_library_max_rows = 3;
        state.visitor_library_max_bytes = 120;
    })
    .await;
    let full = json!({ "error": "library_full" });
    let first = send(&h, &id(1), TOKEN, None, "1.1.1.1", rows(4)).await;
    assert_eq!((first.status(), body_json(first).await), (StatusCode::PAYLOAD_TOO_LARGE, full.clone()));
    assert_eq!(start(&h, &id(1), TOKEN, None, "1.1.1.1", rows(3)).await, StatusCode::OK);

    let more = send(&h, &id(1), TOKEN, None, "1.1.1.1", json!([{ "k": key(9), "base": 0, "v": "v" }])).await;
    assert_eq!((more.status(), body_json(more).await), (StatusCode::PAYLOAD_TOO_LARGE, full.clone()));
    let rewrite = json!([{ "k": key(0), "base": 1, "v": "w" }]);
    assert_eq!(
        start(&h, &id(1), TOKEN, None, "1.1.1.1", rewrite).await,
        StatusCode::OK,
        "a row it holds is fine"
    );

    let heavy = json!([{ "k": key(0), "base": 0, "v": "x".repeat(200) }]);
    let bytes = send(&h, &id(2), TOKEN, None, "1.1.1.1", heavy.clone()).await;
    assert_eq!((bytes.status(), body_json(bytes).await), (StatusCode::PAYLOAD_TOO_LARGE, full));
    let proof = claim(MEMBER_LIB);
    assert_eq!(
        start(&h, &id(3), TOKEN, Some(&proof), "1.1.1.1", heavy).await,
        StatusCode::OK,
        "a household's holds it"
    );
}

/// A visitor cannot get past its caps by replacing its rows in bulk.
#[tokio::test]
async fn a_staged_rewrite_has_the_visitors_cap_too() {
    let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
        configure(state);
        state.visitor_library_max_rows = 3;
    });
    let library = id(1);
    let first = send(&h, &library, TOKEN, None, "1.1.1.1", rows(1)).await;
    assert_eq!(first.status(), StatusCode::OK);
    let generation = first.headers()[super::GENERATION_HEADER].to_str().unwrap().to_owned();
    let headers = [
        ("x-den-library-token", TOKEN),
        (super::WIRE_HEADER, "3"),
        (super::GENERATION_HEADER, generation.as_str()),
    ];
    let opened = h.send("POST", &format!("/lib/{library}/rewrite"), None, &headers).await;
    assert_eq!(opened.status(), StatusCode::OK);
    let rewrite = body_json(opened).await["rewrite"].as_str().unwrap().to_owned();
    let stage = |n: u32| {
        let writes: Vec<Value> = (0..n).map(|i| json!({ "k": key(i), "v": "v" })).collect();
        json!({ "writes": writes }).to_string()
    };
    let path = format!("/lib/{library}/rewrite/{rewrite}/rows");
    assert_eq!(h.send("POST", &path, Some(stage(3)), &headers).await.status(), StatusCode::OK);
    assert_eq!(h.send("POST", &path, Some(stage(4)), &headers).await.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

/// The budget on one library's writes is the same for a visitor's.
#[tokio::test]
async fn a_visitor_library_has_the_per_library_write_budget() {
    let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
        configure(state);
        state.library_write_burst = 2;
        state.library_write_per_minute = 1;
    });
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK);
    assert_eq!(anonymous(&h, 1, "1.1.1.1").await, StatusCode::OK);
    let over = send(&h, &id(1), TOKEN, None, "1.1.1.1", rows(1)).await;
    assert_eq!(over.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(over.headers().contains_key("retry-after"));
}

/// `members` and `open` are what they were: no tier is recorded, no visitor limit applies, and every library is a
/// household's.
#[tokio::test]
async fn the_other_modes_start_no_visitors() {
    for mode in [NewLibraries::Open, NewLibraries::Members] {
        let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
            configure(state);
            state.new_libraries = mode;
            state.visitor_libraries_daily_max = 0;
            state.visitor_library_max_rows = 1;
        });
        let status = anonymous(&h, 1, "1.1.1.1").await;
        match mode {
            NewLibraries::Open => {
                assert_eq!(status, StatusCode::OK);
                assert!(!is_visitor(&h, &id(1)).await);
                assert_eq!(
                    start(&h, &id(1), TOKEN, None, "1.1.1.1", rows(2)).await,
                    StatusCode::OK,
                    "no visitor cap"
                );
            }
            _ => assert_eq!(status, StatusCode::FORBIDDEN),
        }
    }
}
