//! Whether a client sits behind the home's own router — the one thing that decides who is handed the LAN media base.
//!
//! The LAN name resolves to a private address, which is reachable only from the home network. Anyone else who is
//! handed it opens a connection to that address on their own network on every play and waits for it to fail, may be
//! asked by their browser to allow local-network access, and learns the household's internal addressing. So it goes
//! only to a client whose public address is the home's: that client is behind the same router, and is the one for
//! whom the public address does not loop back in.
//!
//! The home's public address is not configured separately. The public media base names a host whose one A record is
//! kept on that address (with a 60 s TTL), so resolving it says where the home is now, and follows the address when
//! it changes. An address that cannot be established means no LAN base is handed out.

use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long an answer is kept: the record's own TTL.
const FRESH: Duration = Duration::from_secs(60);
/// How long a failed or empty lookup is kept, so an unresolvable name is not asked about on every play.
const RETRY: Duration = Duration::from_secs(10);
/// How long a lookup may take before it counts as failed. A play waits on it, and only the first after a change.
const LOOKUP: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct HomeAddress {
    seen: Mutex<Option<(Instant, Vec<IpAddr>)>>,
}

impl HomeAddress {
    /// Whether `client` is one of the addresses `base`'s host has now. `base` is a bare origin
    /// (`https://host[:port]`); a host that is an address itself needs no lookup.
    pub async fn is_behind_home_router(&self, base: &str, client: IpAddr) -> bool {
        let Some(host) = host_of(base) else { return false };
        let client = client.to_canonical();
        if let Ok(literal) = host.parse::<IpAddr>() {
            return literal.to_canonical() == client;
        }
        self.addresses(host).await.iter().any(|home| home.to_canonical() == client)
    }

    async fn addresses(&self, host: &str) -> Vec<IpAddr> {
        if let Some((at, found)) = crate::lock(&self.seen).as_ref() {
            if at.elapsed() < if found.is_empty() { RETRY } else { FRESH } {
                return found.clone();
            }
        }
        let found = match tokio::time::timeout(LOOKUP, tokio::net::lookup_host((host, 443))).await {
            Ok(Ok(addresses)) => addresses.map(|a| a.ip()).collect(),
            _ => Vec::new(),
        };
        *crate::lock(&self.seen) = Some((Instant::now(), found.clone()));
        found
    }
}

/// The host of a bare origin, without its port.
fn host_of(origin: &str) -> Option<&str> {
    let authority = origin.split_once("://")?.1;
    let host = match authority.strip_prefix('[') {
        Some(bracketed) => bracketed.split_once(']')?.0,
        None => authority.split(':').next()?,
    };
    (!host.is_empty()).then_some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 10));
    const ELSEWHERE: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 77));

    fn remembered(found: Vec<IpAddr>, age: Duration) -> HomeAddress {
        HomeAddress { seen: Mutex::new(Some((Instant::now() - age, found))) }
    }

    #[test]
    fn a_hosts_port_and_brackets_are_not_part_of_it() {
        assert_eq!(host_of("https://media.example.test"), Some("media.example.test"));
        assert_eq!(host_of("https://media.example.test:8449"), Some("media.example.test"));
        assert_eq!(host_of("https://203.0.113.10"), Some("203.0.113.10"));
        assert_eq!(host_of("https://[2001:db8::1]:8449"), Some("2001:db8::1"));
        assert_eq!(host_of("media.example.test"), None);
        assert_eq!(host_of("https://"), None);
    }

    #[tokio::test]
    async fn an_address_literal_is_the_home_address_itself() {
        let home = HomeAddress::default();
        assert!(home.is_behind_home_router("https://203.0.113.10", HOME).await);
        assert!(!home.is_behind_home_router("https://203.0.113.10", ELSEWHERE).await);
        assert!(!home.is_behind_home_router("https://203.0.113.10", "2001:db8::7".parse().unwrap()).await);
    }

    #[tokio::test]
    async fn a_name_is_resolved_and_a_client_on_any_of_its_addresses_is_home() {
        let home = HomeAddress::default();
        assert!(home.is_behind_home_router("https://localhost", "127.0.0.1".parse().unwrap()).await);
        assert!(!home.is_behind_home_router("https://localhost", ELSEWHERE).await);
    }

    #[tokio::test]
    async fn a_name_that_does_not_resolve_is_nobodys_home() {
        // `.invalid` never resolves (RFC 6761), so nothing is known and nobody is handed the LAN base.
        let home = HomeAddress::default();
        assert!(!home.is_behind_home_router("https://home.invalid", HOME).await);
        assert!(!home.is_behind_home_router("https://home.invalid", ELSEWHERE).await);
    }

    #[tokio::test]
    async fn a_fresh_answer_is_used_without_asking_again_and_a_stale_one_is_asked_for_again() {
        // The name cannot resolve, so a `true` can only come from what was remembered.
        let fresh = remembered(vec![HOME], FRESH - Duration::from_secs(5));
        assert!(fresh.is_behind_home_router("https://home.invalid", HOME).await);
        assert!(!fresh.is_behind_home_router("https://home.invalid", ELSEWHERE).await);

        let stale = remembered(vec![HOME], FRESH + Duration::from_secs(5));
        assert!(
            !stale.is_behind_home_router("https://home.invalid", HOME).await,
            "asked again, and it is gone"
        );
    }

    #[tokio::test]
    async fn an_empty_answer_is_kept_only_briefly() {
        let failed = remembered(Vec::new(), RETRY - Duration::from_secs(2));
        assert!(!failed.is_behind_home_router("https://home.invalid", HOME).await);
        // Past the retry window a lookup is made again, and this one is answered by the resolver.
        let retried = remembered(Vec::new(), RETRY + Duration::from_secs(2));
        assert!(retried.is_behind_home_router("https://localhost", "127.0.0.1".parse().unwrap()).await);
    }
}
