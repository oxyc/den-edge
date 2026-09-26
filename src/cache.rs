//! The validators an answer carries so a client holding a copy can ask "still this?" and be told 304 instead of
//! being sent the same bytes again: an `ETag` digest of the body, a `Last-Modified` from when it was kept, and the
//! conditional-request check both are read by.

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use sha2::{Digest, Sha256};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Provider cache response metadata. The JSON stays a plain file so old caches and maintenance tools continue to
/// work; this fixed-size sidecar lets a hit validate and stream that file without reading it into a `Value` or a
/// body-sized allocation. Its stamp ties it to the exact body generation, so a crash or a rename between the two
/// can only cause one bounded re-hash, never a mismatched ETag or length.
const JSON_META_MAGIC: &[u8; 8] = b"DENJSON2";
const JSON_META_LEN: usize = 64;
const JSON_CONTENT_TYPE: u8 = 1;
const IDENTITY_ENCODING: u8 = 0;
const JSON_HASH_SHARDS: usize = 16;
const HASH_CHUNK: usize = 64 * 1024;

fn json_meta_path(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(".response");
    PathBuf::from(name)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    seconds: u64,
    nanos: u32,
    device: u64,
    inode: u64,
}

fn stamp(metadata: &std::fs::Metadata) -> Option<Stamp> {
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    // den-edge's deployment and CI targets are Unix. Other targets remain correct by refusing to trust a sidecar
    // in `decode_json_meta`; they simply hash the bounded body on every open.
    #[cfg(not(unix))]
    let (device, inode) = (0, 0);
    Some(Stamp {
        len: metadata.len(),
        seconds: modified.as_secs(),
        nanos: modified.subsec_nanos(),
        device,
        inode,
    })
}

fn encode_json_meta(stamp: Stamp, digest: &[u8; 16]) -> [u8; JSON_META_LEN] {
    let mut out = [0; JSON_META_LEN];
    out[..8].copy_from_slice(JSON_META_MAGIC);
    out[8..16].copy_from_slice(&stamp.len.to_be_bytes());
    out[16..24].copy_from_slice(&stamp.seconds.to_be_bytes());
    out[24..28].copy_from_slice(&stamp.nanos.to_be_bytes());
    out[28] = JSON_CONTENT_TYPE;
    out[29] = IDENTITY_ENCODING;
    out[32..40].copy_from_slice(&stamp.device.to_be_bytes());
    out[40..48].copy_from_slice(&stamp.inode.to_be_bytes());
    out[48..64].copy_from_slice(digest);
    out
}

#[cfg(not(unix))]
fn decode_json_meta(_: &[u8; JSON_META_LEN], _: Stamp) -> Option<[u8; 16]> {
    None
}

#[cfg(unix)]
fn decode_json_meta(bytes: &[u8; JSON_META_LEN], expected: Stamp) -> Option<[u8; 16]> {
    let number = |range: std::ops::Range<usize>| {
        let mut out = [0; 8];
        out.copy_from_slice(&bytes[range]);
        u64::from_be_bytes(out)
    };
    let mut nanos = [0; 4];
    nanos.copy_from_slice(&bytes[24..28]);
    let found = Stamp {
        len: number(8..16),
        seconds: number(16..24),
        nanos: u32::from_be_bytes(nanos),
        device: number(32..40),
        inode: number(40..48),
    };
    if &bytes[..8] != JSON_META_MAGIC
        || found != expected
        || bytes[28] != JSON_CONTENT_TYPE
        || bytes[29] != IDENTITY_ENCODING
    {
        return None;
    }
    let mut digest = [0; 16];
    digest.copy_from_slice(&bytes[48..64]);
    Some(digest)
}

async fn read_json_meta(file: &Path, stamp: Stamp) -> Option<[u8; 16]> {
    let mut sidecar = tokio::fs::File::open(json_meta_path(file)).await.ok()?;
    if sidecar.metadata().await.ok()?.len() != JSON_META_LEN as u64 {
        return None;
    }
    let mut bytes = [0; JSON_META_LEN];
    sidecar.read_exact(&mut bytes).await.ok()?;
    decode_json_meta(&bytes, stamp)
}

async fn write_json_meta(file: &Path, stamp: Stamp, digest: &[u8; 16]) {
    let sidecar = json_meta_path(file);
    let temp = sidecar.with_extension(format!("response.{}.tmp", crate::hex(&crate::random_bytes::<8>())));
    let bytes = encode_json_meta(stamp, digest);
    if tokio::fs::write(&temp, bytes).await.is_ok() && tokio::fs::rename(&temp, &sidecar).await.is_ok() {
        // Provider sweeps scan directory entries. Giving the sidecar its body's age makes both expire together
        // instead of leaving young orphan metadata beside a body that was just removed.
        let modified = UNIX_EPOCH + Duration::new(stamp.seconds, stamp.nanos);
        // Open before handing the blocking timestamp syscall off. If this future is cancelled, or an external
        // writer replaces the pathname while the task is queued, the task can only backdate this exact inode --
        // never a newer sidecar generation that later appeared under the same name.
        if let Ok(file) = tokio::fs::File::options().write(true).open(&sidecar).await {
            let file = file.into_std().await;
            let _ = tokio::task::spawn_blocking(move || file.set_modified(modified)).await;
        }
        return;
    }
    let _ = tokio::fs::remove_file(temp).await;
}

fn json_hash_locks() -> &'static [tokio::sync::Mutex<()>] {
    static LOCKS: OnceLock<Vec<tokio::sync::Mutex<()>>> = OnceLock::new();
    LOCKS.get_or_init(|| (0..JSON_HASH_SHARDS).map(|_| tokio::sync::Mutex::new(())).collect())
}

fn json_hash_lock(file: &Path) -> &'static tokio::sync::Mutex<()> {
    let mut hash = DefaultHasher::new();
    file.hash(&mut hash);
    &json_hash_locks()[hash.finish() as usize % JSON_HASH_SHARDS]
}

async fn open_json_file(file: &Path, max_bytes: usize) -> io::Result<(tokio::fs::File, Stamp, SystemTime)> {
    let opened = tokio::fs::File::open(file).await?;
    let metadata = opened.metadata().await?;
    if !metadata.is_file() {
        return Err(io::ErrorKind::NotFound.into());
    }
    if metadata.len() > u64::try_from(max_bytes).unwrap_or(u64::MAX) {
        return Err(io::ErrorKind::FileTooLarge.into());
    }
    let stamp = stamp(&metadata).ok_or(io::ErrorKind::InvalidData)?;
    let modified = UNIX_EPOCH + Duration::new(stamp.seconds, stamp.nanos);
    Ok((opened, stamp, modified))
}

/// An exact JSON representation ready to validate and stream. Only this small descriptor is resident; a 200 reads
/// the open file in 64 KiB pieces under socket backpressure and a 304 drops it without reading body bytes.
pub(crate) struct JsonFile {
    file: tokio::fs::File,
    len: u64,
    modified: SystemTime,
    age: Duration,
    digest: [u8; 16],
}

impl JsonFile {
    pub(crate) fn age(&self) -> Duration {
        self.age
    }

    pub(crate) fn matches(&self, body: &[u8]) -> bool {
        self.digest == Sha256::digest(body)[..16]
    }

    /// Build the canonical identity response. Callers add cache policy and diagnostics before `revalidate`.
    pub(crate) fn response(self) -> Response {
        let mut response = crate::handler::raw_json(
            StatusCode::OK,
            Body::new(crate::web::FileBody::from_file(self.file, self.len)),
            false,
        );
        if let Ok(length) = HeaderValue::from_str(&self.len.to_string()) {
            response.headers_mut().insert(header::CONTENT_LENGTH, length);
        }
        response.headers_mut().insert(header::ETAG, tag_digest(&self.digest));
        if let Ok(modified) = HeaderValue::from_str(&http_date(self.modified)) {
            response.headers_mut().insert(header::LAST_MODIFIED, modified);
        }
        response
    }
}

/// Atomically keep a canonical JSON body and prepare its response metadata while the bytes are already resident.
/// Ratings uses this for misses and refreshes, so the first later hit does not have to hash the body from disk.
pub(crate) async fn write_json(file: &Path, body: &Bytes) -> bool {
    let _turn = json_hash_lock(file).lock().await;
    if !crate::tmdb::write(file, body).await {
        return false;
    }
    let Ok((_, stamp, _)) = open_json_file(file, body.len()).await else { return true };
    let digest = Sha256::digest(body);
    let mut short = [0; 16];
    short.copy_from_slice(&digest[..16]);
    write_json_meta(file, stamp, &short).await;
    true
}

/// Open an exact cached JSON representation. Current entries read only their fixed 64-byte sidecar. An entry made
/// by an older release is hashed once and receives a sidecar; the 16 striped locks cap hashing buffers at 1 MiB and
/// collapse concurrent upgrades without a path-cardinality map that could grow forever. `max_bytes` also keeps a
/// corrupt or hand-placed cache entry from turning a provider's documented response cap into an unbounded stream.
pub(crate) async fn open_json(file: &Path, max_bytes: usize) -> Option<JsonFile> {
    let (mut opened, mut found, mut modified) = open_json_file(file, max_bytes).await.ok()?;
    let digest = match read_json_meta(file, found).await {
        Some(digest) => digest,
        None => {
            drop(opened);
            let _turn = json_hash_lock(file).lock().await;
            (opened, found, modified) = open_json_file(file, max_bytes).await.ok()?;
            if let Some(digest) = read_json_meta(file, found).await {
                digest
            } else {
                let mut hasher = Sha256::new();
                let mut chunk = vec![0; usize::try_from(found.len).unwrap_or(HASH_CHUNK).min(HASH_CHUNK)];
                loop {
                    let read = opened.read(&mut chunk).await.ok()?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&chunk[..read]);
                }
                opened.rewind().await.ok()?;
                let mut digest = [0; 16];
                digest.copy_from_slice(&hasher.finalize()[..16]);
                // Only publish metadata for the same generation we hashed. A concurrent rename merely leaves this
                // request serving its already-open, self-consistent inode and the next one prepares the new file.
                if tokio::fs::metadata(file).await.ok().and_then(|m| stamp(&m)) == Some(found) {
                    write_json_meta(file, found, &digest).await;
                }
                digest
            }
        }
    };
    let now = SystemTime::now();
    modified = modified.min(now);
    Some(JsonFile {
        file: opened,
        len: found.len,
        modified,
        age: now.duration_since(modified).unwrap_or_default(),
        digest,
    })
}

/// A strong tag for `body`: its SHA-256, cut to 128 bits, which is still far past any collision a cache could meet.
pub(crate) fn tag(body: &[u8]) -> HeaderValue {
    let digest = Sha256::digest(body);
    tag_digest(&digest[..16])
}

fn tag_digest(digest: &[u8]) -> HeaderValue {
    HeaderValue::from_str(&format!("\"{}\"", crate::hex(digest))).expect("a quoted hex digest")
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
    use http_body_util::BodyExt;

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

    #[tokio::test]
    async fn cached_json_is_prepared_once_streamed_in_pieces_and_validated_from_its_sidecar() {
        let dir = crate::handler::tests::temp_dir();
        let file = dir.join("ratings.json");
        let body: Vec<u8> = (0..HASH_CHUNK * 2 + 17).map(|n| (n % 251) as u8).collect();

        // A file from the release before response metadata is upgraded lazily without changing its plain body.
        crate::tmdb::write(&file, &Bytes::from(body.clone())).await;
        let prepared = open_json(&file, body.len()).await.unwrap();
        assert_eq!(tokio::fs::metadata(json_meta_path(&file)).await.unwrap().len(), JSON_META_LEN as u64);
        let response = prepared.response();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], body.len().to_string());
        let etag = response.headers()[header::ETAG].to_str().unwrap().to_owned();
        let mut streamed = response.into_body();
        let (mut frames, mut received) = (0, Vec::new());
        while let Some(frame) = streamed.frame().await {
            received.extend_from_slice(frame.unwrap().data_ref().unwrap());
            frames += 1;
        }
        assert_eq!(received, body);
        assert_eq!(frames, 3, "the representation is read under backpressure, not allocated whole");

        // The next conditional request uses the persisted digest and sends no body bytes.
        let prepared = open_json(&file, body.len()).await.unwrap();
        let mut asked = HeaderMap::new();
        asked.insert(header::IF_NONE_MATCH, HeaderValue::from_str(&etag).unwrap());
        let response = revalidate(prepared.response(), &asked);
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert!(response.into_body().collect().await.unwrap().to_bytes().is_empty());
    }

    #[tokio::test]
    async fn an_atomic_same_size_same_time_replacement_cannot_reuse_the_old_validator() {
        let dir = crate::handler::tests::temp_dir();
        let file = dir.join("ratings.json");
        let old = Bytes::from_static(br#"{"rating":"1"}"#);
        let new = Bytes::from_static(br#"{"rating":"2"}"#);
        assert_eq!(old.len(), new.len());

        write_json(&file, &old).await;
        let old_response = open_json(&file, old.len()).await.unwrap().response();
        let old_etag = old_response.headers()[header::ETAG].to_str().unwrap().to_owned();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();

        let replacement = dir.join("replacement");
        std::fs::write(&replacement, &new).unwrap();
        std::fs::File::options().write(true).open(&replacement).unwrap().set_modified(modified).unwrap();
        std::fs::rename(replacement, &file).unwrap();

        let prepared = open_json(&file, new.len()).await.unwrap();
        let mut asked = HeaderMap::new();
        asked.insert(header::IF_NONE_MATCH, HeaderValue::from_str(&old_etag).unwrap());
        let response = revalidate(prepared.response(), &asked);
        assert_eq!(response.status(), StatusCode::OK, "the old sidecar belongs to another inode");
        assert_ne!(response.headers()[header::ETAG], old_etag.as_str());
        assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), new);
    }

    #[tokio::test]
    async fn a_provider_cache_file_cannot_exceed_its_endpoint_cap() {
        let dir = crate::handler::tests::temp_dir();
        let file = dir.join("ratings.json");
        crate::tmdb::write(&file, &Bytes::from_static(b"12345")).await;
        assert!(open_json(&file, 4).await.is_none());
    }
}
