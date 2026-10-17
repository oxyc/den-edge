//! den-edge — Den's sync relay, on the homelab. It relays pairings between a TV and another device, carries a
//! paired device's sealed messages to the TV (the inbox), and keeps the library's record log. It also serves the
//! Den web app. It never interprets what it stores: the log and the inbox are ciphertext the devices seal.
//!
//! State lives in files under `DATA_DIR`; pairing sessions live in memory only.

mod assistant;
mod billboard;
mod cache;
mod diagnostics;
mod grants;
mod handler;
mod hold;
mod home;
mod inbox;
mod library;
mod link;
mod meta;
mod metrics;
mod mmap;
mod oauth;
mod pair;
mod ratings;
mod recovery;
mod relay;
mod routes;
mod skipdb;
mod startup;
mod store;
mod sync;
mod title_metadata;
mod tmdb;
mod warnings;
mod web;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct AppState {
    pub store: store::Store,
    /// Held across every read-modify-write on the store, so an inbox append, a drain and a versioned write
    /// each happen as one step. Workers KV could not do this, which is how its inbox lost messages when two
    /// arrived at once. One household never contends on it.
    pub write_lock: tokio::sync::Mutex<()>,
    /// A short-held registry of independently locked record logs. One household's batch remains atomic without
    /// making its disk I/O or snapshot selection block another household.
    pub libraries: library::Libraries,
    /// `/changes?wait=` requests waiting for a write to their library.
    pub library_holds: hold::Holds,
    /// `POST /inbox/drain?wait=` requests waiting for a message in one of their queues.
    pub inbox_holds: hold::Holds,
    /// `POST /assistant/drain?wait=` requests waiting for a request in their library's queue.
    pub assistant_holds: hold::Holds,
    /// Held across every read-modify-write of an assistant queue or drop-box key (`assistant.rs`).
    pub assistant_lock: tokio::sync::Mutex<()>,
    /// When each library's TV queue was last drained (assistant v1 §16), ms: whether its TV is awake. Kept in memory
    /// alone: a TV draining refreshes it within seconds of a restart.
    pub assistant_tv_seen: std::sync::Mutex<std::collections::HashMap<String, u64>>,
    /// Transactional current-row authority. Databases are opened lazily; constructing the manager replays and
    /// migrates none, so startup work is independent of library history length.
    pub(crate) library_v3: Arc<library::v3::StoreManager>,
    /// CPU-heavy library gzip jobs. A busy pool falls back to identity so compression cannot occupy every Tokio
    /// worker or queue without bound; Cloudflare can compress public delivery at its edge.
    pub library_compression_slots: Arc<tokio::sync::Semaphore>,
    /// Bytes retained by live library response bodies. A permit follows the body through a slow client or
    /// cancellation, so many unique sync pages cannot silently exceed the aggregate library-memory budget.
    pub library_response_bytes: Arc<tokio::sync::Semaphore>,
    /// Memory budgets include keys and conservative allocation overhead, not only ciphertext.
    pub library_limits: library::Limits,
    /// Every per-address budget's count (`link::throttled_at`, `link::throttled_per_minute`): a pairing's guesses,
    /// the relay's and the proxies' questions.
    pub claims: Mutex<link::Throttles>,
    /// Recovery's per-visitor budgets (`recovery::Limiter`), apart from `claims`: their windows last up to a day, and
    /// must never crowd out the minute-long budgets every other route counts in.
    pub recovery_claims: Mutex<recovery::Limiter>,
    /// Pairing sessions by `sid`. Ten minutes long at most, so memory is enough: a restart costs a pairing in
    /// progress, which the TV simply starts again.
    pub pairs: Mutex<HashMap<String, pair::Session>>,
    /// Unix milliseconds. A field so a test can move time.
    pub clock: Box<dyn Fn() -> u64 + Send + Sync>,
    pub gen_nameplate: Box<dyn Fn() -> String + Send + Sync>,
    pub metrics: Arc<metrics::Metrics>,
    /// Reusable exact-file mappings. The cache and every response owner share one count/byte budget.
    pub(crate) mmaps: mmap::Cache,
    /// Requests whose handlers or response bodies are live. The permit follows the response body, so a slow
    /// receiver remains admitted until it finishes or disconnects rather than becoming unaccounted work.
    pub request_slots: Arc<tokio::sync::Semaphore>,
    /// The bulk share of `request_slots`. Small control/state routes do not take this permit, leaving
    /// `handler::CONTROL_REQUESTS` positions they can still use while files, relays, and large reads are busy.
    pub bulk_request_slots: Arc<tokio::sync::Semaphore>,
    /// Bearer token for `/metrics` (env `METRICS_TOKEN`). `None` turns the route off.
    pub metrics_token: Option<String>,
    /// One stderr line per request (env `LOG_REQUESTS`), naming the route and never a key.
    pub log_requests: bool,
    /// Whether a playback report (`diagnostics.rs`, `startup.rs`) may log what was played — the TMDB id, the
    /// release name and size, the chosen audio and subtitle tracks (env `LOG_IDENTITY`; default on, `0` or
    /// `false` turns it off). The box's journal is RAM-only and readable only by its owner, who chose to keep
    /// this on by default so a playback problem stays reproducible; every other field (event, outcome, reason,
    /// duration, rid) is logged either way.
    pub log_identity: bool,
    /// Origins a browser may call from (env `WEB_ORIGINS`, comma-separated): the Den web app when it is served
    /// from elsewhere. Empty sends no CORS headers at all — the app served here is same-origin and needs none.
    pub web_origins: Vec<String>,
    /// The Den web app's built files (env `WEB_DIR`), served at `/`. `None` serves no app.
    pub web_dir: Option<std::path::PathBuf>,
    /// The web app's ETags and its shell, kept so a request neither hashes nor reads a whole file (`web.rs`).
    pub web_files: web::Files,
    /// Proxies whose report of the visitor's address counts (env `TRUSTED_PROXIES`, comma-separated IPs):
    /// `cloudflared` and `tailscale serve` connect from their own address (`handler::client_ip`).
    pub trusted_proxies: Vec<std::net::IpAddr>,
    /// The ones among them whose `CF-Connecting-IP` counts: entries written `cf:<ip>`, for `cloudflared`.
    pub cloudflare_proxies: Vec<std::net::IpAddr>,
    /// The web app's public names (env `WEB_HOSTS`, comma-separated). They sit behind Cloudflare Access, and a
    /// request for one gets the web app and none of the device API (`handler::Face`, oxyc/den#15).
    pub web_hosts: Vec<String>,
    /// The device API's public names (env `API_HOSTS`). They bypass Access, so a request for one gets the
    /// device routes and never the web app — which would otherwise be handed out past Access.
    pub api_hosts: Vec<String>,
    /// Web host names allowed to discover real profiles (env `PROFILES_HOSTS`). Empty keeps real mode off.
    pub profiles_hosts: Vec<String>,
    /// Web host names allowed to use only the synthetic, non-migrating profiles preview
    /// (env `PROFILES_PREVIEW_HOSTS`). Preview wins if a host is accidentally present in both lists.
    pub profiles_preview_hosts: Vec<String>,
    /// Enables only the authenticated profiles-v1 migration transaction routes. It is deliberately independent
    /// from profile discovery and defaults off (env `PROFILE_MIGRATION_ENABLED`).
    pub profile_migration_enabled: bool,
    /// Enables the authenticated compound profile key-reset routes and their write lock. During the rollout an
    /// unset `PROFILE_RESET_ENABLED` inherits `PROFILE_MIGRATION_ENABLED`, so an older deployment configuration
    /// cannot silently disable reset before it starts rendering the independent switch.
    pub profile_reset_enabled: bool,
    /// Batches one library may send in a burst, and how many a minute it earns back (env `LIBRARY_WRITE_BURST`,
    /// `LIBRARY_WRITE_PER_MINUTE`). A per-minute of 0 turns the budget off.
    pub library_write_burst: u32,
    pub library_write_per_minute: u32,
    /// Under `NEW_LIBRARIES=visitors`: visitor libraries one address may start a day, and all addresses together
    /// (env `VISITOR_LIBRARIES_PER_ADDRESS_DAILY_MAX`, `VISITOR_LIBRARIES_DAILY_MAX`; 0 closes starting them).
    pub visitor_libraries_per_address_daily: u32,
    pub visitor_libraries_daily_max: u32,
    /// What one visitor library may hold: live bytes and rows (env `VISITOR_LIBRARY_MAX_BYTES`,
    /// `VISITOR_LIBRARY_MAX_ROWS`). Never above what any library may hold.
    pub visitor_library_max_bytes: usize,
    pub visitor_library_max_rows: usize,
    pub visitor_day: Mutex<library::VisitorDay>,
    /// What `/config` tells the Apple TV about profiles (env `PROFILES_TV`): `Some(true)` enables them,
    /// `Some(false)` is the operator's explicit rollback, and `None` omits the key so the TV stays "unavailable".
    pub profiles_tv: Option<bool>,
    /// Exact household library ids enrolled for profiles-v1 preparation (env `PROFILE_PREPARE_HOUSEHOLDS`).
    /// This is transport authority, not runtime truth: committed runtime is derived by a client only after it
    /// decrypts and validates the stored directory. An empty set keeps every legacy household off.
    pub profile_prepare_households: HashSet<String>,
    /// Households whose aborted key reset still has declared successor libraries to delete
    /// (`library::reset_lock`): filled from the sweep hints at startup and when a reset ends, drained by the sweep.
    pub reset_sweeps: Mutex<HashSet<String>>,
    /// Path prefix → addon LAN origin (env `ADDON_RELAY`: `/scout=http://192.168.86.193:8080,…`): what the web app
    /// asks on its own origin and den-edge fetches from the addon (`relay.rs`).
    pub relays: Vec<(String, String)>,
    pub relay_client: relay::RelayClient,
    /// Relayed fetches allowed in flight at once (`relay::MAX_IN_FLIGHT`), so the addons behind this origin can't
    /// be swamped through it.
    pub relay_slots: Arc<tokio::sync::Semaphore>,
    /// Relayed request bodies being received (`relay::MAX_BODY_IN_FLIGHT`). Kept apart from `relay_slots`, so slow
    /// uploads cannot occupy every upstream slot, while their bounded bodies cannot accumulate without a cap.
    pub relay_body_slots: Arc<tokio::sync::Semaphore>,
    /// atlas `/recommend` bodies being received, which may be larger (`relay::RECOMMEND_BODIES_IN_FLIGHT`).
    pub recommend_body_slots: Arc<tokio::sync::Semaphore>,
    /// Of those, the ones atlas's tuning playground may hold at once (`relay::PLAYGROUND_IN_FLIGHT`).
    pub playground_slots: Arc<tokio::sync::Semaphore>,
    /// Bytes of relayed answers collected whole that may be held at once (`relay::COLLECT_BUDGET_BYTES`).
    pub relay_collect_budget: Arc<tokio::sync::Semaphore>,
    /// Every address for each service, in order (env `ROUTES`, den-spec routes-v1): served as `GET /routes`.
    pub routes: routes::Routes,
    /// The table served on the web app's public name instead of `routes` (env `ROUTES_PUBLIC`). The full table
    /// names the LAN addresses and the tailnet, which a public visitor has no use for and shouldn't be handed;
    /// `None` serves the full table everywhere, as before.
    pub routes_public: Option<routes::Routes>,
    /// The immutable `/config` and face-specific `/routes` bodies and validators. Built after environment
    /// configuration is complete, so their 304 path neither serializes nor hashes on each client startup.
    pub(crate) prepared_public_json: Option<handler::PreparedPublicJson>,
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
    /// The batch store is opened and imports the legacy JSON files on first use. A failed/corrupt open is retried;
    /// it never causes the durable cache to be deleted.
    pub title_metadata_store: tokio::sync::OnceCell<Arc<title_metadata::Store>>,
    /// Serializes publish batches so simultaneous partial observations cannot erase fields.
    pub title_metadata_writes: tokio::sync::Mutex<()>,
    /// Retained bytes and parsing headroom for TMDB title-metadata observations. This is weighted by body size,
    /// so large background answers cannot multiply memory merely because task slots remain.
    pub title_metadata_observation_budget: Arc<tokio::sync::Semaphore>,
    /// Questions the household key may ask OMDb in a UTC day (env `OMDB_DAILY_MAX`); `None` is no ceiling of ours.
    pub ratings_daily_max: Option<u32>,
    /// Today (as a day number) and what the household key has spent of it.
    pub ratings_spent: Mutex<(u64, u32)>,
    /// Titles whose stale ratings are being fetched again right now (`ratings::refresh_behind`).
    pub ratings_refreshing: Mutex<std::collections::HashSet<String>>,
    /// Where each release's skip segments are kept (`<DATA_DIR>/skipdb`), for every browser that plays it
    /// (`skipdb.rs`). SkipDB's read API needs no key, so there is nothing to spend and no household key here.
    pub skipdb_cache_dir: Option<std::path::PathBuf>,
    /// Today (a UTC day number) and how many SkipDB answers have been kept under a new name in it (`skipdb::new_name`).
    pub skipdb_kept_new: Mutex<(u64, u32)>,
    /// den-remux's key for asking it to detect an episode's segments (env `SEGMENTS_KEY`, sent as
    /// `X-Den-Segments-Key`). Unset, `/skipdb` reads what remux has detected but never asks for a scan.
    pub segments_key: Option<String>,
    /// Episodes a scan was asked for lately, and when (ms), so one is asked for once per `skipdb::SCAN_EVERY`.
    pub segments_scans: Mutex<HashMap<String, u64>>,
    /// SIMKL's public client id (env `SIMKL_CLIENT_ID`), served as part of `/config`. Not a secret: SIMKL's
    /// PIN flow runs in the browser and needs only this. `None` leaves it out, and the app hides its sign-in.
    pub simkl_client_id: Option<String>,
    /// Every trailer response currently proxied, member or guest (`relay::MEDIA_STREAMS`). The permit follows the
    /// response body, bounding upstream sockets and Hyper buffers even for authenticated household clients.
    pub media_slots: Arc<tokio::sync::Semaphore>,
    /// The member share of `media_slots` (`relay::MEMBER_MEDIA_STREAMS`). Guests do not take these permits, so a
    /// burst of household clients cannot consume the capacity reserved for guest sessions already admitted.
    pub member_media_slots: Arc<tokio::sync::Semaphore>,
    /// Guest trailer streams that may be in flight at once (`relay::GUEST_MEDIA_STREAMS`).
    ///
    /// The per-address budgets bound requests per minute, which is not the thing the household feels: what
    /// hurts is several 1080p viewers running at the same moment, saturating the upload the TVs also live on.
    /// A permit follows the guest's idle lease, while `media_slots` separately bounds each active response body.
    /// Members never take a guest permit.
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
    /// lease holds one of `guest_media_slots`, which comes back once neither a request nor a frame of a body it
    /// admitted has passed for the idle time.
    pub media_leases: Mutex<HashMap<String, relay::Lease>>,
    /// Guest grants' in-memory state (`grants.rs`): last use, media source addresses, sessions already ended.
    pub grants: grants::Grants,
    /// Held across every read-modify-write of recovery entries (`recovery.rs`).
    pub recovery_lock: tokio::sync::Mutex<()>,
    /// Distinct `ipv4Hint` addresses each member rate-limit bucket (an IPv6 /64) had a media listener opened for,
    /// and when (`relay::MEMBER_HINTS`). A guest's are counted with its grant's sources instead.
    pub member_hints: Mutex<HashMap<String, Vec<(std::net::IpAddr, u64)>>>,
    /// Public Reel activation hints, separately and globally bounded because unlike remux member hints these
    /// may be created by unauthenticated IPv6 /64s holding signed media capabilities.
    pub reel_hints: Mutex<HashMap<String, Vec<(std::net::IpAddr, u64)>>>,
    /// Shared with den-remux (env `REMUX_EDGE_SECRET` here, `EDGE_SECRET` there): what lets den-edge name a grant
    /// as a session's owner and end its sessions. Unset, a guest is offered no remux at all — without it remux
    /// would count the guest's sessions as the host's.
    pub remux_edge_secret: Option<String>,
    /// The unified Den playback surface and guest-owned Den installs (env `DEN_PLAYBACK_ENABLED`). The feature is
    /// built dormant: an operator must explicitly enable Edge as well as Hearth before any new route is exposed.
    pub den_playback_enabled: bool,
    /// The authorization server for Den's MCP connector (`oauth.rs`; env `OAUTH_ISSUER`, `OAUTH_SIGNING_KEY`).
    /// `None` turns `/oauth/…` and `/mcp` off.
    pub oauth: Option<oauth::OAuth>,
}

/// The release carried by the runtime image. Keeping it out of Cargo.toml means a web-only release does not
/// invalidate the expensive Rust build layer merely to change its tag. Developer builds and tests have no image
/// metadata, so they retain the package version as a useful fallback.
pub(crate) fn release_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION
        .get_or_init(|| {
            std::env::var("DEN_VERSION")
                .ok()
                .filter(|version| !version.is_empty())
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned())
        })
        .as_str()
}

impl AppState {
    pub fn new(store: store::Store, metrics_token: Option<String>, log_requests: bool) -> Self {
        let metrics = Arc::new(metrics::Metrics::default());
        let library_limits = library::Limits::default();
        let library_v3 = Arc::new(
            library::v3::StoreManager::open_shared(
                &store.namespace_dir("lib"),
                16 * library::v3::OPEN_DATABASE_BYTES,
                store.quota(),
                64 * 1024 * 1024,
            )
            .expect("the library-v3 manager must share the already-open durable store"),
        );
        AppState {
            store,
            write_lock: tokio::sync::Mutex::new(()),
            libraries: library::Libraries::default(),
            library_holds: hold::Holds::new(library::MAX_HELD, library::MAX_HELD_PER_LIBRARY),
            inbox_holds: hold::Holds::new(inbox::MAX_HELD, inbox::MAX_HELD_PER_ADDRESS),
            assistant_holds: hold::Holds::new(assistant::MAX_HELD, assistant::MAX_HELD_PER_ADDRESS),
            assistant_lock: tokio::sync::Mutex::new(()),
            assistant_tv_seen: std::sync::Mutex::default(),
            library_v3,
            library_compression_slots: Arc::new(tokio::sync::Semaphore::new(library::COMPRESSION_JOBS)),
            library_response_bytes: Arc::new(tokio::sync::Semaphore::new(library_limits.cache_bytes)),
            library_limits,
            claims: Mutex::new(link::Throttles::default()),
            recovery_claims: Mutex::new(recovery::Limiter::default()),
            pairs: Mutex::new(HashMap::new()),
            clock: Box::new(now_ms),
            gen_nameplate: Box::new(pair::gen_nameplate),
            metrics: Arc::clone(&metrics),
            mmaps: mmap::Cache::new(metrics),
            request_slots: Arc::new(tokio::sync::Semaphore::new(handler::REQUESTS)),
            bulk_request_slots: Arc::new(tokio::sync::Semaphore::new(handler::BULK_REQUESTS)),
            metrics_token,
            log_requests,
            log_identity: true,
            web_origins: Vec::new(),
            web_dir: None,
            web_files: web::Files::default(),
            trusted_proxies: Vec::new(),
            cloudflare_proxies: Vec::new(),
            web_hosts: Vec::new(),
            api_hosts: Vec::new(),
            profiles_hosts: Vec::new(),
            profiles_preview_hosts: Vec::new(),
            profile_migration_enabled: false,
            profile_reset_enabled: false,
            library_write_burst: library::WRITE_BURST,
            library_write_per_minute: library::WRITE_PER_MINUTE,
            visitor_libraries_per_address_daily: library::VISITOR_LIBRARIES_PER_ADDRESS_DAILY_MAX,
            visitor_libraries_daily_max: library::VISITOR_LIBRARIES_DAILY_MAX,
            visitor_library_max_bytes: library::VISITOR_LIBRARY_MAX_BYTES,
            visitor_library_max_rows: library::VISITOR_LIBRARY_MAX_ROWS,
            visitor_day: Mutex::new(library::VisitorDay::default()),
            profiles_tv: None,
            profile_prepare_households: HashSet::new(),
            reset_sweeps: Mutex::new(HashSet::new()),
            relays: Vec::new(),
            relay_client: relay::client(),
            relay_slots: Arc::new(tokio::sync::Semaphore::new(relay::MAX_IN_FLIGHT)),
            relay_body_slots: Arc::new(tokio::sync::Semaphore::new(relay::MAX_BODY_IN_FLIGHT)),
            recommend_body_slots: Arc::new(tokio::sync::Semaphore::new(relay::RECOMMEND_BODIES_IN_FLIGHT)),
            relay_collect_budget: Arc::new(tokio::sync::Semaphore::new(relay::COLLECT_BUDGET_BYTES)),
            playground_slots: Arc::new(tokio::sync::Semaphore::new(relay::PLAYGROUND_IN_FLIGHT)),
            routes: Vec::new(),
            routes_public: None,
            prepared_public_json: None,
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
            title_metadata_store: tokio::sync::OnceCell::new(),
            title_metadata_writes: tokio::sync::Mutex::new(()),
            title_metadata_observation_budget: Arc::new(tokio::sync::Semaphore::new(
                title_metadata::OBSERVATION_BUDGET_BYTES,
            )),
            skipdb_cache_dir: None,
            skipdb_kept_new: Mutex::new((0, 0)),
            segments_key: None,
            segments_scans: Mutex::new(HashMap::new()),
            ratings_daily_max: None,
            ratings_spent: Mutex::new((0, 0)),
            ratings_refreshing: Mutex::new(std::collections::HashSet::new()),
            simkl_client_id: None,
            media_slots: Arc::new(tokio::sync::Semaphore::new(relay::MEDIA_STREAMS)),
            member_media_slots: Arc::new(tokio::sync::Semaphore::new(relay::MEMBER_MEDIA_STREAMS)),
            guest_media_slots: Arc::new(tokio::sync::Semaphore::new(relay::GUEST_MEDIA_STREAMS)),
            media_daily_max: None,
            media_spent: Arc::new(Mutex::new((0, 0))),
            media_leases: Mutex::new(HashMap::new()),
            grants: grants::Grants::default(),
            recovery_lock: tokio::sync::Mutex::new(()),
            member_hints: Mutex::new(HashMap::new()),
            reel_hints: Mutex::new(HashMap::new()),
            remux_edge_secret: None,
            den_playback_enabled: false,
            oauth: None,
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
    let cap = env_number("STORE_CAP_BYTES").unwrap_or(store::DEFAULT_CAP);
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
    state.log_identity = env_flag("LOG_IDENTITY", true);
    state.web_dir = env_opt("WEB_DIR").map(std::path::PathBuf::from);
    if let Some(web) = state.web_dir.as_deref() {
        match state.web_files.prepare(web).await {
            Ok(count) => eprintln!("prepared {count} immutable web assets"),
            Err(e) => eprintln!("could not prepare immutable web assets: {e}; using per-request file checks"),
        }
    }
    (state.trusted_proxies, state.cloudflare_proxies) =
        env_opt("TRUSTED_PROXIES").map(|v| parse_proxies(&v)).unwrap_or_default();
    state.web_hosts = env_opt("WEB_HOSTS").map(|v| parse_hosts("WEB_HOSTS", &v)).unwrap_or_default();
    state.api_hosts = env_opt("API_HOSTS").map(|v| parse_hosts("API_HOSTS", &v)).unwrap_or_default();
    state.profiles_hosts =
        env_opt("PROFILES_HOSTS").map(|v| parse_hosts("PROFILES_HOSTS", &v)).unwrap_or_default();
    state.profiles_preview_hosts = env_opt("PROFILES_PREVIEW_HOSTS")
        .map(|v| parse_hosts("PROFILES_PREVIEW_HOSTS", &v))
        .unwrap_or_default();
    state.profile_migration_enabled = env_flag("PROFILE_MIGRATION_ENABLED", false);
    state.profile_reset_enabled = env_flag("PROFILE_RESET_ENABLED", state.profile_migration_enabled);
    state.library_write_burst = env_number("LIBRARY_WRITE_BURST").unwrap_or(library::WRITE_BURST);
    state.library_write_per_minute =
        env_number("LIBRARY_WRITE_PER_MINUTE").unwrap_or(library::WRITE_PER_MINUTE);
    state.visitor_libraries_per_address_daily = env_number("VISITOR_LIBRARIES_PER_ADDRESS_DAILY_MAX")
        .unwrap_or(library::VISITOR_LIBRARIES_PER_ADDRESS_DAILY_MAX);
    state.visitor_libraries_daily_max =
        env_number("VISITOR_LIBRARIES_DAILY_MAX").unwrap_or(library::VISITOR_LIBRARIES_DAILY_MAX);
    state.visitor_library_max_bytes =
        env_number("VISITOR_LIBRARY_MAX_BYTES").unwrap_or(library::VISITOR_LIBRARY_MAX_BYTES);
    state.visitor_library_max_rows =
        env_number("VISITOR_LIBRARY_MAX_ROWS").unwrap_or(library::VISITOR_LIBRARY_MAX_ROWS);
    state.profiles_tv = env_opt("PROFILES_TV").and_then(|value| {
        parse_tri_state("PROFILES_TV", &value).unwrap_or_else(|reason| {
            eprintln!("{reason}");
            std::process::exit(1);
        })
    });
    state.profile_prepare_households = env_opt("PROFILE_PREPARE_HOUSEHOLDS")
        .map(|value| {
            parse_library_ids("PROFILE_PREPARE_HOUSEHOLDS", &value).unwrap_or_else(|reason| {
                eprintln!("{reason}");
                std::process::exit(1);
            })
        })
        .unwrap_or_default();
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
        origin(&value).filter(|value| lan_media_origin(value)).or_else(|| {
            eprintln!("LAN_MEDIA_BASE must be a bare https origin or private-LAN http origin — disabling it");
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
            eprintln!("NEW_LIBRARIES is {v:?}: expected open, members or visitors");
            std::process::exit(1);
        })
    });
    // Lent to a device with no key of its own. The cache directory exists only when there is a key to lend, so
    // a deployment without one carries no directory it will never write to.
    state.simkl_client_id = env_opt("SIMKL_CLIENT_ID");
    state.tmdb_key = env_opt("TMDB_KEY");
    state.tmdb_daily_max = env_number("TMDB_DAILY_MAX");
    state.media_daily_max = env_number("MEDIA_DAILY_MAX_BYTES");
    state.remux_edge_secret = env_opt("REMUX_EDGE_SECRET");
    state.den_playback_enabled = env_flag("DEN_PLAYBACK_ENABLED", false);
    state.segments_key = env_opt("SEGMENTS_KEY");
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
    state.ratings_daily_max = env_number("OMDB_DAILY_MAX");
    state.ratings_cache_dir = Some(std::path::Path::new(&dir).join("ratings"));
    state.title_metadata_cache_dir = Some(std::path::Path::new(&dir).join("title-metadata"));
    // No key to gate this one on: SkipDB's read API is open, so the only question is where to keep the answers.
    state.skipdb_cache_dir = Some(std::path::Path::new(&dir).join("skipdb"));
    state.oauth = oauth_config();
    state.prepared_public_json = Some(handler::PreparedPublicJson::new(&state));
    let state = Arc::new(state);
    inbox::sweep(&state).await;
    tokio::spawn(inbox::sweep_forever(Arc::clone(&state)));
    tokio::spawn(tmdb::sweep_forever(Arc::clone(&state)));
    tokio::spawn(warnings::sweep_forever(Arc::clone(&state)));
    tokio::spawn(ratings::sweep_forever(Arc::clone(&state)));
    tokio::spawn(title_metadata::sweep_forever(Arc::clone(&state)));
    tokio::spawn(skipdb::sweep_forever(Arc::clone(&state)));
    tokio::spawn(grants::sweep_forever(Arc::clone(&state)));
    tokio::spawn(oauth::sweep_forever(Arc::clone(&state)));
    tokio::spawn(library::reset_lock::sweep_startup(Arc::clone(&state)));
    let app = axum::Router::new().fallback(handler::handle).with_state(Arc::clone(&state));

    let port: u16 = env_number("PORT").unwrap_or(8080);
    // `PORT` is always served: it is the address other containers reach this one on. A socket handed over by the
    // supervisor is served as well, and is the one that survives this process being replaced.
    let mut listeners = Vec::new();
    match inherited_listener() {
        Some(Ok(l)) => {
            eprintln!(
                "serving on an inherited socket, {}",
                l.local_addr().map_or("?".to_owned(), |a| a.to_string())
            );
            listeners.push(l);
        }
        Some(Err(e)) => {
            eprintln!("inherited listening socket unusable: {e}");
            std::process::exit(1);
        }
        None => {}
    }
    listeners.push(tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap_or_else(|e| {
        eprintln!("bind :{port} failed: {e}");
        std::process::exit(1);
    }));
    let shutdown = shutdown_signal();
    let port = listeners.last().and_then(|l| l.local_addr().ok()).map_or(port, |a| a.port());
    let on = |b: bool| if b { "on" } else { "off" };
    eprintln!(
        "den-edge {} listening on :{port} — data={dir} web={} metrics={} log_requests={} log_identity={} web_origins={} \
         web_hosts={} api_hosts={} relays={} routes={} routes_public={} new_libraries={} tmdb={} warnings={} ratings={} guest_remux={} \
         den_playback={} oauth={} assistant_writes={}",
        release_version(),
        state.web_dir.as_deref().map_or("none".to_owned(), |d| d.display().to_string()),
        on(state.metrics_token.is_some()),
        on(state.log_requests),
        on(state.log_identity),
        if state.web_origins.is_empty() { "none".to_owned() } else { state.web_origins.join(",") },
        if state.web_hosts.is_empty() { "none".to_owned() } else { state.web_hosts.join(",") },
        if state.api_hosts.is_empty() { "none".to_owned() } else { state.api_hosts.join(",") },
        state.relays.iter().map(|(prefix, _)| prefix.as_str()).collect::<Vec<_>>().join(","),
        state.routes.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(","),
        state.routes_public.as_ref().map_or_else(
            || "full".to_owned(),
            |t| t.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(","),
        ),
        if state.new_libraries == library::NewLibraries::Visitors {
            format!(
                "visitors(per-address {}/day, {}/day, library {}B/{}rows)",
                state.visitor_libraries_per_address_daily,
                state.visitor_libraries_daily_max,
                state.visitor_library_max_bytes,
                state.visitor_library_max_rows,
            )
        } else {
            state.new_libraries.as_str().to_owned()
        },
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
        on(state.den_playback_enabled),
        // The public key is what den-mcp's TOKEN_PUBLIC_KEYS must hold; it is not a secret.
        state.oauth.as_ref().map_or_else(
            || "off".to_owned(),
            |o| format!("on(issuer {} key {})", o.issuer, oauth::b64url(o.verifying_key().as_bytes())),
        ),
        on(state.oauth.as_ref().is_some_and(|o| o.write_public.is_some())),
    );
    let limits = Limits { grace: DRAIN_GRACE, header_read: HEADER_READ_TIMEOUT };
    let outcome = serve_until(listeners, app, Arc::clone(&state.metrics), shutdown, limits).await;
    eprintln!("{}", outcome.describe());
}

/// The listening socket the supervisor handed over (systemd socket activation: `LISTEN_PID` is this process,
/// `LISTEN_FDS` counts sockets starting at fd 3). The supervisor keeps the socket open across restarts, so
/// connections queue in the kernel while a new process starts instead of being refused. `None` when nothing was
/// handed over; the caller then binds `PORT` itself.
#[cfg(unix)]
fn inherited_listener() -> Option<std::io::Result<tokio::net::TcpListener>> {
    const FIRST_FD: i32 = 3;
    let pid = std::env::var("LISTEN_PID").ok()?.parse::<u32>().ok()?;
    let count = std::env::var("LISTEN_FDS").ok()?.parse::<i32>().ok()?;
    if pid != std::process::id() {
        eprintln!("LISTEN_FDS is set for process {pid}, not this one ({}); ignoring it", std::process::id());
        return None;
    }
    if count < 1 {
        return None;
    }
    if count > 1 {
        return Some(Err(std::io::Error::other(format!("expected one socket, got {count}"))));
    }
    // SAFETY: the activation protocol hands this process sole ownership of fd 3.
    Some(unsafe { adopt_listener(FIRST_FD) })
}

/// # Safety
/// `fd` must be an open listening TCP socket that nothing else owns.
#[cfg(unix)]
unsafe fn adopt_listener(fd: i32) -> std::io::Result<tokio::net::TcpListener> {
    use std::os::fd::FromRawFd;
    let std_listener = unsafe { std::net::TcpListener::from_raw_fd(fd) };
    std_listener.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(std_listener)
}

#[cfg(not(unix))]
fn inherited_listener() -> Option<std::io::Result<tokio::net::TcpListener>> {
    None
}

/// `TRUSTED_PROXIES`: comma-separated IP addresses, the trusted ones and, second, those written `cf:<ip>` — the
/// proxies that set `CF-Connecting-IP` rather than pass on what the visitor wrote in it. A malformed entry is said
/// and skipped — trusting it would mean guessing what was meant.
fn parse_proxies(value: &str) -> (Vec<std::net::IpAddr>, Vec<std::net::IpAddr>) {
    let (mut trusted, mut cloudflare) = (Vec::new(), Vec::new());
    for p in value.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (cf, address) = p.strip_prefix("cf:").map_or((false, p), |a| (true, a.trim()));
        let Ok(ip) = address.parse() else {
            eprintln!("TRUSTED_PROXIES: {p:?} is not an IP address — skipping it");
            continue;
        };
        trusted.push(ip);
        if cf {
            cloudflare.push(ip);
        }
    }
    (trusted, cloudflare)
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

/// A protected exact-household enrollment list. Unlike host discovery, a malformed id must stop startup: silently
/// dropping one could leave the operator believing a household can recover while every migration route is hidden.
fn parse_library_ids(var: &str, value: &str) -> Result<HashSet<String>, String> {
    value.split(',').map(str::trim).filter(|id| !id.is_empty()).try_fold(HashSet::new(), |mut ids, id| {
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err(format!("{var}: {id:?} is not an exact lowercase 32-hex library id"));
        }
        if !ids.insert(id.to_owned()) {
            return Err(format!("{var}: duplicate household {id:?}"));
        }
        Ok(ids)
    })
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

/// HTTPS anywhere, or HTTP only where a Cast receiver on the same LAN can route it. Loopback is intentionally
/// excluded: on a Chromecast it names the Chromecast, not the Hearth host.
fn lan_media_origin(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    if url.origin().ascii_serialization() != value {
        return false;
    }
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str().map(|host| host.trim_end_matches('.').to_ascii_lowercase()) else {
        return false;
    };
    if host.ends_with(".local") && host != "localhost.local" {
        return true;
    }
    let Ok(address) = host.parse::<std::net::Ipv4Addr>() else { return false };
    address.is_private()
}

/// The MCP connector's authorization server, when `OAUTH_ISSUER` (its public https origin) and `OAUTH_SIGNING_KEY` (an
/// Ed25519 private key's 32 bytes, unpadded base64url) are both set. `OAUTH_RESOURCE` is the origin den-mcp is reached
/// on when it is not the issuer's, and `OAUTH_CONSENT_ORIGIN` the web app's when the issuer is not its name.
fn oauth_config() -> Option<oauth::OAuth> {
    let (issuer, seed) = match (env_opt("OAUTH_ISSUER"), env_opt("OAUTH_SIGNING_KEY")) {
        (None, None) => return None,
        (Some(issuer), Some(seed)) => (issuer, seed),
        _ => {
            eprintln!("OAUTH_ISSUER and OAUTH_SIGNING_KEY go together — the MCP connector is off");
            return None;
        }
    };
    let Some(issuer) = origin(&issuer) else {
        eprintln!("OAUTH_ISSUER must be a bare origin — the MCP connector is off");
        return None;
    };
    let Some(seed) = oauth::b64url_decode(seed.trim()).and_then(|s| <[u8; 32]>::try_from(s).ok()) else {
        eprintln!("OAUTH_SIGNING_KEY must be 32 bytes, unpadded base64url — the MCP connector is off");
        return None;
    };
    let resource = env_opt("OAUTH_RESOURCE").and_then(|v| origin(&v)).unwrap_or_else(|| issuer.clone());
    let consent = env_opt("OAUTH_CONSENT_ORIGIN").and_then(|v| origin(&v)).unwrap_or_else(|| issuer.clone());
    let mut oauth = oauth::OAuth::new(issuer, format!("{resource}/mcp"), consent, seed);
    // den-mcp's X-Wing public key: with it, a member may let an assistant change the library (`den:library.write`).
    if let Some(key) = env_opt("MCP_WRITE_PUBLIC_KEY") {
        oauth.write_public = oauth::write_public_key(key.trim());
        if oauth.write_public.is_none() {
            eprintln!("MCP_WRITE_PUBLIC_KEY must be an X-Wing public key, unpadded base64url — assistant writes are off");
        }
    }
    Some(oauth)
}

/// An env var's value, with unset and empty both meaning "not configured" — the rule every den addon uses.
fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// A yes/no env var that defaults to `default` when unset or empty, rather than to off: `LOG_IDENTITY` must stay
/// on through a deploy that forgets to set it, so only an explicit `0` or `false` (either case) turns it off.
fn env_flag(name: &str, default: bool) -> bool {
    match env_opt(name) {
        None => default,
        Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false"),
    }
}

/// A value that is on, off, or deliberately unsaid. Unlike `env_flag`, anything outside the six spellings is an
/// error: a mistyped rollback signal must stop the start, not be read as "on".
fn parse_tri_state(name: &str, value: &str) -> Result<Option<bool>, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" => Ok(None),
        "1" | "true" | "on" => Ok(Some(true)),
        "0" | "false" | "off" => Ok(Some(false)),
        _ => Err(format!("{name} is {value:?}: expected 1, true, on, 0, false or off")),
    }
}

/// A whole number from the environment, unset and empty both meaning "not configured". One that is set and does
/// not parse stops the start, as a mistyped `NEW_LIBRARIES` does: dropped, a mistyped daily ceiling was silently
/// no ceiling at all, and a mistyped port or store cap silently the default.
fn env_number<T: std::str::FromStr>(name: &str) -> Option<T> {
    let value = env_opt(name)?;
    Some(parse_number(name, &value).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    }))
}

fn parse_number<T: std::str::FromStr>(name: &str, value: &str) -> Result<T, String> {
    value.trim().parse().map_err(|_| format!("{name} is {value:?}: expected a whole number"))
}

/// How serving ended. A drain that ran out of time is designed and exits 0, like a clean one.
#[derive(Debug)]
enum Outcome {
    Drained,
    DeadlineHit(String),
}

impl Outcome {
    fn describe(&self) -> String {
        match self {
            Outcome::Drained => "shut down cleanly".to_owned(),
            Outcome::DeadlineHit(why) => why.clone(),
        }
    }
}

/// How long a connection may take over its request head, and how long a stop waits for the requests in flight.
struct Limits {
    grace: Duration,
    header_read: Duration,
}

/// Longest a connection may take to send a request head, idle keep-alive included: past it the connection is
/// closed. It only applies once the server has a timer — `axum::serve` gives it none, so a client could hold a
/// socket half-way through a head for as long as it liked.
///
/// hyper has no separate keep-alive idle bound, so this is also how long an idle connection is kept, and it is
/// longer than the proxies in front keep theirs: a proxy that sends a request into a connection den-edge is closing
/// at that moment gets no answer, and one it does not retry — Go's transport retries only idempotent requests, so a
/// POST — would reach the visitor as a 502. That race is reasoned from the defaults, not seen. hyper's own default
/// of 30 s was under the 90 s idle both `cloudflared` (`keepAliveTimeout`) and `tailscale serve` (Go's
/// `http.DefaultTransport`) are assumed to keep: their documented defaults, not checked on the box.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(120);
const _: () = assert!(HEADER_READ_TIMEOUT.as_secs() > 90);

/// Accepted HTTP/1 connections, including idle keep-alives and clients still sending their request head. At the
/// 16 KiB Hyper read-buffer ceiling this has a 4 MiB protocol-buffer upper bound instead of an unbounded task/FD
/// count with roughly 400 KiB available to each connection.
const CONNECTIONS: usize = 256;
const CONNECTION_READ_BUFFER: usize = 16 * 1024;

/// Serve until `shutdown` resolves, then drain for at most `limits.grace` — den-atlas's bounded drain: hyper waits
/// on a connection that is mid-request, so without the bound a client holding half a request head decides
/// how long a restart takes.
///
/// hyper's HTTP/1 server directly rather than `axum::serve`, which offers no way to give hyper a timer, and
/// without one the header read timeout is never applied.
async fn serve_until(
    listeners: Vec<tokio::net::TcpListener>,
    app: axum::Router,
    metrics: Arc<metrics::Metrics>,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    limits: Limits,
) -> Outcome {
    use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
    // HTTP/1 only. Left to tell HTTP/2 prior knowledge from HTTP/1 itself, the builder waits for a connection's
    // first bytes before hyper's timer starts, so one that sends nothing was held without limit
    // (`a_request_head_that_never_ends_is_closed`). No client of den-edge is known to speak cleartext HTTP/2 to it:
    // browsers never do, and `tailscale serve` and `cloudflared` default to HTTP/1.1 towards an http origin (their
    // documented defaults, not checked on the box).
    let mut builder = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new()).http1_only();
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(limits.header_read)
        .max_buf_size(CONNECTION_READ_BUFFER);
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let connections = Arc::new(tokio::sync::Semaphore::new(CONNECTIONS));
    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        // Take capacity before accept. Once all userspace connection tasks are occupied, the kernel listen
        // backlog supplies bounded backpressure without allocating another Tokio task or Hyper buffer per peer.
        let connection = match Arc::clone(&connections).try_acquire_owned() {
            Ok(permit) => permit,
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                metrics.connection_waited();
                tokio::select! {
                    permit = Arc::clone(&connections).acquire_owned() => permit.expect("connection semaphore is never closed"),
                    () = &mut shutdown => break,
                }
            }
            Err(tokio::sync::TryAcquireError::Closed) => unreachable!("connection semaphore is never closed"),
        };
        let (stream, peer) = tokio::select! {
            accepted = accept_any(&listeners) => match accepted {
                Ok(accepted) => accepted,
                // What `axum::serve` does: a connection reset before it was taken is that connection's
                // business, and anything else (out of descriptors) is waited out rather than spun on.
                Err(e) if is_connection_error(&e) => continue,
                Err(e) => {
                    eprintln!("accept error: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            },
            () = &mut shutdown => break,
        };
        // Hyper can finish a response into an autotuned kernel send queue before a slow client has read it. The
        // body then releases its media permit while megabytes remain charged to the cgroup, so application-level
        // stream limits alone are not a memory bound. Keep every accepted connection's queues small and refuse a
        // connection if the platform cannot honor the ceiling.
        if let Err(e) = bound_connection_buffers(&stream) {
            eprintln!("refusing {peer}: cannot bound TCP buffers: {e}");
            continue;
        }
        let service = hyper_util::service::TowerToHyperService::new(
            app.clone().layer(axum::Extension(axum::extract::ConnectInfo(peer))),
        );
        let conn = graceful.watch(builder.serve_connection(TokioIo::new(stream), service).into_owned());
        metrics.connection_admitted();
        let connection = ConnectionAdmission { _permit: connection, metrics: Arc::clone(&metrics) };
        tokio::spawn(async move {
            let _connection = connection;
            let _ = conn.await;
        });
    }
    drop(listeners);
    tokio::select! {
        () = graceful.shutdown() => Outcome::Drained,
        () = tokio::time::sleep(limits.grace) => Outcome::DeadlineHit(format!(
            "drain deadline ({:?}) reached with requests still in flight",
            limits.grace
        )),
    }
}

/// The next connection on any of `listeners` (one `PORT` socket, plus the supervisor's when it handed one over).
async fn accept_any(
    listeners: &[tokio::net::TcpListener],
) -> std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)> {
    std::future::poll_fn(|cx| {
        for listener in listeners {
            if let std::task::Poll::Ready(accepted) = listener.poll_accept(cx) {
                return std::task::Poll::Ready(accepted);
            }
        }
        std::task::Poll::Pending
    })
    .await
}

// Linux reports twice the requested SO_SNDBUF/SO_RCVBUF because it includes kernel bookkeeping. These effective
// ceilings therefore bound 256 admitted connections to at most 32 MiB of downstream response queues plus 16 MiB
// of request queues; media's upstream queues are bounded separately in `relay::client`.
const CONNECTION_SEND_BUFFER: usize = 64 * 1024;
const CONNECTION_RECV_BUFFER: usize = 32 * 1024;
const SOCKET_BUFFER_ACCOUNTING_FACTOR: usize = 2;

// The read-back is only a sound check on Linux, where an explicit SO_RCVBUF/SO_SNDBUF switches autotuning off for
// good. macOS keeps growing the receive buffer of a connection that is already receiving data, even straight after
// an explicit set, so a legitimate local client (Node's fetch, the rehearsal) would read back far above the ceiling
// and be refused at random. The cgroup memory bound this guards is a Linux deployment concern, so elsewhere the
// ceilings are applied best-effort and not verified.
const VERIFY_BUFFER_CEILINGS: bool = cfg!(target_os = "linux");

fn bound_connection_buffers(stream: &tokio::net::TcpStream) -> std::io::Result<()> {
    let socket = socket2::SockRef::from(stream);
    socket.set_send_buffer_size(CONNECTION_SEND_BUFFER)?;
    socket.set_recv_buffer_size(CONNECTION_RECV_BUFFER)?;
    if !VERIFY_BUFFER_CEILINGS {
        return Ok(());
    }
    let send = socket.send_buffer_size()?;
    let recv = socket.recv_buffer_size()?;
    if send > CONNECTION_SEND_BUFFER * SOCKET_BUFFER_ACCOUNTING_FACTOR
        || recv > CONNECTION_RECV_BUFFER * SOCKET_BUFFER_ACCOUNTING_FACTOR
    {
        return Err(std::io::Error::other(format!(
            "effective buffers exceed ceilings (send={send}, recv={recv})"
        )));
    }
    Ok(())
}

struct ConnectionAdmission {
    _permit: tokio::sync::OwnedSemaphorePermit,
    metrics: Arc<metrics::Metrics>,
}

impl Drop for ConnectionAdmission {
    fn drop(&mut self) {
        self.metrics.connection_released();
    }
}

fn is_connection_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::{ConnectionAborted, ConnectionRefused, ConnectionReset};
    matches!(e.kind(), ConnectionRefused | ConnectionAborted | ConnectionReset)
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

    #[tokio::test]
    async fn accepted_connection_kernel_buffers_are_bounded() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(tokio::net::TcpStream::connect(addr));
        let (server, _) = listener.accept().await.unwrap();
        let client = client.await.unwrap().unwrap();

        bound_connection_buffers(&server).unwrap();
        let socket = socket2::SockRef::from(&server);
        assert!(
            socket.send_buffer_size().unwrap() <= CONNECTION_SEND_BUFFER * SOCKET_BUFFER_ACCOUNTING_FACTOR
        );
        assert!(
            socket.recv_buffer_size().unwrap() <= CONNECTION_RECV_BUFFER * SOCKET_BUFFER_ACCOUNTING_FACTOR
        );
        drop(client);
    }

    // A client such as Node's undici sends its request the moment the handshake completes, so the connection is
    // already receiving data when it is bounded. On macOS the kernel then grows the receive buffer past the
    // ceiling at random (seen: recv=555392), which must not get a legitimate connection refused.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn bounding_a_connection_that_is_already_receiving_data_is_not_refused() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut refused = Vec::new();
        for _ in 0..1000 {
            let writer = tokio::spawn(async move {
                let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
                while client.write_all(&[b'x'; 64 * 1024]).await.is_ok() {}
            });
            let (server, _) = listener.accept().await.unwrap();
            if let Err(e) = bound_connection_buffers(&server) {
                refused.push(e.to_string());
            }
            // Drain like a server that has started reading the request, which lets the kernel grow the window.
            let drain = tokio::spawn(async move {
                let mut server = server;
                let _ = tokio::io::copy(&mut server, &mut tokio::io::sink()).await;
            });
            tokio::time::sleep(Duration::from_millis(2)).await;
            writer.abort();
            drain.abort();
        }
        assert!(refused.is_empty(), "{} of 1000 refused, e.g. {:?}", refused.len(), refused.first());
    }

    #[test]
    fn profile_prepare_enrollment_accepts_only_exact_unique_household_ids() {
        let first = "0123456789abcdef0123456789abcdef";
        let second = "fedcba9876543210fedcba9876543210";
        let ids = parse_library_ids("PROFILE_PREPARE_HOUSEHOLDS", &format!(" {first}, {second} ")).unwrap();
        assert_eq!(ids, HashSet::from([first.to_owned(), second.to_owned()]));
        assert!(parse_library_ids("PROFILE_PREPARE_HOUSEHOLDS", "").unwrap().is_empty());
        for invalid in [
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdeg",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcdef,0123456789abcdef0123456789abcdef",
        ] {
            assert!(parse_library_ids("PROFILE_PREPARE_HOUSEHOLDS", invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn profiles_tv_is_tri_state_and_rejects_anything_else() {
        for (value, expected) in [
            ("", None),
            ("  ", None),
            ("1", Some(true)),
            ("true", Some(true)),
            (" ON ", Some(true)),
            ("0", Some(false)),
            ("False", Some(false)),
            ("off", Some(false)),
        ] {
            assert_eq!(parse_tri_state("PROFILES_TV", value), Ok(expected), "{value:?}");
        }
        for invalid in ["yes", "no", "2", "enabled", "tru", "1,0"] {
            assert!(parse_tri_state("PROFILES_TV", invalid).is_err(), "{invalid}");
        }
    }

    /// A socket bound by someone else (the supervisor) serves requests, and its accepted connections still get
    /// their kernel buffers bounded.
    #[cfg(unix)]
    #[tokio::test]
    async fn serves_on_an_inherited_listening_socket() {
        use std::os::fd::IntoRawFd;
        let owner = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = owner.local_addr().unwrap();
        // A connection made before the "process" adopts the socket waits in the kernel queue, not refused.
        let mut early = tokio::net::TcpStream::connect(addr).await.unwrap();
        let listener = unsafe { adopt_listener(owner.into_raw_fd()) }.unwrap();
        assert_eq!(listener.local_addr().unwrap(), addr);
        let state = Arc::new(AppState::new(
            store::Store::open(&handler::tests::temp_dir(), store::DEFAULT_CAP).unwrap(),
            None,
            false,
        ));
        let metrics = Arc::clone(&state.metrics);
        let app = axum::Router::new().fallback(handler::handle).with_state(state);
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let limits = Limits { grace: Duration::from_millis(300), header_read: HEADER_READ_TIMEOUT };
        let server = tokio::spawn(async move {
            serve_until(vec![listener], app, metrics, async { rx.await.unwrap_or(()) }, limits).await
        });
        early.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut reply = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut early, &mut reply).await.unwrap();
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        let _ = tx.send(());
        tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
    }

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
        let metrics = Arc::clone(&state.metrics);
        let app = axum::Router::new().fallback(handler::handle).with_state(state);
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let grace = Duration::from_millis(300);
        let limits = Limits { grace, header_read: HEADER_READ_TIMEOUT };
        let server = tokio::spawn(async move {
            serve_until(vec![l], app, metrics, async { rx.await.unwrap_or(()) }, limits).await
        });

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
        drop(sock);
    }

    /// A server on a fresh port, relaying `/atlas` to an addon that answers `{}` at once; stopped by dropping the
    /// sender.
    async fn relaying_server(
        header_read: Duration,
    ) -> (std::net::SocketAddr, tokio::sync::oneshot::Sender<()>) {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addon = upstream.local_addr().unwrap();
        let answer = axum::Router::new().fallback(|| async { "{}" });
        tokio::spawn(async move { axum::serve(upstream, answer).await.unwrap() });
        let mut state = AppState::new(
            store::Store::open(&handler::tests::temp_dir(), store::DEFAULT_CAP).unwrap(),
            None,
            false,
        );
        state.relays = parse_relays(&format!("/atlas=http://{addon}"));
        let state = Arc::new(state);
        let metrics = Arc::clone(&state.metrics);
        let app = axum::Router::new().fallback(handler::handle).with_state(state);
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let limits = Limits { grace: Duration::from_millis(100), header_read };
        tokio::spawn(async move {
            serve_until(vec![l], app, metrics, async { rx.await.unwrap_or(()) }, limits).await
        });
        (addr, tx)
    }

    /// What `raw` gets back, read until the server closes.
    async fn exchange(addr: std::net::SocketAddr, raw: &str) -> String {
        use tokio::io::AsyncReadExt;
        let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
        sock.write_all(raw.as_bytes()).await.unwrap();
        let mut answer = String::new();
        sock.read_to_string(&mut answer).await.unwrap();
        answer
    }

    /// Sixteen uploads that never finish their body used to take every relay slot for as long as their sockets
    /// stayed open, and the household's next relayed request waited out the slot wait for a 503 `relay_busy`.
    #[tokio::test]
    async fn uploads_that_never_finish_do_not_take_the_relay() {
        let (addr, _stop) = relaying_server(Duration::from_secs(30)).await;
        let mut stalled = Vec::new();
        for _ in 0..relay::MAX_IN_FLIGHT {
            let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
            let head = "POST /atlas/recommend HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n";
            sock.write_all(format!("{head}Content-Length: 100\r\n\r\n{{").as_bytes()).await.unwrap();
            stalled.push(sock);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let answer = tokio::time::timeout(
            Duration::from_secs(3),
            exchange(addr, "GET /atlas/labels.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
        )
        .await
        .expect("the relay was held");
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    }

    /// A connection that never finishes its request head is closed after the header read timeout; with no timer,
    /// hyper never applied one and the socket was held for as long as the client liked.
    #[tokio::test]
    async fn a_request_head_that_never_ends_is_closed() {
        let (addr, _stop) = relaying_server(Duration::from_millis(200)).await;
        let closed = tokio::time::timeout(
            Duration::from_secs(3),
            exchange(addr, "GET /health HTTP/1.1\r\nHost: x\r\n"),
        );
        assert!(closed.await.is_ok(), "still open");
        // So is one that never sends a byte.
        let silent = tokio::time::timeout(Duration::from_secs(3), exchange(addr, ""));
        assert!(silent.await.is_ok(), "a silent connection is still open");
        // An idle keep-alive connection is the same wait for a head, and goes the same way.
        let idle = "GET /health HTTP/1.1\r\nHost: x\r\n\r\n";
        let answer =
            tokio::time::timeout(Duration::from_secs(3), exchange(addr, idle)).await.expect("still open");
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    }

    #[test]
    fn log_identity_defaults_on_and_only_0_or_false_turns_it_off() {
        let name = "DEN_EDGE_TEST_LOG_IDENTITY_FLAG";
        std::env::remove_var(name);
        assert!(env_flag(name, true), "unset must keep the default");
        for off in ["0", "false", "FALSE", " false "] {
            std::env::set_var(name, off);
            assert!(!env_flag(name, true), "{off:?} must turn it off");
        }
        for on in ["1", "true", "yes", "anything-else"] {
            std::env::set_var(name, on);
            assert!(env_flag(name, true), "{on:?} must leave it on");
        }
        std::env::remove_var(name);
    }

    #[test]
    fn a_number_that_does_not_parse_is_said_not_dropped() {
        assert_eq!(parse_number::<u64>("TMDB_DAILY_MAX", " 500 "), Ok(500));
        assert_eq!(
            parse_number::<u64>("TMDB_DAILY_MAX", "5k"),
            Err(r#"TMDB_DAILY_MAX is "5k": expected a whole number"#.to_owned())
        );
        assert!(parse_number::<u16>("PORT", "80800").is_err(), "out of range");
    }

    #[test]
    fn lan_media_may_be_https_or_private_http_but_never_loopback_or_public_http() {
        for accepted in [
            "https://media.example",
            "http://10.0.0.8:8090",
            "http://172.20.1.8",
            "http://192.168.86.8:8090",
            "http://hearth.local:8090",
        ] {
            assert!(lan_media_origin(accepted), "{accepted}");
        }
        for refused in [
            "http://127.0.0.1:8090",
            "http://localhost:8090",
            "http://169.254.1.8:8090",
            "http://203.0.113.8:8090",
            "http://media.example",
            "http://192.168.1.8:8090/path",
        ] {
            assert!(!lan_media_origin(refused), "{refused}");
        }
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
