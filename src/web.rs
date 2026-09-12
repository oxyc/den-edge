//! The Den web app's built files (`WEB_DIR`; `/web` in the image), served at `/` beside the API — one origin
//! for the app and its sync, so no CORS and one certificate. A path with no file behind it and no extension
//! is one of the app's own routes and gets `index.html`. Vite's hashed files under `/assets/` are cached for
//! a year; everything else revalidates, so a release shows up on the next load.
//!
//! The app's routes must not reuse an API path (`/settings`, `/plugins`, `/link/…`): the API answers first.

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
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
         frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
}

pub async fn serve(dir: &Path, path: &str, remux: &[String]) -> Response {
    let Some(relative) = relative(path) else { return not_found() };
    let file = if relative.as_os_str().is_empty() { dir.join("index.html") } else { dir.join(&relative) };
    match tokio::fs::read(&file).await {
        Ok(bytes) => respond(bytes, &file, path.starts_with("/assets/"), remux),
        // A route in the app, not a file: the app's shell renders it.
        Err(_) if !path.rsplit('/').next().unwrap_or("").contains('.') => {
            let index = dir.join("index.html");
            match tokio::fs::read(&index).await {
                Ok(bytes) => respond(bytes, &index, false, remux),
                Err(_) => not_found(),
            }
        }
        Err(_) => not_found(),
    }
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
    let mut resp = Response::new(Body::from(bytes));
    let headers = resp.headers_mut();
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
