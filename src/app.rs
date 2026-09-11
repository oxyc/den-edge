//! `/app` — the Den Companion phone web page, served same-origin so its `/link` and `/inbox` calls need no
//! CORS. The files under `app/` are the page exactly as the Cloudflare Worker served it.

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;

const INDEX: &str = include_str!("../app/index.html");
const APP_JS: &str = include_str!("../app/app.js");
const MANIFEST: &str = include_str!("../app/manifest.webmanifest");
const SERVICE_WORKER: &str = include_str!("../app/sw.js");
const ICON: &str = include_str!("../app/icon.svg");
/// What the page may load and call: itself, TMDB's API and images, and OMDb for its ratings key — and no inline
/// script. Its markup styles inline, so styles alone allow it.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: https://image.tmdb.org; \
    connect-src 'self' https://api.themoviedb.org https://www.omdbapi.com; \
    frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

pub fn handle(path: &str) -> Response {
    let (body, content_type) = match path {
        "/app" | "/app/" => (INDEX, "text/html; charset=utf-8"),
        "/app/app.js" => (APP_JS, "text/javascript; charset=utf-8"),
        "/app/manifest.webmanifest" => (MANIFEST, "application/manifest+json"),
        "/app/sw.js" => (SERVICE_WORKER, "text/javascript; charset=utf-8"),
        "/app/icon.svg" => (ICON, "image/svg+xml"),
        _ => ("not found", "text/plain; charset=utf-8"),
    };
    let status = if body == "not found" { StatusCode::NOT_FOUND } else { StatusCode::OK };
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = status;
    resp.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static(content_type));
    if content_type.starts_with("text/html") {
        resp.headers_mut().insert(header::CONTENT_SECURITY_POLICY, header::HeaderValue::from_static(CSP));
    }
    resp
}
