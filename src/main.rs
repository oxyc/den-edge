//! den-edge — Den's sync relay, on the homelab. It relays pairings between a TV and another device, carries a
//! paired device's sealed messages to the TV (the inbox), and keeps the library's record log. It also serves the
//! Den web app. It never interprets what it stores: the log and the inbox are ciphertext the devices seal.
//!
//! State lives in files under `DATA_DIR`; pairing sessions live in memory only.

mod cache;
mod grants;
mod handler;
mod home;
mod inbox;
mod library;
mod link;
mod meta;
mod metrics;
mod pair;
mod ratings;
mod relay;
mod routes;
mod skipdb;
mod store;
mod sync;
mod title_metadata;
mod tmdb;
mod warnings;
mod web;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct AppState {
    pub store: store::Store,
    /// Held across every read-modify-write on the store, so an inbox append, a drain and a versioned write
    /// each happen as one step. Workers KV could not do this, which is how its inbox lost messages when two
    /// arrived at once. One household never contends on it.
    pub write_lock: tokio::sync::Mutex<()>,
    /// The record logs loaded so far, by library id — one household's, a few MB at most. Held across a batch
    /// or a read, so each library's compare-and-set is one step.
    pub libraries: tokio::sync::Mutex<HashMap<String, library::Library>>,
    /// Memory budgets include keys and conservative allocation overhead, not only ciphertext.
    pub library_limits: library::Limits,
    /// Guesses per client address, to keep a pairing's nameplate from being guessed online.
    pub claims: Mutex<HashMap<String, link::Throttle>>,
    /// Pairing sessions by `sid`. Ten minutes long at most, so memory is enough: a restart costs a pairing in
    /// progress, which the TV simply starts again.
    pub pairs: Mutex<HashMap<String, pair::Session>>,
    /// Unix milliseconds. A field so a test can move time.
    pub clock: Box<dyn Fn() -> u64 + Send + Sync>,
    pub gen_nameplate: Box<dyn Fn() -> String + Send + Sync>,
    pub metrics: metrics::Metrics,
    /// Bearer token for `/metrics` (env `METRICS_TOKEN`). `None` turns the route off.
    pub metrics_token: Option<String>,
    /// One stderr line per request (env `LOG_REQUESTS`), naming the route and never a key.
    pub log_requests: bool,
    /// Origins a browser may call from (env `WEB_ORIGINS`, comma-separated): the Den web app when it is served
    /// from elsewhere. Empty sends no CORS headers at all — the app served here is same-origin and needs none.
    pub web_origins: Vec<String>,
    /// The Den web app's built files (env `WEB_DIR`), served at `/`. `None` serves no app.
    pub web_dir: Option<std::path::PathBuf>,
    /// Proxies whose report of the visitor's address counts (env `TRUSTED_PROXIES`, comma-separated IPs):
    /// `cloudflared` and `tailscale serve` connect from their own address (`handler::client_ip`).
    pub trusted_proxies: Vec<std::net::IpAddr>,
    /// The web app's public names (env `WEB_HOSTS`, comma-separated). They sit behind Cloudflare Access, and a
    /// request for one gets the web app and none of the device API (`handler::Face`, oxyc/den#15).
    pub web_hosts: Vec<String>,
    /// The device API's public names (env `API_HOSTS`). They bypass Access, so a request for one gets the
    /// device routes and never the web app — which would otherwise be handed out past Access.
    pub api_hosts: Vec<String>,
    /// Path prefix → addon LAN origin (env `ADDON_RELAY`: `/scout=http://192.168.86.193:8080,…`): what the web app
    /// asks on its own origin and den-edge fetches from the addon (`relay.rs`).
    pub relays: Vec<(String, String)>,
    pub relay_client: relay::RelayClient,
    /// Relayed fetches allowed in flight at once (`relay::MAX_IN_FLIGHT`), so the addons behind this origin can't
    /// be swamped through it.
    pub relay_slots: Arc<tokio::sync::Semaphore>,
    /// Of those, the ones atlas's tuning playground may hold at once (`relay::PLAYGROUND_IN_FLIGHT`).
    pub playground_slots: Arc<tokio::sync::Semaphore>,
    /// Every address for each service, in order (env `ROUTES`, den-spec routes-v1): served as `GET /routes`.
    pub routes: routes::Routes,
    /// The table served on the web app's public name instead of `routes` (env `ROUTES_PUBLIC`). The full table
    /// names the LAN addresses and the tailnet, which a public visitor has no use for and shouldn't be handed;
    /// `None` serves the full table everywhere, as before.
    pub routes_public: Option<routes::Routes>,
    /// The https origins the web app's CSP lets it fetch video from: den-remux's, for a title playing here,
    /// and den-reel's, for a trailer. Reel's were missing, so the policy refused every trailer on the public
    /// and tailnet names.
    pub media_origins: Vec<String>,
    /// Public IP-literal origin handed only to a proven member after the listener helper opened it.
    pub public_media_base: Option<String>,
    /// The same den-remux on the home network, over https, handed with the public base — but only to a client whose
    /// public address is the home's (`home.rs`). On home Wi-Fi the router does not loop a phone's request for the
    /// public address back in, so the player tries this one first; anywhere else it is unreachable and only costs a
    /// failed connection.
    pub lan_media_base: Option<String>,
    /// Where the home's public address is now, read from the public media base's host (`home.rs`).
    pub home_address: home::HomeAddress,
    /// Host helper socket mounted into the container. The helper owns nftables; den-edge can only request
    /// the fixed, short-lived public-listener action.
    pub public_media_socket: Option<std::path::PathBuf>,
    /// The static Cast sender/player origin allowed to frame the web app's playback handoff.
    pub cast_origin: Option<String>,
    /// Who may start a library (env `NEW_LIBRARIES`: `open` or `members`).
    pub new_libraries: library::NewLibraries,
    /// The household's TMDB key (env `TMDB_KEY`), lent to devices that have none of their own (`tmdb.rs`).
    /// `None` turns `/tmdb/` off entirely.
    pub tmdb_key: Option<String>,
    /// Built only when there is a key: it is the one client here that speaks TLS.
    pub tmdb_client: Option<tmdb::TmdbClient>,
    /// Where proxied answers are kept (`<DATA_DIR>/tmdb`). On disk and keyed by the question alone, so one
    /// answer serves every device that asks it and a restart doesn't throw six months of them away.
    pub tmdb_cache_dir: Option<std::path::PathBuf>,
    /// Questions that may actually reach TMDB in a day (env `TMDB_DAILY_MAX`); `None` is no ceiling.
    pub tmdb_daily_max: Option<u32>,
    /// Today (as a day number) and what has been spent of it.
    pub tmdb_spent: Mutex<(u64, u32)>,
    /// Stale lists and searches being asked of TMDB again right now, by cache key (`tmdb::refresh_behind`).
    pub tmdb_refreshing: Mutex<std::collections::HashSet<String>>,
    /// The household's doesthedogdie key (env `DOESTHEDOGDIE_KEY`), spent looking up a title a library member opens
    /// that nobody has yet (`warnings.rs`). `None` leaves lookups to callers who bring their own key.
    pub warnings_key: Option<String>,
    /// Where each title's warnings are kept (`<DATA_DIR>/warnings`), for every browser that opens it.
    pub warnings_cache_dir: Option<std::path::PathBuf>,
    /// Until when the household key is rested (ms): doesthedogdie said it was rate-limited, or its month is nearly
    /// spent.
    pub warnings_rest_until: Mutex<u64>,
    /// The household's OMDb key (env `OMDB_KEY`), spent looking up the ratings of a title a library member opens
    /// that nobody has yet (`ratings.rs`). `None` leaves lookups to callers who bring their own key.
    pub ratings_key: Option<String>,
    /// Where each title's ratings are kept (`<DATA_DIR>/ratings`), for every device that opens it.
    pub ratings_cache_dir: Option<std::path::PathBuf>,
    /// Allowlisted title metadata observed by paired clients, with TMDB and Atlas/IMDb provenance kept apart.
    /// This shared index exists even when the household has no TMDB key configured.
    pub title_metadata_cache_dir: Option<std::path::PathBuf>,
    /// Serializes the small read/merge/write records so simultaneous partial observations cannot erase fields.
    pub title_metadata_writes: tokio::sync::Mutex<()>,
    /// Questions the household key may ask OMDb in a UTC day (env `OMDB_DAILY_MAX`); `None` is no ceiling of ours.
    pub ratings_daily_max: Option<u32>,
    /// Today (as a day number) and what the household key has spent of it.
    pub ratings_spent: Mutex<(u64, u32)>,
    /// Titles whose stale ratings are being fetched again right now (`ratings::refresh_behind`).
    pub ratings_refreshing: Mutex<std::collections::HashSet<String>>,
    /// Where each release's skip segments are kept (`<DATA_DIR>/skipdb`), for every browser that plays it
    /// (`skipdb.rs`). SkipDB's read API needs no key, so there is nothing to spend and no household key here.
    pub skipdb_cache_dir: Option<std::path::PathBuf>,
    /// SIMKL's public client id (env `SIMKL_CLIENT_ID`), served as part of `/config`. Not a secret: SIMKL's
    /// PIN flow runs in the browser and needs only this. `None` leaves it out, and the app hides its sign-in.
    pub simkl_client_id: Option<String>,
    /// Guest trailer streams that may be in flight at once (`relay::GUEST_MEDIA_STREAMS`).
    ///
    /// The per-address budgets bound requests per minute, which is not the thing the household feels: what
    /// hurts is several 1080p streams running at the same moment, saturating the upload the TVs also live on.
    /// A permit is held for the life of a streamed response, so this counts what is actually flowing rather
    /// than how often it was asked for. Members never take one.
    pub guest_media_slots: Arc<tokio::sync::Semaphore>,
    /// Bytes of trailer a guest may be served in a day (env `MEDIA_DAILY_MAX_BYTES`); `None` is no ceiling.
    /// The kill switch the concurrency cap cannot be: three streams running all day is still three streams.
    pub media_daily_max: Option<u64>,
    /// Today (as a day number) and the guest bytes served in it.
    ///
    /// Behind an `Arc` because a streamed body outlives the request that started it: the counter has to
    /// travel with the stream and be added to as the frames go out, not once when the headers do.
    pub media_spent: Arc<Mutex<(u64, u64)>>,
    /// Trailer sessions admitted through the media relay, by rate-limit bucket and video.
    ///
    /// A session is admitted once, at its master playlist (or at a first `/play` for a video nothing has
    /// opened yet), and every request that follows belongs to that admission — segments are never refused,
    /// because a refusal mid-playback is a stall rather than a clean fall back to the embed. A guest's
    /// lease holds one of `guest_media_slots`, which comes back when the lease expires.
    pub media_leases: Mutex<HashMap<String, relay::Lease>>,
    /// Guest grants' in-memory state (`grants.rs`): last use, media source addresses, sessions already ended.
    pub grants: grants::Grants,
    /// Shared with den-remux (env `REMUX_EDGE_SECRET` here, `EDGE_SECRET` there): what lets den-edge name a grant
    /// as a session's owner and end its sessions. Unset, a guest is offered no remux at all — without it remux
    /// would count the guest's sessions as the host's.
    pub remux_edge_secret: Option<String>,
}

impl AppState {
    pub fn new(store: store::Store, metrics_token: Option<String>, log_requests: bool) -> Self {
        AppState {
            store,
            write_lock: tokio::sync::Mutex::new(()),
            libraries: tokio::sync::Mutex::new(HashMap::new()),
            library_limits: library::Limits::default(),
            claims: Mutex::new(HashMap::new()),
            pairs: Mutex::new(HashMap::new()),
            clock: Box::new(now_ms),
            gen_nameplate: Box::new(pair::gen_nameplate),
            metrics: metrics::Metrics::default(),
            metrics_token,
            log_requests,
            web_origins: Vec::new(),
            web_dir: None,
            trusted_proxies: Vec::new(),
            web_hosts: Vec::new(),
            api_hosts: Vec::new(),
            relays: Vec::new(),
            relay_client: relay::client(),
            relay_slots: Arc::new(tokio::sync::Semaphore::new(relay::MAX_IN_FLIGHT)),
            playground_slots: Arc::new(tokio::sync::Semaphore::new(relay::PLAYGROUND_IN_FLIGHT)),
            routes: Vec::new(),
            routes_public: None,
            media_origins: Vec::new(),
            public_media_base: None,
            lan_media_base: None,
            home_address: home::HomeAddress::default(),
            public_media_socket: None,
            cast_origin: None,
            new_libraries: library::NewLibraries::Open,
            tmdb_key: None,
            tmdb_client: None,
            tmdb_cache_dir: None,
            tmdb_daily_max: None,
            tmdb_spent: Mutex::new((0, 0)),
            tmdb_refreshing: Mutex::new(std::collections::HashSet::new()),
            warnings_key: None,
            warnings_cache_dir: None,
            warnings_rest_until: Mutex::new(0),
            ratings_key: None,
            ratings_cache_dir: None,
            title_metadata_cache_dir: None,
            title_metadata_writes: tokio::sync::Mutex::new(()),
            skipdb_cache_dir: None,
            ratings_daily_max: None,
            ratings_spent: Mutex::new((0, 0)),
            ratings_refreshing: Mutex::new(std::collections::HashSet::new()),
            simkl_client_id: None,
            guest_media_slots: Arc::new(tokio::sync::Semaphore::new(relay::GUEST_MEDIA_STREAMS)),
            media_daily_max: None,
            media_spent: Arc::new(Mutex::new((0, 0))),
            media_leases: Mutex::new(HashMap::new()),
            grants: grants::Grants::default(),
            remux_edge_secret: None,
        }
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Bytes from the OS's random source. There is no recovering from a failed one, and handing out a guessable
/// key instead would be worse than stopping, so it panics.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random source failed");
    bytes
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A poisoned lock still holds consistent data here — every critical section is a map update — so take it.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[tokio::main]
async fn main() {
    let dir = env_opt("DATA_DIR").unwrap_or_else(|| "data".to_owned());
    let cap = env_opt("STORE_CAP_BYTES").and_then(|v| v.parse().ok()).unwrap_or(store::DEFAULT_CAP);
    let store = store::Store::open(std::path::Path::new(&dir), cap).unwrap_or_else(|e| {
        eprintln!("data dir {dir} is unusable: {e}");
        std::process::exit(1);
    });
    let mut state = AppState::new(
        store,
        env_opt("METRICS_TOKEN"),
        std::env::var("LOG_REQUESTS").is_ok_and(|v| !v.is_empty() && v != "0"),
    );
    state.web_origins = env_opt("WEB_ORIGINS")
        .map(|v| v.split(',').map(|o| o.trim().to_owned()).filter(|o| !o.is_empty()).collect())
        .unwrap_or_default();
    state.web_dir = env_opt("WEB_DIR").map(std::path::PathBuf::from);
    state.trusted_proxies = env_opt("TRUSTED_PROXIES").map(|v| parse_proxies(&v)).unwrap_or_default();
    state.web_hosts = env_opt("WEB_HOSTS").map(|v| parse_hosts("WEB_HOSTS", &v)).unwrap_or_default();
    state.api_hosts = env_opt("API_HOSTS").map(|v| parse_hosts("API_HOSTS", &v)).unwrap_or_default();
    state.relays = env_opt("ADDON_RELAY").map(|v| parse_relays(&v)).unwrap_or_default();
    state.routes = env_opt("ROUTES").map(|v| routes::parse(&v)).unwrap_or_default();
    state.routes_public = env_opt("ROUTES_PUBLIC").map(|v| routes::parse(&v));
    state.media_origins = routes::media_origins(&state.routes);
    state.public_media_base = env_opt("PUBLIC_MEDIA_BASE").and_then(|value| {
        origin(&value).filter(|value| value.starts_with("https://")).or_else(|| {
            eprintln!("PUBLIC_MEDIA_BASE must be a bare https origin — disabling it");
            None
        })
    });
    state.lan_media_base = env_opt("LAN_MEDIA_BASE").and_then(|value| {
        origin(&value).filter(|value| value.starts_with("https://")).or_else(|| {
            eprintln!("LAN_MEDIA_BASE must be a bare https origin — disabling it");
            None
        })
    });
    state.public_media_socket = env_opt("PUBLIC_MEDIA_SOCKET").map(std::path::PathBuf::from);
    state.cast_origin = env_opt("CAST_ORIGIN").and_then(|value| {
        origin(&value).filter(|value| value.starts_with("https://")).or_else(|| {
            eprintln!("CAST_ORIGIN must be a bare https origin — disabling it");
            None
        })
    });
    state.new_libraries = env_opt("NEW_LIBRARIES").map_or(library::NewLibraries::Open, |v| {
        library::NewLibraries::parse(&v).unwrap_or_else(|| {
            eprintln!("NEW_LIBRARIES is {v:?}: expected open or members");
            std::process::exit(1);
        })
    });
    // Lent to a device with no key of its own. The cache directory exists only when there is a key to lend, so
    // a deployment without one carries no directory it will never write to.
    state.simkl_client_id = env_opt("SIMKL_CLIENT_ID");
    state.tmdb_key = env_opt("TMDB_KEY");
    state.tmdb_daily_max = env_opt("TMDB_DAILY_MAX").and_then(|v| v.parse().ok());
    state.media_daily_max = env_opt("MEDIA_DAILY_MAX_BYTES").and_then(|v| v.parse().ok());
    state.remux_edge_secret = env_opt("REMUX_EDGE_SECRET");
    // The box's https client, no longer TMDB's alone: `/warnings/` forwards the content warnings with it, for
    // a browser that cannot ask doesthedogdie itself. Built whether or not a key is lent — gated on the TMDB
    // key, a household that never lent one would find the warnings turned off with it, for no reason it could
    // see.
    state.tmdb_client = Some(tmdb::client());
    if state.tmdb_key.is_some() {
        state.tmdb_cache_dir = Some(std::path::Path::new(&dir).join("tmdb"));
    }
    // Always kept, household key or not: a title looked up with a caller's own key is kept for everyone too.
    state.warnings_key = env_opt("DOESTHEDOGDIE_KEY");
    state.warnings_cache_dir = Some(std::path::Path::new(&dir).join("warnings"));
    state.ratings_key = env_opt("OMDB_KEY");
    state.ratings_daily_max = env_opt("OMDB_DAILY_MAX").and_then(|v| v.parse().ok());
    state.ratings_cache_dir = Some(std::path::Path::new(&dir).join("ratings"));
    state.title_metadata_cache_dir = Some(std::path::Path::new(&dir).join("title-metadata"));
    // No key to gate this one on: SkipDB's read API is open, so the only question is where to keep the answers.
    state.skipdb_cache_dir = Some(std::path::Path::new(&dir).join("skipdb"));
    let state = Arc::new(state);
    inbox::sweep(&state).await;
    tokio::spawn(inbox::sweep_forever(Arc::clone(&state)));
    tokio::spawn(tmdb::sweep_forever(Arc::clone(&state)));
    tokio::spawn(warnings::sweep_forever(Arc::clone(&state)));
    tokio::spawn(ratings::sweep_forever(Arc::clone(&state)));
    tokio::spawn(title_metadata::sweep_forever(Arc::clone(&state)));
    tokio::spawn(skipdb::sweep_forever(Arc::clone(&state)));
    tokio::spawn(grants::sweep_forever(Arc::clone(&state)));
    let app = axum::Router::new().fallback(handler::handle).with_state(Arc::clone(&state));

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap_or_else(|e| {
        eprintln!("bind :{port} failed: {e}");
        std::process::exit(1);
    });
    let shutdown = shutdown_signal();
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    let on = |b: bool| if b { "on" } else { "off" };
    eprintln!(
        "den-edge {} listening on :{port} — data={dir} web={} metrics={} log_requests={} web_origins={} \
         web_hosts={} api_hosts={} relays={} routes={} routes_public={} new_libraries={} tmdb={} warnings={} ratings={} guest_remux={}",
        env!("CARGO_PKG_VERSION"),
        state.web_dir.as_deref().map_or("none".to_owned(), |d| d.display().to_string()),
        on(state.metrics_token.is_some()),
        on(state.log_requests),
        if state.web_origins.is_empty() { "none".to_owned() } else { state.web_origins.join(",") },
        if state.web_hosts.is_empty() { "none".to_owned() } else { state.web_hosts.join(",") },
        if state.api_hosts.is_empty() { "none".to_owned() } else { state.api_hosts.join(",") },
        state.relays.iter().map(|(prefix, _)| prefix.as_str()).collect::<Vec<_>>().join(","),
        state.routes.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(","),
        state.routes_public.as_ref().map_or_else(
            || "full".to_owned(),
            |t| t.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(","),
        ),
        state.new_libraries.as_str(),
        match (&state.tmdb_key, state.tmdb_daily_max) {
            (None, _) => "off".to_owned(),
            (Some(_), None) => "on".to_owned(),
            (Some(_), Some(max)) => format!("on(max {max}/day)"),
        },
        if state.warnings_key.is_some() { "household-key" } else { "own-keys" },
        match (&state.ratings_key, state.ratings_daily_max) {
            (None, _) => "own-keys".to_owned(),
            (Some(_), None) => "household-key".to_owned(),
            (Some(_), Some(max)) => format!("household-key(max {max}/day)"),
        },
        on(state.remux_edge_secret.is_some()),
    );
    let outcome = serve_until(listener, app, shutdown, DRAIN_GRACE).await;
    eprintln!("{}", outcome.describe());
    let code = outcome.exit_code();
    if code != 0 {
        std::process::exit(code);
    }
}

/// `TRUSTED_PROXIES`: comma-separated IP addresses. A malformed entry is said and skipped — trusting it would mean
/// guessing what was meant.
fn parse_proxies(value: &str) -> Vec<std::net::IpAddr> {
    value
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter_map(|p| {
            let parsed = p.parse().ok();
            if parsed.is_none() {
                eprintln!("TRUSTED_PROXIES: {p:?} is not an IP address — skipping it");
            }
            parsed
        })
        .collect()
}

/// `WEB_HOSTS` / `API_HOSTS`: comma-separated host names, lower-cased, compared whole against a request's
/// `Host`. An entry with a port, path or credentials is said and skipped: a name that matched differently from
/// how it reads would make the split between the two halves a guess.
fn parse_hosts(var: &str, value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .filter(|h| {
            let ok = !h.contains(['/', ':', '@', '?', '#', ' ']);
            if !ok {
                eprintln!("{var}: {h:?} is not a bare host name — skipping it");
            }
            ok
        })
        .collect()
}

/// `ADDON_RELAY`: comma-separated `/<prefix>=<origin>` pairs — one path segment, a plain http(s) origin. A malformed
/// pair is said and skipped.
fn parse_relays(value: &str) -> Vec<(String, String)> {
    value
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let parsed = pair.split_once('=').and_then(|(prefix, lan)| {
                let prefix = prefix.trim();
                let segment = prefix.strip_prefix('/')?;
                let ok =
                    !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
                ok.then(|| Some((prefix.to_owned(), origin(lan)?))).flatten()
            });
            if parsed.is_none() {
                eprintln!("ADDON_RELAY: {pair:?} is not /<prefix>=<origin> — skipping it");
            }
            parsed
        })
        .collect()
}

/// `http(s)://host[:port]`, lower-cased, without a trailing slash — or `None` for anything with a path, query,
/// credentials or a space, which would read differently from how it matches.
fn origin(o: &str) -> Option<String> {
    let o = o.trim().trim_end_matches('/').to_ascii_lowercase();
    let ok = o.split_once("://").is_some_and(|(scheme, host)| {
        matches!(scheme, "http" | "https")
            && !host.is_empty()
            && !host.contains(['/', '?', '#', '@', ' ', ';', ','])
    });
    ok.then_some(o)
}

/// An env var's value, with unset and empty both meaning "not configured" — the rule every den addon uses.
fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// How serving ended. A drain that ran out of time is designed and exits 0; only a serve error fails.
#[derive(Debug)]
enum Outcome {
    Drained,
    DeadlineHit(String),
    Failed(String),
}

impl Outcome {
    fn exit_code(&self) -> i32 {
        match self {
            Outcome::Drained | Outcome::DeadlineHit(_) => 0,
            Outcome::Failed(_) => 1,
        }
    }

    fn describe(&self) -> String {
        match self {
            Outcome::Drained => "shut down cleanly".to_owned(),
            Outcome::DeadlineHit(why) | Outcome::Failed(why) => why.clone(),
        }
    }
}

/// Serve until `shutdown` resolves, then drain for at most `grace` — den-atlas's bounded drain: hyper waits
/// on a connection that is mid-request, so without the bound a client holding half a request head decides
/// how long a restart takes.
async fn serve_until(
    listener: tokio::net::TcpListener,
    app: axum::Router,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    grace: Duration,
) -> Outcome {
    let (signalled_tx, signalled_rx) = tokio::sync::oneshot::channel::<()>();
    let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            shutdown.await;
            let _ = signalled_tx.send(());
        });
    tokio::select! {
        r = serve => match r {
            Ok(()) => Outcome::Drained,
            Err(e) => Outcome::Failed(format!("serve error: {e}")),
        },
        _ = async {
            let _ = signalled_rx.await;
            tokio::time::sleep(grace).await;
        } => Outcome::DeadlineHit(format!("drain deadline ({grace:?}) reached with requests still in flight")),
    }
}

/// Under podman's default 10s stop timeout, so the drain finishes before anything kills it.
const DRAIN_GRACE: Duration = Duration::from_secs(8);
const _: () = assert!(DRAIN_GRACE.as_secs() < 10);

/// Resolves on SIGTERM or SIGINT. PID 1 in a `scratch` image gets no default terminate action, so without
/// a handler every restart waits out the stop timeout. A second signal exits at once.
fn shutdown_signal() -> impl std::future::Future<Output = ()> {
    use tokio::signal::unix::{signal, SignalKind};
    // Registered now, not when first polled, so a stop that arrives before the server polls it still drains.
    let term = signal(SignalKind::terminate());
    let int = signal(SignalKind::interrupt());
    async move {
        tokio::select! {
            _ = wait_for(term, "SIGTERM") => {}
            _ = wait_for(int, "SIGINT") => {}
        }
        tokio::spawn(async move {
            tokio::select! {
                _ = wait_for(signal(SignalKind::terminate()), "") => {}
                _ = wait_for(signal(SignalKind::interrupt()), "") => {}
            }
            eprintln!("second signal — exiting without finishing the drain");
            std::process::exit(0);
        });
    }
}

/// Resolve when this signal arrives, or never if it could not be registered — returning at once would shut
/// the server down at boot. An empty `name` says nothing when it fires.
async fn wait_for(registered: std::io::Result<tokio::signal::unix::Signal>, name: &str) {
    match registered {
        Ok(mut sig) => {
            sig.recv().await;
            if !name.is_empty() {
                eprintln!("{name} — draining in-flight requests");
            }
        }
        Err(e) => {
            eprintln!("signal handler unavailable ({e}); a stop will be a hard kill");
            std::future::pending::<()>().await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// A client that sends half a request head must not hold shutdown open past the grace.
    #[tokio::test]
    async fn a_client_holding_a_partial_request_cannot_hold_shutdown_open() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let state = Arc::new(AppState::new(
            store::Store::open(&handler::tests::temp_dir(), store::DEFAULT_CAP).unwrap(),
            None,
            false,
        ));
        let app = axum::Router::new().fallback(handler::handle).with_state(state);
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let grace = Duration::from_millis(300);
        let server =
            tokio::spawn(async move { serve_until(l, app, async { rx.await.unwrap_or(()) }, grace).await });

        let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
        sock.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n").await.unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let started = std::time::Instant::now();
        let _ = tx.send(());
        let outcome =
            tokio::time::timeout(Duration::from_secs(5), server).await.expect("unbounded drain").unwrap();
        assert!(matches!(&outcome, Outcome::DeadlineHit(w) if w.contains("drain deadline")), "{outcome:?}");
        assert!(started.elapsed() < grace * 4);
        assert_eq!(outcome.exit_code(), 0, "a routine drain timeout must not look like a crash");
        drop(sock);
    }

    #[test]
    fn only_a_serve_error_exits_non_zero() {
        assert_eq!(Outcome::Drained.exit_code(), 0);
        assert_eq!(Outcome::Failed("bind failed".into()).exit_code(), 1);
    }

    #[tokio::test]
    async fn an_unregisterable_signal_never_fires() {
        let fired = tokio::time::timeout(
            Duration::from_millis(200),
            wait_for(Err(std::io::Error::other("no handler")), "SIGTERM"),
        )
        .await;
        assert!(
            fired.is_err(),
            "an unregisterable signal resolved, which would shut the server down at boot"
        );
    }
}
