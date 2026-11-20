//! A personal build's diagnosis log, from wherever the device is (`POST /device-log`).
//!
//! A build that carries a log collector posts its redacted lines to it, and the collector lives on the home
//! network: away from home every line was lost, which is exactly when a failure is hardest to reconstruct. This
//! takes the same batch on the device API name and hands it to the collector (env `DEVICE_LOG_UPSTREAM`, a URL),
//! with the build's own bearer token (env `DEVICE_LOG_TOKEN`, the collector's `LOG_TOKEN`). Unconfigured, or
//! with any other token, the route is the 404 an unknown path gets. Nothing of the body is read or logged here.

use crate::handler::{client_ip, constant_time_eq, error, json_reply as bare_json, retry_after};
use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use http_body_util::Full;
use std::sync::Arc;
use std::time::Duration;

pub const PATH: &str = "/device-log";
/// The collector's own cap.
pub const MAX_BODY_BYTES: usize = 1_000_000;
/// A build flushes about once a second and on every warning; a burst of errors stays well inside this.
const PER_MINUTE: u32 = 240;
const TIMEOUT: Duration = Duration::from_secs(5);

/// Where a device's lines go, and the token that may send them.
pub struct DeviceLog {
    pub upstream: String,
    pub token: String,
}

impl DeviceLog {
    pub fn from_env(upstream: Option<String>, token: Option<String>) -> Option<Self> {
        match (upstream, token) {
            (Some(upstream), Some(token)) if !token.is_empty() => Some(Self { upstream, token }),
            _ => None,
        }
    }
}

pub async fn handle(state: &Arc<AppState>, req: Request) -> Response {
    let not_found = || bare_json(StatusCode::NOT_FOUND, &error("not_found"));
    let Some(sink) = state.device_log.as_ref() else { return not_found() };
    if req.method() != Method::POST {
        return not_found();
    }
    let presented = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    let Some(given) = presented.strip_prefix("Bearer ") else { return not_found() };
    if !constant_time_eq(given.trim().as_bytes(), sink.token.as_bytes()) {
        return not_found();
    }
    let ip = client_ip(state, &req);
    if let Some(wait) = crate::link::throttled_per_minute(state, &format!("device-log:{ip}"), PER_MINUTE) {
        return retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES).await else {
        return bare_json(StatusCode::PAYLOAD_TOO_LARGE, &error("payload_too_large"));
    };
    let Ok(out) = axum::http::Request::builder()
        .method(Method::POST)
        .uri(&sink.upstream)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::AUTHORIZATION, format!("Bearer {}", sink.token))
        .body(Full::new(Bytes::from(body)))
    else {
        return bare_json(StatusCode::INTERNAL_SERVER_ERROR, &error("device_log_upstream"));
    };
    let status = match tokio::time::timeout(TIMEOUT, state.relay_client.request(out)).await {
        Ok(Ok(answer)) if answer.status().is_success() => StatusCode::NO_CONTENT,
        Ok(Ok(answer)) => {
            eprintln!("device-log: collector said {}", answer.status());
            StatusCode::BAD_GATEWAY
        }
        Ok(Err(e)) => {
            eprintln!("device-log: collector unreachable: {e}");
            StatusCode::BAD_GATEWAY
        }
        Err(_) => {
            eprintln!("device-log: collector timed out");
            StatusCode::GATEWAY_TIMEOUT
        }
    };
    let mut response = Response::new(Body::empty());
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::DeviceLog;
    use crate::handler::tests::Harness;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use std::sync::Arc;

    #[tokio::test]
    async fn a_device_log_batch_reaches_the_collector_only_with_the_build_token() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = upstream.local_addr().unwrap();
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        let app = axum::Router::new().fallback(move |req: Request| {
            let sent = sent.clone();
            async move {
                let auth = req.headers()["authorization"].to_str().unwrap().to_owned();
                let body = axum::body::to_bytes(req.into_body(), 1 << 20).await.unwrap();
                sent.send((auth, body)).unwrap();
                StatusCode::OK
            }
        });
        tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });

        let mut h = Harness::new();
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.api_hosts = crate::parse_hosts("API_HOSTS", "d-api.example");
        state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.example");
        let api = ("host", "d-api.example");
        let line = "12:00:00.000 [info] player: hello";

        // Switched off: the 404 any unknown path gets.
        let off =
            h.send("POST", "/device-log", Some(line.into()), &[api, ("authorization", "Bearer t0k")]).await;
        assert_eq!(off.status(), StatusCode::NOT_FOUND);

        Arc::get_mut(&mut h.state).unwrap().device_log =
            DeviceLog::from_env(Some(format!("http://{addr}/log")), Some("t0k".into()));
        for auth in ["Bearer wrong", "t0k", ""] {
            let refused =
                h.send("POST", "/device-log", Some(line.into()), &[api, ("authorization", auth)]).await;
            assert_eq!(refused.status(), StatusCode::NOT_FOUND, "{auth:?}");
        }
        assert!(received.try_recv().is_err(), "a refused batch reached the collector");

        let ok =
            h.send("POST", "/device-log", Some(line.into()), &[api, ("authorization", "Bearer t0k")]).await;
        assert_eq!(ok.status(), StatusCode::NO_CONTENT);
        let (auth, body) = received.recv().await.unwrap();
        assert_eq!(auth, "Bearer t0k");
        assert_eq!(body, line.as_bytes());
        // The device API's route only: the public web name serves the web app.
        let web = h
            .send(
                "POST",
                "/device-log",
                Some(line.into()),
                &[("host", "d.example"), ("authorization", "Bearer t0k")],
            )
            .await;
        assert_eq!(web.status(), StatusCode::NOT_FOUND);
    }
}
