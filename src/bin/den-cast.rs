//! A deliberately tiny, idle static server for cast.oxy.fi.

use axum::{
    body::Body,
    extract::Path,
    http::{header, HeaderValue, Response, StatusCode},
    routing::get,
    Router,
};
use std::{path::PathBuf, sync::Arc};

const PARENT_ORIGINS: &str = match option_env!("DEN_PARENT_ORIGINS") {
    Some(value) => value,
    None => "https://d.oxy.fi",
};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let root = Arc::new(PathBuf::from(std::env::var("WEB_DIR").unwrap_or_else(|_| "/web".into())));
    let app = Router::new().route("/", get(index)).route("/{*path}", get(file)).with_state(root);
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let listener =
        tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.expect("bind cast listener");
    axum::serve(listener, app).await.expect("serve cast files");
}

async fn index(axum::extract::State(root): axum::extract::State<Arc<PathBuf>>) -> Response<Body> {
    response(root.join("index.html"), false)
}

async fn file(
    axum::extract::State(root): axum::extract::State<Arc<PathBuf>>,
    Path(path): Path<String>,
) -> Response<Body> {
    if path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return empty(StatusCode::NOT_FOUND);
    }
    let asset = path.starts_with("assets/");
    let candidate = root.join(&path);
    if candidate.is_file() {
        response(candidate, asset)
    } else if !asset {
        response(root.join("index.html"), false)
    } else {
        empty(StatusCode::NOT_FOUND)
    }
}

fn response(path: PathBuf, immutable: bool) -> Response<Body> {
    let Ok(bytes) = std::fs::read(&path) else { return empty(StatusCode::NOT_FOUND) };
    let mime = match path.extension().and_then(|x| x.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    };
    let csp = format!(
        "default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self'; \
         img-src 'self' https: data:; media-src https: blob:; connect-src https:; object-src 'none'; \
         base-uri 'none'; form-action 'none'; frame-ancestors {PARENT_ORIGINS}"
    );
    let mut out = Response::new(Body::from(bytes));
    out.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    out.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { "public, max-age=31536000, immutable" } else { "no-cache" }),
    );
    out.headers_mut()
        .insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&csp).expect("valid parent origins"));
    out.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    out.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.headers_mut().insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow, noarchive"));
    out
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder().status(status).body(Body::empty()).expect("empty response")
}
