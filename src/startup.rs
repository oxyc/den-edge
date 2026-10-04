//! A browser's playback-startup timing, landed in the request log (den-edge#234's step 0): how long the
//! stretches of starting a session took, bucketed and labelled — never which title, which server, or any URL
//! or token. `POST /playback/startup`, fire-and-forget, answered with no body.
//!
//! Every field is typed and allowlisted by `serde`: a request this doesn't parse into `Report` is a 400, not a
//! free-text line in the log. The one thing that reaches `eprintln!` (`StartupTag`, `handler.rs`) is the join of
//! those typed fields back into text, so nothing freeform from the body ever does.

use crate::diagnostics::Identity;
use crate::handler::{client_ip, error, json_reply, read_json, retry_after, StartupTag};
use crate::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use std::sync::Arc;

const MAX_BODY_BYTES: usize = 1024;
/// A play starts a session once; this is headroom for a retry or two, not a stream of them.
const PER_MINUTE: u32 = 20;
/// However long a report claims a stretch took, capped before it reaches the log: past ten minutes this
/// measurement no longer means anything, whatever the browser sent.
const MAX_MS: u32 = 600_000;
const MAX_BYTES: u64 = 200 * 1024 * 1024 * 1024;

pub async fn handle(state: &Arc<AppState>, req: Request) -> Response {
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_per_minute(state, &format!("startup:{ip}"), PER_MINUTE) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let value = match read_json(req, MAX_BODY_BYTES).await {
        Ok(v) => v,
        Err(r) => return *r,
    };
    let Ok(report) = serde_json::from_value::<Report>(value) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_startup_report"));
    };
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.extensions_mut().insert(StartupTag(report.tag(state.log_identity)));
    resp
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    session_ms: u32,
    resolve_ms: Option<u32>,
    open_ms: Option<u32>,
    tried: Option<u32>,
    init_ms: Option<u32>,
    first_segment_ms: u32,
    first_frame_ms: u32,
    /// Absent on native HLS: no loader there to read a byte count from, only `buffered` seconds (which this
    /// report does not carry — den-edge's log is for comparing starts, not for the live "Buffering…" line).
    bytes_loaded: Option<u64>,
    size: Size,
    codec: Codec,
    transcoded: bool,
    player: Player,
    route: Route,
    /// What was opened — the TMDB id, the release — gated like every other identity field (`LOG_IDENTITY`).
    #[serde(flatten)]
    identity: Identity,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Size {
    Small,
    Medium,
    Large,
    Xlarge,
}

impl Size {
    fn as_str(&self) -> &'static str {
        match self {
            Size::Small => "small",
            Size::Medium => "medium",
            Size::Large => "large",
            Size::Xlarge => "xlarge",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Codec {
    H264,
    Hevc,
    Av1,
    Vp9,
}

impl Codec {
    fn as_str(&self) -> &'static str {
        match self {
            Codec::H264 => "h264",
            Codec::Hevc => "hevc",
            Codec::Av1 => "av1",
            Codec::Vp9 => "vp9",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Player {
    Native,
    #[serde(rename = "hls.js")]
    HlsJs,
}

impl Player {
    fn as_str(&self) -> &'static str {
        match self {
            Player::Native => "native",
            Player::HlsJs => "hls.js",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Route {
    Lan,
    Public,
    Tailnet,
}

impl Route {
    fn as_str(&self) -> &'static str {
        match self {
            Route::Lan => "lan",
            Route::Public => "public",
            Route::Tailnet => "tailnet",
        }
    }
}

impl Report {
    /// `name:value` pairs, comma-joined, for one `startup=` tag on the request log line (`handler::log_line`).
    fn tag(&self, log_identity: bool) -> String {
        let ms = |n: u32| n.min(MAX_MS);
        let mut parts = vec![
            format!("session:{}", ms(self.session_ms)),
            format!("firstSeg:{}", ms(self.first_segment_ms)),
            format!("firstFrame:{}", ms(self.first_frame_ms)),
            format!("size:{}", self.size.as_str()),
            format!("codec:{}", self.codec.as_str()),
            format!("transcoded:{}", u8::from(self.transcoded)),
            format!("player:{}", self.player.as_str()),
            format!("route:{}", self.route.as_str()),
        ];
        if let Some(v) = self.bytes_loaded {
            parts.push(format!("bytes:{}", v.min(MAX_BYTES)));
        }
        if let Some(v) = self.resolve_ms {
            parts.push(format!("resolve:{}", ms(v)));
        }
        if let Some(v) = self.open_ms {
            parts.push(format!("open:{}", ms(v)));
        }
        if let Some(v) = self.tried {
            parts.push(format!("tried:{}", v.min(100)));
        }
        if let Some(v) = self.init_ms {
            parts.push(format!("init:{}", ms(v)));
        }
        parts.extend(self.identity.parts(log_identity));
        parts.join(",")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> Report {
        Report {
            session_ms: 1234,
            resolve_ms: Some(56),
            open_ms: Some(200),
            tried: Some(3),
            init_ms: Some(90),
            first_segment_ms: 2200,
            first_frame_ms: 9800,
            bytes_loaded: Some(12_345_678),
            size: Size::Large,
            codec: Codec::Hevc,
            transcoded: false,
            player: Player::HlsJs,
            route: Route::Lan,
            identity: Identity::default(),
        }
    }

    #[test]
    fn the_tag_names_every_field_and_nothing_else() {
        assert_eq!(
            report().tag(true),
            "session:1234,firstSeg:2200,firstFrame:9800,size:large,codec:hevc,transcoded:0,\
             player:hls.js,route:lan,bytes:12345678,resolve:56,open:200,tried:3,init:90"
        );
    }

    #[test]
    fn absent_server_timing_and_byte_fields_are_left_out_rather_than_zeroed() {
        let mut r = report();
        r.resolve_ms = None;
        r.open_ms = None;
        r.tried = None;
        r.init_ms = None;
        r.bytes_loaded = None; // native HLS: no loader there to read a byte count from
        assert_eq!(
            r.tag(true),
            "session:1234,firstSeg:2200,firstFrame:9800,size:large,codec:hevc,transcoded:0,\
             player:hls.js,route:lan"
        );
    }

    #[test]
    fn a_claimed_duration_past_ten_minutes_is_capped_before_the_log_sees_it() {
        let mut r = report();
        r.session_ms = u32::MAX;
        assert!(r.tag(true).contains("session:600000"));
    }

    #[test]
    fn startup_identity_fields_are_gated_by_log_identity() {
        let mut body = serde_json::json!({
            "sessionMs": 1234, "firstSegmentMs": 2200, "firstFrameMs": 9800,
            "size": "large", "codec": "hevc", "transcoded": false, "player": "hls.js", "route": "lan",
        });
        body["tmdbId"] = serde_json::json!(550);
        body["mediaType"] = serde_json::json!("movie");
        body["release"] = serde_json::json!({ "name": "Fight.Club.1999", "size": 123 });
        let report: Report = serde_json::from_value(body).unwrap();
        let on = report.tag(true);
        assert!(on.contains("tmdbId:550"), "{on:?}");
        assert!(on.contains("mediaType:movie"), "{on:?}");
        assert!(on.contains("release:Fight.Club.1999"), "{on:?}");
        let off = report.tag(false);
        assert!(!off.contains("tmdbId"), "{off:?} must carry no identity field with LOG_IDENTITY off");
        assert!(!off.contains("release"), "{off:?} must carry no identity field with LOG_IDENTITY off");
    }

    /// A body missing the required fields, or carrying anything outside the allowlisted shape — a title, say —
    /// fails to parse into `Report` at all: there is no path from an unexpected field to a log line.
    #[test]
    fn a_body_outside_the_allowlisted_shape_does_not_parse() {
        let missing_fields = serde_json::json!({ "sessionMs": 1 });
        assert!(serde_json::from_value::<Report>(missing_fields).is_err());
        let unknown_enum_value = serde_json::json!({
            "sessionMs": 1, "firstSegmentMs": 1, "firstFrameMs": 1, "bytesLoaded": 1,
            "size": "huge", "codec": "hevc", "transcoded": false, "player": "hls.js", "route": "lan",
        });
        assert!(serde_json::from_value::<Report>(unknown_enum_value).is_err());
    }
}
