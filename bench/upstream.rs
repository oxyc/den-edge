//! Deterministic dependency for relay benchmarks. It deliberately uses only std so the
//! benchmark images remain scratch/static and the measured service gets the memory budget.

use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

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
    let bytes = query_u64(target, "bytes", 262_144).min(8 * 1024 * 1024) as usize;
    let slow = target.split('?').next().is_some_and(|path| path.contains("/slow"));
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
        return;
    }
    let fill = if content_type == "application/json" { b' ' } else { 0x5a };
    let block = vec![fill; chunk];
    let mut left = bytes;
    while left > 0 {
        let n = left.min(block.len());
        if stream.write_all(&block[..n]).is_err() {
            break;
        }
        left -= n;
        if slow && left > 0 {
            thread::sleep(delay);
        }
    }
}

fn main() {
    let port = env::var("PORT").unwrap_or_else(|_| "9090".into());
    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).expect("bind fixture upstream");
    for stream in listener.incoming().flatten() {
        thread::spawn(|| handle(stream));
    }
}
