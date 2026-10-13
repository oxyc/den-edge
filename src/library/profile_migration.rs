//! Dormant storage primitives for the one-time household/Owner split.
//!
//! There is deliberately no HTTP route or application caller in this module. These primitives implement the
//! storage guarantees beneath den-spec profiles-v1 §8.1 while keeping the feature unreachable: one-transaction
//! source snapshots, a durable/read-back-verified backup before any destination write, an exact
//! generation/base/digest fenced in-place rewrite, and retirement while the freshly checked household authority
//! remains locked.

use super::v3::{
    LibrarySnapshot, MigrationCommit, MigrationResultKind, Protocol, RestorePlan, RestoreRow, RewriteRow,
    StoreError,
};
use super::{library_store_locked, load_rewrite, owned, retire_owned_locked, v3_io};
use crate::handler::constant_time_eq;
use crate::AppState;
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct MigrationFence {
    /// Durable per-household migration counter, deliberately unrelated to public `x-den-generation`.
    pub generation: u64,
    pub base: u64,
    /// SHA-256 of the canonical current-row snapshot, including generation, head and wire minimum.
    #[serde(rename = "head")]
    pub authenticated_head: String,
    pub rewrite: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
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
    pub source: &'a MigrationFence,
    pub authority: &'a RetirementAuthority,
    pub profiles_row: Option<&'a SealedProfilesRow>,
    pub protected: &'a ProtectedLibraries,
    pub candidate_id: &'a str,
}

/// Fresh household authority supplied by the client. `kind` participates in the compare-and-swap so a committed
/// directory cannot be cleaned up through the looser changed-legacy branch.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
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
pub(crate) struct SealedProfilesRow {
    #[serde(rename = "k")]
    pub key: String,
    #[serde(rename = "seq")]
    pub sequence: u64,
    #[serde(rename = "v")]
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
    FenceChanged,
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
        household_id: &str,
        token_hash: [u8; 32],
    ) -> Result<AttemptEvidence, MigrationError> {
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
        if let Some(mut opened) = self.load_attempt(household_id, attempt).await? {
            if opened.purpose != purpose {
                return Err(MigrationError::Invalid("migration attempt purpose changed"));
            }
            let read_store = Arc::clone(&store);
            let winner = tokio::task::spawn_blocking(move || read_store.migration_winner())
                .await
                .map_err(io::Error::other)??;
            let winner = winner.filter(|winner| winner.expected_generation == opened.fence.generation);
            if opened.state == AttemptState::Open {
                if let Some(winner) = winner.as_ref() {
                    opened.state = if winner.attempt == opened.attempt {
                        match winner.kind {
                            MigrationResultKind::Committed => AttemptState::Committed,
                            MigrationResultKind::Restored => AttemptState::Restored,
                        }
                    } else {
                        AttemptState::Superseded
                    };
                    opened.terminal = Some(winner.clone());
                    self.save_attempt(&opened).await?;
                }
            }
            return Ok(AttemptEvidence {
                attempt: opened.attempt,
                state: opened.state,
                purpose: opened.purpose,
                wire_minimum: opened.wire_minimum,
                fence: opened.fence,
                winner: opened.terminal.or(winner),
            });
        }
        let read_store = Arc::clone(&store);
        let snapshot =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
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
        };
        self.save_attempt(&opened).await?;
        Ok(AttemptEvidence {
            attempt: opened.attempt,
            state: opened.state,
            purpose: opened.purpose,
            wire_minimum: opened.wire_minimum,
            fence: opened.fence,
            winner: None,
        })
    }

    async fn acquire_fence(
        &self,
        attempt: &str,
        household_id: &str,
        token_hash: [u8; 32],
    ) -> Result<MigrationFence, MigrationError> {
        Ok(self.open_attempt(attempt, AttemptPurpose::Split, household_id, token_hash).await?.fence)
    }

    /// Persist and read back the source snapshot. The attempt-scoped file is idempotent only for the same source;
    /// a retry with a changed fence refuses to overwrite the evidence from which a candidate may already derive.
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
        let opened = self
            .load_attempt(household_id, attempt)
            .await?
            .ok_or(MigrationError::Invalid("attempt is absent"))?;
        if opened.state != AttemptState::Open
            || opened.purpose != AttemptPurpose::Split
            || opened.fence != *expected
        {
            return Err(MigrationError::FenceChanged);
        }
        let read_store = Arc::clone(&store);
        let snapshot =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
        ensure_fence(household_id, &snapshot, expected)?;
        let (_, member_hash) = store.credentials();
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
            rows: snapshot_rows(&snapshot)?,
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
        self.verify_backup(household_id, expected, &reference).await?;
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

    /// Durable lookup after a response is lost during commit. The winner marker shares the redb transaction with
    /// the rewrite, so this also repairs a terminal sidecar that the process died before updating.
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
        let winner = tokio::task::spawn_blocking(move || store.migration_winner())
            .await
            .map_err(io::Error::other)??;
        let winner = winner.filter(|winner| winner.expected_generation == durable.fence.generation);
        Ok(AttemptEvidence {
            attempt: durable.attempt,
            state: durable.state,
            purpose: durable.purpose,
            wire_minimum: durable.wire_minimum,
            fence: durable.fence,
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
        let winner = tokio::task::spawn_blocking(move || read_store.migration_winner())
            .await
            .map_err(io::Error::other)??;
        let winner = winner.filter(|winner| winner.expected_generation == durable.fence.generation);
        if durable.state == AttemptState::Open {
            durable.state = match winner.as_ref() {
                Some(winner) if winner.attempt == durable.attempt => match winner.kind {
                    MigrationResultKind::Committed => AttemptState::Committed,
                    MigrationResultKind::Restored => AttemptState::Restored,
                },
                Some(_) => AttemptState::Superseded,
                None => AttemptState::Aborted,
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
            winner: durable.terminal.or(winner),
        })
    }

    /// Replace the mixed household in place. The same id and key are used; all three source authorities must still
    /// match the backup: database generation, numeric base and authenticated current-row digest.
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
        {
            return Err(MigrationError::FenceChanged);
        }
        self.verify_backup(household_id, expected, backup).await?;
        let staged_digest = self.stage_rows(household_id, expected, backup, rows).await?;
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
        {
            return Err(MigrationError::FenceChanged);
        }
        let read_store = Arc::clone(&store);
        let snapshot =
            tokio::task::spawn_blocking(move || read_store.snapshot()).await.map_err(io::Error::other)??;
        if ensure_fence(household_id, &snapshot, expected).is_err() {
            self.set_attempt_state(household_id, &backup.attempt, AttemptState::Superseded).await?;
            return Err(MigrationError::FenceChanged);
        }
        let owned_rows = rows.to_vec();
        let live_cap = self.state.library_limits.stored_bytes;
        let base = expected.base;
        let resulting_generation = expected
            .generation
            .checked_add(1)
            .ok_or(MigrationError::Invalid("migration generation exhausted"))?;
        let resulting_base =
            base.checked_add(rows.len() as u64).ok_or(MigrationError::Invalid("migration base exhausted"))?;
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
                rows,
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
            self.set_attempt_state(household_id, recovery_attempt, AttemptState::Superseded).await?;
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
        let RetirementRequest { source, authority, profiles_row, protected, candidate_id } = request;
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

    async fn save_attempt(&self, attempt: &DurableAttempt) -> Result<(), MigrationError> {
        let bytes = serde_json::to_vec(attempt).map_err(io::Error::other)?;
        self.state
            .store
            .replace_file(NS, &attempt_key(&attempt.household_id, &attempt.attempt), "json", &bytes)
            .await?;
        self.state.store.sync_dir(NS).await?;
        Ok(())
    }

    async fn set_attempt_state(
        &self,
        household_id: &str,
        attempt: &str,
        state: AttemptState,
    ) -> Result<(), MigrationError> {
        let mut durable = self
            .load_attempt(household_id, attempt)
            .await?
            .ok_or(MigrationError::Invalid("attempt is absent"))?;
        durable.state = state;
        self.save_attempt(&durable).await
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
        let winner = tokio::task::spawn_blocking(move || store.migration_winner())
            .await
            .map_err(io::Error::other)??;
        let Some(winner) = winner.filter(|winner| winner.expected_generation == attempt.fence.generation)
        else {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::Harness;
    use axum::http::StatusCode;
    use serde_json::json;

    const HOUSEHOLD: &str = "0123456789abcdef0123456789abcdef";
    const CANDIDATE: &str = "fedcba9876543210fedcba9876543210";
    const HOUSEHOLD_TOKEN: &str = "household-key";
    const CANDIDATE_TOKEN: &str = "candidate-key";
    const ACTIVITY: &str = "aaaaaaaaaaaaaaaa";
    const CONFIG: &str = "bbbbbbbbbbbbbbbb";
    const DIRECTORY: &str = "cccccccccccccccc";
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

    #[tokio::test]
    async fn backup_is_durable_readable_and_bound_to_the_exact_source_fence() {
        let h = Harness::new();
        assert_eq!(
            write(&h, HOUSEHOLD, ACTIVITY, 0, "sealed-activity", HOUSEHOLD_TOKEN).await,
            StatusCode::OK
        );
        let storage = ProfileMigrationStorage::new(&h.state);
        let source = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let concurrent = storage.acquire_fence(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert_eq!(source.generation, concurrent.generation);
        assert_eq!(source.base, concurrent.base);
        assert_eq!(source.authenticated_head, concurrent.authenticated_head);
        assert_ne!(source.rewrite, concurrent.rewrite);
        let backup = storage
            .create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &source)
            .await
            .unwrap();
        storage.verify_backup(HOUSEHOLD, &source, &backup).await.unwrap();

        assert_eq!(write(&h, HOUSEHOLD, CONFIG, 0, "later", HOUSEHOLD_TOKEN).await, StatusCode::OK);
        let changed = storage.acquire_fence(ATTEMPT3, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert_ne!(source, changed);
        assert!(matches!(
            storage.create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &changed).await,
            Err(MigrationError::FenceChanged)
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
        write(&h, HOUSEHOLD, CONFIG, 0, "household-config", HOUSEHOLD_TOKEN).await;
        let kept = vec![RewriteRow { key: CONFIG.into(), value: "household-config".into() }];
        assert!(matches!(
            storage.rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &stale, &stale_backup, &kept).await,
            Err(MigrationError::FenceChanged)
        ));

        let current = storage.acquire_fence(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let backup = storage
            .create_verified_backup(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &current)
            .await
            .unwrap();
        let rows = vec![
            RewriteRow { key: CONFIG.into(), value: "household-config".into() },
            RewriteRow { key: DIRECTORY.into(), value: "sealed-directory".into() },
        ];
        let committed = storage
            .rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &current, &backup, &rows)
            .await
            .unwrap();
        assert_eq!(committed.wire_min, 5);
        assert_eq!(committed.head, current.base + 2);
        assert_eq!(
            h.state.library_v3.credentials(HOUSEHOLD).unwrap().unwrap().0,
            token(HOUSEHOLD_TOKEN),
            "the in-place split keeps the household id and key"
        );
        let winner = storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT2).await.unwrap();
        assert_eq!(winner.state, AttemptState::Committed);
        let winner = winner.winner.unwrap();
        assert_eq!(winner.resulting_base, committed.head);
        assert_eq!(winner.resulting_generation, committed.migration_generation);
        assert_eq!(winner.staged_digest, Some(staged_digest(&rows).unwrap()));

        let loser = storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap();
        assert_eq!(loser.state, AttemptState::Superseded);

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
            storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state,
            AttemptState::Open
        );
        assert_eq!(
            storage.abort_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state,
            AttemptState::Aborted
        );
    }

    #[tokio::test]
    async fn concurrent_attempts_share_a_snapshot_and_only_one_matching_commit_wins() {
        let h = Harness::new();
        write(&h, HOUSEHOLD, ACTIVITY, 0, "legacy", HOUSEHOLD_TOKEN).await;
        let storage = ProfileMigrationStorage::new(&h.state);
        let (first, repeated) = tokio::join!(
            storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)),
            storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN))
        );
        assert_eq!(first.unwrap(), repeated.unwrap(), "one attempt id has one durable rewrite handle");

        let one = storage.acquire_fence(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        let two = storage.acquire_fence(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN)).await.unwrap();
        assert_eq!(
            (one.generation, one.base, &one.authenticated_head),
            (two.generation, two.base, &two.authenticated_head)
        );
        let backup_one =
            storage.create_verified_backup(ATTEMPT, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &one).await.unwrap();
        let backup_two =
            storage.create_verified_backup(ATTEMPT2, HOUSEHOLD, token(HOUSEHOLD_TOKEN), &two).await.unwrap();
        let rows = [RewriteRow { key: CONFIG.into(), value: "kept".into() }];
        let (commit_one, commit_two) = tokio::join!(
            storage.rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &one, &backup_one, &rows),
            storage.rewrite_household(HOUSEHOLD, token(HOUSEHOLD_TOKEN), &two, &backup_two, &rows)
        );
        assert_ne!(commit_one.is_ok(), commit_two.is_ok());
        assert!(matches!(commit_one, Ok(_) | Err(MigrationError::FenceChanged)));
        assert!(matches!(commit_two, Ok(_) | Err(MigrationError::FenceChanged)));

        let state_one =
            storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT).await.unwrap().state;
        let state_two =
            storage.lookup_attempt(HOUSEHOLD, token(HOUSEHOLD_TOKEN), ATTEMPT2).await.unwrap().state;
        assert!(matches!(
            (state_one, state_two),
            (AttemptState::Committed, AttemptState::Superseded)
                | (AttemptState::Superseded, AttemptState::Committed)
        ));
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

        let recovery = storage
            .open_attempt(ATTEMPT3, AttemptPurpose::Restore, HOUSEHOLD, token(HOUSEHOLD_TOKEN))
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

        write(&h, HOUSEHOLD, DIRECTORY, 0, "sealed-committed-directory", HOUSEHOLD_TOKEN).await;
        let household_hash = token(HOUSEHOLD_TOKEN);
        let candidate_hash = token(CANDIDATE_TOKEN);
        let fresh = storage.acquire_fence(ATTEMPT2, HOUSEHOLD, household_hash).await.unwrap();
        let committed = RetirementAuthority {
            generation: fresh.generation,
            base: fresh.base,
            head: fresh.authenticated_head.clone(),
            kind: AuthorityKind::Committed,
        };
        let snapshot = storage.locked_snapshot(HOUSEHOLD, household_hash).await.unwrap();
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
