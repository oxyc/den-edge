//! The validators an answer carries so a client holding a copy can ask "still this?" and be told 304 instead of
//! being sent the same bytes again: an `ETag` digest of the body, a `Last-Modified` from when it was kept, and the
//! conditional-request check both are read by.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A strong tag for `body`: its SHA-256, cut to 128 bits, which is still far past any collision a cache could meet.
pub(crate) fn tag(body: &[u8]) -> HeaderValue {
    let digest = Sha256::digest(body);
    HeaderValue::from_str(&format!("\"{}\"", crate::hex(&digest[..16]))).expect("a quoted hex digest")
}

/// Tag `resp` with `body`'s digest and, when known, when it was kept; then answer 304 if the caller already holds it.
pub(crate) fn validated(
    mut resp: Response,
    body: &[u8],
    modified: Option<SystemTime>,
    request: &HeaderMap,
) -> Response {
    resp.headers_mut().insert(header::ETAG, tag(body));
    if let Some(value) = modified.and_then(|t| HeaderValue::from_str(&http_date(t)).ok()) {
        resp.headers_mut().insert(header::LAST_MODIFIED, value);
    }
    revalidate(resp, request)
}

/// Validators name the selected representation, so a gzip response cannot validate identity bytes.
/// GET/HEAD use weak comparison, including a list of tags or `*` (RFC 9110 §13.1.2). `If-Modified-Since` is read
/// only when no `If-None-Match` was sent, and only against a `Last-Modified` this answer carries (§13.1.3).
///
/// A 304 keeps every header of the answer it stands for — its `Cache-Control` and `ETag` above all, which is what
/// lets the client go on using the copy it holds.
pub(crate) fn revalidate(mut response: Response, request: &HeaderMap) -> Response {
    if response.status() != StatusCode::OK {
        return response;
    }
    let matched = if request.contains_key(header::IF_NONE_MATCH) {
        let Some(etag) = response.headers().get(header::ETAG) else { return response };
        request.get_all(header::IF_NONE_MATCH).iter().any(|line| {
            line.to_str().is_ok_and(|line| {
                line.split(',').any(|tag| {
                    let tag = tag.trim();
                    tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
                })
            })
        })
    } else {
        let seconds =
            |value: Option<&HeaderValue>| value.and_then(|v| v.to_str().ok()).and_then(parse_http_date);
        match (
            seconds(response.headers().get(header::LAST_MODIFIED)),
            seconds(request.get(header::IF_MODIFIED_SINCE)),
        ) {
            (Some(modified), Some(since)) => modified <= since,
            _ => false,
        }
    };
    if matched {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        *response.body_mut() = Body::empty();
    }
    response
}

const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] =
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `t` as an IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), the one form RFC 9110 lets a sender use.
pub(crate) fn http_date(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs();
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    let (year, month, day) = civil(days);
    // 1970-01-01 was a Thursday.
    let weekday = DAYS[((days + 4) % 7) as usize];
    format!(
        "{weekday}, {day:02} {} {year:04} {:02}:{:02}:{:02} GMT",
        MONTHS[(month - 1) as usize],
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// An IMF-fixdate as seconds since the epoch. The obsolete RFC 850 and asctime forms are not read: a date that
/// does not parse is a condition not met, and the whole answer is sent, which is always correct.
fn parse_http_date(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    let [_, day, month, year, time, "GMT"] = parts.as_slice() else { return None };
    let day: u32 = day.parse().ok().filter(|d| (1..=31).contains(d))?;
    let month = MONTHS.iter().position(|m| m == month)? as u32 + 1;
    // Four digits, as the form has them: a longer year overflows `days_from_civil`.
    let year: i64 = year.parse().ok().filter(|y| (1970..=9999).contains(y))?;
    let mut hms = time.split(':').map(|n| n.parse::<u64>().ok());
    let (Some(Some(h)), Some(Some(m)), Some(Some(sec)), None) =
        (hms.next(), hms.next(), hms.next(), hms.next())
    else {
        return None;
    };
    if h > 23 || m > 59 || sec > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days as u64 * 86_400 + h * 3600 + m * 60 + sec)
}

/// Days since 1970-01-01 as (year, month, day), proleptic Gregorian (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The inverse of `civil`.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = i64::from((month + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_written_and_read_as_imf_fixdates() {
        let t = UNIX_EPOCH + Duration::from_secs(784_111_777);
        assert_eq!(http_date(t), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784_111_777));
        assert_eq!(http_date(UNIX_EPOCH), "Thu, 01 Jan 1970 00:00:00 GMT");
        // A leap day, and the round trip across a range of years.
        assert_eq!(http_date(UNIX_EPOCH + Duration::from_secs(951_782_400)), "Tue, 29 Feb 2000 00:00:00 GMT");
        for secs in [0, 86_399, 1_789_000_000, 4_102_444_800] {
            let t = UNIX_EPOCH + Duration::from_secs(secs);
            assert_eq!(parse_http_date(&http_date(t)), Some(secs), "{secs}");
        }
        for bad in [
            "",
            "Sunday, 06-Nov-94 08:49:37 GMT",
            "Sun Nov  6 08:49:37 1994",
            "Sun, 06 Nov 1994 25:00:00 GMT",
            // A year past the four digits the form allows overflowed the day count: a panic in a debug build, and
            // in release a wrapped date that could answer 304.
            "Sun, 06 Nov 9223372036854775807 00:00:00 GMT",
            "Sun, 06 Nov 10000 00:00:00 GMT",
        ] {
            assert_eq!(parse_http_date(bad), None, "{bad}");
        }
    }

    fn ok() -> Response {
        let mut resp = Response::new(Body::from("{}"));
        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        resp
    }

    fn asking(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        pairs.iter().map(|(name, value)| (name.clone(), HeaderValue::from_str(value).unwrap())).collect()
    }

    #[test]
    fn a_held_copy_is_answered_304_with_the_same_policy_and_tag() {
        let modified = UNIX_EPOCH + Duration::from_secs(1_789_000_000);
        let first = validated(ok(), b"{}", Some(modified), &HeaderMap::new());
        assert_eq!(first.status(), StatusCode::OK);
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
        assert_eq!(etag.len(), 34, "32 hex digits, quoted: {etag}");
        let last = first.headers()[header::LAST_MODIFIED].to_str().unwrap().to_owned();

        let by_tag = validated(ok(), b"{}", Some(modified), &asking(&[(header::IF_NONE_MATCH, &etag)]));
        assert_eq!(by_tag.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(by_tag.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(by_tag.headers()[header::ETAG], etag.as_str());

        let by_date = validated(ok(), b"{}", Some(modified), &asking(&[(header::IF_MODIFIED_SINCE, &last)]));
        assert_eq!(by_date.status(), StatusCode::NOT_MODIFIED);

        // A changed body is a different tag, and a tag that does not match wins over a date that would.
        let changed = validated(
            ok(),
            b"{\"x\":1}",
            Some(modified),
            &asking(&[(header::IF_NONE_MATCH, &etag), (header::IF_MODIFIED_SINCE, &last)]),
        );
        assert_eq!(changed.status(), StatusCode::OK);
        let older = http_date(modified - Duration::from_secs(1));
        let newer = validated(ok(), b"{}", Some(modified), &asking(&[(header::IF_MODIFIED_SINCE, &older)]));
        assert_eq!(newer.status(), StatusCode::OK, "kept after the copy the caller holds");
    }
}
