//! Real HTTP admission/body/lock barriers against the durable library authority.
use super::*;
use crate::handler::tests::{body_json, Harness};
use axum::body::Bytes;
use std::future::Future;
use tokio::sync::oneshot;

const LIB: &str = "0123456789abcdef0123456789abcdef";
const TOKEN: &str = "the-write-token";
const K1: &str = "aaaaaaaaaaaaaaaa";
const K2: &str = "bbbbbbbbbbbbbbbb";

/// Mutations without a request body use an explicit barrier after actual HTTP admission instead.
#[derive(Clone)]
pub(super) struct AdmissionGate(Arc<tokio::sync::Barrier>);

impl AdmissionGate {
    pub(super) async fn pause(&self) {
        self.0.wait().await;
        self.0.wait().await;
    }
}

struct DelayedBody {
    started: Option<oneshot::Sender<()>>,
    release: Option<oneshot::Receiver<Bytes>>,
    consumed: Option<oneshot::Sender<()>>,
}

impl http_body::Body for DelayedBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Infallible>>> {
        if let Some(started) = self.started.take() {
            started.send(()).unwrap();
        }
        let Some(release) = self.release.as_mut() else {
            if let Some(consumed) = self.consumed.take() {
                let _ = consumed.send(());
            }
            return Poll::Ready(None);
        };
        match Pin::new(release).poll(cx) {
            Poll::Ready(Ok(bytes)) => {
                self.release = None;
                Poll::Ready(Some(Ok(http_body::Frame::data(bytes))))
            }
            Poll::Ready(Err(_)) => panic!("test dropped its body barrier"),
            Poll::Pending => Poll::Pending,
        }
    }
}

fn delayed(
    action: &str,
    wire: Option<&str>,
    generation: &str,
) -> (Request, oneshot::Receiver<()>, oneshot::Sender<Bytes>, oneshot::Receiver<()>) {
    let (started, observed) = oneshot::channel();
    let (release, waiting) = oneshot::channel();
    let (consumed, drained) = oneshot::channel();
    let mut builder = Request::builder()
        .method("POST")
        .uri(format!("/lib/{LIB}/{action}"))
        .header(TOKEN_HEADER, TOKEN)
        .header(GENERATION_HEADER, generation);
    if let Some(wire) = wire {
        builder = builder.header(WIRE_HEADER, wire);
    }
    let request = builder
        .body(Body::new(DelayedBody {
            started: Some(started),
            release: Some(waiting),
            consumed: Some(consumed),
        }))
        .unwrap();
    (request, observed, release, drained)
}

// Poll the real handler until it reaches the named boundary. Biased polling ensures that when the body signals
// EOF, the request has continued through parsing to its pending library lock before this helper returns.
async fn reached(request: &mut Pin<&mut impl Future<Output = Response>>, barrier: oneshot::Receiver<()>) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::select! {
            biased;
            response = request => panic!("request completed before its barrier: {}", response.status()),
            result = barrier => result.unwrap(),
        }
    })
    .await
    .expect("request did not reach the barrier");
}

async fn post(h: &Harness, action: &str, wire: &str, generation: &str, body: Value) -> Response {
    h.send(
        "POST",
        &format!("/lib/{LIB}/{action}"),
        Some(body.to_string()),
        &[(TOKEN_HEADER, TOKEN), (WIRE_HEADER, wire), (GENERATION_HEADER, generation)],
    )
    .await
}

fn generation(response: &Response) -> String {
    response.headers()[GENERATION_HEADER].to_str().unwrap().to_owned()
}

async fn create(h: &Harness, wire: &str) -> String {
    let response = h
        .send(
            "POST",
            &format!("/lib/{LIB}/batch"),
            Some(json!({"writes":[{"k":K1,"base":0,"v":"before"}]}).to_string()),
            &[(TOKEN_HEADER, TOKEN), (WIRE_HEADER, wire), (WIRE_MIN_HEADER, wire), (GENERATION_HEADER, "0")],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[WIRE_MIN_HEADER], wire);
    generation(&response)
}

async fn stage(h: &Harness, wire: &str, generation: &str) -> (String, u64) {
    let opened = post(h, "rewrite", wire, generation, json!({})).await;
    assert_eq!(opened.status(), StatusCode::OK);
    let opened = body_json(opened).await;
    let rewrite = opened["rewrite"].as_str().unwrap().to_owned();
    let staged = post(
        h,
        &format!("rewrite/{rewrite}/rows"),
        wire,
        generation,
        json!({"writes":[{"k":K2,"v":"after"}]}),
    )
    .await;
    assert_eq!(staged.status(), StatusCode::OK);
    (rewrite, opened["base"].as_u64().unwrap())
}

async fn commit(h: &Harness, wire: &str, generation: &str, rewrite: &str, base: u64) -> Response {
    let response = post(
        h,
        &format!("rewrite/{rewrite}/commit"),
        wire,
        generation,
        json!({"base":base,"wireMin":wire.parse::<u64>().unwrap()}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    response
}

async fn read(h: &Harness) -> Value {
    let response = h
        .send("GET", &format!("/lib/{LIB}/changes"), None, &[(TOKEN_HEADER, TOKEN), (WIRE_HEADER, "4")])
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

async fn refused(response: Response, wire: &str, current: &str, upgrade: bool) {
    assert_eq!(response.headers()[GENERATION_HEADER], current);
    assert_eq!(response.headers()[WIRE_MIN_HEADER], wire);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.status(), if upgrade { StatusCode::UPGRADE_REQUIRED } else { StatusCode::CONFLICT });
    let answer = body_json(response).await;
    assert_eq!(answer["error"], if upgrade { "upgrade_required" } else { "generation_changed" });
    if upgrade {
        assert_eq!(answer["min"], wire.parse::<u64>().unwrap());
    }
}

#[tokio::test]
async fn delayed_batches_cannot_cross_completed_rewrites() {
    for (old_wire, new_wire) in [(Some("3"), "4"), (Some("3"), "3"), (None, "3")] {
        let h = Harness::new();
        let old = create(&h, old_wire.unwrap_or("2")).await;
        let (current, before, base) = {
            let (request, observed, release, _) = delayed("batch", old_wire, &old);
            let mut pending = std::pin::pin!(h.send_request(request));
            reached(&mut pending, observed).await;
            let (rewrite, base) = stage(&h, new_wire, &old).await;
            let current = generation(&commit(&h, new_wire, &old, &rewrite, base).await);
            assert_ne!(current, old);
            let before = read(&h).await;
            release
                .send(Bytes::from(json!({"writes":[{"k":K1,"base":0,"v":"obsolete"}]}).to_string()))
                .unwrap();
            refused(pending.await, new_wire, &current, old_wire != Some(new_wire)).await;
            (current, before, base)
        };
        assert_eq!(read(&h).await, before, "rejection must change neither rows nor head");

        // The recovery headers let a current client read the new snapshot and keep normal row-CAS behavior.
        let conflict =
            post(&h, "batch", new_wire, &current, json!({"writes":[{"k":K2,"base":0,"v":"wrong-base"}]}))
                .await;
        assert_eq!(conflict.status(), StatusCode::OK);
        let conflict = body_json(conflict).await;
        assert_eq!(conflict["applied"], json!([]));
        assert_eq!(conflict["conflicts"], json!([{"k":K2,"seq":base+1,"v":"after"}]));
        let accepted =
            post(&h, "batch", new_wire, &current, json!({"writes":[{"k":K2,"base":base+1,"v":"current"}]}))
                .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let final_state = read(&h).await;
        assert_eq!(final_state["entries"], json!([{"k":K2,"seq":base+2,"v":"current"}]));
        let dir = h.dir.clone();
        drop(h);
        let reopened = Harness::in_dir(dir);
        assert_eq!(read(&reopened).await, final_state);
    }
}

#[tokio::test]
async fn batch_waiting_for_the_library_lock_rechecks_after_rewrite_commit() {
    let h = Harness::new();
    let old = create(&h, "3").await;
    let (batch, observed, release, drained) = delayed("batch", Some("3"), &old);
    let mut batch = std::pin::pin!(h.send_request(batch));
    reached(&mut batch, observed).await;
    let (rewrite, base) = stage(&h, "3", &old).await;
    let (commit, observed, commit_release, commit_drained) =
        delayed(&format!("rewrite/{rewrite}/commit"), Some("3"), &old);
    let mut commit = std::pin::pin!(h.send_request(commit));
    reached(&mut commit, observed).await;
    let slot = h.state.libraries.slot(LIB, h.state.now());
    let lock = slot.library.lock().await;
    commit_release.send(Bytes::from(json!({"base":base,"wireMin":3}).to_string())).unwrap();
    reached(&mut commit, commit_drained).await;
    release.send(Bytes::from(json!({"writes":[{"k":K1,"base":0,"v":"obsolete"}]}).to_string())).unwrap();
    reached(&mut batch, drained).await;
    drop(lock); // FIFO: the real rewrite handler owns the lock before the already-admitted batch.
    let (committed, response) = tokio::join!(commit, batch);
    assert_eq!(committed.status(), StatusCode::OK);
    let current = generation(&committed);
    refused(response, "3", &current, false).await;
    assert_eq!(read(&h).await["entries"], json!([{"k":K2,"seq":base+1,"v":"after"}]));
}

#[tokio::test]
async fn delayed_batch_rechecks_a_library_only_restore() {
    let h = Harness::new();
    let original = create(&h, "3").await;
    let database = h.state.library_v3.path(LIB);
    let backup = h.dir.join("before-rewrite.redb");
    std::fs::copy(&database, &backup).unwrap();
    let (rewrite, base) = stage(&h, "3", &original).await;
    let old = generation(&commit(&h, "3", &original, &rewrite, base).await);
    let (request, observed, release, _) = delayed("batch", Some("3"), &old);
    let mut pending = std::pin::pin!(h.send_request(request));
    reached(&mut pending, observed).await;
    // Inject a restored file at the closed-handle reopen boundary. This is not an online restore API: operators
    // stop Edge for a restore, so a real process restart cannot preserve an in-flight HTTP request. The separate
    // stopped-store test covers that supported lifecycle. No library lease lives across this body wait.
    h.state.library_v3.clear();
    std::fs::copy(&backup, &database).unwrap();
    let before = read(&h).await;
    let current = before["generation"].as_str().unwrap();
    assert_ne!(current, old);
    assert_eq!(before["entries"], json!([{"k":K1,"seq":1,"v":"before"}]));
    release.send(Bytes::from(json!({"writes":[{"k":K2,"base":0,"v":"obsolete"}]}).to_string())).unwrap();
    refused(pending.await, "3", current, false).await;
    assert_eq!(read(&h).await, before);
}

#[tokio::test]
async fn stopped_store_restore_refuses_the_old_client_and_accepts_current_recovery() {
    let h = Harness::new();
    let old = create(&h, "3").await;
    let dir = h.dir.clone();
    drop(h);
    // The supported full-store restore lifecycle: stop, remove the store epoch as restore tooling does, reopen.
    std::fs::remove_file(dir.join("generation")).unwrap();
    let restored = Harness::in_dir(dir);
    let before = read(&restored).await;
    let current = before["generation"].as_str().unwrap();
    assert_ne!(current, old);
    let writes = json!({"writes":[{"k":K2,"base":0,"v":"recovered"}]});
    refused(post(&restored, "batch", "3", &old, writes.clone()).await, "3", current, false).await;
    assert_eq!(read(&restored).await, before);
    assert_eq!(post(&restored, "batch", "3", current, writes).await.status(), StatusCode::OK);
    assert_eq!(read(&restored).await["head"], 2);
}

#[tokio::test]
async fn unchanged_delayed_writer_succeeds_and_cancelled_body_cannot_write() {
    let h = Harness::new();
    let current = create(&h, "3").await;
    let before = read(&h).await;
    let (request, observed, _release, _) = delayed("batch", Some("3"), &current);
    {
        let mut cancelled = std::pin::pin!(h.send_request(request));
        reached(&mut cancelled, observed).await;
    }
    assert_eq!(read(&h).await, before);
    let (request, observed, release, _) = delayed("batch", Some("3"), &current);
    let mut pending = std::pin::pin!(h.send_request(request));
    reached(&mut pending, observed).await;
    release.send(Bytes::from(json!({"writes":[{"k":K2,"base":0,"v":"current"}]}).to_string())).unwrap();
    let response = pending.await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["applied"], json!([{"k":K2,"seq":2}]));
}

#[tokio::test]
async fn admitted_member_delete_and_rewrite_open_cannot_cross_a_rewrite() {
    for action in ["member", "", "rewrite"] {
        for wire in ["3", "4"] {
            let h = Harness::new();
            let old = create(&h, "3").await;
            let gate = AdmissionGate(Arc::new(tokio::sync::Barrier::new(2)));
            let mut request = Request::builder()
                .method(match action {
                    "member" => "PUT",
                    "" => "DELETE",
                    _ => "POST",
                })
                .uri(format!("/lib/{LIB}/{action}"))
                .header(TOKEN_HEADER, TOKEN)
                .header(MEMBER_HEADER, format!("{LIB}:new-member"))
                .header(WIRE_HEADER, "3")
                .header(GENERATION_HEADER, &old)
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(gate.clone());
            let mut pending = std::pin::pin!(h.send_request(request));
            tokio::select! {
                biased;
                response = &mut pending => panic!("completed before admission: {}", response.status()),
                _ = gate.0.wait() => {},
            }
            let (rewrite, base) = stage(&h, wire, &old).await;
            let current = generation(&commit(&h, wire, &old, &rewrite, base).await);
            let before = read(&h).await;
            let (response, _) = tokio::join!(pending, gate.0.wait());
            refused(response, wire, &current, wire == "4").await;
            assert_eq!(read(&h).await, before);
            assert!(load_rewrite(&h.state, LIB).await.unwrap().is_none());
            assert!(!retired(&h.state, LIB).await.unwrap());
            let credentials = h.state.library_v3.credentials(LIB).unwrap().unwrap();
            assert!(credentials.1.is_none(), "a stale membership request must not register a credential");
            let response = h
                .send(
                    match action {
                        "member" => "PUT",
                        "" => "DELETE",
                        _ => "POST",
                    },
                    &format!("/lib/{LIB}/{action}"),
                    None,
                    &[
                        (TOKEN_HEADER, TOKEN),
                        (MEMBER_HEADER, &format!("{LIB}:new-member")),
                        (WIRE_HEADER, wire),
                        (GENERATION_HEADER, &current),
                    ],
                )
                .await;
            assert_eq!(response.status(), StatusCode::OK, "the current {action} caller remains supported");
        }
    }
}

#[tokio::test]
async fn delayed_first_write_cannot_join_a_library_created_by_another_request() {
    let h = Harness::new();
    let (request, observed, release, _) = delayed("batch", Some("3"), "0");
    let mut pending = std::pin::pin!(h.send_request(request));
    reached(&mut pending, observed).await;
    let current = create(&h, "3").await;
    let before = read(&h).await;
    release.send(Bytes::from(json!({"writes":[{"k":K2,"base":0,"v":"obsolete"}]}).to_string())).unwrap();
    refused(pending.await, "3", &current, false).await;
    assert_eq!(read(&h).await, before);
}

#[tokio::test]
async fn first_wired_mutations_can_convert_a_legacy_generation_zero_log() {
    for action in ["batch", "member", "rewrite"] {
        let h = Harness::new();
        let token_hash = Sha256::digest(TOKEN.as_bytes()).into();
        let log = header_line(&token_hash, None) + &log_line(1, K1, "legacy");
        h.state.store.replace_file(NS, LIB, EXT, log.as_bytes()).await.unwrap();
        let response = h
            .send(
                if action == "member" { "PUT" } else { "POST" },
                &format!("/lib/{LIB}/{action}"),
                Some(json!({"writes":[{"k":K2,"base":0,"v":"current"}]}).to_string()),
                &[
                    (TOKEN_HEADER, TOKEN),
                    (MEMBER_HEADER, &format!("{LIB}:member")),
                    (WIRE_HEADER, "3"),
                    (GENERATION_HEADER, "0"),
                ],
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK, "the first wired {action} still converts legacy state");
        assert_ne!(generation(&response), "0");
    }
}

#[tokio::test]
async fn batch_transaction_rechecks_authority_even_without_the_http_slot_lock() {
    for wire in [3, 4] {
        let h = Harness::new();
        create(&h, "3").await;
        let store =
            h.state.library_v3.existing_library(LIB, Sha256::digest(TOKEN.as_bytes()).into()).unwrap();
        let old = store.protocol().unwrap();
        let stale = v3::WriteAuthority { wire: Some(3), generation: Some(old.generation) };
        let current = store
            .rewrite(
                old.head,
                &[v3::RewriteRow { key: K2.to_owned(), value: "after".to_owned() }],
                wire,
                32 << 20,
            )
            .unwrap();
        let before = store.snapshot().unwrap();
        let writes = [v3::Write { key: K1.to_owned(), base: 0, value: "obsolete".to_owned() }];
        let result = store.apply_tiered(&writes, 32 << 20, 2, v3::VisitorTier::NONE, &stale);
        assert!(matches!(
            (wire, result),
            (3, Err(v3::StoreError::GenerationChanged)) | (4, Err(v3::StoreError::UpgradeRequired(4)))
        ));
        assert_eq!(store.snapshot().unwrap(), before);
        store.acquire_exclusive_operation_lock("reset", current.migration_generation, current.head).unwrap();
        assert!(
            matches!(
                store.apply_tiered(&writes, 32 << 20, 2, v3::VisitorTier::NONE, &stale),
                Err(v3::StoreError::Locked)
            ),
            "exclusive-operation refusal keeps precedence"
        );
        store.release_exclusive_operation_lock("reset").unwrap();
        let current = v3::WriteAuthority { wire: Some(wire), generation: Some(current.generation) };
        assert_eq!(
            store.apply_tiered(&writes, 32 << 20, 2, v3::VisitorTier::NONE, &current).unwrap().applied.len(),
            1
        );
    }
}
