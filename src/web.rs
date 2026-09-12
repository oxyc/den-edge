//! The Den web app's built files (`WEB_DIR`; `/web` in the image), served at `/` beside the API — one origin
//! for the app and its sync, so no CORS and one certificate. A path with no file behind it and no extension
//! is one of the app's own routes and gets `index.html`. Vite's hashed files under `/assets/` are cached for
//! a year; everything else revalidates, so a release shows up on the next load.
//!
//! The app's routes must not reuse an API path (`/settings`, `/plugins`, `/link/…`): the API answers first.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

/// What the app may load and call: itself — its addons too, which it asks through this origin (`relay.rs`, or
/// `tailscale serve` on the tailnet) — TMDB's images and API (BYOK, straight from the browser), YouTube's embed for
/// trailers, and den-remux's video: `blob:` for hls.js, which hands the video element a MediaSource, and `remux`,
/// den-remux's https origins from the routes table (already checked to be bare origins).
fn csp(remux: &[String]) -> String {
    let remux: String = remux.iter().map(|o| format!(" {o}")).collect();
    format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: https://image.tmdb.org; media-src 'self' blob:{remux}; \
         connect-src 'self' https://api.themoviedb.org{remux}; frame-src https://www.youtube-nocookie.com; \
         object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
}

pub async fn serve(dir: &Path, path: &str, remux: &[String], headers: &HeaderMap) -> Response {
    let Some(relative) = relative(path) else { return not_found() };
    let file = if relative.as_os_str().is_empty() { dir.join("index.html") } else { dir.join(&relative) };
    match tokio::fs::read(&file).await {
        Ok(bytes) => encoded(bytes, &file, path.starts_with("/assets/"), remux, headers).await,
        // A route in the app, not a file: the app's shell renders it.
        Err(_) if !path.rsplit('/').next().unwrap_or("").contains('.') => {
            let index = dir.join("index.html");
            match tokio::fs::read(&index).await {
                Ok(bytes) => encoded(bytes, &index, false, remux, headers).await,
                Err(_) => not_found(),
            }
        }
        Err(_) => not_found(),
    }
}

/// RFC 9110 §12.5.3: explicit refusals override wildcard acceptance, including across field lines.
/// Missing/empty headers conservatively get identity; malformed weights are never permission to encode.
pub(crate) fn encodings(headers: &HeaderMap) -> (u16, u16) {
    let (mut gzip, mut identity, mut wildcard): (Option<u16>, Option<u16>, Option<u16>) = (None, None, None);
    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else { continue };
        for coding in value.split(',') {
            let mut parts = coding.trim().split(';');
            let name = parts.next().unwrap_or("").trim();
            let weight = parts.next().map_or(1000, |p| {
                let Some((key, value)) = p.trim().split_once('=') else { return 0 };
                let value = value.trim();
                if !key.trim().eq_ignore_ascii_case("q") || parts.next().is_some() {
                    return 0;
                }
                let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
                if !matches!(whole, "0" | "1")
                    || fraction.len() > 3
                    || !fraction.bytes().all(|b| b.is_ascii_digit())
                {
                    return 0;
                }
                if whole == "1" {
                    return if fraction.bytes().all(|b| b == b'0') { 1000 } else { 0 };
                }
                fraction.parse::<u16>().unwrap_or(0) * 10_u16.pow(3 - fraction.len() as u32)
            });
            let slot = if name.eq_ignore_ascii_case("gzip") {
                &mut gzip
            } else if name.eq_ignore_ascii_case("identity") {
                &mut identity
            } else if name == "*" {
                &mut wildcard
            } else {
                continue;
            };
            *slot = Some(slot.map_or(weight, |prior| prior.min(weight)));
        }
    }
    (gzip.or(wildcard).unwrap_or(0), identity.unwrap_or(if wildcard == Some(0) { 0 } else { 1000 }))
}

async fn encoded(
    bytes: Vec<u8>,
    file: &Path,
    immutable: bool,
    remux: &[String],
    headers: &HeaderMap,
) -> Response {
    let (gzip, identity) = encodings(headers);
    if gzip > 0 && gzip >= identity {
        let mut sidecar = file.as_os_str().to_os_string();
        sidecar.push(".gz");
        // A hand-updated WEB_DIR must never serve a stale sidecar after its original changed.
        let fresh = match (tokio::fs::metadata(file).await, tokio::fs::metadata(&sidecar).await) {
            (Ok(original), Ok(compressed)) => match (original.modified(), compressed.modified()) {
                (Ok(original), Ok(compressed)) => compressed >= original,
                _ => false,
            },
            _ => false,
        };
        if fresh {
            if let Ok(compressed) = tokio::fs::read(sidecar).await {
                let mut response = respond(compressed, file, immutable, remux);
                response.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
                return revalidate(response, headers);
            }
        }
    }
    if identity == 0 {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_ACCEPTABLE;
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response.headers_mut().insert(header::VARY, HeaderValue::from_static("accept-encoding"));
        return response;
    }
    revalidate(respond(bytes, file, immutable, remux), headers)
}

/// Validators name the selected representation, so a gzip response cannot validate identity bytes.
/// GET/HEAD use weak comparison, including a list of tags or `*` (RFC 9110 §13.1.2).
fn revalidate(mut response: Response, request: &HeaderMap) -> Response {
    let Some(etag) = response.headers().get(header::ETAG) else { return response };
    let matched = request.get_all(header::IF_NONE_MATCH).iter().any(|line| {
        line.to_str().is_ok_and(|line| {
            line.split(',').any(|tag| {
                let tag = tag.trim();
                tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
            })
        })
    });
    if matched {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        *response.body_mut() = Body::empty();
    }
    response
}

/// The request path as a path under the web directory, or `None` if it would step outside it.
fn relative(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim_start_matches('/');
    let relative = PathBuf::from(trimmed);
    relative.components().all(|c| matches!(c, Component::Normal(_))).then_some(relative)
}

fn respond(bytes: Vec<u8>, file: &Path, immutable: bool, remux: &[String]) -> Response {
    let content_type = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    let etag = format!("\"{}\"", crate::hex(&Sha256::digest(&bytes)));
    let length = bytes.len();
    let mut resp = Response::new(Body::from(bytes));
    let headers = resp.headers_mut();
    headers.insert(header::ETAG, HeaderValue::from_str(&etag).expect("a quoted SHA-256 digest"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { "public, max-age=31536000, immutable" } else { "no-cache" }),
    );
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if content_type.starts_with("text/html") {
        let policy = HeaderValue::from_str(&csp(remux))
            .or_else(|_| HeaderValue::from_str(&csp(&[])))
            .expect("the policy is ASCII");
        headers.insert(header::CONTENT_SECURITY_POLICY, policy);
    }
    resp
}

fn not_found() -> Response {
    let mut resp = Response::new(Body::from("not found"));
    *resp.status_mut() = StatusCode::NOT_FOUND;
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    resp
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::{body_text, Harness};
    use axum::http::{header, StatusCode};
    use std::sync::Arc;

    #[test]
    fn policy_allows_local_wasm_without_allowing_javascript_eval() {
        let policy = super::csp(&[]);
        assert!(policy.contains("script-src 'self' 'wasm-unsafe-eval';"));
        assert!(!policy.contains("'unsafe-eval'"));
    }

    #[test]
    fn encoding_negotiation_respects_weights_refusals_and_multiple_fields() {
        for (value, expected) in [
            ("", (0, 1000)),
            ("gzip, br", (1000, 1000)),
            ("GZip; Q=0.8", (800, 1000)),
            ("*", (1000, 1000)),
            ("gzip;q=0, *", (0, 1000)),
            ("*;q=0", (0, 0)),
            ("gzip, *;q=0", (1000, 0)),
            ("identity;q=0.5, gzip;q=0.9", (900, 500)),
            ("identity, *;q=0", (0, 1000)),
            ("gzip;q=garbage", (0, 1000)),
            ("gzip;q=1.001", (0, 1000)),
            ("gzip;q=0.0001", (0, 1000)),
            ("gzip;q=0.001", (1, 1000)),
            ("gzip;q=1.000", (1000, 1000)),
        ] {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, value.parse().unwrap());
            assert_eq!(super::encodings(&headers), expected, "{value}");
        }
        let mut headers = axum::http::HeaderMap::new();
        headers.append(header::ACCEPT_ENCODING, "*".parse().unwrap());
        headers.append(header::ACCEPT_ENCODING, "gzip;q=0".parse().unwrap());
        assert_eq!(super::encodings(&headers), (0, 1000));
    }

    #[tokio::test]
    async fn conditional_requests_validate_the_selected_representation() {
        let h = with_app();
        let first = h.send("GET", "/", None, &[]).await;
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
        for method in ["GET", "HEAD"] {
            for condition in [etag.clone(), format!("\"old\", W/{etag}"), "*".into()] {
                let response = h.send(method, "/", None, &[("if-none-match", &condition)]).await;
                assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
                assert_eq!(response.headers()[header::VARY], "accept-encoding");
                assert_eq!(response.headers()[header::ETAG], etag);
                assert!(response.headers().contains_key(header::CONTENT_SECURITY_POLICY));
                assert!(body_text(response).await.is_empty());
            }
        }
        let mismatch = h.send("GET", "/", None, &[("if-none-match", "invalid")]).await;
        assert_eq!(mismatch.status(), StatusCode::OK);
        std::fs::write(h.dir.join("web/index.html"), "new app").unwrap();
        let changed = h.send("GET", "/", None, &[("if-none-match", &etag)]).await;
        assert_eq!(changed.status(), StatusCode::OK);
        assert_ne!(changed.headers()[header::ETAG], etag);
        std::fs::write(h.dir.join("web/index.html.gz"), b"compressed representation").unwrap();
        let gzip = h.send("GET", "/", None, &[("accept-encoding", "gzip")]).await;
        let gzip_etag = gzip.headers()[header::ETAG].to_str().unwrap().to_owned();
        let response =
            h.send("GET", "/", None, &[("accept-encoding", "gzip"), ("if-none-match", &gzip_etag)]).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        let identity = h.send("GET", "/", None, &[("if-none-match", &gzip_etag)]).await;
        assert_eq!(identity.status(), StatusCode::OK);
        assert_ne!(identity.headers()[header::ETAG], gzip_etag);
    }

    #[tokio::test]
    async fn precompressed_assets_keep_mime_cache_and_head_semantics() {
        let h = with_app();
        // gzip("console.log(1)"); the build also verifies every generated sidecar by decompression.
        let gzip: &[u8] = &[
            31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 75, 206, 207, 43, 206, 207, 73, 213, 203, 201, 79, 215, 48,
            212, 4, 0, 104, 254, 1, 67, 14, 0, 0, 0,
        ];
        std::fs::write(h.dir.join("web/assets/index-abc123.js.gz"), gzip).unwrap();
        let response = h.send("GET", "/assets/index-abc123.js", None, &[("accept-encoding", "gzip")]).await;
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        assert_eq!(response.headers()[header::VARY], "accept-encoding");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], gzip.len().to_string());
        assert_eq!(axum::body::to_bytes(response.into_body(), 1024).await.unwrap().as_ref(), gzip);
        let head = h.send("HEAD", "/assets/index-abc123.js", None, &[("accept-encoding", "gzip")]).await;
        assert_eq!(head.headers()[header::CONTENT_ENCODING], "gzip");
        assert_eq!(head.headers()[header::CONTENT_LENGTH], gzip.len().to_string());
        assert!(body_text(head).await.is_empty());
        let plain = h.send("GET", "/assets/index-abc123.js", None, &[("accept-encoding", "gzip;q=0")]).await;
        assert!(!plain.headers().contains_key(header::CONTENT_ENCODING));
        assert_eq!(plain.headers()[header::VARY], "accept-encoding");
        assert_eq!(body_text(plain).await, "console.log(1)");
        assert_eq!(
            h.send("GET", "/", None, &[("accept-encoding", "identity;q=0")]).await.status(),
            StatusCode::NOT_ACCEPTABLE
        );
        let api = h.send("GET", "/health", None, &[("accept-encoding", "gzip")]).await;
        assert!(!api.headers().contains_key(header::CONTENT_ENCODING));
        let original = std::fs::File::open(h.dir.join("web/assets/index-abc123.js")).unwrap();
        original.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(10)).unwrap();
        let stale = h.send("GET", "/assets/index-abc123.js", None, &[("accept-encoding", "gzip")]).await;
        assert!(!stale.headers().contains_key(header::CONTENT_ENCODING));
    }

    fn with_app() -> Harness {
        let mut h = Harness::new();
        let web = h.dir.join("web");
        std::fs::create_dir_all(web.join("assets")).unwrap();
        std::fs::write(web.join("index.html"), "<!doctype html><title>Den</title>").unwrap();
        std::fs::write(web.join("assets/index-abc123.js"), "console.log(1)").unwrap();
        std::fs::write(h.dir.join("secret.txt"), "outside").unwrap();
        Arc::get_mut(&mut h.state).unwrap().web_dir = Some(web);
        h
    }

    #[tokio::test]
    async fn the_app_is_served_at_the_root_with_its_routes_falling_back_to_the_shell() {
        let h = with_app();
        let root = h.send("GET", "/", None, &[]).await;
        assert_eq!(root.status(), StatusCode::OK);
        assert!(root.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("image.tmdb.org"));
        assert_eq!(root.headers()[header::CACHE_CONTROL], "no-cache");
        assert!(body_text(root).await.contains("<title>Den</title>"));

        let asset = h.send("GET", "/assets/index-abc123.js", None, &[]).await;
        assert_eq!(asset.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        assert_eq!(asset.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");

        let route = h.send("GET", "/movies/603", None, &[]).await;
        assert!(body_text(route).await.contains("<title>Den</title>"), "an app route gets the shell");
        assert_eq!(h.send("GET", "/assets/missing.js", None, &[]).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_api_answers_first_and_nothing_outside_the_app_is_served() {
        let h = with_app();
        assert_eq!(h.call("GET", "/health", None).await.1["status"], "ok");
        assert_eq!(h.call("GET", "/metrics", None).await.0, StatusCode::NOT_FOUND, "no token is still a 404");
        assert_eq!(h.call("POST", "/", None).await.0, StatusCode::NOT_FOUND);
        let escape = h.send("GET", "/../secret.txt", None, &[]).await;
        assert_ne!(body_text(escape).await, "outside");
    }

    #[tokio::test]
    async fn without_a_web_dir_the_root_is_the_old_404() {
        assert_eq!(Harness::new().call("GET", "/", None).await.0, StatusCode::NOT_FOUND);
    }
}
