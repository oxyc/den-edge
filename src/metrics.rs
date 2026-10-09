//! `/metrics`: requests by route and status, in Prometheus text, behind the bearer token every den service
//! uses. Routes are the fixed labels from `handler::route_label`, so no key ever becomes a label.

use crate::lock;
use axum::body::Bytes;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Metrics {
    requests: Mutex<BTreeMap<(&'static str, u16), u64>>,
    request_admission: Mutex<RequestAdmission>,
    connection_admission: Mutex<ConnectionAdmission>,
    media_admission: Mutex<MediaAdmissionState>,
    byte_admission: Mutex<ByteAdmissionState>,
    streams: Mutex<StreamState>,
    compression: Mutex<CompressionState>,
    provider_access: [[AtomicU64; 4]; 4],
    provider_upstream: [[AtomicU64; 5]; 4],
    provider_store: [[AtomicU64; 5]; 4],
    provider_inventory: [[AtomicU64; 3]; 4],
    provider_inventory_scan: [[AtomicU64; 2]; 4],
    tmdb_prepared: [AtomicU64; 4],
    title_metadata: [[AtomicU64; 7]; 3],
    /// Record-log writes applied, and refused as stale — a rising share of conflicts means devices are fighting
    /// over rows (or one keeps writing from an old base).
    library_writes: Mutex<(u64, u64)>,
    /// An invited guest's play refused at session start, by the refusal's code (one of `GUEST_PLAY_REFUSALS`):
    /// how often each known limit is met, IPv6 above all, before anything bigger is built for it.
    guest_play_refused: Mutex<BTreeMap<&'static str, u64>>,
    /// Media listeners opened wide (to more than the visitor's own address), by reason (`cast`, `ipv6`) and by
    /// who asked (`member`, `guest`). A guest is never given the wide scope, so its rows stay 0.
    public_media_wide: Mutex<BTreeMap<(&'static str, &'static str), u64>>,
    /// Media listeners opened for the IPv4 address an IPv6 visitor's page reported (`ipv4Hint`) rather than
    /// opened wide, by who asked. Each one is a `wide:ipv6` grant that did not happen.
    public_media_hinted: Mutex<BTreeMap<&'static str, u64>>,
    /// `ipv4Hint`s not used, by reason (one of `HINT_REJECTIONS`).
    public_media_hint_rejected: Mutex<BTreeMap<&'static str, u64>>,
    /// Session starts from an IPv6 visitor sent back for an `ipv4Hint` (`ipv4_hint_wanted`), by who asked.
    public_media_hint_wanted: Mutex<BTreeMap<&'static str, u64>>,
    mmap: Mutex<MmapMetrics>,
}

#[derive(Default)]
struct MmapMetrics {
    outcomes: [u64; 6],
    faults: [u64; 3],
    resident_count: usize,
    resident_bytes: usize,
    resident_high_water_bytes: usize,
    cached_count: usize,
    cached_bytes: usize,
}

pub(crate) const MMAP_OUTCOMES: [&str; 6] = ["hit", "built", "ineligible", "budget", "fault", "evicted"];
pub(crate) const MMAP_FAULTS: [&str; 3] = ["map", "read", "generation"];

#[derive(Default)]
struct RequestAdmission {
    active: [usize; 2],
    high_water: [usize; 2],
    waited: [u64; 2],
    refused: [u64; 2],
}

#[derive(Default)]
struct ConnectionAdmission {
    active: usize,
    high_water: usize,
    waited: u64,
}

#[derive(Default)]
struct MediaAdmissionState {
    active: [usize; 2],
    high_water: [usize; 2],
    refused: BTreeMap<&'static str, u64>,
}

#[derive(Default)]
struct ByteAdmissionState {
    active: [usize; 3],
    high_water: [usize; 3],
    waited: [u64; 3],
    refused: [u64; 3],
}

#[derive(Default)]
struct StreamState {
    active: [usize; 2],
    high_water: [usize; 2],
    retained: [usize; 2],
    retained_high_water: [usize; 2],
    terminated: [[u64; 6]; 2],
}

#[derive(Default)]
struct CompressionState {
    active: usize,
    high_water: usize,
    jobs: [u64; 3],
    input_bytes: u64,
    output_bytes: u64,
}

#[derive(Clone, Copy)]
pub enum BytePool {
    RelayCollect = 0,
    TmdbDerived = 1,
    TitleObservation = 2,
}

impl BytePool {
    const LABELS: [&'static str; 3] = ["relay_collect", "tmdb_derived", "title_observation"];
}

pub struct ByteAdmission {
    metrics: Arc<Metrics>,
    pool: usize,
    bytes: usize,
}

impl Drop for ByteAdmission {
    fn drop(&mut self) {
        let mut admission = lock(&self.metrics.byte_admission);
        admission.active[self.pool] = admission.active[self.pool].saturating_sub(self.bytes);
    }
}

#[derive(Clone, Copy)]
pub enum StreamClass {
    Addon = 0,
    Media = 1,
}

impl StreamClass {
    const LABELS: [&'static str; 2] = ["addon", "media"];
}

#[derive(Clone, Copy)]
pub enum StreamTermination {
    RouteLimit = 0,
    SourceIdle = 1,
    ReceiverIdle = 2,
    Lifetime = 3,
    UpstreamError = 4,
    ReceiverClosed = 5,
}

impl StreamTermination {
    const LABELS: [&'static str; 6] =
        ["route_limit", "source_idle", "receiver_idle", "lifetime", "upstream_error", "receiver_closed"];
}

pub struct StreamAdmission {
    metrics: Arc<Metrics>,
    class: usize,
}

impl Drop for StreamAdmission {
    fn drop(&mut self) {
        let mut streams = lock(&self.metrics.streams);
        streams.active[self.class] = streams.active[self.class].saturating_sub(1);
    }
}

struct StreamBytes {
    bytes: Bytes,
    metrics: Arc<Metrics>,
    class: usize,
    len: usize,
}

impl AsRef<[u8]> for StreamBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

impl Drop for StreamBytes {
    fn drop(&mut self) {
        let mut streams = lock(&self.metrics.streams);
        streams.retained[self.class] = streams.retained[self.class].saturating_sub(self.len);
    }
}

pub struct CompressionJob {
    metrics: Arc<Metrics>,
}

impl CompressionJob {
    pub fn finished(self, input: usize, output: Option<usize>) {
        let mut compression = lock(&self.metrics.compression);
        match output {
            Some(output) => {
                compression.jobs[0] += 1;
                compression.input_bytes += input as u64;
                compression.output_bytes += output as u64;
            }
            None => compression.jobs[1] += 1,
        }
        // `self` drops below and returns the active gauge through the same mutex.
        drop(compression);
    }
}

impl Drop for CompressionJob {
    fn drop(&mut self) {
        let mut compression = lock(&self.metrics.compression);
        compression.active = compression.active.saturating_sub(1);
    }
}

#[derive(Clone, Copy)]
pub enum Provider {
    Tmdb = 0,
    Ratings = 1,
    Warnings = 2,
    Skipdb = 3,
}

impl Provider {
    const LABELS: [&'static str; 4] = ["tmdb", "ratings", "warnings", "skipdb"];
}

#[derive(Clone, Copy)]
pub enum CacheAccess {
    Fresh = 0,
    Negative = 1,
    Stale = 2,
    Cold = 3,
}

impl CacheAccess {
    const LABELS: [&'static str; 4] = ["fresh", "negative", "stale", "cold"];
}

#[derive(Clone, Copy)]
pub enum ProviderUpstream {
    Updated = 0,
    NotModified = 1,
    Negative = 2,
    Failed = 3,
    Cancelled = 4,
}

impl ProviderUpstream {
    const LABELS: [&'static str; 5] = ["updated", "not_modified", "negative", "failed", "cancelled"];
}

#[derive(Clone, Copy)]
pub enum CacheStore {
    Stored = 0,
    Skipped = 1,
    Failed = 2,
    Expired = 3,
    Cancelled = 4,
}

impl CacheStore {
    const LABELS: [&'static str; 5] = ["stored", "skipped_policy", "failed", "expired", "cancelled"];
}

pub struct ProviderUpstreamAttempt {
    metrics: Arc<Metrics>,
    provider: Provider,
    finished: bool,
}

impl ProviderUpstreamAttempt {
    pub fn finished(mut self, result: ProviderUpstream) {
        self.metrics.provider_upstream(self.provider, result);
        self.finished = true;
    }
}

impl Drop for ProviderUpstreamAttempt {
    fn drop(&mut self) {
        if !self.finished {
            self.metrics.provider_upstream(self.provider, ProviderUpstream::Cancelled);
        }
    }
}

pub struct ProviderStoreAttempt {
    metrics: Arc<Metrics>,
    provider: Provider,
    finished: bool,
}

impl ProviderStoreAttempt {
    pub fn finished(mut self, result: CacheStore) {
        self.metrics.provider_cache_store(self.provider, result);
        self.finished = true;
    }
}

impl Drop for ProviderStoreAttempt {
    fn drop(&mut self) {
        if !self.finished {
            self.metrics.provider_cache_store(self.provider, CacheStore::Cancelled);
        }
    }
}

#[derive(Clone, Copy)]
pub enum TmdbPrepared {
    FileHit = 0,
    FileBuilt = 1,
    TransientBuilt = 2,
    PublishFailed = 3,
}

impl TmdbPrepared {
    const LABELS: [&'static str; 4] = ["file_hit", "file_built", "transient_built", "publish_failed"];
}

#[derive(Clone, Copy)]
pub enum TitleQuery {
    Nonempty = 0,
    Empty = 1,
    Unavailable = 2,
    Failed = 3,
}

pub enum TitlePublish {
    Stored = 0,
    Unavailable = 1,
    Full = 2,
    Failed = 3,
}

pub enum TitleObservation {
    Accepted = 0,
    NoStore = 1,
    TooLarge = 2,
    Busy = 3,
    Empty = 4,
    Stored = 5,
    Failed = 6,
}

const TITLE_METADATA_LABELS: [&[&str]; 3] = [
    &["nonempty", "empty", "unavailable", "failed"],
    &["stored", "unavailable", "full", "failed"],
    &["accepted", "no_store", "too_large", "busy", "empty", "stored", "failed"],
];

/// Keeps the media gauge tied to the same lifetime as the permits and upstream body. Dropping an answer before
/// polling it, downstream cancellation, and every error path therefore return the gauge as well as capacity.
pub struct MediaAdmission {
    metrics: Arc<Metrics>,
    audience: usize,
}

impl Drop for MediaAdmission {
    fn drop(&mut self) {
        let mut admission = lock(&self.metrics.media_admission);
        debug_assert!(admission.active[self.audience] > 0);
        admission.active[self.audience] = admission.active[self.audience].saturating_sub(1);
    }
}

/// The codes a guest's session start can be refused with, each always rendered, so a limit never met reads 0.
pub const GUEST_PLAY_REFUSALS: [&str; 7] = [
    "public_media_cast",
    "public_media_ipv6",
    "public_media_unavailable",
    "public_listener_unavailable",
    "relay_busy",
    "too_many_sources",
    "hint_limit",
];

/// Why an `ipv4Hint` was not used: not one bare IPv4 address, an address no one on the internet has, or one
/// past the cap on distinct hinted addresses.
pub const HINT_REJECTIONS: [&str; 3] = ["malformed", "not_global", "limit"];

impl Metrics {
    pub(crate) fn mmap_outcome(&self, outcome: usize) {
        lock(&self.mmap).outcomes[outcome] += 1;
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn mmap_fault(&self, fault: usize) {
        let mut metrics = lock(&self.mmap);
        metrics.outcomes[4] += 1;
        metrics.faults[fault] += 1;
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn mmap_resident_add(&self, bytes: usize) {
        let mut metrics = lock(&self.mmap);
        metrics.resident_count += 1;
        metrics.resident_bytes += bytes;
        metrics.resident_high_water_bytes = metrics.resident_high_water_bytes.max(metrics.resident_bytes);
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn mmap_resident_remove(&self, bytes: usize) {
        let mut metrics = lock(&self.mmap);
        metrics.resident_count = metrics.resident_count.saturating_sub(1);
        metrics.resident_bytes = metrics.resident_bytes.saturating_sub(bytes);
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn mmap_cached(&self, count: usize, bytes: usize) {
        let mut metrics = lock(&self.mmap);
        metrics.cached_count = count;
        metrics.cached_bytes = bytes;
    }

    pub fn record(&self, route: &'static str, status: u16) {
        *lock(&self.requests).entry((route, status)).or_default() += 1;
    }

    pub fn request_admitted(&self, bulk: bool, waited: bool) {
        let class = usize::from(bulk);
        let mut admission = lock(&self.request_admission);
        admission.active[class] += 1;
        admission.high_water[class] = admission.high_water[class].max(admission.active[class]);
        admission.waited[class] += u64::from(waited);
    }

    pub fn request_released(&self, bulk: bool) {
        let class = usize::from(bulk);
        let mut admission = lock(&self.request_admission);
        debug_assert!(admission.active[class] > 0);
        admission.active[class] = admission.active[class].saturating_sub(1);
    }

    pub fn request_refused(&self, bulk: bool) {
        lock(&self.request_admission).refused[usize::from(bulk)] += 1;
    }

    pub fn connection_waited(&self) {
        lock(&self.connection_admission).waited += 1;
    }

    pub fn connection_admitted(&self) {
        let mut admission = lock(&self.connection_admission);
        admission.active += 1;
        admission.high_water = admission.high_water.max(admission.active);
    }

    pub fn connection_released(&self) {
        let mut admission = lock(&self.connection_admission);
        debug_assert!(admission.active > 0);
        admission.active = admission.active.saturating_sub(1);
    }

    pub fn media_admitted(self: &Arc<Self>, member: bool) -> MediaAdmission {
        let audience = usize::from(member);
        let mut admission = lock(&self.media_admission);
        admission.active[audience] += 1;
        admission.high_water[audience] = admission.high_water[audience].max(admission.active[audience]);
        drop(admission);
        MediaAdmission { metrics: Arc::clone(self), audience }
    }

    pub fn media_refused(&self, reason: &'static str) {
        debug_assert!(["total", "member", "guest", "daily"].contains(&reason));
        *lock(&self.media_admission).refused.entry(reason).or_default() += 1;
    }

    pub fn byte_admitted(self: &Arc<Self>, pool: BytePool, bytes: usize, waited: bool) -> ByteAdmission {
        let pool = pool as usize;
        let mut admission = lock(&self.byte_admission);
        admission.active[pool] = admission.active[pool].saturating_add(bytes);
        admission.high_water[pool] = admission.high_water[pool].max(admission.active[pool]);
        admission.waited[pool] += u64::from(waited);
        drop(admission);
        ByteAdmission { metrics: Arc::clone(self), pool, bytes }
    }

    pub fn byte_refused(&self, pool: BytePool) {
        lock(&self.byte_admission).refused[pool as usize] += 1;
    }

    pub fn stream_started(self: &Arc<Self>, class: StreamClass) -> StreamAdmission {
        let class = class as usize;
        let mut streams = lock(&self.streams);
        streams.active[class] += 1;
        streams.high_water[class] = streams.high_water[class].max(streams.active[class]);
        drop(streams);
        StreamAdmission { metrics: Arc::clone(self), class }
    }

    /// Attach retained-byte accounting to the allocation itself, so clones and Hyper write buffers keep the gauge
    /// charged until the last reference is dropped.
    pub fn stream_bytes(self: &Arc<Self>, class: StreamClass, bytes: Bytes) -> Bytes {
        let class = class as usize;
        let len = bytes.len();
        let mut streams = lock(&self.streams);
        streams.retained[class] = streams.retained[class].saturating_add(len);
        streams.retained_high_water[class] = streams.retained_high_water[class].max(streams.retained[class]);
        drop(streams);
        Bytes::from_owner(StreamBytes { bytes, metrics: Arc::clone(self), class, len })
    }

    pub fn stream_terminated(&self, class: StreamClass, reason: StreamTermination) {
        lock(&self.streams).terminated[class as usize][reason as usize] += 1;
    }

    pub fn compression_started(self: &Arc<Self>) -> CompressionJob {
        let mut compression = lock(&self.compression);
        compression.active += 1;
        compression.high_water = compression.high_water.max(compression.active);
        drop(compression);
        CompressionJob { metrics: Arc::clone(self) }
    }

    pub fn compression_busy(&self) {
        lock(&self.compression).jobs[2] += 1;
    }

    pub fn compression_failed(&self) {
        lock(&self.compression).jobs[1] += 1;
    }

    pub fn provider_cache_access(&self, provider: Provider, result: CacheAccess) {
        self.provider_access[provider as usize][result as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn provider_upstream(&self, provider: Provider, result: ProviderUpstream) {
        self.provider_upstream[provider as usize][result as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn provider_upstream_started(self: &Arc<Self>, provider: Provider) -> ProviderUpstreamAttempt {
        ProviderUpstreamAttempt { metrics: Arc::clone(self), provider, finished: false }
    }

    pub fn provider_cache_store(&self, provider: Provider, result: CacheStore) {
        self.provider_store[provider as usize][result as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn provider_store_started(self: &Arc<Self>, provider: Provider) -> ProviderStoreAttempt {
        ProviderStoreAttempt { metrics: Arc::clone(self), provider, finished: false }
    }

    /// Replace the last bounded background inventory snapshot. This is never called from a request path.
    pub fn provider_cache_inventory(
        &self,
        provider: Provider,
        bytes: u64,
        entries: u64,
        oldest_age_seconds: u64,
    ) {
        self.provider_inventory[provider as usize][0].store(bytes, Ordering::Relaxed);
        self.provider_inventory[provider as usize][1].store(entries, Ordering::Relaxed);
        self.provider_inventory[provider as usize][2].store(oldest_age_seconds, Ordering::Relaxed);
    }

    pub fn provider_cache_scan(&self, provider: Provider, success: bool) {
        self.provider_inventory_scan[provider as usize][usize::from(!success)]
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn tmdb_prepared(&self, result: TmdbPrepared) {
        self.tmdb_prepared[result as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn title_query(&self, result: TitleQuery) {
        self.title_metadata[0][result as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn title_publish(&self, result: TitlePublish) {
        self.title_metadata[1][result as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn title_observation(&self, result: TitleObservation) {
        self.title_metadata[2][result as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_library_writes(&self, applied: usize, conflicts: usize) {
        let mut counts = lock(&self.library_writes);
        counts.0 += applied as u64;
        counts.1 += conflicts as u64;
    }

    pub fn record_guest_play_refused(&self, code: &'static str) {
        debug_assert!(GUEST_PLAY_REFUSALS.contains(&code), "{code} is not a rendered label");
        *lock(&self.guest_play_refused).entry(code).or_default() += 1;
    }

    pub fn record_public_media_wide(&self, reason: &'static str, who: &'static str) {
        *lock(&self.public_media_wide).entry((reason, who)).or_default() += 1;
    }

    pub fn record_public_media_hinted(&self, who: &'static str) {
        *lock(&self.public_media_hinted).entry(who).or_default() += 1;
    }

    pub fn record_public_media_hint_rejected(&self, reason: &'static str) {
        debug_assert!(HINT_REJECTIONS.contains(&reason), "{reason} is not a rendered label");
        *lock(&self.public_media_hint_rejected).entry(reason).or_default() += 1;
    }

    pub fn record_public_media_hint_wanted(&self, who: &'static str) {
        *lock(&self.public_media_hint_wanted).entry(who).or_default() += 1;
    }

    pub fn render(&self) -> String {
        let mut out = format!(
            "# HELP den_edge_build_info The running version.\n# TYPE den_edge_build_info gauge\n\
             den_edge_build_info{{version=\"{}\"}} 1\n\
             # HELP den_edge_requests_total Requests answered, by route and status.\n\
             # TYPE den_edge_requests_total counter\n",
            crate::release_version()
        );
        for ((route, status), n) in lock(&self.requests).iter() {
            out.push_str(&format!("den_edge_requests_total{{route=\"{route}\",status=\"{status}\"}} {n}\n"));
        }
        out.push_str(
            "# HELP den_edge_request_admission_active Requests whose handler or response body is live, by class.\n\
             # TYPE den_edge_request_admission_active gauge\n\
             # HELP den_edge_request_admission_high_water Highest simultaneous admitted requests, by class.\n\
             # TYPE den_edge_request_admission_high_water gauge\n\
             # HELP den_edge_request_admission_waited_total Requests that had to wait for admission, by class.\n\
             # TYPE den_edge_request_admission_waited_total counter\n\
             # HELP den_edge_request_admission_refused_total Requests refused after the admission wait, by class.\n\
             # TYPE den_edge_request_admission_refused_total counter\n",
        );
        let admission = lock(&self.request_admission);
        for (class, label) in ["control", "bulk"].into_iter().enumerate() {
            out.push_str(&format!(
                "den_edge_request_admission_active{{class=\"{label}\"}} {}\n\
                 den_edge_request_admission_high_water{{class=\"{label}\"}} {}\n\
                 den_edge_request_admission_waited_total{{class=\"{label}\"}} {}\n\
                 den_edge_request_admission_refused_total{{class=\"{label}\"}} {}\n",
                admission.active[class],
                admission.high_water[class],
                admission.waited[class],
                admission.refused[class]
            ));
        }
        drop(admission);
        let connections = lock(&self.connection_admission);
        out.push_str(&format!(
            "# HELP den_edge_connection_admission_active Accepted HTTP connections currently live.\n\
             # TYPE den_edge_connection_admission_active gauge\n\
             den_edge_connection_admission_active {}\n\
             # HELP den_edge_connection_admission_high_water Highest simultaneous accepted HTTP connections.\n\
             # TYPE den_edge_connection_admission_high_water gauge\n\
             den_edge_connection_admission_high_water {}\n\
             # HELP den_edge_connection_admission_waited_total Times the accept loop waited for connection capacity.\n\
             # TYPE den_edge_connection_admission_waited_total counter\n\
             den_edge_connection_admission_waited_total {}\n",
            connections.active, connections.high_water, connections.waited
        ));
        drop(connections);
        let media = lock(&self.media_admission);
        out.push_str(
            "# HELP den_edge_media_admission_active Admitted media exchanges currently holding capacity, by audience.\n\
             # TYPE den_edge_media_admission_active gauge\n\
             # HELP den_edge_media_admission_high_water Highest simultaneous admitted media exchanges holding capacity, by audience.\n\
             # TYPE den_edge_media_admission_high_water gauge\n\
             # HELP den_edge_media_admission_refused_total Media admissions refused, by bounded resource.\n\
             # TYPE den_edge_media_admission_refused_total counter\n",
        );
        for (audience, label) in ["guest", "member"].into_iter().enumerate() {
            out.push_str(&format!(
                "den_edge_media_admission_active{{audience=\"{label}\"}} {}\n\
                 den_edge_media_admission_high_water{{audience=\"{label}\"}} {}\n",
                media.active[audience], media.high_water[audience]
            ));
        }
        for reason in ["total", "member", "guest", "daily"] {
            let count = media.refused.get(reason).copied().unwrap_or(0);
            out.push_str(&format!("den_edge_media_admission_refused_total{{reason=\"{reason}\"}} {count}\n"));
        }
        drop(media);
        out.push_str(
            "# HELP den_edge_byte_admission_used_bytes Bytes of capacity currently reserved under a fixed memory pool.\n\
             # TYPE den_edge_byte_admission_used_bytes gauge\n\
             # HELP den_edge_byte_admission_high_water_bytes Highest bytes of capacity reserved under a fixed memory pool.\n\
             # TYPE den_edge_byte_admission_high_water_bytes gauge\n\
             # HELP den_edge_byte_admission_waited_total Admissions that waited for byte capacity.\n\
             # TYPE den_edge_byte_admission_waited_total counter\n\
             # HELP den_edge_byte_admission_refused_total Admissions refused for lack of byte capacity.\n\
             # TYPE den_edge_byte_admission_refused_total counter\n",
        );
        let bytes = lock(&self.byte_admission);
        for (pool, label) in BytePool::LABELS.into_iter().enumerate() {
            out.push_str(&format!(
                "den_edge_byte_admission_used_bytes{{pool=\"{label}\"}} {}\n\
                 den_edge_byte_admission_high_water_bytes{{pool=\"{label}\"}} {}\n\
                 den_edge_byte_admission_waited_total{{pool=\"{label}\"}} {}\n\
                 den_edge_byte_admission_refused_total{{pool=\"{label}\"}} {}\n",
                bytes.active[pool], bytes.high_water[pool], bytes.waited[pool], bytes.refused[pool]
            ));
        }
        drop(bytes);
        out.push_str(
            "# HELP den_edge_stream_active Bounded response pumps currently live, by fixed traffic class.\n\
             # TYPE den_edge_stream_active gauge\n\
             # HELP den_edge_stream_high_water Highest simultaneous response pumps, by fixed traffic class.\n\
             # TYPE den_edge_stream_high_water gauge\n\
             # HELP den_edge_stream_retained_bytes Logical bytes in body frames retained by den-edge; backing allocations may be shared.\n\
             # TYPE den_edge_stream_retained_bytes gauge\n\
             # HELP den_edge_stream_retained_high_water_bytes Highest logical bytes in retained body frames; backing allocations may be shared.\n\
             # TYPE den_edge_stream_retained_high_water_bytes gauge\n\
             # HELP den_edge_stream_terminated_total Streams terminated before normal completion, by bounded reason.\n\
             # TYPE den_edge_stream_terminated_total counter\n",
        );
        let streams = lock(&self.streams);
        for (class, label) in StreamClass::LABELS.into_iter().enumerate() {
            out.push_str(&format!(
                "den_edge_stream_active{{class=\"{label}\"}} {}\n\
                 den_edge_stream_high_water{{class=\"{label}\"}} {}\n\
                 den_edge_stream_retained_bytes{{class=\"{label}\"}} {}\n\
                 den_edge_stream_retained_high_water_bytes{{class=\"{label}\"}} {}\n",
                streams.active[class],
                streams.high_water[class],
                streams.retained[class],
                streams.retained_high_water[class]
            ));
            for (reason, reason_label) in StreamTermination::LABELS.into_iter().enumerate() {
                out.push_str(&format!(
                    "den_edge_stream_terminated_total{{class=\"{label}\",reason=\"{reason_label}\"}} {}\n",
                    streams.terminated[class][reason]
                ));
            }
        }
        drop(streams);
        let compression = lock(&self.compression);
        out.push_str(&format!(
            "# HELP den_edge_compression_active Library gzip jobs currently running.\n\
             # TYPE den_edge_compression_active gauge\n\
             den_edge_compression_active {}\n\
             # HELP den_edge_compression_high_water Highest simultaneous library gzip jobs.\n\
             # TYPE den_edge_compression_high_water gauge\n\
             den_edge_compression_high_water {}\n\
             # HELP den_edge_compression_jobs_total Library gzip attempts by bounded outcome.\n\
             # TYPE den_edge_compression_jobs_total counter\n\
             den_edge_compression_jobs_total{{kind=\"library_gzip\",outcome=\"success\"}} {}\n\
             den_edge_compression_jobs_total{{kind=\"library_gzip\",outcome=\"failed\"}} {}\n\
             den_edge_compression_jobs_total{{kind=\"library_gzip\",outcome=\"busy\"}} {}\n\
             # HELP den_edge_compression_input_bytes_total Uncompressed bytes accepted by successful gzip jobs.\n\
             # TYPE den_edge_compression_input_bytes_total counter\n\
             den_edge_compression_input_bytes_total{{kind=\"library_gzip\"}} {}\n\
             # HELP den_edge_compression_output_bytes_total Compressed bytes produced by successful gzip jobs.\n\
             # TYPE den_edge_compression_output_bytes_total counter\n\
             den_edge_compression_output_bytes_total{{kind=\"library_gzip\"}} {}\n",
            compression.active,
            compression.high_water,
            compression.jobs[0],
            compression.jobs[1],
            compression.jobs[2],
            compression.input_bytes,
            compression.output_bytes
        ));
        drop(compression);
        out.push_str(
            "# HELP den_edge_provider_cache_access_total Provider-cache lookups by bounded semantic result.\n\
             # TYPE den_edge_provider_cache_access_total counter\n\
             # HELP den_edge_provider_upstream_total Actual provider exchanges by bounded outcome.\n\
             # TYPE den_edge_provider_upstream_total counter\n\
             # HELP den_edge_provider_cache_store_total Provider-cache persistence decisions by bounded outcome.\n\
             # TYPE den_edge_provider_cache_store_total counter\n\
             # HELP den_edge_provider_cache_bytes Regular-file bytes in the last background inventory.\n\
             # TYPE den_edge_provider_cache_bytes gauge\n\
             # HELP den_edge_provider_cache_entries Serveable JSON bodies in the last background inventory.\n\
             # TYPE den_edge_provider_cache_entries gauge\n\
             # HELP den_edge_provider_cache_oldest_age_seconds Age of the oldest serveable JSON body in the last complete background inventory.\n\
             # TYPE den_edge_provider_cache_oldest_age_seconds gauge\n\
             # HELP den_edge_provider_cache_scan_total Background provider-cache inventories by bounded outcome.\n\
             # TYPE den_edge_provider_cache_scan_total counter\n",
        );
        for (provider, provider_label) in Provider::LABELS.into_iter().enumerate() {
            for (result, result_label) in CacheAccess::LABELS.into_iter().enumerate() {
                let n = self.provider_access[provider][result].load(Ordering::Relaxed);
                out.push_str(&format!(
                    "den_edge_provider_cache_access_total{{provider=\"{provider_label}\",result=\"{result_label}\"}} {n}\n"
                ));
            }
            for (result, result_label) in ProviderUpstream::LABELS.into_iter().enumerate() {
                let n = self.provider_upstream[provider][result].load(Ordering::Relaxed);
                out.push_str(&format!(
                    "den_edge_provider_upstream_total{{provider=\"{provider_label}\",result=\"{result_label}\"}} {n}\n"
                ));
            }
            for (result, result_label) in CacheStore::LABELS.into_iter().enumerate() {
                let n = self.provider_store[provider][result].load(Ordering::Relaxed);
                out.push_str(&format!(
                    "den_edge_provider_cache_store_total{{provider=\"{provider_label}\",result=\"{result_label}\"}} {n}\n"
                ));
            }
            let bytes = self.provider_inventory[provider][0].load(Ordering::Relaxed);
            let entries = self.provider_inventory[provider][1].load(Ordering::Relaxed);
            let oldest_age = self.provider_inventory[provider][2].load(Ordering::Relaxed);
            out.push_str(&format!(
                "den_edge_provider_cache_bytes{{provider=\"{provider_label}\"}} {bytes}\n\
                 den_edge_provider_cache_entries{{provider=\"{provider_label}\"}} {entries}\n\
                 den_edge_provider_cache_oldest_age_seconds{{provider=\"{provider_label}\"}} {oldest_age}\n"
            ));
            for (outcome, outcome_label) in ["success", "failed"].into_iter().enumerate() {
                let n = self.provider_inventory_scan[provider][outcome].load(Ordering::Relaxed);
                out.push_str(&format!(
                    "den_edge_provider_cache_scan_total{{provider=\"{provider_label}\",outcome=\"{outcome_label}\"}} {n}\n"
                ));
            }
        }
        out.push_str(
            "# HELP den_edge_tmdb_prepared_total TMDB prepared-response reuse and build outcomes.\n\
             # TYPE den_edge_tmdb_prepared_total counter\n",
        );
        for (result, label) in TmdbPrepared::LABELS.into_iter().enumerate() {
            let n = self.tmdb_prepared[result].load(Ordering::Relaxed);
            out.push_str(&format!("den_edge_tmdb_prepared_total{{result=\"{label}\"}} {n}\n"));
        }
        for (metric, name) in ["query", "publish"].into_iter().enumerate() {
            out.push_str(&format!(
                "# HELP den_edge_title_metadata_{name}_total Title-metadata {name} outcomes.\n\
                 # TYPE den_edge_title_metadata_{name}_total counter\n"
            ));
            for (result, label) in TITLE_METADATA_LABELS[metric].iter().enumerate() {
                let n = self.title_metadata[metric][result].load(Ordering::Relaxed);
                out.push_str(&format!("den_edge_title_metadata_{name}_total{{result=\"{label}\"}} {n}\n"));
            }
        }
        for (name, range) in [("observation_admission", 0..4), ("observation_completion", 4..7)] {
            out.push_str(&format!(
                "# HELP den_edge_title_metadata_{name}_total Title-metadata {name} outcomes.\n\
                 # TYPE den_edge_title_metadata_{name}_total counter\n"
            ));
            for result in range {
                let label = TITLE_METADATA_LABELS[2][result];
                let n = self.title_metadata[2][result].load(Ordering::Relaxed);
                out.push_str(&format!("den_edge_title_metadata_{name}_total{{result=\"{label}\"}} {n}\n"));
            }
        }
        let (applied, conflicts) = *lock(&self.library_writes);
        out.push_str(&format!(
            "# HELP den_edge_library_writes_total Record-log writes, applied or refused as stale.\n\
             # TYPE den_edge_library_writes_total counter\n\
             den_edge_library_writes_total{{outcome=\"applied\"}} {applied}\n\
             den_edge_library_writes_total{{outcome=\"conflict\"}} {conflicts}\n"
        ));
        out.push_str(
            "# HELP den_edge_guest_play_refused_total Invited guests' plays refused at session start, by code.\n\
             # TYPE den_edge_guest_play_refused_total counter\n",
        );
        let refused = lock(&self.guest_play_refused);
        for code in GUEST_PLAY_REFUSALS {
            let n = refused.get(code).copied().unwrap_or(0);
            out.push_str(&format!("den_edge_guest_play_refused_total{{code=\"{code}\"}} {n}\n"));
        }
        out.push_str(
            "# HELP den_edge_public_media_wide_total Media listeners opened wide, by reason and by who asked.\n\
             # TYPE den_edge_public_media_wide_total counter\n",
        );
        let wide = lock(&self.public_media_wide);
        for reason in ["cast", "ipv6"] {
            for who in ["member", "guest"] {
                let n = wide.get(&(reason, who)).copied().unwrap_or(0);
                out.push_str(&format!(
                    "den_edge_public_media_wide_total{{reason=\"{reason}\",who=\"{who}\"}} {n}\n"
                ));
            }
        }
        out.push_str(
            "# HELP den_edge_public_media_hinted_total Media listeners opened for an IPv6 visitor's reported IPv4 \
             address instead of wide, by who asked.\n\
             # TYPE den_edge_public_media_hinted_total counter\n",
        );
        let hinted = lock(&self.public_media_hinted);
        for who in ["member", "guest", "reel"] {
            let n = hinted.get(who).copied().unwrap_or(0);
            out.push_str(&format!("den_edge_public_media_hinted_total{{who=\"{who}\"}} {n}\n"));
        }
        out.push_str(
            "# HELP den_edge_public_media_hint_rejected_total IPv4 hints not used, by reason.\n\
             # TYPE den_edge_public_media_hint_rejected_total counter\n",
        );
        let rejected = lock(&self.public_media_hint_rejected);
        for reason in HINT_REJECTIONS {
            let n = rejected.get(reason).copied().unwrap_or(0);
            out.push_str(&format!("den_edge_public_media_hint_rejected_total{{reason=\"{reason}\"}} {n}\n"));
        }
        out.push_str(
            "# HELP den_edge_public_media_hint_wanted_total IPv6 visitors' session starts sent back for an IPv4 \
             hint, by who asked.\n\
             # TYPE den_edge_public_media_hint_wanted_total counter\n",
        );
        let wanted = lock(&self.public_media_hint_wanted);
        for who in ["member", "guest", "reel"] {
            let n = wanted.get(who).copied().unwrap_or(0);
            out.push_str(&format!("den_edge_public_media_hint_wanted_total{{who=\"{who}\"}} {n}\n"));
        }
        drop(wanted);
        let mmap = lock(&self.mmap);
        out.push_str(
            "# HELP den_edge_mmap_total Exact-file mmap decisions by fixed outcome.\n\
             # TYPE den_edge_mmap_total counter\n",
        );
        for (index, outcome) in MMAP_OUTCOMES.into_iter().enumerate() {
            out.push_str(&format!("den_edge_mmap_total{{outcome=\"{outcome}\"}} {}\n", mmap.outcomes[index]));
        }
        out.push_str(
            "# HELP den_edge_mmap_faults_total Mapping build failures by fixed cause.\n\
             # TYPE den_edge_mmap_faults_total counter\n",
        );
        for (index, reason) in MMAP_FAULTS.into_iter().enumerate() {
            out.push_str(&format!(
                "den_edge_mmap_faults_total{{reason=\"{reason}\"}} {}\n",
                mmap.faults[index]
            ));
        }
        out.push_str(&format!(
            "# HELP den_edge_mmap_resident_bytes Bytes charged to live mappings, cached or response-owned.\n\
             # TYPE den_edge_mmap_resident_bytes gauge\n\
             den_edge_mmap_resident_bytes {}\n\
             # HELP den_edge_mmap_resident_count Live mappings, cached or response-owned.\n\
             # TYPE den_edge_mmap_resident_count gauge\n\
             den_edge_mmap_resident_count {}\n\
             # HELP den_edge_mmap_resident_high_water_bytes Highest live mapped bytes.\n\
             # TYPE den_edge_mmap_resident_high_water_bytes gauge\n\
             den_edge_mmap_resident_high_water_bytes {}\n\
             # HELP den_edge_mmap_cached_bytes Bytes retained by the reusable mapping cache.\n\
             # TYPE den_edge_mmap_cached_bytes gauge\n\
             den_edge_mmap_cached_bytes {}\n\
             # HELP den_edge_mmap_cached_count Mappings retained by the reusable mapping cache.\n\
             # TYPE den_edge_mmap_cached_count gauge\n\
             den_edge_mmap_cached_count {}\n",
            mmap.resident_bytes,
            mmap.resident_count,
            mmap.resident_high_water_bytes,
            mmap.cached_bytes,
            mmap.cached_count,
        ));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bounded_metric_series_is_rendered_even_at_zero() {
        let rendered = Metrics::default().render();
        for row in [
            r#"den_edge_byte_admission_used_bytes{pool="relay_collect"} 0"#,
            r#"den_edge_byte_admission_refused_total{pool="tmdb_derived"} 0"#,
            r#"den_edge_stream_retained_bytes{class="addon"} 0"#,
            r#"den_edge_stream_terminated_total{class="media",reason="receiver_idle"} 0"#,
            r#"den_edge_stream_terminated_total{class="addon",reason="receiver_closed"} 0"#,
            r#"den_edge_compression_jobs_total{kind="library_gzip",outcome="busy"} 0"#,
            r#"den_edge_provider_cache_access_total{provider="tmdb",result="fresh"} 0"#,
            r#"den_edge_provider_upstream_total{provider="ratings",result="failed"} 0"#,
            r#"den_edge_provider_cache_store_total{provider="warnings",result="expired"} 0"#,
            r#"den_edge_provider_cache_bytes{provider="skipdb"} 0"#,
            r#"den_edge_provider_cache_entries{provider="tmdb"} 0"#,
            r#"den_edge_provider_cache_oldest_age_seconds{provider="tmdb"} 0"#,
            r#"den_edge_provider_cache_scan_total{provider="tmdb",outcome="failed"} 0"#,
            r#"den_edge_tmdb_prepared_total{result="transient_built"} 0"#,
            r#"den_edge_title_metadata_observation_admission_total{result="busy"} 0"#,
            r#"den_edge_title_metadata_observation_completion_total{result="stored"} 0"#,
        ] {
            assert!(rendered.contains(row), "missing {row}");
        }
    }

    #[test]
    fn retained_byte_gauges_follow_their_real_owners() {
        let metrics = Arc::new(Metrics::default());
        let admission = metrics.byte_admitted(BytePool::RelayCollect, 4096, true);
        let stream = metrics.stream_started(StreamClass::Addon);
        let bytes = metrics.stream_bytes(StreamClass::Addon, Bytes::from_static(b"frame"));
        let clone = bytes.clone();
        let rendered = metrics.render();
        assert!(rendered.contains(r#"den_edge_byte_admission_used_bytes{pool="relay_collect"} 4096"#));
        assert!(rendered.contains(r#"den_edge_stream_active{class="addon"} 1"#));
        assert!(rendered.contains(r#"den_edge_stream_retained_bytes{class="addon"} 5"#));
        drop(bytes);
        assert!(metrics.render().contains(r#"den_edge_stream_retained_bytes{class="addon"} 5"#));
        drop(clone);
        drop(stream);
        drop(admission);
        let rendered = metrics.render();
        assert!(rendered.contains(r#"den_edge_byte_admission_used_bytes{pool="relay_collect"} 0"#));
        assert!(rendered.contains(r#"den_edge_stream_active{class="addon"} 0"#));
        assert!(rendered.contains(r#"den_edge_stream_retained_bytes{class="addon"} 0"#));
    }

    #[test]
    fn counters_accept_only_fixed_enum_values() {
        let metrics = Arc::new(Metrics::default());
        metrics.provider_cache_access(Provider::Tmdb, CacheAccess::Fresh);
        metrics.provider_upstream(Provider::Ratings, ProviderUpstream::Failed);
        metrics.provider_cache_store(Provider::Warnings, CacheStore::Expired);
        metrics.provider_cache_inventory(Provider::Skipdb, 8192, 7, 3600);
        metrics.provider_cache_scan(Provider::Skipdb, true);
        metrics.tmdb_prepared(TmdbPrepared::FileBuilt);
        metrics.stream_terminated(StreamClass::Media, StreamTermination::Lifetime);
        metrics.compression_busy();
        let job = metrics.compression_started();
        job.finished(100, Some(60));
        let rendered = metrics.render();
        for row in [
            r#"den_edge_provider_cache_access_total{provider="tmdb",result="fresh"} 1"#,
            r#"den_edge_provider_upstream_total{provider="ratings",result="failed"} 1"#,
            r#"den_edge_provider_cache_store_total{provider="warnings",result="expired"} 1"#,
            r#"den_edge_provider_cache_bytes{provider="skipdb"} 8192"#,
            r#"den_edge_provider_cache_entries{provider="skipdb"} 7"#,
            r#"den_edge_provider_cache_oldest_age_seconds{provider="skipdb"} 3600"#,
            r#"den_edge_provider_cache_scan_total{provider="skipdb",outcome="success"} 1"#,
            r#"den_edge_tmdb_prepared_total{result="file_built"} 1"#,
            r#"den_edge_stream_terminated_total{class="media",reason="lifetime"} 1"#,
            r#"den_edge_compression_jobs_total{kind="library_gzip",outcome="success"} 1"#,
        ] {
            assert!(rendered.contains(row), "missing {row}");
        }
    }
}
