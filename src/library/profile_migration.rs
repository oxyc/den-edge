//! Dormant storage primitives for the one-time household/Owner split.
//!
//! These primitives implement the storage guarantees beneath den-spec profiles-v1 §8.1. The HTTP adapter at the
//! bottom of this module remains behind a separate default-off feature gate: one-transaction
//! source snapshots, a durable/read-back-verified backup before any destination write, an exact
//! generation/base/digest fenced in-place rewrite, and retirement while the freshly checked household authority
//! remains locked.

use super::v3::{
    LibrarySnapshot, LibraryStore, MigrationCommit, MigrationResultKind, Protocol, RestorePlan, RestoreRow,
    RewriteRow, StoreError,
};
use super::{library_store_locked, load_rewrite, owned, retire_owned_locked, v3_io};
use crate::handler::{constant_time_eq, error, internal, json_reply, read_json};
use crate::AppState;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io;
use std::sync::Arc;

const NS: &str = "lib-profile-migration";
const BACKUP_EXT: &str = "backup";
const STAGE_EXT: &str = "rows";
const BACKUP_VERSION: u64 = 1;
const PROFILE_WIRE_MINIMUM: u64 = 5;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const BODY_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MigrationFence {
    /// Durable per-household migration counter, deliberately unrelated to public `x-den-generation`.
    pub generation: u64,
    pub base: u64,
    /// SHA-256 of the canonical current-row snapshot, including generation, head and wire minimum.
    #[serde(rename = "head")]
    pub authenticated_head: String,
    pub rewrite: String,
}

/// The exact authenticated source a person saw before authorizing migration. This deliberately omits the public
/// generation, row base and rewrite nonce: den-core binds consent to the durable migration generation and the
/// canonical authenticated snapshot head.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MigrationSource {
    pub generation: u64,
    pub head: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BackupReference {
    pub attempt: String,
    pub id: String,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProtectedLibraries {
    /// The household and every live profile library id from the validated directory.
    pub ids: HashSet<String>,
}

pub(crate) struct RetirementRequest<'a> {
    pub attempt: &'a str,
    pub source: &'a MigrationFence,
    pub authority: &'a RetirementAuthority,
    pub profiles_row: Option<&'a SealedProfilesRow>,
    pub protected: &'a ProtectedLibraries,
    pub candidate_id: &'a str,
}

/// Fresh household authority supplied by the client. `kind` participates in the compare-and-swap so a committed
/// directory cannot be cleaned up through the looser changed-legacy branch.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RetirementAuthority {
    pub generation: u64,
    pub base: u64,
    pub head: String,
    pub kind: AuthorityKind,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AuthorityKind {
    Committed,
    ChangedLegacy,
    Corrupt,
}

/// Opaque identity of the exact sealed `profiles` row authenticated by the client. den-edge receives no keys.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SealedProfilesRow {
    #[serde(rename = "k")]
    pub key: String,
    #[serde(rename = "seq")]
    pub sequence: u64,
    #[serde(rename = "v")]
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfilesRowEvidence {
    pub present: bool,
    pub seq: Option<u64>,
    pub digest: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DirectoryState {
    Absent,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestoreRequest {
    pub backup: BackupReference,
    pub fence: MigrationFence,
    #[serde(rename = "wireMin")]
    pub wire_minimum: u64,
    pub profiles_row: ProfilesRowEvidence,
    pub directory_state: DirectoryState,
    pub planner_decision: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AttemptEvidence {
    pub attempt: String,
    pub state: AttemptState,
    pub purpose: AttemptPurpose,
    pub wire_minimum: u64,
    pub fence: MigrationFence,
    pub backup: Option<BackupReference>,
    pub winner: Option<MigrationCommit>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AttemptPurpose {
    Split,
    Restore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RetirementResult {
    Retired,
    Absent,
}

#[derive(Debug)]
pub(crate) enum MigrationError {
    Invalid(&'static str),
    InProgress,
    FenceChanged,
    SourceChanged,
    BackupMissing,
    BackupCorrupt,
    SameLegacyFence,
    ProtectedCandidate,
    NotFound,
    Forbidden,
    Storage(io::Error),
}

impl From<io::Error> for MigrationError {
    fn from(value: io::Error) -> Self {
        Self::Storage(value)
    }
}

impl From<StoreError> for MigrationError {
    fn from(value: StoreError) -> Self {
        match value {
            StoreError::Forbidden => Self::Forbidden,
            StoreError::Locked => Self::InProgress,
            other => Self::Storage(v3_io(other)),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SnapshotRow {
    #[serde(rename = "k")]
    key: String,
    #[serde(rename = "seq")]
    sequence: u64,
    #[serde(rename = "v")]
    value: String,
}

#[derive(Clone, Debug, Serialize)]
struct SnapshotAuthority<'a> {
    #[serde(rename = "libraryId")]
    library_id: &'a str,
    #[serde(rename = "generation")]
    migration_generation: u64,
    #[serde(rename = "base")]
    head: u64,
    #[serde(rename = "wireMin")]
    wire_minimum: u64,
    rows: &'a [SnapshotRow],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DurableBackup {
    version: u64,
    manifest: BackupManifest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BackupManifest {
    id: String,
    #[serde(rename = "householdId")]
    household_id: String,
    attempt: String,
    source: MigrationFence,
    #[serde(rename = "wireMin")]
    wire_minimum: u64,
    authorization: BackupAuthorization,
    rows: Vec<SnapshotRow>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupAuthorization {
    token_hash: String,
    member_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DurableAttempt {
    version: u64,
    household_id: String,
    attempt: String,
    purpose: AttemptPurpose,
    wire_minimum: u64,
    request_digest: Option<String>,
    terminal: Option<MigrationCommit>,
    state: AttemptState,
    fence: MigrationFence,
    /// The immutable provider-read-back-verified artifact bound before this attempt becomes authoritative. A
    /// split always owns its artifact; a restore owns the original split artifact selected by recovery handoff.
    backup: Option<BackupReference>,
    #[serde(default)]
    provider_read_back_verified: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AttemptState {
    Open,
    Committed,
    Restored,
    Superseded,
    Aborted,
}

#[derive(Deserialize)]
struct Fragment {
    k: String,
    seq: u64,
    v: String,
}

pub(crate) struct ProfileMigrationStorage<'a> {
    state: &'a AppState,
}

impl<'a> ProfileMigrationStorage<'a> {
    pub(crate) fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    /// Observe one exact household authority. Opening is durable and idempotent for one immutable purpose.
    pub(crate) async fn open_attempt(
        &self,
        attempt: &str,
        purpose: AttemptPurpose,
        expected_source: &MigrationSource,
        household_id: &str,
        token_hash: [u8; 32],
        allow_new_split: bool,
    ) -> Result<AttemptEvidence, MigrationError> {
        valid_attempt(attempt)?;
        valid_source(expected_source)?;
        self.authenticate_household(household_id, token_hash).await?;
        // A terminal replay is a durable lookup first. An open replay continues to the durable lock check: a
        // sidecar may have reached disk immediately before a crash that preceded lock acquisition.
        if let Some(opened) = self.load_attempt(household_id, attempt).await? {
            if opened.purpose != purpose || source_from_fence(&opened.fence) != *expected_source {
                return Err(MigrationError::Invalid("migration attempt mismatch"));
            }
            let mut resolved = opened.clone();
            // The redb terminal may be newer than the sidecar after a crash. Repair it when possible, but an exact
            // replay still returns its stored result if current storage cannot be consulted.
            if self.resolve_terminal(household_id, token_hash, &mut resolved).await.is_ok()
                && resolved.state != AttemptState::Open
            {
                return Ok(AttemptEvidence {
                    attempt: resolved.attempt,
                    state: resolved.state,
                    purpose: resolved.purpose,
                    wire_minimum: resolved.wire_minimum,
                    fence: resolved.fence,
                    backup: resolved.backup,
                    winner: resolved.terminal,
                });
            }
        }
        if purpose == AttemptPurpose::Split && !allow_new_split {
            return Err(MigrationError::NotFound);
        }
        let slot = self.state.libraries.slot(household_id, self.state.now());
        let mut library = slot.library.lock().await;
        let store = library_store_locked(self.state, household_id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        let read_store = Arc::clone(&store);
        let active = tokio::task::spawn_blocking(move || read_store.exclusive_operation_lock())
            .await
            .map_err(io::Error::other)??;
        if active.as_deref() == Some(attempt) {
            let opened = self.load_attempt(household_id, attempt).await?.ok_or(MigrationError::InProgress)?;
            if opened.purpose != purpose || source_from_fence(&opened.fence) != *expected_source {
                return Err(MigrationError::Invalid("migration attempt mismatch"));
            }
            if !opened.provider_read_back_verified || opened.backup.is_none() {
                return Err(MigrationError::InProgress);
            }
            return Ok(attempt_evidence(opened));
        }
        if let Some(held) = active.as_deref() {
            if purpose != AttemptPurpose::Restore {
                return Err(MigrationError::InProgress);
            }
            // The only different-attempt exception is owner-authenticated recovery handoff. Resolve the held id
            // internally and reveal nothing unless its split has the invariant read-back-verified backup.
            let mut split = self
                .load_attempt(household_id, held)
                .await
                .map_err(|reason| match reason {
                    MigrationError::Storage(_) => reason,
                    _ => MigrationError::InProgress,
                })?
                .ok_or(MigrationError::InProgress)?;
            let backup = split.backup.clone().ok_or(MigrationError::InProgress)?;
            if split.state != AttemptState::Open
                || split.purpose != AttemptPurpose::Split
                || !split.provider_read_back_verified
                || source_from_fence(&split.fence) != *expected_source
            {
                return Err(MigrationError::InProgress);
            }
            self.load_verified_backup(household_id, &split.fence, &backup).await.map_err(|reason| {
                match reason {
                    MigrationError::Storage(_) => reason,
                    _ => MigrationError::InProgress,
                }
            })?;
            let read_store = Arc::clone(&store);
            let snapshot = tokio::task::spawn_blocking(move || read_store.snapshot())
                .await
                .map_err(io::Error::other)??;
            if migration_source(household_id, &snapshot)? != *expected_source {
                return Err(MigrationError::InProgress);
            }
            let existing = self.load_attempt(household_id, attempt).await?;
            let restore = match existing {
                Some(opened)
                    if opened.purpose == AttemptPurpose::Restore
                        && source_from_fence(&opened.fence) == *expected_source
                        && opened.backup.as_ref() == Some(&backup)
                        && opened.provider_read_back_verified =>
                {
                    opened
                }
                Some(_) => return Err(MigrationError::Invalid("migration attempt mismatch")),
                None => {
                    let opened = DurableAttempt {
                        version: BACKUP_VERSION,
                        household_id: household_id.to_owned(),
                        attempt: attempt.to_owned(),
                        purpose,
                        wire_minimum: snapshot.protocol.wire_min,
                        request_digest: None,
                        terminal: None,
                        state: AttemptState::Open,
                        fence: fence(household_id, &snapshot, crate::hex(&crate::random_bytes::<16>()))?,
                        backup: Some(backup),
                        provider_read_back_verified: true,
                    };
                    self.save_attempt(&opened).await?;
                    opened
                }
            };
            let write_store = Arc::clone(&store);
            let from_attempt = held.to_owned();
            let to_attempt = attempt.to_owned();
            let expected_generation = restore.fence.generation;
            let expected_base = restore.fence.base;
            let transferred = tokio::task::spawn_blocking(move || {
                write_store.transfer_exclusive_operation_lock(
                    &from_attempt,
                    &to_attempt,
                    expected_generation,
                    expected_base,
                )
            })
            .await
            .map_err(io::Error::other)?;
            match transferred {
                Ok(()) => {}
                Err(StoreError::Locked) | Err(StoreError::Invalid(_)) => {
                    return Err(MigrationError::InProgress);
                }
                Err(reason) => return Err(reason.into()),
            }
            split.state = AttemptState::Aborted;
            if let Err(reason) = self.save_attempt(&split).await {
                eprintln!("profile migration recovery handoff sidecar: {reason:?}");
            }
            return Ok(attempt_evidence(restore));
        }
        if active.is_none() && load_rewrite(self.state, household_id).await?.is_some() {
            return Err(MigrationError::Invalid("another rewrite is staged"));
        }
        // Re-read the sidecar under the same household lock. A sidecar without a matching redb lock is only a
        // crash remnant from before acquisition and may resume only this exact immutable attempt.
        let existing = self.load_attempt(household_id, attempt).await?;
        if let Some(opened) = existing.as_ref() {
            if opened.purpose != purpose || source_from_fence(&opened.fence) != *expected_source {
                return Err(MigrationError::Invalid("migration attempt mismatch"));
            }
        }
        let read_store = Arc::clone(&store);
        let snapshot =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
        if migration_source(household_id, &snapshot)? != *expected_source {
            return Err(MigrationError::SourceChanged);
        }
        let opened = match existing {
            Some(opened) => {
                if !opened.provider_read_back_verified || opened.backup.is_none() {
                    return Err(MigrationError::InProgress);
                }
                let backup = opened.backup.as_ref().ok_or(MigrationError::InProgress)?;
                let verified = if opened.purpose == AttemptPurpose::Split {
                    self.load_verified_backup(household_id, &opened.fence, backup).await.map(drop)
                } else {
                    self.load_backup_for_restore(household_id, backup).await.map(drop)
                };
                if verified.is_err() {
                    return Err(MigrationError::InProgress);
                }
                opened
            }
            None => {
                let frozen = fence(household_id, &snapshot, crate::hex(&crate::random_bytes::<16>()))?;
                let backup = match purpose {
                    AttemptPurpose::Split => Some(
                        self.create_backup_artifact(
                            attempt,
                            household_id,
                            token_hash,
                            &frozen,
                            &snapshot,
                            store.credentials().1,
                        )
                        .await?,
                    ),
                    AttemptPurpose::Restore => {
                        let read_store = Arc::clone(&store);
                        let winner =
                            tokio::task::spawn_blocking(move || read_store.latest_migration_result())
                                .await
                                .map_err(io::Error::other)??
                                .ok_or(MigrationError::InProgress)?;
                        let reference = self
                            .load_attempt(household_id, &winner.attempt)
                            .await?
                            .and_then(|terminal| terminal.backup)
                            .unwrap_or(BackupReference {
                                attempt: winner.attempt,
                                id: winner.backup_id,
                                digest: winner.backup_digest,
                            });
                        self.load_backup_for_restore(household_id, &reference).await.map_err(|reason| {
                            match reason {
                                MigrationError::Storage(_) => reason,
                                _ => MigrationError::InProgress,
                            }
                        })?;
                        Some(reference)
                    }
                };
                let opened = DurableAttempt {
                    version: BACKUP_VERSION,
                    household_id: household_id.to_owned(),
                    attempt: attempt.to_owned(),
                    purpose,
                    wire_minimum: snapshot.protocol.wire_min,
                    request_digest: None,
                    terminal: None,
                    state: AttemptState::Open,
                    fence: frozen,
                    backup,
                    provider_read_back_verified: true,
                };
                self.save_attempt(&opened).await?;
                opened
            }
        };
        let write_store = Arc::clone(&store);
        let lock_attempt = attempt.to_owned();
        let expected_generation = opened.fence.generation;
        let expected_base = opened.fence.base;
        let acquired = tokio::task::spawn_blocking(move || {
            write_store.acquire_exclusive_operation_lock(&lock_attempt, expected_generation, expected_base)
        })
        .await
        .map_err(io::Error::other)?;
        match acquired {
            Ok(()) => Ok(attempt_evidence(opened)),
            Err(StoreError::Locked) => Err(MigrationError::InProgress),
            Err(StoreError::Invalid(message)) if message == "migration_source_changed" => {
                Err(MigrationError::SourceChanged)
            }
            Err(reason) => Err(reason.into()),
        }
    }

    /// Read the migration-authoritative source without creating an attempt. A later open must present this exact
    /// value and rechecks it while holding the same household lock, closing the consent-to-open race.
    pub(crate) async fn observe_source(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
    ) -> Result<MigrationSource, MigrationError> {
        let slot = self.state.libraries.slot(household_id, self.state.now());
        let mut library = slot.library.lock().await;
        if load_rewrite(self.state, household_id).await?.is_some() {
            return Err(MigrationError::Invalid("another rewrite is staged"));
        }
        let store = library_store_locked(self.state, household_id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        let snapshot =
            tokio::task::spawn_blocking(move || store.snapshot()).await.map_err(io::Error::other)??;
        migration_source(household_id, &snapshot)
    }

    #[cfg(test)]
    async fn acquire_fence(
        &self,
        attempt: &str,
        household_id: &str,
        token_hash: [u8; 32],
    ) -> Result<MigrationFence, MigrationError> {
        let source = self.observe_source(household_id, token_hash).await?;
        Ok(self
            .open_attempt(attempt, AttemptPurpose::Split, &source, household_id, token_hash, true)
            .await?
            .fence)
    }

    /// Re-open and verify the immutable backup already bound by open. This compatibility endpoint never creates a
    /// second artifact: lock publication and backup publication share the open crash boundary.
    pub(crate) async fn create_verified_backup(
        &self,
        attempt: &str,
        household_id: &str,
        token_hash: [u8; 32],
        expected: &MigrationFence,
    ) -> Result<BackupReference, MigrationError> {
        valid_attempt(attempt)?;
        let slot = self.state.libraries.slot(household_id, self.state.now());
        let mut library = slot.library.lock().await;
        if load_rewrite(self.state, household_id).await?.is_some() {
            return Err(MigrationError::Invalid("another rewrite is staged"));
        }
        let store = library_store_locked(self.state, household_id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        self.ensure_attempt_lock(&store, attempt).await?;
        let opened = self
            .load_attempt(household_id, attempt)
            .await?
            .ok_or(MigrationError::Invalid("attempt is absent"))?;
        if opened.state != AttemptState::Open || opened.fence != *expected {
            return Err(MigrationError::FenceChanged);
        }
        let reference = opened.backup.ok_or(MigrationError::InProgress)?;
        if !opened.provider_read_back_verified {
            return Err(MigrationError::InProgress);
        }
        if opened.purpose == AttemptPurpose::Split {
            self.load_verified_backup(household_id, expected, &reference).await?;
        } else {
            self.load_backup_for_restore(household_id, &reference).await?;
        }
        Ok(reference)
    }

    async fn create_backup_artifact(
        &self,
        attempt: &str,
        household_id: &str,
        token_hash: [u8; 32],
        expected: &MigrationFence,
        snapshot: &LibrarySnapshot,
        member_hash: Option<[u8; 32]>,
    ) -> Result<BackupReference, MigrationError> {
        ensure_fence(household_id, snapshot, expected)?;
        let manifest = BackupManifest {
            id: format!("backup-{attempt}"),
            household_id: household_id.to_owned(),
            attempt: attempt.to_owned(),
            source: expected.clone(),
            wire_minimum: snapshot.protocol.wire_min,
            authorization: BackupAuthorization {
                token_hash: crate::hex(&token_hash),
                member_hash: member_hash.map(|value| crate::hex(&value)),
            },
            rows: snapshot_rows(snapshot)?,
        };
        let backup = DurableBackup { version: BACKUP_VERSION, manifest };
        let bytes = serde_json::to_vec(&backup).map_err(io::Error::other)?;
        let digest = hex_digest(&canonical_json(&backup.manifest)?);
        let backup_key = attempt_key(household_id, attempt);
        if let Some(existing) = self.state.store.get_file(NS, &backup_key, BACKUP_EXT).await? {
            if existing != bytes {
                return Err(MigrationError::FenceChanged);
            }
        } else {
            self.state.store.replace_file(NS, &backup_key, BACKUP_EXT, &bytes).await?;
            self.state.store.sync_dir(NS).await?;
        }
        let reference =
            BackupReference { attempt: attempt.to_owned(), id: backup.manifest.id.clone(), digest };
        self.load_verified_backup(household_id, expected, &reference).await?;
        Ok(reference)
    }

    /// Re-open, parse and digest the durable evidence. This intentionally does not trust a successful write call:
    /// the migration may resume in another process after the creating process died.
    pub(crate) async fn verify_backup(
        &self,
        household_id: &str,
        expected: &MigrationFence,
        reference: &BackupReference,
    ) -> Result<(), MigrationError> {
        self.load_verified_backup(household_id, expected, reference).await.map(drop)
    }

    async fn load_verified_backup(
        &self,
        household_id: &str,
        expected: &MigrationFence,
        reference: &BackupReference,
    ) -> Result<BackupManifest, MigrationError> {
        valid_attempt(&reference.attempt)?;
        let bytes = self
            .state
            .store
            .get_file(NS, &attempt_key(household_id, &reference.attempt), BACKUP_EXT)
            .await?
            .ok_or(MigrationError::BackupMissing)?;
        let backup: DurableBackup =
            serde_json::from_slice(&bytes).map_err(|_| MigrationError::BackupCorrupt)?;
        let digest = hex_digest(&canonical_json(&backup.manifest)?);
        if !constant_time_eq(digest.as_bytes(), reference.digest.as_bytes()) {
            return Err(MigrationError::BackupCorrupt);
        }
        if backup.version != BACKUP_VERSION
            || backup.manifest.id != reference.id
            || backup.manifest.attempt != reference.attempt
            || backup.manifest.household_id != household_id
            || backup.manifest.source != *expected
            || !valid_backup_rows(&backup.manifest.rows)
            || !valid_digest(&backup.manifest.authorization.token_hash)
            || backup.manifest.authorization.member_hash.as_deref().is_some_and(|hash| !valid_digest(hash))
            || backup_head(&backup.manifest)? != expected.authenticated_head
        {
            return Err(MigrationError::BackupCorrupt);
        }
        Ok(backup.manifest)
    }

    async fn verified_backup_json(
        &self,
        household_id: &str,
        reference: &BackupReference,
    ) -> Result<Value, MigrationError> {
        let manifest = self.load_backup_for_restore(household_id, reference).await?;
        let mut value = serde_json::to_value(&manifest).map_err(io::Error::other)?;
        value
            .as_object_mut()
            .ok_or(MigrationError::BackupCorrupt)?
            .insert("digest".into(), Value::String(reference.digest.clone()));
        Ok(value)
    }

    async fn backup_reference(
        &self,
        household_id: &str,
        attempt: &str,
    ) -> Result<BackupReference, MigrationError> {
        let opened = self.load_attempt(household_id, attempt).await?.ok_or(MigrationError::NotFound)?;
        if !opened.provider_read_back_verified {
            return Err(MigrationError::BackupCorrupt);
        }
        let reference = opened.backup.ok_or(MigrationError::BackupMissing)?;
        self.load_backup_for_restore(household_id, &reference).await?;
        Ok(reference)
    }

    async fn load_backup_for_restore(
        &self,
        household_id: &str,
        reference: &BackupReference,
    ) -> Result<BackupManifest, MigrationError> {
        let bytes = self
            .state
            .store
            .get_file(NS, &attempt_key(household_id, &reference.attempt), BACKUP_EXT)
            .await?
            .ok_or(MigrationError::BackupMissing)?;
        let artifact: DurableBackup =
            serde_json::from_slice(&bytes).map_err(|_| MigrationError::BackupCorrupt)?;
        let source = artifact.manifest.source.clone();
        let original = self
            .load_attempt(household_id, &reference.attempt)
            .await?
            .ok_or(MigrationError::BackupCorrupt)?;
        if original.purpose != AttemptPurpose::Split || original.fence != source {
            return Err(MigrationError::BackupCorrupt);
        }
        self.load_verified_backup(household_id, &source, reference).await
    }

    /// Durable lookup after a response is lost during commit. Attempt- and generation-scoped terminal records share
    /// the redb transaction with the rewrite, so this also repairs a sidecar that the process died before updating.
    pub(crate) async fn lookup_attempt(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
        attempt: &str,
    ) -> Result<AttemptEvidence, MigrationError> {
        valid_attempt(attempt)?;
        let mut durable = self.load_attempt(household_id, attempt).await?.ok_or(MigrationError::NotFound)?;
        self.resolve_terminal(household_id, token_hash, &mut durable).await?;
        let store = self.state.library_v3.existing_library(household_id, token_hash)?;
        if durable.state == AttemptState::Open {
            // A sidecar written immediately before a crash that preceded lock acquisition is not a recorded
            // attempt: the lock transaction is the commit point of open.
            let lock_store = Arc::clone(&store);
            let held = tokio::task::spawn_blocking(move || lock_store.exclusive_operation_lock())
                .await
                .map_err(io::Error::other)??;
            if held.as_deref() != Some(attempt) {
                return Err(MigrationError::NotFound);
            }
        }
        let lookup_attempt = durable.attempt.clone();
        let expected_generation = durable.fence.generation;
        let winner =
            tokio::task::spawn_blocking(move || store.migration_result(&lookup_attempt, expected_generation))
                .await
                .map_err(io::Error::other)??;
        Ok(AttemptEvidence {
            attempt: durable.attempt,
            state: durable.state,
            purpose: durable.purpose,
            wire_minimum: durable.wire_minimum,
            fence: durable.fence,
            backup: durable.backup,
            winner: durable.terminal.or(winner),
        })
    }

    /// Explicit abort is the only transition from open to aborted. Terminal evidence remains durable.
    pub(crate) async fn abort_attempt(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
        attempt: &str,
    ) -> Result<AttemptEvidence, MigrationError> {
        valid_attempt(attempt)?;
        let slot = self.state.libraries.slot(household_id, self.state.now());
        let mut library = slot.library.lock().await;
        let store = library_store_locked(self.state, household_id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        let mut durable = self.load_attempt(household_id, attempt).await?.ok_or(MigrationError::NotFound)?;
        let read_store = Arc::clone(&store);
        let active = tokio::task::spawn_blocking(move || read_store.exclusive_operation_lock())
            .await
            .map_err(io::Error::other)??;
        if active.as_deref().is_some_and(|held| held != attempt) {
            return Err(MigrationError::InProgress);
        }
        let abort_store = Arc::clone(&store);
        let abort_attempt = attempt.to_owned();
        let already_aborted =
            tokio::task::spawn_blocking(move || abort_store.exclusive_operation_aborted(&abort_attempt))
                .await
                .map_err(io::Error::other)??;
        let read_store = Arc::clone(&store);
        let lookup_attempt = durable.attempt.clone();
        let expected_generation = durable.fence.generation;
        let winner = tokio::task::spawn_blocking(move || {
            read_store.migration_result(&lookup_attempt, expected_generation)
        })
        .await
        .map_err(io::Error::other)??;
        if durable.state == AttemptState::Open {
            durable.state = match winner.as_ref() {
                Some(winner) if winner.attempt == durable.attempt => match winner.kind {
                    MigrationResultKind::Committed => AttemptState::Committed,
                    MigrationResultKind::Restored => AttemptState::Restored,
                },
                Some(_) => AttemptState::Superseded,
                None if already_aborted => AttemptState::Aborted,
                None => {
                    if active.as_deref() != Some(attempt) {
                        return Err(MigrationError::NotFound);
                    }
                    if self
                        .state
                        .store
                        .get_file(NS, &attempt_key(household_id, attempt), STAGE_EXT)
                        .await?
                        .is_some()
                    {
                        return Err(MigrationError::InProgress);
                    }
                    let write_store = Arc::clone(&store);
                    let abort_attempt = attempt.to_owned();
                    let generation = durable.fence.generation;
                    let base = durable.fence.base;
                    tokio::task::spawn_blocking(move || {
                        write_store.abort_exclusive_operation(&abort_attempt, generation, base)
                    })
                    .await
                    .map_err(io::Error::other)??;
                    AttemptState::Aborted
                }
            };
            durable.terminal = winner.clone();
            self.save_attempt(&durable).await?;
        }
        Ok(AttemptEvidence {
            attempt: durable.attempt,
            state: durable.state,
            purpose: durable.purpose,
            wire_minimum: durable.wire_minimum,
            fence: durable.fence,
            backup: durable.backup,
            winner: durable.terminal.or(winner),
        })
    }

    /// Replace the mixed household in place. The same id and key are used; all three source authorities must still
    /// match the backup: database generation, numeric base and authenticated current-row digest.
    #[cfg(test)]
    pub(super) async fn rewrite_household(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
        expected: &MigrationFence,
        backup: &BackupReference,
        rows: &[RewriteRow],
    ) -> Result<Protocol, MigrationError> {
        let opened = self
            .load_attempt(household_id, &backup.attempt)
            .await?
            .ok_or(MigrationError::Invalid("attempt is absent"))?;
        if opened.state != AttemptState::Open
            || opened.purpose != AttemptPurpose::Split
            || opened.fence != *expected
            || opened.backup.as_ref() != Some(backup)
            || !opened.provider_read_back_verified
        {
            return Err(MigrationError::FenceChanged);
        }
        self.verify_backup(household_id, expected, backup).await?;
        let staged_digest = self.stage_rows(household_id, expected, backup, rows).await?;
        self.commit_household(household_id, token_hash, expected, backup, &staged_digest).await
    }

    pub(crate) async fn stage_household_rows(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
        expected: &MigrationFence,
        backup: &BackupReference,
        rows: &[RewriteRow],
    ) -> Result<String, MigrationError> {
        let mut keys = HashSet::with_capacity(rows.len());
        if rows.is_empty()
            || rows.len() > super::MAX_ROWS
            || rows.iter().any(|row| {
                !super::valid_hex_id(&row.key)
                    || !keys.insert(row.key.as_str())
                    || row.value.len() > super::MAX_VALUE_V4
            })
        {
            return Err(MigrationError::Invalid("invalid staged rows"));
        }
        let slot = self.state.libraries.slot(household_id, self.state.now());
        let mut library = slot.library.lock().await;
        let store = library_store_locked(self.state, household_id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        self.ensure_attempt_lock(&store, &backup.attempt).await?;
        let opened = self
            .load_attempt(household_id, &backup.attempt)
            .await?
            .ok_or(MigrationError::Invalid("attempt is absent"))?;
        if opened.state != AttemptState::Open
            || opened.purpose != AttemptPurpose::Split
            || opened.fence != *expected
            || opened.backup.as_ref() != Some(backup)
            || !opened.provider_read_back_verified
        {
            return Err(MigrationError::FenceChanged);
        }
        self.stage_rows(household_id, expected, backup, rows).await
    }

    async fn ensure_attempt_lock(
        &self,
        store: &Arc<dyn LibraryStore>,
        attempt: &str,
    ) -> Result<(), MigrationError> {
        let read_store = Arc::clone(store);
        let active = tokio::task::spawn_blocking(move || read_store.exclusive_operation_lock())
            .await
            .map_err(io::Error::other)??;
        if active.as_deref() == Some(attempt) {
            Ok(())
        } else {
            Err(MigrationError::InProgress)
        }
    }

    pub(crate) async fn commit_household(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
        expected: &MigrationFence,
        backup: &BackupReference,
        requested_staged_digest: &str,
    ) -> Result<Protocol, MigrationError> {
        self.verify_backup(household_id, expected, backup).await?;
        let (rows, staged_digest) = self.load_staged_rows(household_id, &backup.attempt).await?;
        if !constant_time_eq(staged_digest.as_bytes(), requested_staged_digest.as_bytes()) {
            return Err(MigrationError::Invalid("staged digest changed"));
        }
        let slot = self.state.libraries.slot(household_id, self.state.now());
        let mut library = slot.library.lock().await;
        if load_rewrite(self.state, household_id).await?.is_some() {
            return Err(MigrationError::Invalid("another rewrite is staged"));
        }
        let store = library_store_locked(self.state, household_id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        let opened = self
            .load_attempt(household_id, &backup.attempt)
            .await?
            .ok_or(MigrationError::Invalid("attempt is absent"))?;
        if opened.state != AttemptState::Open
            || opened.purpose != AttemptPurpose::Split
            || opened.fence != *expected
            || opened.backup.as_ref() != Some(backup)
            || !opened.provider_read_back_verified
        {
            return Err(MigrationError::FenceChanged);
        }
        let read_store = Arc::clone(&store);
        let snapshot =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
        if ensure_fence(household_id, &snapshot, expected).is_err() {
            return Err(MigrationError::FenceChanged);
        }
        let owned_rows = rows;
        let live_cap = self.state.library_limits.stored_bytes;
        let base = expected.base;
        let resulting_generation = expected
            .generation
            .checked_add(1)
            .ok_or(MigrationError::Invalid("migration generation exhausted"))?;
        let resulting_base = base
            .checked_add(owned_rows.len() as u64)
            .ok_or(MigrationError::Invalid("migration base exhausted"))?;
        let resulting_wire_minimum = snapshot.protocol.wire_min.max(PROFILE_WIRE_MINIMUM);
        let commit = MigrationCommit {
            kind: MigrationResultKind::Committed,
            expected_generation: expected.generation,
            resulting_generation,
            resulting_base,
            resulting_head: projected_head(
                household_id,
                resulting_generation,
                resulting_base,
                resulting_wire_minimum,
                &owned_rows,
            )?,
            wire_minimum: resulting_wire_minimum,
            attempt: backup.attempt.clone(),
            backup_id: backup.id.clone(),
            backup_digest: backup.digest.clone(),
            staged_digest: Some(staged_digest),
            request_digest: None,
        };
        let terminal = commit.clone();
        let protocol = tokio::task::spawn_blocking(move || {
            store.rewrite(base, &owned_rows, PROFILE_WIRE_MINIMUM, live_cap, Some(&commit))
        })
        .await
        .map_err(io::Error::other)??;
        self.set_attempt_terminal(household_id, &backup.attempt, AttemptState::Committed, terminal).await?;
        self.state.library_holds.wake(household_id);
        Ok(protocol)
    }

    /// Restore is a distinct, explicitly opened recovery transaction. The request is durably bound before the
    /// compare-and-swap, and the redb terminal marker commits atomically with the restored rows.
    pub(crate) async fn restore_backup(
        &self,
        recovery_attempt: &str,
        household_id: &str,
        token_hash: [u8; 32],
        request: &RestoreRequest,
    ) -> Result<MigrationCommit, MigrationError> {
        valid_attempt(recovery_attempt)?;
        if request.backup.attempt == recovery_attempt
            || request.planner_decision != "restore-backup"
            || !valid_profiles_evidence(&request.profiles_row)
        {
            return Err(MigrationError::Invalid("invalid restore request"));
        }
        let backup = self.load_backup_for_restore(household_id, &request.backup).await?;
        if !constant_time_eq(backup.authorization.token_hash.as_bytes(), crate::hex(&token_hash).as_bytes()) {
            return Err(MigrationError::Forbidden);
        }
        let member_hash = match backup.authorization.member_hash.as_deref() {
            Some(member) => Some(super::from_hex32(member).ok_or(MigrationError::BackupCorrupt)?),
            None => None,
        };
        let request_digest = hex_digest(&canonical_json(request)?);
        let slot = self.state.libraries.slot(household_id, self.state.now());
        let mut library = slot.library.lock().await;
        if load_rewrite(self.state, household_id).await?.is_some() {
            return Err(MigrationError::Invalid("another rewrite is staged"));
        }
        let store = library_store_locked(self.state, household_id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        let mut opened = self
            .load_attempt(household_id, recovery_attempt)
            .await?
            .ok_or(MigrationError::Invalid("recovery attempt is absent"))?;
        if opened.purpose != AttemptPurpose::Restore
            || opened.fence != request.fence
            || opened.wire_minimum != request.wire_minimum
            || opened.backup.as_ref() != Some(&request.backup)
            || !opened.provider_read_back_verified
        {
            return Err(MigrationError::Invalid("recovery attempt mismatch"));
        }
        if opened.request_digest.as_ref().is_some_and(|bound| bound != &request_digest) {
            return Err(MigrationError::Invalid("restore request changed"));
        }
        if opened.state == AttemptState::Restored {
            return opened.terminal.ok_or(MigrationError::BackupCorrupt);
        }
        if opened.state != AttemptState::Open {
            return Err(MigrationError::FenceChanged);
        }
        if opened.request_digest.is_none() {
            opened.request_digest = Some(request_digest.clone());
            self.save_attempt(&opened).await?;
        }
        let read_store = Arc::clone(&store);
        let current =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
        if ensure_fence(household_id, &current, &request.fence).is_err()
            || current.protocol.wire_min != request.wire_minimum
            || !profiles_evidence_matches(&current, &request.profiles_row)?
        {
            return Err(MigrationError::FenceChanged);
        }
        let resulting_generation = request
            .fence
            .generation
            .checked_add(1)
            .ok_or(MigrationError::Invalid("migration generation exhausted"))?;
        let resulting_wire_minimum = current.protocol.wire_min.max(backup.wire_minimum);
        let resulting_head = restored_head(
            household_id,
            resulting_generation,
            backup.source.base,
            resulting_wire_minimum,
            &backup.rows,
        )?;
        let terminal = MigrationCommit {
            kind: MigrationResultKind::Restored,
            expected_generation: request.fence.generation,
            resulting_generation,
            resulting_base: backup.source.base,
            resulting_head,
            wire_minimum: resulting_wire_minimum,
            attempt: recovery_attempt.to_owned(),
            backup_id: request.backup.id.clone(),
            backup_digest: request.backup.digest.clone(),
            staged_digest: None,
            request_digest: Some(request_digest),
        };
        let rows = backup
            .rows
            .iter()
            .map(|row| RestoreRow { key: row.key.clone(), sequence: row.sequence, value: row.value.clone() })
            .collect::<Vec<_>>();
        let current_base = request.fence.base;
        let restored_base = backup.source.base;
        let backup_wire_minimum = backup.wire_minimum;
        let live_cap = self.state.library_limits.stored_bytes;
        let write_store = Arc::clone(&store);
        let stored_terminal = terminal.clone();
        let protocol = tokio::task::spawn_blocking(move || {
            write_store.restore(RestorePlan {
                current_base,
                restored_base,
                rows: &rows,
                wire_min: backup_wire_minimum,
                member_hash,
                live_cap,
                migration: &stored_terminal,
            })
        })
        .await
        .map_err(io::Error::other)??;
        if protocol.migration_generation != terminal.resulting_generation
            || protocol.head != terminal.resulting_base
            || protocol.wire_min != terminal.wire_minimum
        {
            return Err(MigrationError::Storage(io::Error::other("restore result mismatch")));
        }
        self.set_attempt_terminal(household_id, recovery_attempt, AttemptState::Restored, terminal.clone())
            .await?;
        self.state.library_holds.wake(household_id);
        Ok(terminal)
    }

    /// Freshly re-read the exact authority and sealed profiles row while holding both library locks, then keep those
    /// locks through publication of the candidate's retirement marker. The client sends only opaque ciphertext and
    /// derived ids; completeness of the protected set remains its den-core-validated obligation.
    pub(crate) async fn conditionally_retire_candidate(
        &self,
        household_id: &str,
        household_token_hash: [u8; 32],
        candidate_token_hash: [u8; 32],
        request: RetirementRequest<'_>,
    ) -> Result<RetirementResult, MigrationError> {
        let RetirementRequest { attempt, source, authority, profiles_row, protected, candidate_id } = request;
        valid_attempt(attempt)?;
        if household_id == candidate_id
            || !super::valid_hex_id(household_id)
            || !super::valid_hex_id(candidate_id)
            || authority.kind == AuthorityKind::Corrupt
            || !protected.ids.contains(household_id)
            || protected.ids.contains(candidate_id)
            || protected.ids.iter().any(|id| !super::valid_hex_id(id))
        {
            return Err(MigrationError::ProtectedCandidate);
        }
        // Recovery takes this lock before any library lock too. Holding it prevents a recovery entry from being
        // created for the candidate after we establish that it is unreferenced and before its marker is published.
        let recovery = self.state.recovery_lock.lock().await;
        let household_slot = self.state.libraries.slot(household_id, self.state.now());
        let candidate_slot = self.state.libraries.slot(candidate_id, self.state.now());
        // Every cleanup uses raw-id order, so crossing cleanup requests cannot deadlock each other.
        let (mut household, mut candidate) = if household_id.as_bytes() < candidate_id.as_bytes() {
            let household = household_slot.library.lock().await;
            let candidate = candidate_slot.library.lock().await;
            (household, candidate)
        } else {
            let candidate = candidate_slot.library.lock().await;
            let household = household_slot.library.lock().await;
            (household, candidate)
        };
        let household_store = library_store_locked(
            self.state,
            household_id,
            household_token_hash,
            &household_slot,
            &mut household,
        )
        .await
        .map_err(|_| MigrationError::Forbidden)?
        .ok_or(MigrationError::NotFound)?;
        let read_store = Arc::clone(&household_store);
        let current =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
        let current_authority = RetirementAuthority {
            generation: current.protocol.migration_generation,
            base: current.protocol.head,
            head: authenticated_head(household_id, &current)?,
            kind: authority.kind,
        };
        if current_authority != *authority {
            return Err(MigrationError::FenceChanged);
        }
        // The attempt is server-owned durable authority, not a client assertion. In particular, an unchanged
        // legacy source is safe to clean up only after this exact split attempt reached the terminal Aborted state.
        // An abort cannot race a commit here: abort establishes its state while holding the same household lock.
        let cleanup_attempt =
            self.load_attempt(household_id, attempt).await?.ok_or(MigrationError::NotFound)?;
        if cleanup_attempt.household_id != household_id
            || cleanup_attempt.attempt != attempt
            || cleanup_attempt.purpose != AttemptPurpose::Split
            || cleanup_attempt.fence != *source
        {
            return Err(MigrationError::FenceChanged);
        }
        match authority.kind {
            AuthorityKind::Committed => {
                let expected = profiles_row.ok_or(MigrationError::Invalid("profiles row is absent"))?;
                let current_row = find_row(&current, &expected.key)?
                    .ok_or(MigrationError::Invalid("profiles row is absent"))?;
                if current_row.sequence != expected.sequence || current_row.value != expected.value {
                    return Err(MigrationError::FenceChanged);
                }
            }
            AuthorityKind::ChangedLegacy => {
                if profiles_row.is_some() {
                    return Err(MigrationError::Invalid("legacy authority has a profiles row"));
                }
                if current.protocol.migration_generation == source.generation
                    && current.protocol.head == source.base
                    && authenticated_head(household_id, &current)? == source.authenticated_head
                    && cleanup_attempt.state != AttemptState::Aborted
                {
                    return Err(MigrationError::SameLegacyFence);
                }
            }
            AuthorityKind::Corrupt => return Err(MigrationError::Invalid("household is corrupt")),
        }

        let (selected_v3, _) =
            match owned(self.state, &candidate_slot, &candidate, candidate_id, candidate_token_hash).await {
                Ok(owner) => owner,
                Err(response) if response.status() == axum::http::StatusCode::NOT_FOUND => {
                    return Ok(RetirementResult::Absent);
                }
                Err(response) if response.status() == axum::http::StatusCode::GONE => {
                    return Ok(RetirementResult::Absent);
                }
                Err(response) if response.status() == axum::http::StatusCode::FORBIDDEN => {
                    return Err(MigrationError::Forbidden);
                }
                Err(_) => {
                    return Err(MigrationError::Storage(io::Error::other("candidate ownership failed")))
                }
            };
        let response = retire_owned_locked(
            self.state,
            candidate_id,
            &candidate_slot,
            &mut candidate,
            selected_v3,
            None,
            recovery,
        )
        .await;
        if response.status().is_success() {
            Ok(RetirementResult::Retired)
        } else {
            Err(MigrationError::Storage(io::Error::other("candidate retirement failed")))
        }
    }

    #[cfg(test)]
    async fn locked_snapshot(
        &self,
        id: &str,
        token_hash: [u8; 32],
    ) -> Result<LibrarySnapshot, MigrationError> {
        let slot = self.state.libraries.slot(id, self.state.now());
        let mut library = slot.library.lock().await;
        if load_rewrite(self.state, id).await?.is_some() {
            return Err(MigrationError::Invalid("another rewrite is staged"));
        }
        let store = library_store_locked(self.state, id, token_hash, &slot, &mut library)
            .await
            .map_err(|_| MigrationError::Forbidden)?
            .ok_or(MigrationError::NotFound)?;
        let read_store = Arc::clone(&store);
        let snapshot =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
        Ok(snapshot)
    }

    async fn load_attempt(
        &self,
        household_id: &str,
        attempt: &str,
    ) -> Result<Option<DurableAttempt>, MigrationError> {
        let Some(bytes) = self.state.store.get_file(NS, &attempt_key(household_id, attempt), "json").await?
        else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|_| MigrationError::BackupCorrupt)
    }

    async fn authenticate_household(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
    ) -> Result<(), MigrationError> {
        let manager = Arc::clone(&self.state.library_v3);
        let household_id = household_id.to_owned();
        let credentials = tokio::task::spawn_blocking(move || manager.credentials(&household_id))
            .await
            .map_err(io::Error::other)??;
        match credentials {
            Some((stored, _)) if constant_time_eq(&stored, &token_hash) => Ok(()),
            Some(_) => Err(MigrationError::Forbidden),
            None => Err(MigrationError::NotFound),
        }
    }

    async fn save_attempt(&self, attempt: &DurableAttempt) -> Result<(), MigrationError> {
        let bytes = serde_json::to_vec(attempt).map_err(io::Error::other)?;
        self.state
            .store
            .replace_file(NS, &attempt_key(&attempt.household_id, &attempt.attempt), "json", &bytes)
            .await?;
        self.state.store.sync_dir(NS).await?;
        Ok(())
    }

    async fn set_attempt_terminal(
        &self,
        household_id: &str,
        attempt: &str,
        state: AttemptState,
        terminal: MigrationCommit,
    ) -> Result<(), MigrationError> {
        let mut durable = self
            .load_attempt(household_id, attempt)
            .await?
            .ok_or(MigrationError::Invalid("attempt is absent"))?;
        durable.state = state;
        durable.terminal = Some(terminal);
        self.save_attempt(&durable).await
    }

    async fn resolve_terminal(
        &self,
        household_id: &str,
        token_hash: [u8; 32],
        attempt: &mut DurableAttempt,
    ) -> Result<(), MigrationError> {
        if attempt.state != AttemptState::Open {
            return Ok(());
        }
        let store = self.state.library_v3.existing_library(household_id, token_hash)?;
        let abort_store = Arc::clone(&store);
        let abort_attempt = attempt.attempt.clone();
        let aborted =
            tokio::task::spawn_blocking(move || abort_store.exclusive_operation_aborted(&abort_attempt))
                .await
                .map_err(io::Error::other)??;
        if aborted {
            attempt.state = AttemptState::Aborted;
            self.save_attempt(attempt).await?;
            return Ok(());
        }
        let lookup_attempt = attempt.attempt.clone();
        let expected_generation = attempt.fence.generation;
        let winner =
            tokio::task::spawn_blocking(move || store.migration_result(&lookup_attempt, expected_generation))
                .await
                .map_err(io::Error::other)??;
        let Some(winner) = winner else {
            return Ok(());
        };
        attempt.state = if winner.attempt == attempt.attempt {
            match winner.kind {
                MigrationResultKind::Committed => AttemptState::Committed,
                MigrationResultKind::Restored => AttemptState::Restored,
            }
        } else {
            AttemptState::Superseded
        };
        attempt.terminal = Some(winner);
        self.save_attempt(attempt).await
    }

    async fn stage_rows(
        &self,
        household_id: &str,
        expected: &MigrationFence,
        backup: &BackupReference,
        rows: &[RewriteRow],
    ) -> Result<String, MigrationError> {
        let digest = staged_digest(rows)?;
        let bytes = serde_json::to_vec(&rows.iter().map(|row| (&row.key, &row.value)).collect::<Vec<_>>())
            .map_err(io::Error::other)?;
        let key = attempt_key(household_id, &backup.attempt);
        if let Some(existing) = self.state.store.get_file(NS, &key, STAGE_EXT).await? {
            if existing != bytes {
                return Err(MigrationError::Invalid("staged rows changed"));
            }
        } else {
            // The durable stage is bound to a verified immutable backup and the complete four-field fence.
            self.verify_backup(household_id, expected, backup).await?;
            self.state.store.replace_file(NS, &key, STAGE_EXT, &bytes).await?;
            self.state.store.sync_dir(NS).await?;
        }
        Ok(digest)
    }

    async fn load_staged_rows(
        &self,
        household_id: &str,
        attempt: &str,
    ) -> Result<(Vec<RewriteRow>, String), MigrationError> {
        let bytes = self
            .state
            .store
            .get_file(NS, &attempt_key(household_id, attempt), STAGE_EXT)
            .await?
            .ok_or(MigrationError::Invalid("staged rows are absent"))?;
        let pairs: Vec<(String, String)> =
            serde_json::from_slice(&bytes).map_err(|_| MigrationError::BackupCorrupt)?;
        let rows = pairs.into_iter().map(|(key, value)| RewriteRow { key, value }).collect::<Vec<_>>();
        let digest = staged_digest(&rows)?;
        Ok((rows, digest))
    }
}

fn snapshot_rows(snapshot: &LibrarySnapshot) -> Result<Vec<SnapshotRow>, MigrationError> {
    let mut rows = snapshot
        .rows
        .iter()
        .map(|stored| {
            let fragment: Fragment =
                serde_json::from_slice(&stored.fragment).map_err(|_| MigrationError::BackupCorrupt)?;
            if fragment.seq != stored.sequence {
                return Err(MigrationError::BackupCorrupt);
            }
            Ok(SnapshotRow { key: fragment.k, sequence: fragment.seq, value: fragment.v })
        })
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by(|left, right| left.key.as_bytes().cmp(right.key.as_bytes()));
    Ok(rows)
}

fn authenticated_head(library_id: &str, snapshot: &LibrarySnapshot) -> Result<String, MigrationError> {
    let rows = snapshot_rows(snapshot)?;
    let authority = SnapshotAuthority {
        library_id,
        migration_generation: snapshot.protocol.migration_generation,
        head: snapshot.protocol.head,
        wire_minimum: snapshot.protocol.wire_min,
        rows: &rows,
    };
    let bytes = canonical_json(&authority)?;
    Ok(hex_digest(&bytes))
}

fn backup_head(manifest: &BackupManifest) -> Result<String, MigrationError> {
    let authority = SnapshotAuthority {
        library_id: &manifest.household_id,
        migration_generation: manifest.source.generation,
        head: manifest.source.base,
        wire_minimum: manifest.wire_minimum,
        rows: &manifest.rows,
    };
    Ok(hex_digest(&canonical_json(&authority)?))
}

fn projected_head(
    library_id: &str,
    generation: u64,
    base: u64,
    wire_minimum: u64,
    rows: &[RewriteRow],
) -> Result<String, MigrationError> {
    let start =
        base.checked_sub(rows.len() as u64).ok_or(MigrationError::Invalid("invalid projected base"))?;
    let mut rows = rows
        .iter()
        .enumerate()
        .map(|(offset, row)| SnapshotRow {
            key: row.key.clone(),
            sequence: start + offset as u64 + 1,
            value: row.value.clone(),
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| left.key.as_bytes().cmp(right.key.as_bytes()));
    let authority = SnapshotAuthority {
        library_id,
        migration_generation: generation,
        head: base,
        wire_minimum,
        rows: &rows,
    };
    Ok(hex_digest(&canonical_json(&authority)?))
}

fn restored_head(
    library_id: &str,
    generation: u64,
    base: u64,
    wire_minimum: u64,
    rows: &[SnapshotRow],
) -> Result<String, MigrationError> {
    let authority =
        SnapshotAuthority { library_id, migration_generation: generation, head: base, wire_minimum, rows };
    Ok(hex_digest(&canonical_json(&authority)?))
}

fn valid_profiles_evidence(evidence: &ProfilesRowEvidence) -> bool {
    match (evidence.present, evidence.seq, evidence.digest.as_deref()) {
        (false, None, None) => true,
        (true, Some(sequence), Some(digest)) => sequence != 0 && valid_digest(digest),
        _ => false,
    }
}

fn profiles_evidence_matches(
    snapshot: &LibrarySnapshot,
    evidence: &ProfilesRowEvidence,
) -> Result<bool, MigrationError> {
    if !evidence.present {
        return Ok(true);
    }
    let Some(sequence) = evidence.seq else { return Ok(false) };
    let Some(expected) = evidence.digest.as_deref() else { return Ok(false) };
    Ok(snapshot_rows(snapshot)?.iter().find(|row| row.sequence == sequence).is_some_and(|row| {
        constant_time_eq(hex_digest(row.value.as_bytes()).as_bytes(), expected.as_bytes())
    }))
}

fn fence(
    library_id: &str,
    snapshot: &LibrarySnapshot,
    rewrite: String,
) -> Result<MigrationFence, MigrationError> {
    if snapshot.protocol.migration_generation > MAX_SAFE_INTEGER
        || snapshot.protocol.head > MAX_SAFE_INTEGER
        || snapshot.protocol.wire_min > MAX_SAFE_INTEGER
    {
        return Err(MigrationError::Invalid("migration fence exceeds the safe-integer range"));
    }
    Ok(MigrationFence {
        generation: snapshot.protocol.migration_generation,
        base: snapshot.protocol.head,
        authenticated_head: authenticated_head(library_id, snapshot)?,
        rewrite,
    })
}

pub(super) fn migration_source(
    library_id: &str,
    snapshot: &LibrarySnapshot,
) -> Result<MigrationSource, MigrationError> {
    let source = MigrationSource {
        generation: snapshot.protocol.migration_generation,
        head: authenticated_head(library_id, snapshot)?,
    };
    valid_source(&source)?;
    Ok(source)
}

fn source_from_fence(fence: &MigrationFence) -> MigrationSource {
    MigrationSource { generation: fence.generation, head: fence.authenticated_head.clone() }
}

fn valid_source(source: &MigrationSource) -> Result<(), MigrationError> {
    if source.generation <= MAX_SAFE_INTEGER && valid_digest(&source.head) {
        Ok(())
    } else {
        Err(MigrationError::Invalid("invalid migration source"))
    }
}

fn ensure_fence(
    library_id: &str,
    snapshot: &LibrarySnapshot,
    expected: &MigrationFence,
) -> Result<(), MigrationError> {
    if snapshot.protocol.migration_generation == expected.generation
        && snapshot.protocol.head == expected.base
        && authenticated_head(library_id, snapshot)? == expected.authenticated_head
    {
        Ok(())
    } else {
        Err(MigrationError::FenceChanged)
    }
}

fn find_row(snapshot: &LibrarySnapshot, key: &str) -> Result<Option<SnapshotRow>, MigrationError> {
    for row in snapshot_rows(snapshot)? {
        if row.key == key {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

fn valid_attempt(attempt: &str) -> Result<(), MigrationError> {
    if attempt.len() == 32
        && attempt.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(MigrationError::Invalid("invalid attempt"))
    }
}

fn valid_backup_rows(rows: &[SnapshotRow]) -> bool {
    let mut keys = HashSet::with_capacity(rows.len());
    let mut sequences = HashSet::with_capacity(rows.len());
    rows.iter().all(|row| {
        super::valid_hex_id(&row.key) && keys.insert(row.key.as_str()) && sequences.insert(row.sequence)
    })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// serde_json's value maps are ordered without the `preserve_order` feature. Round-tripping through `Value` sorts
/// every object recursively, yielding RFC 8785's representation for this integer/string-only schema.
fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, MigrationError> {
    let value = serde_json::to_value(value).map_err(io::Error::other)?;
    serde_json::to_vec(&value).map_err(io::Error::other).map_err(Into::into)
}

fn hex_digest(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

fn staged_digest(rows: &[RewriteRow]) -> Result<String, MigrationError> {
    let mut rows =
        rows.iter().map(|row| serde_json::json!({ "k": row.key, "v": row.value })).collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left["k"].as_str().unwrap().as_bytes().cmp(right["k"].as_str().unwrap().as_bytes())
    });
    let bytes = serde_json::to_vec(&rows).map_err(io::Error::other)?;
    Ok(hex_digest(&bytes))
}

fn attempt_key(household_id: &str, attempt: &str) -> String {
    format!("{household_id}:{attempt}")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequest {
    attempt: String,
    purpose: AttemptPurpose,
    #[serde(rename = "expectedSource")]
    expected_source: MigrationSource,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupInput {
    id: String,
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StageRequest {
    fence: MigrationFence,
    backup: BackupInput,
    writes: Vec<StageRow>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StageRow {
    k: String,
    v: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitRequest {
    fence: MigrationFence,
    backup: BackupInput,
    staged_digest: String,
    #[serde(rename = "wireMin")]
    wire_minimum: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetireRequest {
    source: MigrationFence,
    authority: RetirementAuthority,
    profiles_row: Option<SealedProfilesRow>,
    protected_library_ids: Vec<String>,
    candidate_library_id: String,
}

fn backup_reference(attempt: &str, input: BackupInput) -> BackupReference {
    BackupReference { attempt: attempt.to_owned(), id: input.id, digest: input.digest }
}

fn attempt_evidence(attempt: DurableAttempt) -> AttemptEvidence {
    AttemptEvidence {
        attempt: attempt.attempt,
        state: attempt.state,
        purpose: attempt.purpose,
        wire_minimum: attempt.wire_minimum,
        fence: attempt.fence,
        backup: attempt.backup,
        winner: attempt.terminal,
    }
}

fn attempt_json(evidence: AttemptEvidence) -> Value {
    let AttemptEvidence { attempt, state, purpose, wire_minimum, fence, backup, winner } = evidence;
    let mut answer = json!({
        "attempt": attempt,
        "state": state,
        "purpose": purpose,
        "wireMin": wire_minimum,
        "fence": fence,
    });
    if let Some(backup) = backup {
        answer["backup"] = json!(backup);
    }
    if let Some(terminal) = winner {
        let terminal_json = json!({
            "attempt": terminal.attempt,
            "state": terminal.kind,
            "generation": terminal.resulting_generation,
            "base": terminal.resulting_base,
            "head": terminal.resulting_head,
            "wireMin": terminal.wire_minimum,
            "backup": { "id": terminal.backup_id, "digest": terminal.backup_digest },
            "stagedDigest": terminal.staged_digest,
        });
        if terminal.attempt == attempt {
            // Successful commit/restore responses use den-spec's flat terminal shape. Keeping these fields at
            // the top level also lets a client resume from lookup without understanding an edge-only wrapper.
            answer["generation"] = terminal_json["generation"].clone();
            answer["base"] = terminal_json["base"].clone();
            answer["head"] = terminal_json["head"].clone();
            answer["wireMin"] = terminal_json["wireMin"].clone();
            answer["backup"] = terminal_json["backup"].clone();
            answer["stagedDigest"] = terminal_json["stagedDigest"].clone();
        } else {
            // A superseded attempt still needs to identify the durable winner that makes cleanup safe.
            answer["winner"] = terminal_json;
        }
    }
    answer
}

fn migration_error(error_value: MigrationError) -> Response {
    match error_value {
        MigrationError::Invalid("migration attempt mismatch")
        | MigrationError::Invalid("restore request changed")
        | MigrationError::Invalid("recovery attempt mismatch") => {
            json_reply(StatusCode::CONFLICT, &error("migration_attempt_mismatch"))
        }
        MigrationError::Invalid("another rewrite is staged") => {
            json_reply(StatusCode::CONFLICT, &error("rewrite_in_progress"))
        }
        MigrationError::Invalid("staged digest changed") => {
            json_reply(StatusCode::CONFLICT, &error("staged_digest_mismatch"))
        }
        MigrationError::InProgress => json_reply(StatusCode::CONFLICT, &error("migration_in_progress")),
        MigrationError::FenceChanged => json_reply(StatusCode::CONFLICT, &error("migration_fence_moved")),
        MigrationError::SourceChanged => json_reply(StatusCode::CONFLICT, &error("migration_source_changed")),
        MigrationError::BackupMissing => json_reply(StatusCode::NOT_FOUND, &error("backup_not_found")),
        MigrationError::BackupCorrupt => json_reply(StatusCode::CONFLICT, &error("backup_not_verified")),
        MigrationError::SameLegacyFence => json_reply(StatusCode::CONFLICT, &error("same_legacy_fence")),
        MigrationError::ProtectedCandidate => json_reply(StatusCode::CONFLICT, &error("protected_library")),
        MigrationError::NotFound => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
        MigrationError::Forbidden => json_reply(StatusCode::FORBIDDEN, &error("forbidden")),
        MigrationError::Invalid(_) => json_reply(StatusCode::BAD_REQUEST, &error("bad_request")),
        MigrationError::Storage(reason) => internal("profile migration", reason),
    }
}

async fn typed<T: for<'de> Deserialize<'de>>(request: Request, cap: usize) -> Result<T, Box<Response>> {
    let value = read_json(request, cap).await?;
    serde_json::from_value(value)
        .map_err(|_| Box::new(json_reply(StatusCode::BAD_REQUEST, &error("bad_request"))))
}

pub(crate) async fn handle(
    state: &AppState,
    household_id: &str,
    token_hash: [u8; 32],
    action: &str,
    request: Request,
) -> Response {
    let storage = ProfileMigrationStorage::new(state);
    if action == "profile-migration/source" {
        if request.method() != Method::GET {
            return crate::handler::method_not_allowed();
        }
        if axum::body::to_bytes(request.into_body(), 0).await.is_err() {
            return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
        }
        return match storage.observe_source(household_id, token_hash).await {
            Ok(source) => json_reply(StatusCode::OK, &json!({ "source": source })),
            Err(reason) => migration_error(reason),
        };
    }
    if action == "profile-migration" {
        if request.method() != Method::POST {
            return crate::handler::method_not_allowed();
        }
        let input: OpenRequest = match typed(request, BODY_BYTES).await {
            Ok(input) => input,
            Err(response) => return *response,
        };
        return match storage
            .open_attempt(
                &input.attempt,
                input.purpose,
                &input.expected_source,
                household_id,
                token_hash,
                input.purpose == AttemptPurpose::Restore
                    || state.profile_prepare_households.contains(household_id),
            )
            .await
        {
            Ok(evidence) => json_reply(StatusCode::OK, &attempt_json(evidence)),
            Err(reason) => migration_error(reason),
        };
    }

    let Some(rest) = action.strip_prefix("profile-migration/") else {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    };
    let mut segments = rest.split('/');
    let attempt = segments.next().unwrap_or_default();
    let operation = segments.next();
    if attempt.is_empty() || segments.next().is_some() {
        return json_reply(StatusCode::NOT_FOUND, &error("not_found"));
    }

    match (operation, request.method().clone()) {
        (None, Method::GET) => match storage.lookup_attempt(household_id, token_hash, attempt).await {
            Ok(evidence) => json_reply(StatusCode::OK, &attempt_json(evidence)),
            Err(reason) => migration_error(reason),
        },
        (None, Method::DELETE) => match storage.abort_attempt(household_id, token_hash, attempt).await {
            Ok(evidence) => json_reply(StatusCode::OK, &attempt_json(evidence)),
            Err(reason) => migration_error(reason),
        },
        (Some("backup"), Method::POST) => {
            if axum::body::to_bytes(request.into_body(), 0).await.is_err() {
                return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
            }
            let evidence = match storage.lookup_attempt(household_id, token_hash, attempt).await {
                Ok(evidence) => evidence,
                Err(reason) => return migration_error(reason),
            };
            match storage.create_verified_backup(attempt, household_id, token_hash, &evidence.fence).await {
                Ok(reference) => match storage.load_backup_for_restore(household_id, &reference).await {
                    Ok(manifest) => json_reply(
                        StatusCode::OK,
                        &json!({ "id": reference.id, "digest": reference.digest, "source": manifest.source }),
                    ),
                    Err(reason) => migration_error(reason),
                },
                Err(reason) => migration_error(reason),
            }
        }
        (Some("backup"), Method::GET) => {
            if let Err(reason) = storage.lookup_attempt(household_id, token_hash, attempt).await {
                return migration_error(reason);
            }
            let reference = match storage.backup_reference(household_id, attempt).await {
                Ok(reference) => reference,
                Err(reason) => return migration_error(reason),
            };
            match storage.verified_backup_json(household_id, &reference).await {
                Ok(backup) => json_reply(StatusCode::OK, &backup),
                Err(reason) => migration_error(reason),
            }
        }
        (Some("rows"), Method::POST) => {
            let input: StageRequest = match typed(request, super::BATCH_MAX_BODY_BYTES).await {
                Ok(input) => input,
                Err(response) => return *response,
            };
            let backup = backup_reference(attempt, input.backup);
            let rows = input
                .writes
                .into_iter()
                .map(|row| RewriteRow { key: row.k, value: row.v })
                .collect::<Vec<_>>();
            match storage.stage_household_rows(household_id, token_hash, &input.fence, &backup, &rows).await {
                Ok(digest) => json_reply(StatusCode::OK, &json!({ "stagedDigest": digest })),
                Err(reason) => migration_error(reason),
            }
        }
        (Some("commit"), Method::POST) => {
            let input: CommitRequest = match typed(request, BODY_BYTES).await {
                Ok(input) => input,
                Err(response) => return *response,
            };
            if input.wire_minimum != PROFILE_WIRE_MINIMUM || !valid_digest(&input.staged_digest) {
                return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
            }
            let backup = backup_reference(attempt, input.backup);
            match storage
                .commit_household(household_id, token_hash, &input.fence, &backup, &input.staged_digest)
                .await
            {
                Ok(_) => match storage.lookup_attempt(household_id, token_hash, attempt).await {
                    Ok(evidence) => json_reply(StatusCode::OK, &attempt_json(evidence)),
                    Err(reason) => migration_error(reason),
                },
                Err(reason) => migration_error(reason),
            }
        }
        (Some("restore"), Method::POST) => {
            let input: RestoreRequest = match typed(request, BODY_BYTES).await {
                Ok(input) => input,
                Err(response) => return *response,
            };
            match storage.restore_backup(attempt, household_id, token_hash, &input).await {
                Ok(_) => match storage.lookup_attempt(household_id, token_hash, attempt).await {
                    Ok(evidence) => json_reply(StatusCode::OK, &attempt_json(evidence)),
                    Err(reason) => migration_error(reason),
                },
                Err(reason) => migration_error(reason),
            }
        }
        (Some("retire-candidate"), Method::POST) => {
            let candidate = match request
                .headers()
                .get("x-den-candidate-library-token")
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty() && value.len() <= 256)
            {
                Some(candidate) => candidate.to_owned(),
                None => return json_reply(StatusCode::UNAUTHORIZED, &error("missing_candidate_token")),
            };
            let input: RetireRequest = match typed(request, BODY_BYTES).await {
                Ok(input) => input,
                Err(response) => return *response,
            };
            let evidence = match storage.lookup_attempt(household_id, token_hash, attempt).await {
                Ok(evidence) => evidence,
                Err(reason) => return migration_error(reason),
            };
            if evidence.fence != input.source || input.protected_library_ids.len() > 64 {
                return json_reply(StatusCode::CONFLICT, &error("migration_fence_moved"));
            }
            let protected_count = input.protected_library_ids.len();
            let ids = input.protected_library_ids.into_iter().collect::<HashSet<_>>();
            if ids.len() != protected_count {
                return json_reply(StatusCode::BAD_REQUEST, &error("bad_request"));
            }
            let protected = ProtectedLibraries { ids };
            let candidate_hash: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
            match storage
                .conditionally_retire_candidate(
                    household_id,
                    token_hash,
                    candidate_hash,
                    RetirementRequest {
                        attempt,
                        source: &input.source,
                        authority: &input.authority,
                        profiles_row: input.profiles_row.as_ref(),
                        protected: &protected,
                        candidate_id: &input.candidate_library_id,
                    },
                )
                .await
            {
                Ok(RetirementResult::Retired) => json_reply(StatusCode::OK, &json!({ "result": "retired" })),
                Ok(RetirementResult::Absent) => json_reply(StatusCode::OK, &json!({ "result": "absent" })),
                Err(reason) => migration_error(reason),
            }
        }
        (Some("backup"), _) | (Some("rows" | "commit" | "restore" | "retire-candidate"), _) | (None, _) => {
            crate::handler::method_not_allowed()
        }
        _ => json_reply(StatusCode::NOT_FOUND, &error("not_found")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::{body_json, Harness};
    use axum::http::StatusCode;
    use serde_json::json;

    const HOUSEHOLD: &str = "0123456789abcdef0123456789abcdef";
    const CANDIDATE: &str = "fedcba9876543210fedcba9876543210";
    const HOUSEHOLD_TOKEN: &str = "household-key";
    const CANDIDATE_TOKEN: &str = "candidate-key";
    const ACTIVITY: &str = "aaaaaaaaaaaaaaaa";
    const CONFIG: &str = "bbbbbbbbbbbbbbbb";
    const DIRECTORY: &str = "cccccccccccccccc";
    const DELIVERY: &str = "dddddddddddddddd";
    const ATTEMPT: &str = "11111111111111111111111111111111";
    const ATTEMPT2: &str = "22222222222222222222222222222222";
    const ATTEMPT3: &str = "33333333333333333333333333333333";

    fn token(value: &str) -> [u8; 32] {
        Sha256::digest(value.as_bytes()).into()
    }

    async fn write(h: &Harness, id: &str, key: &str, base: u64, value: &str, token: &str) -> StatusCode {
        h.send(
            "POST",
            &format!("/lib/{id}/batch"),
            Some(json!({ "writes": [{ "k": key, "base": base, "v": value }] }).to_string()),
            &[("x-den-library-token", token)],
        )
        .await
        .status()
    }

    async fn migration_request(
        h: &Harness,
        method: &str,
        path: &str,
        body: Option<String>,
        token_value: Option<&str>,
    ) -> Response {
        let mut headers = vec![("x-den-wire", "5")];
        if let Some(token_value) = token_value {
            headers.push(("x-den-library-token", token_value));
        }
        h.send(method, path, body, &headers).await
    }

    async fn open_body(
        h: &Harness,
        household_id: &str,
        token_value: &str,
        attempt: &str,
        purpose: &str,
    ) -> String {
        let source = ProfileMigrationStorage::new(&h.state)
            .observe_source(household_id, token(token_value))
            .await
            .unwrap();
        json!({ "attempt": attempt, "purpose": purpose, "expectedSource": source }).to_string()
    }

    async fn assert_disabled(response: Response) {
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(response).await, json!({ "error": "not_found" }));
    }

    fn row_values(value: &Value, field: &str) -> std::collections::BTreeMap<String, String> {
        value[field]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| (row["k"].as_str().unwrap().to_owned(), row["v"].as_str().unwrap().to_owned()))
            .collect()
    }

    #[tokio::test]
    async fn disabled_adapter_is_uniformly_unreachable_before_global_routing() {
        let h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
            state.web_origins = vec!["https://app.example".into()];
        });
        assert_eq!(
            write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await,
            StatusCode::OK
        );
        let storage = ProfileMigrationStorage::new(&h.state);
        let before = storage.locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let attempt = format!("{base}/{ATTEMPT}");
        let routes = [
            (base, "POST"),
            (format!("/lib/{HOUSEHOLD}/profile-migration/source"), "GET"),
            (attempt.clone(), "GET"),
            (format!("{attempt}/backup"), "POST"),
            (format!("{attempt}/rows"), "POST"),
            (format!("{attempt}/commit"), "POST"),
            (format!("{attempt}/restore"), "POST"),
            (format!("{attempt}/retire-candidate"), "POST"),
        ];

        for (path, correct_method) in &routes {
            for method in [*correct_method, "PATCH"] {
                assert_disabled(
                    h.send(
                        method,
                        path,
                        Some("{}".into()),
                        &[("x-den-wire", "5"), ("x-den-library-token", HOUSEHOLD_TOKEN)],
                    )
                    .await,
                )
                .await;
            }

            assert_disabled(
                h.send(
                    correct_method,
                    path,
                    Some("{}".into()),
                    &[("content-length", "18446744073709551615")],
                )
                .await,
            )
            .await;

            let preflight = h
                .send(
                    "OPTIONS",
                    path,
                    None,
                    &[
                        ("origin", "https://app.example"),
                        ("access-control-request-method", correct_method),
                        ("access-control-request-headers", "x-den-candidate-library-token"),
                    ],
                )
                .await;
            assert!(!preflight.headers().contains_key("access-control-allow-methods"));
            assert!(!preflight.headers().contains_key("access-control-allow-headers"));
            assert_disabled(preflight).await;
        }

        let after = storage.locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert_eq!(after, before, "a disabled route may not mutate the household");
        assert!(storage.load_attempt(HOUSEHOLD, ATTEMPT).await.unwrap().is_none());
        for extension in ["json", BACKUP_EXT, STAGE_EXT] {
            assert!(
                h.state
                    .store
                    .get_file(NS, &attempt_key(HOUSEHOLD, ATTEMPT), extension)
                    .await
                    .unwrap()
                    .is_none(),
                "a disabled route created {extension} state"
            );
        }
        assert!(
            !h.state.metrics.render().contains("profile-migration"),
            "disabled route names must not become metric labels"
        );
    }

    #[tokio::test]
    async fn unenrolled_legacy_household_is_uniformly_absent_while_an_enrolled_neighbor_prepares() {
        let mut h = Harness::in_dir_with(crate::handler::tests::temp_dir(), |state| {
            state.web_origins = vec!["https://app.example".into()];
        });
        write(&h, HOUSEHOLD, ACTIVITY, 0, "enrolled", HOUSEHOLD_TOKEN).await;
        write(&h, CANDIDATE, ACTIVITY, 0, "off", CANDIDATE_TOKEN).await;
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.profile_migration_enabled = true;
        state.profile_prepare_households.insert(HOUSEHOLD.to_owned());

        let enrolled = format!("/lib/{HOUSEHOLD}/profile-migration");
        let off = format!("/lib/{CANDIDATE}/profile-migration");
        let body = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await;
        assert_eq!(
            migration_request(&h, "POST", &enrolled, Some(body), Some(HOUSEHOLD_TOKEN)).await.status(),
            StatusCode::OK
        );
        for method in ["POST", "PATCH"] {
            assert_disabled(
                h.send(
                    method,
                    &off,
                    Some("{}".into()),
                    &[("x-den-wire", "5"), ("x-den-library-token", CANDIDATE_TOKEN)],
                )
                .await,
            )
            .await;
        }
        assert_disabled(
            h.send(
                "GET",
                &format!("{off}/source"),
                None,
                &[("x-den-wire", "5"), ("x-den-library-token", CANDIDATE_TOKEN)],
            )
            .await,
        )
        .await;
        assert_disabled(
            h.send("POST", &off, Some("{}".into()), &[("content-length", "18446744073709551615")]).await,
        )
        .await;
        let preflight = h
            .send(
                "OPTIONS",
                &off,
                None,
                &[
                    ("origin", "https://app.example"),
                    ("access-control-request-method", "POST"),
                    ("access-control-request-headers", "x-den-candidate-library-token"),
                ],
            )
            .await;
        assert!(!preflight.headers().contains_key("access-control-allow-methods"));
        assert_disabled(preflight).await;
    }

    #[tokio::test]
    async fn household_capability_reports_transport_inputs_not_runtime_and_requires_wire_five_auth() {
        let mut h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "enrolled", HOUSEHOLD_TOKEN).await;
        write(&h, CANDIDATE, ACTIVITY, 0, "off", CANDIDATE_TOKEN).await;
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.profile_migration_enabled = true;
        state.profile_prepare_households.insert(HOUSEHOLD.to_owned());

        let enrolled = format!("/lib/{HOUSEHOLD}/profile-capability");
        let off = format!("/lib/{CANDIDATE}/profile-capability");
        let prepared = body_json(
            h.send("GET", &enrolled, None, &[("x-den-wire", "5"), ("x-den-library-token", HOUSEHOLD_TOKEN)])
                .await,
        )
        .await;
        assert_eq!(
            prepared,
            json!({
                "enrollment": "prepare", "wireMin": 2, "migrationWire": 5,
                "runtimeHouseholdWire": 5, "runtimeProfileWire": 4,
            })
        );
        assert!(prepared.get("runtime").is_none(), "edge cannot validate an encrypted directory");
        assert_eq!(
            body_json(
                h.send("GET", &off, None, &[("x-den-wire", "5"), ("x-den-library-token", CANDIDATE_TOKEN)],)
                    .await,
            )
            .await["enrollment"],
            "off"
        );
        assert_eq!(
            h.send("GET", &enrolled, None, &[("x-den-wire", "5"), ("x-den-library-token", "wrong")],)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            h.send("GET", &enrolled, None, &[("x-den-wire", "5")]).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            h.send("GET", &enrolled, None, &[("x-den-wire", "4"), ("x-den-library-token", HOUSEHOLD_TOKEN)],)
                .await
                .status(),
            StatusCode::UPGRADE_REQUIRED
        );

        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = false;
        assert_eq!(
            body_json(
                h.send(
                    "GET",
                    &enrolled,
                    None,
                    &[("x-den-wire", "5"), ("x-den-library-token", HOUSEHOLD_TOKEN)],
                )
                .await,
            )
            .await["enrollment"],
            "off"
        );
    }

    #[tokio::test]
    async fn source_observation_and_open_bind_pre_pin_authority_without_race_side_effects() {
        let mut h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "before-pin", HOUSEHOLD_TOKEN).await;
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.profile_migration_enabled = true;
        state.profile_prepare_households.insert(HOUSEHOLD.to_owned());
        let source_path = format!("/lib/{HOUSEHOLD}/profile-migration/source");
        let open_path = format!("/lib/{HOUSEHOLD}/profile-migration");

        for (wire, token_value, status) in [
            ("4", Some(HOUSEHOLD_TOKEN), StatusCode::UPGRADE_REQUIRED),
            ("5", None, StatusCode::UNAUTHORIZED),
            ("5", Some("wrong"), StatusCode::FORBIDDEN),
        ] {
            assert_eq!(
                h.send(
                    "GET",
                    &source_path,
                    None,
                    &[("x-den-wire", wire), ("x-den-library-token", token_value.unwrap_or("")),],
                )
                .await
                .status(),
                status
            );
        }
        assert_eq!(
            migration_request(&h, "GET", &source_path, Some("{}".into()), Some(HOUSEHOLD_TOKEN),)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let observed_response = migration_request(&h, "GET", &source_path, None, Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(observed_response.status(), StatusCode::OK);
        assert_eq!(observed_response.headers().get("cache-control").unwrap(), "no-store");
        let observed = body_json(observed_response).await;
        assert_eq!(observed.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["source"]);
        assert!(observed["source"]["generation"].as_u64().is_some());
        assert!(valid_digest(observed["source"]["head"].as_str().unwrap()));
        assert!(ProfileMigrationStorage::new(&h.state)
            .load_attempt(HOUSEHOLD, ATTEMPT)
            .await
            .unwrap()
            .is_none());

        let different_head = if observed["source"]["head"].as_str().unwrap().starts_with('a') {
            "b".repeat(64)
        } else {
            "a".repeat(64)
        };
        let same_generation_other_head = json!({
            "attempt": ATTEMPT2,
            "purpose": "split",
            "expectedSource": {
                "generation": observed["source"]["generation"],
                "head": different_head,
            },
        })
        .to_string();
        let changed_head = migration_request(
            &h,
            "POST",
            &open_path,
            Some(same_generation_other_head),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(changed_head.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(changed_head).await, json!({ "error": "migration_source_changed" }));
        assert!(ProfileMigrationStorage::new(&h.state)
            .load_attempt(HOUSEHOLD, ATTEMPT2)
            .await
            .unwrap()
            .is_none());

        // A normal household write between the pre-PIN observation and POST open changes the authenticated head
        // without advancing the dedicated migration generation. The stale consent must create nothing.
        assert_eq!(write(&h, HOUSEHOLD, ACTIVITY, 1, "after-pin", HOUSEHOLD_TOKEN).await, StatusCode::OK);
        let stale = json!({
            "attempt": ATTEMPT,
            "purpose": "split",
            "expectedSource": observed["source"].clone(),
        })
        .to_string();
        let raced = migration_request(&h, "POST", &open_path, Some(stale), Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(raced.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(raced).await, json!({ "error": "migration_source_changed" }));
        let storage = ProfileMigrationStorage::new(&h.state);
        assert!(storage.load_attempt(HOUSEHOLD, ATTEMPT).await.unwrap().is_none());
        for extension in ["json", BACKUP_EXT, STAGE_EXT] {
            assert!(h
                .state
                .store
                .get_file(NS, &attempt_key(HOUSEHOLD, ATTEMPT), extension)
                .await
                .unwrap()
                .is_none());
        }

        let current =
            body_json(migration_request(&h, "GET", &source_path, None, Some(HOUSEHOLD_TOKEN)).await).await;
        assert_ne!(
            current["source"]["generation"], observed["source"]["generation"],
            "visible row writes advance the migration generation"
        );
        assert_ne!(current["source"]["head"], observed["source"]["head"]);
        let exact = json!({
            "attempt": ATTEMPT,
            "purpose": "split",
            "expectedSource": current["source"].clone(),
        })
        .to_string();
        assert_eq!(
            migration_request(&h, "POST", &open_path, Some(exact.clone()), Some(HOUSEHOLD_TOKEN))
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            write(&h, HOUSEHOLD, ACTIVITY, 2, "after-open", HOUSEHOLD_TOKEN).await,
            StatusCode::CONFLICT,
            "an opened migration exclusively owns household mutation"
        );
        super::super::save_rewrite(
            &h.state,
            HOUSEHOLD,
            &super::super::RewriteStage {
                id: "unavailable-current-source".into(),
                base: 2,
                touched: h.state.now(),
                rows: Vec::new(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            migration_request(&h, "POST", &open_path, Some(exact.clone()), Some(HOUSEHOLD_TOKEN))
                .await
                .status(),
            StatusCode::OK,
            "an exact existing attempt replay is lookup-first even when current source is unavailable"
        );
        h.state
            .store
            .delete_file(super::super::REWRITE_NS, HOUSEHOLD, super::super::REWRITE_EXT)
            .await
            .unwrap();
        h.state.store.sync_dir(super::super::REWRITE_NS).await.unwrap();
        let purpose_changed = json!({
            "attempt": ATTEMPT,
            "purpose": "restore",
            "expectedSource": current["source"].clone(),
        })
        .to_string();
        let purpose_response =
            migration_request(&h, "POST", &open_path, Some(purpose_changed), Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(purpose_response.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(purpose_response).await, json!({ "error": "migration_attempt_mismatch" }));
        let changed_replay = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await;
        let response =
            migration_request(&h, "POST", &open_path, Some(changed_replay), Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(response.status(), StatusCode::OK, "the owning attempt resumes with the unchanged source");

        let missing = json!({ "attempt": ATTEMPT2, "purpose": "split" }).to_string();
        assert_eq!(
            migration_request(&h, "POST", &open_path, Some(missing), Some(HOUSEHOLD_TOKEN)).await.status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn wire_five_recovery_observation_survives_prepare_off_but_cannot_start_a_new_split() {
        let mut h = Harness::new();
        let created = h
            .send(
                "POST",
                &format!("/lib/{HOUSEHOLD}/batch"),
                Some(json!({ "writes": [{ "k": ACTIVITY, "base": 0, "v": "wire-five" }] }).to_string()),
                &[
                    ("x-den-wire", "5"),
                    ("x-den-wire-min", "5"),
                    ("x-den-generation", "0"),
                    ("x-den-library-token", HOUSEHOLD_TOKEN),
                ],
            )
            .await;
        assert_eq!(created.status(), StatusCode::OK);
        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = true;
        let source_path = format!("/lib/{HOUSEHOLD}/profile-migration/source");
        let open_path = format!("/lib/{HOUSEHOLD}/profile-migration");
        let observed =
            body_json(migration_request(&h, "GET", &source_path, None, Some(HOUSEHOLD_TOKEN)).await).await;
        let restore = json!({
            "attempt": ATTEMPT3,
            "purpose": "restore",
            "expectedSource": observed["source"].clone(),
        })
        .to_string();
        let restored_open =
            migration_request(&h, "POST", &open_path, Some(restore), Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(restored_open.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(restored_open).await, json!({ "error": "migration_in_progress" }));
        assert!(
            ProfileMigrationStorage::new(&h.state).load_attempt(HOUSEHOLD, ATTEMPT3).await.unwrap().is_none(),
            "restore cannot open without a server-verified bound backup"
        );

        let split = json!({
            "attempt": ATTEMPT,
            "purpose": "split",
            "expectedSource": observed["source"].clone(),
        })
        .to_string();
        let refused = migration_request(&h, "POST", &open_path, Some(split), Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(refused.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(refused).await, json!({ "error": "not_found" }));
        assert!(ProfileMigrationStorage::new(&h.state)
            .load_attempt(HOUSEHOLD, ATTEMPT)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn migration_transport_uses_exact_wire_five_and_newer_household_minimum_wins() {
        let mut h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.profile_migration_enabled = true;
        state.profile_prepare_households.insert(HOUSEHOLD.to_owned());
        let path = format!("/lib/{HOUSEHOLD}/profile-migration");
        let body = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await;
        for wire in ["4", "6"] {
            let response = h
                .send(
                    "POST",
                    &path,
                    Some(body.clone()),
                    &[("x-den-wire", wire), ("x-den-library-token", HOUSEHOLD_TOKEN)],
                )
                .await;
            assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED, "wire {wire}");
            assert_eq!(body_json(response).await["min"], 5, "wire {wire}");
        }

        let newer = "99999999999999999999999999999999";
        let created = h
            .send(
                "POST",
                &format!("/lib/{newer}/batch"),
                Some(json!({ "writes": [{ "k": ACTIVITY, "base": 0, "v": "newer" }] }).to_string()),
                &[
                    ("x-den-wire", "6"),
                    ("x-den-wire-min", "6"),
                    ("x-den-generation", "0"),
                    ("x-den-library-token", CANDIDATE_TOKEN),
                ],
            )
            .await;
        assert_eq!(created.status(), StatusCode::OK);
        for wire in ["5", "6"] {
            let response = h
                .send(
                    "POST",
                    &format!("/lib/{newer}/profile-migration"),
                    Some(body.clone()),
                    &[("x-den-wire", wire), ("x-den-library-token", CANDIDATE_TOKEN)],
                )
                .await;
            assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED, "wire {wire}");
            assert_eq!(body_json(response).await["min"], 6, "wire {wire}");
        }
    }

    #[tokio::test]
    async fn http_adapter_is_default_off_wire_five_authenticated_and_restart_durable() {
        let mut h = Harness::new();
        let dir = h.dir.clone();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let initial_open = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await;

        assert_eq!(
            migration_request(&h, "POST", &base, Some(initial_open.clone()), Some(HOUSEHOLD_TOKEN))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = true;
        Arc::get_mut(&mut h.state).unwrap().profile_prepare_households.insert(HOUSEHOLD.to_owned());
        assert_eq!(
            h.send("POST", &base, Some(initial_open.clone()), &[("x-den-library-token", HOUSEHOLD_TOKEN)],)
                .await
                .status(),
            StatusCode::UPGRADE_REQUIRED
        );
        assert_eq!(
            migration_request(&h, "POST", &base, Some(initial_open.clone()), None).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            migration_request(&h, "POST", &base, Some(initial_open.clone()), Some("wrong")).await.status(),
            StatusCode::FORBIDDEN
        );
        let opened =
            body_json(migration_request(&h, "POST", &base, Some(initial_open), Some(HOUSEHOLD_TOKEN)).await)
                .await;
        assert_eq!(opened["state"], "open");
        assert_eq!(opened["purpose"], "split");

        let attempt_path = format!("{base}/{ATTEMPT}");
        let backup = body_json(
            migration_request(&h, "POST", &format!("{attempt_path}/backup"), None, Some(HOUSEHOLD_TOKEN))
                .await,
        )
        .await;
        assert!(valid_digest(backup["digest"].as_str().unwrap()));
        let artifact = body_json(
            migration_request(&h, "GET", &format!("{attempt_path}/backup"), None, Some(HOUSEHOLD_TOKEN))
                .await,
        )
        .await;
        assert_eq!(artifact["digest"], backup["digest"]);
        assert_eq!(artifact["rows"][0]["v"], "sealed-activity");

        let writes = json!([
            { "k": CONFIG, "v": "household-configuration" },
            { "k": DIRECTORY, "v": "sealed-directory" },
        ]);
        let staged = body_json(
            migration_request(
                &h,
                "POST",
                &format!("{attempt_path}/rows"),
                Some(
                    json!({
                        "fence": opened["fence"],
                        "backup": { "id": backup["id"], "digest": backup["digest"] },
                        "writes": writes,
                    })
                    .to_string(),
                ),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        assert!(valid_digest(staged["stagedDigest"].as_str().unwrap()));
        let committed = body_json(
            migration_request(
                &h,
                "POST",
                &format!("{attempt_path}/commit"),
                Some(
                    json!({
                        "fence": opened["fence"],
                        "backup": { "id": backup["id"], "digest": backup["digest"] },
                        "stagedDigest": staged["stagedDigest"],
                        "wireMin": 5,
                    })
                    .to_string(),
                ),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        assert_eq!(committed["state"], "committed");
        assert_eq!(
            committed["generation"].as_u64(),
            opened["fence"]["generation"].as_u64().map(|generation| generation + 1)
        );
        assert_eq!(committed["backup"]["id"], backup["id"]);
        drop(h);

        let mut restarted = Harness::in_dir(dir);
        Arc::get_mut(&mut restarted.state).unwrap().profile_migration_enabled = true;
        let looked_up =
            body_json(migration_request(&restarted, "GET", &attempt_path, None, Some(HOUSEHOLD_TOKEN)).await)
                .await;
        assert_eq!(looked_up["state"], "committed");
        assert_eq!(looked_up["stagedDigest"], staged["stagedDigest"]);

        let recovery = body_json(
            migration_request(
                &restarted,
                "POST",
                &base,
                Some(open_body(&restarted, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT3, "restore").await),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        let current = ProfileMigrationStorage::new(&restarted.state)
            .locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
            .await
            .unwrap();
        let profiles = find_row(&current, DIRECTORY).unwrap().unwrap();
        let restore_body = json!({
            "backup": { "attempt": ATTEMPT, "id": backup["id"], "digest": backup["digest"] },
            "fence": recovery["fence"],
            "wireMin": recovery["wireMin"],
            "profilesRow": {
                "present": true,
                "seq": profiles.sequence,
                "digest": hex_digest(profiles.value.as_bytes()),
            },
            "directoryState": "invalid",
            "plannerDecision": "restore-backup",
        })
        .to_string();
        let restore_path = format!("{base}/{ATTEMPT3}/restore");
        for _ in 0..2 {
            let restored = body_json(
                migration_request(
                    &restarted,
                    "POST",
                    &restore_path,
                    Some(restore_body.clone()),
                    Some(HOUSEHOLD_TOKEN),
                )
                .await,
            )
            .await;
            assert_eq!(restored["state"], "restored");
            assert_eq!(restored["attempt"], ATTEMPT3);
            assert_eq!(restored["backup"]["id"], backup["id"]);
        }
        let original =
            body_json(migration_request(&restarted, "GET", &attempt_path, None, Some(HOUSEHOLD_TOKEN)).await)
                .await;
        assert_eq!(original["state"], "committed", "restore retains the earlier terminal");

        Arc::get_mut(&mut restarted.state).unwrap().profile_migration_enabled = false;
        assert_disabled(
            migration_request(&restarted, "GET", &attempt_path, None, Some(HOUSEHOLD_TOKEN)).await,
        )
        .await;

        let unknown = format!("/lib/{CANDIDATE}/profile-migration");
        assert_eq!(
            migration_request(
                &restarted,
                "POST",
                &unknown,
                Some(
                    json!({
                        "attempt": ATTEMPT2,
                        "purpose": "split",
                        "expectedSource": { "generation": 0, "head": "0".repeat(64) },
                    })
                    .to_string(),
                ),
                Some(CANDIDATE_TOKEN),
            )
            .await
            .status(),
            StatusCode::NOT_FOUND,
            "opening a migration must never auto-start a library"
        );
    }

    fn rehearsal_rows() -> std::collections::BTreeMap<String, String> {
        std::collections::BTreeMap::from([
            (ACTIVITY.to_owned(), "synthetic-owner-activity".to_owned()),
            (CONFIG.to_owned(), "synthetic-household-config".to_owned()),
            (DELIVERY.to_owned(), "synthetic-delivery-state".to_owned()),
        ])
    }

    /// A wire-4 household with synthetic rows and the migration adapter switched on, over the real router and
    /// redb stores in the Harness's temporary directory.
    async fn rehearsal_household() -> Harness {
        let mut h = Harness::new();
        let created = h
            .send(
                "POST",
                &format!("/lib/{HOUSEHOLD}/batch"),
                Some(
                    json!({
                        "writes": [
                            { "k": ACTIVITY, "base": 0, "v": "synthetic-owner-activity" },
                            { "k": CONFIG, "base": 0, "v": "synthetic-household-config" },
                            { "k": DELIVERY, "base": 0, "v": "synthetic-delivery-state" },
                        ],
                    })
                    .to_string(),
                ),
                &[
                    ("x-den-wire", "4"),
                    ("x-den-wire-min", "4"),
                    ("x-den-generation", "0"),
                    ("x-den-library-token", HOUSEHOLD_TOKEN),
                ],
            )
            .await;
        assert_eq!(created.status(), StatusCode::OK);
        assert_eq!(created.headers()["x-den-wire-min"], "4");
        let state = Arc::get_mut(&mut h.state).unwrap();
        state.profile_migration_enabled = true;
        state.profile_prepare_households.insert(HOUSEHOLD.to_owned());
        h
    }

    async fn rehearsal_open(h: &Harness, attempt: &str, purpose: &str) -> Response {
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        migration_request(
            h,
            "POST",
            &base,
            Some(open_body(h, HOUSEHOLD, HOUSEHOLD_TOKEN, attempt, purpose).await),
            Some(HOUSEHOLD_TOKEN),
        )
        .await
    }

    async fn household_changes(h: &Harness, wire: &str) -> Response {
        h.send(
            "GET",
            &format!("/lib/{HOUSEHOLD}/changes"),
            None,
            &[("x-den-wire", wire), ("x-den-library-token", HOUSEHOLD_TOKEN)],
        )
        .await
    }

    /// Single exclusive attempt, end to end: open (backup bound), copy Owner rows into a real candidate library,
    /// every competitor and ordinary write refused while locked, stage, commit with the response discarded,
    /// recover by lookup, then the lock is released and wire 5 is enforced. All ids, credentials and row values
    /// are fresh synthetic constants scoped to the temporary Harness directory. Dropping the commit response
    /// models the only part outside the in-process server: a client losing a response the server committed.
    #[tokio::test]
    async fn synthetic_server_rehearsal_runs_one_exclusive_split_with_a_lost_commit_response() {
        let h = rehearsal_household().await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let attempt_path = format!("{base}/{ATTEMPT}");

        let opened = body_json(rehearsal_open(&h, ATTEMPT, "split").await).await;
        assert_eq!(opened["state"], "open");
        let backup = opened["backup"].clone();
        assert_eq!(backup["attempt"], ATTEMPT);
        let artifact = body_json(
            migration_request(&h, "GET", &format!("{attempt_path}/backup"), None, Some(HOUSEHOLD_TOKEN))
                .await,
        )
        .await;
        assert_eq!(artifact["digest"], backup["digest"]);
        assert_eq!(row_values(&artifact, "rows"), rehearsal_rows());

        // Copy the Owner's rows from the bound backup into a real candidate library and read them back over
        // the normal wire-4 API before the household is touched.
        let copied = artifact["rows"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["k"] == ACTIVITY || row["k"] == DELIVERY)
            .map(|row| json!({ "k": row["k"], "base": 0, "v": row["v"] }))
            .collect::<Vec<_>>();
        let created = h
            .send(
                "POST",
                &format!("/lib/{CANDIDATE}/batch"),
                Some(json!({ "writes": copied }).to_string()),
                &[
                    ("x-den-wire", "4"),
                    ("x-den-wire-min", "4"),
                    ("x-den-generation", "0"),
                    ("x-den-library-token", CANDIDATE_TOKEN),
                ],
            )
            .await;
        assert_eq!(created.status(), StatusCode::OK);
        let readback = body_json(
            h.send(
                "GET",
                &format!("/lib/{CANDIDATE}/changes"),
                None,
                &[("x-den-wire", "4"), ("x-den-library-token", CANDIDATE_TOKEN)],
            )
            .await,
        )
        .await;
        assert_eq!(
            row_values(&readback, "entries"),
            std::collections::BTreeMap::from([
                (ACTIVITY.to_owned(), "synthetic-owner-activity".to_owned()),
                (DELIVERY.to_owned(), "synthetic-delivery-state".to_owned()),
            ])
        );

        // While locked: a competing split, a competing restore (stale source, so not the Owner handoff) and
        // ordinary household writes all learn only `migration_in_progress`; reads keep working.
        let mut stale = ProfileMigrationStorage::new(&h.state)
            .observe_source(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
            .await
            .unwrap();
        stale.head = if stale.head.starts_with('f') { "e".repeat(64) } else { "f".repeat(64) };
        let competing_restore =
            json!({ "attempt": ATTEMPT3, "purpose": "restore", "expectedSource": stale }).to_string();
        let refused = [
            rehearsal_open(&h, ATTEMPT2, "split").await,
            migration_request(&h, "POST", &base, Some(competing_restore), Some(HOUSEHOLD_TOKEN)).await,
            h.send(
                "POST",
                &format!("/lib/{HOUSEHOLD}/batch"),
                Some(json!({ "writes": [{ "k": CONFIG, "base": 2, "v": "blocked" }] }).to_string()),
                &[("x-den-wire", "4"), ("x-den-library-token", HOUSEHOLD_TOKEN)],
            )
            .await,
            h.send(
                "PUT",
                &format!("/lib/{HOUSEHOLD}/member"),
                None,
                &[("x-den-wire", "4"), ("x-den-library-token", HOUSEHOLD_TOKEN)],
            )
            .await,
        ];
        for response in refused {
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(body_json(response).await, json!({ "error": "migration_in_progress" }));
        }
        assert_eq!(household_lock(&h).as_deref(), Some(ATTEMPT));
        let locked_read = household_changes(&h, "4").await;
        assert_eq!(locked_read.status(), StatusCode::OK);
        assert_eq!(row_values(&body_json(locked_read).await, "entries"), rehearsal_rows());

        let staged = body_json(
            migration_request(
                &h,
                "POST",
                &format!("{attempt_path}/rows"),
                Some(
                    json!({
                        "fence": opened["fence"],
                        "backup": { "id": backup["id"], "digest": backup["digest"] },
                        "writes": [
                            { "k": CONFIG, "v": "synthetic-household-config" },
                            { "k": DIRECTORY, "v": format!("synthetic-directory-owner:{CANDIDATE}") },
                        ],
                    })
                    .to_string(),
                ),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;

        // The server commits, the caller discards the response, and a lookup alone recovers the terminal.
        let lost = migration_request(
            &h,
            "POST",
            &format!("{attempt_path}/commit"),
            Some(
                json!({
                    "fence": opened["fence"],
                    "backup": { "id": backup["id"], "digest": backup["digest"] },
                    "stagedDigest": staged["stagedDigest"],
                    "wireMin": 5,
                })
                .to_string(),
            ),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(lost.status(), StatusCode::OK);
        drop(lost);
        let committed =
            body_json(migration_request(&h, "GET", &attempt_path, None, Some(HOUSEHOLD_TOKEN)).await).await;
        assert_eq!(committed["state"], "committed");
        assert_eq!(committed["wireMin"], 5);
        assert_eq!(committed["stagedDigest"], staged["stagedDigest"]);
        assert_eq!(committed["backup"], json!({ "id": backup["id"], "digest": backup["digest"] }));
        assert!(committed["head"].is_string() && committed.get("winner").is_none());
        let again =
            body_json(migration_request(&h, "GET", &attempt_path, None, Some(HOUSEHOLD_TOKEN)).await).await;
        assert_eq!(again, committed, "a repeated lookup is byte-identical");

        assert_eq!(household_lock(&h), None, "commit releases the exclusive lock");
        let old_wire = household_changes(&h, "4").await;
        assert_eq!(old_wire.status(), StatusCode::UPGRADE_REQUIRED);
        assert_eq!(body_json(old_wire).await, json!({ "error": "upgrade_required", "min": 5 }));
        let current = body_json(household_changes(&h, "5").await).await;
        assert_eq!(
            row_values(&current, "entries"),
            std::collections::BTreeMap::from([
                (CONFIG.to_owned(), "synthetic-household-config".to_owned()),
                (DIRECTORY.to_owned(), format!("synthetic-directory-owner:{CANDIDATE}")),
            ])
        );
    }

    /// Process death mid-split: the split is opened and rows are staged, the server restarts, and a client with
    /// no journal recovers with the Owner PIN alone. The restore handoff binds the split's exact backup, restore
    /// puts the original household back, and a second restart shows the result, the released lock and both
    /// terminal states are durable.
    #[tokio::test]
    async fn synthetic_server_rehearsal_recovers_a_crashed_split_by_owner_pin_restore_across_restarts() {
        let h = rehearsal_household().await;
        let dir = h.dir.clone();
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let opened = body_json(rehearsal_open(&h, ATTEMPT, "split").await).await;
        let backup = opened["backup"].clone();
        let staged = migration_request(
            &h,
            "POST",
            &format!("{base}/{ATTEMPT}/rows"),
            Some(
                json!({
                    "fence": opened["fence"],
                    "backup": { "id": backup["id"], "digest": backup["digest"] },
                    "writes": [
                        { "k": CONFIG, "v": "synthetic-household-config" },
                        { "k": DIRECTORY, "v": format!("synthetic-directory-owner:{CANDIDATE}") },
                    ],
                })
                .to_string(),
            ),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(staged.status(), StatusCode::OK);
        drop(h);

        let enable = |h: &mut Harness| {
            let state = Arc::get_mut(&mut h.state).unwrap();
            state.profile_migration_enabled = true;
            state.profile_prepare_households.insert(HOUSEHOLD.to_owned());
        };
        let mut restarted = Harness::in_dir(dir.clone());
        enable(&mut restarted);
        assert_eq!(household_lock(&restarted).as_deref(), Some(ATTEMPT), "the lock survives the crash");

        // No journal: only the Owner PIN's household credential and the live source observation.
        let recovery = body_json(rehearsal_open(&restarted, ATTEMPT3, "restore").await).await;
        assert_eq!(
            (recovery["state"].as_str(), recovery["purpose"].as_str()),
            (Some("open"), Some("restore"))
        );
        assert_eq!(recovery["backup"], backup, "the handoff binds the split's exact backup");
        assert_eq!(household_lock(&restarted).as_deref(), Some(ATTEMPT3));
        let artifact = body_json(
            migration_request(
                &restarted,
                "GET",
                &format!("{base}/{ATTEMPT3}/backup"),
                None,
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        assert_eq!(artifact["attempt"], ATTEMPT);
        assert_eq!(artifact["digest"], backup["digest"]);
        assert_eq!(row_values(&artifact, "rows"), rehearsal_rows());
        let split = body_json(
            migration_request(&restarted, "GET", &format!("{base}/{ATTEMPT}"), None, Some(HOUSEHOLD_TOKEN))
                .await,
        )
        .await;
        assert_eq!(split["state"], "aborted");

        let restored = body_json(
            migration_request(
                &restarted,
                "POST",
                &format!("{base}/{ATTEMPT3}/restore"),
                Some(
                    json!({
                        "backup": backup,
                        "fence": recovery["fence"],
                        "wireMin": recovery["wireMin"],
                        "profilesRow": { "present": false, "seq": null, "digest": null },
                        "directoryState": "absent",
                        "plannerDecision": "restore-backup",
                    })
                    .to_string(),
                ),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        assert_eq!(restored["state"], "restored");
        assert_eq!(household_lock(&restarted), None);
        let restored_lookup = body_json(
            migration_request(&restarted, "GET", &format!("{base}/{ATTEMPT3}"), None, Some(HOUSEHOLD_TOKEN))
                .await,
        )
        .await;
        drop(restarted);

        let mut again = Harness::in_dir(dir);
        enable(&mut again);
        assert_eq!(household_lock(&again), None, "the released lock is durable");
        let lookup = body_json(
            migration_request(&again, "GET", &format!("{base}/{ATTEMPT3}"), None, Some(HOUSEHOLD_TOKEN))
                .await,
        )
        .await;
        assert_eq!(lookup["state"], "restored");
        assert_eq!(lookup, restored_lookup);
        let split = body_json(
            migration_request(&again, "GET", &format!("{base}/{ATTEMPT}"), None, Some(HOUSEHOLD_TOKEN)).await,
        )
        .await;
        assert_eq!(split["state"], "aborted");
        let household = household_changes(&again, "4").await;
        assert_eq!(household.status(), StatusCode::OK);
        assert_eq!(row_values(&body_json(household).await, "entries"), rehearsal_rows());
    }

    #[tokio::test]
    async fn retirement_route_uses_its_own_durable_abort_to_clean_an_unchanged_source() {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = true;
        Arc::get_mut(&mut h.state).unwrap().profile_prepare_households.insert(HOUSEHOLD.to_owned());
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        write(&h, CANDIDATE, ACTIVITY, 0, "candidate", CANDIDATE_TOKEN).await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let opened = body_json(
            migration_request(
                &h,
                "POST",
                &base,
                Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        let body = json!({
            "source": opened["fence"],
            "authority": {
                "generation": opened["fence"]["generation"],
                "base": opened["fence"]["base"],
                "head": opened["fence"]["head"],
                "kind": "changed-legacy",
            },
            "profilesRow": null,
            "protectedLibraryIds": [HOUSEHOLD],
            "candidateLibraryId": CANDIDATE,
        })
        .to_string();
        let attempt_path = format!("{base}/{ATTEMPT}");
        let retire_path = format!("{attempt_path}/retire-candidate");
        let retire = |body: String| {
            h.send(
                "POST",
                &retire_path,
                Some(body),
                &[
                    ("x-den-wire", "5"),
                    ("x-den-library-token", HOUSEHOLD_TOKEN),
                    ("x-den-candidate-library-token", CANDIDATE_TOKEN),
                ],
            )
        };

        assert_eq!(retire(body.clone()).await.status(), StatusCode::CONFLICT);
        let aborted =
            body_json(migration_request(&h, "DELETE", &attempt_path, None, Some(HOUSEHOLD_TOKEN)).await)
                .await;
        assert_eq!(aborted["state"], "aborted");
        assert_eq!(body_json(retire(body).await).await["result"], "retired");
    }

    #[tokio::test]
    async fn retirement_route_requires_a_separate_candidate_header_and_fresh_authority() {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = true;
        Arc::get_mut(&mut h.state).unwrap().profile_prepare_households.insert(HOUSEHOLD.to_owned());
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        write(&h, CANDIDATE, ACTIVITY, 0, "candidate", CANDIDATE_TOKEN).await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let source = body_json(
            migration_request(
                &h,
                "POST",
                &base,
                Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        let attempt_path = format!("{base}/{ATTEMPT}");
        assert_eq!(
            migration_request(&h, "DELETE", &attempt_path, None, Some(HOUSEHOLD_TOKEN)).await.status(),
            StatusCode::OK
        );
        write(&h, HOUSEHOLD, CONFIG, 0, "changed", HOUSEHOLD_TOKEN).await;
        let snapshot = ProfileMigrationStorage::new(&h.state)
            .locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
            .await
            .unwrap();
        let body = json!({
            "source": source["fence"],
            "authority": {
                "generation": snapshot.protocol.migration_generation,
                "base": snapshot.protocol.head,
                "head": authenticated_head(HOUSEHOLD, &snapshot).unwrap(),
                "kind": "changed-legacy",
            },
            "profilesRow": null,
            "protectedLibraryIds": [HOUSEHOLD],
            "candidateLibraryId": CANDIDATE,
        })
        .to_string();
        let path = format!("{base}/{ATTEMPT}/retire-candidate");
        assert_eq!(
            migration_request(&h, "POST", &path, Some(body.clone()), Some(HOUSEHOLD_TOKEN)).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            h.send(
                "POST",
                &path,
                Some(body.clone()),
                &[
                    ("x-den-wire", "5"),
                    ("x-den-library-token", HOUSEHOLD_TOKEN),
                    ("x-den-candidate-library-token", "wrong"),
                ],
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        let retired = body_json(
            h.send(
                "POST",
                &path,
                Some(body),
                &[
                    ("x-den-wire", "5"),
                    ("x-den-library-token", HOUSEHOLD_TOKEN),
                    ("x-den-candidate-library-token", CANDIDATE_TOKEN),
                ],
            )
            .await,
        )
        .await;
        assert_eq!(retired["result"], "retired");
        assert_eq!(
            h.send(
                "GET",
                &format!("/lib/{CANDIDATE}/changes"),
                None,
                &[("x-den-library-token", CANDIDATE_TOKEN)],
            )
            .await
            .status(),
            StatusCode::GONE
        );
    }

    #[tokio::test]
    async fn backup_is_durable_readable_and_bound_to_the_exact_source_fence() {
        let h = Harness::new();
        assert_eq!(
            write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await,
            StatusCode::OK
        );
        let storage = ProfileMigrationStorage::new(&h.state);
        let source = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert!(matches!(
            storage.acquire_fence(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await,
            Err(MigrationError::InProgress)
        ));
        let backup = storage
            .create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &source)
            .await
            .unwrap();
        storage.verify_backup(HOUSEHOLD, &source, &backup).await.unwrap();

        assert_eq!(
            storage.abort_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state,
            AttemptState::Aborted
        );
        assert_eq!(write(&h, HOUSEHOLD, CONFIG, 0, "later", HOUSEHOLD_TOKEN).await, StatusCode::OK);
        let changed = storage.acquire_fence(ATTEMPT3, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert_ne!(source, changed);
        assert!(matches!(
            storage.create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &changed).await,
            Err(MigrationError::InProgress)
        ));

        h.state
            .store
            .replace_file(NS, &attempt_key(HOUSEHOLD, ATTEMPT), BACKUP_EXT, b"truncated")
            .await
            .unwrap();
        assert!(matches!(
            storage.verify_backup(HOUSEHOLD, &source, &backup).await,
            Err(MigrationError::BackupCorrupt)
        ));
    }

    #[tokio::test]
    async fn rewrite_requires_backup_and_all_three_fence_authorities_then_keeps_identity() {
        let h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let stale = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let stale_backup =
            storage.create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &stale).await.unwrap();
        assert_eq!(
            write(&h, HOUSEHOLD, CONFIG, 0, "household-config", HOUSEHOLD_TOKEN).await,
            StatusCode::CONFLICT
        );
        let kept = vec![RewriteRow { key: CONFIG.into(), value: "household-config".into() }];
        let mut moved = stale.clone();
        moved.base += 1;
        assert!(matches!(
            storage.rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &moved, &stale_backup, &kept).await,
            Err(MigrationError::FenceChanged)
        ));
        let rows = vec![
            RewriteRow { key: CONFIG.into(), value: "household-config".into() },
            RewriteRow { key: DIRECTORY.into(), value: "sealed-directory".into() },
        ];
        let committed = storage
            .rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &stale, &stale_backup, &rows)
            .await
            .unwrap();
        assert_eq!(committed.wire_min, 5);
        assert_eq!(committed.head, stale.base + 2);
        assert_eq!(
            h.state.library_v3.credentials(HOUSEHOLD).unwrap().unwrap().0,
            token(HOUSEHOLD_TOKEN),
            "the in-place split keeps the household id and key"
        );
        let winner = storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap();
        assert_eq!(winner.state, AttemptState::Committed);
        let winner = winner.winner.unwrap();
        assert_eq!(winner.resulting_base, committed.head);
        assert_eq!(winner.resulting_generation, committed.migration_generation);
        assert_eq!(winner.staged_digest, Some(staged_digest(&rows).unwrap()));

        let abort_fence = storage.acquire_fence(ATTEMPT3, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let aborted = storage.abort_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT3).await.unwrap();
        assert_eq!(aborted.state, AttemptState::Aborted, "a later snapshot is a distinct abortable attempt");
        assert_eq!(aborted.fence, abort_fence);
    }

    #[tokio::test]
    async fn an_open_attempt_and_verified_backup_survive_restart_without_idle_expiry() {
        let h = Harness::new();
        let dir = h.dir.clone();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await;
        let (source, backup) = {
            let storage = ProfileMigrationStorage::new(&h.state);
            let source = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
            let backup = storage
                .create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &source)
                .await
                .unwrap();
            (source, backup)
        };
        drop(h);

        let restarted = Harness::in_dir(dir);
        restarted.advance(365 * 24 * 60 * 60 * 1_000);
        let storage = ProfileMigrationStorage::new(&restarted.state);
        assert_eq!(storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap(), source);
        storage.verify_backup(HOUSEHOLD, &source, &backup).await.unwrap();
        assert_eq!(
            write(&restarted, HOUSEHOLD, CONFIG, source.base, "blocked", HOUSEHOLD_TOKEN).await,
            StatusCode::CONFLICT,
            "a process restart retains the durable lock"
        );
        assert!(matches!(
            storage.acquire_fence(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await,
            Err(MigrationError::InProgress)
        ));
        assert_eq!(
            storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state,
            AttemptState::Open
        );
        assert_eq!(
            storage.abort_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state,
            AttemptState::Aborted
        );
    }

    #[tokio::test]
    async fn verified_split_backup_hands_the_exclusive_lock_to_fresh_restore_and_survives_restart() {
        let h = Harness::new();
        let dir = h.dir.clone();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let source = storage.observe_source(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let split = storage
            .open_attempt(ATTEMPT, AttemptPurpose::Split, &source, HOUSEHOLD, token(HOUSEHOLD_TOKEN), true)
            .await
            .unwrap();
        let backup = split.backup.clone().expect("open publishes its verified backup binding");
        storage.verify_backup(HOUSEHOLD, &split.fence, &backup).await.unwrap();
        let replay = storage
            .open_attempt(ATTEMPT, AttemptPurpose::Split, &source, HOUSEHOLD, token(HOUSEHOLD_TOKEN), true)
            .await
            .unwrap();
        assert_eq!(replay.backup, Some(backup.clone()));

        let restore = storage
            .open_attempt(ATTEMPT3, AttemptPurpose::Restore, &source, HOUSEHOLD, token(HOUSEHOLD_TOKEN), true)
            .await
            .unwrap();
        assert_eq!(restore.backup, Some(backup.clone()), "handoff returns the exact split artifact");
        assert_eq!(
            storage.backup_reference(HOUSEHOLD, ATTEMPT3).await.unwrap(),
            backup,
            "the restore route is bound to the original split backup"
        );
        let store = h.state.library_v3.existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).unwrap();
        assert_eq!(store.exclusive_operation_lock().unwrap().as_deref(), Some(ATTEMPT3));
        assert_eq!(
            storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state,
            AttemptState::Aborted
        );
        drop(h);

        let restarted = Harness::in_dir(dir);
        let storage = ProfileMigrationStorage::new(&restarted.state);
        let resumed = storage
            .open_attempt(ATTEMPT3, AttemptPurpose::Restore, &source, HOUSEHOLD, token(HOUSEHOLD_TOKEN), true)
            .await
            .unwrap();
        assert_eq!(resumed.backup, restore.backup);
        assert_eq!(
            restarted
                .state
                .library_v3
                .existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
                .unwrap()
                .exclusive_operation_lock()
                .unwrap()
                .as_deref(),
            Some(ATTEMPT3),
            "the compare-and-transfer lock survives process restart"
        );
    }

    #[tokio::test]
    async fn recovery_handoff_requires_an_intact_bound_backup_and_never_leaks_split_metadata() {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = true;
        Arc::get_mut(&mut h.state).unwrap().profile_prepare_households.insert(HOUSEHOLD.to_owned());
        write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let split = migration_request(
            &h,
            "POST",
            &base,
            Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(split.status(), StatusCode::OK);
        assert!(body_json(split).await["backup"]["digest"].is_string());
        h.state
            .store
            .replace_file(NS, &attempt_key(HOUSEHOLD, ATTEMPT), BACKUP_EXT, b"corrupt")
            .await
            .unwrap();

        let restore = migration_request(
            &h,
            "POST",
            &base,
            Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT3, "restore").await),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(restore.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(restore).await, json!({ "error": "migration_in_progress" }));
        let storage = ProfileMigrationStorage::new(&h.state);
        assert!(storage.load_attempt(HOUSEHOLD, ATTEMPT3).await.unwrap().is_none());
        assert_eq!(
            h.state
                .library_v3
                .existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
                .unwrap()
                .exclusive_operation_lock()
                .unwrap()
                .as_deref(),
            Some(ATTEMPT),
            "an ineligible recovery leaves the original lock untouched"
        );
    }

    async fn enabled_harness_with_legacy_row() -> Harness {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = true;
        Arc::get_mut(&mut h.state).unwrap().profile_prepare_households.insert(HOUSEHOLD.to_owned());
        assert_eq!(write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await, StatusCode::OK);
        h
    }

    fn household_lock(h: &Harness) -> Option<String> {
        h.state
            .library_v3
            .existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
            .unwrap()
            .exclusive_operation_lock()
            .unwrap()
    }

    #[tokio::test]
    async fn http_lookup_replays_the_open_answer_and_abort_is_refused_once_staging_begins() {
        let h = enabled_harness_with_legacy_row().await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let attempt = format!("{base}/{ATTEMPT}");
        let open = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await;
        let opened =
            body_json(migration_request(&h, "POST", &base, Some(open.clone()), Some(HOUSEHOLD_TOKEN)).await)
                .await;
        assert_eq!(opened["state"], "open");
        assert_eq!(opened["backup"]["attempt"], ATTEMPT);

        let looked_up =
            body_json(migration_request(&h, "GET", &attempt, None, Some(HOUSEHOLD_TOKEN)).await).await;
        assert_eq!(looked_up, opened, "a lost open response is answered by an identical lookup");
        let replayed =
            body_json(migration_request(&h, "POST", &base, Some(open), Some(HOUSEHOLD_TOKEN)).await).await;
        assert_eq!(replayed, opened);

        let backup = body_json(
            migration_request(&h, "POST", &format!("{attempt}/backup"), None, Some(HOUSEHOLD_TOKEN)).await,
        )
        .await;
        assert_eq!(backup["digest"], opened["backup"]["digest"]);
        assert_eq!(backup["source"], opened["fence"]);
        let artifact = body_json(
            migration_request(&h, "GET", &format!("{attempt}/backup"), None, Some(HOUSEHOLD_TOKEN)).await,
        )
        .await;
        assert_eq!(artifact["attempt"], ATTEMPT);

        let staged = migration_request(
            &h,
            "POST",
            &format!("{attempt}/rows"),
            Some(
                json!({
                    "fence": opened["fence"],
                    "backup": { "id": opened["backup"]["id"], "digest": opened["backup"]["digest"] },
                    "writes": [{ "k": CONFIG, "v": "kept" }],
                })
                .to_string(),
            ),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(staged.status(), StatusCode::OK);

        let refused = migration_request(&h, "DELETE", &attempt, None, Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(refused).await, json!({ "error": "migration_in_progress" }));
        assert_eq!(household_lock(&h).as_deref(), Some(ATTEMPT), "a refused abort leaves the lock held");
        let still_open =
            body_json(migration_request(&h, "GET", &attempt, None, Some(HOUSEHOLD_TOKEN)).await).await;
        assert_eq!(still_open, opened);
    }

    #[tokio::test]
    async fn abort_before_staging_releases_the_lock_atomically_for_a_new_attempt() {
        let h = enabled_harness_with_legacy_row().await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let attempt = format!("{base}/{ATTEMPT}");
        let open = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await;
        assert_eq!(
            migration_request(&h, "POST", &base, Some(open.clone()), Some(HOUSEHOLD_TOKEN)).await.status(),
            StatusCode::OK
        );
        let aborted = migration_request(&h, "DELETE", &attempt, None, Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(aborted.status(), StatusCode::OK);
        assert_eq!(body_json(aborted).await["state"], "aborted");
        assert_eq!(household_lock(&h), None);

        let replay =
            body_json(migration_request(&h, "POST", &base, Some(open), Some(HOUSEHOLD_TOKEN)).await).await;
        assert_eq!(replay["state"], "aborted", "an aborted attempt id is never reopened");
        assert_eq!(household_lock(&h), None);
        let next = migration_request(
            &h,
            "POST",
            &base,
            Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT2, "split").await),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(next.status(), StatusCode::OK);
        assert_eq!(household_lock(&h).as_deref(), Some(ATTEMPT2));
    }

    #[tokio::test]
    async fn a_sidecar_without_the_lock_is_a_crash_remnant_that_open_resumes() {
        let h = enabled_harness_with_legacy_row().await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let attempt = format!("{base}/{ATTEMPT}");
        let open = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await;
        let opened =
            body_json(migration_request(&h, "POST", &base, Some(open.clone()), Some(HOUSEHOLD_TOKEN)).await)
                .await;
        // Model a crash after the sidecar and backup reached disk but before the lock transaction committed.
        h.state
            .library_v3
            .existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
            .unwrap()
            .release_exclusive_operation_lock(ATTEMPT)
            .unwrap();

        for method in ["GET", "DELETE"] {
            assert_eq!(
                migration_request(&h, method, &attempt, None, Some(HOUSEHOLD_TOKEN)).await.status(),
                StatusCode::NOT_FOUND,
                "{method}: the lock transaction is the commit point of open"
            );
        }
        assert_eq!(household_lock(&h), None);
        let resumed =
            body_json(migration_request(&h, "POST", &base, Some(open), Some(HOUSEHOLD_TOKEN)).await).await;
        assert_eq!(resumed, opened, "the same attempt resumes with its stored fence and backup");
        assert_eq!(household_lock(&h).as_deref(), Some(ATTEMPT));
    }

    #[tokio::test]
    async fn http_recovery_handoff_returns_the_bound_backup_and_competitors_learn_nothing() {
        let h = enabled_harness_with_legacy_row().await;
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let split = body_json(
            migration_request(
                &h,
                "POST",
                &base,
                Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;

        let source = ProfileMigrationStorage::new(&h.state)
            .observe_source(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
            .await
            .unwrap();
        let mut wrong = source.clone();
        wrong.head = if wrong.head.starts_with('f') { "e".repeat(64) } else { "f".repeat(64) };
        let wrong = json!({ "attempt": ATTEMPT3, "purpose": "restore", "expectedSource": wrong }).to_string();
        let refused = migration_request(&h, "POST", &base, Some(wrong), Some(HOUSEHOLD_TOKEN)).await;
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(refused).await, json!({ "error": "migration_in_progress" }));
        assert_eq!(household_lock(&h).as_deref(), Some(ATTEMPT), "a failed handoff changes nothing");

        let restore = body_json(
            migration_request(
                &h,
                "POST",
                &base,
                Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT3, "restore").await),
                Some(HOUSEHOLD_TOKEN),
            )
            .await,
        )
        .await;
        assert_eq!((restore["state"].as_str(), restore["purpose"].as_str()), (Some("open"), Some("restore")));
        assert_eq!(restore["backup"], split["backup"], "the handoff binds the split's exact artifact");
        assert_eq!(household_lock(&h).as_deref(), Some(ATTEMPT3));
        let artifact = body_json(
            migration_request(&h, "GET", &format!("{base}/{ATTEMPT3}/backup"), None, Some(HOUSEHOLD_TOKEN))
                .await,
        )
        .await;
        assert_eq!(artifact["attempt"], ATTEMPT, "the restore reads the original manifest unchanged");
        let old = body_json(
            migration_request(&h, "GET", &format!("{base}/{ATTEMPT}"), None, Some(HOUSEHOLD_TOKEN)).await,
        )
        .await;
        assert_eq!(old["state"], "aborted");

        for (attempt, purpose) in [(ATTEMPT, "split"), (ATTEMPT2, "split"), (ATTEMPT2, "restore")] {
            let body = open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, attempt, purpose).await;
            let response = migration_request(&h, "POST", &base, Some(body), Some(HOUSEHOLD_TOKEN)).await;
            if attempt == ATTEMPT {
                assert_eq!(body_json(response).await["state"], "aborted");
            } else {
                assert_eq!(response.status(), StatusCode::CONFLICT, "{attempt} {purpose}");
                assert_eq!(body_json(response).await, json!({ "error": "migration_in_progress" }));
            }
        }
    }

    #[tokio::test]
    async fn atomic_abort_marker_repairs_a_lost_sidecar_response_and_unlocks() {
        let h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let opened = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let store = h.state.library_v3.existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).unwrap();
        store.abort_exclusive_operation(ATTEMPT, opened.generation, opened.base).unwrap();

        let repaired = storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap();
        assert_eq!(repaired.state, AttemptState::Aborted);
        assert_eq!(store.exclusive_operation_lock().unwrap(), None);
        assert_eq!(
            write(&h, HOUSEHOLD, CONFIG, opened.base, "unlocked", HOUSEHOLD_TOKEN).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn one_attempt_exclusively_owns_mutation_and_same_attempt_resumes() {
        let h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let (first, repeated) = tokio::join!(
            storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)),
            storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN))
        );
        assert_eq!(first.unwrap(), repeated.unwrap(), "one attempt id has one durable rewrite handle");

        let one = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert!(matches!(
            storage.acquire_fence(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await,
            Err(MigrationError::InProgress)
        ));
        assert_eq!(
            storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap(),
            one,
            "an owning attempt resumes idempotently"
        );
        assert_eq!(
            write(&h, HOUSEHOLD, CONFIG, one.base, "blocked", HOUSEHOLD_TOKEN).await,
            StatusCode::CONFLICT
        );
        let backup_one =
            storage.create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &one).await.unwrap();
        let rows = [RewriteRow { key: CONFIG.into(), value: "kept".into() }];
        let committed = storage
            .rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &one, &backup_one, &rows)
            .await
            .unwrap();
        assert_eq!(committed.wire_min, PROFILE_WIRE_MINIMUM);
        let household = h.state.library_v3.existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).unwrap();
        assert_eq!(household.exclusive_operation_lock().unwrap(), None);
        let protocol = household.protocol().unwrap();
        let generation = super::super::full_generation(&h.state, &protocol.generation);
        assert_eq!(
            h.send(
                "POST",
                &format!("/lib/{HOUSEHOLD}/batch"),
                Some(
                    json!({ "writes": [{ "k": DIRECTORY, "base": committed.head, "v": "unlocked" }] })
                        .to_string(),
                ),
                &[
                    ("x-den-wire", "5"),
                    ("x-den-generation", &generation),
                    ("x-den-library-token", HOUSEHOLD_TOKEN),
                ],
            )
            .await
            .status(),
            StatusCode::OK,
            "commit atomically releases the exclusive lock"
        );
    }

    #[tokio::test]
    async fn exclusive_migration_lock_refuses_competitors_and_every_ordinary_mutation() {
        let mut h = Harness::new();
        Arc::get_mut(&mut h.state).unwrap().profile_migration_enabled = true;
        Arc::get_mut(&mut h.state).unwrap().profile_prepare_households.insert(HOUSEHOLD.to_owned());
        assert_eq!(write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await, StatusCode::OK);
        let base = format!("/lib/{HOUSEHOLD}/profile-migration");
        let opened = migration_request(
            &h,
            "POST",
            &base,
            Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(opened.status(), StatusCode::OK);

        let competing = migration_request(
            &h,
            "POST",
            &base,
            Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT2, "split").await),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(competing.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(competing).await, json!({ "error": "migration_in_progress" }));

        let mutations = [
            ("POST", format!("/lib/{HOUSEHOLD}/batch"), Some(json!({ "writes": [] }).to_string())),
            ("PUT", format!("/lib/{HOUSEHOLD}/member"), None),
            ("DELETE", format!("/lib/{HOUSEHOLD}"), None),
            ("POST", format!("/lib/{HOUSEHOLD}/rewrite"), None),
        ];
        for (method, path, body) in mutations {
            let response = h
                .send(method, &path, body, &[("x-den-wire", "5"), ("x-den-library-token", HOUSEHOLD_TOKEN)])
                .await;
            assert_eq!(response.status(), StatusCode::CONFLICT, "{method} {path}");
            assert_eq!(
                body_json(response).await,
                json!({ "error": "migration_in_progress" }),
                "the response never exposes the owning attempt"
            );
        }

        let resumed = migration_request(
            &h,
            "POST",
            &base,
            Some(open_body(&h, HOUSEHOLD, HOUSEHOLD_TOKEN, ATTEMPT, "split").await),
            Some(HOUSEHOLD_TOKEN),
        )
        .await;
        assert_eq!(resumed.status(), StatusCode::OK);
        assert_eq!(body_json(resumed).await["attempt"], ATTEMPT);
    }

    #[tokio::test]
    async fn mutation_boundaries_close_delete_and_rewrite_preflight_races() {
        let h = Harness::new();
        assert_eq!(write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await, StatusCode::OK);
        let storage = ProfileMigrationStorage::new(&h.state);
        let expected = storage.observe_source(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let store = h.state.library_v3.existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).unwrap();
        let protocol = store.protocol().unwrap();
        store
            .acquire_exclusive_operation_lock(ATTEMPT, protocol.migration_generation, protocol.head)
            .unwrap();

        assert_eq!(
            super::super::rewrite_open(&h.state, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.status(),
            StatusCode::CONFLICT,
            "rewrite open rechecks after taking the library slot"
        );
        assert_eq!(
            super::super::forget(&h.state, HOUSEHOLD, token(HOUSEHOLD_TOKEN), None, None).await.status(),
            StatusCode::CONFLICT,
            "delete rechecks before its first irreversible mutation"
        );
        assert!(h.state.library_v3.credentials(HOUSEHOLD).unwrap().is_some());
        store.release_exclusive_operation_lock(ATTEMPT).unwrap();

        let opened = super::super::rewrite_open(&h.state, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await;
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = body_json(opened).await;
        let rewrite = opened["rewrite"].as_str().unwrap();
        let rewrite_base = opened["base"].as_u64().unwrap();

        assert!(matches!(
            storage
                .open_attempt(
                    ATTEMPT,
                    AttemptPurpose::Split,
                    &expected,
                    HOUSEHOLD,
                    token(HOUSEHOLD_TOKEN),
                    true,
                )
                .await,
            Err(MigrationError::Invalid("another rewrite is staged"))
        ));
        assert_eq!(store.exclusive_operation_lock().unwrap(), None);

        // Model a lock acquired after an HTTP preflight but before the sidecar handler takes the slot. Production
        // migration acquisition serializes this boundary; the direct store call makes the losing side observable.
        store
            .acquire_exclusive_operation_lock(ATTEMPT, protocol.migration_generation, protocol.head)
            .unwrap();
        let rows = Request::builder()
            .method(Method::POST)
            .body(axum::body::Body::from(json!({ "writes": [{ "k": CONFIG, "v": "kept" }] }).to_string()))
            .unwrap();
        assert_eq!(
            super::super::rewrite_rows(
                &h.state,
                HOUSEHOLD,
                token(HOUSEHOLD_TOKEN),
                &format!("rewrite/{rewrite}/rows"),
                rows,
            )
            .await
            .status(),
            StatusCode::CONFLICT,
            "rewrite rows rechecks before replacing its sidecar"
        );
        let commit = Request::builder()
            .method(Method::POST)
            .body(axum::body::Body::from(json!({ "base": rewrite_base, "wireMin": 4 }).to_string()))
            .unwrap();
        assert_eq!(
            super::super::rewrite_commit(
                &h.state,
                HOUSEHOLD,
                token(HOUSEHOLD_TOKEN),
                5,
                &format!("rewrite/{rewrite}/commit"),
                commit,
            )
            .await
            .status(),
            StatusCode::CONFLICT,
            "rewrite commit rechecks inside the redb write transaction"
        );
        assert_eq!(
            super::super::rewrite_abort(
                &h.state,
                HOUSEHOLD,
                token(HOUSEHOLD_TOKEN),
                &format!("rewrite/{rewrite}"),
            )
            .await
            .status(),
            StatusCode::CONFLICT,
            "rewrite abort rechecks while holding the library slot"
        );
        store.release_exclusive_operation_lock(ATTEMPT).unwrap();
        assert_eq!(
            super::super::rewrite_abort(
                &h.state,
                HOUSEHOLD,
                token(HOUSEHOLD_TOKEN),
                &format!("rewrite/{rewrite}"),
            )
            .await
            .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn restore_requires_a_fresh_bound_recovery_attempt_and_is_idempotent() {
        let h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy-activity", HOUSEHOLD_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let source = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let backup = storage
            .create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &source)
            .await
            .unwrap();
        let split_rows = [
            RewriteRow { key: CONFIG.into(), value: "configuration".into() },
            RewriteRow { key: DIRECTORY.into(), value: "invalid-directory".into() },
        ];
        storage
            .rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &source, &backup, &split_rows)
            .await
            .unwrap();

        let recovery_source = storage.observe_source(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let recovery = storage
            .open_attempt(
                ATTEMPT3,
                AttemptPurpose::Restore,
                &recovery_source,
                HOUSEHOLD,
                token(HOUSEHOLD_TOKEN),
                true,
            )
            .await
            .unwrap();
        assert_eq!(recovery.state, AttemptState::Open);
        assert_eq!(recovery.purpose, AttemptPurpose::Restore);
        assert_eq!(recovery.wire_minimum, 5);
        let current = storage.locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let profiles = find_row(&current, DIRECTORY).unwrap().unwrap();
        let request = RestoreRequest {
            backup: backup.clone(),
            fence: recovery.fence.clone(),
            wire_minimum: recovery.wire_minimum,
            profiles_row: ProfilesRowEvidence {
                present: true,
                seq: Some(profiles.sequence),
                digest: Some(hex_digest(profiles.value.as_bytes())),
            },
            directory_state: DirectoryState::Invalid,
            planner_decision: "restore-backup".into(),
        };
        let restored =
            storage.restore_backup(ATTEMPT3, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &request).await.unwrap();
        assert_eq!(restored.kind, MigrationResultKind::Restored);
        assert_eq!(restored.resulting_base, source.base);
        assert_eq!(restored.wire_minimum, 5, "restore never lowers the committed wire minimum");
        let after = storage.locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert_eq!(after.protocol.head, source.base);
        assert_eq!(after.protocol.wire_min, 5);
        assert_eq!(find_row(&after, ACTIVITY).unwrap().unwrap().value, "legacy-activity");
        assert!(find_row(&after, DIRECTORY).unwrap().is_none());
        assert_eq!(
            h.state
                .library_v3
                .existing_library(HOUSEHOLD, token(HOUSEHOLD_TOKEN))
                .unwrap()
                .exclusive_operation_lock()
                .unwrap(),
            None,
            "verified restore atomically releases the exclusive lock"
        );

        let repeated =
            storage.restore_backup(ATTEMPT3, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &request).await.unwrap();
        assert_eq!(repeated, restored);
        assert_eq!(
            storage.locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap().protocol,
            after.protocol,
            "an identical retry does not advance either generation again"
        );
        let mut changed = request.clone();
        changed.directory_state = DirectoryState::Absent;
        assert!(matches!(
            storage.restore_backup(ATTEMPT3, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &changed).await,
            Err(MigrationError::Invalid("restore request changed"))
        ));
        let lookup = storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT3).await.unwrap();
        assert_eq!(lookup.state, AttemptState::Restored);
        assert_eq!(lookup.winner, Some(restored));
    }

    #[tokio::test]
    async fn attempt_terminals_survive_a_lost_sidecar_later_restore_and_restart() {
        let h = Harness::new();
        let dir = h.dir.clone();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy-activity", HOUSEHOLD_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let source = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let winner_open = storage.load_attempt(HOUSEHOLD, ATTEMPT).await.unwrap().unwrap();
        let backup = storage
            .create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &source)
            .await
            .unwrap();
        let split_rows = [
            RewriteRow { key: CONFIG.into(), value: "configuration".into() },
            RewriteRow { key: DIRECTORY.into(), value: "invalid-directory".into() },
        ];
        storage
            .rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &source, &backup, &split_rows)
            .await
            .unwrap();

        // Model a process death after redb committed but before the attempt sidecar recorded the response.
        storage.save_attempt(&winner_open).await.unwrap();
        assert_eq!(
            storage.load_attempt(HOUSEHOLD, ATTEMPT).await.unwrap().unwrap().state,
            AttemptState::Open
        );
        let recovery_source = storage.observe_source(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let recovery = storage
            .open_attempt(
                ATTEMPT3,
                AttemptPurpose::Restore,
                &recovery_source,
                HOUSEHOLD,
                token(HOUSEHOLD_TOKEN),
                true,
            )
            .await
            .unwrap();
        let current = storage.locked_snapshot(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let profiles = find_row(&current, DIRECTORY).unwrap().unwrap();
        let request = RestoreRequest {
            backup,
            fence: recovery.fence,
            wire_minimum: recovery.wire_minimum,
            profiles_row: ProfilesRowEvidence {
                present: true,
                seq: Some(profiles.sequence),
                digest: Some(hex_digest(profiles.value.as_bytes())),
            },
            directory_state: DirectoryState::Invalid,
            planner_decision: "restore-backup".into(),
        };
        storage.restore_backup(ATTEMPT3, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &request).await.unwrap();
        drop(h);

        let restarted = Harness::in_dir(dir);
        let storage = ProfileMigrationStorage::new(&restarted.state);
        let winner = storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap();
        assert_eq!(winner.state, AttemptState::Committed);
        let winning_terminal = winner.winner.unwrap();
        assert_eq!(winning_terminal.attempt, ATTEMPT);
        assert_eq!(winning_terminal.kind, MigrationResultKind::Committed);
        assert_eq!(winning_terminal.expected_generation, source.generation);
    }

    #[tokio::test]
    async fn an_aborted_split_retires_its_candidate_against_the_unchanged_source_only() {
        let h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        write(&h, CANDIDATE, ACTIVITY, 0, "candidate", CANDIDATE_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let source = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let unchanged = RetirementAuthority {
            generation: source.generation,
            base: source.base,
            head: source.authenticated_head.clone(),
            kind: AuthorityKind::ChangedLegacy,
        };
        let protected = ProtectedLibraries { ids: HashSet::from([HOUSEHOLD.to_owned()]) };
        let request = || RetirementRequest {
            attempt: ATTEMPT,
            source: &source,
            authority: &unchanged,
            profiles_row: None,
            protected: &protected,
            candidate_id: CANDIDATE,
        };

        assert!(matches!(
            storage
                .conditionally_retire_candidate(
                    HOUSEHOLD,
                    token(HOUSEHOLD_TOKEN),
                    token(CANDIDATE_TOKEN),
                    request(),
                )
                .await,
            Err(MigrationError::SameLegacyFence)
        ));
        let other_source = storage.observe_source(HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let other = storage
            .open_attempt(
                ATTEMPT2,
                AttemptPurpose::Split,
                &other_source,
                HOUSEHOLD,
                token(HOUSEHOLD_TOKEN),
                true,
            )
            .await;
        assert!(matches!(other, Err(MigrationError::InProgress)));
        assert!(matches!(
            storage
                .conditionally_retire_candidate(
                    HOUSEHOLD,
                    token(HOUSEHOLD_TOKEN),
                    token(CANDIDATE_TOKEN),
                    request(),
                )
                .await,
            Err(MigrationError::SameLegacyFence)
        ));
        let aborted = storage.abort_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap();
        assert_eq!(aborted.state, AttemptState::Aborted);
        assert_eq!(
            storage
                .conditionally_retire_candidate(
                    HOUSEHOLD,
                    token(HOUSEHOLD_TOKEN),
                    token(CANDIDATE_TOKEN),
                    request(),
                )
                .await
                .unwrap(),
            RetirementResult::Retired
        );
    }

    #[tokio::test]
    async fn retirement_rechecks_the_directory_and_excludes_every_live_id_and_key() {
        let h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        write(&h, CANDIDATE, ACTIVITY, 0, "candidate", CANDIDATE_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let source = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();

        let unchanged = RetirementAuthority {
            generation: source.generation,
            base: source.base,
            head: source.authenticated_head.clone(),
            kind: AuthorityKind::ChangedLegacy,
        };
        let protected = ProtectedLibraries { ids: HashSet::from([HOUSEHOLD.to_owned()]) };

        assert!(matches!(
            storage
                .conditionally_retire_candidate(
                    HOUSEHOLD,
                    token(HOUSEHOLD_TOKEN),
                    token(CANDIDATE_TOKEN),
                    RetirementRequest {
                        attempt: ATTEMPT,
                        source: &source,
                        authority: &unchanged,
                        profiles_row: None,
                        protected: &protected,
                        candidate_id: CANDIDATE,
                    },
                )
                .await,
            Err(MigrationError::SameLegacyFence)
        ));

        assert_eq!(
            storage.abort_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state,
            AttemptState::Aborted
        );
        assert_eq!(
            write(&h, HOUSEHOLD, DIRECTORY, 0, "sealed-committed-directory", HOUSEHOLD_TOKEN).await,
            StatusCode::OK
        );
        let household_hash = token(HOUSEHOLD_TOKEN);
        let candidate_hash = token(CANDIDATE_TOKEN);
        let snapshot = storage.locked_snapshot(HOUSEHOLD, household_hash).await.unwrap();
        let committed = RetirementAuthority {
            generation: snapshot.protocol.migration_generation,
            base: snapshot.protocol.head,
            head: authenticated_head(HOUSEHOLD, &snapshot).unwrap(),
            kind: AuthorityKind::Committed,
        };
        let row = find_row(&snapshot, DIRECTORY).unwrap().unwrap();
        let sealed = SealedProfilesRow { key: row.key, sequence: row.sequence, value: row.value };
        let includes_candidate =
            ProtectedLibraries { ids: HashSet::from([HOUSEHOLD.to_owned(), CANDIDATE.to_owned()]) };
        assert!(matches!(
            storage
                .conditionally_retire_candidate(
                    HOUSEHOLD,
                    household_hash,
                    candidate_hash,
                    RetirementRequest {
                        attempt: ATTEMPT,
                        source: &source,
                        authority: &committed,
                        profiles_row: Some(&sealed),
                        protected: &includes_candidate,
                        candidate_id: CANDIDATE,
                    },
                )
                .await,
            Err(MigrationError::ProtectedCandidate)
        ));
        assert_eq!(
            storage
                .conditionally_retire_candidate(
                    HOUSEHOLD,
                    household_hash,
                    candidate_hash,
                    RetirementRequest {
                        attempt: ATTEMPT,
                        source: &source,
                        authority: &committed,
                        profiles_row: Some(&sealed),
                        protected: &protected,
                        candidate_id: CANDIDATE,
                    },
                )
                .await
                .unwrap(),
            RetirementResult::Retired
        );
        assert_eq!(
            h.send(
                "GET",
                &format!("/lib/{CANDIDATE}/changes"),
                None,
                &[("x-den-library-token", CANDIDATE_TOKEN)],
            )
            .await
            .status(),
            StatusCode::GONE
        );
        assert_eq!(
            storage
                .conditionally_retire_candidate(
                    HOUSEHOLD,
                    household_hash,
                    candidate_hash,
                    RetirementRequest {
                        attempt: ATTEMPT,
                        source: &source,
                        authority: &committed,
                        profiles_row: Some(&sealed),
                        protected: &protected,
                        candidate_id: CANDIDATE,
                    },
                )
                .await
                .unwrap(),
            RetirementResult::Absent,
            "loser cleanup is idempotent"
        );
    }

    #[test]
    fn authenticated_authority_uses_jcs_key_order() {
        let rows = [SnapshotRow { key: ACTIVITY.into(), sequence: 1, value: "é".into() }];
        let authority = SnapshotAuthority {
            library_id: HOUSEHOLD,
            migration_generation: 7,
            head: 1,
            wire_minimum: 4,
            rows: &rows,
        };
        assert_eq!(
            String::from_utf8(canonical_json(&authority).unwrap()).unwrap(),
            format!(
                r#"{{"base":1,"generation":7,"libraryId":"{HOUSEHOLD}","rows":[{{"k":"{ACTIVITY}","seq":1,"v":"é"}}],"wireMin":4}}"#
            )
        );
    }
}
