//! Deterministic dependency for relay benchmarks. It deliberately uses only std so the
//! benchmark images remain scratch/static and the measured service gets the memory budget.

use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

static ACCEPTED: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicU64 = AtomicU64::new(0);
static COMPLETED: AtomicU64 = AtomicU64::new(0);
static ABORTED: AtomicU64 = AtomicU64::new(0);
static CANCEL_ACCEPTED: AtomicU64 = AtomicU64::new(0);
static CANCEL_ACTIVE: AtomicU64 = AtomicU64::new(0);
static CANCEL_COMPLETED: AtomicU64 = AtomicU64::new(0);
static CANCEL_ABORTED: AtomicU64 = AtomicU64::new(0);

struct Active {
    cancellation: bool,
}

impl Drop for Active {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
        if self.cancellation {
            CANCEL_ACTIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn query_u64(target: &str, name: &str, default: u64) -> u64 {
    target
        .split_once('?')
        .map(|(_, q)| q)
        .and_then(|q| q.split('&').find_map(|part| part.split_once('=').filter(|(key, _)| *key == name)))
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(default)
}

fn handle(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut request = [0_u8; 8192];
    let Ok(read) = stream.read(&mut request) else { return };
    let line = String::from_utf8_lossy(&request[..read]);
    let target = line.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("/");
    if target.split('?').next() == Some("/stats") {
        let body = format!(
            "{{\"accepted\":{},\"active\":{},\"completed\":{},\"aborted\":{},\"cancel_accepted\":{},\"cancel_active\":{},\"cancel_completed\":{},\"cancel_aborted\":{}}}",
            ACCEPTED.load(Ordering::SeqCst),
            ACTIVE.load(Ordering::SeqCst),
            COMPLETED.load(Ordering::SeqCst),
            ABORTED.load(Ordering::SeqCst),
            CANCEL_ACCEPTED.load(Ordering::SeqCst),
            CANCEL_ACTIVE.load(Ordering::SeqCst),
            CANCEL_COMPLETED.load(Ordering::SeqCst),
            CANCEL_ABORTED.load(Ordering::SeqCst),
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    }
    let bytes = query_u64(target, "bytes", 262_144).min(8 * 1024 * 1024) as usize;
    let slow = target.split('?').next().is_some_and(|path| path.contains("/slow"));
    let cancellation = slow && bytes == 1024 * 1024;
    ACCEPTED.fetch_add(1, Ordering::SeqCst);
    ACTIVE.fetch_add(1, Ordering::SeqCst);
    if cancellation {
        CANCEL_ACCEPTED.fetch_add(1, Ordering::SeqCst);
        CANCEL_ACTIVE.fetch_add(1, Ordering::SeqCst);
    }
    let _active = Active { cancellation };
    let delay = Duration::from_millis(query_u64(target, "delay_ms", 5).min(1_000));
    let chunk = query_u64(target, "chunk", 16_384).clamp(1, 1024 * 1024) as usize;
    let content_type = if target.contains(".mp4") || target.contains("progressive") {
        "video/mp4"
    } else {
        "application/json"
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {bytes}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(head.as_bytes()).is_err() {
        ABORTED.fetch_add(1, Ordering::SeqCst);
        if cancellation {
            CANCEL_ABORTED.fetch_add(1, Ordering::SeqCst);
        }
        return;
    }
    let fill = if content_type == "application/json" { b' ' } else { 0x5a };
    let block = vec![fill; chunk];
    let mut left = bytes;
    while left > 0 {
        let n = left.min(block.len());
        if stream.write_all(&block[..n]).is_err() {
            ABORTED.fetch_add(1, Ordering::SeqCst);
            if cancellation {
                CANCEL_ABORTED.fetch_add(1, Ordering::SeqCst);
            }
            return;
        }
        left -= n;
        if slow && left > 0 {
            thread::sleep(delay);
        }
    }
    COMPLETED.fetch_add(1, Ordering::SeqCst);
    if cancellation {
        CANCEL_COMPLETED.fetch_add(1, Ordering::SeqCst);
    }
}

fn main() {
    let port = env::var("PORT").unwrap_or_else(|_| "9090".into());
    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).expect("bind fixture upstream");
    for stream in listener.incoming().flatten() {
        thread::spawn(|| handle(stream));
    }
}
