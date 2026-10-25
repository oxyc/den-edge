//! An authenticated outbound wake-controller long poll. A controller registers only opaque queue identifiers for
//! the library its assistant write session proves; events name its own target ids and never carry sealed content.

use crate::handler::{error, json_reply, read_json};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

pub const BODY_BYTES: usize = 32 * 1024;
pub const MAX_HELD: usize = 8;
pub const MAX_HELD_PER_CONTROLLER: usize = 1;
const MAX_TARGETS: usize = 16;
const MAX_ACKS: usize = 32;
const MAX_STAGES: usize = 32;
const MAX_RETAINED_STAGES: usize = 256;
const STAGE_TTL_MS: u64 = 10 * 60_000;
const LEASE_MS: u64 = 60_000;
const NS: &str = "wake";

#[derive(Default)]
pub struct Controllers {
    inner: std::sync::Mutex<HashMap<(String, String), Controller>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Target {
    id: String,
    name: String,
    inbox: String,
    tv: String,
    capabilities: Vec<String>,
}

struct Controller {
    targets: Vec<Target>,
    lease_until: u64,
    registered_at: u64,
    pending: HashMap<String, Event>,
    stages: HashMap<(String, String), RetainedStage>,
    poll_generation: u64,
}

#[derive(Clone)]
struct Event {
    id: String,
    sources: BTreeSet<&'static str>,
    first_accepted_at: u64,
    last_accepted_at: u64,
}

#[derive(Deserialize)]
struct Poll {
    v: u8,
    targets: Vec<Target>,
    #[serde(default, rename = "acks")]
    ack: Vec<String>,
    #[serde(default)]
    stages: Vec<Stage>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Stage {
    event: String,
    target: String,
    stage: String,
    status: String,
    at: u64,
    #[serde(default)]
    elapsed_ms: Option<u64>,
    #[serde(default)]
    reason: Option<String>,
}

struct RetainedStage {
    report: Stage,
    received_at: u64,
}

#[derive(Deserialize)]
struct Enrollment {
    name: String,
}

#[derive(Serialize, Deserialize)]
struct StoredController {
    controller: String,
    library: String,
    name: String,
    verifier: String,
    #[serde(default)]
    targets: Vec<Target>,
    #[serde(default)]
    watermarks: HashMap<String, u64>,
}

pub fn is_path(path: &str) -> bool {
    path == "/wake/controllers"
        || path.starts_with("/wake/controllers/")
        || path == "/wake/poll"
        || path == "/wake/targets"
}

fn lower_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_name(name: &str) -> bool {
    crate::oauth::clean_name(name, 40).as_deref() == Some(name)
}

fn valid_poll(poll: &Poll) -> bool {
    if poll.v != 1
        || poll.targets.len() > MAX_TARGETS
        || poll.ack.len() > MAX_ACKS
        || poll.stages.len() > MAX_STAGES
        || !poll.ack.iter().all(|id| lower_hex(id, 32))
        || !poll.stages.iter().all(valid_stage)
        || !poll.targets.iter().all(|t| {
            lower_hex(&t.id, 32)
                && valid_name(&t.name)
                && lower_hex(&t.inbox, 64)
                && lower_hex(&t.tv, 32)
                && t.capabilities.len() <= 8
                && t.capabilities.iter().all(|capability| {
                    !capability.is_empty()
                        && capability.len() <= 32
                        && capability.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
                })
                && t.capabilities.iter().collect::<BTreeSet<_>>().len() == t.capabilities.len()
        })
    {
        return false;
    }
    let unique = |values: Vec<&str>| values.len() == values.iter().copied().collect::<BTreeSet<_>>().len();
    let target_pairs: Vec<(&str, &str)> =
        poll.targets.iter().map(|target| (target.inbox.as_str(), target.tv.as_str())).collect();
    let stage_pairs: Vec<(&str, &str)> =
        poll.stages.iter().map(|stage| (stage.event.as_str(), stage.stage.as_str())).collect();
    unique(poll.targets.iter().map(|t| t.id.as_str()).collect())
        && target_pairs.len() == target_pairs.iter().copied().collect::<BTreeSet<_>>().len()
        && unique(poll.ack.iter().map(String::as_str).collect())
        && stage_pairs.len() == stage_pairs.iter().copied().collect::<BTreeSet<_>>().len()
}

fn valid_stage(stage: &Stage) -> bool {
    const STAGES: [&str; 7] = [
        "trigger-received",
        "wake-requested",
        "receiver-awake",
        "companion-connected",
        "app-known",
        "launch-requested",
        "receiver-ready",
    ];
    const STATUSES: [&str; 3] = ["started", "ok", "error"];
    const REASONS: [&str; 9] = [
        "stale-event",
        "offline",
        "pairing-revoked",
        "address-changed",
        "app-missing",
        "connect-timeout",
        "launch-timeout",
        "protocol-error",
        "internal",
    ];
    lower_hex(&stage.event, 32)
        && lower_hex(&stage.target, 32)
        && STAGES.contains(&stage.stage.as_str())
        && STATUSES.contains(&stage.status.as_str())
        && stage.elapsed_ms.is_none_or(|elapsed| elapsed <= 300_000)
        && stage
            .reason
            .as_ref()
            .is_none_or(|reason| stage.status == "error" && REASONS.contains(&reason.as_str()))
}

fn poll_wait(value: Option<String>) -> Result<Option<Duration>, Box<Response>> {
    match value.as_deref() {
        None | Some("0") => Ok(None),
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|seconds| (1..=crate::hold::MAX_WAIT_SECS).contains(seconds))
            .map(|seconds| Some(Duration::from_secs(seconds)))
            .ok_or_else(|| Box::new(json_reply(StatusCode::BAD_REQUEST, &error("invalid_poll")))),
    }
}

fn event(source: &'static str, at: u64) -> Event {
    Event {
        id: crate::hex(&crate::random_bytes::<16>()),
        sources: BTreeSet::from([source]),
        first_accepted_at: at,
        last_accepted_at: at,
    }
}

fn add_event(controller: &mut Controller, target: &str, source: &'static str, at: u64) {
    match controller.pending.get_mut(target) {
        Some(current) => {
            current.id = crate::hex(&crate::random_bytes::<16>());
            current.sources.insert(source);
            current.first_accepted_at = current.first_accepted_at.min(at);
            current.last_accepted_at = current.last_accepted_at.max(at);
        }
        None => {
            controller.pending.insert(target.to_owned(), event(source, at));
        }
    }
}

impl Controllers {
    pub fn notify_inbox(&self, state: &AppState, wake: &str, at: u64) {
        let mut controllers = crate::lock(&self.inner);
        for ((library, id), controller) in controllers.iter_mut().filter(|(_, c)| c.lease_until > at) {
            let targets: Vec<String> = controller
                .targets
                .iter()
                .filter(|target| {
                    target.inbox == wake && !crate::assistant::tv_online(state, library, &target.tv)
                })
                .map(|target| target.id.clone())
                .collect();
            for target in targets {
                add_event(controller, &target, "inbox", at);
                state.controller_holds.wake(&format!("{library}:{id}"));
            }
        }
    }

    pub fn notify_assistant(&self, holds: &crate::hold::Holds, library: &str, lane: &str, at: u64) {
        let mut controllers = crate::lock(&self.inner);
        for ((registered_library, id), controller) in controllers
            .iter_mut()
            .filter(|((registered_library, _), c)| registered_library == library && c.lease_until > at)
        {
            let targets: Vec<String> = controller
                .targets
                .iter()
                .filter(|target| target.tv == lane)
                .map(|target| target.id.clone())
                .collect();
            for target in targets {
                add_event(controller, &target, "assistant", at);
                holds.wake(&format!("{registered_library}:{id}"));
            }
        }
    }

    pub fn wakeable(&self, library: &str, now: u64) -> Vec<(String, String, u64)> {
        let controllers = crate::lock(&self.inner);
        let mut lanes = HashMap::<String, (String, u64)>::new();
        for ((_, _), controller) in controllers
            .iter()
            .filter(|((registered, _), controller)| registered == library && controller.lease_until > now)
        {
            for target in &controller.targets {
                if target.capabilities.iter().any(|capability| capability == "companion-wake")
                    && target.capabilities.iter().any(|capability| capability == "app-launch")
                {
                    lanes.entry(target.tv.clone()).or_insert((target.name.clone(), controller.registered_at));
                }
            }
        }
        lanes.into_iter().map(|(lane, (name, at))| (lane, name, at)).collect()
    }

    pub fn registered(&self, library: &str) -> Vec<(String, String, u64)> {
        let controllers = crate::lock(&self.inner);
        let mut lanes = HashMap::<String, (String, u64)>::new();
        for ((_, _), controller) in controllers.iter().filter(|((registered, _), _)| registered == library) {
            for target in &controller.targets {
                lanes.entry(target.tv.clone()).or_insert((target.name.clone(), controller.registered_at));
            }
        }
        lanes.into_iter().map(|(lane, (name, at))| (lane, name, at)).collect()
    }

    pub fn lane_registered(&self, library: &str, lane: &str, now: u64) -> bool {
        let _ = now;
        crate::lock(&self.inner).iter().any(|((registered, _), controller)| {
            registered == library && controller.targets.iter().any(|target| target.tv == lane)
        })
    }

    pub fn remove_library(&self, library: &str) {
        crate::lock(&self.inner).retain(|(registered, _), _| registered != library);
    }
}

pub fn inbox_wake_id(inbox: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"den/wake/inbox/v1:");
    digest.update(inbox.as_bytes());
    crate::hex(&digest.finalize())
}

fn stored_key(controller: &str) -> String {
    format!("controller:{controller}")
}

async fn enrolling_library(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<String, Box<Response>> {
    let member = headers.get(crate::library::MEMBER_HEADER).and_then(|value| value.to_str().ok());
    if crate::library::is_household_member(state, member).await {
        return Ok(member.and_then(|claim| claim.split_once(':')).unwrap().0.to_owned());
    }
    crate::oauth::write_session(state, headers).await.map(|session| session.library)
}

async fn authenticate(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<StoredController, Response> {
    let invalid = || json_reply(StatusCode::UNAUTHORIZED, &error("invalid_controller"));
    let credential =
        headers.get("x-den-wake-controller").and_then(|value| value.to_str().ok()).ok_or_else(invalid)?;
    let (controller, secret) = credential.split_once('.').ok_or_else(invalid)?;
    if !lower_hex(controller, 32) {
        return Err(invalid());
    }
    let secret =
        den_assistant::b64url_decode(secret).filter(|secret| secret.len() == 32).ok_or_else(invalid)?;
    let bytes = state
        .store
        .get(NS, &stored_key(controller))
        .await
        .map_err(|e| crate::handler::internal("wake controller read", e))?;
    let stored: StoredController = bytes
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(|stored: &StoredController| stored.controller == controller)
        .ok_or_else(invalid)?;
    let verifier: [u8; 32] = Sha256::digest(&secret).into();
    let expected = crate::hex(&verifier);
    if !crate::handler::constant_time_eq(stored.verifier.as_bytes(), expected.as_bytes()) {
        return Err(invalid());
    }
    Ok(stored)
}

async fn library_controllers(state: &AppState, library: &str) -> std::io::Result<Vec<StoredController>> {
    let ids: Vec<String> = match state.store.get(NS, &format!("library:{library}")).await? {
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        None => Vec::new(),
    };
    let mut controllers = Vec::new();
    for id in ids {
        if let Some(bytes) = state.store.get(NS, &stored_key(&id)).await? {
            if let Ok(controller) = serde_json::from_slice(&bytes) {
                controllers.push(controller);
            }
        }
    }
    Ok(controllers)
}

pub(crate) async fn persisted_registered(
    state: &AppState,
    library: &str,
) -> std::io::Result<Vec<(String, String)>> {
    Ok(library_controllers(state, library)
        .await?
        .into_iter()
        .flat_map(|controller| controller.targets.into_iter().map(|target| (target.tv, target.name)))
        .collect())
}

pub(crate) async fn persisted_lane(state: &AppState, library: &str, lane: &str) -> std::io::Result<bool> {
    Ok(persisted_registered(state, library).await?.iter().any(|(tv, _)| tv == lane))
}

pub(crate) async fn delete_library(state: &AppState, library: &str) -> std::io::Result<()> {
    let _lock = state.controller_lock.lock().await;
    for controller in library_controllers(state, library).await? {
        state.store.delete(NS, &stored_key(&controller.controller)).await?;
    }
    state.store.delete(NS, &format!("library:{library}")).await?;
    state.controllers.remove_library(library);
    Ok(())
}

async fn enroll(state: &AppState, req: Request) -> Response {
    let library = match enrolling_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    if let Some(wait) =
        crate::link::throttled_per_window(state, &format!("wake-enroll:{library}"), 5, 1, 3_600_000)
    {
        return crate::handler::retry_after(StatusCode::TOO_MANY_REQUESTS, &error("rate_limited"), wait);
    }
    let body = match read_json(req, BODY_BYTES).await {
        Ok(body) => body,
        Err(refused) => return *refused,
    };
    let Ok(enrollment) = serde_json::from_value::<Enrollment>(body) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_controller"));
    };
    if !valid_name(&enrollment.name) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_controller"));
    }
    let _lock = state.controller_lock.lock().await;
    let index_key = format!("library:{library}");
    let mut ids: Vec<String> = state
        .store
        .get(NS, &index_key)
        .await
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if ids.len() >= 4 {
        return json_reply(StatusCode::CONFLICT, &error("controllers_full"));
    }
    let controller = crate::hex(&crate::random_bytes::<16>());
    let secret = crate::random_bytes::<32>();
    let verifier = crate::hex(&Sha256::digest(secret));
    let stored = StoredController {
        controller: controller.clone(),
        library,
        name: enrollment.name,
        verifier,
        targets: Vec::new(),
        watermarks: HashMap::new(),
    };
    let bytes = serde_json::to_vec(&stored).expect("controller serializes");
    if let Err(e) = state.store.put(NS, &stored_key(&controller), &bytes).await {
        return crate::handler::internal("wake controller write", e);
    }
    ids.push(controller.clone());
    if let Err(e) = state.store.put(NS, &index_key, &serde_json::to_vec(&ids).unwrap()).await {
        let _ = state.store.delete(NS, &stored_key(&controller)).await;
        return crate::handler::internal("wake controller index write", e);
    }
    let credential = format!("{controller}.{}", den_assistant::b64url(&secret));
    json_reply(StatusCode::CREATED, &json!({ "controller": controller, "credential": credential }))
}

async fn delete_controller(state: &AppState, req: Request, controller: &str) -> Response {
    let library = match enrolling_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    if !lower_hex(controller, 32) {
        return json_reply(StatusCode::NO_CONTENT, &Value::Null);
    }
    let _lock = state.controller_lock.lock().await;
    let index_key = format!("library:{library}");
    let mut ids: Vec<String> = state
        .store
        .get(NS, &index_key)
        .await
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if ids.iter().any(|id| id == controller) {
        ids.retain(|id| id != controller);
        if let Err(e) = state.store.put(NS, &index_key, &serde_json::to_vec(&ids).unwrap()).await {
            return crate::handler::internal("wake controller index write", e);
        }
        if let Err(e) = state.store.delete(NS, &stored_key(controller)).await {
            return crate::handler::internal("wake controller delete", e);
        }
        crate::lock(&state.controllers.inner).remove(&(library, controller.to_owned()));
    }
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    response
}

async fn targets(state: &AppState, req: Request) -> Response {
    let library = match enrolling_library(state, req.headers()).await {
        Ok(library) => library,
        Err(refused) => return *refused,
    };
    let stored = match library_controllers(state, &library).await {
        Ok(stored) => stored,
        Err(e) => return crate::handler::internal("wake targets read", e),
    };
    let now = state.now();
    let wakeable = state.controllers.wakeable(&library, now);
    let mut listed = Vec::new();
    for controller in stored {
        for target in controller.targets {
            listed.push(json!({
                "id": target.id,
                "name": target.name,
                "tv": target.tv,
                "registered": true,
                "wakeable": wakeable.iter().any(|(lane, ..)| lane == &target.tv),
                "online": crate::assistant::tv_online(state, &library, &target.tv),
                "lastSeenAt": crate::assistant::tv_last_seen(state, &library, &target.tv),
            }));
        }
    }
    json_reply(StatusCode::OK, &json!({ "targets": listed }))
}

pub async fn handle(state: &AppState, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    if path == "/wake/controllers" && req.method() == Method::POST {
        return enroll(state, req).await;
    }
    if path == "/wake/targets" && req.method() == Method::GET {
        return targets(state, req).await;
    }
    if let Some(controller) = path.strip_prefix("/wake/controllers/") {
        if req.method() == Method::DELETE {
            return delete_controller(state, req, controller).await;
        }
    }
    if path != "/wake/poll" || req.method() != Method::POST {
        return crate::handler::method_not_allowed();
    }
    let mut stored = match authenticate(state, req.headers()).await {
        Ok(stored) => stored,
        Err(refused) => return refused,
    };
    let wait = match poll_wait(crate::handler::query_param(&req, "wait")) {
        Ok(wait) => wait,
        Err(refused) => return *refused,
    };
    let admission = req.extensions().get::<crate::handler::AdmissionSlot>().cloned();
    let body = match read_json(req, BODY_BYTES).await {
        Ok(body) => body,
        Err(refused) => return *refused,
    };
    if body.get("v").is_some_and(|version| version.as_u64() != Some(1)) {
        return json_reply(StatusCode::BAD_REQUEST, &error("unsupported_version"));
    }
    let Ok(poll) = serde_json::from_value::<Poll>(body) else {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_poll"));
    };
    if !valid_poll(&poll) {
        return json_reply(StatusCode::BAD_REQUEST, &error("invalid_poll"));
    }
    // Polls replace one persisted controller snapshot. Serialize that same-key write (and the library-wide
    // collision check before it) so concurrent reconnects cannot race Store's atomic temporary path.
    let controller_guard = state.controller_lock.lock().await;
    match library_controllers(state, &stored.library).await {
        Ok(controllers) => {
            let conflict = controllers
                .into_iter()
                .filter(|other| other.controller != stored.controller)
                .flat_map(|other| other.targets)
                .any(|other| {
                    poll.targets.iter().any(|target| {
                        target.id == other.id || (target.inbox == other.inbox && target.tv == other.tv)
                    })
                });
            if conflict {
                return json_reply(StatusCode::CONFLICT, &error("target_conflict"));
            }
        }
        Err(e) => return crate::handler::internal("wake controllers read", e),
    }
    let now = state.now();
    let key = (stored.library.clone(), stored.controller.clone());
    let (first_registration, poll_generation) = {
        let mut controllers = crate::lock(&state.controllers.inner);
        let changed = controllers
            .get(&key)
            .is_none_or(|current| current.targets != poll.targets || current.lease_until <= now);
        let current = controllers.entry(key.clone()).or_insert_with(|| Controller {
            targets: poll.targets.clone(),
            lease_until: now + LEASE_MS,
            registered_at: now,
            pending: HashMap::new(),
            stages: HashMap::new(),
            poll_generation: 0,
        });
        if changed {
            current.targets = poll.targets.clone();
            current.registered_at = now;
            current.pending.retain(|target, _| poll.targets.iter().any(|t| &t.id == target));
        }
        current.lease_until = now + LEASE_MS;
        current.poll_generation = current.poll_generation.wrapping_add(1);
        current.stages.retain(|_, stage| stage.received_at.saturating_add(STAGE_TTL_MS) > now);
        for stage in &poll.stages {
            let belongs_to_pending =
                current.pending.get(&stage.target).is_some_and(|pending| pending.id == stage.event);
            if belongs_to_pending {
                let stage_key = (stage.event.clone(), stage.stage.clone());
                if current.stages.get(&stage_key).is_none_or(|retained| retained.report.at <= stage.at) {
                    current
                        .stages
                        .insert(stage_key, RetainedStage { report: stage.clone(), received_at: now });
                }
            }
        }
        while current.stages.len() > MAX_RETAINED_STAGES {
            let Some(oldest) =
                current.stages.iter().min_by_key(|(_, stage)| stage.received_at).map(|(key, _)| key.clone())
            else {
                break;
            };
            current.stages.remove(&oldest);
        }
        for ack in &poll.ack {
            current.pending.retain(|target, event| {
                if &event.id == ack {
                    stored
                        .watermarks
                        .entry(target.clone())
                        .and_modify(|at| *at = (*at).max(event.last_accepted_at))
                        .or_insert(event.last_accepted_at);
                    false
                } else {
                    true
                }
            });
        }
        (changed, current.poll_generation)
    };
    if first_registration {
        for target in &poll.targets {
            if !crate::assistant::tv_online(state, &stored.library, &target.tv) {
                if let Ok(Some((first, last))) = crate::inbox::wake_trigger(state, &target.inbox).await {
                    if last > stored.watermarks.get(&target.id).copied().unwrap_or(0) {
                        let mut controllers = crate::lock(&state.controllers.inner);
                        if let Some(controller) = controllers.get_mut(&key) {
                            add_event(controller, &target.id, "inbox", first);
                            if last != first {
                                add_event(controller, &target.id, "inbox", last);
                            }
                        }
                    }
                }
            }
            let assistant_at =
                crate::assistant::lane_trigger(state, &stored.library, &target.tv).await.ok().flatten();
            if !crate::assistant::tv_online(state, &stored.library, &target.tv)
                && assistant_at.is_some_and(|at| at > stored.watermarks.get(&target.id).copied().unwrap_or(0))
            {
                let mut controllers = crate::lock(&state.controllers.inner);
                if let Some(controller) = controllers.get_mut(&key) {
                    add_event(controller, &target.id, "assistant", assistant_at.unwrap_or(now));
                }
            }
        }
    }
    stored.targets = poll.targets.clone();
    let bytes = serde_json::to_vec(&stored).expect("controller serializes");
    if let Err(e) = state.store.put(NS, &stored_key(&stored.controller), &bytes).await {
        return crate::handler::internal("wake controller snapshot write", e);
    }
    drop(controller_guard);
    let hold_key = format!("{}:{}", stored.library, stored.controller);
    let owner = hold_key.clone();
    state.controller_holds.cancel_owner(&owner);
    let mut hold =
        wait.and_then(|duration| Some((state.controller_holds.hold(&owner, &[&hold_key])?, duration)));
    let was_held = hold.is_some();
    loop {
        let response = {
            let controllers = crate::lock(&state.controllers.inner);
            controllers.get(&key).map(|controller| {
                let superseded = controller.poll_generation != poll_generation;
                let mut events: Vec<(&String, &Event)> = controller
                    .pending
                    .iter()
                    .collect();
                events.sort_by_key(|(_, event)| event.first_accepted_at);
                let events: Vec<Value> = if superseded {
                    Vec::new()
                } else {
                    events
                    .into_iter()
                    .map(|(target, event)| {
                        json!({ "event": event.id, "target": target, "sources": event.sources,
                            "firstAcceptedAt": event.first_accepted_at, "lastAcceptedAt": event.last_accepted_at })
                    })
                    .collect()
                };
                let accepted: Vec<&str> = controller.targets.iter().map(|target| target.id.as_str()).collect();
                (json!({ "v": 1, "serverTime": state.now(), "acceptedTargets": accepted, "events": events }), superseded)
            })
        };
        let Some((response, superseded)) = response else {
            return json_reply(StatusCode::CONFLICT, &error("controller_expired"));
        };
        if superseded || response["events"].as_array().is_some_and(|events| !events.is_empty()) {
            return json_reply(StatusCode::OK, &response);
        }
        if hold.is_none() {
            if !was_held {
                if let Some(wait) =
                    crate::link::throttled_per_minute(state, &format!("wake-poll:{}", stored.controller), 6)
                {
                    return crate::handler::retry_after(
                        StatusCode::TOO_MANY_REQUESTS,
                        &error("rate_limited"),
                        wait,
                    );
                }
            }
            return json_reply(StatusCode::OK, &response);
        }
        let (held, duration) = hold.take().expect("checked above");
        if !crate::handler::AdmissionSlot::wait_out(admission.as_ref(), state, held.wait(duration)).await {
            return crate::handler::busy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, Harness};
    use crate::oauth::tests::{connect_write, seed, write_harness, LIB, TOKEN};
    use axum::http::header;

    const TARGET: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const LANE: &str = "cccccccccccccccccccccccccccccccc";
    const INBOX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    fn body(wake: &str, ack: Vec<String>) -> Value {
        json!({
            "v": 1,
            "targets": [{ "id": TARGET, "name": "Living room", "inbox": wake, "tv": LANE,
                "capabilities": ["companion-wake", "app-launch"] }],
            "acks": ack,
        })
    }

    async fn enroll_controller(h: &Harness, access: &str) -> String {
        let bearer = format!("Bearer {access}");
        let response = h
            .send(
                "POST",
                "/wake/controllers",
                Some(json!({ "name": "Hearth" }).to_string()),
                &[
                    (header::AUTHORIZATION.as_str(), &bearer),
                    (header::CONTENT_TYPE.as_str(), "application/json"),
                ],
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        body_json(response).await["credential"].as_str().unwrap().to_owned()
    }

    async fn poll(h: &Harness, credential: &str, body: Value) -> (StatusCode, Value) {
        poll_at(h, credential, "/wake/poll", body).await
    }

    async fn poll_at(h: &Harness, credential: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let response = h
            .send(
                "POST",
                path,
                Some(body.to_string()),
                &[("x-den-wake-controller", credential), (header::CONTENT_TYPE.as_str(), "application/json")],
            )
            .await;
        let status = response.status();
        (status, body_json(response).await)
    }

    #[test]
    fn an_inbox_credential_has_a_one_way_public_wake_id() {
        assert_eq!(inbox_wake_id(INBOX), "04d970191021f3f41c1b167c40a3673f0dfce37da758a7d291d2582f5ab06310");
    }

    #[tokio::test]
    async fn registration_requires_a_write_session_and_is_strictly_bounded() {
        let h = write_harness().await;
        let wake = inbox_wake_id(INBOX);
        assert_eq!(h.call("POST", "/wake/poll", Some(body(&wake, vec![]))).await.0, StatusCode::UNAUTHORIZED);
        let tokens = connect_write(&h, &seed("grant")).await;
        let access = tokens["access_token"].as_str().unwrap();
        let credential = enroll_controller(&h, access).await;
        assert_eq!(poll(&h, &credential, body(&wake, vec![])).await.0, StatusCode::OK);
        let mut bad = body(&wake, vec![]);
        bad["targets"][0]["inbox"] = json!(INBOX);
        assert_eq!(
            poll(&h, &credential, bad).await.0,
            StatusCode::BAD_REQUEST,
            "a drain credential is not accepted"
        );
    }

    #[tokio::test]
    async fn an_accepted_inbox_write_is_caught_up_delivered_and_acked_without_its_body() {
        let h = write_harness().await;
        let wake = inbox_wake_id(INBOX);
        let appended = h
            .send(
                "POST",
                "/inbox/append",
                Some(json!({ "sealed": "opaque" }).to_string()),
                &[("x-den-link", INBOX), (header::CONTENT_TYPE.as_str(), "application/json")],
            )
            .await;
        assert_eq!(appended.status(), StatusCode::OK);
        let tokens = connect_write(&h, &seed("grant")).await;
        let access = tokens["access_token"].as_str().unwrap();
        let credential = enroll_controller(&h, access).await;
        let (status, received) = poll(&h, &credential, body(&wake, vec![])).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(received["events"][0]["target"], TARGET);
        assert_eq!(received["events"][0]["sources"], json!(["inbox"]));
        assert!(received.to_string().find(INBOX).is_none() && received.to_string().find("opaque").is_none());
        let id = received["events"][0]["event"].as_str().unwrap().to_owned();
        let (_, acked) = poll(&h, &credential, body(&wake, vec![id])).await;
        assert_eq!(acked["events"], json!([]));
        let dir = h.dir.clone();
        drop(h);
        let restarted = Harness::in_dir(dir);
        let (_, after_restart) = poll(&restarted, &credential, body(&wake, vec![])).await;
        assert_eq!(after_restart["events"], json!([]), "the persisted watermark prevents a replay");
    }

    #[tokio::test]
    async fn registration_is_wakeable_without_claiming_den_is_online() {
        let h = write_harness().await;
        let wake = inbox_wake_id(INBOX);
        let tokens = connect_write(&h, &seed("grant")).await;
        let access = tokens["access_token"].as_str().unwrap();
        let credential = enroll_controller(&h, access).await;
        poll(&h, &credential, body(&wake, vec![])).await;
        let bearer = format!("Bearer {access}");
        let response =
            h.send("GET", "/assistant/tv", None, &[(header::AUTHORIZATION.as_str(), &bearer)]).await;
        let listed = body_json(response).await;
        assert_eq!(listed["online"], false);
        assert_eq!(
            (listed["tvs"][0]["online"].clone(), listed["tvs"][0]["wakeable"].clone()),
            (json!(false), json!(true))
        );
    }

    #[tokio::test]
    async fn an_expired_lease_catches_up_the_same_snapshot_and_coalescing_keeps_both_times() {
        let h = write_harness().await;
        let wake = inbox_wake_id(INBOX);
        let tokens = connect_write(&h, &seed("grant")).await;
        let credential = enroll_controller(&h, tokens["access_token"].as_str().unwrap()).await;
        poll(&h, &credential, body(&wake, vec![])).await;
        h.advance(LEASE_MS);
        for (n, sealed) in ["first", "second"].into_iter().enumerate() {
            let response = h
                .send(
                    "POST",
                    "/inbox/append",
                    Some(json!({ "sealed": sealed }).to_string()),
                    &[("x-den-link", INBOX), (header::CONTENT_TYPE.as_str(), "application/json")],
                )
                .await;
            assert_eq!(response.status(), StatusCode::OK);
            if n == 0 {
                h.advance(1000);
            }
        }
        let (_, received) = poll(&h, &credential, body(&wake, vec![])).await;
        assert_eq!(received["events"].as_array().unwrap().len(), 1);
        assert!(
            received["events"][0]["firstAcceptedAt"].as_u64().unwrap()
                < received["events"][0]["lastAcceptedAt"].as_u64().unwrap()
        );
    }

    #[tokio::test]
    async fn an_online_lane_suppresses_inbox_catch_up() {
        let h = write_harness().await;
        let member = format!("{LIB}:{TOKEN}");
        let drained = h
            .send(
                "POST",
                &format!("/assistant/drain?queue=tv&tv={LANE}"),
                Some(json!({ "name": "Living room" }).to_string()),
                &[
                    (crate::library::MEMBER_HEADER, &member),
                    (header::CONTENT_TYPE.as_str(), "application/json"),
                ],
            )
            .await;
        assert_eq!(drained.status(), StatusCode::OK);
        let appended = h
            .send(
                "POST",
                "/inbox/append",
                Some(json!({ "sealed": "opaque" }).to_string()),
                &[("x-den-link", INBOX), (header::CONTENT_TYPE.as_str(), "application/json")],
            )
            .await;
        assert_eq!(appended.status(), StatusCode::OK);
        let tokens = connect_write(&h, &seed("grant")).await;
        let credential = enroll_controller(&h, tokens["access_token"].as_str().unwrap()).await;
        let (_, received) = poll(&h, &credential, body(&inbox_wake_id(INBOX), vec![])).await;
        assert_eq!(received["events"], json!([]));
    }

    #[tokio::test]
    async fn lifecycle_reports_are_strict_atomic_bounded_and_retained_briefly() {
        let h = write_harness().await;
        let wake = inbox_wake_id(INBOX);
        let tokens = connect_write(&h, &seed("grant")).await;
        let credential = enroll_controller(&h, tokens["access_token"].as_str().unwrap()).await;
        assert_eq!(poll(&h, &credential, body(&wake, vec![])).await.0, StatusCode::OK);
        let appended = h
            .send(
                "POST",
                "/inbox/append",
                Some(json!({ "sealed": "opaque" }).to_string()),
                &[("x-den-link", INBOX), (header::CONTENT_TYPE.as_str(), "application/json")],
            )
            .await;
        assert_eq!(appended.status(), StatusCode::OK);
        let (_, received) = poll(&h, &credential, body(&wake, vec![])).await;
        let event = received["events"][0]["event"].as_str().unwrap();

        let mut with_stage = body(&wake, vec![]);
        with_stage["stages"] = json!([{
            "event": event,
            "target": TARGET,
            "stage": "launch-requested",
            "status": "ok",
            "at": 1_000_010,
            "elapsedMs": 842,
            "ignoredFutureMember": true,
        }]);
        assert_eq!(poll(&h, &credential, with_stage.clone()).await.0, StatusCode::OK);
        let controller = credential.split_once('.').unwrap().0.to_owned();
        {
            let controllers = crate::lock(&h.state.controllers.inner);
            let retained = &controllers[&(LIB.to_owned(), controller.clone())].stages;
            assert_eq!(retained.len(), 1);
            assert_eq!(retained.values().next().unwrap().report.elapsed_ms, Some(842));
        }

        let mut invalid = with_stage.clone();
        invalid["stages"][0]["elapsedMs"] = json!(300_001);
        assert_eq!(poll(&h, &credential, invalid).await.0, StatusCode::BAD_REQUEST);
        let mut duplicate = with_stage;
        let repeated = duplicate["stages"][0].clone();
        duplicate["stages"].as_array_mut().unwrap().push(repeated);
        assert_eq!(poll(&h, &credential, duplicate).await.0, StatusCode::BAD_REQUEST);
        let mut too_many = body(&wake, vec![]);
        too_many["stages"] = Value::Array(vec![
            json!({
                "event": event, "target": TARGET, "stage": "receiver-ready", "status": "ok", "at": 1
            });
            MAX_STAGES + 1
        ]);
        assert_eq!(poll(&h, &credential, too_many).await.0, StatusCode::BAD_REQUEST);

        h.advance(STAGE_TTL_MS);
        assert_eq!(poll(&h, &credential, body(&wake, vec![])).await.0, StatusCode::OK);
        assert!(crate::lock(&h.state.controllers.inner)[&(LIB.to_owned(), controller)].stages.is_empty());
    }

    #[tokio::test]
    async fn polling_version_wait_and_non_held_rate_are_strict() {
        let h = write_harness().await;
        let wake = inbox_wake_id(INBOX);
        let tokens = connect_write(&h, &seed("grant")).await;
        let credential = enroll_controller(&h, tokens["access_token"].as_str().unwrap()).await;
        let mut version = body(&wake, vec![]);
        version["v"] = json!(2);
        let (status, error_body) = poll(&h, &credential, version).await;
        assert_eq!((status, &error_body["error"]), (StatusCode::BAD_REQUEST, &json!("unsupported_version")));
        assert_eq!(
            poll_at(&h, &credential, "/wake/poll?wait=26", body(&wake, vec![])).await.0,
            StatusCode::BAD_REQUEST
        );

        for request in 1..=7 {
            let (status, response) = poll(&h, &credential, body(&wake, vec![])).await;
            if request <= 6 {
                assert_eq!(status, StatusCode::OK, "poll {request}");
            } else {
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(response["error"], "rate_limited");
            }
        }
    }

    #[tokio::test]
    async fn a_new_poll_cancels_and_replaces_the_old_held_poll() {
        let h = std::sync::Arc::new(write_harness().await);
        let wake = inbox_wake_id(INBOX);
        let tokens = connect_write(&h, &seed("grant")).await;
        let credential = enroll_controller(&h, tokens["access_token"].as_str().unwrap()).await;
        let old_h = std::sync::Arc::clone(&h);
        let old_credential = credential.clone();
        let old_wake = wake.clone();
        let old = tokio::spawn(async move {
            poll_at(&old_h, &old_credential, "/wake/poll?wait=25", body(&old_wake, vec![])).await
        });
        let owner = format!("{LIB}:{}", credential.split_once('.').unwrap().0);
        tokio::time::timeout(Duration::from_secs(1), async {
            while h.state.controller_holds.held_by(&owner) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the old poll acquires its held slot");

        assert_eq!(poll(&h, &credential, body(&wake, vec![])).await.0, StatusCode::OK);
        let (status, response) = tokio::time::timeout(Duration::from_secs(1), old)
            .await
            .expect("the superseded poll returns promptly")
            .expect("poll task succeeds");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response["events"], json!([]));
    }

    #[tokio::test]
    async fn concurrent_poll_starts_do_not_race_the_persisted_snapshot() {
        let h = std::sync::Arc::new(write_harness().await);
        let wake = inbox_wake_id(INBOX);
        let tokens = connect_write(&h, &seed("grant")).await;
        let credential = enroll_controller(&h, tokens["access_token"].as_str().unwrap()).await;
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));
        let mut polls = Vec::new();
        for _ in 0..2 {
            let h = std::sync::Arc::clone(&h);
            let barrier = std::sync::Arc::clone(&barrier);
            let credential = credential.clone();
            let wake = wake.clone();
            polls.push(tokio::spawn(async move {
                barrier.wait().await;
                poll(&h, &credential, body(&wake, vec![])).await
            }));
        }
        barrier.wait().await;
        for response in polls {
            assert_eq!(response.await.expect("poll task succeeds").0, StatusCode::OK);
        }
    }
}
