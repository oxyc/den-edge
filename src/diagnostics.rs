//! What a browser's web player and Chromecast/AirPlay path saw and the device API never does: a page that broke
//! or never rendered, how playback was routed or ended, and how a cast attempt went. Sibling reports beside
//! `startup.rs` (den-edge#234's precedent), same shape: `POST`, rate-limited per address, serde-allowlisted so a
//! body this doesn't parse into one of the structs below is a 400, not a line in the log — and every field is an
//! enum or a capped number. Never a title, a URL, a token, a library id or any other free text, by construction
//! rather than by scrubbing.

use crate::handler::{
    client_ip, error, json_reply, read_json, retry_after, CastTag, LoadTag, PageErrorTag, PerformanceTag,
    PlaybackOutcomeTag, PlaybackRouteTag, ReportField,
};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::sync::Arc;

/// A handful of enums and short strings: a few hundred bytes, generously, for any report in this file.
const MAX_BODY_BYTES: usize = 2048;
/// One of these per page load, or per playback session, or per cast attempt — headroom for a retry, not a stream.
const PER_MINUTE: u32 = 20;
const MAX_MS: u32 = 600_000;
const MAX_SECS: u32 = 24 * 3600;

/// Read `req`'s body as `T` within `MAX_BODY_BYTES`, rate-limited per address under `bucket`. The shared half of
/// every handler below; `Err` already carries the response to answer with, boxed like `read_json`'s.
async fn intake<T: DeserializeOwned>(
    state: &Arc<AppState>,
    req: Request,
    bucket: &str,
) -> Result<T, Box<Response>> {
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_per_minute(state, &format!("{bucket}:{ip}"), PER_MINUTE) {
        return Err(Box::new(retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait)));
    }
    let value = read_json(req, MAX_BODY_BYTES).await?;
    serde_json::from_value::<T>(value.clone()).map_err(|_| {
        let mut resp = json_reply(StatusCode::BAD_REQUEST, &error("invalid_report"));
        if let Some(field) = refused_field::<T>(&value) {
            resp.extensions_mut().insert(ReportField(field));
        }
        Box::new(resp)
    })
}

/// The one optional field whose value alone made `value` fail to parse as `T`: the report parses without it. Only a
/// field name of a few letters is named, never its value; a missing required field, or several bad ones, name none.
fn refused_field<T: DeserializeOwned>(value: &serde_json::Value) -> Option<String> {
    let object = value.as_object()?;
    object.keys().find_map(|key| {
        let named = (1..=24).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphabetic());
        let mut without = object.clone();
        without.remove(key);
        (named && serde_json::from_value::<T>(serde_json::Value::Object(without)).is_ok())
            .then(|| key.clone())
    })
}

/// A bare `204`, `no-store`, with `tag` for the request log — the shape every report in this file answers with.
fn accepted(tag: String, insert: impl FnOnce(&mut Response, String)) -> Response {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    insert(&mut resp, tag);
    resp
}

/// A short string of lowercase ASCII hex digits and digits, `.`, `-` and `+` — the shell's own `x-den-release`
/// (`web.rs`'s `release()`, the shell's digest), read back by `web/src/lib/diagnosticsReport.ts` from the page
/// this report is about. Rejected outright rather than truncated: a release string is never partial.
#[derive(Clone, Deserialize)]
#[serde(try_from = "String")]
struct Release(String);

/// The shell's digest is a SHA-256, 64 hex digits. At 32 every report that named its release was a 400.
const MAX_RELEASE_LEN: usize = 64;

impl TryFrom<String> for Release {
    type Error = &'static str;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        let ok = !s.is_empty()
            && s.len() <= MAX_RELEASE_LEN
            && s.bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || matches!(b, b'.' | b'-' | b'+'));
        if ok {
            Ok(Release(s))
        } else {
            Err("invalid_release")
        }
    }
}

/// A subtitle's language as a short BCP-47-ish tag (`en`, `pt-br`) — lowercase ASCII letters and hyphens only,
/// never the free-text name of a language.
#[derive(Clone, Deserialize)]
#[serde(try_from = "String")]
struct Language(String);

impl TryFrom<String> for Language {
    type Error = &'static str;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        let ok = (2..=8).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
        if ok {
            Ok(Language(s))
        } else {
            Err("invalid_language")
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Identity: what was played, carried on `/playback/outcome`, `/playback/cast` and `/playback/startup` — the TMDB
// id and media kind, the release opened, and the chosen audio/subtitle tracks — gated as one group by
// `LOG_IDENTITY` (`AppState::log_identity`, default on). Joinable to the session, device or guest by the
// request id every one of these reports is already logged with (`handler::log_line`'s `rid=`); never a title, a
// URL, a token or a library id. The box's journal is RAM-only and reaches only its owner (den#246).
//
// Present on the struct whatever the switch says — accepting the field is this box's call, not a caller's — and
// reaching the log only through `tag()`, which leaves the whole group out when `log_identity` is false.

/// TMDB's own numeric id for a title. Carried as-is: this report never looks it up or validates it against TMDB.
type TmdbId = u32;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MediaType {
    Movie,
    Tv,
}

impl MediaType {
    fn as_str(&self) -> &'static str {
        match self {
            MediaType::Movie => "movie",
            MediaType::Tv => "tv",
        }
    }
}

/// den-remux always re-encodes a browser session's audio to AAC (`web/src/lib/remux.ts`'s `Session`), so this is
/// the one value a report can send today; typed rather than a free string so a future codec is a deliberate
/// addition here, not a silent pass-through.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AudioCodec {
    Aac,
}

impl AudioCodec {
    fn as_str(&self) -> &'static str {
        match self {
            AudioCodec::Aac => "aac",
        }
    }
}

/// A release name: letters, digits, space and `._-[]()+` only, and never empty or past `MAX_RELEASE_NAME_LEN`.
///
/// Unlike `Release` (the shell's digest) above, a name outside this shape does not fail the whole report: a
/// release name is the one identity field a hostile or malformed body is most likely to get wrong, and the rest
/// of the report — what matters for reproducing a stall — must still reach the log. So this is read as a plain
/// `String` and checked here, after parsing, rather than through `TryFrom`.
const MAX_RELEASE_NAME_LEN: usize = 200;

fn valid_release_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_RELEASE_NAME_LEN
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b' ' | b'.' | b'_' | b'-' | b'[' | b']' | b'(' | b')' | b'+')
        })
}

/// The release den-remux opened: a name and a size, validated and logged together — a name outside
/// `valid_release_name`'s shape drops both rather than logging an orphaned size.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRelease {
    name: String,
    size: u64,
}

/// The identity fields a report may carry, flattened into it so every one of them answers the same `LOG_IDENTITY`
/// switch (`tag`) rather than each report gating its own copy.
#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Identity {
    tmdb_id: Option<TmdbId>,
    media_type: Option<MediaType>,
    season: Option<u32>,
    episode: Option<u32>,
    release: Option<RawRelease>,
    audio_track_index: Option<u32>,
    audio_language: Option<Language>,
    audio_codec: Option<AudioCodec>,
    subtitle_index: Option<u32>,
    subtitle_language: Option<Language>,
    subtitle_source: Option<SubtitleSource>,
}

impl Identity {
    /// This group's `name:value` parts, to extend a report's own into one `tag()` — empty when `log_identity` is
    /// off, or when every field was absent or failed its own validation (a release name outside its shape, say).
    pub(crate) fn parts(&self, log_identity: bool) -> Vec<String> {
        if !log_identity {
            return Vec::new();
        }
        let mut parts = Vec::new();
        if let Some(id) = self.tmdb_id {
            parts.push(format!("tmdbId:{id}"));
        }
        if let Some(t) = &self.media_type {
            parts.push(format!("mediaType:{}", t.as_str()));
        }
        if let Some(s) = self.season {
            parts.push(format!("season:{s}"));
        }
        if let Some(e) = self.episode {
            parts.push(format!("episode:{e}"));
        }
        if let Some(r) = &self.release {
            if valid_release_name(&r.name) {
                parts.push(format!("release:{}", r.name));
                parts.push(format!("releaseSize:{}", r.size));
            }
        }
        if let Some(i) = self.audio_track_index {
            parts.push(format!("audioTrack:{i}"));
        }
        if let Some(l) = &self.audio_language {
            parts.push(format!("audioLang:{}", l.0));
        }
        if let Some(c) = &self.audio_codec {
            parts.push(format!("audioCodec:{}", c.as_str()));
        }
        if let Some(i) = self.subtitle_index {
            parts.push(format!("subIndex:{i}"));
        }
        if let Some(l) = &self.subtitle_language {
            parts.push(format!("subLang:{}", l.0));
        }
        if let Some(s) = &self.subtitle_source {
            parts.push(format!("subSource:{}", s.as_str()));
        }
        parts
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Page errors (`POST /playback/page-error`): an uncaught error, an unhandled rejection, a chunk that failed to
// load, or a page whose first route never rendered.

const PAGE_ERROR_BUCKET: &str = "page-error";

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ErrorKind {
    Uncaught,
    UnhandledRejection,
    ChunkLoad,
    RenderStall,
}

impl ErrorKind {
    fn as_str(&self) -> &'static str {
        match self {
            ErrorKind::Uncaught => "uncaught",
            ErrorKind::UnhandledRejection => "unhandled_rejection",
            ErrorKind::ChunkLoad => "chunk_load",
            ErrorKind::RenderStall => "render_stall",
        }
    }
}

/// The component the error's stack named, against a fixed allowlist (`web/src/lib/diagnosticsReport.ts`'s
/// `moduleOf`) — never the stack itself, which may carry a path or a query string.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Module {
    App,
    Player,
    Billboard,
    Row,
    Settings,
    Cast,
    Router,
    Other,
}

impl Module {
    fn as_str(&self) -> &'static str {
        match self {
            Module::App => "app",
            Module::Player => "player",
            Module::Billboard => "billboard",
            Module::Row => "row",
            Module::Settings => "settings",
            Module::Cast => "cast",
            Module::Router => "router",
            Module::Other => "other",
        }
    }
}

/// The error's real constructor (`web/src/lib/diagnosticsReport.ts`'s `errorKindOf`), from a closed allowlist —
/// never its `message` or its (freely settable) `.name`, and never a URL. `DomException` covers every one of a
/// `DOMException`'s named variants but `NetworkError`, named on its own as the one a fetch or a media element's
/// own network failure actually throws.
#[derive(Deserialize)]
enum ThrownErrorKind {
    #[serde(rename = "TypeError")]
    TypeError,
    #[serde(rename = "ReferenceError")]
    ReferenceError,
    #[serde(rename = "RangeError")]
    RangeError,
    #[serde(rename = "SyntaxError")]
    SyntaxError,
    #[serde(rename = "DOMException")]
    DomException,
    #[serde(rename = "NetworkError")]
    NetworkError,
    #[serde(rename = "other")]
    Other,
}

impl ThrownErrorKind {
    fn as_str(&self) -> &'static str {
        match self {
            ThrownErrorKind::TypeError => "TypeError",
            ThrownErrorKind::ReferenceError => "ReferenceError",
            ThrownErrorKind::RangeError => "RangeError",
            ThrownErrorKind::SyntaxError => "SyntaxError",
            ThrownErrorKind::DomException => "DOMException",
            ThrownErrorKind::NetworkError => "NetworkError",
            ThrownErrorKind::Other => "other",
        }
    }
}

/// A built chunk's base name (`web/src/lib/diagnosticsReport.ts`'s `chunkOf`): PascalCase, letters and digits
/// only, capped well past any real chunk's name — never the frame it came from, which may carry a path or a
/// query string a production build appends for cache-busting.
const MAX_CHUNK_LEN: usize = 32;

#[derive(Deserialize)]
#[serde(try_from = "String")]
struct Chunk(String);

impl TryFrom<String> for Chunk {
    type Error = &'static str;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        let ok = !s.is_empty()
            && s.len() <= MAX_CHUNK_LEN
            && s.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
            && s.bytes().all(|b| b.is_ascii_alphanumeric());
        if ok {
            Ok(Chunk(s))
        } else {
            Err("invalid_chunk")
        }
    }
}

/// Which kind of page this was, never the page itself: a title's id or a search's query must not reach the log.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum PageRoute {
    Home,
    Title,
    Settings,
    Other,
}

impl PageRoute {
    fn as_str(&self) -> &'static str {
        match self {
            PageRoute::Home => "home",
            PageRoute::Title => "title",
            PageRoute::Settings => "settings",
            PageRoute::Other => "other",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageErrorReport {
    platform: Option<ClientPlatform>,
    kind: ErrorKind,
    module: Module,
    /// Absent for a report with no caught error to read one from (`render_stall`, `chunk_load`).
    error_kind: Option<ThrownErrorKind>,
    /// Absent where the error's first stack frame named no app chunk (`chunkOf`).
    chunk: Option<Chunk>,
    /// Absent when the page's own re-fetch of its release (`diagnosticsReport.ts`'s `loadRelease`) hadn't
    /// resolved yet — an error in the first moment of a load — rather than a report that waits for it.
    release: Option<Release>,
    route: PageRoute,
}

impl PageErrorReport {
    fn tag(&self) -> String {
        let mut tag = format!("kind:{},module:{}", self.kind.as_str(), self.module.as_str());
        if let Some(platform) = self.platform {
            tag.push_str(&format!(",platform:{}", platform.as_str()));
        }
        if let Some(error_kind) = &self.error_kind {
            tag.push_str(&format!(",errorKind:{}", error_kind.as_str()));
        }
        if let Some(chunk) = &self.chunk {
            tag.push_str(&format!(",chunk:{}", chunk.0));
        }
        if let Some(release) = &self.release {
            tag.push_str(&format!(",release:{}", release.0));
        }
        tag.push_str(&format!(",route:{}", self.route.as_str()));
        tag
    }
}

pub async fn handle_page_error(state: &Arc<AppState>, req: Request) -> Response {
    let report: PageErrorReport = match intake(state, req, PAGE_ERROR_BUCKET).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    accepted(report.tag(), |resp, tag| {
        resp.extensions_mut().insert(PageErrorTag(tag));
    })
}

// ---------------------------------------------------------------------------------------------------------------
// A page load's timing (`POST /playback/load`, `web/src/lib/loadReport.ts`): how long one load took to reach each
// of its milestones, on which kind of page, device and engine — sent once per load, so a page slow on one phone is
// read from this log line rather than reproduced.

const LOAD_BUCKET: &str = "load";
/// A page starts a Worker per library session and one more on a restart; past this is a burst worth seeing as such.
const MAX_WORKERS: u32 = 50;
/// Caps on one kind's request tally: its count, and its milliseconds summed across requests that overlap.
const MAX_REQUESTS: u32 = 10_000;
const MAX_NET_MS: u32 = 36_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum LoadRoute {
    Home,
    Movies,
    Series,
    Watchlist,
    Title,
    Settings,
    Other,
}

impl LoadRoute {
    fn as_str(&self) -> &'static str {
        match self {
            LoadRoute::Home => "home",
            LoadRoute::Movies => "movies",
            LoadRoute::Series => "series",
            LoadRoute::Watchlist => "watchlist",
            LoadRoute::Title => "title",
            LoadRoute::Settings => "settings",
            LoadRoute::Other => "other",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum DeviceClass {
    Phone,
    Tablet,
    Desktop,
    Tv,
}

impl DeviceClass {
    fn as_str(&self) -> &'static str {
        match self {
            DeviceClass::Phone => "phone",
            DeviceClass::Tablet => "tablet",
            DeviceClass::Desktop => "desktop",
            DeviceClass::Tv => "tv",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum BrowserEngine {
    Webkit,
    Blink,
    Gecko,
    Other,
}

/// The client implementation, separate from its form factor and browser engine. Optional on existing reports so
/// an older installed TV package keeps reporting while deployments roll forward.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClientPlatform {
    Web,
    Ios,
    Ipados,
    Webos,
    Tizen,
    AndroidTv,
    AppleTv,
}

impl ClientPlatform {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Ios => "ios",
            Self::Ipados => "ipados",
            Self::Webos => "webos",
            Self::Tizen => "tizen",
            Self::AndroidTv => "android_tv",
            Self::AppleTv => "apple_tv",
        }
    }
}

/// Browser heap counters are deliberately named as such: they are not comparable with a native process's RSS or
/// physical footprint. Engines that expose none omit the whole object rather than manufacturing zeroes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserMemory {
    js_heap_used_mb: u32,
    js_heap_total_mb: u32,
    js_heap_limit_mb: u32,
}

impl BrowserEngine {
    fn as_str(&self) -> &'static str {
        match self {
            BrowserEngine::Webkit => "webkit",
            BrowserEngine::Blink => "blink",
            BrowserEngine::Gecko => "gecko",
            BrowserEngine::Other => "other",
        }
    }
}

/// How the page was entered: the navigation timing entry's type, or `swap` for a load Den itself made onto a newer
/// release (`release.ts`, under `den-retry`). A page iOS discarded in the background and loads again on return
/// is any of the first three, never `swap`, so a "refreshed when I came back" is told apart from Den's own swap.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum LoadEntry {
    Navigate,
    Reload,
    BackForward,
    Swap,
}

impl LoadEntry {
    fn as_str(&self) -> &'static str {
        match self {
            LoadEntry::Navigate => "navigate",
            LoadEntry::Reload => "reload",
            LoadEntry::BackForward => "back_forward",
            LoadEntry::Swap => "swap",
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum StartupLongTaskPhase {
    Bootstrap,
    AppImport,
    AppMount,
    ScreenPreload,
    TvCss,
    TvSearch,
    ViewportMeasure,
    HomeShelves,
    HomeMetadata,
    HomeHero,
    Other,
}

impl StartupLongTaskPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::AppImport => "app_import",
            Self::AppMount => "app_mount",
            Self::ScreenPreload => "screen_preload",
            Self::TvCss => "tv_css",
            Self::TvSearch => "tv_search",
            Self::ViewportMeasure => "viewport_measure",
            Self::HomeShelves => "home_shelves",
            Self::HomeMetadata => "home_metadata",
            Self::HomeHero => "home_hero",
            Self::Other => "other",
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum StartupLongTaskStage {
    PreApp,
    AppImport,
    AppMount,
    BeforeShelves,
    ShelvesToBillboard,
    BillboardToHandover,
    HandoverToPoster,
    AfterPoster,
}

impl StartupLongTaskStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::PreApp => "pre_app",
            Self::AppImport => "app_import",
            Self::AppMount => "app_mount",
            Self::BeforeShelves => "before_shelves",
            Self::ShelvesToBillboard => "shelves_to_billboard",
            Self::BillboardToHandover => "billboard_to_handover",
            Self::HandoverToPoster => "handover_to_poster",
            Self::AfterPoster => "after_poster",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadReport {
    route: LoadRoute,
    device: DeviceClass,
    engine: BrowserEngine,
    platform: Option<ClientPlatform>,
    /// Milliseconds since navigation start; each absent when this load never reached it. A `worker_…` one is the
    /// first library Worker's own, on the page's clock.
    page_boot_ms: Option<u32>,
    app_module_ms: Option<u32>,
    app_evaluated_ms: Option<u32>,
    app_mounted_ms: Option<u32>,
    worker_started_ms: Option<u32>,
    worker_script_ms: Option<u32>,
    /// A session took a library Worker: one started at page boot, or a new one.
    session_worker_ms: Option<u32>,
    core_compile_start_ms: Option<u32>,
    core_compiled_ms: Option<u32>,
    worker_core_requested_ms: Option<u32>,
    worker_core_ready_ms: Option<u32>,
    worker_ready_ms: Option<u32>,
    capability_ms: Option<u32>,
    bootstrap_ms: Option<u32>,
    worker_log_requested_ms: Option<u32>,
    worker_log_opened_ms: Option<u32>,
    directory_ms: Option<u32>,
    handover_ms: Option<u32>,
    billboard_detail_ms: Option<u32>,
    shelves_ms: Option<u32>,
    poster_ms: Option<u32>,
    episodes_ms: Option<u32>,
    /// A first library read's start and end: on a slow device it is most of a first open.
    import_start_ms: Option<u32>,
    import_ms: Option<u32>,
    /// The same Worker steps as the last library Worker reached them: the handover waits for both of two.
    worker_script_last_ms: Option<u32>,
    worker_core_ready_last_ms: Option<u32>,
    worker_ready_last_ms: Option<u32>,
    worker_log_opened_last_ms: Option<u32>,
    /// What the TMDB cache did for this load, by outcome.
    #[serde(default)]
    tmdb_cache: std::collections::BTreeMap<TmdbCacheOutcome, u32>,
    workers: u32,
    /// The page started hidden (a background tab), which delays everything that waits for a frame.
    #[serde(default)]
    hidden: bool,
    entry: Option<LoadEntry>,
    release: Option<Release>,
    /// The page's own requests by kind, each `[count, milliseconds summed]`.
    #[serde(default)]
    net: std::collections::BTreeMap<NetKind, (u32, u32)>,
    /// Its Workers' requests by kind, the same way.
    #[serde(default)]
    worker_net: std::collections::BTreeMap<NetKind, (u32, u32)>,
    /// The page's script and Wasm files by where they came from, and its Workers'.
    files: Option<FileSources>,
    worker_files: Option<FileSources>,
    /// The page's main thread blocked 50 ms or more at a time: `[count, milliseconds in all, longest]`.
    long_tasks: Option<(u32, u32, u32)>,
    /// The same totals attributed to fixed page phases; never a title, id, route or URL.
    #[serde(default)]
    long_task_phases: std::collections::BTreeMap<StartupLongTaskPhase, (u32, u32, u32)>,
    /// Every task in one coarse interval between existing startup milestones.
    #[serde(default)]
    long_task_stages: std::collections::BTreeMap<StartupLongTaskStage, (u32, u32, u32)>,
    /// One settled-load JavaScript heap snapshot, where the engine makes those counters available.
    memory: Option<BrowserMemory>,
    /// What each library Worker's open did, by the library it serves.
    #[serde(default)]
    library_workers: LibraryWorkers,
}

/// A load's library Workers by the library each serves (`startupTiming.ts` `LibraryWorkerRole`): a profile
/// household's own, and a library's (a profile's, or a household's without profiles).
#[derive(Deserialize, Default)]
struct LibraryWorkers {
    household: Option<LibraryWorker>,
    profile: Option<LibraryWorker>,
}

/// What one library Worker's open did (`LibraryWorkerStartup`). Closed sets and a time only.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryWorker {
    views: Option<LibraryViews>,
    promoted: Option<LibraryPromotion>,
    selection: Option<LibrarySelectionKind>,
    core_requested_ms: Option<u32>,
}

/// Saved views, the fact store without them, or the whole log.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum LibraryViews {
    Saved,
    Facts,
    Miss,
}

/// Why a Worker opened its whole library after all: the kind of reason.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum LibraryPromotion {
    Cache,
    Selection,
    Command,
    Edit,
    Query,
    Task,
    Observation,
    Import,
    Continue,
    Reconcile,
    Content,
    Layout,
}

/// The selection a `selection` promotion was for.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum LibrarySelectionKind {
    Overview,
    Watchlist,
    Recommendations,
    Continue,
    History,
    Title,
    Presence,
    Settings,
    Devices,
    Connections,
    Simkl,
    Recovery,
    Runtime,
    Profiles,
    Downloads,
}

impl LibraryViews {
    fn as_str(self) -> &'static str {
        match self {
            LibraryViews::Saved => "saved",
            LibraryViews::Facts => "facts",
            LibraryViews::Miss => "miss",
        }
    }
}

impl LibraryPromotion {
    fn as_str(self) -> &'static str {
        match self {
            LibraryPromotion::Cache => "cache",
            LibraryPromotion::Selection => "selection",
            LibraryPromotion::Command => "command",
            LibraryPromotion::Edit => "edit",
            LibraryPromotion::Query => "query",
            LibraryPromotion::Task => "task",
            LibraryPromotion::Observation => "observation",
            LibraryPromotion::Import => "import",
            LibraryPromotion::Continue => "continue",
            LibraryPromotion::Reconcile => "reconcile",
            LibraryPromotion::Content => "content",
            LibraryPromotion::Layout => "layout",
        }
    }
}

impl LibrarySelectionKind {
    fn as_str(self) -> &'static str {
        match self {
            LibrarySelectionKind::Overview => "overview",
            LibrarySelectionKind::Watchlist => "watchlist",
            LibrarySelectionKind::Recommendations => "recommendations",
            LibrarySelectionKind::Continue => "continue",
            LibrarySelectionKind::History => "history",
            LibrarySelectionKind::Title => "title",
            LibrarySelectionKind::Presence => "presence",
            LibrarySelectionKind::Settings => "settings",
            LibrarySelectionKind::Devices => "devices",
            LibrarySelectionKind::Connections => "connections",
            LibrarySelectionKind::Simkl => "simkl",
            LibrarySelectionKind::Recovery => "recovery",
            LibrarySelectionKind::Runtime => "runtime",
            LibrarySelectionKind::Profiles => "profiles",
            LibrarySelectionKind::Downloads => "downloads",
        }
    }
}

impl LibraryWorker {
    /// `<prefix>_views:saved,<prefix>_promoted:selection/profiles,<prefix>_core_req:2061`, each part it has.
    fn tag(&self, prefix: &str, parts: &mut Vec<String>) {
        if let Some(views) = self.views {
            parts.push(format!("{prefix}_views:{}", views.as_str()));
        }
        if let Some(promoted) = self.promoted {
            let selection = self.selection.filter(|_| matches!(promoted, LibraryPromotion::Selection));
            parts.push(match selection {
                Some(kind) => format!("{prefix}_promoted:{}/{}", promoted.as_str(), kind.as_str()),
                None => format!("{prefix}_promoted:{}", promoted.as_str()),
            });
        }
        if let Some(ms) = self.core_requested_ms {
            parts.push(format!("{prefix}_core_req:{}", ms.min(MAX_MS)));
        }
    }
}

/// Script and Wasm files counted by where each came from (`loadReport.ts` `fileTally`): the HTTP cache, a service
/// worker, the network, or an engine that doesn't say. Counts only, never a file's name.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileSources {
    cache: u32,
    service_worker: u32,
    network: u32,
    unknown: u32,
}

/// What a page's request was for (`loadReport.ts` `netKindOf`). A closed set, so a report carries no path.
#[derive(Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum NetKind {
    Lib,
    Tmdb,
    Meta,
    Atlas,
    Image,
    Routes,
    Config,
    Health,
    Version,
    Capabilities,
    Plugins,
    Reel,
    Oauth,
    Grant,
    Assistant,
    Remux,
    Subtitles,
    Pair,
    Other,
}

/// What the browser's TMDB cache did with one question (`loadReport.ts` `TMDB_CACHE`). A closed set.
#[derive(Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum TmdbCacheOutcome {
    Fresh,
    Stale,
    BriefFresh,
    BriefStale,
    Missing,
    TooOld,
    ReadFailed,
    WriteFailed,
    NoStore,
}

impl TmdbCacheOutcome {
    fn as_str(&self) -> &'static str {
        match self {
            TmdbCacheOutcome::Fresh => "fresh",
            TmdbCacheOutcome::Stale => "stale",
            TmdbCacheOutcome::BriefFresh => "brief_fresh",
            TmdbCacheOutcome::BriefStale => "brief_stale",
            TmdbCacheOutcome::Missing => "missing",
            TmdbCacheOutcome::TooOld => "too_old",
            TmdbCacheOutcome::ReadFailed => "read_failed",
            TmdbCacheOutcome::WriteFailed => "write_failed",
            TmdbCacheOutcome::NoStore => "no_store",
        }
    }
}

impl NetKind {
    fn as_str(&self) -> &'static str {
        match self {
            NetKind::Lib => "lib",
            NetKind::Tmdb => "tmdb",
            NetKind::Meta => "meta",
            NetKind::Atlas => "atlas",
            NetKind::Image => "image",
            NetKind::Routes => "routes",
            NetKind::Config => "config",
            NetKind::Health => "health",
            NetKind::Version => "version",
            NetKind::Capabilities => "capabilities",
            NetKind::Plugins => "plugins",
            NetKind::Reel => "reel",
            NetKind::Oauth => "oauth",
            NetKind::Grant => "grant",
            NetKind::Assistant => "assistant",
            NetKind::Remux => "remux",
            NetKind::Subtitles => "subtitles",
            NetKind::Pair => "pair",
            NetKind::Other => "other",
        }
    }
}

impl LoadReport {
    fn tag(&self) -> String {
        let mut parts = vec![
            format!("route:{}", self.route.as_str()),
            format!("device:{}", self.device.as_str()),
            format!("engine:{}", self.engine.as_str()),
        ];
        if let Some(platform) = self.platform {
            parts.push(format!("platform:{}", platform.as_str()));
        }
        for (name, ms) in [
            ("boot", self.page_boot_ms),
            ("app", self.app_module_ms),
            ("app_eval", self.app_evaluated_ms),
            ("mounted", self.app_mounted_ms),
            ("w_started", self.worker_started_ms),
            ("w_script", self.worker_script_ms),
            ("session", self.session_worker_ms),
            ("core_compile", self.core_compile_start_ms),
            ("core_compiled", self.core_compiled_ms),
            ("w_core_req", self.worker_core_requested_ms),
            ("w_core", self.worker_core_ready_ms),
            ("worker", self.worker_ready_ms),
            ("capability", self.capability_ms),
            ("bootstrap", self.bootstrap_ms),
            ("w_log_req", self.worker_log_requested_ms),
            ("w_log", self.worker_log_opened_ms),
            ("directory", self.directory_ms),
            ("handover", self.handover_ms),
            ("billboard", self.billboard_detail_ms),
            ("shelves", self.shelves_ms),
            ("poster", self.poster_ms),
            ("episodes", self.episodes_ms),
            ("import_start", self.import_start_ms),
            ("import", self.import_ms),
            ("w_script_last", self.worker_script_last_ms),
            ("w_core_last", self.worker_core_ready_last_ms),
            ("worker_last", self.worker_ready_last_ms),
            ("w_log_last", self.worker_log_opened_last_ms),
        ] {
            if let Some(ms) = ms {
                parts.push(format!("{name}:{}", ms.min(MAX_MS)));
            }
        }
        parts.push(format!("workers:{}", self.workers.min(MAX_WORKERS)));
        for (prefix, worker) in
            [("hh", &self.library_workers.household), ("pf", &self.library_workers.profile)]
        {
            if let Some(worker) = worker {
                worker.tag(prefix, &mut parts);
            }
        }
        for (prefix, tally) in [("net", &self.net), ("wnet", &self.worker_net)] {
            for (kind, (count, ms)) in tally {
                parts.push(format!(
                    "{prefix}_{}:{}/{}ms",
                    kind.as_str(),
                    count.min(&MAX_REQUESTS),
                    ms.min(&MAX_NET_MS)
                ));
            }
        }
        for (prefix, files) in [("files", &self.files), ("wfiles", &self.worker_files)] {
            if let Some(f) = files {
                parts.push(format!(
                    "{prefix}:cache{}/net{}/sw{}/unknown{}",
                    f.cache.min(MAX_REQUESTS),
                    f.network.min(MAX_REQUESTS),
                    f.service_worker.min(MAX_REQUESTS),
                    f.unknown.min(MAX_REQUESTS)
                ));
            }
        }
        for (outcome, count) in &self.tmdb_cache {
            parts.push(format!("tmdb_{}:{}", outcome.as_str(), count.min(&MAX_REQUESTS)));
        }
        if let Some((count, ms, longest)) = self.long_tasks {
            parts.push(format!(
                "long:{}/{}ms/max{}ms",
                count.min(MAX_REQUESTS),
                ms.min(MAX_NET_MS),
                longest.min(MAX_MS)
            ));
        }
        for (phase, (count, ms, longest)) in &self.long_task_phases {
            parts.push(format!(
                "long_{}:{}/{}ms/max{}ms",
                phase.as_str(),
                count.min(&MAX_REQUESTS),
                ms.min(&MAX_NET_MS),
                longest.min(&MAX_MS)
            ));
        }
        for (stage, (count, ms, longest)) in &self.long_task_stages {
            parts.push(format!(
                "long_stage_{}:{}/{}ms/max{}ms",
                stage.as_str(),
                count.min(&MAX_REQUESTS),
                ms.min(&MAX_NET_MS),
                longest.min(&MAX_MS)
            ));
        }
        if let Some(memory) = &self.memory {
            parts.push(format!(
                "jsHeap:{}/{}/{}MB",
                memory.js_heap_used_mb.min(1_048_576),
                memory.js_heap_total_mb.min(1_048_576),
                memory.js_heap_limit_mb.min(1_048_576)
            ));
        }
        if self.hidden {
            parts.push("hidden:1".to_owned());
        }
        if let Some(entry) = &self.entry {
            parts.push(format!("entry:{}", entry.as_str()));
        }
        if let Some(release) = &self.release {
            parts.push(format!("release:{}", release.0));
        }
        parts.join(",")
    }
}

pub async fn handle_load(state: &Arc<AppState>, req: Request) -> Response {
    let report: LoadReport = match intake(state, req, LOAD_BUCKET).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    accepted(report.tag(), |resp, tag| {
        resp.extensions_mut().insert(LoadTag(tag));
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Native Apple performance (`POST /performance/event`): one bounded, identity-free event at meaningful journey
// boundaries. Browser loads retain their richer `/playback/load` report; the common platform and memory names let
// later audits compare them without confusing JS heap with native process memory.

const PERFORMANCE_BUCKET: &str = "performance";
const MAX_MEMORY_MB: u64 = 1_048_576;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PerformanceJourney {
    Launch,
    Navigation,
    Playback,
    Memory,
}
impl PerformanceJourney {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Navigation => "navigation",
            Self::Playback => "playback",
            Self::Memory => "memory",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PerformanceStage {
    AppInit,
    Shell,
    Content,
    Settled,
    FirstFrame,
    Ended,
    Background,
    Warning,
    /// Main-thread stalls while one screen was showing, sent as it was left.
    Stalls,
}
impl PerformanceStage {
    fn as_str(&self) -> &'static str {
        match self {
            Self::AppInit => "app_init",
            Self::Shell => "shell",
            Self::Content => "content",
            Self::Settled => "settled",
            Self::FirstFrame => "first_frame",
            Self::Ended => "ended",
            Self::Background => "background",
            Self::Warning => "warning",
            Self::Stalls => "stalls",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PerformanceRoute {
    Home,
    Movies,
    Series,
    Watchlist,
    Title,
    Search,
    Settings,
    Player,
    Other,
}
impl PerformanceRoute {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Movies => "movies",
            Self::Series => "series",
            Self::Watchlist => "watchlist",
            Self::Title => "title",
            Self::Search => "search",
            Self::Settings => "settings",
            Self::Player => "player",
            Self::Other => "other",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PerformanceOutcome {
    Clean,
    ThroughputLimited,
    ReconnectProne,
    Error,
    /// Left before a single frame with no failure on screen: the viewer gave up waiting.
    Abandoned,
}
impl PerformanceOutcome {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::ThroughputLimited => "throughput_limited",
            Self::ReconnectProne => "reconnect_prone",
            Self::Error => "error",
            Self::Abandoned => "abandoned",
        }
    }
}

/// Why a playback session ended on an error, from the player's own closed set.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PerformanceFailure {
    NoSource,
    SourceUnreachable,
    NothingQueued,
    ListExpired,
    RateLimited,
    ServiceRefused,
    EngineUnavailable,
    Other,
}
impl PerformanceFailure {
    fn as_str(&self) -> &'static str {
        match self {
            Self::NoSource => "no_source",
            Self::SourceUnreachable => "source_unreachable",
            Self::NothingQueued => "nothing_queued",
            Self::ListExpired => "list_expired",
            Self::RateLimited => "rate_limited",
            Self::ServiceRefused => "service_refused",
            Self::EngineUnavailable => "engine_unavailable",
            Self::Other => "other",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PerformanceDecode {
    Hardware,
    Software,
}
impl PerformanceDecode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Hardware => "hardware",
            Self::Software => "software",
        }
    }
}

/// What a playback event knows: the first frame's breakdown, or a session's health as it ends. Durations in
/// milliseconds.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PerformancePlayback {
    outcome: Option<PerformanceOutcome>,
    failure: Option<PerformanceFailure>,
    decode: Option<PerformanceDecode>,
    cached: Option<bool>,
    /// Sources opened, fallbacks included.
    attempts: Option<u32>,
    /// Waiting for the debrid to have the release.
    wait_ms: Option<u32>,
    /// The engine opening the source that played, to its first frame.
    open_ms: Option<u32>,
    underruns: Option<u32>,
    reconnects: Option<u32>,
    seconds: Option<u32>,
    /// Time spent with the buffer run dry.
    rebuffer_ms: Option<u32>,
    min_buffer_ms: Option<u32>,
    min_throughput_mbps: Option<u32>,
    dropped_frames: Option<u32>,
    max_drift_ms: Option<u32>,
    /// `[count, total milliseconds, longest milliseconds]`.
    seeks: Option<(u32, u32, u32)>,
}

impl PerformancePlayback {
    fn push_tags(&self, parts: &mut Vec<String>) {
        if let Some(outcome) = &self.outcome {
            parts.push(format!("outcome:{}", outcome.as_str()));
        }
        if let Some(failure) = &self.failure {
            parts.push(format!("failure:{}", failure.as_str()));
        }
        if let Some(decode) = &self.decode {
            parts.push(format!("decode:{}", decode.as_str()));
        }
        if let Some(cached) = self.cached {
            parts.push(format!("cached:{}", u8::from(cached)));
        }
        for (name, value, cap) in [
            ("attempts", self.attempts, 1_000),
            // A debrid fetch and a whole session's rebuffering can each run past `MAX_MS`.
            ("waitMs", self.wait_ms, MAX_NET_MS),
            ("openMs", self.open_ms, MAX_MS),
            ("underruns", self.underruns, 10_000),
            ("reconnects", self.reconnects, 10_000),
            ("seconds", self.seconds, MAX_SECS),
            ("rebufferMs", self.rebuffer_ms, MAX_NET_MS),
            ("minBufferMs", self.min_buffer_ms, MAX_MS),
            ("minMbps", self.min_throughput_mbps, 100_000),
            ("dropped", self.dropped_frames, 1_000_000),
            ("maxDriftMs", self.max_drift_ms, MAX_MS),
        ] {
            if let Some(value) = value {
                parts.push(format!("{name}:{}", value.min(cap)));
            }
        }
        if let Some(seeks) = self.seeks {
            parts.push(count_total_longest("seeks", seeks));
        }
    }
}

/// `name:count/totalms/maxlongestms`, each part capped: a stall or seek summary as the log line carries it.
fn count_total_longest(name: &str, (count, total, longest): (u32, u32, u32)) -> String {
    format!("{name}:{}/{}ms/max{}ms", count.min(MAX_REQUESTS), total.min(MAX_NET_MS), longest.min(MAX_MS))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeMemory {
    resident_mb: Option<u64>,
    footprint_mb: Option<u64>,
    peak_resident_mb: Option<u64>,
    available_mb: Option<u64>,
    warnings: u32,
}

/// How one screen drew while it showed, from the app's display-link frame monitor: frames delivered, frames
/// missed, the time late frames ran past one frame budget, the longest frame, and the time measured.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PerformanceFrames {
    delivered: u32,
    missed: u32,
    hitch_ms: u32,
    longest_ms: u32,
    visible_ms: u32,
}

/// About 46 hours of frames at 60 Hz.
const MAX_FRAMES: u32 = 10_000_000;

impl PerformanceFrames {
    fn push_tags(&self, parts: &mut Vec<String>) {
        let hitch_ms = self.hitch_ms.min(MAX_NET_MS);
        let visible_ms = self.visible_ms.min(MAX_NET_MS);
        parts.push(format!("frames:{}", self.delivered.min(MAX_FRAMES)));
        parts.push(format!("missedFrames:{}", self.missed.min(MAX_FRAMES)));
        parts.push(format!("hitchMs:{hitch_ms}"));
        parts.push(format!("longestFrameMs:{}", self.longest_ms.min(MAX_MS)));
        parts.push(format!("visibleMs:{visible_ms}"));
        // Apple's hitch ratio: hitch milliseconds per second on screen.
        if visible_ms > 0 {
            let ratio = f64::from(hitch_ms) * 1000.0 / f64::from(visible_ms);
            parts.push(format!("hitchRatio:{ratio:.1}"));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PerformanceReport {
    platform: ClientPlatform,
    release: Option<Release>,
    journey: PerformanceJourney,
    stage: PerformanceStage,
    route: Option<PerformanceRoute>,
    duration_ms: Option<u32>,
    /// `[count, total milliseconds, longest milliseconds]` on a `stalls` event: the screen in `route` while they
    /// happened.
    stalls: Option<(u32, u32, u32)>,
    /// On a `stalls` event: how the screen in `route` drew.
    frames: Option<PerformanceFrames>,
    memory: NativeMemory,
    playback: Option<PerformancePlayback>,
}

impl PerformanceReport {
    fn tag(&self) -> String {
        let mut parts = vec![
            format!("platform:{}", self.platform.as_str()),
            format!("journey:{}", self.journey.as_str()),
            format!("stage:{}", self.stage.as_str()),
        ];
        if let Some(route) = &self.route {
            parts.push(format!("route:{}", route.as_str()));
        }
        if let Some(ms) = self.duration_ms {
            parts.push(format!("duration:{}", ms.min(MAX_MS)));
        }
        if let Some(stalls) = self.stalls {
            parts.push(count_total_longest("stalls", stalls));
        }
        if let Some(frames) = &self.frames {
            frames.push_tags(&mut parts);
        }
        let memory = &self.memory;
        for (name, value) in [
            ("rss", memory.resident_mb),
            ("footprint", memory.footprint_mb),
            ("peakRss", memory.peak_resident_mb),
            ("available", memory.available_mb),
        ] {
            if let Some(value) = value {
                parts.push(format!("{name}:{}MB", value.min(MAX_MEMORY_MB)));
            }
        }
        parts.push(format!("memoryWarnings:{}", memory.warnings.min(10_000)));
        if let Some(playback) = &self.playback {
            playback.push_tags(&mut parts);
        }
        if let Some(release) = &self.release {
            parts.push(format!("release:{}", release.0));
        }
        parts.join(",")
    }
}

pub async fn handle_performance(state: &Arc<AppState>, req: Request) -> Response {
    let report: PerformanceReport = match intake(state, req, PERFORMANCE_BUCKET).await {
        Ok(report) => report,
        Err(response) => return *response,
    };
    accepted(report.tag(), |response, tag| {
        response.extensions_mut().insert(PerformanceTag(tag));
    })
}

// ---------------------------------------------------------------------------------------------------------------
// A playback route decision (`POST /playback/route`), sent as it is made so even a request that never opens a
// session leaves a durable, privacy-safe trail.

const PLAYBACK_ROUTE_BUCKET: &str = "playback-route";

macro_rules! closed_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum $name {
            $($variant,)+
        }
        impl $name {
            fn as_str(&self) -> &'static str {
                match self { $(Self::$variant => $value,)+ }
            }
        }
    };
}

closed_enum!(PlaybackRouteEvent {
    Request => "request",
    Selected => "selected",
    Failed => "failed",
    Recovery => "recovery",
    ViewerSelection => "viewer_selection",
});

closed_enum!(PlaybackRouteSource {
    Managed => "managed",
    Torbox => "torbox",
    DenRemux => "den_remux",
    Unavailable => "unavailable",
});
closed_enum!(PlaybackRouteReason {
    Ordinary => "ordinary",
    Refresh => "refresh",
    Fallback => "fallback",
    Direct => "direct",
});
closed_enum!(PlaybackRouteContext {
    NoSession => "no_session",
    ActiveSession => "active_session",
});
closed_enum!(PlaybackRouteStage {
    Startup => "startup",
    MidPlayback => "mid_playback",
});
closed_enum!(PlaybackRouteAttempt {
    Initial => "initial",
    Refreshed => "refreshed",
});
closed_enum!(PlaybackSubtitleConstraint {
    Allowed => "allowed",
    PlaylistRequired => "playlist_required",
    DenSubtitlesDisabled => "den_subtitles_disabled",
});
closed_enum!(PlaybackEmbeddedSubtitles {
    None => "none",
    Available => "available",
});
closed_enum!(PlaybackRouteFailure {
    Login => "login",
    None => "none",
    Busy => "busy",
    Starting => "starting",
    Transcode => "transcode",
    Unreachable => "unreachable",
    Request => "request",
    SourceUnavailable => "source_unavailable",
    TimedOut => "timed_out",
    TemporarilyUnavailable => "temporarily_unavailable",
    Protocol => "protocol",
    Ended => "ended",
    Public => "public",
    Ipv6 => "ipv6",
    Cast => "cast",
    NoCopy => "no_copy",
    NoFit => "no_fit",
});
closed_enum!(PlaybackRouteCause {
    ManagedPrepareTimeout => "managed_prepare_timeout",
    TorboxAuthenticationFailed => "torbox_authentication_failed",
    TorboxItemNotFound => "torbox_item_not_found",
    TorboxMalformedResponse => "torbox_malformed_response",
    TorboxManagedStreamingUnavailableForPlan => "torbox_managed_streaming_unavailable_for_plan",
    TorboxPlaylistUnavailable => "torbox_playlist_unavailable",
    TorboxRateLimited => "torbox_rate_limited",
    TorboxRefused => "torbox_refused",
    TorboxUnavailable => "torbox_unavailable",
    TorboxUnreachable => "torbox_unreachable",
    TorboxUnsafeStreamUrl => "torbox_unsafe_stream_url",
    DebridDown => "debrid_down",
    DebridSlow => "debrid_slow",
});

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlaybackRouteReport {
    platform: Option<ClientPlatform>,
    event: PlaybackRouteEvent,
    requested_source: Option<PlaybackRouteSource>,
    source: Option<PlaybackRouteSource>,
    from: Option<PlaybackRouteSource>,
    to: Option<PlaybackRouteSource>,
    reason: Option<PlaybackRouteReason>,
    context: Option<PlaybackRouteContext>,
    stage: Option<PlaybackRouteStage>,
    attempt: Option<PlaybackRouteAttempt>,
    failure: Option<PlaybackRouteFailure>,
    cause: Option<PlaybackRouteCause>,
    subtitle_constraint: Option<PlaybackSubtitleConstraint>,
    replacement: Option<bool>,
    embedded_subtitles: Option<PlaybackEmbeddedSubtitles>,
}

impl PlaybackRouteReport {
    fn tag(&self) -> String {
        let mut parts = vec![format!("event:{}", self.event.as_str())];
        if let Some(platform) = self.platform {
            parts.push(format!("platform:{}", platform.as_str()));
        }
        macro_rules! add {
            ($field:ident, $name:literal) => {
                if let Some(value) = &self.$field {
                    parts.push(format!(concat!($name, ":{}"), value.as_str()));
                }
            };
        }
        add!(requested_source, "requested");
        add!(source, "source");
        add!(from, "from");
        add!(to, "to");
        add!(reason, "reason");
        add!(context, "context");
        add!(stage, "stage");
        add!(attempt, "attempt");
        add!(failure, "failure");
        add!(cause, "cause");
        add!(subtitle_constraint, "subtitles");
        if let Some(replacement) = self.replacement {
            parts.push(format!("replacement:{}", u8::from(replacement)));
        }
        add!(embedded_subtitles, "embeddedSubtitles");
        parts.join(",")
    }
}

pub async fn handle_playback_route(state: &Arc<AppState>, req: Request) -> Response {
    let report: PlaybackRouteReport = match intake(state, req, PLAYBACK_ROUTE_BUCKET).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    accepted(report.tag(), |resp, tag| {
        resp.extensions_mut().insert(PlaybackRouteTag(tag));
    })
}

// A playback session's outcome (`POST /playback/outcome`), sent once as the session ends — on its natural end,
// the viewer closing the player, a failure, or the tab hiding/unloading (`navigator.sendBeacon`, so the report
// outruns the unload it is reporting on).

const PLAYBACK_OUTCOME_BUCKET: &str = "playback-outcome";

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Engine {
    Native,
    #[serde(rename = "hls.js")]
    HlsJs,
    Progressive,
    /// Played inside the hidden cast-page frame (a public-address session), not the page's own video.
    #[serde(rename = "cast_page")]
    CastPage,
}

impl Engine {
    fn as_str(&self) -> &'static str {
        match self {
            Engine::Native => "native",
            Engine::HlsJs => "hls.js",
            Engine::Progressive => "progressive",
            Engine::CastPage => "cast_page",
        }
    }
}

/// What noticed the failure a visit ended on (`web/src/lib/diagnosticsReport.ts`'s `FailSource`).
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum FailSource {
    MediaElement,
    HlsFatal,
    Stuck,
    CastPageError,
    CastPageSilent,
}

impl FailSource {
    fn as_str(&self) -> &'static str {
        match self {
            FailSource::MediaElement => "media_element",
            FailSource::HlsFatal => "hls_fatal",
            FailSource::Stuck => "stuck",
            FailSource::CastPageError => "cast_page_error",
            FailSource::CastPageSilent => "cast_page_silent",
        }
    }
}

/// Whether the session came from Remux or as a provider's own HLS (TorBox).
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Delivery {
    Remux,
    Direct,
}

impl Delivery {
    fn as_str(&self) -> &'static str {
        match self {
            Delivery::Remux => "remux",
            Delivery::Direct => "direct",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum NetworkRoute {
    Lan,
    Public,
    Tailnet,
}

impl NetworkRoute {
    fn as_str(&self) -> &'static str {
        match self {
            NetworkRoute::Lan => "lan",
            NetworkRoute::Public => "public",
            NetworkRoute::Tailnet => "tailnet",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum EndReason {
    Finished,
    UserExit,
    Error,
}

impl EndReason {
    fn as_str(&self) -> &'static str {
        match self {
            EndReason::Finished => "finished",
            EndReason::UserExit => "user_exit",
            EndReason::Error => "error",
        }
    }
}

/// hls.js's own `ErrorTypes`, exactly as it names them.
#[derive(Deserialize)]
enum HlsFatalType {
    #[serde(rename = "networkError")]
    Network,
    #[serde(rename = "mediaError")]
    Media,
    #[serde(rename = "muxError")]
    Mux,
    #[serde(rename = "otherError")]
    Other,
}

impl HlsFatalType {
    fn as_str(&self) -> &'static str {
        match self {
            HlsFatalType::Network => "networkError",
            HlsFatalType::Media => "mediaError",
            HlsFatalType::Mux => "muxError",
            HlsFatalType::Other => "otherError",
        }
    }
}

/// The hls.js fatal `details` that matter for telling a stall from a dead link; anything else hls.js names
/// (`web/src/lib/diagnosticsReport.ts`'s `hlsFatalDetail`) is sent as `other` rather than as its own free text.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum HlsFatalDetail {
    BufferStalledError,
    BufferSeekOverHole,
    BufferNudgeOnStall,
    FragLoadError,
    FragLoadTimeOut,
    ManifestLoadError,
    ManifestLoadTimeOut,
    LevelLoadError,
    KeyLoadError,
    Other,
}

impl HlsFatalDetail {
    fn as_str(&self) -> &'static str {
        match self {
            HlsFatalDetail::BufferStalledError => "bufferStalledError",
            HlsFatalDetail::BufferSeekOverHole => "bufferSeekOverHole",
            HlsFatalDetail::BufferNudgeOnStall => "bufferNudgeOnStall",
            HlsFatalDetail::FragLoadError => "fragLoadError",
            HlsFatalDetail::FragLoadTimeOut => "fragLoadTimeOut",
            HlsFatalDetail::ManifestLoadError => "manifestLoadError",
            HlsFatalDetail::ManifestLoadTimeOut => "manifestLoadTimeOut",
            HlsFatalDetail::LevelLoadError => "levelLoadError",
            HlsFatalDetail::KeyLoadError => "keyLoadError",
            HlsFatalDetail::Other => "other",
        }
    }
}

/// Why, if at all, a visit moved to another release before it ended: the decoder refusing what played, the link
/// not carrying it, or the viewer's own pick from the release list — never the releases themselves
/// (`web/src/lib/diagnosticsReport.ts`'s `SwitchReason`).
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SwitchReason {
    Decode,
    Delivery,
    User,
}

impl SwitchReason {
    fn as_str(&self) -> &'static str {
        match self {
            SwitchReason::Decode => "decode",
            SwitchReason::Delivery => "delivery",
            SwitchReason::User => "user",
        }
    }
}

/// Where the chosen subtitle came from: the release's own rendition, or den-subtitles' own search — never which
/// file, which is not this report's to carry. `Unknown`: den-remux decides per language whether its own track
/// beats a den-subtitles candidate it was offered, and never says which won, so a session that offered one
/// cannot be told apart from a session that used it — the client sends `release` only when no den-subtitles
/// candidate was offered this session at all (the only source then possible), `unknown` otherwise.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubtitleSource {
    Release,
    DenSubtitles,
    Unknown,
}

impl SubtitleSource {
    fn as_str(&self) -> &'static str {
        match self {
            SubtitleSource::Release => "release",
            SubtitleSource::DenSubtitles => "den_subtitles",
            SubtitleSource::Unknown => "unknown",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackOutcomeReport {
    platform: Option<ClientPlatform>,
    engine: Engine,
    route: NetworkRoute,
    stall_count: u32,
    stalled_ms: u32,
    end_reason: EndReason,
    error_code: Option<u8>,
    hls_fatal_type: Option<HlsFatalType>,
    hls_fatal_detail: Option<HlsFatalDetail>,
    seconds_played: u32,
    /// What was playing — the subtitle's language and source among them (`LOG_IDENTITY`).
    #[serde(flatten)]
    identity: Identity,
    #[serde(default)]
    subtitle_switched: bool,
    #[serde(default)]
    subtitle_turned_off: bool,
    #[serde(default)]
    subtitle_load_failed: bool,
    /// How many times this visit moved to another release, by any `SwitchReason`; absent where it never did.
    switch_count: Option<u32>,
    /// The last of those switches' own reason; absent alongside `switch_count` when there was none.
    last_switch_reason: Option<SwitchReason>,
    fail_source: Option<FailSource>,
    cast_fail_reason: Option<CastFailReason>,
    delivery: Option<Delivery>,
    #[serde(default)]
    lan_offered: bool,
    /// `[count, total milliseconds, longest milliseconds]` of seeks; absent with none.
    seeks: Option<(u32, u32, u32)>,
    /// Frames the browser dropped, where it counts them.
    dropped_frames: Option<u32>,
}

impl PlaybackOutcomeReport {
    fn tag(&self, log_identity: bool) -> String {
        let mut parts = vec![
            format!("engine:{}", self.engine.as_str()),
            format!("route:{}", self.route.as_str()),
            format!("stalls:{}", self.stall_count.min(1000)),
            format!("stalledMs:{}", self.stalled_ms.min(MAX_MS)),
            format!("end:{}", self.end_reason.as_str()),
            format!("secondsPlayed:{}", self.seconds_played.min(MAX_SECS)),
        ];
        if let Some(platform) = self.platform {
            parts.push(format!("platform:{}", platform.as_str()));
        }
        if let Some(v) = self.error_code {
            parts.push(format!("errorCode:{}", v.min(4)));
        }
        if let Some(t) = &self.hls_fatal_type {
            parts.push(format!("hlsType:{}", t.as_str()));
        }
        if let Some(d) = &self.hls_fatal_detail {
            parts.push(format!("hlsDetail:{}", d.as_str()));
        }
        parts.extend(self.identity.parts(log_identity));
        if self.subtitle_switched {
            parts.push("subSwitched:1".to_owned());
        }
        if self.subtitle_turned_off {
            parts.push("subOff:1".to_owned());
        }
        if self.subtitle_load_failed {
            parts.push("subLoadFailed:1".to_owned());
        }
        if let Some(count) = self.switch_count.filter(|c| *c > 0) {
            parts.push(format!("switches:{}", count.min(1000)));
        }
        if let Some(reason) = &self.last_switch_reason {
            parts.push(format!("switchReason:{}", reason.as_str()));
        }
        if let Some(source) = &self.fail_source {
            parts.push(format!("failSource:{}", source.as_str()));
        }
        if let Some(reason) = &self.cast_fail_reason {
            parts.push(format!("castFail:{}", reason.as_str()));
        }
        if let Some(delivery) = &self.delivery {
            parts.push(format!("delivery:{}", delivery.as_str()));
        }
        if self.lan_offered {
            parts.push("lanOffered:1".to_owned());
        }
        if let Some(seeks) = self.seeks {
            parts.push(count_total_longest("seeks", seeks));
        }
        if let Some(dropped) = self.dropped_frames {
            parts.push(format!("dropped:{}", dropped.min(1_000_000)));
        }
        parts.join(",")
    }
}

pub async fn handle_playback_outcome(state: &Arc<AppState>, req: Request) -> Response {
    let report: PlaybackOutcomeReport = match intake(state, req, PLAYBACK_OUTCOME_BUCKET).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    accepted(report.tag(state.log_identity), |resp, tag| {
        resp.extensions_mut().insert(PlaybackOutcomeTag(tag));
    })
}

// ---------------------------------------------------------------------------------------------------------------
// A cast or AirPlay attempt (`POST /playback/cast`): the funnel it reached, how it failed, and how long the
// session lasted, sent once as the attempt concludes.

const CAST_BUCKET: &str = "cast";

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CastKind {
    Chromecast,
    Airplay,
}

impl CastKind {
    fn as_str(&self) -> &'static str {
        match self {
            CastKind::Chromecast => "chromecast",
            CastKind::Airplay => "airplay",
        }
    }
}

/// The furthest stage this attempt reached: the Cast/AirPlay control was offered, pressing it was attempted, or a
/// session actually started playing.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CastStage {
    Offered,
    Attempted,
    Started,
}

impl CastStage {
    fn as_str(&self) -> &'static str {
        match self {
            CastStage::Offered => "offered",
            CastStage::Attempted => "attempted",
            CastStage::Started => "started",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum CastFailReason {
    ReceiverNotLoaded,
    MediaError,
    LanUnreachable,
    SessionError,
    /// The cast page refused the media URLs it was handed, before fetching anything.
    InvalidMedia,
    Other,
}

impl CastFailReason {
    fn as_str(&self) -> &'static str {
        match self {
            CastFailReason::ReceiverNotLoaded => "receiver_not_loaded",
            CastFailReason::MediaError => "media_error",
            CastFailReason::LanUnreachable => "lan_unreachable",
            CastFailReason::SessionError => "session_error",
            CastFailReason::InvalidMedia => "invalid_media",
            CastFailReason::Other => "other",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CastReport {
    platform: Option<ClientPlatform>,
    kind: CastKind,
    reached: CastStage,
    #[serde(default)]
    failed: bool,
    fail_reason: Option<CastFailReason>,
    session_secs: Option<u32>,
    /// What was being cast (`LOG_IDENTITY`).
    #[serde(flatten)]
    identity: Identity,
}

impl CastReport {
    fn tag(&self, log_identity: bool) -> String {
        let mut parts =
            vec![format!("kind:{}", self.kind.as_str()), format!("reached:{}", self.reached.as_str())];
        if let Some(platform) = self.platform {
            parts.push(format!("platform:{}", platform.as_str()));
        }
        if self.failed {
            parts.push("failed:1".to_owned());
        }
        if let Some(r) = &self.fail_reason {
            parts.push(format!("failReason:{}", r.as_str()));
        }
        if let Some(s) = self.session_secs {
            parts.push(format!("sessionSecs:{}", s.min(MAX_SECS)));
        }
        parts.extend(self.identity.parts(log_identity));
        parts.join(",")
    }
}

pub async fn handle_cast(state: &Arc<AppState>, req: Request) -> Response {
    let report: CastReport = match intake(state, req, CAST_BUCKET).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    accepted(report.tag(state.log_identity), |resp, tag| {
        resp.extensions_mut().insert(CastTag(tag));
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_error_tag_names_every_field() {
        let report: PageErrorReport = serde_json::from_value(serde_json::json!({
            "kind": "chunk_load", "module": "player", "release": "deadbeef", "route": "title",
        }))
        .unwrap();
        assert_eq!(report.tag(), "kind:chunk_load,module:player,release:deadbeef,route:title");
    }

    #[test]
    fn page_error_carries_the_thrown_error_s_real_kind_and_the_chunk_it_named() {
        let report: PageErrorReport = serde_json::from_value(serde_json::json!({
            "kind": "uncaught", "module": "other", "errorKind": "TypeError", "chunk": "Library",
            "route": "home",
        }))
        .unwrap();
        assert_eq!(report.tag(), "kind:uncaught,module:other,errorKind:TypeError,chunk:Library,route:home");
    }

    #[test]
    fn a_network_error_is_told_apart_from_any_other_dom_exception() {
        let report: PageErrorReport = serde_json::from_value(serde_json::json!({
            "kind": "uncaught", "module": "other", "errorKind": "NetworkError", "route": "home",
        }))
        .unwrap();
        assert!(report.tag().contains("errorKind:NetworkError"));
    }

    #[test]
    fn a_chunk_name_outside_the_shape_does_not_parse() {
        let bad = serde_json::json!({
            "kind": "uncaught", "module": "other", "chunk": "../evil", "route": "home",
        });
        assert!(serde_json::from_value::<PageErrorReport>(bad).is_err());
    }

    #[test]
    fn a_release_outside_the_allowed_charset_does_not_parse() {
        let bad = serde_json::json!({
            "kind": "uncaught", "module": "app", "release": "deadbeef (patched)", "route": "home",
        });
        assert!(serde_json::from_value::<PageErrorReport>(bad).is_err());
    }

    #[test]
    fn a_report_with_no_release_yet_still_parses_and_leaves_it_out_of_the_tag() {
        let report: PageErrorReport = serde_json::from_value(serde_json::json!({
            "kind": "render_stall", "module": "app", "route": "home",
        }))
        .unwrap();
        assert_eq!(report.tag(), "kind:render_stall,module:app,route:home");
    }

    #[test]
    fn a_body_carrying_a_title_or_url_field_does_not_change_the_tag() {
        // Unknown fields are ignored by serde's default behaviour, not merged into the tag: there is no path
        // from an unexpected field to a log line.
        let report: PageErrorReport = serde_json::from_value(serde_json::json!({
            "kind": "uncaught", "module": "other", "release": "deadbeef", "route": "other",
            "title": "the-shawshank-redemption", "url": "https://example.invalid/evil",
        }))
        .unwrap();
        assert_eq!(report.tag(), "kind:uncaught,module:other,release:deadbeef,route:other");
    }

    #[test]
    fn an_unknown_enum_value_does_not_parse() {
        let bad = serde_json::json!({
            "kind": "nonsense", "module": "app", "release": "deadbeef", "route": "home",
        });
        assert!(serde_json::from_value::<PageErrorReport>(bad).is_err());
    }

    #[test]
    fn a_load_report_names_each_milestone_it_reached_and_nothing_else() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "series", "device": "phone", "engine": "webkit",
            "appModuleMs": 40, "workerReadyMs": 300, "handoverMs": 420, "shelvesMs": 9800,
            "workers": 3, "release": "deadbeef",
            "title": "the-shawshank-redemption", "url": "https://example.invalid/?q=1",
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "route:series,device:phone,engine:webkit,app:40,worker:300,handover:420,shelves:9800,workers:3,\
             release:deadbeef"
        );
    }

    #[test]
    fn a_load_report_separates_client_platform_and_browser_heap() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "platform": "tizen", "workers": 1,
            "memory": { "jsHeapUsedMb": 80, "jsHeapTotalMb": 120, "jsHeapLimitMb": 512 }
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "route:home,device:tv,engine:blink,platform:tizen,workers:1,jsHeap:80/120/512MB"
        );
    }

    #[test]
    fn a_native_performance_event_is_typed_bounded_and_identity_free() {
        // The event `PerformanceAuditTests.eventShape` (den's DenKit) encodes, field for field.
        let report: PerformanceReport = serde_json::from_value(serde_json::json!({
            "platform": "apple_tv", "release": "1.2.3+45", "journey": "playback", "stage": "ended",
            "route": "player", "durationMs": 9500,
            "memory": { "residentMb": 210, "footprintMb": 260, "peakResidentMb": 300,
                "availableMb": 420, "warnings": 1 },
            "playback": { "outcome": "error", "failure": "no_source", "decode": "software", "cached": false,
                "attempts": 3, "waitMs": 4000, "openMs": 1200, "rebufferMs": 800, "seeks": [2, 900, 600] }
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "platform:apple_tv,journey:playback,stage:ended,route:player,duration:9500,rss:210MB,footprint:260MB,\
             peakRss:300MB,available:420MB,memoryWarnings:1,outcome:error,failure:no_source,decode:software,\
             cached:0,attempts:3,waitMs:4000,openMs:1200,rebufferMs:800,seeks:2/900ms/max600ms,release:1.2.3+45"
        );
        for refused in [
            serde_json::json!({ "platform": "apple_tv", "journey": "launch", "stage": "settled",
                "memory": { "warnings": 0 }, "title": "must not parse" }),
            serde_json::json!({ "platform": "apple_tv", "journey": "playback", "stage": "ended",
                "memory": { "warnings": 0 }, "playback": { "url": "must not parse" } }),
        ] {
            assert!(serde_json::from_value::<PerformanceReport>(refused).is_err());
        }
    }

    #[test]
    fn a_native_stalls_event_names_the_screen_they_happened_on() {
        let report: PerformanceReport = serde_json::from_value(serde_json::json!({
            "platform": "apple_tv", "journey": "navigation", "stage": "stalls", "route": "home",
            "stalls": [2, 420, 300], "memory": { "warnings": 0 }
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "platform:apple_tv,journey:navigation,stage:stalls,route:home,stalls:2/420ms/max300ms,memoryWarnings:0"
        );
    }

    #[test]
    fn a_native_stalls_event_carries_how_the_screen_drew_bounded() {
        // The `frames` object `PerformanceAuditTests.framesWireShape` (den's DenKit) encodes, field for field.
        let report: PerformanceReport = serde_json::from_value(serde_json::json!({
            "platform": "apple_tv", "journey": "navigation", "stage": "stalls", "route": "home",
            "frames": { "delivered": 600, "missed": 3, "hitchMs": 50, "longestMs": 67, "visibleMs": 10000 },
            "memory": { "warnings": 0 }
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "platform:apple_tv,journey:navigation,stage:stalls,route:home,frames:600,missedFrames:3,hitchMs:50,\
             longestFrameMs:67,visibleMs:10000,hitchRatio:5.0,memoryWarnings:0"
        );
        let huge: PerformanceReport = serde_json::from_value(serde_json::json!({
            "platform": "apple_tv", "journey": "navigation", "stage": "stalls", "route": "title",
            "frames": { "delivered": u32::MAX, "missed": u32::MAX, "hitchMs": u32::MAX, "longestMs": u32::MAX,
                "visibleMs": 0 },
            "memory": { "warnings": 0 }
        }))
        .unwrap();
        assert_eq!(
            huge.tag(),
            "platform:apple_tv,journey:navigation,stage:stalls,route:title,frames:10000000,missedFrames:10000000,\
             hitchMs:36000000,longestFrameMs:600000,visibleMs:0,memoryWarnings:0",
            "every count is capped, and no ratio without a denominator"
        );
        let unknown = serde_json::from_value::<PerformanceReport>(serde_json::json!({
            "platform": "apple_tv", "journey": "navigation", "stage": "stalls",
            "frames": { "delivered": 1, "missed": 0, "hitchMs": 0, "longestMs": 17, "visibleMs": 17, "screen": "x" },
            "memory": { "warnings": 0 }
        }));
        assert!(unknown.is_err(), "the frames object is closed like the rest of the event");
    }

    #[test]
    fn a_load_report_carries_the_first_import_and_the_page_requests_by_kind() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "importStartMs": 900, "importMs": 118_000,
            "posterMs": 125_000, "workers": 2,
            "net": { "tmdb": [40, 12_000], "lib": [3, 900], "image": [24, 30_000] },
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "route:home,device:tv,engine:blink,poster:125000,import_start:900,import:118000,workers:2,\
             net_lib:3/900ms,net_tmdb:40/12000ms,net_image:24/30000ms"
        );
        let unknown = serde_json::from_value::<LoadReport>(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "workers": 1, "net": { "/tmdb/3/movie/550": [1, 1] },
        }));
        assert!(unknown.is_err(), "a request's path never reaches the log");
    }

    #[test]
    fn a_load_report_names_the_startup_endpoints_a_load_waited_on() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "workers": 2,
            "net": { "routes": [1, 900], "health": [3, 2_400], "config": [1, 120], "plugins": [2, 70], "other": [1, 5] },
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "route:home,device:tv,engine:blink,workers:2,\
             net_routes:1/900ms,net_config:1/120ms,net_health:3/2400ms,net_plugins:2/70ms,net_other:1/5ms"
        );
    }

    #[test]
    fn a_load_report_carries_the_startup_chain_the_workers_requests_and_the_long_tasks() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink",
            "pageBootMs": 120, "appModuleMs": 130, "appEvaluatedMs": 900, "appMountedMs": 1_100,
            "workerStartedMs": 140, "workerScriptMs": 1_600, "sessionWorkerMs": 1_620,
            "coreCompileStartMs": 1_650, "coreCompiledMs": 2_100,
            "workerCoreRequestedMs": 1_640, "workerCoreReadyMs": 2_300, "workerReadyMs": 2_400,
            "capabilityMs": 3_000, "bootstrapMs": 3_100, "workerLogRequestedMs": 3_200, "workerLogOpenedMs": 4_700,
            "directoryMs": 5_000, "handoverMs": 5_300, "workers": 2,
            "net": { "atlas": [1, 86] }, "workerNet": { "lib": [3, 900], "meta": [5, 600] },
            "longTasks": [12, 3_400, 900],
            "longTaskPhases": {
                "bootstrap": [2, 900, 700], "app_import": [1, 300, 300],
                "home_shelves": [2, 480, 300], "other": [7, 1_720, 900]
            },
            "longTaskStages": {
                "pre_app": [1, 100, 100], "app_import": [2, 600, 400],
                "before_shelves": [9, 2_700, 900]
            },
            "workerScriptLastMs": 2_700, "workerCoreReadyLastMs": 3_900, "workerReadyLastMs": 4_000,
            "workerLogOpenedLastMs": 5_200,
            "tmdbCache": { "missing": 132, "fresh": 3, "write_failed": 132 },
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "route:home,device:tv,engine:blink,boot:120,app:130,app_eval:900,mounted:1100,w_started:140,\
             w_script:1600,session:1620,core_compile:1650,core_compiled:2100,w_core_req:1640,w_core:2300,worker:2400,\
             capability:3000,bootstrap:3100,w_log_req:3200,w_log:4700,directory:5000,handover:5300,\
             w_script_last:2700,w_core_last:3900,worker_last:4000,w_log_last:5200,workers:2,\
             net_atlas:1/86ms,wnet_lib:3/900ms,wnet_meta:5/600ms,tmdb_fresh:3,tmdb_missing:132,\
             tmdb_write_failed:132,long:12/3400ms/max900ms,long_bootstrap:2/900ms/max700ms,\
             long_app_import:1/300ms/max300ms,long_home_shelves:2/480ms/max300ms,long_other:7/1720ms/max900ms,\
             long_stage_pre_app:1/100ms/max100ms,long_stage_app_import:2/600ms/max400ms,\
             long_stage_before_shelves:9/2700ms/max900ms"
        );
    }

    #[test]
    fn a_load_report_says_where_the_page_and_worker_files_came_from() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "workers": 1,
            "files": { "cache": 14, "serviceWorker": 0, "network": 2, "unknown": 0 },
            "workerFiles": { "cache": 1, "network": 3, "unknown": 2, "names": ["/assets/x.js"] },
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "route:home,device:tv,engine:blink,workers:1,\
             files:cache14/net2/sw0/unknown0,wfiles:cache1/net3/sw0/unknown2"
        );
        let capped: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "workers": 1,
            "files": { "cache": u32::MAX, "serviceWorker": 0, "network": 0, "unknown": 0 },
        }))
        .unwrap();
        assert!(capped.tag().ends_with(&format!("files:cache{MAX_REQUESTS}/net0/sw0/unknown0")));
    }

    #[test]
    fn a_load_report_names_a_tv() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "billboardDetailMs": 7113, "workers": 2,
        }))
        .unwrap();
        assert_eq!(report.tag(), "route:home,device:tv,engine:blink,billboard:7113,workers:2");
    }

    #[test]
    fn a_load_report_says_what_each_library_worker_opened_from_and_why_it_asked_for_den_core() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "workers": 2,
            "libraryWorkers": {
                "household": { "views": "saved", "promoted": "selection", "selection": "downloads", "coreRequestedMs": 2061 },
                "profile": { "views": "facts", "promoted": "layout", "selection": "continue", "coreRequestedMs": u32::MAX },
            },
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            format!(
                "route:home,device:tv,engine:blink,workers:2,hh_views:saved,hh_promoted:selection/downloads,\
                 hh_core_req:2061,pf_views:facts,pf_promoted:layout,pf_core_req:{MAX_MS}"
            )
        );
        let saved_only: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "tv", "engine": "blink", "workers": 2,
            "libraryWorkers": { "profile": { "views": "saved" } },
        }))
        .unwrap();
        assert_eq!(saved_only.tag(), "route:home,device:tv,engine:blink,workers:2,pf_views:saved");
        for worker in [
            serde_json::json!({ "views": "/lib/abc" }),
            serde_json::json!({ "promoted": "selection:profiles" }),
            serde_json::json!({ "promoted": "selection", "selection": "title:550" }),
        ] {
            let unknown = serde_json::json!({
                "route": "home", "device": "tv", "engine": "blink", "workers": 2,
                "libraryWorkers": { "household": worker },
            });
            assert!(serde_json::from_value::<LoadReport>(unknown).is_err());
        }
    }

    #[test]
    fn a_load_report_caps_what_it_claims_and_says_it_started_hidden() {
        let report: LoadReport = serde_json::from_value(serde_json::json!({
            "route": "home", "device": "desktop", "engine": "blink",
            "appModuleMs": u32::MAX, "workers": 9999, "hidden": true,
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            format!("route:home,device:desktop,engine:blink,app:{MAX_MS},workers:{MAX_WORKERS},hidden:1")
        );
        let unknown = serde_json::json!({
            "route": "/movie/550", "device": "phone", "engine": "webkit", "workers": 1,
        });
        assert!(serde_json::from_value::<LoadReport>(unknown).is_err());
    }

    #[test]
    fn a_load_report_says_how_the_page_was_entered() {
        for entry in ["navigate", "reload", "back_forward", "swap"] {
            let report: LoadReport = serde_json::from_value(serde_json::json!({
                "route": "title", "device": "phone", "engine": "webkit", "workers": 2, "entry": entry,
            }))
            .unwrap();
            assert_eq!(
                report.tag(),
                format!("route:title,device:phone,engine:webkit,workers:2,entry:{entry}")
            );
        }
        let unknown = serde_json::json!({
            "route": "title", "device": "phone", "engine": "webkit", "workers": 2, "entry": "https://x/",
        });
        assert!(serde_json::from_value::<LoadReport>(unknown).is_err());
    }

    #[test]
    fn a_refused_report_names_the_one_optional_field_it_failed_on_but_never_its_value() {
        let bad_chunk = serde_json::json!({
            "kind": "uncaught", "module": "other", "chunk": "../evil", "route": "home",
        });
        assert_eq!(refused_field::<PageErrorReport>(&bad_chunk).as_deref(), Some("chunk"));
        // A required field that fails cannot be left out to prove it, so nothing is named.
        let bad_kind = serde_json::json!({ "kind": "nonsense", "module": "app", "route": "home" });
        assert_eq!(refused_field::<PageErrorReport>(&bad_kind), None);
    }

    #[test]
    fn playback_route_tag_names_only_closed_route_facts() {
        let report: PlaybackRouteReport = serde_json::from_value(serde_json::json!({
            "event": "failed",
            "requestedSource": "torbox",
            "reason": "direct",
            "failure": "source_unavailable",
            "cause": "torbox_authentication_failed",
            "subtitleConstraint": "den_subtitles_disabled",
            "replacement": false,
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "event:failed,requested:torbox,reason:direct,failure:source_unavailable,\
             cause:torbox_authentication_failed,subtitles:den_subtitles_disabled,replacement:0"
        );
    }

    #[test]
    fn playback_route_refuses_unknown_values_and_fields() {
        let unknown_value = serde_json::json!({ "event": "failed", "failure": "provider_said_secret" });
        assert!(serde_json::from_value::<PlaybackRouteReport>(unknown_value).is_err());
        let unknown_field = serde_json::json!({ "event": "failed", "url": "https://signed.example/secret" });
        assert!(serde_json::from_value::<PlaybackRouteReport>(unknown_field).is_err());
    }

    fn outcome() -> serde_json::Value {
        serde_json::json!({
            "engine": "hls.js",
            "route": "lan",
            "stallCount": 3,
            "stalledMs": 4500,
            "endReason": "finished",
            "secondsPlayed": 1200,
        })
    }

    #[test]
    fn playback_outcome_tag_leaves_out_absent_optionals() {
        let report: PlaybackOutcomeReport = serde_json::from_value(outcome()).unwrap();
        assert_eq!(
            report.tag(true),
            "engine:hls.js,route:lan,stalls:3,stalledMs:4500,end:finished,secondsPlayed:1200"
        );
    }

    #[test]
    fn playback_outcome_carries_its_seeks_and_dropped_frames() {
        let mut body = outcome();
        body["seeks"] = serde_json::json!([2, 1020, 900]);
        body["droppedFrames"] = serde_json::json!(14);
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        assert!(report.tag(false).ends_with(",seeks:2/1020ms/max900ms,dropped:14"), "{}", report.tag(false));
    }

    /// The 2026-10-17 failure, as it should have read: a Hearth session played in the cast page, which refused its
    /// load. Before, the same visit logged only `engine:native,route:public,end:error`.
    #[test]
    fn playback_outcome_names_the_cast_page_and_what_noticed_the_failure() {
        let mut body = outcome();
        body["engine"] = serde_json::json!("cast_page");
        body["route"] = serde_json::json!("public");
        body["endReason"] = serde_json::json!("error");
        body["failSource"] = serde_json::json!("cast_page_error");
        body["castFailReason"] = serde_json::json!("invalid_media");
        body["delivery"] = serde_json::json!("remux");
        body["lanOffered"] = serde_json::json!(true);
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        let tag = report.tag(false);
        assert!(tag.starts_with("engine:cast_page,route:public,"), "{tag}");
        assert!(
            tag.ends_with("failSource:cast_page_error,castFail:invalid_media,delivery:remux,lanOffered:1"),
            "{tag}"
        );
        let mut bad = outcome();
        bad["failSource"] = serde_json::json!("anything");
        assert!(serde_json::from_value::<PlaybackOutcomeReport>(bad).is_err());
    }

    #[test]
    fn playback_outcome_carries_subtitle_facts_and_the_hls_fatal_pair() {
        let mut body = outcome();
        body["endReason"] = serde_json::json!("error");
        body["hlsFatalType"] = serde_json::json!("mediaError");
        body["hlsFatalDetail"] = serde_json::json!("fragLoadError");
        body["subtitleLanguage"] = serde_json::json!("pt-br");
        body["subtitleSource"] = serde_json::json!("den_subtitles");
        body["subtitleSwitched"] = serde_json::json!(true);
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        assert_eq!(
            report.tag(true),
            "engine:hls.js,route:lan,stalls:3,stalledMs:4500,end:error,secondsPlayed:1200,\
             hlsType:mediaError,hlsDetail:fragLoadError,subLang:pt-br,subSource:den_subtitles,subSwitched:1"
        );
    }

    #[test]
    fn a_switch_mid_visit_names_its_count_and_last_reason() {
        let mut body = outcome();
        body["switchCount"] = serde_json::json!(3);
        body["lastSwitchReason"] = serde_json::json!("delivery");
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        assert!(report.tag(true).contains("switches:3,switchReason:delivery"));
    }

    #[test]
    fn a_zero_switch_count_is_left_out_like_an_absent_one() {
        let mut body = outcome();
        body["switchCount"] = serde_json::json!(0);
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        assert!(!report.tag(true).contains("switches:"));
    }

    #[test]
    fn an_unresolved_subtitle_source_logs_as_unknown() {
        let mut body = outcome();
        body["subtitleLanguage"] = serde_json::json!("pt-br");
        body["subtitleSource"] = serde_json::json!("unknown");
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        assert!(report.tag(true).contains("subSource:unknown"));
    }

    #[test]
    fn a_claimed_duration_past_a_day_is_capped_before_the_log_sees_it() {
        let mut body = outcome();
        body["secondsPlayed"] = serde_json::json!(u32::MAX);
        body["stalledMs"] = serde_json::json!(u32::MAX);
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        assert!(report.tag(true).contains(&format!("secondsPlayed:{MAX_SECS}")));
        assert!(report.tag(true).contains(&format!("stalledMs:{MAX_MS}")));
    }

    #[test]
    fn a_subtitle_language_outside_the_shape_does_not_parse() {
        let mut body = outcome();
        body["subtitleLanguage"] = serde_json::json!("<script>");
        assert!(serde_json::from_value::<PlaybackOutcomeReport>(body).is_err());
    }

    /// Every identity field this report can carry, so a test can assert each is logged with `LOG_IDENTITY` on
    /// and every one of them is gone with it off.
    fn identity_fields() -> serde_json::Value {
        serde_json::json!({
            "tmdbId": 550,
            "mediaType": "movie",
            "season": 2,
            "episode": 4,
            "release": { "name": "Fight.Club.1999.1080p.BluRay.x264-GROUP", "size": 7_654_321_000u64 },
            "audioTrackIndex": 1,
            "audioLanguage": "en",
            "audioCodec": "aac",
            "subtitleIndex": 2,
            "subtitleLanguage": "pt-br",
            "subtitleSource": "den_subtitles",
        })
    }

    #[test]
    fn identity_fields_reach_the_outcome_tag_only_when_log_identity_is_on() {
        let mut body = outcome();
        for (k, v) in identity_fields().as_object().unwrap() {
            body[k] = v.clone();
        }
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        let on = report.tag(true);
        for part in [
            "tmdbId:550",
            "mediaType:movie",
            "season:2",
            "episode:4",
            "release:Fight.Club.1999.1080p.BluRay.x264-GROUP",
            "releaseSize:7654321000",
            "audioTrack:1",
            "audioLang:en",
            "audioCodec:aac",
            "subIndex:2",
            "subLang:pt-br",
            "subSource:den_subtitles",
        ] {
            assert!(on.contains(part), "{on:?} must contain {part:?}");
        }
        let off = report.tag(false);
        assert_eq!(
            off, "engine:hls.js,route:lan,stalls:3,stalledMs:4500,end:finished,secondsPlayed:1200",
            "LOG_IDENTITY off must leave out every identity field and nothing else"
        );
    }

    #[test]
    fn an_over_long_or_bad_charset_release_name_logs_no_release() {
        let too_long = "x".repeat(MAX_RELEASE_NAME_LEN + 1);
        let bad_charset = "Fight Club <script>1999</script>";
        for name in [too_long.as_str(), bad_charset] {
            let mut body = outcome();
            body["release"] = serde_json::json!({ "name": name, "size": 123 });
            body["tmdbId"] = serde_json::json!(550);
            let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
            let tag = report.tag(true);
            assert!(!tag.contains("release:"), "{tag:?} must not carry an invalid release name");
            assert!(!tag.contains("releaseSize:"), "{tag:?} must not carry an orphaned release size");
            // The rest of the report still reaches the log: a bad release name drops only itself.
            assert!(tag.contains("tmdbId:550"), "{tag:?} must still carry the rest of the report");
        }
    }

    #[test]
    fn cast_tag_names_the_stage_and_leaves_out_absent_failure() {
        let report: CastReport =
            serde_json::from_value(serde_json::json!({ "kind": "chromecast", "reached": "started" }))
                .unwrap();
        assert_eq!(report.tag(true), "kind:chromecast,reached:started");
    }

    #[test]
    fn a_failed_cast_attempt_names_its_reason_and_duration() {
        let report: CastReport = serde_json::from_value(serde_json::json!({
            "kind": "airplay", "reached": "attempted", "failed": true,
            "failReason": "lan_unreachable", "sessionSecs": 42,
        }))
        .unwrap();
        assert_eq!(
            report.tag(true),
            "kind:airplay,reached:attempted,failed:1,failReason:lan_unreachable,sessionSecs:42"
        );
    }

    #[test]
    fn cast_identity_fields_are_gated_by_log_identity_too() {
        let mut body = serde_json::json!({ "kind": "airplay", "reached": "started" });
        body["tmdbId"] = serde_json::json!(550);
        body["mediaType"] = serde_json::json!("movie");
        let report: CastReport = serde_json::from_value(body).unwrap();
        assert_eq!(report.tag(true), "kind:airplay,reached:started,tmdbId:550,mediaType:movie");
        assert_eq!(report.tag(false), "kind:airplay,reached:started");
    }
}
