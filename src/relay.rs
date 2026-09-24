//! The addons' JSON routes relayed from the web app's own origin (`ADDON_RELAY`, oxyc/den#15). On its public name
//! the web app asks `/scout/…` and `/atlas/…` here, and den-edge fetches them at the addon's LAN address — as
//! `tailscale serve` does on the tailnet. So the browser needs no Cloudflare Access service token (which stays on
//! the TVs), no CORS preflight past Access, and a library's LAN install URLs work as they are. Mostly JSON
//! goes through; the exception is den-reel's trailer, which is streamed with its ranges intact because on a
//! public name there is no address a browser can fetch it from directly. den-remux's control JSON may take this
//! path for a member; its video never does — the player is given a signed URL on the public IP-literal origin.

use crate::handler::{error, json_reply, ListenerScope, MAX_BODY_BYTES};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
pub(crate) const GUEST_PER_WINDOW: u32 = 120;
/// Relayed calls per grant per minute, whoever they come from: guests share NATs, so the per-address budget
/// alone would let one grant spread its browsing over many addresses.
pub(crate) const GRANT_PER_WINDOW: u32 = 300;
/// Relayed fetches in flight at once, across everyone. The addons are one small box: without this a handful of
/// visitors on a public name can hold every upstream socket and starve the TVs that actually live here.
pub(crate) const MAX_IN_FLIGHT: usize = 16;
/// Media fetches per address per minute, counted apart from the JSON above.
///
/// One playback is many requests, not one: a video element opens a range, seeks, and opens another. Charging
/// those against a page's allowance would spend it on a single trailer and refuse the page around it.
const MEDIA_PER_WINDOW: u32 = 600;
/// Calls per address per minute to atlas's tuning playground (`/atlas/playground…`), counted apart from the
/// relay budget above and in its place, so tuning never spends a visitor's browsing allowance and browsing never
/// spends tuning's.
///
/// A tuned row is computed per request and never cached: ~7 ms and ~14 KB at the defaults, up to ~50 ms and
/// ~0.7 MB at the knobs' limits. At the relay's 120 a minute one address could pull ~84 MB a minute of the
/// household's upload through it; at 30 it is ~21 MB. The page ranks only when a person presses Rank or picks an
/// anchor, so 30 — one every two seconds — is more than a person tuning by hand asks for. Members get no larger
/// one: the page sends no membership header, so there would be nothing to earn it with.
pub(crate) const PLAYGROUND_PER_WINDOW: u32 = 30;
/// Playground calls in flight at once, across everyone, inside `MAX_IN_FLIGHT`. However many addresses call it,
/// the other twelve relay slots stay for the web app. Four covers a person clicking anchors faster than the
/// answers come back, and a second person tuning at the same time.
pub(crate) const PLAYGROUND_IN_FLIGHT: usize = 4;
/// What a caller refused a playground slot is told to wait: an answer takes tens of milliseconds, so a slot is
/// back well within it.
const PLAYGROUND_BUSY_RETRY_MS: u64 = 1_000;
/// How long a request waits for one of those slots before giving up, so a queue can't grow without bound.
const SLOT_WAIT: Duration = Duration::from_secs(5);
const FAILED_SESSION_CLEANUP_TIMEOUT: Duration = Duration::from_secs(3);
/// Distinct `ipv4Hint` addresses one member's rate-limit bucket (an IPv6 /64) may have the media listener opened
/// for within `MEMBER_HINT_TTL_MS`. A household's few devices, and a carrier that moves them now and then, fit well
/// inside it; a page cycling through made-up addresses does not.
pub(crate) const MEMBER_HINTS: usize = 4;
const MEMBER_HINT_TTL_MS: u64 = 60 * 60 * 1000;

/// Where `path_and_query` goes when it is under one of `relays`: that addon's LAN origin with the rest of it.
pub fn target(relays: &[(String, String)], path_and_query: &str) -> Option<String> {
    relays.iter().find_map(|(prefix, origin)| {
        let rest = path_and_query.strip_prefix(prefix.as_str())?;
        // den-remux is mounted at /remux in its own HTTP API as well as in the web relay. The other
        // addons are mounted only by den-edge and therefore have their relay prefix stripped.
        let keep_prefix = prefix == "/remux";
        match rest.chars().next() {
            None if keep_prefix => Some(format!("{origin}{prefix}/")),
            None => Some(format!("{origin}/")),
            Some('/') if keep_prefix => Some(format!("{origin}{prefix}{rest}")),
            Some('/') => Some(format!("{origin}{rest}")),
            Some('?') if keep_prefix => Some(format!("{origin}{prefix}/{rest}")),
            Some('?') => Some(format!("{origin}/{rest}")),
            _ => None,
        }
    })
}

/// The den-remux routes this relay passes: its control JSON, and `/speed` — random bytes a player away from home times
/// its link by before it starts a session, so the first session it asks for already fits. Never its video.
///
/// `/remux/grant` is this server's own: a player whose session is already open asks for the media listener to be
/// opened again for the address it now comes from (`relay_with`).
fn remux_control(path: &str) -> bool {
    matches!(path, "/remux/health" | "/remux/session" | "/remux/releases" | "/remux/speed" | GRANT)
}

/// Where a player re-asserts the public media grant for a session it already has, from whatever address it has now:
/// `{"playlist": "/remux/s/<sid>/<sig>/master.m3u8"}`, plus `ipv4Hint`/`noHint` as a session start takes them.
///
/// The grant is made for the address a session started from, and kept by the listener while that session is live.
/// A viewer whose address changes mid-film (Wi-Fi to mobile, or a carrier that moves it) arrives from one the listener
/// does not know, and its next segment is dropped as a stranger's. The session's signed playlist is what proves the
/// caller holds it: den-remux is asked for it (`HEAD`) and only a live session's answer (200) opens the listener. The
/// caller passes the same membership or guest gate as a session start, and a guest's addresses are counted the same.
const GRANT: &str = "/remux/grant";

/// Most bytes a relayed `/remux/speed` asks den-remux for: what the web app times a link over. Every byte leaves over
/// the home upload, so nobody gets more through here.
pub(crate) const SPEED_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// A `/remux/speed` target with its `bytes` held to SPEED_MAX_BYTES and nothing else in its query; `None` for a count
/// that isn't one.
fn speed_target(target: &str) -> Option<String> {
    let mut url = url::Url::parse(target).ok()?;
    let named = url.query_pairs().find(|(k, _)| k == "bytes").map(|(_, v)| v.parse::<u64>());
    let bytes = match named {
        None => SPEED_MAX_BYTES,
        Some(Ok(n)) => n.min(SPEED_MAX_BYTES),
        Some(Err(_)) => return None,
    };
    url.set_query(Some(&format!("bytes={bytes}")));
    Some(url.to_string())
}

fn session_end_url(target: &str, body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let playlist = value.get("playlist")?.as_str()?;
    let root = playlist.strip_suffix("/master.m3u8")?;
    let mut pieces = root.strip_prefix("/remux/s/")?.split('/');
    let safe = |piece: &str| {
        piece.len() == 22 && piece.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    };
    if !pieces.next().is_some_and(safe) || !pieces.next().is_some_and(safe) || pieces.next().is_some() {
        return None;
    }
    let mut url = url::Url::parse(target).ok()?;
    url.set_path(root);
    url.set_query(None);
    Some(url.to_string())
}

async fn discard_failed_public_session(state: &AppState, target: &str, body: &[u8], rid: &str) {
    let Some(url) = session_end_url(target, body) else { return };
    let Ok(request) = axum::http::Request::builder()
        .method(Method::DELETE)
        .uri(url)
        .header("x-request-id", rid)
        .body(Full::new(Bytes::new()))
    else {
        return;
    };
    let _ = tokio::time::timeout(FAILED_SESSION_CLEANUP_TIMEOUT, state.relay_client.request(request)).await;
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
/// open — and everything that follows rides on it. A guest's lease shares one of `guest_media_slots`
/// with every body it is streaming; the slot comes back once the lease has idled out and none of those
/// bodies has sent a frame for as long. Held by the lease alone, a trailer streaming past the idle time
/// outlived it; held by the bodies until they ended, a paused progressive trailer, a phone gone off
/// Wi-Fi or a stalled addon kept a slot for as long as its connection stayed open.
pub struct Lease {
    until: u64,
    slot: Option<Arc<Slot>>,
}

/// A guest's slot, shared by its lease and every body the lease admitted.
pub(crate) struct Slot {
    /// Taken out when the lease ends. A body still open then streams on, but no longer holds a slot.
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
    /// When a body of this lease last sent a frame.
    sent: std::sync::atomic::AtomicU64,
}

impl Lease {
    /// No request, and no frame from a body of this lease, for the idle time.
    fn over(&self, now: u64) -> bool {
        self.until <= now
            && self.slot.as_ref().is_none_or(|slot| {
                slot.sent.load(std::sync::atomic::Ordering::Relaxed).saturating_add(LEASE_IDLE_MS) <= now
            })
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(slot) = &self.slot {
            crate::lock(&slot.permit).take();
        }
    }
}

/// What admission decided.
enum Admitted {
    /// Play on. A guest's bytes count against the guest ceiling, and its body keeps `slot` while it sends.
    Yes { slot: Option<Arc<Slot>> },
    /// Every guest slot is taken.
    Busy,
    /// Today's guest allowance is gone.
    Spent,
}

/// The membership this request claims, if any: `<id>:<member-proof>` as the app sends it.
fn member_claim(req: &Request) -> Option<String> {
    req.headers().get(crate::library::MEMBER_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// The video a request is for, when it names one.
///
/// A master (`/hls/<id>.m3u8`) and a file (`/play/<id>.mp4`) do; a segment does not — its own URL is
/// carried in the query, and the id never appears. Only `native_master` asks any more: a lease is
/// kept by address now, so nothing else needs to know which trailer a request belongs to.
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
/// A lease belongs to an ADDRESS, not to a video. A household member is admitted free; a guest takes
/// one slot and must be inside the day's allowance, and everything that address asks for afterwards
/// — the next slide's trailer, every segment, every range — takes that lease over rather than
/// opening a second. It is never refused once open, because a stall mid-trailer is worse than a
/// clean refusal at the start, which the page turns into YouTube's embed.
///
/// Keyed per video, as it first was, one viewer on Home held two slots at once: the slide playing
/// now and the one before it, still idling out with no bytes flowing — Home changes slide every
/// fifteen seconds against a thirty-second idle lease. Three of those refused a third viewer while
/// the box was carrying barely one stream. The cap is meant to bound concurrent viewers, and a
/// billboard is one viewer however many trailers it opens.
///
/// Members and guests are held apart, so a visitor on the household's own network cannot ride the
/// lease a member opened. Which one to look for is read from whether a claim is present at all; what
/// is stored is decided by whether that claim proved out, so a forged one lands on the guest lease
/// and spends a guest slot.
async fn admit(state: &AppState, claim: Option<&str>, bucket: &str) -> Admitted {
    let now = (state.clock)();
    let side = |member: bool| format!("{bucket}|{}", if member { "member" } else { "guest" });
    {
        let mut leases = crate::lock(&state.media_leases);
        leases.retain(|_, lease| !lease.over(now));
        if let Some(lease) = leases.get_mut(&side(claim.is_some())) {
            lease.until = now + LEASE_IDLE_MS;
            return Admitted::Yes { slot: lease.slot.clone() };
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
            Ok(permit) => Some(Arc::new(Slot { permit: Mutex::new(Some(permit)), sent: 0.into() })),
            Err(_) => return Admitted::Busy,
        }
    };
    crate::lock(&state.media_leases)
        .insert(side(member), Lease { until: now + LEASE_IDLE_MS, slot: slot.clone() });
    Admitted::Yes { slot }
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
    state: &Arc<AppState>,
    req: Request,
    target: String,
    rid: &str,
    face: crate::handler::Face,
) -> Response {
    relay_with(state, req, target, rid, face, None).await
}

/// A grant guest's call, already authenticated (`guest`).
struct Guest {
    gid: String,
    /// The host's real install segment for the addon this call reaches; `None` for a `/remux` control call.
    segment: Option<String>,
    /// The grant's escrowed installs, which a `/remux/session` body is translated to.
    installs: std::collections::BTreeMap<String, String>,
    /// Whether the answer names the install and so must come back with `~<gid>` in its place.
    scrub: bool,
    /// A manifest, which loses the host's install id and the name of their debrid service.
    manifest: bool,
}

impl Guest {
    fn remux(&self) -> bool {
        self.segment.is_none()
    }

    /// An answer as the guest may see it, or `None` when it cannot be made so (an encoding this cannot read).
    fn answer(&self, headers: &axum::http::HeaderMap, body: &Bytes) -> Option<Bytes> {
        let Some(segment) = self.segment.as_ref().filter(|_| self.scrub || self.manifest) else {
            return Some(body.clone());
        };
        let json = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.contains("json"));
        if !json || body.is_empty() {
            return Some(body.clone());
        }
        if headers.get(header::CONTENT_ENCODING).is_some_and(|e| e != "identity") {
            return None;
        }
        let mut text = std::str::from_utf8(body).ok()?.to_owned();
        if self.scrub {
            text = text.replace(segment.as_str(), &format!("~{}", self.gid));
        }
        if !self.manifest {
            return Some(Bytes::from(text));
        }
        let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
        crate::grants::strip_manifest(&mut value);
        serde_json::to_vec(&value).ok().map(Bytes::from)
    }
}

/// A guest's call to a grant's addon (`/<addon>/~<gid>/…`) or to the `/remux` control plane with `x-den-grant`,
/// or the request handed back when it is neither.
///
/// The grant is the whole gate: it is looked up after the address budget (a forged header must meet a budget
/// before it can make anything read a file) and before anything a member would pass, and a guest is never
/// treated as a member — whatever `x-den-library-member` it sends is not read.
pub async fn guest(
    state: &Arc<AppState>,
    req: Request,
    rid: &str,
    face: crate::handler::Face,
) -> Result<Response, Box<Request>> {
    let path = req.uri().path().to_owned();
    let parsed = crate::grants::parse_guest_path(&path);
    let remux = path.starts_with("/remux/") && req.headers().contains_key(crate::grants::HEADER);
    if parsed.is_none() && !remux {
        return Err(Box::new(req));
    }
    let not_found = || json(StatusCode::NOT_FOUND, "not_found");
    let ip = crate::handler::client_ip(state, &req);
    if let Some(wait) =
        crate::link::throttled_per_minute(state, &format!("relay-guest-gate:{ip}"), MEMBER_PER_WINDOW)
    {
        return Ok(limited(wait));
    }
    let path_gid = match &parsed {
        Some(Ok(p)) => Some(p.gid.as_str()),
        Some(Err(())) => return Ok(not_found()),
        None => None,
    };
    let claim = req.headers().get(crate::grants::HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let live = match crate::grants::authenticate(state, claim.as_deref(), path_gid).await {
        Ok(live) => live,
        Err(crate::grants::Denied::NotFound) => return Ok(not_found()),
        Err(crate::grants::Denied::Expired(at)) => {
            return Ok(crate::handler::json_reply(
                StatusCode::GONE,
                &serde_json::json!({ "error": "grant_expired", "expiredAt": at }),
            ))
        }
    };
    if let Some(wait) =
        crate::link::throttled_per_minute(state, &format!("relay-grant:{}", live.gid), GRANT_PER_WINDOW)
    {
        return Ok(limited(wait));
    }
    let query = req.uri().query().map(str::to_owned);
    let (target, guest) = match parsed {
        Some(Ok(p)) => {
            let shared = live.addons.iter().any(|a| a == p.addon);
            let Some(segment) = live.installs.get(p.addon).filter(|_| shared).cloned() else {
                return Ok(not_found());
            };
            // A path the streaming branch would take is refused whatever the allowlist says: a guest's bytes never
            // leave through `stream`, only through the session remux opens for it.
            if !crate::grants::allowed(p.addon, req.method(), &p.rest)
                || media(&path)
                || crate::grants::query_names(query.as_deref(), &["debug"])
            {
                return Ok(not_found());
            }
            let real = format!("/{}/{segment}{}", p.addon, p.rest);
            let real = query.as_ref().map_or(real.clone(), |q| format!("{real}?{q}"));
            let Some(target) = target(&state.relays, &real) else { return Ok(not_found()) };
            let guest = Guest {
                gid: live.gid,
                scrub: p.addon != "atlas",
                manifest: p.rest == "/manifest.json",
                segment: Some(segment),
                installs: Default::default(),
            };
            (target, guest)
        }
        _ => {
            // Without the shared secret remux would count a guest's sessions as the host's own, and unless
            // strangers cannot start libraries a grant is not a gate at all (`relay_with` asks the same of members).
            let control = remux_control(&path);
            if state.remux_edge_secret.is_none()
                || !control
                || !crate::grants::libraries_are_members_only(state)
            {
                return Ok(not_found());
            }
            // An install of the guest's own in the query would bypass the body rewrite below.
            if crate::grants::query_names(query.as_deref(), &["scout", "subtitles"]) {
                return Ok(json(StatusCode::BAD_REQUEST, "bad_request"));
            }
            let pq = req.uri().path_and_query().map_or(path.clone(), |pq| pq.as_str().to_owned());
            let Some(target) = target(&state.relays, &pq) else { return Ok(not_found()) };
            let guest = Guest {
                gid: live.gid,
                segment: None,
                installs: live.installs,
                scrub: false,
                manifest: false,
            };
            (target, guest)
        }
    };
    Ok(relay_with(state, req, target, rid, face, Some(guest)).await)
}

/// `/remux/session` and `/remux/releases` name the guest's installs as `<origin>/<addon>/~<gid>` — the same shape
/// the web app sends for a real one, with the grant in the segment's place. Each is translated to the host's real
/// install at the relay table's own origin, so the guest never sees it and never chooses where remux fetches from.
/// Anything else in either field is refused.
fn remux_body(relays: &[(String, String)], guest: &Guest, body: &[u8]) -> Option<Bytes> {
    let mut value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let fields = value.as_object_mut()?;
    for addon in ["scout", "subtitles"] {
        let Some(field) = fields.get_mut(addon).filter(|f| !f.is_null()) else { continue };
        *field = serde_json::Value::String(real_install(relays, guest, addon, field.as_str()?)?);
    }
    serde_json::to_vec(&value).ok().map(Bytes::from)
}

fn real_install(relays: &[(String, String)], guest: &Guest, addon: &str, given: &str) -> Option<String> {
    let url = url::Url::parse(given).ok()?;
    let plain = url.host_str().is_some()
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    let segments: Vec<&str> = url.path_segments()?.collect();
    let virtual_install = [addon.as_bytes().to_vec(), format!("~{}", guest.gid).into_bytes()];
    let named = matches!(segments.len(), 2 | 3)
        && segments.get(2).is_none_or(|last| last.is_empty())
        && segments
            .iter()
            .zip(&virtual_install)
            .all(|(s, want)| crate::grants::percent_decode(s).is_some_and(|got| got == *want));
    if !plain || !named {
        return None;
    }
    target(relays, &format!("/{addon}/{}", guest.installs.get(addon)?))
}

async fn relay_with(
    state: &Arc<AppState>,
    req: Request,
    target: String,
    rid: &str,
    face: crate::handler::Face,
    grant: Option<Guest>,
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
    let remux = req.uri().path().starts_with("/remux/");
    if remux && !remux_control(req.uri().path()) {
        return json(StatusCode::NOT_FOUND, "not_found");
    }
    let speed = req.uri().path() == "/remux/speed";
    let target = if speed { speed_target(&target) } else { Some(target) };
    let Some(target) = target else { return json(StatusCode::BAD_REQUEST, "bad_request") };
    // A guest has been through its grant already (`guest`) and is never a member, so none of this is asked of it.
    // `/scout` itself and `/scout?…` are relayed to scout's `/` (`target`), so they are scout's too.
    let scout = req.uri().path() == "/scout" || req.uri().path().starts_with("/scout/");
    let member_only = grant.is_none() && face == crate::handler::Face::Web && (scout || remux);
    if member_only {
        let ip = crate::handler::client_ip(state, &req);
        // A forged member header must meet an address budget before it can make the library store load anything.
        if let Some(wait) =
            crate::link::throttled_per_minute(state, &format!("relay-member-gate:{ip}"), MEMBER_PER_WINDOW)
        {
            return limited(wait);
        }
        // Membership is only a meaningful public gate when strangers cannot create a library for themselves.
        if remux && state.new_libraries != crate::library::NewLibraries::Members {
            return json(StatusCode::NOT_FOUND, "not_found");
        }
        let claim = member_claim(&req);
        if !crate::library::is_member(state, claim.as_deref()).await {
            return json(StatusCode::NOT_FOUND, "not_found");
        }
    }
    // The visitor's budget is spent first, and only an address past it is asked whether it is a member and has
    // the larger one. That order is deliberate: checking membership first would let a forged member header make
    // every relayed request do a library lookup, which is the work this limit exists to protect.
    let address = crate::handler::client_addr(state, &req);
    let ip = crate::handler::client_ip(state, &req);
    // A trailer's bytes come through here or not at all. On the public name a browser cannot reach reel
    // directly — its only https address there is the tailnet's, which does not resolve for anyone off it — so
    // the video has to be served from this origin. Streamed rather than collected, and on its own budget.
    if media(req.uri().path()) && !native_master(req.uri().path(), req.uri().query()) {
        if let Some(wait) =
            crate::link::throttled_per_minute(state, &format!("relay-media:{ip}"), MEDIA_PER_WINDOW)
        {
            return limited(wait);
        }
        // Read here rather than inside `admit`: an async fn holding a `&Request` is not `Send`, and
        // this one is awaited inside the handler.
        let claim = if grant.is_some() { None } else { member_claim(&req) };
        return match admit(state, claim.as_deref(), &ip).await {
            Admitted::Yes { slot } => stream(state, req, target, rid, slot).await,
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
    // A grant's calls are counted against the grant (`guest`), not against the address they come from, so a
    // household's guests do not share one budget.
    let playground = playground(req.uri().path());
    let visitor_wait = if grant.is_some() {
        None
    } else if playground {
        if let Some(wait) =
            crate::link::throttled_per_minute(state, &format!("relay-playground:{ip}"), PLAYGROUND_PER_WINDOW)
        {
            return limited(wait);
        }
        None
    } else {
        crate::link::throttled_per_minute(state, &format!("relay:{ip}"), GUEST_PER_WINDOW)
    };
    if let Some(visitor_wait) = visitor_wait {
        let member = member_claim(&req);
        if !crate::library::is_member(state, member.as_deref()).await {
            return limited(visitor_wait);
        }
        if let Some(wait) =
            crate::link::throttled_per_minute(state, &format!("relay-member:{ip}"), MEMBER_PER_WINDOW)
        {
            return limited(wait);
        }
    }
    // Taken before a relay slot and without waiting, so playground calls never queue for more than their share.
    let _playground_slot = if playground {
        match Arc::clone(&state.playground_slots).try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return crate::handler::retry_after(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &error("playground_busy"),
                    PLAYGROUND_BUSY_RETRY_MS,
                )
            }
        }
    } else {
        None
    };
    // A guest's session gets the public listener as a member's does, but only on the public name, where a member's
    // does too.
    let guest_remux = face == crate::handler::Face::Web && grant.as_ref().is_some_and(Guest::remux);
    // A grant asked again for an open session opens the listener as a start does, and goes through the same checks.
    let regrant = req.uri().path() == GRANT;
    let public_session = (member_only || guest_remux)
        && (req.uri().path() == "/remux/session" || regrant)
        && method == Method::POST;
    if regrant && !public_session {
        return json(StatusCode::NOT_FOUND, "not_found");
    }
    // A guest's play refused at its start, counted by code on `/metrics`.
    let guest_refused = |code: &'static str| {
        if guest_remux && public_session {
            state.metrics.record_guest_play_refused(code);
        }
    };
    let content_type = req.headers().get(header::CONTENT_TYPE).cloned();
    if public_session
        && (state.public_media_base.is_none() || state.public_media_socket.is_none() || address.is_none())
    {
        guest_refused("public_media_unavailable");
        return json(StatusCode::SERVICE_UNAVAILABLE, "public_media_unavailable");
    }
    // An answer that has to be rewritten cannot be read compressed, so a guest's is asked for as it is.
    let identity = grant.as_ref().is_some_and(|g| g.scrub || g.manifest);
    let conditions: Vec<_> = [header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE, header::ACCEPT_ENCODING]
        .into_iter()
        .filter(|name| !(identity && *name == header::ACCEPT_ENCODING))
        .filter_map(|name| req.headers().get(&name).cloned().map(|value| (name, value)))
        .collect();
    let control = req.uri().path().to_owned();
    // Read before a relay slot is taken, and within `TIMEOUT`: sixteen uploads that never finished their body held
    // every slot for as long as their sockets stayed open, and the relay was busy for everyone.
    let body =
        match tokio::time::timeout(TIMEOUT, axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES)).await {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => return json(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            Err(_) => return json(StatusCode::REQUEST_TIMEOUT, "request_timeout"),
        };
    // Held until this answer is done with, so the cap counts what is actually in flight upstream.
    let slot = tokio::time::timeout(SLOT_WAIT, Arc::clone(&state.relay_slots).acquire_owned()).await;
    let _slot = match slot {
        Ok(Ok(permit)) => permit,
        // Every slot is taken: the wait it just spent is also how long the next caller should give it.
        _ => {
            guest_refused("relay_busy");
            return crate::handler::retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &error("relay_busy"),
                SLOT_WAIT.as_millis() as u64,
            );
        }
    };
    let body = match &grant {
        Some(g) if g.remux() && method == Method::POST && control != "/remux/health" => {
            match remux_body(&state.relays, g, &body) {
                Some(rewritten) => rewritten,
                None => return json(StatusCode::BAD_REQUEST, "bad_request"),
            }
        }
        _ => body,
    };
    // The page's report of its own IPv4 address is for this server alone: remux never sees it.
    let (body, hint, no_hint) = if public_session {
        match take_hint(body) {
            Some(taken) => taken,
            None => return json(StatusCode::BAD_REQUEST, "bad_request"),
        }
    } else {
        (body, None, false)
    };
    let cast = public_session
        && serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("player").and_then(serde_json::Value::as_str).map(str::to_owned))
            .is_some_and(|player| player == "cast");
    // The media base is IPv4 only, so a visitor seen over IPv6 plays from an IPv4 address this server never sees.
    // Its page may say which (`ipv4Hint`), and then the listener opens for that one address rather than wide. The
    // observed address always wins: a visitor seen over IPv4 is opened for that, whatever its page says. A Cast
    // receiver fetches from its own address, which the page cannot know.
    //
    // The page looks its address up only when asked to, so a visitor seen over IPv4 — most of them — never makes
    // that third-party request: an IPv6 visitor that said neither `ipv4Hint` nor `noHint` is sent back for one
    // before anything reaches remux or the listener.
    if public_session && !cast && hint.is_none() && !no_hint && address.is_some_and(|a| a.is_ipv6()) {
        state.metrics.record_public_media_hint_wanted(if guest_remux { "guest" } else { "member" });
        return json(StatusCode::PRECONDITION_REQUIRED, "ipv4_hint_wanted");
    }
    let hinted = match (public_session && !cast, address, hint) {
        (true, Some(source), Some(hint)) if source.is_ipv6() => match hint_address(&hint) {
            Ok(v4) => Some(std::net::IpAddr::V4(v4)),
            Err(reason) => {
                state.metrics.record_public_media_hint_rejected(reason);
                None
            }
        },
        _ => None,
    };
    if let (true, Some(g), Some(source)) = (public_session, &grant, address) {
        // The wide scope opens the listener to more than the guest's own address, and a guest is never given it:
        // an IPv6 guest without a usable hint, or a Cast guest, is turned away rather than let in to everyone. Nor
        // may one grant open sources without end by changing address, observed or hinted. The media base is an IPv4
        // literal, so the exact-address grant can only name an IPv4 address; a Cast receiver fetches from its own
        // address, which only the wide scope admits. Each gets its own code, so the page can say which limit it
        // met and the log line shows it.
        if cast {
            guest_refused("public_media_cast");
            return json(StatusCode::SERVICE_UNAVAILABLE, "public_media_cast");
        }
        if let Some(hinted) = hinted {
            if !state.grants.allow_source(&g.gid, hinted, state.now()) {
                state.metrics.record_public_media_hint_rejected("limit");
                guest_refused("hint_limit");
                return json(StatusCode::TOO_MANY_REQUESTS, "hint_limit");
            }
        } else if source.is_ipv6() {
            guest_refused("public_media_ipv6");
            return json(StatusCode::SERVICE_UNAVAILABLE, "public_media_ipv6");
        } else if !state.grants.allow_source(&g.gid, source, state.now()) {
            guest_refused("too_many_sources");
            return json(StatusCode::TOO_MANY_REQUESTS, "too_many_sources");
        }
    }
    if let (true, None, Some(hinted)) = (public_session, &grant, hinted) {
        // A member is never refused the wide scope, so a hint only narrows its grant; but a hint is whatever the page
        // says, so one member's addresses are still counted, as a guest's are.
        if !allow_member_hint(state, &ip, hinted) {
            state.metrics.record_public_media_hint_rejected("limit");
            return json(StatusCode::TOO_MANY_REQUESTS, "hint_limit");
        }
    }
    // Nothing of the browser's goes along but what the addon reads: not its cookies, which carry its Access
    // session, nor anything Cloudflare added. Its validators do, so a revalidation is the addon's 304 rather
    // than the whole answer again, and the encodings it takes, so a large file (atlas's labels) arrives gzipped
    // and within `MAX_ANSWER_BYTES`.
    // This request's id goes with it. The addon logs one line per request and so does this server; without a
    // shared id the two are impossible to put side by side afterwards, which is exactly when you want to.
    // What den-remux is asked: for a grant, whether the named session is live — its signed playlist, which only the
    // session's holder can name, and which counts as the session being used.
    let (method, target, body) = if regrant {
        match session_end_url(&target, &body) {
            Some(root) => (Method::HEAD, format!("{root}/master.m3u8"), Bytes::new()),
            None => return json(StatusCode::BAD_REQUEST, "bad_request"),
        }
    } else {
        (method, target, body)
    };
    let mut out = axum::http::Request::builder()
        .method(method)
        .uri(&target)
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", rid);
    if let Some(content_type) = content_type {
        out = out.header(header::CONTENT_TYPE, content_type);
    }
    if identity {
        out = out.header(header::ACCEPT_ENCODING, "identity");
    }
    if let (Some(g), Some(secret)) = (grant.as_ref().filter(|g| g.remux()), &state.remux_edge_secret) {
        // What tells remux this session is a guest's, to be counted, capped and ended apart from the host's.
        out = out
            .header("x-den-edge-secret", secret.as_str())
            .header("x-den-owner", format!("grant:{}", g.gid));
    }
    // Only den-remux consumes this for its per-viewer start budget. Do not broaden the visitor-address data
    // handed to unrelated addons merely because they share the relay implementation.
    if remux {
        if let Some(address) = address {
            out = out.header("x-forwarded-for", address.to_string());
        }
        if public_session {
            // Internal signal for remux's public-session gauge. It lets the root gate close while unrelated LAN
            // playback continues; the public listener still trusts only den-edge's root-owned Unix-socket call.
            out = out.header("x-den-public-session", "1");
        }
    }
    for (name, value) in conditions {
        out = out.header(name, value);
    }
    let Ok(out) = out.body(Full::new(body)) else { return json(StatusCode::BAD_REQUEST, "bad_request") };
    // One deadline for the head and the body: an addon that answered its head and then stalled held a relay slot
    // for as long as it stayed silent.
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let answer = match tokio::time::timeout_at(deadline, state.relay_client.request(out)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            eprintln!("relay: {e}");
            return json(StatusCode::BAD_GATEWAY, "addon_unreachable");
        }
        Err(_) => return json(StatusCode::GATEWAY_TIMEOUT, "addon_timeout"),
    };
    let (parts, body) = answer.into_parts();
    let mut bytes = match collect_by(body, deadline).await {
        Ok(bytes) => bytes,
        Err(refused) => return refused,
    };
    if let Some(g) = &grant {
        // Whatever the addon says about the host's install goes back as the guest's own `~<gid>`.
        match g.answer(&parts.headers, &bytes) {
            Some(scrubbed) => bytes = scrubbed,
            None => return json(StatusCode::BAD_GATEWAY, "addon_answer_unreadable"),
        }
    }
    // atlas's catalog charts carry each title's JustWatch IMDb score. It is kept here for every client, as the TMDB
    // proxy keeps what it fetches (`title_metadata.rs`), and the answer says so — only when it was taken on — so a
    // browser sends nothing back.
    let encoding = parts.headers.get(header::CONTENT_ENCODING).map(|v| v.as_bytes());
    let observed = parts.status == StatusCode::OK
        && atlas_catalog(&control)
        && matches!(encoding, None | Some(b"identity" | b"gzip"))
        && crate::title_metadata::observe_atlas(state, &bytes, encoding == Some(b"gzip"));
    let mut scope = None;
    let opened = if regrant { StatusCode::OK } else { StatusCode::CREATED };
    if public_session && parts.status == opened {
        if let (Some(base), Some(socket), Some(address)) =
            (&state.public_media_base, &state.public_media_socket, address)
        {
            let asked = if hinted.is_some() { "hint" } else { listener_scope(cast, address) };
            scope = Some(ListenerScope(asked));
            if open_public_listener(socket, hinted.unwrap_or(address), cast).await {
                let who = if guest_remux { "guest" } else { "member" };
                if hinted.is_some() {
                    state.metrics.record_public_media_hinted(who);
                } else if let Some(reason) = asked.strip_prefix("wide:") {
                    state.metrics.record_public_media_wide(reason, who);
                }
                if regrant {
                    let mut resp = Response::new(Body::empty());
                    *resp.status_mut() = StatusCode::NO_CONTENT;
                    resp.headers_mut()
                        .insert(header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
                    resp.extensions_mut().insert(ListenerScope(asked));
                    return resp;
                }
                if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    value["publicBase"] = serde_json::Value::String(base.clone());
                    // Opened for the page's reported address: if it was wrong, the page asks again without it.
                    if hinted.is_some() {
                        value["hinted"] = serde_json::Value::Bool(true);
                    }
                    // Only to a client behind the home's own router. Anyone else — a remote member, an invited
                    // guest — cannot reach a private address, and would try it first on every play regardless.
                    if let Some(lan) = &state.lan_media_base {
                        if state.home_address.is_behind_home_router(base, address).await {
                            value["lanBase"] = serde_json::Value::String(lan.clone());
                        }
                    }
                    if let Some(cast_origin) = &state.cast_origin {
                        value["castOrigin"] = serde_json::Value::String(cast_origin.clone());
                    }
                    if let Ok(encoded) = serde_json::to_vec(&value) {
                        bytes = Bytes::from(encoded);
                    }
                }
            } else {
                // A session that plays on is never ended for this: only one this call just made.
                if !regrant {
                    discard_failed_public_session(state, &target, &bytes, rid).await;
                }
                guest_refused("public_listener_unavailable");
                let mut refused = crate::handler::retry_after(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &error("public_listener_unavailable"),
                    1_000,
                );
                refused.extensions_mut().insert(ListenerScope(asked));
                return refused;
            }
        }
    }
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
    // A tuned row answers one caller's knobs; atlas says `no-store`, and this holds to it whatever atlas says, so
    // no cache in front of this origin keeps one.
    if public_session || playground || speed {
        resp.headers_mut().insert(header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
    }
    // Scout's answers are shared caching material on the LAN, where anyone may ask. On the web name only a member
    // is answered at all, so a shared cache in front of it — Cloudflare's — must not keep one to hand a stranger.
    // The browser keeps its own copy for as long as scout said.
    if member_only || grant.is_some() {
        if let Some(policy) = resp.headers().get(header::CACHE_CONTROL).map(private) {
            resp.headers_mut().insert(header::CACHE_CONTROL, policy);
        }
    }
    if let Some(scope) = scope {
        resp.extensions_mut().insert(scope);
    }
    if observed {
        resp.headers_mut().insert(TITLE_METADATA, axum::http::HeaderValue::from_static("kept"));
    }
    resp
}

/// An addon's answer body, whole and within `MAX_ANSWER_BYTES`, by `deadline`.
async fn collect_by<B>(body: B, deadline: tokio::time::Instant) -> Result<Bytes, Response>
where
    B: http_body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    match tokio::time::timeout_at(deadline, Limited::new(body, MAX_ANSWER_BYTES).collect()).await {
        Ok(Ok(collected)) => Ok(collected.to_bytes()),
        Ok(Err(_)) => Err(json(StatusCode::BAD_GATEWAY, "addon_answer_unreadable")),
        Err(_) => Err(json(StatusCode::GATEWAY_TIMEOUT, "addon_timeout")),
    }
}

/// On a relayed atlas chart: den-edge keeps what it says about its titles (`title_metadata::observe_atlas`), so the
/// web app does not send it back. An atlas reached directly — the tailnet's `/atlas`, which `tailscale serve` hands
/// straight to atlas — answers without it, and the web app still sends those.
const TITLE_METADATA: header::HeaderName = header::HeaderName::from_static("x-den-title-metadata");

/// Is this relayed path one of atlas's catalog charts (`/atlas/catalog/movie/<id>/…json`, under an install's config
/// or a grant's `~<gid>` too)?
fn atlas_catalog(path: &str) -> bool {
    path.strip_prefix("/atlas/").is_some_and(|rest| rest.split('/').any(|segment| segment == "catalog"))
}

/// Which listener grant a public session needs, as the request log names it: `browser` for the visitor's own
/// address, else the wide scope and why. The media base is an IPv4 literal. A visitor Cloudflare saw over IPv6
/// fetches it from an address this process never sees (dual-stack, NAT64, carrier NAT), so an exact-address grant
/// would drop its own session; a Cast receiver fetches from its own address.
fn listener_scope(cast: bool, source: std::net::IpAddr) -> &'static str {
    if cast {
        "wide:cast"
    } else if source.is_ipv6() {
        "wide:ipv6"
    } else {
        "browser"
    }
}

/// A session start's body without its `ipv4Hint` and `noHint`, the hint unless the page said `noHint`, and whether
/// it said `noHint` — which it does when a hinted session already failed to play, or its own lookup found nothing.
/// A body that is not a JSON object is left as it is, for remux to refuse. `None` only if the body cannot be
/// written back.
fn take_hint(body: Bytes) -> Option<(Bytes, Option<serde_json::Value>, bool)> {
    let Ok(serde_json::Value::Object(mut fields)) = serde_json::from_slice(&body) else {
        return Some((body, None, false));
    };
    let hint = fields.remove("ipv4Hint");
    let no_hint = fields.remove("noHint");
    if hint.is_none() && no_hint.is_none() {
        return Some((body, None, false));
    }
    let no_hint = no_hint.as_ref().and_then(serde_json::Value::as_bool) == Some(true);
    let hint = hint.filter(|_| !no_hint);
    serde_json::to_vec(&fields).ok().map(|body| (Bytes::from(body), hint, no_hint))
}

/// The address an `ipv4Hint` names: one bare IPv4 address (no prefix, no port) that someone on the internet could
/// hold. Anything else is refused by reason, as `den_edge_public_media_hint_rejected_total` counts it.
fn hint_address(hint: &serde_json::Value) -> Result<std::net::Ipv4Addr, &'static str> {
    let addr: std::net::Ipv4Addr = hint.as_str().and_then(|s| s.parse().ok()).ok_or("malformed")?;
    let [a, b, c, _] = addr.octets();
    let special = a == 0 // "this network", the unspecified address among it
        || addr.is_private()
        || addr.is_loopback()
        || addr.is_link_local()
        || addr.is_multicast()
        || addr.is_broadcast()
        || addr.is_documentation()
        || (a == 100 && (64..128).contains(&b)) // shared address space: carrier-grade NAT
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240; // reserved
    if special {
        Err("not_global")
    } else {
        Ok(addr)
    }
}

/// May the member bucket `bucket` have the listener opened for `addr`, a hinted address? A known one always may, a
/// new one while the bucket holds fewer than `MEMBER_HINTS` in the last hour.
fn allow_member_hint(state: &AppState, bucket: &str, addr: std::net::IpAddr) -> bool {
    let now = state.now();
    let mut hints = crate::lock(&state.member_hints);
    hints.retain(|_, list| list.iter().any(|(_, at)| now.saturating_sub(*at) < MEMBER_HINT_TTL_MS));
    let list = hints.entry(bucket.to_owned()).or_default();
    crate::grants::remember_source(list, addr, now, MEMBER_HINTS, MEMBER_HINT_TTL_MS)
}

/// Ask the root-owned helper for its one operation. It validates the address again and owns every nftables
/// argument; this process never runs a privileged command or supplies a table, chain, port, or timeout.
async fn open_public_listener(socket: &std::path::Path, source: std::net::IpAddr, cast: bool) -> bool {
    let wide = listener_scope(cast, source) != "browser";
    let operation = async {
        let mut stream = tokio::net::UnixStream::connect(socket).await.ok()?;
        let request = serde_json::json!({
            "open": true,
            "source": source.to_string(),
            "scope": if wide { "cast" } else { "browser" },
        });
        stream.write_all(request.to_string().as_bytes()).await.ok()?;
        stream.write_all(b"\n").await.ok()?;
        stream.shutdown().await.ok()?;
        let mut answer = [0u8; 3];
        stream.read_exact(&mut answer).await.ok()?;
        (answer == *b"ok\n").then_some(())
    };
    // The helper may have to start the TLS proxy container before it answers, and a timeout here makes it tear
    // that proxy down again, so every retry would start cold.
    tokio::time::timeout(Duration::from_secs(10), operation).await.ok().flatten().is_some()
}

/// A `Cache-Control` with `public` turned into `private`, everything else as it was. One that cannot be read is
/// not kept anywhere.
fn private(policy: &axum::http::HeaderValue) -> axum::http::HeaderValue {
    let Ok(policy) = policy.to_str() else { return axum::http::HeaderValue::from_static("no-store") };
    let directives: Vec<&str> = policy
        .split(',')
        .map(str::trim)
        .map(|directive| if directive.eq_ignore_ascii_case("public") { "private" } else { directive })
        .collect();
    axum::http::HeaderValue::from_str(&directives.join(", "))
        .unwrap_or_else(|_| axum::http::HeaderValue::from_static("no-store"))
}

/// Is this relayed path a trailer's bytes rather than JSON? Reel's `/play/<id>.mp4`, and the playlist and
/// segments that will join it. An install's config sits between the prefix and these, so the segment is looked
/// for rather than positioned — but only under reel, so no other addon can be streamed through by naming a
/// path after one of these.
fn media(path: &str) -> bool {
    path.strip_prefix("/reel/").is_some_and(|rest| {
        let mut segments = rest.split('/').peekable();
        while let Some(segment) = segments.next() {
            if matches!(segment, "play" | "hls" | "seg" | "progressive") {
                return true;
            }
            // reel's minted URLs, which name no route and no video: `/m/<kind>/<blob>`. ANY kind counts,
            // not just the two that exist — a kind added later and not listed here would go down the JSON
            // path, be collected whole, refused past eight megabytes and forwarded no `Range`, which is
            // exactly how `/progressive` broke. Being wrongly called media is the safe direction.
            if segment == "m" && segments.peek().is_some() {
                return true;
            }
        }
        false
    })
}

/// Is this relayed path atlas's tuning playground? Atlas serves it at `/playground` and under an install's config
/// (`/<config>/playground…`), so the segment is looked for anywhere under atlas rather than positioned: a path
/// wrongly counted here only meets the smaller budget, and one wrongly missed would be computed on the general one.
fn playground(path: &str) -> bool {
    path.strip_prefix("/atlas/").is_some_and(|rest| rest.split('/').any(|segment| segment == "playground"))
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
    minted_native(path)
        || (media_video(path).is_some()
            && path.ends_with(".m3u8")
            && query.is_some_and(|q| q.split('&').any(|p| p == "native=1")))
}

/// `/m/n/<blob>`: a minted native master, told apart from `/m/s/<blob>` by the path alone.
///
/// A minted URL carries its video, form and flags inside a signed blob only reel can read, so the fact this
/// exemption turns on had nowhere to be seen from here. Asking reel to name the kind in the path is what
/// keeps the accounting possible — and reel refuses a blob filed under the wrong segment, so the path can be
/// trusted rather than merely believed. A query flag would have been forgeable; this is not.
fn minted_native(path: &str) -> bool {
    path.strip_prefix("/reel/").is_some_and(|rest| {
        let mut segments = rest.split('/');
        while let Some(segment) = segments.next() {
            if segment == "m" {
                return segments.next() == Some("n");
            }
        }
        false
    })
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
async fn stream(
    state: &Arc<AppState>,
    req: Request,
    target: String,
    rid: &str,
    slot: Option<Arc<Slot>>,
) -> Response {
    let method = req.method().clone();
    let asked: Vec<_> = [
        header::RANGE,
        header::IF_RANGE,
        header::IF_NONE_MATCH,
        header::IF_MODIFIED_SINCE,
        header::ACCEPT_ENCODING,
    ]
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
    // claims. A member's bytes are not counted at all — the ceiling is a guest ceiling. Each is counted on the
    // day it leaves: a stream begun before UTC midnight that kept its first day reset the new day's count.
    let body = if let Some(slot) = slot {
        let state = Arc::clone(state);
        Body::new(body.map_frame(move |frame| {
            let now = (state.clock)();
            slot.sent.store(now, std::sync::atomic::Ordering::Relaxed);
            if let Some(data) = frame.data_ref() {
                let day = now / 86_400_000;
                let mut spent = crate::lock(&state.media_spent);
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
    json_reply(status, &error(code))
}

/// A refusal that says when the window clears, rather than leaving the caller to guess and come straight back.
fn limited(after_ms: u64) -> Response {
    crate::handler::retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), after_ms)
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use crate::handler::ListenerScope;
    use axum::http::StatusCode;
    use serde_json::json;
    use std::sync::Arc;

    const LIB: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "the-write-token";
    const MEMBER: &str = "the-separate-member-proof";

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

    async fn registered_library(h: &Harness) -> String {
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        let started =
            h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        assert_eq!(started.status(), StatusCode::OK);
        let claim = format!("{LIB}:{MEMBER}");
        let registered = h
            .send(
                "PUT",
                &format!("/lib/{LIB}/member"),
                None,
                &[("x-den-library-token", TOKEN), ("x-den-library-member", &claim)],
            )
            .await;
        assert_eq!(registered.status(), StatusCode::OK);
        claim
    }

    #[test]
    fn failed_public_session_cleanup_uses_only_a_strict_signed_playlist() {
        let sid = "A".repeat(22);
        let sig = "b".repeat(22);
        let body = json!({ "playlist": format!("/remux/s/{sid}/{sig}/master.m3u8") }).to_string();
        assert_eq!(
            super::session_end_url("http://den-remux:8095/remux/session?x=1", body.as_bytes()).as_deref(),
            Some(format!("http://den-remux:8095/remux/s/{sid}/{sig}").as_str())
        );
        assert!(super::session_end_url(
            "http://den-remux:8095/remux/session",
            br#"{"playlist":"http://evil/remux/s/a/b/master.m3u8"}"#,
        )
        .is_none());
    }

    #[test]
    fn remux_keeps_the_prefix_its_upstream_api_owns() {
        let relays = crate::parse_relays("/scout=http://scout:8080, /remux=http://remux:8095");
        assert_eq!(
            super::target(&relays, "/remux/session?x=1").as_deref(),
            Some("http://remux:8095/remux/session?x=1")
        );
        assert_eq!(
            super::target(&relays, "/scout/cfg/manifest.json").as_deref(),
            Some("http://scout:8080/cfg/manifest.json")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_ipv6_visitor_gets_the_wide_scope_and_an_ipv4_visitor_its_own_address() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = crate::handler::tests::temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("listener.sock");
        let unix = tokio::net::UnixListener::bind(&socket).unwrap();
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (stream, _) = unix.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let _ = sent.send(line);
                stream.into_inner().write_all(b"ok\n").await.unwrap();
            }
        });

        for source in ["2001:db8::7", "203.0.113.7"] {
            assert!(super::open_public_listener(&socket, source.parse().unwrap(), false).await);
        }
        let scope =
            |line: String| serde_json::from_str::<serde_json::Value>(line.trim()).unwrap()["scope"].clone();
        assert_eq!(scope(received.recv().await.unwrap()), "cast");
        assert_eq!(scope(received.recv().await.unwrap()), "browser");
    }

    #[tokio::test]
    async fn public_remux_is_members_only_and_control_only() {
        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.relays = crate::parse_relays("/remux=http://127.0.0.1:9");
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");

        assert_eq!(
            h.send("GET", "/remux/health", None, &[("host", "d.oxy.fi")]).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            h.send("GET", "/remux/video", None, &[("host", "d.oxy.fi")]).await.status(),
            StatusCode::NOT_FOUND
        );

        let claim = registered_library(&h).await;
        let open_mode = h
            .send("GET", "/remux/health", None, &[("host", "d.oxy.fi"), ("x-den-library-member", &claim)])
            .await;
        assert_eq!(open_mode.status(), StatusCode::NOT_FOUND, "public remux requires members mode");

        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Members;
        let relayed = h
            .send("GET", "/remux/health", None, &[("host", "d.oxy.fi"), ("x-den-library-member", &claim)])
            .await;
        assert_eq!(relayed.status(), StatusCode::BAD_GATEWAY, "member reached the absent upstream");
    }

    /// A member on the public name (source `192.168.1.9`, the harness's peer) starts a Cast session against a
    /// listener that acknowledges, with `public_base` as the public media base. Returns the answer and what the
    /// listener was asked.
    #[cfg(unix)]
    async fn members_cast_session(public_base: &str) -> (serde_json::Value, serde_json::Value) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let app = axum::Router::new().fallback(|req: axum::extract::Request| async move {
            assert_eq!(req.uri().path(), "/remux/session");
            assert_eq!(req.headers()["x-forwarded-for"], "192.168.1.9");
            assert_eq!(req.headers()["x-den-public-session"], "1");
            (StatusCode::CREATED, json!({ "playlist": "/remux/s/id/sig/master.m3u8" }).to_string())
        });
        tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });

        let dir = crate::handler::tests::temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("listener.sock");
        let unix = tokio::net::UnixListener::bind(&socket).unwrap();
        let (sent, received) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = unix.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let _ = sent.send(line);
            let mut stream = stream.into_inner();
            stream.write_all(b"ok\n").await.unwrap();
        });

        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.relays = crate::parse_relays(&format!("/remux=http://{upstream_addr}"));
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        state.public_media_base = Some(public_base.into());
        state.lan_media_base = Some("https://lan.media.example:8449".into());
        state.public_media_socket = Some(socket);
        state.cast_origin = Some("https://cast.oxy.fi".into());
        let claim = registered_library(&h).await;
        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Members;
        let answer = h
            .send(
                "POST",
                "/remux/session",
                Some(json!({ "player": "cast" }).to_string()),
                &[
                    ("host", "d.oxy.fi"),
                    ("content-type", "application/json"),
                    ("x-den-library-member", &claim),
                ],
            )
            .await;
        assert_eq!(answer.status(), StatusCode::CREATED);
        // A member's Cast session is the wide scope: named on its log line, and counted once it is open.
        assert_eq!(answer.extensions().get::<ListenerScope>().map(|s| s.0), Some("wide:cast"));
        let metrics = h.state.metrics.render();
        assert!(
            metrics.contains(r#"den_edge_public_media_wide_total{reason="cast",who="member"} 1"#),
            "{metrics}"
        );
        assert!(
            metrics.contains(r#"den_edge_public_media_wide_total{reason="cast",who="guest"} 0"#),
            "{metrics}"
        );
        let body = crate::handler::tests::body_json(answer).await;
        let ask: serde_json::Value = serde_json::from_str(received.await.unwrap().trim()).unwrap();
        (body, ask)
    }

    /// A member seen over IPv6 whose page reports a global IPv4 address gets the listener for that address, not the
    /// wide scope; without a usable report it gets the wide scope as before. A member seen over IPv4 is opened for
    /// its observed address whatever the page says, and remux never sees the report.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_members_ipv4_hint_narrows_its_ipv6_grant_to_one_address() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let relayed = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let app = axum::Router::new().fallback({
            let relayed = Arc::clone(&relayed);
            move |req: axum::extract::Request| {
                let relayed = Arc::clone(&relayed);
                async move {
                    let body = axum::body::to_bytes(req.into_body(), 1 << 20).await.unwrap();
                    relayed.lock().unwrap().push(serde_json::from_slice(&body).unwrap());
                    (StatusCode::CREATED, json!({ "playlist": "/remux/s/id/sig/master.m3u8" }).to_string())
                }
            }
        });
        tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });

        let dir = crate::handler::tests::temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("listener.sock");
        let unix = tokio::net::UnixListener::bind(&socket).unwrap();
        let (sent, mut opened) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (stream, _) = unix.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let _ = sent.send(serde_json::from_str::<serde_json::Value>(line.trim()).unwrap());
                stream.into_inner().write_all(b"ok\n").await.unwrap();
            }
        });

        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.relays = crate::parse_relays(&format!("/remux=http://{upstream_addr}"));
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        state.trusted_proxies = vec!["192.168.1.9".parse().unwrap()];
        state.public_media_base = Some("https://203.0.113.10".into());
        state.public_media_socket = Some(socket);
        let claim = registered_library(&h).await;
        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Members;
        let start = |source: &'static str, body: serde_json::Value| {
            let (h, claim) = (&h, claim.clone());
            async move {
                h.send(
                    "POST",
                    "/remux/session",
                    Some(body.to_string()),
                    &[
                        ("host", "d.oxy.fi"),
                        ("content-type", "application/json"),
                        ("x-den-library-member", &claim),
                        ("x-forwarded-for", source),
                    ],
                )
                .await
            }
        };
        let scope = |resp: &axum::response::Response| resp.extensions().get::<ListenerScope>().map(|s| s.0);

        let resp = start("2001:db8::7", json!({ "ipv4Hint": "8.8.8.8" })).await;
        assert_eq!((resp.status(), scope(&resp)), (StatusCode::CREATED, Some("hint")));
        assert_eq!(crate::handler::tests::body_json(resp).await["hinted"], true);
        assert_eq!(
            opened.recv().await.unwrap(),
            json!({ "open": true, "source": "8.8.8.8", "scope": "browser" })
        );
        assert_eq!(relayed.lock().unwrap().last().unwrap(), &json!({}), "remux never sees the hint");

        // Seen over IPv6 and saying nothing either way: sent back for a hint, with nothing relayed or opened.
        let before = relayed.lock().unwrap().len();
        for body in [json!({}), json!({ "noHint": false })] {
            let resp = start("2001:db8::7", body.clone()).await;
            assert_eq!(resp.status(), StatusCode::PRECONDITION_REQUIRED, "{body}");
            let logged = resp.extensions().get::<crate::handler::ErrorCode>().map(|c| c.0.clone());
            assert_eq!(logged.as_deref(), Some("ipv4_hint_wanted"), "{body}");
            assert_eq!(scope(&resp), None, "{body}");
            assert_eq!(crate::handler::tests::body_json(resp).await["error"], "ipv4_hint_wanted", "{body}");
        }
        assert_eq!(relayed.lock().unwrap().len(), before, "nothing reaches remux");
        assert!(opened.try_recv().is_err(), "no listener is opened");
        // Seen over IPv4 it is never asked for one.
        let resp = start("203.0.113.8", json!({})).await;
        assert_eq!((resp.status(), scope(&resp)), (StatusCode::CREATED, Some("browser")));
        assert_eq!(opened.recv().await.unwrap()["source"], "203.0.113.8");

        for body in [
            json!({ "noHint": true }),
            json!({ "ipv4Hint": "100.64.1.1" }),
            json!({ "ipv4Hint": "127.0.0.1" }),
            json!({ "ipv4Hint": "8.8.8.8", "noHint": true }),
        ] {
            let resp = start("2001:db8::7", body.clone()).await;
            assert_eq!((resp.status(), scope(&resp)), (StatusCode::CREATED, Some("wide:ipv6")), "{body}");
            assert!(crate::handler::tests::body_json(resp).await.get("hinted").is_none(), "{body}");
            assert_eq!(opened.recv().await.unwrap()["scope"], "cast", "{body}");
            assert_eq!(relayed.lock().unwrap().last().unwrap(), &json!({}), "{body}");
        }

        let resp = start("203.0.113.7", json!({ "ipv4Hint": "9.9.9.9" })).await;
        assert_eq!((resp.status(), scope(&resp)), (StatusCode::CREATED, Some("browser")));
        assert_eq!(opened.recv().await.unwrap()["source"], "203.0.113.7", "the observed address wins");

        // One /64 may name `MEMBER_HINTS` distinct addresses an hour; a known one, or another /64, still plays.
        for hint in ["9.9.9.9", "1.1.1.1", "1.0.0.1"] {
            let resp = start("2001:db8::8", json!({ "ipv4Hint": hint })).await;
            assert_eq!(resp.status(), StatusCode::CREATED, "{hint}");
        }
        let refused = start("2001:db8::9", json!({ "ipv4Hint": "8.8.4.4" })).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(crate::handler::tests::body_json(refused).await["error"], "hint_limit");
        assert_eq!(
            start("2001:db8::9", json!({ "ipv4Hint": "8.8.8.8" })).await.status(),
            StatusCode::CREATED
        );
        let other = start("2001:db8:1::9", json!({ "ipv4Hint": "8.8.4.4" })).await;
        assert_eq!(other.status(), StatusCode::CREATED);
        h.advance(super::MEMBER_HINT_TTL_MS);
        assert_eq!(
            start("2001:db8::9", json!({ "ipv4Hint": "8.8.4.4" })).await.status(),
            StatusCode::CREATED
        );

        let metrics = h.state.metrics.render();
        for counted in [
            r#"den_edge_public_media_hinted_total{who="member"} 7"#,
            r#"den_edge_public_media_wide_total{reason="ipv6",who="member"} 4"#,
            r#"den_edge_public_media_hint_rejected_total{reason="not_global"} 2"#,
            r#"den_edge_public_media_hint_rejected_total{reason="limit"} 1"#,
            r#"den_edge_public_media_hint_wanted_total{who="member"} 2"#,
            r#"den_edge_public_media_hint_wanted_total{who="guest"} 0"#,
        ] {
            assert!(metrics.contains(counted), "{counted} in {metrics}");
        }
    }

    #[test]
    fn an_ipv4_hint_is_one_global_ipv4_address() {
        let hint = |value: serde_json::Value| super::hint_address(&value).map(|a| a.to_string());
        for global in ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.32.0.1", "198.20.0.1"] {
            assert_eq!(hint(json!(global)), Ok(global.to_owned()));
        }
        for special in [
            "0.0.0.0",
            "0.1.2.3",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "100.64.0.1",
            "100.127.255.255",
            "192.0.0.8",
            "198.18.0.1",
            "198.19.255.255",
        ] {
            assert_eq!(hint(json!(special)), Err("not_global"), "{special}");
        }
        for malformed in [
            json!("8.8.8.8/32"),
            json!("8.8.8.8:443"),
            json!(" 8.8.8.8"),
            json!("08.8.8.8"),
            json!("8.8.8"),
            json!("::ffff:8.8.8.8"),
            json!("2001:4860::8888"),
            json!(["8.8.8.8"]),
            json!(null),
        ] {
            assert_eq!(hint(malformed.clone()), Err("malformed"), "{malformed}");
        }
    }

    #[test]
    fn a_hint_is_taken_out_of_the_session_body() {
        let take = |body: &str| {
            let (body, hint, no_hint) = super::take_hint(axum::body::Bytes::from(body.to_owned())).unwrap();
            (String::from_utf8(body.to_vec()).unwrap(), hint, no_hint)
        };
        assert_eq!(
            take(r#"{"a":1,"ipv4Hint":"8.8.8.8"}"#),
            (r#"{"a":1}"#.into(), Some(json!("8.8.8.8")), false)
        );
        assert_eq!(take(r#"{"a":1,"ipv4Hint":"8.8.8.8","noHint":true}"#), (r#"{"a":1}"#.into(), None, true));
        assert_eq!(take(r#"{"a":1,"noHint":true}"#), (r#"{"a":1}"#.into(), None, true));
        assert_eq!(take(r#"{"a":1,"noHint":false}"#), (r#"{"a":1}"#.into(), None, false));
        // Untouched when there is nothing to take, byte for byte, and when it is not an object.
        assert_eq!(take(r#"{ "a": 1 }"#), (r#"{ "a": 1 }"#.into(), None, false));
        assert_eq!(take("not json"), ("not json".into(), None, false));
    }

    #[test]
    fn a_public_session_names_the_listener_scope_it_needs() {
        let v4: std::net::IpAddr = "203.0.113.7".parse().unwrap();
        let v6: std::net::IpAddr = "2001:db8::7".parse().unwrap();
        assert_eq!(super::listener_scope(false, v4), "browser");
        assert_eq!(super::listener_scope(false, v6), "wide:ipv6");
        assert_eq!(super::listener_scope(true, v4), "wide:cast");
        assert_eq!(super::listener_scope(true, v6), "wide:cast");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn public_base_is_revealed_only_after_the_listener_acknowledges() {
        let (body, ask) = members_cast_session("https://203.0.113.10").await;
        assert_eq!(body["publicBase"], "https://203.0.113.10");
        assert_eq!(body["castOrigin"], "https://cast.oxy.fi");
        assert_eq!(ask, json!({ "open": true, "source": "192.168.1.9", "scope": "cast" }));
    }

    /// The LAN name resolves to a private address, so it means something only to a client behind the home's router,
    /// whose public address is the home's. A member playing from anywhere else would try it first on every play.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_lan_base_is_not_handed_to_a_client_away_from_home() {
        let (body, _) = members_cast_session("https://203.0.113.10").await;
        assert!(body.get("lanBase").is_none(), "the client is not at the home address: {body}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_lan_base_is_handed_to_a_client_behind_the_homes_router() {
        // The public base is at the client's own address: the same router, so the home address is the client's.
        let (body, _) = members_cast_session("https://192.168.1.9").await;
        assert_eq!(body["lanBase"], "https://lan.media.example:8449");
        assert_eq!(body["publicBase"], "https://192.168.1.9");
    }

    /// With the home's address unknown, nobody is handed the LAN base: a wrong guess costs every visitor a failed
    /// connection, and a missing one only the home's own phone.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_lan_base_is_withheld_when_the_home_address_is_unknown() {
        let (body, _) = members_cast_session("https://home.invalid").await;
        assert!(body.get("lanBase").is_none(), "{body}");
        assert_eq!(body["publicBase"], "https://home.invalid");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_listener_ends_the_public_session_and_returns_a_retry() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let sid = "A".repeat(22);
        let sig = "b".repeat(22);
        let session_path = format!("/remux/s/{sid}/{sig}");
        let playlist = format!("{session_path}/master.m3u8");
        let (deleted_tx, deleted_rx) = tokio::sync::oneshot::channel();
        let deleted_tx = Arc::new(std::sync::Mutex::new(Some(deleted_tx)));
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let app = axum::Router::new().fallback({
            let deleted_tx = Arc::clone(&deleted_tx);
            move |req: axum::extract::Request| {
                let deleted_tx = Arc::clone(&deleted_tx);
                let playlist = playlist.clone();
                let session_path = session_path.clone();
                async move {
                    if req.method() == axum::http::Method::DELETE {
                        assert_eq!(req.uri().path(), session_path);
                        if let Some(sent) = deleted_tx.lock().unwrap().take() {
                            let _ = sent.send(());
                        }
                        (StatusCode::NO_CONTENT, String::new())
                    } else {
                        (StatusCode::CREATED, json!({ "playlist": playlist }).to_string())
                    }
                }
            }
        });
        tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });

        let dir = crate::handler::tests::temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("listener.sock");
        let unix = tokio::net::UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let (stream, _) = unix.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            stream.into_inner().write_all(b"no\n").await.unwrap();
        });

        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.relays = crate::parse_relays(&format!("/remux=http://{upstream_addr}"));
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        state.public_media_base = Some("https://203.0.113.10".into());
        state.public_media_socket = Some(socket);
        let claim = registered_library(&h).await;
        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Members;
        let answer = h
            .send(
                "POST",
                "/remux/session",
                Some(json!({ "player": "cast" }).to_string()),
                &[
                    ("host", "d.oxy.fi"),
                    ("content-type", "application/json"),
                    ("x-den-library-member", &claim),
                ],
            )
            .await;
        assert_eq!(answer.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(answer.headers().contains_key("retry-after"));
        // The log line says which scope was refused, and nothing opened is counted.
        assert_eq!(answer.extensions().get::<ListenerScope>().map(|s| s.0), Some("wide:cast"));
        let code = answer.extensions().get::<crate::handler::ErrorCode>().map(|c| c.0.clone());
        assert_eq!(code.as_deref(), Some("public_listener_unavailable"));
        let metrics = h.state.metrics.render();
        assert!(
            metrics.contains(r#"den_edge_public_media_wide_total{reason="cast",who="member"} 0"#),
            "{metrics}"
        );
        deleted_rx.await.unwrap();
    }

    /// A member whose address changed mid-film asks for the listener again for the session it holds: den-remux is asked
    /// only whether that signed session is live (`HEAD` of its playlist), and only a live one opens the listener, for
    /// the address the call comes from. A dead one is answered as den-remux answered it, and a refused listener never
    /// ends the session that plays on.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_grant_is_asked_again_for_a_live_session_from_the_address_it_comes_from() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let sid = "A".repeat(22);
        let sig = "b".repeat(22);
        let playlist = format!("/remux/s/{sid}/{sig}/master.m3u8");
        let asked = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let app = axum::Router::new().fallback({
            let asked = Arc::clone(&asked);
            let live = playlist.clone();
            move |req: axum::extract::Request| {
                let asked = Arc::clone(&asked);
                let live = live.clone();
                async move {
                    asked.lock().unwrap().push(format!("{} {}", req.method(), req.uri().path()));
                    if req.uri().path() == live {
                        StatusCode::OK
                    } else {
                        StatusCode::GONE
                    }
                }
            }
        });
        tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });

        let dir = crate::handler::tests::temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("listener.sock");
        let unix = tokio::net::UnixListener::bind(&socket).unwrap();
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            // Acknowledged once, then refused.
            for answer in [&b"ok\n"[..], &b"no\n"[..]] {
                let (stream, _) = unix.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let _ = sent.send(line);
                stream.into_inner().write_all(answer).await.unwrap();
            }
        });

        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.relays = crate::parse_relays(&format!("/remux=http://{upstream_addr}"));
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        state.public_media_base = Some("https://203.0.113.10".into());
        state.public_media_socket = Some(socket);
        let claim = registered_library(&h).await;
        Arc::get_mut(&mut h.state).unwrap().new_libraries = crate::library::NewLibraries::Members;
        let grant = |body: serde_json::Value, member: bool| {
            let h = &h;
            let claim = claim.clone();
            async move {
                let headers: Vec<(&str, &str)> = [("host", "d.oxy.fi"), ("content-type", "application/json")]
                    .into_iter()
                    .chain(member.then_some(("x-den-library-member", claim.as_str())))
                    .collect();
                h.send("POST", "/remux/grant", Some(body.to_string()), &headers).await
            }
        };

        assert_eq!(
            grant(json!({ "playlist": playlist }), false).await.status(),
            StatusCode::NOT_FOUND,
            "only a member (or a guest's grant) may ask"
        );
        assert!(asked.lock().unwrap().is_empty());

        let answer = grant(json!({ "playlist": playlist }), true).await;
        assert_eq!(answer.status(), StatusCode::NO_CONTENT);
        assert_eq!(answer.headers()["cache-control"], "no-store");
        assert_eq!(answer.extensions().get::<ListenerScope>().map(|s| s.0), Some("browser"));
        let ask: serde_json::Value = serde_json::from_str(received.recv().await.unwrap().trim()).unwrap();
        assert_eq!(ask, json!({ "open": true, "source": "192.168.1.9", "scope": "browser" }));
        assert_eq!(asked.lock().unwrap().as_slice(), [format!("HEAD {playlist}")]);

        let other = format!("/remux/s/{}/{sig}/master.m3u8", "C".repeat(22));
        let gone = grant(json!({ "playlist": other }), true).await;
        assert_eq!(gone.status(), StatusCode::GONE, "a session den-remux no longer has opens nothing");
        for not_a_session in [json!({ "playlist": "/remux/session" }), json!({}), json!({ "playlist": 1 })] {
            assert_eq!(grant(not_a_session, true).await.status(), StatusCode::BAD_REQUEST);
        }

        let refused = grant(json!({ "playlist": playlist }), true).await;
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(refused.headers().contains_key("retry-after"));
        received.recv().await.unwrap();
        assert!(
            asked.lock().unwrap().iter().all(|a| a.starts_with("HEAD ")),
            "the playing session is never ended: {:?}",
            asked.lock().unwrap()
        );
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

    /// Relaying `/atlas` at a port nothing listens on, as `harness` does `/scout`.
    fn atlas() -> Harness {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays("/atlas=http://127.0.0.1:9");
        h
    }

    const TUNED: &str = "/atlas/playground/similar/movie/1.json?pool_k=1000&limit=200";

    /// A tuned row is computed per call and can be ~0.7 MB, so the playground is held to far fewer calls than
    /// browsing — and spending them leaves the visitor's browsing allowance whole.
    #[tokio::test]
    async fn the_playground_has_its_own_smaller_allowance() {
        let h = atlas();
        for i in 0..super::PLAYGROUND_PER_WINDOW {
            assert_eq!(h.send("GET", TUNED, None, &[]).await.status(), StatusCode::BAD_GATEWAY, "{i}");
        }
        let refused = h.send("GET", TUNED, None, &[]).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(refused.headers().contains_key("retry-after"), "the refusal never said when to return");
        // The page, its knobs and a path under an install's config are the same playground, on the same budget.
        for path in [
            "/atlas/playground",
            "/atlas/playground/params.json",
            "/atlas/us_8/playground/similar/movie/1.json",
        ] {
            assert_eq!(
                h.send("GET", path, None, &[]).await.status(),
                StatusCode::TOO_MANY_REQUESTS,
                "{path}"
            );
        }

        for i in 0..super::GUEST_PER_WINDOW {
            let browsing = h.send("GET", "/atlas/recommend", None, &[]).await;
            assert_eq!(browsing.status(), StatusCode::BAD_GATEWAY, "browsing refused at {i}");
        }
        assert_eq!(
            h.send("GET", "/atlas/recommend", None, &[]).await.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    /// And the other way round: a visitor who has browsed their allowance away has not spent the playground's.
    #[tokio::test]
    async fn browsing_does_not_spend_the_playgrounds_allowance() {
        let h = atlas();
        for _ in 0..super::GUEST_PER_WINDOW {
            h.send("GET", "/atlas/recommend", None, &[]).await;
        }
        assert_eq!(
            h.send("GET", "/atlas/recommend", None, &[]).await.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(h.send("GET", TUNED, None, &[]).await.status(), StatusCode::BAD_GATEWAY);
    }

    /// However many addresses call the playground, it holds at most its share of the relay's slots, and the web
    /// app still gets through beside it.
    #[tokio::test]
    async fn the_playground_holds_only_its_share_of_the_relay() {
        // An atlas whose tuned rows never finish, so every playground call that reaches it stays in flight.
        let (arrived_tx, mut arrived) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
            let arrived_tx = arrived_tx.clone();
            async move {
                if req.uri().path().starts_with("/playground/") {
                    let _ = arrived_tx.send(());
                    std::future::pending::<()>().await;
                }
                StatusCode::OK
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays(&format!("/atlas=http://{addr}"));
        let h = Arc::new(h);

        let held: Vec<_> = (0..super::PLAYGROUND_IN_FLIGHT)
            .map(|_| {
                let h = Arc::clone(&h);
                tokio::spawn(async move { h.send("GET", TUNED, None, &[]).await.status() })
            })
            .collect();
        for _ in 0..super::PLAYGROUND_IN_FLIGHT {
            arrived.recv().await.unwrap();
        }

        let wait = std::time::Duration::from_secs(2);
        let refused = tokio::time::timeout(wait, h.send("GET", TUNED, None, &[]))
            .await
            .expect("a playground call past its share was sent on to atlas");
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(refused.headers().contains_key("retry-after"), "the refusal never said when to return");
        assert_eq!(crate::handler::tests::body_json(refused).await, json!({ "error": "playground_busy" }));

        let browsing =
            tokio::time::timeout(wait, h.send("GET", "/atlas/recommend", None, &[])).await.unwrap();
        assert_eq!(browsing.status(), StatusCode::OK, "the web app waited on the playground");
        for task in held {
            task.abort();
        }
    }

    /// A tuned row answers one caller's knobs, so nothing in front of this origin may keep it, even if atlas
    /// ever forgot to say so.
    #[tokio::test]
    async fn a_tuned_row_is_never_caching_material() {
        let addon = public_addon().await;
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays(&format!("/atlas={addon}"));
        let tuned = h.send("GET", TUNED, None, &[]).await;
        assert_eq!(tuned.headers()["cache-control"], "no-store");
        let browsing = h.send("GET", "/atlas/recommend", None, &[]).await;
        assert_eq!(browsing.headers()["cache-control"], "public, max-age=300, stale-while-revalidate=60");
    }

    #[test]
    fn only_atlas_playground_paths_are_the_playground() {
        for path in [
            "/atlas/playground",
            "/atlas/playground/",
            "/atlas/playground/params.json",
            "/atlas/playground/similar/series/1438.json",
            "/atlas/us_8/playground/similar/movie/1.json",
            "/atlas//playground/similar/movie/1.json",
        ] {
            assert!(super::playground(path), "{path}");
        }
        for path in
            ["/atlas/recommend", "/atlas/index/similar/movie/1.json", "/scout/playground", "/playground"]
        {
            assert!(!super::playground(path), "{path}");
        }
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
        // `/scout` and `/scout?…` are relayed to scout's own `/`, and are scout's as much as the rest.
        for bare in ["/scout", "/scout?x=1"] {
            let guest = h.send("GET", bare, None, &[("host", "d.oxy.fi")]).await;
            assert_eq!(guest.status(), StatusCode::NOT_FOUND, "{bare}");
        }

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

    /// The cap is on viewers at once, because that is what spends the household's upload — not on
    /// trailers, and not on requests, which a rate limit already bounds.
    #[tokio::test]
    async fn a_guest_holds_one_slot_however_many_trailers_it_opens() {
        let mut h = reel();
        Arc::get_mut(&mut h.state).unwrap().guest_media_slots = Arc::new(tokio::sync::Semaphore::new(1));

        let first = h.send("GET", "/reel/hls/aaaaaaaaaaa.m3u8", None, &[]).await;
        assert_eq!(first.status(), StatusCode::BAD_GATEWAY, "admitted, and the addon is not there");

        // The next slide takes that lease over instead of opening a second. Keyed per video this was
        // a 503: Home changes slide every fifteen seconds against a thirty-second idle lease, so one
        // viewer held the trailer playing now and the one before it, idling out with nothing flowing.
        let second = h.send("GET", "/reel/hls/bbbbbbbbbbb.m3u8", None, &[]).await;
        assert_eq!(second.status(), StatusCode::BAD_GATEWAY, "the same viewer, not a second one");

        // A segment rides it too. Refusing one would stall a trailer that is already playing instead
        // of falling back cleanly.
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
        // Refused at the start, where the page turns it into YouTube's embed, and told when to come
        // back rather than left to guess.
        assert!(proxied.headers().contains_key("retry-after"));

        // And the flag buys nothing on the bytes: a segment with no lease open takes a slot itself.
        let segment =
            h.send("GET", "/reel/hls/seg?u=https%3A%2F%2Fr1.googlevideo.com%2Fx&native=1", None, &[]).await;
        assert_eq!(segment.status(), StatusCode::SERVICE_UNAVAILABLE, "a segment is still carried");
    }

    /// A reel that answers every request with `sent` bytes of a 1 MiB body and then holds the connection open, so the
    /// stream is still running when a test looks.
    async fn reel_mid_stream(sent: usize) -> Harness {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut conn, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let _ = conn.read(&mut [0; 4096]).await;
                    let head =
                        "HTTP/1.1 200 OK\r\ncontent-type: video/mp2t\r\ncontent-length: 1048576\r\n\r\n";
                    conn.write_all(head.as_bytes()).await.unwrap();
                    conn.write_all(&vec![0; sent]).await.unwrap();
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                });
            }
        });
        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.relays = crate::parse_relays(&format!("/reel=http://{addr}"));
        state.trusted_proxies = vec!["192.168.1.9".parse().unwrap()];
        h
    }

    /// An addon that sends its head and part of its body, then goes silent, is given up on at the deadline rather than
    /// holding the relay slot for as long as it stays silent.
    #[tokio::test]
    async fn an_answer_that_stalls_mid_body_is_given_up_on() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let _ = conn.read(&mut [0; 4096]).await;
            conn.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        });
        let ask = axum::http::Request::get(format!("http://{addr}/x"))
            .body(http_body_util::Full::new(axum::body::Bytes::new()))
            .unwrap();
        let answer = super::client().request(ask).await.unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(200);
        let given_up = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            super::collect_by(answer.into_body(), deadline),
        )
        .await
        .expect("still waiting on the body");
        assert_eq!(given_up.unwrap_err().status(), StatusCode::GATEWAY_TIMEOUT);
    }

    /// A player keeps asking for segments for as long as it plays, and the budget is per minute. Counted in a window
    /// that moved on with every request allowed, a steady viewer's window never closed: at one segment a second the
    /// 601st, ten minutes in, was refused mid-trailer. Browsing the JSON relay met the same wall at its 121st call.
    #[tokio::test]
    async fn a_steady_viewer_or_browser_is_never_refused() {
        let h = reel();
        for i in 0..700 {
            let status = h.send("GET", SEGMENT, None, &[]).await.status();
            assert_ne!(status, StatusCode::TOO_MANY_REQUESTS, "segment {i}");
            h.advance(1_000);
        }
        let h = harness();
        for i in 0..150 {
            assert_ne!(ask(&h, &[]).await, StatusCode::TOO_MANY_REQUESTS, "call {i}");
            h.advance(10_000);
        }
    }

    const SEGMENT: &str = "/reel/hls/seg?u=https%3A%2F%2Fr1.googlevideo.com%2Fx";

    /// A guest's bytes are counted on the day they leave. A stream begun before UTC midnight used to put its later
    /// bytes on the day it began, and in doing so wiped the new day's count back to zero.
    #[tokio::test]
    async fn a_guests_bytes_after_midnight_count_toward_the_new_day() {
        use http_body_util::BodyExt;
        let h = reel_mid_stream(1000).await;
        let resp = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.1")]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        h.advance(86_400_000);
        *crate::lock(&h.state.media_spent) = (1, 500);
        let mut body = resp.into_body();
        let mut got = 0;
        while got < 1000 {
            got += body.frame().await.unwrap().unwrap().into_data().unwrap().len();
        }
        assert_eq!(*crate::lock(&h.state.media_spent), (1, 1500));
    }

    /// The guest cap bounds viewers at once, so a slot is held for as long as a guest's trailer is still streaming,
    /// not only for the thirty seconds after its last request: a long stream used to outlive it and let another
    /// guest in past the cap.
    #[tokio::test]
    async fn a_guest_slot_is_held_while_its_trailer_streams() {
        use http_body_util::BodyExt;
        let mut h = reel_mid_stream(10).await;
        Arc::get_mut(&mut h.state).unwrap().guest_media_slots = Arc::new(tokio::sync::Semaphore::new(1));
        let first = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.1")]).await;
        assert_eq!(first.status(), StatusCode::OK);
        let mut body = first.into_body();
        h.advance(super::LEASE_IDLE_MS - 1);
        assert_eq!(body.frame().await.unwrap().unwrap().into_data().unwrap().len(), 10);
        h.advance(2);

        let other = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.2")]).await;
        assert_eq!(other.status(), StatusCode::SERVICE_UNAVAILABLE, "the first guest is still watching");
        let same = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.1")]).await;
        assert_eq!(same.status(), StatusCode::OK, "and still holds its own slot");

        drop((body, same));
        h.advance(super::LEASE_IDLE_MS + 1);
        let other = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.2")]).await;
        assert_eq!(other.status(), StatusCode::OK, "the slot came back once it stopped");
    }

    /// A body that stops sending — a paused trailer, a phone gone off Wi-Fi, a stalled addon — gives its slot back
    /// once it has been silent for the idle time, though its connection is still open; it used to hold the slot for
    /// as long as it stayed open. The stream itself is not cut.
    #[tokio::test]
    async fn a_guest_slot_comes_back_from_a_stream_that_went_silent() {
        use http_body_util::BodyExt;
        let mut h = reel_mid_stream(10).await;
        Arc::get_mut(&mut h.state).unwrap().guest_media_slots = Arc::new(tokio::sync::Semaphore::new(1));
        let first = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.1")]).await;
        assert_eq!(first.status(), StatusCode::OK);
        let mut body = first.into_body();
        assert_eq!(body.frame().await.unwrap().unwrap().into_data().unwrap().len(), 10);
        h.advance(super::LEASE_IDLE_MS + 1);

        let other = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.2")]).await;
        assert_eq!(other.status(), StatusCode::OK, "the silent stream gave its slot back");
        let again = h.send("GET", SEGMENT, None, &[("x-forwarded-for", "203.0.113.1")]).await;
        assert_eq!(again.status(), StatusCode::SERVICE_UNAVAILABLE, "and its address starts over for one");
        drop(body);
    }

    /// An addon that says its answer may be kept by anyone, and echoes the validator it was sent.
    async fn public_addon() -> String {
        use axum::http::{header, HeaderValue};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|req: axum::extract::Request| async move {
            let since = req.headers().get(header::IF_MODIFIED_SINCE).map(|v| v.to_str().unwrap().to_owned());
            let mut resp =
                axum::response::Response::new(axum::body::Body::from(json!({ "since": since }).to_string()));
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=300, stale-while-revalidate=60"),
            );
            resp
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    /// Only a member is answered on the web name, so what scout says anyone may keep must not be kept by a shared
    /// cache in front of it, to be handed to whoever asks next.
    #[tokio::test]
    async fn scout_on_the_web_name_is_never_shared_caching_material() {
        let addon = public_addon().await;
        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.relays = crate::parse_relays(&format!("/scout={addon}, /atlas={addon}"));
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
        let body = json!({ "writes": [{ "k": "aaaaaaaaaaaaaaaa", "base": 0, "v": "c1" }] }).to_string();
        h.send("POST", &format!("/lib/{LIB}/batch"), Some(body), &[("x-den-library-token", TOKEN)]).await;
        let member = format!("{LIB}:{TOKEN}");

        let policy =
            |resp: axum::response::Response| resp.headers()["cache-control"].to_str().unwrap().to_owned();
        let web = h
            .send(
                "GET",
                "/scout/cfg/manifest.json",
                None,
                &[("host", "d.oxy.fi"), ("x-den-library-member", &member)],
            )
            .await;
        assert_eq!(policy(web), "private, max-age=300, stale-while-revalidate=60");
        let lan = h.send("GET", "/scout/cfg/manifest.json", None, &[]).await;
        assert_eq!(
            policy(lan),
            "public, max-age=300, stale-while-revalidate=60",
            "anyone may ask on the LAN"
        );
        let atlas = h.send("GET", "/atlas/recommend", None, &[("host", "d.oxy.fi")]).await;
        assert_eq!(policy(atlas), "public, max-age=300, stale-while-revalidate=60", "atlas answers everyone");

        assert_eq!(super::private(&"no-store".parse().unwrap()), "no-store");
        assert_eq!(super::private(&"PUBLIC,max-age=5".parse().unwrap()), "private, max-age=5");
    }

    /// A trailer's revalidation is the addon's 304 too, whichever validator the player holds.
    #[tokio::test]
    async fn the_media_relay_passes_on_if_modified_since() {
        let addon = public_addon().await;
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().relays = crate::parse_relays(&format!("/reel={addon}"));
        let since = "Sat, 12 Sep 2026 12:00:00 GMT";
        let resp = h.send("GET", "/reel/play/abc.mp4", None, &[("if-modified-since", since)]).await;
        assert_eq!(crate::handler::tests::body_json(resp).await, json!({ "since": since }));
    }

    #[test]
    fn only_a_playlist_asked_for_natively_is_exempt() {
        assert!(super::native_master("/reel/hls/dQw4w9WgXcQ.m3u8", Some("s=tag&native=1")));
        assert!(!super::native_master("/reel/hls/dQw4w9WgXcQ.m3u8", Some("s=tag")));
        assert!(!super::native_master("/reel/hls/dQw4w9WgXcQ.m3u8", None));
        // The file and the segments are what this box carries, whatever they ask for.
        assert!(!super::native_master("/reel/play/dQw4w9WgXcQ.mp4", Some("native=1")));
        assert!(!super::native_master("/reel/hls/seg", Some("u=x&native=1")));
        // Minted URLs say which they are in the path, because the blob that decides it is reel's to read.
        // No `native=1` needed, and none believed: the segment is the whole of it.
        assert!(super::native_master("/reel/m/n/AbC123", Some("s=tag")));
        assert!(super::native_master("/reel/cfg/m/n/AbC123", Some("s=tag")));
        assert!(!super::native_master("/reel/m/s/AbC123", Some("s=tag")));
        // A proxied master's segments are carried by this box, one slot each.
        assert!(!super::native_master("/reel/m/s/seg", Some("u=x")));
        // Claiming it in the query buys nothing now the path is what is read.
        assert!(!super::native_master("/reel/m/s/AbC123", Some("s=tag&native=1")));
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
        // `/progressive` belongs here for the reason the others do, and it was left out when den-edge
        // started asking for it: the JSON path collects a whole body and refuses anything past eight
        // megabytes, so a trailer served that way came back 502 — measured, on a 7 MB slide that only
        // squeaked under it and a larger one that did not. It forwards no `Range` either, so nothing
        // relayed that way could seek.
        for path in [
            "/reel/play/abc.mp4",
            "/reel/cfg/play/abc.mp4",
            "/reel/hls/abc.m3u8",
            "/reel/seg/1.ts",
            "/reel/progressive/abc.mp4",
            "/reel/cfg/progressive/abc.mp4",
            // Minted URLs: both kinds, the proxied master's segments, and one behind an install's config.
            "/reel/m/n/AbC123",
            "/reel/m/s/AbC123",
            "/reel/m/s/seg",
            "/reel/cfg/m/s/AbC123",
            // A kind reel has not invented yet. Listing only the known ones is how `/progressive` came to
            // be relayed as JSON, collected whole and refused past eight megabytes, so anything minted
            // streams — being wrongly called media costs nothing, and being wrongly called JSON breaks it.
            "/reel/m/x/AbC123",
        ] {
            assert!(super::media(path), "{path}");
        }
        for path in [
            "/reel/cfg/meta/movie/tmdb:550.json",
            "/reel/direct/abc.json",
            "/scout/cfg/play/ticket",
            "/atlas/recommend",
            "/playlist",
            // `m` naming nothing is not a minted URL; reel dropped the bare `/m/<blob>` form.
            "/reel/m",
        ] {
            assert!(!super::media(path), "{path}");
        }
    }
}
