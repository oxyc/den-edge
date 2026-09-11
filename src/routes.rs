//! The routes table (den-spec `wire/routes-v1.md`, oxyc/den#16): for each service, every address a client may try,
//! in order — LAN, tailnet, public — as the deployment builds it (env `ROUTES`). `GET /routes` serves all of it on
//! every name: a client away from home still holds install URLs issued on the LAN, and needs the LAN entries to tell
//! which service each one is.

use serde_json::{json, Map, Value};
use std::net::IpAddr;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub url: String,
    /// A public name behind Cloudflare Access: a client holding the service token sends it here and nowhere else.
    pub access: bool,
}

pub type Routes = Vec<(String, Vec<Entry>)>;

/// `ROUTES`: `<service>=<entry> <entry> …;<service>=…`, an entry `[access:]http(s)://host[:port][/path]`. A
/// malformed service or entry is said and skipped.
pub fn parse(value: &str) -> Routes {
    value
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|service| {
            let Some((name, entries)) = service.split_once('=') else {
                eprintln!("ROUTES: {service:?} is not <service>=<entries> — skipping it");
                return None;
            };
            let name = name.trim();
            if name.is_empty()
                || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            {
                eprintln!("ROUTES: {name:?} is not a service name — skipping it");
                return None;
            }
            let entries = entries
                .split_whitespace()
                .filter_map(|e| {
                    let (access, url) = match e.strip_prefix("access:") {
                        Some(url) => (true, url),
                        None => (false, e),
                    };
                    let parsed = entry_url(url);
                    if parsed.is_none() {
                        eprintln!(
                            "ROUTES: {e:?} for {name} is not http(s)://host[:port][/path] — skipping it"
                        );
                    }
                    parsed.map(|url| Entry { url, access })
                })
                .collect();
            Some((name.to_owned(), entries))
        })
        .collect()
}

/// `http(s)://host[:port]` with an optional path of plain segments: the origin lower-cased, no trailing slash.
fn entry_url(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") {
        return None;
    }
    let (host, path) = rest.find('/').map_or((rest, ""), |i| rest.split_at(i));
    let host = host.to_ascii_lowercase();
    let path = path.trim_end_matches('/');
    let host_ok = !host.is_empty()
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'));
    let path_ok = path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.'))
        && !path.split('/').skip(1).any(|s| s.is_empty() || s == "." || s == "..");
    (host_ok && path_ok).then(|| format!("{scheme}://{host}{path}"))
}

/// Is `url` on a LAN address: RFC 1918, loopback, link-local, a unique-local IPv6 address, or a `.local` name?
fn private(url: &str) -> bool {
    let authority = url.split_once("://").map_or("", |(_, rest)| rest.split('/').next().unwrap_or(""));
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
        Err(_) => host == "localhost" || host.ends_with(".local"),
    }
}

/// The table as den-spec's JSON.
pub fn to_json(routes: &Routes) -> Value {
    let services: Map<String, Value> = routes
        .iter()
        .map(|(name, entries)| {
            let list =
                entries
                    .iter()
                    .map(|e| {
                        if e.access {
                            json!({ "url": e.url, "access": true })
                        } else {
                            json!({ "url": e.url })
                        }
                    })
                    .collect();
            (name.clone(), Value::Array(list))
        })
        .collect();
    json!({ "v": 1, "addons": services })
}

/// Where the web app's player may fetch video: the origins of den-remux's https entries, none of them on the LAN.
pub fn remux_origins(routes: &Routes) -> Vec<String> {
    let mut origins: Vec<String> = Vec::new();
    for entry in routes.iter().filter(|(name, _)| name == "remux").flat_map(|(_, entries)| entries) {
        let Some(rest) = entry.url.strip_prefix("https://") else { continue };
        let origin = format!("https://{}", rest.split('/').next().unwrap_or(""));
        if !private(&entry.url) && !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "scout=http://192.168.86.193:8080 https://PVE.example:8443/scout/ access:https://d-scout.oxy.fi;\
        remux=http://192.168.86.193:8095/remux https://pve.example:8443/remux access:https://d-remux.oxy.fi/remux";

    #[test]
    fn a_table_parses_and_a_bad_entry_is_skipped() {
        let routes =
            parse(&format!("{TABLE};atlas=ftp://x http://10.0.0.2:8081 https://a/../b;BAD=http://x"));
        assert_eq!(routes.len(), 3, "BAD is not a service name");
        assert_eq!(
            routes[0].1,
            [
                Entry { url: "http://192.168.86.193:8080".into(), access: false },
                Entry { url: "https://pve.example:8443/scout".into(), access: false },
                Entry { url: "https://d-scout.oxy.fi".into(), access: true },
            ]
        );
        assert_eq!(routes[2].1, [Entry { url: "http://10.0.0.2:8081".into(), access: false }]);
    }

    #[test]
    fn the_table_carries_every_entry() {
        let table = to_json(&parse(TABLE));
        assert_eq!(table["v"], 1);
        assert_eq!(
            table["addons"]["scout"],
            json!([
                { "url": "http://192.168.86.193:8080" },
                { "url": "https://pve.example:8443/scout" },
                { "url": "https://d-scout.oxy.fi", "access": true }
            ])
        );
    }

    #[test]
    fn lan_addresses_are_told_apart() {
        for url in [
            "http://10.1.2.3",
            "http://172.20.0.1:80",
            "http://127.0.0.1",
            "http://den.local:1",
            "http://[fd00::1]:8",
        ] {
            assert!(private(url), "{url}");
        }
        assert!(!private("https://d-api.oxy.fi") && !private("http://172.32.0.1"));
    }

    #[test]
    fn the_player_may_fetch_from_den_remuxs_https_origins() {
        assert_eq!(remux_origins(&parse(TABLE)), ["https://pve.example:8443", "https://d-remux.oxy.fi"]);
    }
}
