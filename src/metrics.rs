//! `/metrics`: requests by route and status, in Prometheus text, behind the bearer token every den service
//! uses. Routes are the fixed labels from `handler::route_label`, so no key ever becomes a label.

use crate::lock;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Metrics {
    requests: Mutex<BTreeMap<(&'static str, u16), u64>>,
    request_admission: Mutex<RequestAdmission>,
    connection_admission: Mutex<ConnectionAdmission>,
    media_admission: Mutex<MediaAdmissionState>,
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
}

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
            env!("CARGO_PKG_VERSION")
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
        for who in ["member", "guest"] {
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
        for who in ["member", "guest"] {
            let n = wanted.get(who).copied().unwrap_or(0);
            out.push_str(&format!("den_edge_public_media_hint_wanted_total{{who=\"{who}\"}} {n}\n"));
        }
        out
    }
}
