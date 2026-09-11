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
}

impl Metrics {
    pub fn record(&self, route: &'static str, status: u16) {
        *lock(&self.requests).entry((route, status)).or_default() += 1;
    }

    pub fn record_library_writes(&self, applied: usize, conflicts: usize) {
        let mut counts = lock(&self.library_writes);
        counts.0 += applied as u64;
        counts.1 += conflicts as u64;
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
        out
    }
}
