//! The Cast sender and away-browser player (`web/cast`, built into `CAST_DIR`; `/cast` in the image). The player
//! frames it cross-origin, so it lives on a name of its own — `CAST_ORIGIN`'s host — and that name answers nothing
//! else: no API route, no web app, not even `/health`. Its answers carry the headers the separate den-cast server
//! sent before this replaced it, and only those.

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use std::path::{Path, PathBuf};

/// Who may frame the page. The page is built with the same list (`VITE_DEN_PARENT_ORIGINS`) and answers only their
/// messages.
const PARENT_ORIGINS: &str = match option_env!("DEN_PARENT_ORIGINS") {
    Some(value) => value,
    None => "https://d.oxy.fi",
};

/// Whether `host`, a request's normalized host (`handler::request_host`), is `CAST_ORIGIN`'s.
pub fn is_host(cast_origin: Option<&str>, host: &str) -> bool {
    cast_origin
        .and_then(|origin| origin.strip_prefix("https://"))
        .and_then(|authority| authority.parse::<axum::http::uri::Authority>().ok())
        .is_some_and(|authority| authority.host().trim_end_matches('.').eq_ignore_ascii_case(host))
}

/// `/` or a file under `dir`. A path that is not a file is the page itself, so its own routes load it, except under
/// `assets/`, where a missing file is a 404. Without a `dir` every path is a 404: the name still answers nothing else.
pub async fn serve(dir: Option<&Path>, method: &Method, path: &str) -> Response<Body> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        let mut out = empty(StatusCode::METHOD_NOT_ALLOWED);
        out.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET,HEAD"));
        return out;
    }
    let Some(dir) = dir else { return empty(StatusCode::NOT_FOUND) };
    let path = path.strip_prefix('/').unwrap_or_default();
    if path.is_empty() {
        return response(dir.join("index.html"), false).await;
    }
    let Ok(path) = percent_encoding::percent_decode_str(path).decode_utf8() else {
        // axum's own rejection, word for word.
        const INVALID: &str = "Invalid URL: Invalid UTF-8 in `path`";
        let mut out = Response::new(Body::from(INVALID));
        *out.status_mut() = StatusCode::BAD_REQUEST;
        out.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
        out.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(INVALID.len()));
        return out;
    };
    let path = path.as_ref();
    if path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return empty(StatusCode::NOT_FOUND);
    }
    let asset = path.starts_with("assets/");
    let candidate = dir.join(path);
    if tokio::fs::metadata(&candidate).await.is_ok_and(|m| m.is_file()) {
        response(candidate, asset).await
    } else if !asset {
        response(dir.join("index.html"), false).await
    } else {
        empty(StatusCode::NOT_FOUND)
    }
}

async fn response(path: PathBuf, immutable: bool) -> Response<Body> {
    let Ok(bytes) = tokio::fs::read(&path).await else { return empty(StatusCode::NOT_FOUND) };
    let mime = match path.extension().and_then(|x| x.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    };
    // Inline styles are allowed because the Cast SDK reveals `<google-cast-launcher>` by setting its `style`; under
    // `style-src 'self'` the button stays `display: none` and nothing can be cast. Google serves the SDK unversioned,
    // so a hash of today's style would break on its next update. Scripts stay strict, and the page draws no user
    // content.
    let csp = format!(
        "default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self' 'unsafe-inline'; \
         img-src 'self' https: data:; media-src https: blob:; connect-src https:; object-src 'none'; \
         base-uri 'none'; form-action 'none'; frame-ancestors {PARENT_ORIGINS}"
    );
    let length = bytes.len();
    let mut out = Response::new(Body::from(bytes));
    let headers = out.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    // Named here rather than left to the body: a HEAD answer is emptied before it is sent and still says how long
    // the file is.
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { "public, max-age=31536000, immutable" } else { "no-cache" }),
    );
    headers
        .insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&csp).expect("valid parent origins"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow, noarchive"));
    out
}

fn empty(status: StatusCode) -> Response<Body> {
    let mut out = Response::new(Body::empty());
    *out.status_mut() = status;
    out.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    out
}

#[cfg(test)]
mod tests {
    use crate::handler::tests::{body_text, temp_dir, Harness};
    use axum::http::{header, StatusCode};
    use std::sync::Arc;

    const CSP: &str = "default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self' 'unsafe-inline'; \
                       img-src 'self' https: data:; media-src https: blob:; connect-src https:; object-src 'none'; \
                       base-uri 'none'; form-action 'none'; frame-ancestors https://d.oxy.fi";

    /// A den-edge serving the web app on `d.oxy.fi` and the Cast page on `cast.example`.
    fn harness() -> Harness {
        let web = temp_dir();
        std::fs::create_dir_all(web.join("assets")).unwrap();
        std::fs::write(web.join("index.html"), "<!doctype html><title>Den</title>").unwrap();
        std::fs::write(web.join("assets/web-app.js"), "web").unwrap();
        let cast = temp_dir();
        std::fs::create_dir_all(cast.join("assets")).unwrap();
        std::fs::write(cast.join("index.html"), "<title>Den Cast</title>").unwrap();
        std::fs::write(cast.join("assets/app.js"), "cast()").unwrap();
        std::fs::write(cast.join("assets/app.css"), "a{}").unwrap();
        std::fs::write(cast.join("icon.svg"), "<svg/>").unwrap();
        Harness::in_dir_with(temp_dir(), |state| {
            state.web_dir = Some(web);
            state.web_hosts = crate::parse_hosts("WEB_HOSTS", "d.oxy.fi");
            state.api_hosts = crate::parse_hosts("API_HOSTS", "d-api.oxy.fi");
            state.web_origins = vec!["https://d.oxy.fi".into(), "https://cast.example".into()];
            state.cast_origin = Some("https://cast.example".into());
            state.cast_dir = Some(cast);
        })
    }

    /// Every header the page's answers carry, in order, apart from the transport's own (`date`).
    fn headers(resp: &axum::response::Response) -> Vec<(String, String)> {
        resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned())).collect()
    }

    fn page(content_type: &str, length: &str, cache: &str) -> Vec<(String, String)> {
        [
            ("content-type", content_type),
            ("content-length", length),
            ("cache-control", cache),
            ("content-security-policy", CSP),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
            ("x-robots-tag", "noindex, nofollow, noarchive"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
    }

    /// The headers den-cast sent, exactly: no den-edge hardening, CORS, `vary` or request id on top, even for an
    /// origin `WEB_ORIGINS` names.
    #[tokio::test]
    async fn the_cast_host_answers_with_den_casts_headers_and_nothing_more() {
        let h = harness();
        let on_cast = |path: &'static str| {
            let h = &h;
            async move {
                h.send("GET", path, None, &[("host", "cast.example"), ("origin", "https://cast.example")])
                    .await
            }
        };
        let html = page("text/html; charset=utf-8", "23", "no-cache");
        for path in ["/", "/receiver", "/away/123?x=1", "/not-a-file.js"] {
            let resp = on_cast(path).await;
            assert_eq!(resp.status(), StatusCode::OK, "{path}");
            assert_eq!(headers(&resp), html, "{path}");
            assert_eq!(body_text(resp).await, "<title>Den Cast</title>", "{path}");
        }
        let immutable = "public, max-age=31536000, immutable";
        let js = on_cast("/assets/app.js").await;
        assert_eq!(headers(&js), page("text/javascript; charset=utf-8", "6", immutable));
        assert_eq!(body_text(js).await, "cast()");
        assert_eq!(
            headers(&on_cast("/assets/app.css").await),
            page("text/css; charset=utf-8", "3", immutable)
        );
        assert_eq!(headers(&on_cast("/icon.svg").await), page("image/svg+xml", "6", "no-cache"));
        // Paths are percent-decoded first, as axum's `Path` did for den-cast.
        assert_eq!(body_text(on_cast("/assets/app%2Ejs").await).await, "cast()");
        assert_eq!(on_cast("/assets/%2e%2e/index.html").await.status(), StatusCode::NOT_FOUND);
        let invalid = on_cast("/x%FF").await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_text(invalid).await, "Invalid URL: Invalid UTF-8 in `path`");

        // A HEAD says what a GET would, without the body.
        let head = h.send("HEAD", "/assets/app.js", None, &[("host", "cast.example")]).await;
        assert_eq!(headers(&head), page("text/javascript; charset=utf-8", "6", immutable));
        assert_eq!(body_text(head).await, "");

        let missing = vec![("content-length".to_owned(), "0".to_owned())];
        for path in ["/assets/gone.js", "/assets/../index.html", "/a//b", "/receiver/", "/./x"] {
            let resp = on_cast(path).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(headers(&resp), missing, "{path}");
        }
        let post = h.send("POST", "/", Some("{}".into()), &[("host", "cast.example")]).await;
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            headers(&post),
            vec![("content-length".to_owned(), "0".to_owned()), ("allow".to_owned(), "GET,HEAD".to_owned())]
        );
    }

    /// The Cast SDK reveals its launcher with an inline style, which the page's policy must admit; its scripts stay
    /// limited to the page's own and the SDK's.
    #[tokio::test]
    async fn the_cast_page_admits_inline_styles_and_no_inline_script() {
        let h = harness();
        let resp = h.send("GET", "/", None, &[("host", "cast.example")]).await;
        let csp = resp.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_owned();
        let directive = |name: &str| {
            csp.split(';').map(str::trim).find(|d| d.starts_with(&format!("{name} "))).unwrap().to_owned()
        };
        assert_eq!(directive("style-src"), "style-src 'self' 'unsafe-inline'");
        assert_eq!(directive("script-src"), "script-src 'self' https://www.gstatic.com");
    }

    /// The Cast page's name is public and outside Access: it must not become another way into den-edge. Every route
    /// that answers on the LAN face answers there as the page itself or a bare 404, never as den-edge.
    #[tokio::test]
    async fn the_cast_host_exposes_no_other_route() {
        let h = harness();
        for path in [
            "/health",
            "/version",
            "/config",
            "/routes",
            "/metrics",
            "/lib/abc",
            "/lib/abc/batch",
            "/den/config/playback",
            "/remux/session",
            "/tmdb/3/movie/550",
            "/pair/new",
            "/inbox/drain",
            "/grant/redeem",
            "/oauth/authorize",
            "/playback/cast",
            "/scout/manifest.json",
        ] {
            for host in ["cast.example", "CAST.example.:443"] {
                let resp = h.send("GET", path, None, &[("host", host)]).await;
                assert_eq!(resp.status(), StatusCode::OK, "GET {path} on {host}");
                assert!(!resp.headers().contains_key("x-request-id"), "GET {path} on {host}");
                assert_eq!(body_text(resp).await, "<title>Den Cast</title>", "GET {path} on {host}");
                let post = h.send("POST", path, Some("{}".into()), &[("host", host)]).await;
                assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED, "POST {path} on {host}");
                assert_eq!(body_text(post).await, "", "POST {path} on {host}");
            }
        }
        // The web app's own files are not the Cast page's.
        let asset = h.send("GET", "/assets/web-app.js", None, &[("host", "cast.example")]).await;
        assert_eq!(asset.status(), StatusCode::NOT_FOUND);
        // A preflight is refused like any other method, with no CORS grant.
        let preflight = h
            .send(
                "OPTIONS",
                "/lib/abc",
                None,
                &[
                    ("host", "cast.example"),
                    ("origin", "https://cast.example"),
                    ("access-control-request-method", "POST"),
                ],
            )
            .await;
        assert_eq!(preflight.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(!preflight.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    /// The other names are untouched: the web app on its own, den-edge on the rest, and none of them the Cast page.
    #[tokio::test]
    async fn other_names_never_serve_the_cast_page() {
        let h = harness();
        for host in ["d.oxy.fi", "d-api.oxy.fi", "den.lan", "cast.example.evil"] {
            let health = h.send("GET", "/health", None, &[("host", host)]).await;
            assert_eq!(health.status(), StatusCode::OK, "{host}");
            assert!(health.headers().contains_key("x-request-id"), "{host}");
            let asset = h.send("GET", "/assets/app.js", None, &[("host", host)]).await;
            assert_eq!(asset.status(), StatusCode::NOT_FOUND, "{host}");
        }
        let web = h.send("GET", "/", None, &[("host", "d.oxy.fi")]).await;
        assert_eq!(body_text(web).await, "<!doctype html><title>Den</title>");
    }

    /// With `CAST_ORIGIN` set but no `CAST_DIR`, the name still answers nothing of den-edge's.
    #[tokio::test]
    async fn without_its_files_the_cast_host_is_all_404() {
        let mut h = harness();
        Arc::get_mut(&mut h.state).unwrap().cast_dir = None;
        for path in ["/", "/health", "/lib/abc", "/config"] {
            let resp = h.send("GET", path, None, &[("host", "cast.example")]).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(body_text(resp).await, "", "{path}");
        }
    }
}
