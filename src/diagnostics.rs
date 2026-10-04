//! What a browser's web player and Chromecast/AirPlay path saw and the device API never does: a page that broke
//! or never rendered, how a playback session ended, and how a cast attempt went. Three sibling reports beside
//! `startup.rs` (den-edge#234's precedent), same shape: `POST`, rate-limited per address, serde-allowlisted so a
//! body this doesn't parse into one of the structs below is a 400, not a line in the log — and every field is an
//! enum or a capped number. Never a title, a URL, a token, a library id or any other free text, by construction
//! rather than by scrubbing.

use crate::handler::{
    client_ip, error, json_reply, read_json, retry_after, CastTag, PageErrorTag, PlaybackOutcomeTag,
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
/// every handler below; `Err` already carries the response to answer with.
async fn intake<T: DeserializeOwned>(
    state: &Arc<AppState>,
    req: Request,
    bucket: &str,
) -> Result<T, Response> {
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_per_minute(state, &format!("{bucket}:{ip}"), PER_MINUTE) {
        return Err(retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait));
    }
    let value = match read_json(req, MAX_BODY_BYTES).await {
        Ok(v) => v,
        Err(r) => return Err(*r),
    };
    serde_json::from_value::<T>(value)
        .map_err(|_| json_reply(StatusCode::BAD_REQUEST, &error("invalid_report")))
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

impl TryFrom<String> for Release {
    type Error = &'static str;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        let ok = !s.is_empty()
            && s.len() <= 32
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
    kind: ErrorKind,
    module: Module,
    /// Absent when the page's own re-fetch of its release (`diagnosticsReport.ts`'s `loadRelease`) hadn't
    /// resolved yet — an error in the first moment of a load — rather than a report that waits for it.
    release: Option<Release>,
    route: PageRoute,
}

impl PageErrorReport {
    fn tag(&self) -> String {
        let mut tag = format!("kind:{},module:{}", self.kind.as_str(), self.module.as_str());
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
        Err(resp) => return resp,
    };
    accepted(report.tag(), |resp, tag| {
        resp.extensions_mut().insert(PageErrorTag(tag));
    })
}

// ---------------------------------------------------------------------------------------------------------------
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
}

impl Engine {
    fn as_str(&self) -> &'static str {
        match self {
            Engine::Native => "native",
            Engine::HlsJs => "hls.js",
            Engine::Progressive => "progressive",
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

/// Where the chosen subtitle came from: the release's own rendition, or den-subtitles' own search — never which
/// file, which is not this report's to carry.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubtitleSource {
    Release,
    DenSubtitles,
}

impl SubtitleSource {
    fn as_str(&self) -> &'static str {
        match self {
            SubtitleSource::Release => "release",
            SubtitleSource::DenSubtitles => "den_subtitles",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackOutcomeReport {
    engine: Engine,
    route: NetworkRoute,
    stall_count: u32,
    stalled_ms: u32,
    end_reason: EndReason,
    error_code: Option<u8>,
    hls_fatal_type: Option<HlsFatalType>,
    hls_fatal_detail: Option<HlsFatalDetail>,
    seconds_played: u32,
    subtitle_language: Option<Language>,
    subtitle_source: Option<SubtitleSource>,
    #[serde(default)]
    subtitle_switched: bool,
    #[serde(default)]
    subtitle_turned_off: bool,
    #[serde(default)]
    subtitle_load_failed: bool,
}

impl PlaybackOutcomeReport {
    fn tag(&self) -> String {
        let mut parts = vec![
            format!("engine:{}", self.engine.as_str()),
            format!("route:{}", self.route.as_str()),
            format!("stalls:{}", self.stall_count.min(1000)),
            format!("stalledMs:{}", self.stalled_ms.min(MAX_MS)),
            format!("end:{}", self.end_reason.as_str()),
            format!("secondsPlayed:{}", self.seconds_played.min(MAX_SECS)),
        ];
        if let Some(v) = self.error_code {
            parts.push(format!("errorCode:{}", v.min(4)));
        }
        if let Some(t) = &self.hls_fatal_type {
            parts.push(format!("hlsType:{}", t.as_str()));
        }
        if let Some(d) = &self.hls_fatal_detail {
            parts.push(format!("hlsDetail:{}", d.as_str()));
        }
        if let Some(l) = &self.subtitle_language {
            parts.push(format!("subLang:{}", l.0));
        }
        if let Some(s) = &self.subtitle_source {
            parts.push(format!("subSource:{}", s.as_str()));
        }
        if self.subtitle_switched {
            parts.push("subSwitched:1".to_owned());
        }
        if self.subtitle_turned_off {
            parts.push("subOff:1".to_owned());
        }
        if self.subtitle_load_failed {
            parts.push("subLoadFailed:1".to_owned());
        }
        parts.join(",")
    }
}

pub async fn handle_playback_outcome(state: &Arc<AppState>, req: Request) -> Response {
    let report: PlaybackOutcomeReport = match intake(state, req, PLAYBACK_OUTCOME_BUCKET).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    accepted(report.tag(), |resp, tag| {
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
    Other,
}

impl CastFailReason {
    fn as_str(&self) -> &'static str {
        match self {
            CastFailReason::ReceiverNotLoaded => "receiver_not_loaded",
            CastFailReason::MediaError => "media_error",
            CastFailReason::LanUnreachable => "lan_unreachable",
            CastFailReason::SessionError => "session_error",
            CastFailReason::Other => "other",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CastReport {
    kind: CastKind,
    reached: CastStage,
    #[serde(default)]
    failed: bool,
    fail_reason: Option<CastFailReason>,
    session_secs: Option<u32>,
}

impl CastReport {
    fn tag(&self) -> String {
        let mut parts =
            vec![format!("kind:{}", self.kind.as_str()), format!("reached:{}", self.reached.as_str())];
        if self.failed {
            parts.push("failed:1".to_owned());
        }
        if let Some(r) = &self.fail_reason {
            parts.push(format!("failReason:{}", r.as_str()));
        }
        if let Some(s) = self.session_secs {
            parts.push(format!("sessionSecs:{}", s.min(MAX_SECS)));
        }
        parts.join(",")
    }
}

pub async fn handle_cast(state: &Arc<AppState>, req: Request) -> Response {
    let report: CastReport = match intake(state, req, CAST_BUCKET).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    accepted(report.tag(), |resp, tag| {
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
            report.tag(),
            "engine:hls.js,route:lan,stalls:3,stalledMs:4500,end:finished,secondsPlayed:1200"
        );
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
            report.tag(),
            "engine:hls.js,route:lan,stalls:3,stalledMs:4500,end:error,secondsPlayed:1200,\
             hlsType:mediaError,hlsDetail:fragLoadError,subLang:pt-br,subSource:den_subtitles,subSwitched:1"
        );
    }

    #[test]
    fn a_claimed_duration_past_a_day_is_capped_before_the_log_sees_it() {
        let mut body = outcome();
        body["secondsPlayed"] = serde_json::json!(u32::MAX);
        body["stalledMs"] = serde_json::json!(u32::MAX);
        let report: PlaybackOutcomeReport = serde_json::from_value(body).unwrap();
        assert!(report.tag().contains(&format!("secondsPlayed:{MAX_SECS}")));
        assert!(report.tag().contains(&format!("stalledMs:{MAX_MS}")));
    }

    #[test]
    fn a_subtitle_language_outside_the_shape_does_not_parse() {
        let mut body = outcome();
        body["subtitleLanguage"] = serde_json::json!("<script>");
        assert!(serde_json::from_value::<PlaybackOutcomeReport>(body).is_err());
    }

    #[test]
    fn cast_tag_names_the_stage_and_leaves_out_absent_failure() {
        let report: CastReport =
            serde_json::from_value(serde_json::json!({ "kind": "chromecast", "reached": "started" }))
                .unwrap();
        assert_eq!(report.tag(), "kind:chromecast,reached:started");
    }

    #[test]
    fn a_failed_cast_attempt_names_its_reason_and_duration() {
        let report: CastReport = serde_json::from_value(serde_json::json!({
            "kind": "airplay", "reached": "attempted", "failed": true,
            "failReason": "lan_unreachable", "sessionSecs": 42,
        }))
        .unwrap();
        assert_eq!(
            report.tag(),
            "kind:airplay,reached:attempted,failed:1,failReason:lan_unreachable,sessionSecs:42"
        );
    }
}
