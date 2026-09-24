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
    // PID 1 in a `scratch` image gets no default action for SIGTERM, so without this every stop waited out the
    // stop timeout and ended in SIGKILL. Requests in flight get a moment to finish, never longer.
    let (stopping, stopped) = tokio::sync::oneshot::channel::<()>();
    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        stop_signal().await;
        let _ = stopping.send(());
    });
    tokio::select! {
        served = serve => served.expect("serve cast files"),
        () = async {
            let _ = stopped.await;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        } => {}
    }
}

/// SIGTERM or SIGINT; never, if neither could be registered.
async fn stop_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) {
        (Ok(mut term), Ok(mut int)) => {
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
        }
        _ => std::future::pending().await,
    }
}

async fn index(axum::extract::State(root): axum::extract::State<Arc<PathBuf>>) -> Response<Body> {
    response(root.join("index.html"), false).await
}

async fn file(
    axum::extract::State(root): axum::extract::State<Arc<PathBuf>>,
    Path(path): Path<String>,
) -> Response<Body> {
    if path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return empty(StatusCode::NOT_FOUND);
    }
    let asset = path.starts_with("assets/");
    // Asynchronous file reads: this runs on a single-threaded runtime, where a blocking one stalls every request.
    let candidate = root.join(&path);
    if tokio::fs::metadata(&candidate).await.is_ok_and(|m| m.is_file()) {
        response(candidate, asset).await
    } else if !asset {
        response(root.join("index.html"), false).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_file_an_app_route_and_a_missing_asset() {
        let root = std::env::temp_dir().join(format!("den-cast-{}", std::process::id()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<html>").unwrap();
        std::fs::write(root.join("assets/app.js"), "x").unwrap();
        let root = axum::extract::State(Arc::new(root));
        let asset = file(root.clone(), Path("assets/app.js".into())).await;
        assert_eq!(asset.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
        let route = file(root.clone(), Path("receiver".into())).await;
        assert_eq!(route.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(file(root.clone(), Path("assets/gone.js".into())).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(file(root, Path("../etc/passwd".into())).await.status(), StatusCode::NOT_FOUND);
    }
}
