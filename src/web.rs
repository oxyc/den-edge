//! The Den web app's built files (`WEB_DIR`; `/web` in the image), served at `/` beside the API — one origin
//! for the app and its sync, so no CORS and one certificate. A path with no file behind it and no extension
//! is one of the app's own routes and gets `index.html`. Vite's hashed files under `/assets/` are cached for
//! a year; the shell and the service worker revalidate, so a release shows up on the next load; the rest of
//! what is unhashed (icons, the share image) is kept a day.
//!
//! The app's routes must not reuse an API path (`/settings`, `/plugins`, `/link/…`): the API answers first.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::Response;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

/// What the app may load and call: itself — its addons too, which it asks through this origin (`relay.rs`, or
/// `tailscale serve` on the tailnet) — TMDB's images and API, OMDb's ratings (both BYOK, straight from the
/// browser), YouTube's embed for trailers, YouTube's own media hosts — den-reel's `/direct` hands the page a
/// googlevideo URL so the trailer streams from there instead of crossing the homelab twice — Apple's preview
/// host, whose trailers are streamed from their CDN rather than kept here, which is what their terms ask —
/// and den-remux's
/// video: `blob:` for hls.js, which hands the video element a MediaSource.
///
/// `media` is den-remux's and den-reel's https origins from the routes table (already checked to be bare
/// origins). Reel's were missing, and a trailer is fetched from reel itself — so on the public and tailnet
/// names the policy refused every one of them, which a page reports only as a media load that failed.
///
/// `https://*.ts.net:8443` is there because the routes table cannot name the address the page will actually
/// use. On the public name the table deliberately withholds den-remux — a stranger is told nothing about a
/// household's tailnet — so the page falls back to the tailnet address it stored for itself, and a policy
/// built from the table has no entry for it. Video never crosses the Cloudflare tunnel, so that fallback is
/// the only way playback works away from the LAN, and without this it failed as a blocked media load with
/// nothing on the server to show why. A wildcard rather than one host because a tailnet's name belongs to
/// its household, not to this box: `pve.tailce93d3.ts.net` is only ours. It is bounded by the scheme and by
/// `tailscale serve`'s port, and it grants nothing a tailnet peer could not already reach — reaching one at
/// all requires being on it.
///
/// OMDb is not here either: the IMDb, Rotten Tomatoes and Metacritic figures come through `/ratings/`
/// (`ratings.rs`), which keeps each title for every device.
///
/// doesthedogdie is NOT here, and naming it was a wasted release: the content warnings are fetched with an
/// `x-api-key` header, which makes the browser preflight, and they answer no preflight and send no
/// `Access-Control-Allow-Origin` at all. A page cannot call them however the policy is written — only the TV
/// can, because a native request is not CORS-checked. So `/warnings/` proxies them here (`warnings.rs`) and
/// the page asks this origin, which `'self'` already covers.
fn csp(media: &[String]) -> String {
    let media: String = media.iter().map(|o| format!(" {o}")).collect();
    format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: https://image.tmdb.org; \
         media-src 'self' blob: data: https://*.googlevideo.com https://video-ssl.itunes.apple.com \
         https://*.ts.net:8443{media}; \
         connect-src 'self' https://api.themoviedb.org https://*.ts.net:8443{media}; \
         frame-src https://www.youtube-nocookie.com; \
         object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
}

/// Whether an origin names a tailnet host. The exact name is a household's own — `pve.tailce93d3.ts.net` is
/// ours — and putting it in a policy served on a public name publishes it to anyone who loads the page.
fn tailnet(origin: &str) -> bool {
    let rest = origin.split("://").nth(1).unwrap_or(origin);
    let host = rest.split(['/', ':']).next().unwrap_or("");
    host.trim_end_matches('.').to_ascii_lowercase().ends_with(".ts.net")
}

/// The media origins a browser on the public web name is told about: every one except the tailnet's. Nothing
/// is lost by it — `https://*.ts.net:8443` in the policy already allows the tailnet address a household's own
/// page stored for itself, which is the whole reason the wildcard is there. It was meant to replace the exact
/// host on that name rather than stand beside it.
fn public_media(media: &[String]) -> Vec<String> {
    media.iter().filter(|origin| !tailnet(origin)).cloned().collect()
}

pub async fn serve(
    state: &crate::AppState,
    path: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    face: crate::handler::Face,
) -> Response {
    let Some(dir) = state.web_dir.as_deref() else { return not_found() };
    let kept: Vec<String>;
    let media: &[String] = match face {
        crate::handler::Face::Web => {
            kept = public_media(&state.media_origins);
            &kept
        }
        _ => &state.media_origins,
    };
    let Some(relative) = relative(path) else { return not_found() };
    let asked = if relative.as_os_str().is_empty() { dir.join("index.html") } else { dir.join(&relative) };
    let (bytes, file, immutable) = match tokio::fs::read(&asked).await {
        Ok(bytes) => (bytes, asked, path.starts_with("/assets/")),
        // A route in the app, not a file: the app's shell renders it.
        Err(_) if !path.rsplit('/').next().unwrap_or("").contains('.') => {
            let index = dir.join("index.html");
            match tokio::fs::read(&index).await {
                Ok(bytes) => (bytes, index, false),
                Err(_) => return not_found(),
            }
        }
        Err(_) => return not_found(),
    };
    // The shell says which page this is before any of it has run, for whatever is about to build a link
    // preview from it (`meta.rs`). Injected bytes are served as they are: the gzip sidecar on disk is of the
    // file, not of this answer, and serving it would hand out the generic block to everything that asks for
    // gzip — which is everything.
    if file.file_name().is_some_and(|name| name == "index.html") {
        if let Some(html) = crate::meta::rewrite(state, &bytes, path, query, headers).await {
            return crate::cache::revalidate(respond(html.into_bytes(), &file, false, media), headers);
        }
    }
    encoded(bytes, &file, immutable, media, headers).await
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
    media: &[String],
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
                let mut response = respond(compressed, file, immutable, media);
                response.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
                return crate::cache::revalidate(response, headers);
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
    crate::cache::revalidate(respond(bytes, file, immutable, media), headers)
}

/// The request path as a path under the web directory, or `None` if it would step outside it.
fn relative(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim_start_matches('/');
    let relative = PathBuf::from(trimmed);
    relative.components().all(|c| matches!(c, Component::Normal(_))).then_some(relative)
}

fn respond(bytes: Vec<u8>, file: &Path, immutable: bool, media: &[String]) -> Response {
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
    // The shell and the service worker name every other file of a release, so they are asked again on every load.
    // What else sits unhashed beside them — the icons, the share image, the manifest — changes perhaps once a year,
    // and a day's wait for a new one is no loss.
    let policy = if immutable {
        "public, max-age=31536000, immutable"
    } else if content_type.starts_with("text/html") || file.file_name().is_some_and(|name| name == "sw.js") {
        "no-cache"
    } else {
        "public, max-age=86400, stale-while-revalidate=604800"
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if content_type.starts_with("text/html") {
        let policy = HeaderValue::from_str(&csp(media))
            .or_else(|_| HeaderValue::from_str(&csp(&[])))
            .expect("the policy is ASCII");
        headers.insert(header::CONTENT_SECURITY_POLICY, policy);
        // `robots.txt` asks crawlers not to fetch; this tells the ones that fetch anyway not to keep what
        // they got. A household's library is nobody's search result. Link unfurlers are unaffected — they
        // draw a card from the page they fetched and publish no index — so shared links still show a title
        // and a poster.
        headers.insert(ROBOTS, HeaderValue::from_static("noindex, nofollow, noarchive, noimageindex"));
    }
    resp
}

const ROBOTS: HeaderName = HeaderName::from_static("x-robots-tag");

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

    /// The wildcard REPLACES the exact tailnet host on the browser's public name rather than joining it:
    /// naming `pve.tailce93d3.ts.net` in a policy served to anyone who loads the page publishes whose
    /// household it is, and the wildcard already allows the address that page stored for itself. Every other
    /// name — the LAN, the tailnet itself, the device API — is told the whole list, as before.
    #[test]
    fn the_public_name_is_told_every_media_origin_but_the_tailnets() {
        let media = [
            "https://pve.tailce93d3.ts.net:8443".to_owned(),
            "http://192.168.86.193:8095/remux".to_owned(),
            "https://d-remux.oxy.fi".to_owned(),
        ];
        assert_eq!(
            super::public_media(&media),
            ["http://192.168.86.193:8095/remux", "https://d-remux.oxy.fi"]
        );
        assert!(super::tailnet("https://pve.tailce93d3.ts.net:8443"));
        assert!(super::tailnet("https://pve.tailce93d3.ts.net:8443/remux"));
        assert!(!super::tailnet("https://d-remux.oxy.fi"));
        // A suffix, not the host: the name has to END there.
        assert!(!super::tailnet("https://evil.ts.net.attacker.example"));
    }

    /// A household's tailnet address is the one the page falls back to when the routes table withholds
    /// den-remux, which it does on the public name — so the policy has to allow it without being able to
    /// name it. Both directives: the video is a media load, and hls.js fetches its segments with XHR.
    #[test]
    fn policy_allows_a_tailnet_it_cannot_name() {
        let policy = super::csp(&[]);
        let media = policy.split("media-src").nth(1).expect("a media-src directive");
        let media = media.split(';').next().expect("the directive ends");
        assert!(media.contains("https://*.ts.net:8443"), "{policy}");
        let connect = policy.split("connect-src").nth(1).expect("a connect-src directive");
        let connect = connect.split(';').next().expect("the directive ends");
        assert!(connect.contains("https://*.ts.net:8443"), "{policy}");
        // Bounded: https, and the one port `tailscale serve` publishes.
        assert!(!policy.contains("*.ts.net "), "the port is part of it: {policy}");
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
        assert_eq!(root.headers()[super::ROBOTS], "noindex, nofollow, noarchive, noimageindex");
        assert_eq!(root.headers()[header::CACHE_CONTROL], "no-cache");
        assert!(body_text(root).await.contains("<title>Den</title>"));

        let asset = h.send("GET", "/assets/index-abc123.js", None, &[]).await;
        assert_eq!(asset.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        assert_eq!(asset.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");

        // Unhashed files beside the shell are kept a day; the service worker, like the shell, is asked every load.
        std::fs::write(h.dir.join("web/og.png"), "png").unwrap();
        std::fs::write(h.dir.join("web/sw.js"), "self.skipWaiting()").unwrap();
        let og = h.send("GET", "/og.png", None, &[]).await;
        assert_eq!(
            og.headers()[header::CACHE_CONTROL],
            "public, max-age=86400, stale-while-revalidate=604800"
        );
        assert_eq!(h.send("GET", "/sw.js", None, &[]).await.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(
            h.send("GET", "/index.html", None, &[]).await.headers()[header::CACHE_CONTROL],
            "no-cache"
        );

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
