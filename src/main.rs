//! den-edge — Den's sync relay, on the homelab. It relays pairings between a TV and another device, carries a
//! paired device's sealed messages to the TV (the inbox), and keeps the library's record log. It also serves the
//! Den web app. It never interprets what it stores: the log and the inbox are ciphertext the devices seal.
//!
//! State lives in files under `DATA_DIR`; pairing sessions live in memory only.

mod handler;
mod inbox;
mod library;
mod link;
mod metrics;
mod pair;
mod relay;
mod routes;
mod store;
mod sync;
mod web;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct AppState {
    pub store: store::Store,
    /// Held across every read-modify-write on the store, so an inbox append, a drain and a versioned write
    /// each happen as one step. Workers KV could not do this, which is how its inbox lost messages when two
    /// arrived at once. One household never contends on it.
    pub write_lock: tokio::sync::Mutex<()>,
    /// The record logs loaded so far, by library id — one household's, a few MB at most. Held across a batch
    /// or a read, so each library's compare-and-set is one step.
    pub libraries: tokio::sync::Mutex<HashMap<String, library::Library>>,
    /// Guesses per client address, to keep a pairing's nameplate from being guessed online.
    pub claims: Mutex<HashMap<String, link::Throttle>>,
    /// Pairing sessions by `sid`. Ten minutes long at most, so memory is enough: a restart costs a pairing in
    /// progress, which the TV simply starts again.
    pub pairs: Mutex<HashMap<String, pair::Session>>,
    /// Unix milliseconds. A field so a test can move time.
    pub clock: Box<dyn Fn() -> u64 + Send + Sync>,
    pub gen_nameplate: Box<dyn Fn() -> String + Send + Sync>,
    pub metrics: metrics::Metrics,
    /// Bearer token for `/metrics` (env `METRICS_TOKEN`). `None` turns the route off.
    pub metrics_token: Option<String>,
    /// One stderr line per request (env `LOG_REQUESTS`), naming the route and never a key.
    pub log_requests: bool,
    /// Origins a browser may call from (env `WEB_ORIGINS`, comma-separated): the Den web app when it is served
    /// from elsewhere. Empty sends no CORS headers at all — the app served here is same-origin and needs none.
    pub web_origins: Vec<String>,
    /// The Den web app's built files (env `WEB_DIR`), served at `/`. `None` serves no app.
    pub web_dir: Option<std::path::PathBuf>,
    /// Proxies whose report of the visitor's address counts (env `TRUSTED_PROXIES`, comma-separated IPs):
    /// `cloudflared` and `tailscale serve` connect from their own address (`handler::client_ip`).
    pub trusted_proxies: Vec<std::net::IpAddr>,
    /// The web app's public names (env `WEB_HOSTS`, comma-separated). They sit behind Cloudflare Access, and a
    /// request for one gets the web app and none of the device API (`handler::Face`, oxyc/den#15).
    pub web_hosts: Vec<String>,
    /// The device API's public names (env `API_HOSTS`). They bypass Access, so a request for one gets the
    /// device routes and never the web app — which would otherwise be handed out past Access.
    pub api_hosts: Vec<String>,
    /// Public origin → LAN origin (env `LAN_MAP`: `https://d-scout.oxy.fi=http://192.168.86.193:8080,…`),
    /// published in `GET /config` on every name but the public ones: a TV that reaches den-edge on the LAN
    /// then reaches the addons there too.
    pub lan_map: Vec<(String, String)>,
    /// The addons' public origins behind Cloudflare Access (env `ACCESS_ORIGINS`, comma-separated): the only ones
    /// the TVs send the library's service token to, published in `/config` and `/web-config`.
    pub access_origins: Vec<String>,
    /// Path prefix → addon LAN origin (env `ADDON_RELAY`: `/scout=http://192.168.86.193:8080,…`): what the web app
    /// asks on its own origin and den-edge fetches from the addon (`relay.rs`).
    pub relays: Vec<(String, String)>,
    pub relay_client: relay::RelayClient,
    /// Every address for each service, in order (env `ROUTES`, den-spec routes-v1): served as `GET /routes`.
    pub routes: routes::Routes,
    /// den-remux's https origins from `routes`: what the web app's CSP lets its player fetch video from.
    pub remux_origins: Vec<String>,
    /// Who may start a library (env `NEW_LIBRARIES`: `open` or `members`).
    pub new_libraries: library::NewLibraries,
}

impl AppState {
    pub fn new(store: store::Store, metrics_token: Option<String>, log_requests: bool) -> Self {
        AppState {
            store,
            write_lock: tokio::sync::Mutex::new(()),
            libraries: tokio::sync::Mutex::new(HashMap::new()),
            claims: Mutex::new(HashMap::new()),
            pairs: Mutex::new(HashMap::new()),
            clock: Box::new(now_ms),
            gen_nameplate: Box::new(pair::gen_nameplate),
            metrics: metrics::Metrics::default(),
            metrics_token,
            log_requests,
            web_origins: Vec::new(),
            web_dir: None,
            trusted_proxies: Vec::new(),
            web_hosts: Vec::new(),
            api_hosts: Vec::new(),
            lan_map: Vec::new(),
            access_origins: Vec::new(),
            relays: Vec::new(),
            relay_client: relay::client(),
            routes: Vec::new(),
            remux_origins: Vec::new(),
            new_libraries: library::NewLibraries::Open,
        }
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Bytes from the OS's random source. There is no recovering from a failed one, and handing out a guessable
/// key instead would be worse than stopping, so it panics.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random source failed");
    bytes
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A poisoned lock still holds consistent data here — every critical section is a map update — so take it.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[tokio::main]
async fn main() {
    let dir = env_opt("DATA_DIR").unwrap_or_else(|| "data".to_owned());
    let cap = env_opt("STORE_CAP_BYTES").and_then(|v| v.parse().ok()).unwrap_or(store::DEFAULT_CAP);
    let store = store::Store::open(std::path::Path::new(&dir), cap).unwrap_or_else(|e| {
        eprintln!("data dir {dir} is unusable: {e}");
        std::process::exit(1);
    });
    let mut state = AppState::new(
        store,
        env_opt("METRICS_TOKEN"),
        std::env::var("LOG_REQUESTS").is_ok_and(|v| !v.is_empty() && v != "0"),
    );
    state.web_origins = env_opt("WEB_ORIGINS")
        .map(|v| v.split(',').map(|o| o.trim().to_owned()).filter(|o| !o.is_empty()).collect())
        .unwrap_or_default();
    state.web_dir = env_opt("WEB_DIR").map(std::path::PathBuf::from);
    state.trusted_proxies = env_opt("TRUSTED_PROXIES").map(|v| parse_proxies(&v)).unwrap_or_default();
    state.web_hosts = env_opt("WEB_HOSTS").map(|v| parse_hosts("WEB_HOSTS", &v)).unwrap_or_default();
    state.api_hosts = env_opt("API_HOSTS").map(|v| parse_hosts("API_HOSTS", &v)).unwrap_or_default();
    state.lan_map = env_opt("LAN_MAP").map(|v| parse_lan_map(&v)).unwrap_or_default();
    state.access_origins =
        env_opt("ACCESS_ORIGINS").map(|v| parse_origins("ACCESS_ORIGINS", &v)).unwrap_or_default();
    state.relays = env_opt("ADDON_RELAY").map(|v| parse_relays(&v)).unwrap_or_default();
    state.routes = env_opt("ROUTES").map(|v| routes::parse(&v)).unwrap_or_default();
    state.remux_origins = routes::remux_origins(&state.routes);
    state.new_libraries = env_opt("NEW_LIBRARIES").map_or(library::NewLibraries::Open, |v| {
        library::NewLibraries::parse(&v).unwrap_or_else(|| {
            eprintln!("NEW_LIBRARIES is {v:?}: expected open or members");
            std::process::exit(1);
        })
    });
    let state = Arc::new(state);
    let app = axum::Router::new().fallback(handler::handle).with_state(Arc::clone(&state));

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap_or_else(|e| {
        eprintln!("bind :{port} failed: {e}");
        std::process::exit(1);
    });
    let shutdown = shutdown_signal();
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    let on = |b: bool| if b { "on" } else { "off" };
    eprintln!(
        "den-edge {} listening on :{port} — data={dir} web={} metrics={} log_requests={} web_origins={} \
         web_hosts={} api_hosts={} lan_map={} access_origins={} relays={} routes={} new_libraries={}",
        env!("CARGO_PKG_VERSION"),
        state.web_dir.as_deref().map_or("none".to_owned(), |d| d.display().to_string()),
        on(state.metrics_token.is_some()),
        on(state.log_requests),
        if state.web_origins.is_empty() { "none".to_owned() } else { state.web_origins.join(",") },
        if state.web_hosts.is_empty() { "none".to_owned() } else { state.web_hosts.join(",") },
        if state.api_hosts.is_empty() { "none".to_owned() } else { state.api_hosts.join(",") },
        state.lan_map.len(),
        state.access_origins.len(),
        state.relays.iter().map(|(prefix, _)| prefix.as_str()).collect::<Vec<_>>().join(","),
        state.routes.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(","),
        state.new_libraries.as_str(),
    );
    let outcome = serve_until(listener, app, shutdown, DRAIN_GRACE).await;
    eprintln!("{}", outcome.describe());
    let code = outcome.exit_code();
    if code != 0 {
        std::process::exit(code);
    }
}

/// `TRUSTED_PROXIES`: comma-separated IP addresses. A malformed entry is said and skipped — trusting it would mean
/// guessing what was meant.
fn parse_proxies(value: &str) -> Vec<std::net::IpAddr> {
    value
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter_map(|p| {
            let parsed = p.parse().ok();
            if parsed.is_none() {
                eprintln!("TRUSTED_PROXIES: {p:?} is not an IP address — skipping it");
            }
            parsed
        })
        .collect()
}

/// `WEB_HOSTS` / `API_HOSTS`: comma-separated host names, lower-cased, compared whole against a request's
/// `Host`. An entry with a port, path or credentials is said and skipped: a name that matched differently from
/// how it reads would make the split between the two halves a guess.
fn parse_hosts(var: &str, value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .filter(|h| {
            let ok = !h.contains(['/', ':', '@', '?', '#', ' ']);
            if !ok {
                eprintln!("{var}: {h:?} is not a bare host name — skipping it");
            }
            ok
        })
        .collect()
}

/// `LAN_MAP`: comma-separated `<public origin>=<LAN origin>` pairs, each side `http(s)://host[:port]` with no path.
/// A malformed pair is said and skipped.
fn parse_lan_map(value: &str) -> Vec<(String, String)> {
    value
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let parsed = pair.split_once('=').and_then(|(public, lan)| Some((origin(public)?, origin(lan)?)));
            if parsed.is_none() {
                eprintln!("LAN_MAP: {pair:?} is not <public origin>=<LAN origin> — skipping it");
            }
            parsed
        })
        .collect()
}

/// `ADDON_RELAY`: comma-separated `/<prefix>=<origin>` pairs — one path segment, a plain http(s) origin. A malformed
/// pair is said and skipped.
fn parse_relays(value: &str) -> Vec<(String, String)> {
    value
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let parsed = pair.split_once('=').and_then(|(prefix, lan)| {
                let prefix = prefix.trim();
                let segment = prefix.strip_prefix('/')?;
                let ok =
                    !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
                ok.then(|| Some((prefix.to_owned(), origin(lan)?))).flatten()
            });
            if parsed.is_none() {
                eprintln!("ADDON_RELAY: {pair:?} is not /<prefix>=<origin> — skipping it");
            }
            parsed
        })
        .collect()
}

/// `ACCESS_ORIGINS`: comma-separated origins, as `origin` reads them. A malformed one is said and skipped.
fn parse_origins(var: &str, value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .filter_map(|o| {
            let parsed = origin(o);
            if parsed.is_none() {
                eprintln!("{var}: {o:?} is not http(s)://host[:port] — skipping it");
            }
            parsed
        })
        .collect()
}

/// `http(s)://host[:port]`, lower-cased, without a trailing slash — or `None` for anything with a path, query,
/// credentials or a space, which would read differently from how it matches.
fn origin(o: &str) -> Option<String> {
    let o = o.trim().trim_end_matches('/').to_ascii_lowercase();
    let ok = o.split_once("://").is_some_and(|(scheme, host)| {
        matches!(scheme, "http" | "https")
            && !host.is_empty()
            && !host.contains(['/', '?', '#', '@', ' ', ';', ','])
    });
    ok.then_some(o)
}

/// An env var's value, with unset and empty both meaning "not configured" — the rule every den addon uses.
fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// How serving ended. A drain that ran out of time is designed and exits 0; only a serve error fails.
#[derive(Debug)]
enum Outcome {
    Drained,
    DeadlineHit(String),
    Failed(String),
}

impl Outcome {
    fn exit_code(&self) -> i32 {
        match self {
            Outcome::Drained | Outcome::DeadlineHit(_) => 0,
            Outcome::Failed(_) => 1,
        }
    }

    fn describe(&self) -> String {
        match self {
            Outcome::Drained => "shut down cleanly".to_owned(),
            Outcome::DeadlineHit(why) | Outcome::Failed(why) => why.clone(),
        }
    }
}

/// Serve until `shutdown` resolves, then drain for at most `grace` — den-atlas's bounded drain: hyper waits
/// on a connection that is mid-request, so without the bound a client holding half a request head decides
/// how long a restart takes.
async fn serve_until(
    listener: tokio::net::TcpListener,
    app: axum::Router,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    grace: Duration,
) -> Outcome {
    let (signalled_tx, signalled_rx) = tokio::sync::oneshot::channel::<()>();
    let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            shutdown.await;
            let _ = signalled_tx.send(());
        });
    tokio::select! {
        r = serve => match r {
            Ok(()) => Outcome::Drained,
            Err(e) => Outcome::Failed(format!("serve error: {e}")),
        },
        _ = async {
            let _ = signalled_rx.await;
            tokio::time::sleep(grace).await;
        } => Outcome::DeadlineHit(format!("drain deadline ({grace:?}) reached with requests still in flight")),
    }
}

/// Under podman's default 10s stop timeout, so the drain finishes before anything kills it.
const DRAIN_GRACE: Duration = Duration::from_secs(8);
const _: () = assert!(DRAIN_GRACE.as_secs() < 10);

/// Resolves on SIGTERM or SIGINT. PID 1 in a `scratch` image gets no default terminate action, so without
/// a handler every restart waits out the stop timeout. A second signal exits at once.
fn shutdown_signal() -> impl std::future::Future<Output = ()> {
    use tokio::signal::unix::{signal, SignalKind};
    // Registered now, not when first polled, so a stop that arrives before the server polls it still drains.
    let term = signal(SignalKind::terminate());
    let int = signal(SignalKind::interrupt());
    async move {
        tokio::select! {
            _ = wait_for(term, "SIGTERM") => {}
            _ = wait_for(int, "SIGINT") => {}
        }
        tokio::spawn(async move {
            tokio::select! {
                _ = wait_for(signal(SignalKind::terminate()), "") => {}
                _ = wait_for(signal(SignalKind::interrupt()), "") => {}
            }
            eprintln!("second signal — exiting without finishing the drain");
            std::process::exit(0);
        });
    }
}

/// Resolve when this signal arrives, or never if it could not be registered — returning at once would shut
/// the server down at boot. An empty `name` says nothing when it fires.
async fn wait_for(registered: std::io::Result<tokio::signal::unix::Signal>, name: &str) {
    match registered {
        Ok(mut sig) => {
            sig.recv().await;
            if !name.is_empty() {
                eprintln!("{name} — draining in-flight requests");
            }
        }
        Err(e) => {
            eprintln!("signal handler unavailable ({e}); a stop will be a hard kill");
            std::future::pending::<()>().await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// A client that sends half a request head must not hold shutdown open past the grace.
    #[tokio::test]
    async fn a_client_holding_a_partial_request_cannot_hold_shutdown_open() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let state = Arc::new(AppState::new(
            store::Store::open(&handler::tests::temp_dir(), store::DEFAULT_CAP).unwrap(),
            None,
            false,
        ));
        let app = axum::Router::new().fallback(handler::handle).with_state(state);
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let grace = Duration::from_millis(300);
        let server =
            tokio::spawn(async move { serve_until(l, app, async { rx.await.unwrap_or(()) }, grace).await });

        let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
        sock.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n").await.unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let started = std::time::Instant::now();
        let _ = tx.send(());
        let outcome =
            tokio::time::timeout(Duration::from_secs(5), server).await.expect("unbounded drain").unwrap();
        assert!(matches!(&outcome, Outcome::DeadlineHit(w) if w.contains("drain deadline")), "{outcome:?}");
        assert!(started.elapsed() < grace * 4);
        assert_eq!(outcome.exit_code(), 0, "a routine drain timeout must not look like a crash");
        drop(sock);
    }

    #[test]
    fn only_a_serve_error_exits_non_zero() {
        assert_eq!(Outcome::Drained.exit_code(), 0);
        assert_eq!(Outcome::Failed("bind failed".into()).exit_code(), 1);
    }

    #[tokio::test]
    async fn an_unregisterable_signal_never_fires() {
        let fired = tokio::time::timeout(
            Duration::from_millis(200),
            wait_for(Err(std::io::Error::other("no handler")), "SIGTERM"),
        )
        .await;
        assert!(
            fired.is_err(),
            "an unregisterable signal resolved, which would shut the server down at boot"
        );
    }
}
