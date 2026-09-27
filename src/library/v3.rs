//! Transactional library-v3 storage: one independently writable redb database per library.

use super::{
    constant_time_eq, row_bytes, row_fragment, valid_hex_id, LIBRARY_OVERHEAD, MAX_LIMIT, MAX_ROWS,
    MAX_VALUE, MAX_WRITES, PAGE_BYTES,
};
use axum::body::Bytes;
use redb::backends::FileBackend;
use redb::{
    BackendError, Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, StorageBackend,
    TableDefinition,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io;
use std::ops::Bound::{Excluded, Unbounded};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::sync::{OnceLock, Weak};

const FORMAT_VERSION: u64 = 3;
pub(super) const DATABASE_CACHE_BYTES: usize = 64 * 1024;
pub(super) const OPEN_DATABASE_BYTES: usize = 112 * 1024;
const KEYS: TableDefinition<&str, u64> = TableDefinition::new("keys-v3");
/// The exact v2-compatible memory charge of each live row. Keeping this beside the key index lets a write enforce
/// the same 8 MiB semantic library bound without parsing canonical JSON or confusing redb's cache with live data.
const CHARGES: TableDefinition<&str, u64> = TableDefinition::new("charges-v3");
const SEQUENCE: TableDefinition<u64, &[u8]> = TableDefinition::new("sequence-v3");
const META_U64: TableDefinition<&str, u64> = TableDefinition::new("metadata-u64-v3");
const META_BYTES: TableDefinition<&str, &[u8]> = TableDefinition::new("metadata-bytes-v3");
type Credentials = ([u8; 32], Option<[u8; 32]>);

#[derive(Debug)]
pub(crate) enum StoreError {
    Full,
    Forbidden,
    Invalid(String),
    Failed(String),
}

impl StoreError {
    fn io(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::StorageFull {
            Self::Full
        } else {
            Self::Failed(error.to_string())
        }
    }

    fn redb(error: impl Into<redb::Error>) -> Self {
        match error.into() {
            redb::Error::Io(error) if error.kind() == io::ErrorKind::StorageFull => Self::Full,
            error => Self::Failed(error.to_string()),
        }
    }
}

#[derive(Clone)]
pub(super) struct Write {
    pub key: String,
    pub base: u64,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StoredRow {
    pub sequence: u64,
    pub fragment: Arc<[u8]>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Conflict {
    pub key: String,
    pub current: Option<StoredRow>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct BatchResult {
    pub head: u64,
    pub applied: Vec<(String, u64)>,
    pub conflicts: Vec<Conflict>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct RangePage {
    pub entries: Vec<StoredRow>,
    pub head: u64,
    pub more: bool,
}

pub(super) struct ChunkPage {
    pub chunks: Vec<Bytes>,
    pub len: usize,
}

pub(super) trait LibraryStore: Send + Sync {
    #[cfg(test)]
    fn apply(&self, writes: &[Write]) -> Result<BatchResult, StoreError> {
        self.apply_bounded(writes, 8 << 20)
    }
    fn apply_bounded(&self, writes: &[Write], live_cap: usize) -> Result<BatchResult, StoreError>;
    #[cfg(test)]
    fn latest(&self, key: &str) -> Result<Option<StoredRow>, StoreError>;
    fn range(&self, since: u64, limit: usize) -> Result<RangePage, StoreError>;
    fn range_chunks(&self, since: u64, limit: usize, generation: &str) -> Result<ChunkPage, StoreError>;
    #[cfg(test)]
    fn disk_bytes(&self) -> Result<u64, StoreError>;
    #[cfg(test)]
    fn live_bytes(&self) -> Result<usize, StoreError>;
    fn credentials(&self) -> Credentials;
    fn register_member(&self, member_hash: [u8; 32]) -> Result<bool, StoreError>;
}

/// Aggregate disk reservation shared by every v3 database. File growth is reserved atomically before redb may
/// perform it, so independent library writers cannot each consume the last bytes.
#[derive(Debug)]
struct DiskQuota(crate::store::Quota);

impl DiskQuota {
    fn resize(&self, old: u64, new: u64) -> io::Result<()> {
        self.0.resize(super::NS, old, new)
    }
}

#[derive(Debug)]
struct QuotaBackend {
    inner: FileBackend,
    quota: Arc<DiskQuota>,
    file_cap: u64,
}

impl StorageBackend for QuotaBackend {
    fn len(&self) -> io::Result<u64> {
        self.inner.len()
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        self.inner.read(offset, out)
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        if len > self.file_cap {
            return Err(io::ErrorKind::StorageFull.into());
        }
        let old = self.inner.len()?;
        if len > old {
            self.quota.resize(old, len)?;
            if let Err(error) = self.inner.set_len(len) {
                self.quota.resize(len, old).expect("releasing disk reservation cannot fail");
                return Err(error);
            }
        } else if len < old {
            self.inner.set_len(len)?;
            self.quota.resize(old, len)?;
        }
        Ok(())
    }

    fn sync_data(&self) -> io::Result<()> {
        self.inner.sync_data()
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        let end = offset.checked_add(data.len() as u64).ok_or(io::ErrorKind::StorageFull)?;
        if end > self.file_cap || end > self.inner.len()? {
            return Err(io::ErrorKind::StorageFull.into());
        }
        self.inner.write(offset, data)
    }

    fn close(&self) -> io::Result<()> {
        self.inner.close()
    }

    fn try_lock_range(
        &self,
        start: std::ops::Bound<u64>,
        end: std::ops::Bound<u64>,
    ) -> Result<bool, BackendError> {
        self.inner.try_lock_range(start, end)
    }

    fn try_lock_shared_range(
        &self,
        start: std::ops::Bound<u64>,
        end: std::ops::Bound<u64>,
    ) -> Result<bool, BackendError> {
        self.inner.try_lock_shared_range(start, end)
    }

    fn lock_range(&self, start: std::ops::Bound<u64>, end: std::ops::Bound<u64>) -> Result<(), BackendError> {
        self.inner.lock_range(start, end)
    }

    fn lock_shared_range(
        &self,
        start: std::ops::Bound<u64>,
        end: std::ops::Bound<u64>,
    ) -> Result<(), BackendError> {
        self.inner.lock_shared_range(start, end)
    }

    fn unlock_range(
        &self,
        start: std::ops::Bound<u64>,
        end: std::ops::Bound<u64>,
    ) -> Result<(), BackendError> {
        self.inner.unlock_range(start, end)
    }

    fn query_lock_range(
        &self,
        start: std::ops::Bound<u64>,
        end: std::ops::Bound<u64>,
    ) -> Result<bool, BackendError> {
        self.inner.query_lock_range(start, end)
    }
}

struct RedbLibrary {
    database: Database,
    #[cfg(test)]
    path: PathBuf,
    token_hash: [u8; 32],
    member_hash: Mutex<Option<[u8; 32]>>,
}

/// redb intentionally permits one open handle per file. Tests model a restart by constructing a second AppState
/// before dropping the first, and embedded users may do the same during a graceful handoff, so managers in this
/// process share that handle rather than treating it as corruption.
fn process_databases() -> &'static Mutex<HashMap<PathBuf, Weak<RedbLibrary>>> {
    static DATABASES: OnceLock<Mutex<HashMap<PathBuf, Weak<RedbLibrary>>>> = OnceLock::new();
    DATABASES.get_or_init(|| Mutex::new(HashMap::new()))
}

impl RedbLibrary {
    fn open(
        path: &Path,
        quota: Arc<DiskQuota>,
        file_cap: u64,
        token_hash: [u8; 32],
        initial_member_hash: Option<[u8; 32]>,
    ) -> Result<Self, StoreError> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(StoreError::io)?;
        let backend =
            QuotaBackend { inner: FileBackend::new(file).map_err(StoreError::redb)?, quota, file_cap };
        let mut builder = Database::builder();
        builder.set_cache_size(DATABASE_CACHE_BYTES);
        let database = builder.create_with_backend(backend).map_err(StoreError::redb)?;
        let transaction = database.begin_write().map_err(StoreError::redb)?;
        let version = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let value = metadata.get("format").map_err(StoreError::redb)?.map(|value| value.value());
            value
        };
        let member_hash;
        if let Some(version) = version {
            if version != FORMAT_VERSION {
                return Err(StoreError::Invalid(format!("unsupported library format {version}")));
            }
            {
                let metadata = transaction.open_table(META_BYTES).map_err(StoreError::redb)?;
                let stored_token = metadata
                    .get("token")
                    .map_err(StoreError::redb)?
                    .ok_or_else(|| StoreError::Invalid("v3 token is missing".into()))?;
                if !constant_time_eq(stored_token.value(), &token_hash) {
                    return Err(StoreError::Forbidden);
                }
                let stored_member = metadata.get("member").map_err(StoreError::redb)?;
                member_hash = stored_member.as_ref().map(|stored| stored.value().try_into().unwrap());
            }
            transaction.abort().map_err(StoreError::redb)?;
        } else {
            member_hash = initial_member_hash;
            {
                let mut numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
                numbers.insert("format", FORMAT_VERSION).map_err(StoreError::redb)?;
                numbers.insert("head", 0).map_err(StoreError::redb)?;
                let mut bytes = transaction.open_table(META_BYTES).map_err(StoreError::redb)?;
                bytes.insert("token", token_hash.as_slice()).map_err(StoreError::redb)?;
                if let Some(member) = initial_member_hash {
                    bytes.insert("member", member.as_slice()).map_err(StoreError::redb)?;
                }
                transaction.open_table(KEYS).map_err(StoreError::redb)?;
                transaction.open_table(CHARGES).map_err(StoreError::redb)?;
                transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
            }
            transaction.commit().map_err(StoreError::redb)?;
        }
        Ok(Self {
            database,
            #[cfg(test)]
            path: path.to_owned(),
            token_hash,
            member_hash: Mutex::new(member_hash),
        })
    }

    fn row(&self, sequence: u64, fragment: &[u8]) -> StoredRow {
        StoredRow { sequence, fragment: Arc::from(fragment) }
    }

    fn accepts(&self, token_hash: &[u8; 32]) -> bool {
        constant_time_eq(&self.token_hash, token_hash)
    }
}

impl LibraryStore for RedbLibrary {
    fn apply_bounded(&self, writes: &[Write], live_cap: usize) -> Result<BatchResult, StoreError> {
        let mut unique = HashSet::with_capacity(writes.len());
        if writes.len() > MAX_WRITES
            || writes.iter().any(|write| {
                write.value.len() > MAX_VALUE
                    || !valid_hex_id(&write.key)
                    || !unique.insert(write.key.as_str())
            })
        {
            return Err(StoreError::Invalid("invalid or duplicate v3 write".into()));
        }
        let transaction = self.database.begin_write().map_err(StoreError::redb)?;
        let mut head = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let value = metadata
                .get("head")
                .map_err(StoreError::redb)?
                .ok_or_else(|| StoreError::Invalid("v3 head is missing".into()))?;
            value.value()
        };
        let live_rows = {
            let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            keys.len().map_err(StoreError::redb)?
        };
        let mut accepted = Vec::new();
        let mut conflicts = Vec::new();
        let mut accepted_new_rows = 0u64;
        let mut live_bytes = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let bytes = metadata
                .get("live-bytes")
                .map_err(StoreError::redb)?
                .map_or(LIBRARY_OVERHEAD as u64, |value| value.value());
            bytes
        };
        {
            let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            let charges = transaction.open_table(CHARGES).map_err(StoreError::redb)?;
            let sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
            for write in writes {
                let current_sequence =
                    keys.get(write.key.as_str()).map_err(StoreError::redb)?.map(|v| v.value());
                if current_sequence.unwrap_or(0) != write.base {
                    let current = current_sequence
                        .map(|current| {
                            let fragment = sequence
                                .get(current)
                                .map_err(StoreError::redb)?
                                .ok_or_else(|| StoreError::Invalid("v3 key points to no fragment".into()))?;
                            Ok::<_, StoreError>(self.row(current, fragment.value()))
                        })
                        .transpose()?;
                    conflicts.push(Conflict { key: write.key.clone(), current });
                    continue;
                }
                head = head.checked_add(1).ok_or_else(|| StoreError::Invalid("v3 head overflow".into()))?;
                let fragment = row_fragment(head, &write.key, &write.value);
                let old_charge = charges
                    .get(write.key.as_str())
                    .map_err(StoreError::redb)?
                    .map_or(0, |value| value.value());
                let charge = u64::try_from(row_bytes(&write.key, &write.value, fragment.len()))
                    .map_err(|_| StoreError::Full)?;
                live_bytes = live_bytes
                    .checked_sub(old_charge)
                    .and_then(|bytes| bytes.checked_add(charge))
                    .ok_or_else(|| StoreError::Invalid("v3 live-byte accounting overflow".into()))?;
                accepted_new_rows += u64::from(current_sequence.is_none());
                accepted.push((write, current_sequence, head, fragment, charge));
            }
        }
        if live_rows + accepted_new_rows > MAX_ROWS as u64
            || live_bytes > u64::try_from(live_cap).map_err(|_| StoreError::Full)?
        {
            return Err(StoreError::Full);
        }
        {
            let mut keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            let mut charges = transaction.open_table(CHARGES).map_err(StoreError::redb)?;
            let mut sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
            for (write, old, new, fragment, charge) in &accepted {
                if let Some(old) = old {
                    sequence.remove(*old).map_err(StoreError::redb)?;
                }
                sequence.insert(*new, fragment.as_ref()).map_err(StoreError::redb)?;
                keys.insert(write.key.as_str(), *new).map_err(StoreError::redb)?;
                charges.insert(write.key.as_str(), *charge).map_err(StoreError::redb)?;
            }
        }
        {
            let mut metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            metadata.insert("head", head).map_err(StoreError::redb)?;
            metadata.insert("live-bytes", live_bytes).map_err(StoreError::redb)?;
        }
        transaction.commit().map_err(StoreError::redb)?;
        Ok(BatchResult {
            head,
            applied: accepted.into_iter().map(|(write, _, seq, _, _)| (write.key.clone(), seq)).collect(),
            conflicts,
        })
    }

    #[cfg(test)]
    fn latest(&self, key: &str) -> Result<Option<StoredRow>, StoreError> {
        let transaction = self.database.begin_read().map_err(StoreError::redb)?;
        let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
        let Some(sequence_number) = keys.get(key).map_err(StoreError::redb)?.map(|value| value.value())
        else {
            return Ok(None);
        };
        let sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
        let fragment = sequence
            .get(sequence_number)
            .map_err(StoreError::redb)?
            .ok_or_else(|| StoreError::Invalid("v3 key points to no fragment".into()))?;
        Ok(Some(self.row(sequence_number, fragment.value())))
    }

    fn range(&self, since: u64, limit: usize) -> Result<RangePage, StoreError> {
        let transaction = self.database.begin_read().map_err(StoreError::redb)?;
        let head = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let value = metadata
                .get("head")
                .map_err(StoreError::redb)?
                .ok_or_else(|| StoreError::Invalid("v3 head is missing".into()))?;
            value.value()
        };
        let sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
        let mut rows = sequence.range((Excluded(since), Unbounded)).map_err(StoreError::redb)?;
        let mut entries = Vec::new();
        let mut page_bytes = 128usize;
        let mut more = false;
        while entries.len() < limit.min(MAX_LIMIT) {
            let Some(item) = rows.next() else { break };
            let (stored_sequence, fragment) = item.map_err(StoreError::redb)?;
            let cost = fragment.value().len() + usize::from(!entries.is_empty());
            if !entries.is_empty() && page_bytes + cost > PAGE_BYTES {
                more = true;
                break;
            }
            page_bytes += cost;
            entries.push(self.row(stored_sequence.value(), fragment.value()));
        }
        if !more {
            more = rows.next().transpose().map_err(StoreError::redb)?.is_some();
        }
        Ok(RangePage { entries, head, more })
    }

    fn range_chunks(&self, since: u64, limit: usize, generation: &str) -> Result<ChunkPage, StoreError> {
        const CHUNK_BYTES: usize = 64 * 1024;

        fn append(chunks: &mut Vec<Vec<u8>>, mut bytes: &[u8]) {
            while !bytes.is_empty() {
                if chunks.last().is_none_or(|chunk| chunk.len() == CHUNK_BYTES) {
                    chunks.push(Vec::with_capacity(CHUNK_BYTES));
                }
                let chunk = chunks.last_mut().unwrap();
                let taking = bytes.len().min(CHUNK_BYTES - chunk.len());
                chunk.extend_from_slice(&bytes[..taking]);
                bytes = &bytes[taking..];
            }
        }

        let transaction = self.database.begin_read().map_err(StoreError::redb)?;
        let head = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let value = metadata
                .get("head")
                .map_err(StoreError::redb)?
                .ok_or_else(|| StoreError::Invalid("v3 head is missing".into()))?;
            value.value()
        };
        let sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
        let mut rows = sequence.range((Excluded(since), Unbounded)).map_err(StoreError::redb)?;
        let mut chunks = vec![Vec::with_capacity(CHUNK_BYTES)];
        append(&mut chunks, br#"{"entries":["#);
        let mut entries = 0usize;
        let mut page_bytes = 128usize;
        let mut more = false;
        while entries < limit.min(MAX_LIMIT) {
            let Some(item) = rows.next() else { break };
            let (_, fragment) = item.map_err(StoreError::redb)?;
            let cost = fragment.value().len() + usize::from(entries != 0);
            if entries != 0 && page_bytes + cost > PAGE_BYTES {
                more = true;
                break;
            }
            if entries != 0 {
                append(&mut chunks, b",");
            }
            append(&mut chunks, fragment.value());
            page_bytes += cost;
            entries += 1;
        }
        if !more {
            more = rows.next().transpose().map_err(StoreError::redb)?.is_some();
        }
        let suffix = format!(r#"],"head":{head},"more":{more},"generation":"{generation}"}}"#);
        append(&mut chunks, suffix.as_bytes());
        let len = chunks.iter().map(Vec::len).sum();
        Ok(ChunkPage { chunks: chunks.into_iter().map(Bytes::from).collect(), len })
    }

    #[cfg(test)]
    fn disk_bytes(&self) -> Result<u64, StoreError> {
        Ok(std::fs::metadata(&self.path).map_err(StoreError::io)?.len())
    }

    #[cfg(test)]
    fn live_bytes(&self) -> Result<usize, StoreError> {
        let transaction = self.database.begin_read().map_err(StoreError::redb)?;
        let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
        let bytes = metadata
            .get("live-bytes")
            .map_err(StoreError::redb)?
            .map_or(LIBRARY_OVERHEAD as u64, |value| value.value());
        usize::try_from(bytes).map_err(|_| StoreError::Full)
    }

    fn credentials(&self) -> Credentials {
        (self.token_hash, *self.member_hash.lock().unwrap())
    }

    fn register_member(&self, member_hash: [u8; 32]) -> Result<bool, StoreError> {
        let mut cached = self.member_hash.lock().unwrap();
        if let Some(stored) = *cached {
            return if constant_time_eq(&stored, &member_hash) {
                Ok(false)
            } else {
                Err(StoreError::Invalid("member_already_registered".into()))
            };
        }
        let transaction = self.database.begin_write().map_err(StoreError::redb)?;
        transaction
            .open_table(META_BYTES)
            .map_err(StoreError::redb)?
            .insert("member", member_hash.as_slice())
            .map_err(StoreError::redb)?;
        transaction.commit().map_err(StoreError::redb)?;
        *cached = Some(member_hash);
        Ok(true)
    }
}

struct Slot {
    store: Mutex<Option<Arc<RedbLibrary>>>,
    last_used: AtomicU64,
}

struct Registry {
    slots: HashMap<String, Arc<Slot>>,
    bytes: usize,
}

/// Lazily opens independent databases and charges their measured fixed residency before opening. An active lease
/// pins only its library. Eviction closes an inactive database without blocking another library's writer.
pub(crate) struct StoreManager {
    root: PathBuf,
    registry: Mutex<Registry>,
    clock: AtomicU64,
    memory_cap: usize,
    file_cap: u64,
    quota: Arc<DiskQuota>,
}

impl StoreManager {
    #[cfg(test)]
    pub(super) fn open(
        root: &Path,
        memory_cap: usize,
        disk_cap: u64,
        file_cap: u64,
    ) -> Result<Self, StoreError> {
        std::fs::create_dir_all(root).map_err(StoreError::io)?;
        let mut used = 0u64;
        for entry in std::fs::read_dir(root).map_err(StoreError::io)? {
            let entry = entry.map_err(StoreError::io)?;
            if entry.path().extension().and_then(|value| value.to_str()) == Some("redb") {
                used = used
                    .checked_add(entry.metadata().map_err(StoreError::io)?.len())
                    .ok_or(StoreError::Full)?;
            }
        }
        if used > disk_cap || file_cap > disk_cap || memory_cap < OPEN_DATABASE_BYTES {
            return Err(StoreError::Full);
        }
        Ok(Self {
            root: root.to_owned(),
            registry: Mutex::new(Registry { slots: HashMap::new(), bytes: 0 }),
            clock: AtomicU64::new(1),
            memory_cap,
            file_cap,
            quota: Arc::new(DiskQuota(crate::store::Quota::standalone_with_used(disk_cap, used))),
        })
    }

    /// Production manager: existing files were counted when `Store` opened, and every later redb growth shares
    /// that exact global reservation with inboxes, grants, and the other namespaces.
    pub(crate) fn open_shared(
        root: &Path,
        memory_cap: usize,
        quota: crate::store::Quota,
        file_cap: u64,
    ) -> Result<Self, StoreError> {
        std::fs::create_dir_all(root).map_err(StoreError::io)?;
        if memory_cap < OPEN_DATABASE_BYTES {
            return Err(StoreError::Full);
        }
        Ok(Self {
            root: root.to_owned(),
            registry: Mutex::new(Registry { slots: HashMap::new(), bytes: 0 }),
            clock: AtomicU64::new(1),
            memory_cap,
            file_cap,
            quota: Arc::new(DiskQuota(quota)),
        })
    }

    /// Build a complete v3 authority beside the v2 log, then publish only the database filename. The caller must
    /// durably publish the format marker afterwards; until that marker exists this file is deliberately ignored.
    pub(super) fn import_v2(&self, id: &str, library: &super::Library) -> Result<(), StoreError> {
        let final_path = self.path(id);
        let temporary = final_path.with_extension("redb.tmp");
        self.remove_path(&temporary)?;
        self.remove_path(&final_path)?;
        {
            let store = RedbLibrary::open(
                &temporary,
                Arc::clone(&self.quota),
                self.file_cap,
                library.token_hash,
                library.member_hash,
            )?;
            let transaction = store.database.begin_write().map_err(StoreError::redb)?;
            {
                let mut keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
                let mut charges = transaction.open_table(CHARGES).map_err(StoreError::redb)?;
                let mut sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
                for (key, row) in &library.rows {
                    keys.insert(key.as_str(), row.seq).map_err(StoreError::redb)?;
                    charges
                        .insert(
                            key.as_str(),
                            u64::try_from(row_bytes(key, &row.v, row.fragment.len()))
                                .map_err(|_| StoreError::Full)?,
                        )
                        .map_err(StoreError::redb)?;
                    sequence.insert(row.seq, row.fragment.as_ref()).map_err(StoreError::redb)?;
                }
                let mut metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
                metadata.insert("head", library.head).map_err(StoreError::redb)?;
                metadata
                    .insert("live-bytes", u64::try_from(library.bytes).map_err(|_| StoreError::Full)?)
                    .map_err(StoreError::redb)?;
            }
            transaction.commit().map_err(StoreError::redb)?;
        }
        std::fs::File::open(&temporary).and_then(|file| file.sync_all()).map_err(StoreError::io)?;
        std::fs::rename(&temporary, &final_path).map_err(StoreError::io)?;
        std::fs::File::open(&self.root).and_then(|dir| dir.sync_all()).map_err(StoreError::io)
    }

    /// Remove unpublished or retired database bytes and any inactive cache entry, refunding the shared disk cap.
    pub(super) fn remove(&self, id: &str) -> Result<(), StoreError> {
        {
            let mut registry = self.registry.lock().unwrap();
            if let Some(slot) = registry.slots.get(id).cloned() {
                let mut store = slot.store.try_lock().map_err(|_| StoreError::Full)?;
                if store.as_ref().is_some_and(|store| Arc::strong_count(store) != 1) {
                    return Err(StoreError::Full);
                }
                let removed_open = store.take().is_some();
                drop(store);
                if removed_open {
                    registry.bytes -= OPEN_DATABASE_BYTES;
                }
            }
            registry.slots.remove(id);
        }
        self.remove_path(&self.path(id))?;
        self.remove_path(&self.path(id).with_extension("redb.tmp"))
    }

    /// Read and then cache credentials without knowing the owner token in advance. This is used by membership
    /// checks; after the first check the ordinary bounded manager entry answers without opening the file again.
    pub(super) fn credentials(&self, id: &str) -> Result<Option<Credentials>, StoreError> {
        let slot = self.registry.lock().unwrap().slots.get(id).cloned();
        if let Some(store) = slot.and_then(|slot| slot.store.lock().unwrap().clone()) {
            return Ok(Some(store.credentials()));
        }
        let path = self.path(id);
        if !path.exists() {
            return Ok(None);
        }
        let shared = process_databases().lock().unwrap().get(&path).and_then(Weak::upgrade);
        if let Some(store) = shared {
            let credentials = store.credentials();
            let _ = self.library(id, credentials.0)?;
            return Ok(Some(credentials));
        }
        let file = std::fs::OpenOptions::new().read(true).write(true).open(&path).map_err(StoreError::io)?;
        let backend = QuotaBackend {
            inner: FileBackend::new(file).map_err(StoreError::redb)?,
            quota: Arc::clone(&self.quota),
            file_cap: self.file_cap,
        };
        let mut builder = Database::builder();
        builder.set_cache_size(DATABASE_CACHE_BYTES);
        let database = builder.create_with_backend(backend).map_err(StoreError::redb)?;
        let transaction = database.begin_read().map_err(StoreError::redb)?;
        let metadata = transaction.open_table(META_BYTES).map_err(StoreError::redb)?;
        let token: [u8; 32] = metadata
            .get("token")
            .map_err(StoreError::redb)?
            .ok_or_else(|| StoreError::Invalid("v3 token is missing".into()))?
            .value()
            .try_into()
            .map_err(|_| StoreError::Invalid("v3 token has the wrong size".into()))?;
        let member = metadata
            .get("member")
            .map_err(StoreError::redb)?
            .map(|value| value.value().try_into())
            .transpose()
            .map_err(|_| StoreError::Invalid("v3 member proof has the wrong size".into()))?;
        drop(metadata);
        drop(transaction);
        drop(database);
        let store = self.library(id, token)?;
        debug_assert_eq!(store.credentials(), (token, member));
        Ok(Some((token, member)))
    }

    fn remove_path(&self, path: &Path) -> Result<(), StoreError> {
        let bytes = std::fs::metadata(path).map_or(0, |metadata| metadata.len());
        match std::fs::remove_file(path) {
            Ok(()) => self.quota.resize(bytes, 0).map_err(StoreError::io),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StoreError::io(error)),
        }
    }

    pub(super) fn library(
        &self,
        id: &str,
        token_hash: [u8; 32],
    ) -> Result<Arc<dyn LibraryStore>, StoreError> {
        if !valid_hex_id(id) {
            return Err(StoreError::Invalid("invalid v3 library id".into()));
        }
        let now = self.clock.fetch_add(1, Ordering::Relaxed);
        let (slot, inserted) = {
            let mut registry = self.registry.lock().unwrap();
            match registry.slots.entry(id.to_owned()) {
                std::collections::hash_map::Entry::Occupied(entry) => (Arc::clone(entry.get()), false),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let slot = Arc::new(Slot { store: Mutex::new(None), last_used: AtomicU64::new(now) });
                    entry.insert(Arc::clone(&slot));
                    (slot, true)
                }
            }
        };
        slot.last_used.store(now, Ordering::Relaxed);
        let mut stored = slot.store.lock().unwrap();
        if let Some(store) = stored.as_ref() {
            if !store.accepts(&token_hash) {
                return Err(StoreError::Forbidden);
            }
            let store: Arc<dyn LibraryStore> = Arc::clone(store) as Arc<dyn LibraryStore>;
            return Ok(store);
        }
        let path = self.path(id);
        self.remove_path(&path.with_extension("redb.tmp"))?;
        if let Err(error) = self.reserve_open(id) {
            if inserted {
                let mut registry = self.registry.lock().unwrap();
                if registry.slots.get(id).is_some_and(|registered| Arc::ptr_eq(registered, &slot))
                    && Arc::strong_count(&slot) == 2
                    && stored.is_none()
                {
                    registry.slots.remove(id);
                }
            }
            return Err(error);
        }
        if let Some(store) = process_databases().lock().unwrap().get(&path).and_then(Weak::upgrade) {
            if !store.accepts(&token_hash) {
                let mut registry = self.registry.lock().unwrap();
                registry.bytes -= OPEN_DATABASE_BYTES;
                registry.slots.remove(id);
                return Err(StoreError::Forbidden);
            }
            *stored = Some(Arc::clone(&store));
            return Ok(store);
        }
        let created = !path.exists();
        match RedbLibrary::open(&path, Arc::clone(&self.quota), self.file_cap, token_hash, None) {
            Ok(store) => {
                let store = Arc::new(store);
                process_databases().lock().unwrap().insert(path, Arc::downgrade(&store));
                *stored = Some(Arc::clone(&store));
                Ok(store)
            }
            Err(error) => {
                let mut registry = self.registry.lock().unwrap();
                registry.bytes -= OPEN_DATABASE_BYTES;
                if registry.slots.get(id).is_some_and(|registered| Arc::ptr_eq(registered, &slot)) {
                    registry.slots.remove(id);
                }
                if created {
                    let bytes = std::fs::metadata(&path).map_or(0, |metadata| metadata.len());
                    if std::fs::remove_file(&path).is_ok() {
                        self.quota.resize(bytes, 0).map_err(StoreError::io)?;
                    }
                }
                Err(error)
            }
        }
    }

    pub(super) fn path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{}.redb", crate::hex(&Sha256::digest(id.as_bytes()))))
    }

    fn reserve_open(&self, id: &str) -> Result<(), StoreError> {
        let mut registry = self.registry.lock().unwrap();
        while registry.bytes + OPEN_DATABASE_BYTES > self.memory_cap {
            let mut candidates: Vec<_> = registry
                .slots
                .iter()
                .filter(|(candidate, _)| candidate.as_str() != id)
                .map(|(candidate, slot)| (candidate.clone(), Arc::clone(slot)))
                .collect();
            candidates.sort_by_key(|(_, slot)| slot.last_used.load(Ordering::Relaxed));
            let mut removed = false;
            for (key, candidate) in candidates {
                let Ok(mut store) = candidate.store.try_lock() else { continue };
                if Arc::strong_count(&candidate) == 2
                    && store.as_ref().is_some_and(|store| Arc::strong_count(store) == 1)
                {
                    store.take();
                    registry.bytes -= OPEN_DATABASE_BYTES;
                    registry.slots.remove(&key);
                    removed = true;
                    break;
                }
            }
            if !removed {
                return Err(StoreError::Full);
            }
        }
        registry.bytes += OPEN_DATABASE_BYTES;
        Ok(())
    }

    #[cfg(test)]
    fn cached(&self) -> (usize, usize, usize) {
        let registry = self.registry.lock().unwrap();
        let open = registry.slots.values().filter(|slot| slot.store.lock().unwrap().is_some()).count();
        (open, registry.bytes, registry.slots.len())
    }

    #[cfg(test)]
    pub(crate) fn clear(&self) {
        let mut registry = self.registry.lock().unwrap();
        registry.slots.clear();
        registry.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::tests::temp_dir;

    const TOKEN: [u8; 32] = [7; 32];
    const K1: &str = "aaaaaaaaaaaaaaaa";
    const K2: &str = "bbbbbbbbbbbbbbbb";

    fn manager(root: &Path, open: usize, disk: u64, file: u64) -> StoreManager {
        StoreManager::open(root, open * OPEN_DATABASE_BYTES, disk, file).unwrap()
    }

    fn value(row: &StoredRow) -> serde_json::Value {
        serde_json::from_slice(&row.fragment).unwrap()
    }

    #[test]
    fn latest_range_cas_and_reopen_keep_one_authoritative_fragment() {
        let dir = temp_dir();
        let id = "1111111111111111";
        let first = manager(&dir, 4, 32 << 20, 8 << 20);
        let store = first.library(id, TOKEN).unwrap();
        assert_eq!(
            store.apply(&[Write { key: K1.into(), base: 0, value: "one".into() }]).unwrap().applied,
            vec![(K1.into(), 1)]
        );
        let conflict = store.apply(&[Write { key: K1.into(), base: 0, value: "lost".into() }]).unwrap();
        assert_eq!(value(conflict.conflicts[0].current.as_ref().unwrap())["v"], "one");
        store
            .apply(&[
                Write { key: K1.into(), base: 1, value: "two".into() },
                Write { key: K2.into(), base: 0, value: "three".into() },
            ])
            .unwrap();
        assert_eq!(store.range(0, 500).unwrap().entries.len(), 2);
        drop(store);
        drop(first);

        let reopened = manager(&dir, 4, 32 << 20, 8 << 20);
        let store = reopened.library(id, TOKEN).unwrap();
        assert!(matches!(reopened.library(id, [8; 32]), Err(StoreError::Forbidden)));
        let page = store.range(0, 500).unwrap();
        assert_eq!(page.head, 3);
        assert_eq!(page.entries.iter().map(|row| row.sequence).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(value(&store.latest(K1).unwrap().unwrap())["v"], "two");
    }

    #[test]
    fn a_batch_is_old_or_new_across_abort_and_durable_reopen() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("crash.redb");
        let quota = Arc::new(DiskQuota(crate::store::Quota::standalone(32 << 20)));
        let store = RedbLibrary::open(&path, Arc::clone(&quota), 8 << 20, TOKEN, None).unwrap();
        store.apply(&[Write { key: K1.into(), base: 0, value: "old".into() }]).unwrap();
        {
            let transaction = store.database.begin_write().unwrap();
            transaction.open_table(META_U64).unwrap().insert("head", 2).unwrap();
            transaction.abort().unwrap();
        }
        drop(store);
        let old = RedbLibrary::open(&path, Arc::clone(&quota), 8 << 20, TOKEN, None).unwrap();
        assert_eq!(old.range(0, 10).unwrap().head, 1);
        old.apply(&[Write { key: K1.into(), base: 1, value: "new".into() }]).unwrap();
        drop(old);
        let new = RedbLibrary::open(&path, quota, 8 << 20, TOKEN, None).unwrap();
        assert_eq!(new.range(0, 10).unwrap().head, 2);
        assert_eq!(value(&new.latest(K1).unwrap().unwrap())["v"], "new");
    }

    #[test]
    fn crash_process_child() {
        let Some(root) = std::env::var_os("DEN_V3_CRASH_ROOT") else { return };
        let point = std::env::var("DEN_V3_CRASH_POINT").unwrap();
        let root = PathBuf::from(root);
        let manager = manager(&root, 2, 32 << 20, 8 << 20);
        if point == "after" {
            manager
                .library("cccccccccccccccc", TOKEN)
                .unwrap()
                .apply(&[Write { key: K1.into(), base: 1, value: "new".into() }])
                .unwrap();
            std::process::abort();
        } else {
            let path = manager.path("cccccccccccccccc");
            let used = std::fs::metadata(&path).unwrap().len();
            let quota = Arc::new(DiskQuota(crate::store::Quota::standalone_with_used(32 << 20, used)));
            let store = RedbLibrary::open(&path, quota, 8 << 20, TOKEN, None).unwrap();
            let transaction = store.database.begin_write().unwrap();
            transaction.open_table(META_U64).unwrap().insert("head", 2).unwrap();
            std::process::abort();
        }
    }

    #[test]
    fn process_crash_reopens_exactly_before_or_after_the_commit() {
        for point in ["before", "after"] {
            let root = temp_dir();
            let first = manager(&root, 2, 32 << 20, 8 << 20);
            first
                .library("cccccccccccccccc", TOKEN)
                .unwrap()
                .apply(&[Write { key: K1.into(), base: 0, value: "old".into() }])
                .unwrap();
            drop(first);
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "library::v3::tests::crash_process_child", "--nocapture"])
                .env("DEN_V3_CRASH_ROOT", &root)
                .env("DEN_V3_CRASH_POINT", point)
                .status()
                .unwrap();
            assert!(!status.success());
            let reopened = manager(&root, 2, 32 << 20, 8 << 20);
            let store = reopened.library("cccccccccccccccc", TOKEN).unwrap();
            let expected = if point == "after" { (2, "new") } else { (1, "old") };
            assert_eq!(store.range(0, 10).unwrap().head, expected.0);
            assert_eq!(value(&store.latest(K1).unwrap().unwrap())["v"], expected.1);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn aggregate_and_per_file_disk_quotas_fail_closed() {
        let dir = temp_dir();
        let too_small = manager(&dir.join("file"), 2, 2 << 20, 128 << 10);
        assert!(matches!(too_small.library("aaaaaaaaaaaaaaaa", TOKEN), Err(StoreError::Full)));

        let root = dir.join("aggregate");
        let one = manager(&root, 2, 1200 << 10, 1100 << 10);
        let first = one.library("aaaaaaaaaaaaaaaa", TOKEN).unwrap();
        assert!(first.disk_bytes().unwrap() <= 1100 << 10);
        assert!(matches!(one.library("bbbbbbbbbbbbbbbb", TOKEN), Err(StoreError::Full)));
    }

    #[test]
    fn open_databases_are_charged_and_inactive_ones_are_evicted() {
        let dir = temp_dir();
        let manager = manager(&dir, 3, 64 << 20, 4 << 20);
        for id in 0..40 {
            let store = manager.library(&format!("{id:016x}"), TOKEN).unwrap();
            store.apply(&[Write { key: K1.into(), base: 0, value: id.to_string() }]).unwrap();
            let (open, bytes, slots) = manager.cached();
            assert!(open <= 3);
            assert_eq!(bytes, open * OPEN_DATABASE_BYTES);
            assert!(slots <= 3);
        }
        assert_eq!(manager.cached(), (3, 3 * OPEN_DATABASE_BYTES, 3));
    }

    #[test]
    fn failed_unique_opens_do_not_leave_unbounded_empty_registry_slots() {
        let dir = temp_dir();
        let manager = manager(&dir, 1, 32 << 20, 8 << 20);
        let pinned = manager.library("1111111111111111", TOKEN).unwrap();
        for number in 2..100 {
            let id = format!("{number:016x}");
            assert!(matches!(manager.library(&id, TOKEN), Err(StoreError::Full)));
        }
        assert_eq!(manager.cached(), (1, OPEN_DATABASE_BYTES, 1));
        drop(pinned);
    }

    #[test]
    fn conflicting_new_keys_do_not_consume_the_row_limit() {
        let dir = temp_dir();
        let manager = manager(&dir, 1, 32 << 20, 8 << 20);
        let store = manager.library("1111111111111111", TOKEN).unwrap();
        for number in 0..MAX_ROWS {
            let key = format!("{number:016x}");
            store.apply(&[Write { key, base: 0, value: "live".into() }]).unwrap();
        }
        let conflict = store
            .apply(&[Write { key: "ffffffffffffffff".into(), base: 1, value: "never-applied".into() }])
            .unwrap();
        assert!(conflict.applied.is_empty());
        assert_eq!(conflict.conflicts.len(), 1);
        assert_eq!(store.range(0, MAX_LIMIT).unwrap().entries.len(), MAX_ROWS);
    }

    #[test]
    fn replacements_update_the_exact_live_payload_charge() {
        let dir = temp_dir();
        let manager = manager(&dir, 1, 32 << 20, 8 << 20);
        let store = manager.library("1111111111111111", TOKEN).unwrap();
        assert_eq!(store.live_bytes().unwrap(), LIBRARY_OVERHEAD);
        store.apply(&[Write { key: K1.into(), base: 0, value: "short".into() }]).unwrap();
        let first_fragment = row_fragment(1, K1, "short");
        assert_eq!(
            store.live_bytes().unwrap(),
            LIBRARY_OVERHEAD + row_bytes(K1, "short", first_fragment.len())
        );
        store.apply(&[Write { key: K1.into(), base: 1, value: "a longer value".into() }]).unwrap();
        let second_fragment = row_fragment(2, K1, "a longer value");
        assert_eq!(
            store.live_bytes().unwrap(),
            LIBRARY_OVERHEAD + row_bytes(K1, "a longer value", second_fragment.len())
        );
    }

    #[test]
    fn identity_pages_are_exact_json_in_bounded_chunks() {
        let dir = temp_dir();
        let manager = manager(&dir, 1, 32 << 20, 8 << 20);
        let store = manager.library("1111111111111111", TOKEN).unwrap();
        let value = "\\\"".repeat(16 * 1024);
        store.apply(&[Write { key: K1.into(), base: 0, value }]).unwrap();
        let page = store.range_chunks(0, 500, "0123456789abcdef0123456789abcdef").unwrap();
        assert!(page.chunks.iter().all(|chunk| chunk.len() <= 64 * 1024));
        assert_eq!(page.chunks.iter().map(|chunk| chunk.len()).sum::<usize>(), page.len);
        let joined: Vec<u8> = page.chunks.into_iter().flatten().collect();
        let decoded: serde_json::Value = serde_json::from_slice(&joined).unwrap();
        assert_eq!(decoded["entries"][0]["seq"], 1);
        assert_eq!(decoded["generation"], "0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn active_leases_cannot_be_evicted_or_exceed_the_reservation() {
        let dir = temp_dir();
        let manager = manager(&dir, 2, 32 << 20, 4 << 20);
        let first = manager.library("aaaaaaaaaaaaaaaa", TOKEN).unwrap();
        let second = manager.library("bbbbbbbbbbbbbbbb", TOKEN).unwrap();
        assert!(matches!(manager.library("cccccccccccccccc", TOKEN), Err(StoreError::Full)));
        drop(first);
        assert!(manager.library("cccccccccccccccc", TOKEN).is_ok());
        drop(second);
    }

    #[test]
    fn sixty_four_mib_cgroup_keeps_high_cardinality_bounded() {
        let max = std::fs::read_to_string("/sys/fs/cgroup/memory.max").ok();
        if max.as_deref().map(str::trim) != Some("67108864") {
            return;
        }
        let dir = temp_dir();
        let manager = manager(&dir, 16, 128 << 20, 4 << 20);
        for id in 0..64 {
            let store = manager.library(&format!("{id:016x}"), TOKEN).unwrap();
            store.apply(&[Write { key: K1.into(), base: 0, value: "x".repeat(4096) }]).unwrap();
        }
        assert!(manager.cached().1 <= 16 * OPEN_DATABASE_BYTES);
        assert!(manager.cached().2 <= 16);
        let current: u64 =
            std::fs::read_to_string("/sys/fs/cgroup/memory.current").unwrap().trim().parse().unwrap();
        assert!(current < 64 << 20, "cgroup used {current} bytes");
        let events = std::fs::read_to_string("/sys/fs/cgroup/memory.events").unwrap();
        let peak: u64 =
            std::fs::read_to_string("/sys/fs/cgroup/memory.peak").unwrap().trim().parse().unwrap();
        assert!(peak < 64 << 20, "cgroup peaked at {peak} bytes");
        assert!(events.lines().all(|line| !line.starts_with("max ") || line == "max 0"));
        assert!(events.lines().all(|line| !line.starts_with("oom ") || line == "oom 0"));
        assert!(events.lines().all(|line| !line.starts_with("oom_kill ") || line == "oom_kill 0"));
        eprintln!("library-v3 cgroup current={current} peak={peak} {events:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
