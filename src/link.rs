//! `DELETE /link` — unlinking a device erases what its link left here. Links are made by pairing (`pair.rs`); the
//! six-character codes this module once minted are retired. The per-address throttle that code guesses count
//! against lives here too.

use crate::handler::{error, internal, json_reply, link_key, method_not_allowed, valid_inbox_key};
use crate::{lock, AppState};
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::json;

/// No 0/O or 1/I. Thirty-two symbols, so `byte & 31` picks one without bias.
pub(crate) const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Guesses per client address per minute: a pairing's nameplate is only four characters.
pub(crate) const CLAIMS_PER_WINDOW: u32 = 20;
const CLAIM_WINDOW_MS: u64 = 60 * 1000;
/// All live per-visitor rate-limit identities together, a bound on the map's memory. Public callers can present many
/// legitimate source addresses, and sweeping expired entries is not a bound while their windows overlap.
const MAX_THROTTLE_BUCKETS: usize = 8 * 1024;
/// The entries one IPv6 /48 may hold in a per-visitor table: a household's /64 holds a few dozen (one per route).
pub(crate) const MAX_PER_PREFIX: usize = 256;
/// Budgets that are not per visitor (`is_global`) are few by construction, except a caller's own warnings key: this
/// bounds them, and they expire within their minute.
const MAX_GLOBAL_BUCKETS: usize = 16 * 1024;

use std::collections::{HashMap, HashSet};

pub struct Throttle {
    count: u32,
    until: u64,
    /// The limit the last request was counted against: an entry at it is refusing, and is the last to be evicted.
    limit: u32,
    /// The prefix (`prefix_of`) it is filed under.
    prefix: String,
}

impl Throttle {
    fn refusing(&self, now: u64) -> bool {
        self.until > now && self.count >= self.limit
    }
}

/// Budgets that name no visitor: an upstream's quota (`skipdb:upstream`, `tmdb:preview`, `warnings:upstream:*`), a
/// grant's or an MCP session's allowance, a refused-status log. A flood of new visitors must never reset them, so they
/// live in `AppState::global_claims`, which never evicts.
pub(crate) fn is_global(bucket: &str) -> bool {
    matches!(bucket, "skipdb:upstream" | "tmdb:preview")
        || ["warnings:upstream:", "relay-grant:", "mcp:", "tmdb-refused:"]
            .iter()
            .any(|p| bucket.starts_with(p))
}

/// The prefix a per-visitor budget is capped by: an IPv6 key (`…:<2001:db8:1:2::>/64`, from `rate_limit_key`) by its
/// /48; anything else by the key's own address, which leaves IPv4 ungrouped — addresses are scarce, and a /24 is often
/// many households behind one carrier.
fn prefix_of(bucket: &str) -> String {
    if let Some(head) = bucket.strip_suffix("/64") {
        // `rate_limit_key` writes a /64 with its low half zeroed, so at most four groups precede the closing `::`.
        // A bucket's own name may hold colons too: the address is the longest tail of that shape that parses.
        let starts = std::iter::once(0).chain(head.match_indices(':').map(|(at, _)| at + 1));
        for start in starts {
            let tail = &head[start..];
            let groups = tail.strip_suffix("::").map(|g| g.split(':').count());
            if groups.is_some_and(|n| n <= 4) {
                if let Ok(addr) = tail.parse::<std::net::Ipv6Addr>() {
                    let s = addr.segments();
                    return format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2]);
                }
            }
        }
    }
    bucket.rsplit(':').next().unwrap_or(bucket).to_owned()
}

/// One table of budgets: the shared per-visitor one (`AppState::claims`), recovery's (`AppState::recovery_claims`),
/// or the global one (`AppState::global_claims`, built with `global`).
///
/// A full per-visitor table never refuses a newcomer for that reason (den-spec recovery §5): that made a full table a
/// limit on everyone, which anyone holding a few thousand IPv6 /64s could keep full. Instead:
/// - expired entries go first;
/// - one IPv6 /48 holds at most `MAX_PER_PREFIX` entries, and a newcomer from a /48 at its share is refused — that
///   /48 alone, which is what bounds a round-robin over its /64s;
/// - past that, a newcomer evicts an entry (`victim`): never one that is refusing while one that is not exists, so a
///   flood cannot free a bucket that is holding a caller back; then one of the prefix holding the most, so a flood
///   displaces its own entries before anyone else's; then the lowest count.
pub struct Throttles {
    map: HashMap<String, Throttle>,
    prefixes: HashMap<String, HashSet<String>>,
    capacity: usize,
    /// Never evicts: its budgets are not per visitor. Full, it refuses a new global budget.
    global: bool,
    /// The size past which the next count sweeps out the expired entries: twice what the last sweep left. Swept at
    /// every count once past a fixed 1024, a map holding that many live budgets was scanned whole on every request.
    sweep_above: usize,
    /// A full table is attacker-reachable. Do not turn each novel address into an O(table) expiry scan.
    capacity_sweep_after: u64,
}

impl Default for Throttles {
    fn default() -> Self {
        Self::with_capacity(MAX_THROTTLE_BUCKETS)
    }
}

impl Throttles {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            map: HashMap::new(),
            prefixes: HashMap::new(),
            capacity,
            global: false,
            sweep_above: 0,
            capacity_sweep_after: 0,
        }
    }

    /// The table for `is_global` budgets.
    pub fn global() -> Self {
        Self { global: true, ..Self::with_capacity(MAX_GLOBAL_BUCKETS) }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    #[cfg(test)]
    pub fn holds(&self, bucket: &str) -> bool {
        self.map.contains_key(bucket)
    }

    fn remove(&mut self, bucket: &str) {
        if let Some(gone) = self.map.remove(bucket) {
            if let Some(keys) = self.prefixes.get_mut(&gone.prefix) {
                keys.remove(bucket);
                if keys.is_empty() {
                    self.prefixes.remove(&gone.prefix);
                }
            }
        }
    }

    fn sweep(&mut self, now: u64) {
        let expired: Vec<String> =
            self.map.iter().filter(|(_, t)| t.until <= now).map(|(k, _)| k.clone()).collect();
        for key in expired {
            self.remove(&key);
        }
        self.sweep_above = self.map.len() * 2;
    }

    /// The entry to evict from a full table: never one that is refusing while one that is not exists; then one of
    /// the prefix holding the most (a flood's own); then the lowest count; then the nearest expiry.
    fn victim(&self, now: u64) -> Option<String> {
        self.map
            .iter()
            .min_by_key(|(_, t)| {
                let held = self.prefixes.get(&t.prefix).map_or(0, HashSet::len);
                (t.refusing(now), std::cmp::Reverse(held), t.count, t.until)
            })
            .map(|(k, _)| k.clone())
    }

    /// The budget `bucket` counts in, made room for; `None` when it cannot be: its /48 is at its share, or the global
    /// table is full. Only that /48, or that new global budget, is refused.
    fn entry(&mut self, bucket: &str, limit: u32, now: u64) -> Option<&mut Throttle> {
        if !self.map.contains_key(bucket) {
            let at_capacity = self.map.len() >= self.capacity;
            if self.map.len() > self.sweep_above.max(1024)
                || (at_capacity && now >= self.capacity_sweep_after)
            {
                self.sweep(now);
                if at_capacity {
                    self.capacity_sweep_after = now.saturating_add(1_000);
                }
            }
            let prefix = if self.global { String::new() } else { prefix_of(bucket) };
            if !self.global {
                if self.prefixes.get(&prefix).is_some_and(|keys| keys.len() >= MAX_PER_PREFIX) {
                    // Its own expired entries first; then the /48 waits for one of its windows to close.
                    let expired: Vec<String> = self.prefixes[&prefix]
                        .iter()
                        .filter(|k| self.map.get(*k).is_some_and(|t| t.until <= now))
                        .cloned()
                        .collect();
                    if expired.is_empty() {
                        return None;
                    }
                    for key in expired {
                        self.remove(&key);
                    }
                }
                if self.map.len() >= self.capacity {
                    if let Some(key) = self.victim(now) {
                        self.remove(&key);
                    }
                }
            } else if self.map.len() >= self.capacity {
                return None;
            }
            self.prefixes.entry(prefix.clone()).or_default().insert(bucket.to_owned());
            self.map.insert(bucket.to_owned(), Throttle { count: 0, until: 0, limit, prefix });
        }
        let t = self.map.get_mut(bucket).expect("present or just added");
        t.limit = limit;
        Some(t)
    }
}

/// The table `bucket` counts in.
fn table_for<'a>(state: &'a AppState, bucket: &str) -> &'a std::sync::Mutex<Throttles> {
    if is_global(bucket) {
        &state.global_claims
    } else {
        &state.claims
    }
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    match req.uri().path() {
        "/link" if req.method() == Method::DELETE => forget(state, link_key(&req)).await,
        "/link" => method_not_allowed(),
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

/// Unlinking a device erases what its link left here — its inbox, and the plugins and settings it shared — so a
/// device the TV no longer trusts can't read or add to them (issue #8, N3). Idempotent.
async fn forget(state: &AppState, key: String) -> Response {
    if !valid_inbox_key(&key) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_inbox_key"));
    }
    let _write = state.write_lock.lock().await;
    for ns in ["inbox", "plugins", "settings"] {
        if let Err(e) = state.store.delete(ns, &key).await {
            return internal("link forget", e);
        }
    }
    json_reply(StatusCode::OK, &json!({ "forgotten": true }))
}

/// Counts a guess from `ip`; `Some(ms)` once it is over the pairing limit.
pub(crate) fn throttled(state: &AppState, ip: &str) -> Option<u64> {
    throttled_at(state, ip, CLAIMS_PER_WINDOW)
}

/// Counts one act against `bucket`'s own budget; true once it is over `limit`. A blocked attempt doesn't extend
/// the window, an allowed one does — so a steady stream stays blocked and the window clears once it stops.
///
/// That makes it a guard against guessing and filling (pairing's nameplates, grant codes, new inbox queues), where
/// nobody legitimate keeps asking. It is not "`limit` a minute": at two a minute a caller that never pauses for a
/// whole minute is refused at its `limit`th. A budget meant as a rate — browsing, a player's segments — is
/// `throttled_per_minute`.
///
/// `bucket` is the whole key, so a caller prefixes what it is limiting (`relay:<ip>`, `inbox:<ip>`) and each
/// budget counts on its own: browsing the relay hard must not spend the pairing allowance, and the other way
/// about. All of them share the one map, and so the one sweep that keeps it bounded.
/// `None` while the caller is within its budget; `Some(ms)` once it is over, carrying how long until the
/// window clears.
///
/// The time is the whole point. A limit that says only "no" leaves the caller to guess when to come back, and
/// every client here guessed the same way — a fixed few seconds, forever — which turns one refusal into a
/// steady knock against a door that was going to open on its own.
pub(crate) fn throttled_at(state: &AppState, bucket: &str, limit: u32) -> Option<u64> {
    throttled_by(state, bucket, limit, 1)
}

/// `throttled_at` for an act that costs `cost` of the budget at once — a drain of several queues costs one per
/// queue. Refused whole when it does not fit, and then it spends nothing.
pub(crate) fn throttled_by(state: &AppState, bucket: &str, limit: u32, cost: u32) -> Option<u64> {
    let now = state.now();
    let mut claims = lock(table_for(state, bucket));
    let Some(t) = claims.entry(bucket, limit, now) else { return Some(CLAIM_WINDOW_MS) };
    if t.until <= now {
        t.count = 0;
    }
    if t.count.saturating_add(cost) > limit {
        return Some(t.until.saturating_sub(now));
    }
    t.count += cost;
    t.until = now + CLAIM_WINDOW_MS;
    None
}

/// `limit` a minute in fixed windows: a window opens at its first request and closes a minute later, whatever came
/// in it. For a steady caller — an assistant's MCP calls, a TV's drains, a browser's relayed and proxied questions, a
/// player's segments — where `throttled_at`, whose window moves on with every request allowed, would never close
/// and refuse it for good once it passed the limit.
pub(crate) fn throttled_per_minute(state: &AppState, bucket: &str, limit: u32) -> Option<u64> {
    throttled_per_minute_by(state, bucket, limit, 1)
}

/// `throttled_per_minute` for an act that costs `cost` of the budget at once. Refused whole when it does not fit,
/// and then it spends nothing.
pub(crate) fn throttled_per_minute_by(state: &AppState, bucket: &str, limit: u32, cost: u32) -> Option<u64> {
    throttled_window(table_for(state, bucket), state.now(), bucket, limit, cost, CLAIM_WINDOW_MS)
}

/// `throttled_per_minute` in `table`, with a window of `window_ms`: recovery counts in its own table, its opens per
/// ten minutes and per day.
pub(crate) fn throttled_in_window(
    table: &std::sync::Mutex<Throttles>,
    now: u64,
    bucket: &str,
    limit: u32,
    window_ms: u64,
) -> Option<u64> {
    throttled_window(table, now, bucket, limit, 1, window_ms)
}

fn throttled_window(
    table: &std::sync::Mutex<Throttles>,
    now: u64,
    bucket: &str,
    limit: u32,
    cost: u32,
    window_ms: u64,
) -> Option<u64> {
    let mut claims = lock(table);
    let Some(t) = claims.entry(bucket, limit, now) else { return Some(window_ms) };
    if t.until <= now {
        t.count = 0;
        t.until = now + window_ms;
    }
    if t.count.saturating_add(cost) > limit {
        return Some(t.until.saturating_sub(now));
    }
    t.count += cost;
    None
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;

    #[tokio::test]
    async fn unlinking_erases_what_the_link_left_behind() {
        let h = Harness::new();
        let key = "abcdef0123456789";
        let link = [("x-den-link", key)];
        h.send("POST", "/inbox/append", Some(json!({ "sealed": "AAECAw" }).to_string()), &link).await;
        // What an older link shared, before those routes were retired.
        h.state.store.put("plugins", key, b"{}").await.unwrap();
        h.state.store.put("settings", key, b"{}").await.unwrap();

        assert_eq!(h.send("DELETE", "/link", None, &link).await.status(), StatusCode::OK);
        assert_eq!(h.state.store.get("plugins", key).await.unwrap(), None);
        assert_eq!(h.state.store.get("settings", key).await.unwrap(), None);
        let drained =
            crate::handler::tests::body_json(h.send("GET", "/inbox/drain", None, &link).await).await;
        assert_eq!(drained["messages"], json!([]));
        assert_eq!(h.send("DELETE", "/link", None, &link).await.status(), StatusCode::OK, "again is fine");
        assert_eq!(h.send("DELETE", "/link", None, &[]).await.status(), StatusCode::BAD_REQUEST);
    }

    /// The expired budgets are swept once the map has doubled since the last sweep, not on every count once past
    /// 1024: a sweep that finds everything still live would otherwise run again at the very next request.
    #[tokio::test]
    async fn the_budget_map_is_swept_only_once_it_has_doubled() {
        let h = Harness::new();
        for i in 0..1500 {
            assert!(super::throttled_at(&h.state, &format!("b:{i}"), 1).is_none());
        }
        let sweep_above = crate::lock(&h.state.claims).sweep_above;
        assert_eq!(sweep_above, 2050, "one sweep at 1025, which found all of them live");
        h.advance(super::CLAIM_WINDOW_MS);
        for i in 1500..2051 {
            super::throttled_at(&h.state, &format!("b:{i}"), 1);
        }
        assert_eq!(crate::lock(&h.state.claims).map.len(), 2051, "not swept yet");
        super::throttled_at(&h.state, "b:last", 1);
        assert_eq!(crate::lock(&h.state.claims).map.len(), 552, "the 1500 expired ones gone at the next");
    }

    /// `relay:<the IPv6 /64 of /48 number p, /64 number s>`, as `rate_limit_key` writes it.
    fn v6(p: usize, s: usize) -> String {
        format!("relay:2001:db8:{p:x}:{s:x}::/64")
    }

    /// Fills the shared table from `prefixes` /48s, each at its share, one request per /64.
    fn flood(h: &Harness, prefixes: std::ops::Range<usize>) {
        for p in prefixes {
            for s in 0..super::MAX_PER_PREFIX {
                super::throttled_per_minute(&h.state, &v6(p, s), 100);
            }
        }
    }

    #[test]
    fn a_bucket_is_capped_by_its_ipv6_slash_48() {
        assert_eq!(super::prefix_of("relay:2001:db8:1:2::/64"), "2001:db8:1::/48");
        assert_eq!(super::prefix_of("2001:db8:1:2::/64"), "2001:db8:1::/48");
        assert_eq!(super::prefix_of("warnings:x:2001:db8:a:ffff::/64"), "2001:db8:a::/48");
        assert_eq!(super::prefix_of("relay:203.0.113.7"), "203.0.113.7", "IPv4 is not grouped");
        assert!(super::is_global("tmdb:preview") && super::is_global("warnings:upstream:household"));
        assert!(!super::is_global("tmdb:203.0.113.7"));
    }

    /// The map stays bounded; a full one admits a newcomer from a new prefix, and existing callers of other prefixes
    /// are not displaced by the flood — the flood's own entries go first.
    #[test]
    fn a_full_table_admits_newcomers_without_displacing_existing_callers() {
        let h = Harness::new();
        let household: Vec<String> = (0..5).map(|n| format!("route{n}:203.0.113.7")).collect();
        for key in &household {
            assert!(super::throttled_per_minute(&h.state, key, 100).is_none());
        }
        let prefixes = super::MAX_THROTTLE_BUCKETS / super::MAX_PER_PREFIX + 2;
        flood(&h, 0..prefixes);
        let claims = crate::lock(&h.state.claims);
        assert_eq!(claims.len(), super::MAX_THROTTLE_BUCKETS, "bounded");
        for key in &household {
            assert!(claims.holds(key), "{key} was displaced");
        }
        drop(claims);
        assert!(
            super::throttled_per_minute(&h.state, "relay:198.51.100.4", 100).is_none(),
            "a newcomer is admitted"
        );
        assert!(crate::lock(&h.state.claims).holds("relay:198.51.100.4"));
    }

    /// A bucket that is refusing its caller cannot be freed by a flood: refusing entries are evicted last.
    #[test]
    fn a_flood_cannot_free_a_refusing_bucket() {
        let h = Harness::new();
        let guesser = "mint:192.0.2.1";
        for _ in 0..3 {
            super::throttled_per_minute(&h.state, guesser, 2);
        }
        assert!(super::throttled_per_minute(&h.state, guesser, 2).is_some(), "refusing");
        flood(&h, 0..super::MAX_THROTTLE_BUCKETS / super::MAX_PER_PREFIX + 4);
        assert!(
            super::throttled_per_minute(&h.state, guesser, 2).is_some(),
            "still refusing after the flood"
        );
    }

    /// Budgets that name no visitor are kept apart and never evicted: a full churn of visitors leaves them counting.
    #[test]
    fn global_budgets_survive_a_full_churn() {
        let h = Harness::new();
        for _ in 0..2 {
            assert!(super::throttled_per_minute(&h.state, "tmdb:preview", 2).is_none());
            assert!(super::throttled_per_minute(&h.state, "skipdb:upstream", 2).is_none());
        }
        flood(&h, 0..super::MAX_THROTTLE_BUCKETS / super::MAX_PER_PREFIX + 4);
        assert!(super::throttled_per_minute(&h.state, "tmdb:preview", 2).is_some(), "still spent");
        assert!(super::throttled_per_minute(&h.state, "skipdb:upstream", 2).is_some());
        assert!(!crate::lock(&h.state.claims).holds("tmdb:preview"), "not in the per-visitor table");
    }

    /// Round-robin over more /64s than a /48's share admits at most the share's worth of budgets per window, and a
    /// visitor of another prefix is still admitted meanwhile.
    #[test]
    fn cycling_the_64s_of_one_48_stays_bounded() {
        let h = Harness::new();
        let limit = 3;
        let mut admitted = 0;
        for _round in 0..4 {
            for s in 0..(super::MAX_PER_PREFIX * 3) {
                if super::throttled_per_minute(&h.state, &v6(7, s), limit).is_none() {
                    admitted += 1;
                }
            }
        }
        assert!(admitted <= super::MAX_PER_PREFIX * limit as usize, "{admitted} admitted");
        assert!(super::throttled_per_minute(&h.state, &v6(8, 0), limit).is_none(), "another /48 is admitted");
        assert!(super::throttled_per_minute(&h.state, "relay:198.51.100.4", limit).is_none());
    }

    #[tokio::test]
    async fn the_six_character_code_routes_are_gone() {
        let h = Harness::new();
        assert_eq!(h.call("POST", "/link/new", None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(
            h.call("POST", "/link/claim", Some(json!({ "code": "ABC234" }))).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(h.call("GET", "/link/poll?code=ABC234", None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(h.call("GET", "/link", None).await.0, StatusCode::METHOD_NOT_ALLOWED);
    }
}
