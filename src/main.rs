//! den-edge — Den's sync relay, on the homelab. It links a phone to a TV, carries the companion's messages
//! to the TV (the inbox), keeps the TV's encrypted library backup, and holds the plugin list and settings the
//! phone and the TV share. It also serves the companion web page. It never interprets what it stores: the
//! backup is ciphertext, and the rest is small JSON it validates and bounds.
//!
//! It answers the same HTTP API the Cloudflare Worker did, so moving a TV over is a URL change and one
//! "Back up". State lives in files under `DATA_DIR`; pending link codes live in memory only.

mod app;
mod handler;
mod inbox;
mod library;
mod link;
mod metrics;
mod plugins;
mod settings;
mod store;
mod sync;

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
    /// Link codes waiting to be claimed or polled. Ten minutes long at most, so memory is enough: a restart
    /// costs a pairing in progress, which the TV simply starts again.
    pub links: Mutex<HashMap<String, link::LinkState>>,
    /// Claim attempts per client address, to keep a six-character code from being guessed online.
    pub claims: Mutex<HashMap<String, link::Throttle>>,
    /// Unix milliseconds. A field so a test can move time.
    pub clock: Box<dyn Fn() -> u64 + Send + Sync>,
    pub gen_code: Box<dyn Fn() -> String + Send + Sync>,
    pub gen_inbox_key: Box<dyn Fn() -> String + Send + Sync>,
    pub metrics: metrics::Metrics,
    /// Bearer token for `/metrics` (env `METRICS_TOKEN`). `None` turns the route off.
    pub metrics_token: Option<String>,
    /// One stderr line per request (env `LOG_REQUESTS`), naming the route and never a key.
    pub log_requests: bool,
}

impl AppState {
    pub fn new(store: store::Store, metrics_token: Option<String>, log_requests: bool) -> Self {
        AppState {
            store,
            write_lock: tokio::sync::Mutex::new(()),
            libraries: tokio::sync::Mutex::new(HashMap::new()),
            links: Mutex::new(HashMap::new()),
            claims: Mutex::new(HashMap::new()),
            clock: Box::new(now_ms),
            gen_code: Box::new(link::gen_code),
            gen_inbox_key: Box::new(link::gen_inbox_key),
            metrics: metrics::Metrics::default(),
            metrics_token,
            log_requests,
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
    let store = store::Store::open(std::path::Path::new(&dir)).unwrap_or_else(|e| {
        eprintln!("data dir {dir} is unusable: {e}");
        std::process::exit(1);
    });
    let state = Arc::new(AppState::new(
        store,
        env_opt("METRICS_TOKEN"),
        std::env::var("LOG_REQUESTS").is_ok_and(|v| !v.is_empty() && v != "0"),
    ));
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
        "den-edge {} listening on :{port} — data={dir} metrics={} log_requests={}",
        env!("CARGO_PKG_VERSION"),
        on(state.metrics_token.is_some()),
        on(state.log_requests),
    );
    let outcome = serve_until(listener, app, shutdown, DRAIN_GRACE).await;
    eprintln!("{}", outcome.describe());
    let code = outcome.exit_code();
    if code != 0 {
        std::process::exit(code);
    }
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
        let state =
            Arc::new(AppState::new(store::Store::open(&handler::tests::temp_dir()).unwrap(), None, false));
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
