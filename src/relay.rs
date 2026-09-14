//! The addons' JSON routes relayed from the web app's own origin (`ADDON_RELAY`, oxyc/den#15). On its public name
//! the web app asks `/scout/…` and `/atlas/…` here, and den-edge fetches them at the addon's LAN address — as
//! `tailscale serve` does on the tailnet. So the browser needs no Cloudflare Access service token (which stays on
//! the TVs), no CORS preflight past Access, and a library's LAN install URLs work as they are. Mostly JSON
//! goes through; the exception is den-reel's trailer, which is streamed with its ranges intact because on a
//! public name there is no address a browser can fetch it from directly. den-remux's video never takes this
//! path — the player is given its own origin.

use crate::handler::{error, raw_json, MAX_BODY_BYTES};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use std::sync::Arc;
use std::time::Duration;

/// Plain HTTP: every target is a LAN address.
pub type RelayClient = Client<HttpConnector, Full<Bytes>>;

pub fn client() -> RelayClient {
    Client::builder(TokioExecutor::new()).build_http()
}

/// Past scout's scrape timeout on a slow indexer (8 s), with its answer still to come.
const TIMEOUT: Duration = Duration::from_secs(30);
/// An addon's JSON answer — a catalog page, an index slice — is far under this.
const MAX_ANSWER_BYTES: usize = 8 * 1024 * 1024;
/// Relayed fetches per address per minute.
///
/// Both were first set as though a page were a handful of requests. It is not: one home render is four
/// recommend calls, the rows, reel's meta and direct for each slide it settles on, and an availability sweep —
/// dozens before anyone has touched anything. At thirty a minute a paired household was refused mid-render and
/// the trailers simply stopped, and a guest would have met the same wall.
///
/// What actually protects the addons from a flood is `MAX_IN_FLIGHT` below, which bounds what is happening at
/// once. These two bound the sustained rate, so they can be generous: enough that ordinary browsing never
/// notices them, and low enough that mining every title through this origin does.
const MEMBER_PER_WINDOW: u32 = 600;
const GUEST_PER_WINDOW: u32 = 120;
/// Relayed fetches in flight at once, across everyone. The addons are one small box: without this a handful of
/// visitors on a public name can hold every upstream socket and starve the TVs that actually live here.
pub(crate) const MAX_IN_FLIGHT: usize = 16;
/// Media fetches per address per minute, counted apart from the JSON above.
///
/// One playback is many requests, not one: a video element opens a range, seeks, and opens another. Charging
/// those against a page's allowance would spend it on a single trailer and refuse the page around it.
const MEDIA_PER_WINDOW: u32 = 600;
/// How long a request waits for one of those slots before giving up, so a queue can't grow without bound.
const SLOT_WAIT: Duration = Duration::from_secs(5);

/// Where `path_and_query` goes when it is under one of `relays`: that addon's LAN origin with the rest of it.
pub fn target(relays: &[(String, String)], path_and_query: &str) -> Option<String> {
    relays.iter().find_map(|(prefix, origin)| {
        let rest = path_and_query.strip_prefix(prefix.as_str())?;
        match rest.chars().next() {
            None => Some(format!("{origin}/")),
            Some('/') => Some(format!("{origin}{rest}")),
            Some('?') => Some(format!("{origin}/{rest}")),
            _ => None,
        }
    })
}

/// Guest trailer streams that may run at once. Small on purpose: the household's upload is what a
/// stranger's stream spends, and the TVs in the house are on the other side of it.
pub(crate) const GUEST_MEDIA_STREAMS: usize = 3;
/// How long an admitted session stands with no request before its slot comes back. Long enough to
/// cover the gap between segments — a player fetches one every few seconds and pauses between them —
/// and short enough that a closed tab does not hold a slot for long.
const LEASE_IDLE_MS: u64 = 30_000;
/// What a refused guest is told to wait. A slot frees when someone stops watching, not on a timer, so
/// this is a polite interval rather than a promise.
const MEDIA_BUSY_RETRY_MS: u64 = 30_000;

/// One admitted trailer session.
///
/// Admission is decided once — at the master playlist, or at a first `/play` for a video with nothing
/// open — and everything that follows rides on it. A guest's lease owns one of `guest_media_slots`;
/// dropping the lease is what returns it.
pub struct Lease {
    member: bool,
    until: u64,
    _slot: Option<tokio::sync::OwnedSemaphorePermit>,
}

/// What admission decided.
enum Admitted {
    /// Play on. `guest` says whether these bytes count against the guest ceiling.
    Yes { guest: bool },
    /// Every guest slot is taken.
    Busy,
    /// Today's guest allowance is gone.
    Spent,
}

/// The membership this request claims, if any: `<id>:<token>` as the app sends it.
fn member_claim(req: &Request) -> Option<String> {
    req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// The video a request is for, when it names one.
///
/// A master (`/hls/<id>.m3u8`) and a file (`/play/<id>.mp4`) do; a segment does not — its own URL is
/// carried in the query, and the id never appears. So a segment is matched against whatever that
/// address already has open, which is exactly what it belongs to.
fn media_video(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/reel/")?;
    let (kind, file) = rest.rsplit_once('/')?;
    if !kind.ends_with("hls") && !kind.ends_with("play") {
        return None;
    }
    file.rsplit_once('.').map(|(id, _)| id).filter(|id| !id.is_empty())
}

/// Let this request in, or say why not.
///
/// The first request for a video is the one that is judged: a household member is admitted free, a
/// guest takes a slot and has to be inside the day's allowance. Everything after it — every segment,
/// every range — belongs to that lease and is never refused, because a stall mid-trailer is worse
/// than a clean refusal at the start, which the page turns into YouTube's embed.
async fn admit(state: &AppState, claim: Option<&str>, bucket: &str, video: Option<&str>) -> Admitted {
    let now = (state.clock)();
    let key = video.map(|id| format!("{bucket}|{id}"));
    {
        let mut leases = crate::lock(&state.media_leases);
        leases.retain(|_, lease| lease.until > now);
        // A segment names no video, so it rides on anything this address has open — which is what it
        // is a segment of. Refreshing them all keeps a playing trailer's lease alive.
        let mut found = false;
        for (at, lease) in leases.iter_mut() {
            let mine = key.as_deref() == Some(at.as_str()) || (video.is_none() && at.starts_with(bucket));
            if mine {
                lease.until = now + LEASE_IDLE_MS;
                found = true;
                if key.is_some() {
                    return Admitted::Yes { guest: !lease.member };
                }
            }
        }
        if found {
            return Admitted::Yes { guest: true };
        }
    }
    // Nothing open for this address: this is a session starting, and the only place membership is
    // asked. Once per session, never per segment — the lease remembers the answer.
    let member = crate::library::is_member(state, claim).await;
    let slot = if member {
        None
    } else {
        if !media_allowance_left(state) {
            return Admitted::Spent;
        }
        match Arc::clone(&state.guest_media_slots).try_acquire_owned() {
            Ok(slot) => Some(slot),
            Err(_) => return Admitted::Busy,
        }
    };
    let mut leases = crate::lock(&state.media_leases);
    leases.insert(
        key.unwrap_or_else(|| format!("{bucket}|seg")),
        Lease { member, until: now + LEASE_IDLE_MS, _slot: slot },
    );
    Admitted::Yes { guest: !member }
}

/// Is there anything left of today's guest allowance (env `MEDIA_DAILY_MAX_BYTES`)?
///
/// Read at admission only. A stream that has started is never cut off part-way: the ceiling decides
/// whether a new trailer may begin, not whether one already playing may finish.
fn media_allowance_left(state: &AppState) -> bool {
    let Some(max) = state.media_daily_max else { return true };
    let day = (state.clock)() / 86_400_000;
    let mut spent = crate::lock(&state.media_spent);
    if spent.0 != day {
        *spent = (day, 0);
    }
    if spent.1 >= max {
        // Once for the day, not once per refusal: a ceiling that announced itself only as a 503 to
        // whoever asked next is a drain nobody sees until someone complains.
        if spent.1 == max {
            spent.1 = max + 1;
            eprintln!(
                "media: guest trailer allowance of {max} bytes spent — guests fall back to YouTube's embed until UTC midnight. Members are unaffected."
            );
        }
        return false;
    }
    true
}

pub async fn relay(
    state: &AppState,
    req: Request,
    target: String,
    rid: &str,
    face: crate::handler::Face,
) -> Response {
    let method = req.method().clone();
    if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    // On the public web name, scout answers only to a device that holds a library here.
    //
    // Not about bandwidth: scout's `/configure` and `/config-key` are reachable through this relay, and
    // scout still takes an unsealed config — so a stranger could mint an install carrying their own
    // debrid key, and the indexer scraping that install causes would leave from this house's address.
    // What that costs is the address itself: indexers rate-limit and blocklist by IP, and the household
    // is what gets blocked. It is also the reason the public `d-scout` name sits behind Access.
    //
    // A refusal is the 404 an unknown route gets, so the gate never advertises what it is hiding. The
    // LAN and tailnet faces are untouched — a TV reaches scout directly, never through here.
    if face == crate::handler::Face::Web && req.uri().path().starts_with("/scout/") {
        let claim = member_claim(&req);
        if !crate::library::is_member(state, claim.as_deref()).await {
            return json(StatusCode::NOT_FOUND, "not_found");
        }
    }
    // The visitor's budget is spent first, and only an address past it is asked whether it is a member and has
    // the larger one. That order is deliberate: checking membership first would let a forged member header make
    // every relayed request do a library lookup, which is the work this limit exists to protect.
    let ip = crate::handler::client_ip(state, &req);
    // A trailer's bytes come through here or not at all. On the public name a browser cannot reach reel
    // directly — its only https address there is the tailnet's, which does not resolve for anyone off it — so
    // the video has to be served from this origin. Streamed rather than collected, and on its own budget.
    if media(req.uri().path()) && !native_master(req.uri().path(), req.uri().query()) {
        if let Some(wait) = crate::link::throttled_at(state, &format!("relay-media:{ip}"), MEDIA_PER_WINDOW) {
            return limited(wait);
        }
        let video = media_video(req.uri().path()).map(str::to_owned);
        // Read here rather than inside `admit`: an async fn holding a `&Request` is not `Send`, and
        // this one is awaited inside the handler.
        let claim = member_claim(&req);
        return match admit(state, claim.as_deref(), &ip, video.as_deref()).await {
            Admitted::Yes { guest } => stream(state, req, target, rid, guest).await,
            // Said at the start of a trailer, where the page can turn it into YouTube's embed. Never
            // part-way through one: that would be a stall, and a player would simply keep asking.
            Admitted::Busy => crate::handler::retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &error("media_busy"),
                MEDIA_BUSY_RETRY_MS,
            ),
            Admitted::Spent => crate::handler::retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &error("media_daily_spent"),
                MEDIA_BUSY_RETRY_MS,
            ),
        };
    }
    if let Some(visitor_wait) = crate::link::throttled_at(state, &format!("relay:{ip}"), GUEST_PER_WINDOW) {
        let member =
            req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
        if !crate::library::is_member(state, member.as_deref()).await {
            return limited(visitor_wait);
        }
        if let Some(wait) = crate::link::throttled_at(state, &format!("relay-member:{ip}"), MEMBER_PER_WINDOW)
        {
            return limited(wait);
        }
    }
    // Held until this answer is done with, so the cap counts what is actually in flight upstream.
    let slot = tokio::time::timeout(SLOT_WAIT, Arc::clone(&state.relay_slots).acquire_owned()).await;
    let _slot = match slot {
        Ok(Ok(permit)) => permit,
        // Every slot is taken: the wait it just spent is also how long the next caller should give it.
        _ => {
            return crate::handler::retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &error("relay_busy"),
                SLOT_WAIT.as_millis() as u64,
            )
        }
    };
    let content_type = req.headers().get(header::CONTENT_TYPE).cloned();
    let conditions: Vec<_> = [header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE, header::ACCEPT_ENCODING]
        .into_iter()
        .filter_map(|name| req.headers().get(&name).cloned().map(|value| (name, value)))
        .collect();
    let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES).await else {
        return json(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");
    };
    // Nothing of the browser's goes along but what the addon reads: not its cookies, which carry its Access
    // session, nor anything Cloudflare added. Its validators do, so a revalidation is the addon's 304 rather
    // than the whole answer again, and the encodings it takes, so a large file (atlas's labels) arrives gzipped
    // and within `MAX_ANSWER_BYTES`.
    // This request's id goes with it. The addon logs one line per request and so does this server; without a
    // shared id the two are impossible to put side by side afterwards, which is exactly when you want to.
    let mut out = axum::http::Request::builder()
        .method(method)
        .uri(&target)
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid);
    if let Some(content_type) = content_type {
        out = out.header(header::CONTENT_TYPE, content_type);
    }
    for (name, value) in conditions {
        out = out.header(name, value);
    }
    let Ok(out) = out.body(Full::new(body)) else { return json(StatusCode::BAD_REQUEST, "bad_request") };
    let answer = match tokio::time::timeout(TIMEOUT, state.relay_client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("relay: {e}");
            return json(StatusCode::BAD_GATEWAY, "addon_unreachable");
        }
        Err(_) => return json(StatusCode::GATEWAY_TIMEOUT, "addon_timeout"),
    };
    let (parts, body) = answer.into_parts();
    let Ok(bytes) = Limited::new(body, MAX_ANSWER_BYTES).collect().await.map(|c| c.to_bytes()) else {
        return json(StatusCode::BAD_GATEWAY, "addon_answer_unreadable");
    };
    // Only the answer's cache policy, its validators and diagnostic fields cross this boundary. In particular
    // an upstream cannot set a cookie, redirect the browser, or grant another origin access.
    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = parts.status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_ENCODING,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
        header::VARY,
        // An addon's own rate limit, which the browser can only honour if it is allowed to hear it. Without
        // this the page met a bare 429 and did what every client here does with one: came straight back.
        header::RETRY_AFTER,
        header::HeaderName::from_static("server-timing"),
        header::HeaderName::from_static("x-den-degraded"),
    ] {
        if let Some(value) = parts.headers.get(&name) {
            resp.headers_mut().insert(name, value.clone());
        }
    }
    resp
}

/// Is this relayed path a trailer's bytes rather than JSON? Reel's `/play/<id>.mp4`, and the playlist and
/// segments that will join it. An install's config sits between the prefix and these, so the segment is looked
/// for rather than positioned — but only under reel, so no other addon can be streamed through by naming a
/// path after one of these.
fn media(path: &str) -> bool {
    path.strip_prefix("/reel/")
        .is_some_and(|rest| rest.split('/').any(|segment| matches!(segment, "play" | "hls" | "seg")))
}

/// A master a bare `<video>` plays by itself (`?native=1`), which is not a stream through here.
///
/// reel answers it with YouTube's own segment URLs left in place, so the element fetches every byte
/// from Google and this box carries the playlist alone: four kilobytes, once per trailer.
///
/// Gating it as media was wrong in exactly the place it mattered. A media element cannot send the
/// membership header the way hls.js does through `xhrSetup`, so every phone in the household arrived
/// here as a guest, three trailers filled the cap, and the next one was refused — on the household's
/// own box. The ceiling still binds what is actually carried: `/hls/seg` finds no lease open and
/// takes a slot of its own, so asking for a native master buys nothing but the playlist.
fn native_master(path: &str, query: Option<&str>) -> bool {
    media_video(path).is_some()
        && path.ends_with(".m3u8")
        && query.is_some_and(|q| q.split('&').any(|p| p == "native=1"))
}

/// Media, passed through as it arrives.
///
/// Nothing here collects the body: a trailer is tens of megabytes and the JSON path's ceiling is eight, so
/// collecting would refuse it — and holding it in memory to hand on would be the wrong shape anyway. The
/// range headers travel in both directions, because a video element opens a range, seeks, and opens another,
/// and a player denied `Accept-Ranges` cannot seek at all.
///
/// It takes no in-flight slot. Those bound what is happening at once against a box of one addon, and a
/// trailer playing for two minutes would hold one for two minutes — sixteen viewers would be the whole pool.
async fn stream(state: &AppState, req: Request, target: String, rid: &str, guest: bool) -> Response {
    let method = req.method().clone();
    let asked: Vec<_> = [header::RANGE, header::IF_RANGE, header::IF_NONE_MATCH, header::ACCEPT_ENCODING]
        .into_iter()
        .filter_map(|name| req.headers().get(&name).cloned().map(|value| (name, value)))
        .collect();
    let mut out = axum::http::Request::builder().method(method).uri(&target).header("x-request-id", rid);
    for (name, value) in asked {
        out = out.header(name, value);
    }
    let Ok(out) = out.body(Full::new(Bytes::new())) else {
        return json(StatusCode::BAD_REQUEST, "bad_request");
    };
    // The timeout covers reaching the addon and its answer's head, not the body: a trailer takes as long as
    // it takes to send, and cutting it off mid-stream would be a truncated file rather than an error.
    let answer = match tokio::time::timeout(TIMEOUT, state.relay_client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("relay media: {e}");
            return json(StatusCode::BAD_GATEWAY, "addon_unreachable");
        }
        Err(_) => return json(StatusCode::GATEWAY_TIMEOUT, "addon_timeout"),
    };
    let (parts, body) = answer.into_parts();
    // A guest's bytes are counted as they leave, not estimated from a header: a range request, a
    // player that seeks, a tab closed mid-segment all send a different number than `Content-Length`
    // claims. A member's bytes are not counted at all — the ceiling is a guest ceiling.
    let body = if guest {
        let spent = Arc::clone(&state.media_spent);
        let day = (state.clock)() / 86_400_000;
        Body::new(body.map_frame(move |frame| {
            if let Some(data) = frame.data_ref() {
                let mut spent = crate::lock(&spent);
                if spent.0 != day {
                    *spent = (day, 0);
                }
                spent.1 = spent.1.saturating_add(data.len() as u64);
            }
            frame
        }))
    } else {
        Body::new(body)
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = parts.status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CONTENT_ENCODING,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
        header::VARY,
        header::RETRY_AFTER,
        header::HeaderName::from_static("server-timing"),
    ] {
        if let Some(value) = parts.headers.get(&name) {
            resp.headers_mut().insert(name, value.clone());
        }
    }
    resp
}

fn json(status: StatusCode, code: &str) -> Response {
    raw_json(status, Body::from(error(code).to_string()), true)
}

/// A refusal that says when the window clears, rather than leaving the caller to guess and come straight back.
fn limited(after_ms: u64) -> Response {
    crate::handler::retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), after_ms)
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;
    use std::sync::Arc;

    const LIB: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "the-write-token";

    /// Relaying `/scout` at a port nothing listens on: whatever gets past the limit fails at the fetch, which is
    /// all these need to tell an allowed request from a refused one.
    fn harness() -> Harness {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays("/scout=http://127.0.0.1:9");
        h
    }

    async fn ask(h: &Harness, headers: &[(&str, &str)]) -> StatusCode {
        h.send("GET", "/scout/manifest.json", None, headers).await.status()
    }

    /// A public name is an unmetered proxy to the addons without this — including atlas's half-megabyte labels.
    #[tokio::test]
    async fn a_visitor_gets_a_visitors_allowance() {
        let h = harness();
        for i in 0..super::GUEST_PER_WINDOW {
            assert_eq!(ask(&h, &[]).await, StatusCode::BAD_GATEWAY, "{i}");
        }
        let refused = h.send("GET", "/scout/manifest.json", None, &[]).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        // A refusal that does not say when the window clears is one the caller simply repeats — which is
        // what every client here did with a bare 429, on a fixed few seconds, indefinitely.
        assert!(refused.headers().contains_key("retry-after"), "the refusal never said when to return");
    }

    /// One page of the billboard fans out into many addon calls, so a household that has paired a TV must not be
    /// held to a stranger's budget.
    #[tokio::test]
    async fn a_member_browses_past_the_visitors_allowance() {
        let h = harness();
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK, "the library this membership is proved against");

        let member = format!("{LIB}:{TOKEN}");
        for i in 0..super::GUEST_PER_WINDOW + 10 {
            let status = ask(&h, &[("x-den-library-member", &member)]).await;
            assert_eq!(status, StatusCode::BAD_GATEWAY, "{i}");
        }
        // The token is what earns it: a guessed id with the wrong token is a visitor, whose budget is now spent.
        let forged = format!("{LIB}:not-the-token");
        assert_eq!(ask(&h, &[("x-den-library-member", &forged)]).await, StatusCode::TOO_MANY_REQUESTS);
    }

    /// Scout's `/configure` mints installs, and an install a stranger makes scrapes indexers from this
    /// household's address — which is what indexers blocklist. So on the public web name it answers only
    /// to a device that holds a library here, and to anyone else it is not there at all.
    #[tokio::test]
    async fn on_the_web_name_scout_answers_only_to_a_member() {
        let mut h = harness();
        Arc::get_mut(&mut h.state).unwrap().web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");

        let guest = h.send("GET", "/scout/manifest.json", None, &[("host", "d.oxy.fi")]).await;
        assert_eq!(guest.status(), StatusCode::NOT_FOUND, "and nothing says what is being hidden");

        // The LAN and tailnet names are untouched: a TV reaches scout directly, never through here.
        let lan = h.send("GET", "/scout/manifest.json", None, &[]).await;
        assert_eq!(lan.status(), StatusCode::BAD_GATEWAY, "relayed as it always was");

        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK, "the library this membership is proved against");

        let member = format!("{LIB}:{TOKEN}");
        let paired = h
            .send(
                "GET",
                "/scout/manifest.json",
                None,
                &[("host", "d.oxy.fi"), ("x-den-library-member", &member)],
            )
            .await;
        assert_eq!(paired.status(), StatusCode::BAD_GATEWAY, "relayed, and the addon is not there");
    }

    /// Relaying `/reel` at a port nothing listens on: an admitted request reaches the fetch and fails
    /// there (502), a refused one never gets that far (503). That is the whole distinction these need.
    fn reel() -> Harness {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays("/reel=http://127.0.0.1:9");
        h
    }

    /// The cap is on trailers playing at once, because that is what spends the household's upload —
    /// not on requests, which a rate limit already bounds.
    #[tokio::test]
    async fn a_guest_trailer_holds_a_slot_and_the_next_guest_is_turned_away() {
        let mut h = reel();
        Arc::get_mut(&mut h.state).unwrap().guest_media_slots = Arc::new(tokio::sync::Semaphore::new(1));

        let first = h.send("GET", "/reel/hls/aaaaaaaaaaa.m3u8", None, &[]).await;
        assert_eq!(first.status(), StatusCode::BAD_GATEWAY, "admitted, and the addon is not there");

        let second = h.send("GET", "/reel/hls/bbbbbbbbbbb.m3u8", None, &[]).await;
        assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE, "the only slot is taken");
        // Refused at the start of a trailer, where the page turns it into YouTube's embed, and told
        // when to come back rather than left to guess.
        assert!(second.headers().contains_key("retry-after"));

        // A segment names no video, so it rides on what this address already has open. Refusing one
        // would stall a trailer that is already playing instead of falling back cleanly.
        let segment = h.send("GET", "/reel/hls/seg?u=https%3A%2F%2Fr1.googlevideo.com%2Fx", None, &[]).await;
        assert_eq!(segment.status(), StatusCode::BAD_GATEWAY, "belongs to the admitted session");
    }

    /// The household is not a guest on its own box: every browser in it goes through this relay, so a
    /// cap that counted them would cap the people who own the thing.
    #[tokio::test]
    async fn a_member_takes_no_guest_slot() {
        let mut h = reel();
        Arc::get_mut(&mut h.state).unwrap().guest_media_slots = Arc::new(tokio::sync::Semaphore::new(0));
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK, "the library this membership is proved against");

        let member = format!("{LIB}:{TOKEN}");
        let mine =
            h.send("GET", "/reel/hls/aaaaaaaaaaa.m3u8", None, &[("x-den-library-member", &member)]).await;
        assert_eq!(mine.status(), StatusCode::BAD_GATEWAY, "admitted with no slot to take");

        let guest = h.send("GET", "/reel/hls/bbbbbbbbbbb.m3u8", None, &[]).await;
        assert_eq!(guest.status(), StatusCode::SERVICE_UNAVAILABLE, "a guest still needs one");
    }

    /// The ceiling the concurrency cap cannot be: three streams running all day is still three streams.
    #[tokio::test]
    async fn a_spent_daily_allowance_turns_a_guest_away_but_not_a_member() {
        let mut h = reel();
        Arc::get_mut(&mut h.state).unwrap().media_daily_max = Some(0);
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;

        let guest = h.send("GET", "/reel/hls/aaaaaaaaaaa.m3u8", None, &[]).await;
        assert_eq!(guest.status(), StatusCode::SERVICE_UNAVAILABLE);

        let member = format!("{LIB}:{TOKEN}");
        let mine =
            h.send("GET", "/reel/hls/bbbbbbbbbbb.m3u8", None, &[("x-den-library-member", &member)]).await;
        assert_eq!(mine.status(), StatusCode::BAD_GATEWAY, "a guest ceiling is not the household's");
    }

    /// The playlist a bare element plays by itself carries no stream through here: the segments in it
    /// are Google's own URLs, and the element fetches them direct. Gating it capped the household's
    /// own phones, because a media element cannot send the membership header that hls.js sends.
    #[tokio::test]
    async fn a_native_master_takes_no_guest_slot() {
        let mut h = reel();
        Arc::get_mut(&mut h.state).unwrap().guest_media_slots = Arc::new(tokio::sync::Semaphore::new(0));

        let native = h.send("GET", "/reel/hls/aaaaaaaaaaa.m3u8?native=1", None, &[]).await;
        assert_eq!(native.status(), StatusCode::BAD_GATEWAY, "relayed with no slot to take");

        // The proxied master still opens a session, because its segments do come through here.
        let proxied = h.send("GET", "/reel/hls/aaaaaaaaaaa.m3u8", None, &[]).await;
        assert_eq!(proxied.status(), StatusCode::SERVICE_UNAVAILABLE, "that one is a stream");

        // And the flag buys nothing on the bytes: a segment with no lease open takes a slot itself.
        let segment =
            h.send("GET", "/reel/hls/seg?u=https%3A%2F%2Fr1.googlevideo.com%2Fx&native=1", None, &[]).await;
        assert_eq!(segment.status(), StatusCode::SERVICE_UNAVAILABLE, "a segment is still carried");
    }

    #[test]
    fn only_a_playlist_asked_for_natively_is_exempt() {
        assert!(super::native_master("/reel/hls/dQw4w9WgXcQ.m3u8", Some("s=tag&native=1")));
        assert!(!super::native_master("/reel/hls/dQw4w9WgXcQ.m3u8", Some("s=tag")));
        assert!(!super::native_master("/reel/hls/dQw4w9WgXcQ.m3u8", None));
        // The file and the segments are what this box carries, whatever they ask for.
        assert!(!super::native_master("/reel/play/dQw4w9WgXcQ.mp4", Some("native=1")));
        assert!(!super::native_master("/reel/hls/seg", Some("u=x&native=1")));
    }

    /// A master and a file name their video; a segment carries its own URL in the query and names none.
    #[test]
    fn a_media_path_names_its_video_where_it_has_one() {
        assert_eq!(super::media_video("/reel/hls/dQw4w9WgXcQ.m3u8"), Some("dQw4w9WgXcQ"));
        assert_eq!(super::media_video("/reel/cfg/play/dQw4w9WgXcQ.mp4"), Some("dQw4w9WgXcQ"));
        assert_eq!(super::media_video("/reel/hls/seg"), None);
        assert_eq!(super::media_video("/reel/cfg/meta/movie/tmdb:550.json"), None);
    }

    /// A trailer's bytes are streamed and a lookup is not, and nothing outside reel is streamed at all —
    /// otherwise any addon could be proxied without a ceiling by naming a path `/play/`.
    #[test]
    fn only_reels_own_media_paths_stream() {
        for path in ["/reel/play/abc.mp4", "/reel/cfg/play/abc.mp4", "/reel/hls/abc.m3u8", "/reel/seg/1.ts"] {
            assert!(super::media(path), "{path}");
        }
        for path in [
            "/reel/cfg/meta/movie/tmdb:550.json",
            "/reel/direct/abc.json",
            "/scout/cfg/play/ticket",
            "/atlas/recommend",
            "/playlist",
        ] {
            assert!(!super::media(path), "{path}");
        }
    }
}
