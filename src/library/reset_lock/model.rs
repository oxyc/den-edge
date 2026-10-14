//! The decision half of den-spec `wire/profiles-v1.md` §9.1, as a pure function over a small world.
//!
//! This is the same model `tools/validate_profiles.py` (`reset_lock_step`) runs the `resetLockContract` vectors
//! through. The handlers in the parent module build a `World` from what is durably stored, ask `step` what the
//! request means and then perform exactly that effect, so the vectors pin the code that decides in production.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    pub generation: u64,
    pub head: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Phase {
    Open,
    Committed,
    Retiring,
    Retired,
    Aborted,
}

impl Phase {
    /// A household in one of these phases holds its set; everything else has ended.
    pub(crate) fn live(self) -> bool {
        matches!(self, Self::Open | Self::Committed | Self::Retiring)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Role {
    Household,
    Profile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LibRole {
    Household,
    Profile,
    Successor,
}

impl LibRole {
    fn is(self, role: Role) -> bool {
        matches!((self, role), (Self::Household, Role::Household) | (Self::Profile, Role::Profile))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Member {
    pub library_id: String,
    pub successor: String,
}

/// The purpose a key-reset lock carries; anything else on a library is a §8.1 migration lock.
pub(crate) const PURPOSE: &str = "key-reset";
pub(crate) const RECOVERY_PURPOSE: &str = "key-reset-recovery";

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Lock {
    pub attempt: String,
    #[serde(default)]
    pub owner: String,
    pub purpose: String,
    pub role: Role,
    pub phase: Phase,
    pub source: Source,
    #[serde(default)]
    pub successor: String,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub household: Option<String>,
    #[serde(default)]
    pub swept: bool,
    #[serde(default = "yes")]
    pub proven: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Lib {
    pub role: LibRole,
    #[serde(default)]
    pub wire_min: u64,
    pub source: Source,
    #[serde(default)]
    pub rows: u64,
    #[serde(default)]
    pub retired: bool,
    #[serde(default)]
    pub lock: Option<Lock>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct World {
    pub libraries: BTreeMap<String, Lib>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Acquire,
    Takeover,
    Commit,
    Abort,
    Write,
    Sweep,
    Retire,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Req {
    pub kind: Kind,
    pub library: String,
    #[serde(default)]
    pub attempt: Option<String>,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub role: Option<Role>,
    #[serde(default)]
    pub expected_source: Option<Source>,
    #[serde(default)]
    pub successor: Option<String>,
    #[serde(default)]
    pub members: Option<Vec<Member>>,
    #[serde(default)]
    pub household: Option<String>,
    #[serde(default)]
    pub successor_credential: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Lookup,
    Refused { status: u16, error: &'static str },
    Open,
    Takeover { phase: Phase },
    Rollback,
    Committed,
    Aborted,
    Allowed,
    Sweep { delete: Vec<String> },
    Nothing,
    OrdinaryDelete,
    Retired { door: bool },
}

/// A request the model refuses to interpret at all (the vectors' `error`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Invalid {
    BadRequest,
    Malformed,
    AttemptMismatch,
    RoleMismatch,
    UnknownLibrary,
}

#[cfg(test)]
impl Invalid {
    /// The vectors' name for the refusal.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::BadRequest => "bad_request",
            Self::Malformed => "invalid_exclusive_request",
            Self::AttemptMismatch => "migration_attempt_mismatch",
            Self::RoleMismatch => "role_mismatch",
            Self::UnknownLibrary => "unknown_library",
        }
    }
}

fn refused(status: u16, error: &'static str) -> Decision {
    Decision::Refused { status, error }
}

const CONFLICT: Decision = Decision::Refused { status: 409, error: "migration_in_progress" };
const GONE: Decision = Decision::Refused { status: 410, error: "library_moved" };

pub(crate) fn valid_id32(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_source(source: &Source) -> bool {
    source.generation <= 9_007_199_254_740_991 && valid_digest(&source.head)
}

/// Whether `lock` is in force on its library: a household lock in a live phase, or a member lock whose own
/// household record is of the same attempt and live.
fn held(world: &World, lock: Option<&Lock>) -> bool {
    let Some(lock) = lock else { return false };
    match lock.role {
        Role::Household => lock.phase.live(),
        Role::Profile => {
            let Some(house) = household_lock(world, lock) else { return false };
            lock.phase == Phase::Open && house.attempt == lock.attempt && house.phase.live()
        }
    }
}

fn household_lock<'a>(world: &'a World, lock: &Lock) -> Option<&'a Lock> {
    let id = lock.household.as_ref()?;
    world.libraries.get(id)?.lock.as_ref()
}

fn may_act(world: &World, lock: &Lock, presenter: Option<&str>) -> bool {
    let Some(presenter) = presenter else { return false };
    match lock.role {
        Role::Household => lock.owner == presenter,
        Role::Profile => household_lock(world, lock)
            .is_some_and(|house| house.attempt == lock.attempt && house.owner == presenter),
    }
}

pub(crate) fn step(world: &World, request: &Req) -> Result<Decision, Invalid> {
    let library_id = request.library.as_str();
    let library = world.libraries.get(library_id).ok_or(Invalid::UnknownLibrary)?;
    let lock = library.lock.as_ref();
    let presenter = request.attempt.as_deref();

    match request.kind {
        Kind::Acquire | Kind::Takeover => acquire_or_takeover(world, request, library_id, library, lock),
        Kind::Commit => commit(world, request, lock),
        Kind::Abort => Ok(abort(world, library, lock, presenter)),
        Kind::Write => Ok(if library.retired {
            GONE
        } else if held(world, lock) {
            CONFLICT
        } else {
            Decision::Allowed
        }),
        Kind::Sweep => Ok(match lock {
            Some(lock) if lock.role == Role::Household && lock.phase == Phase::Aborted && !lock.swept => {
                let mut delete = vec![lock.successor.clone()];
                delete.extend(lock.members.iter().map(|member| member.successor.clone()));
                Decision::Sweep { delete }
            }
            _ => Decision::Nothing,
        }),
        Kind::Retire => Ok(retire(world, request, library, lock, presenter)),
    }
}

fn acquire_or_takeover(
    world: &World,
    request: &Req,
    library_id: &str,
    library: &Lib,
    lock: Option<&Lock>,
) -> Result<Decision, Invalid> {
    let acquire = request.kind == Kind::Acquire;
    let presenter = request.attempt.as_deref().filter(|attempt| valid_id32(attempt));
    let want_purpose = if acquire { PURPOSE } else { RECOVERY_PURPOSE };
    let (Some(presenter), Some(role)) = (presenter, request.role) else {
        return Err(Invalid::Malformed);
    };
    if request.purpose.as_deref() != Some(want_purpose) {
        return Err(Invalid::Malformed);
    }
    let expected = request.expected_source.as_ref().filter(|source| valid_source(source));
    let Some(expected) = expected else { return Err(Invalid::Malformed) };
    if !acquire && role != Role::Household {
        return Ok(CONFLICT);
    }
    if acquire {
        if !request.successor.as_deref().is_some_and(valid_id32_or_library) {
            return Err(Invalid::Malformed);
        }
        if role == Role::Household {
            let members = request.members.as_deref().unwrap_or_default();
            let ids: Vec<&str> = members.iter().map(|member| member.library_id.as_str()).collect();
            let mut everything: Vec<&str> = vec![library_id];
            everything.extend(ids.iter().copied());
            everything.push(request.successor.as_deref().unwrap_or_default());
            everything.extend(members.iter().map(|member| member.successor.as_str()));
            let mut sorted = ids.clone();
            sorted.sort_unstable();
            let mut distinct = everything.clone();
            distinct.sort_unstable();
            distinct.dedup();
            if ids.is_empty()
                || ids != sorted
                || !everything.iter().all(|id| valid_id32_or_library(id))
                || distinct.len() != everything.len()
            {
                return Err(Invalid::BadRequest);
            }
        } else if !request.household.as_deref().is_some_and(valid_id32_or_library) {
            return Err(Invalid::Malformed);
        }
    }
    if let Some(lock) = lock {
        if acquire && lock.attempt == presenter {
            let same = lock.role == role
                && &lock.source == expected
                && lock.purpose == PURPOSE
                && Some(lock.successor.as_str()) == request.successor.as_deref()
                && lock.members.as_slice() == request.members.as_deref().unwrap_or_default()
                && lock.household == request.household;
            return if same { Ok(Decision::Lookup) } else { Err(Invalid::AttemptMismatch) };
        }
        if !acquire {
            if lock.attempt == presenter {
                return Err(Invalid::AttemptMismatch);
            }
            if lock.owner == presenter {
                return if &lock.source == expected {
                    Ok(Decision::Lookup)
                } else {
                    Err(Invalid::AttemptMismatch)
                };
            }
        }
    }
    if library.retired {
        return Ok(GONE);
    }
    if held(world, lock) {
        let lock = lock.expect("a held lock exists");
        if acquire || lock.purpose != PURPOSE || lock.role != Role::Household {
            return Ok(CONFLICT);
        }
    } else if !acquire {
        return Ok(CONFLICT);
    }
    if !library.role.is(role) {
        return Err(Invalid::RoleMismatch);
    }
    if acquire && role == Role::Profile {
        let house = request
            .household
            .as_ref()
            .and_then(|id| world.libraries.get(id))
            .and_then(|lib| lib.lock.as_ref());
        let declared = Member {
            library_id: library_id.to_owned(),
            successor: request.successor.clone().unwrap_or_default(),
        };
        let ok = house.is_some_and(|house| {
            house.purpose == PURPOSE
                && house.phase == Phase::Open
                && house.attempt == presenter
                && house.owner == presenter
                && house.members.contains(&declared)
        });
        if !ok {
            return Ok(CONFLICT);
        }
    }
    if !acquire {
        let lock = lock.expect("a held lock exists");
        if !(expected == &lock.source && lock.source == library.source) {
            return Ok(CONFLICT);
        }
        let proof = request.successor_credential.as_deref();
        if let Some(proof) = proof {
            let successor = world.libraries.get(&lock.successor);
            let proven = successor.is_some_and(|successor| {
                !successor.retired && successor.credential.as_deref() == Some(proof)
            });
            if !proven {
                return Ok(CONFLICT);
            }
        }
        if proof.is_none() && lock.phase == Phase::Retiring {
            return Ok(CONFLICT);
        }
        if proof.is_none() && lock.phase == Phase::Committed {
            return Ok(Decision::Rollback);
        }
        return Ok(Decision::Takeover { phase: lock.phase });
    }
    if &library.source != expected {
        return Ok(refused(409, "migration_source_changed"));
    }
    Ok(Decision::Open)
}

/// The vectors use 32-hex ids; the store accepts any library id the routes accept (16 to 128 hex digits).
fn valid_id32_or_library(value: &str) -> bool {
    (16..=128).contains(&value.len()) && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn commit(world: &World, request: &Req, lock: Option<&Lock>) -> Result<Decision, Invalid> {
    let presenter = request.attempt.as_deref();
    if let Some(lock) = lock {
        if lock.role == Role::Household
            && Some(lock.attempt.as_str()) == presenter
            && Some(lock.owner.as_str()) == presenter
            && lock.phase == Phase::Committed
        {
            return if request.successor.as_deref() == Some(lock.successor.as_str()) {
                Ok(Decision::Lookup)
            } else {
                Err(Invalid::AttemptMismatch)
            };
        }
    }
    let Some(lock) = lock.filter(|lock| {
        lock.role == Role::Household
            && lock.phase == Phase::Open
            && Some(lock.attempt.as_str()) == presenter
            && Some(lock.owner.as_str()) == presenter
    }) else {
        return Ok(CONFLICT);
    };
    if request.successor.as_deref() != Some(lock.successor.as_str()) {
        return Err(Invalid::AttemptMismatch);
    }
    for member in &lock.members {
        let member_lock = world.libraries.get(&member.library_id).and_then(|lib| lib.lock.as_ref());
        let locked = member_lock.is_some_and(|member_lock| {
            member_lock.attempt == lock.attempt && member_lock.phase == Phase::Open
        });
        if !locked {
            return Ok(refused(409, "locks_incomplete"));
        }
    }
    let ready = world
        .libraries
        .get(&lock.successor)
        .is_some_and(|successor| !successor.retired && successor.wire_min >= 5 && successor.rows >= 1);
    if !ready {
        return Ok(refused(409, "successor_not_ready"));
    }
    Ok(Decision::Committed)
}

fn abort(world: &World, library: &Lib, lock: Option<&Lock>, presenter: Option<&str>) -> Decision {
    if library.retired {
        return GONE;
    }
    let Some(lock) = lock.filter(|lock| lock.role == Role::Household) else {
        return refused(404, "not_found");
    };
    if lock.phase == Phase::Aborted
        && presenter.is_some_and(|presenter| presenter == lock.attempt || presenter == lock.owner)
    {
        return Decision::Lookup;
    }
    if !held(world, Some(lock)) || Some(lock.owner.as_str()) != presenter || lock.phase != Phase::Open {
        return CONFLICT;
    }
    Decision::Aborted
}

fn retire(
    world: &World,
    request: &Req,
    library: &Lib,
    lock: Option<&Lock>,
    presenter: Option<&str>,
) -> Decision {
    let successor = request.successor.as_deref();
    if library.retired {
        return match lock {
            Some(lock)
                if lock.phase == Phase::Retired
                    && presenter
                        .is_some_and(|presenter| presenter == lock.attempt || presenter == lock.owner)
                    && successor == Some(lock.successor.as_str()) =>
            {
                Decision::Lookup
            }
            _ => GONE,
        };
    }
    if !held(world, lock) {
        return if presenter.is_none() { Decision::OrdinaryDelete } else { refused(409, "lock_not_held") };
    }
    let lock = lock.expect("a held lock exists");
    if !may_act(world, lock, presenter) {
        return CONFLICT;
    }
    if successor != Some(lock.successor.as_str()) {
        return refused(409, "successor_mismatch");
    }
    let house = match lock.role {
        Role::Household => lock,
        Role::Profile => household_lock(world, lock).expect("a held member has its household"),
    };
    if !house.proven {
        return CONFLICT;
    }
    if !matches!(house.phase, Phase::Committed | Phase::Retiring) {
        return refused(409, "successor_not_committed");
    }
    if lock.role == Role::Household {
        let members_retired = lock.members.iter().all(|member| {
            world
                .libraries
                .get(&member.library_id)
                .and_then(|lib| lib.lock.as_ref())
                .is_some_and(|member_lock| member_lock.phase == Phase::Retired)
        });
        if house.phase != Phase::Retiring || !members_retired {
            return refused(409, "locks_held");
        }
        return Decision::Retired { door: false };
    }
    Decision::Retired { door: house.phase == Phase::Committed }
}
