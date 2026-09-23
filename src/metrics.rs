//! `/metrics`: requests by route and status, in Prometheus text, behind the bearer token every den service
//! uses. Routes are the fixed labels from `handler::route_label`, so no key ever becomes a label.

use crate::lock;
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct Metrics {
    requests: Mutex<BTreeMap<(&'static str, u16), u64>>,
    /// Record-log writes applied, and refused as stale — a rising share of conflicts means devices are fighting
    /// over rows (or one keeps writing from an old base).
    library_writes: Mutex<(u64, u64)>,
    /// An invited guest's play refused at session start, by the refusal's code (one of `GUEST_PLAY_REFUSALS`):
    /// how often each known limit is met, IPv6 above all, before anything bigger is built for it.
    guest_play_refused: Mutex<BTreeMap<&'static str, u64>>,
    /// Media listeners opened wide (to more than the visitor's own address), by reason (`cast`, `ipv6`) and by
    /// who asked (`member`, `guest`). A guest is never given the wide scope, so its rows stay 0.
    public_media_wide: Mutex<BTreeMap<(&'static str, &'static str), u64>>,
}

/// The codes a guest's session start can be refused with, each always rendered, so a limit never met reads 0.
pub const GUEST_PLAY_REFUSALS: [&str; 6] = [
    "public_media_cast",
    "public_media_ipv6",
    "public_media_unavailable",
    "public_listener_unavailable",
    "relay_busy",
    "too_many_sources",
];

impl Metrics {
    pub fn record(&self, route: &'static str, status: u16) {
        *lock(&self.requests).entry((route, status)).or_default() += 1;
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
        out
    }
}
