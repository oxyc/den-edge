//! Opt-in HTTP fixture for the real Web LibraryLog integration. Only the body scheduling is injected;
//! authentication, admission, handlers, encryption on the client, and persistent storage stay real.
use super::*;
use crate::handler::tests::Harness;
use axum::body::Bytes;
use std::future::Future;
use tokio::sync::Notify;

#[derive(Default)]
struct Gates {
    entered: Notify,
    release: Arc<Notify>,
    shutdown: Arc<Notify>,
}

struct HeldBody {
    inner: Body,
    entered: Option<Arc<Gates>>,
    released: Pin<Box<dyn Future<Output = ()> + Send>>,
    ready: bool,
}

impl http_body::Body for HeldBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, axum::Error>>> {
        if let Some(gates) = self.entered.take() {
            gates.entered.notify_one();
        }
        if !self.ready {
            if self.released.as_mut().poll(cx).is_pending() {
                return Poll::Pending;
            }
            self.ready = true;
        }
        Pin::new(&mut self.inner).poll_frame(cx)
    }
}

/// Started and stopped by `DEN_EDGE_REAL_RECOVERY=1 npm test -- src/lib/log.edge.test.ts`.
#[tokio::test]
#[ignore = "local HTTP fixture for the opt-in real Web client integration"]
async fn serve_real_client() {
    let h = Harness::in_dir(std::env::var_os("EDGE_RECOVERY_DIR").expect("test data directory").into());
    let state = Arc::clone(&h.state);
    let gates = Arc::new(Gates::default());
    let shutdown = Arc::clone(&gates.shutdown);
    let release_on_shutdown = Arc::clone(&gates.release);
    let app = axum::Router::new().fallback(move |mut req: Request| {
        let state = Arc::clone(&state);
        let gates = Arc::clone(&gates);
        async move {
            match req.uri().path() {
                "/__test/entered" => {
                    if tokio::time::timeout(std::time::Duration::from_secs(15), gates.entered.notified())
                        .await
                        .is_err()
                    {
                        return json_reply(
                            StatusCode::REQUEST_TIMEOUT,
                            &json!({"error":"body_gate_not_entered"}),
                        );
                    }
                    return json_reply(StatusCode::OK, &json!({}));
                }
                "/__test/release" => {
                    gates.release.notify_one();
                    return json_reply(StatusCode::OK, &json!({}));
                }
                "/__test/shutdown" => {
                    gates.release.notify_waiters();
                    gates.shutdown.notify_one();
                    return json_reply(StatusCode::OK, &json!({}));
                }
                _ => {}
            }
            if req.headers().contains_key("x-den-test-hold-body") {
                let (parts, inner) = req.into_parts();
                let release = Arc::clone(&gates.release);
                let released = Box::pin(async move {
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_secs(30), release.notified_owned())
                            .await;
                });
                req = Request::from_parts(
                    parts,
                    Body::new(HeldBody { inner, entered: Some(gates), released, ready: false }),
                );
            }
            req.extensions_mut()
                .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 5000))));
            crate::handler::handle(axum::extract::State(state), req).await
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!("EDGE_RECOVERY_URL=http://{}", listener.local_addr().unwrap());
    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        shutdown.notified_owned().await;
        release_on_shutdown.notify_waiters();
    });
    tokio::time::timeout(std::time::Duration::from_secs(240), std::future::IntoFuture::into_future(serve))
        .await
        .expect("test server lifetime exceeded")
        .unwrap();
}
