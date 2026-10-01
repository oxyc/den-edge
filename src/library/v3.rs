//! Transactional library-v3 storage: one independently writable redb database per library.

use super::{
    constant_time_eq, row_fragment, valid_hex_id, MAX_LIMIT, MAX_ROWS, MAX_VALUE, MAX_WRITES, PAGE_BYTES,
};
use axum::body::Bytes;
use redb::backends::FileBackend;
use redb::{
    BackendError, Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, StorageBackend,
    TableDefinition,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io;
use std::ops::Bound::{Excluded, Unbounded};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard};
use std::sync::{OnceLock, Weak};

const FORMAT_VERSION: u64 = 3;
/// `metadata-u64-v3["charge"]`: how `charges-v3` and `live-bytes` are counted. Absent (stores written before it
/// existed) is v2's in-memory formula `2(k + v) + fragment + 192` plus a 512-byte base, which overstated a v3
/// library about threefold; `CHARGE_STORED` is the stored bytes, `k + v`. Opening an older store recounts it once.
const CHARGE_STORED: u64 = 2;
/// How often one library's file is measured for compaction, and so the most often it is compacted.
const COMPACT_INTERVAL_MS: u64 = 60 * 60 * 1000;
/// Free space smaller than this is not worth rewriting the file for. A new store is ~1 MiB of file (redb's first
/// region), nearly all of it free, so a ratio alone would compact every new library on its first write.
const COMPACT_MIN_FREE: u64 = 2 << 20;
/// Heap one compaction holds beyond its open database's charge. Measured with a counting allocator on redb 4.3.0 at
/// this cache size: ~260 KB for a 13.7 MB household-sized file, ~1.04 MB for a 67 MB file with 34 MB of rows, which
/// is the per-file cap. Compactions run one at a time in the process, so one reservation bounds them all.
const COMPACTION_BYTES: usize = 1536 * 1024;
pub(super) const DATABASE_CACHE_BYTES: usize = 64 * 1024;
const DATABASE_HANDLE_BYTES: usize = 112 * 1024;
const PREPARED_PAGE_BYTES: usize = PAGE_BYTES + 64 * 1024;
/// Redb's measured handle/cache/mapping residency plus one worst-case exact prepared identity page.
pub(crate) const OPEN_DATABASE_BYTES: usize = DATABASE_HANDLE_BYTES + PREPARED_PAGE_BYTES;
const RETAINED_DATABASES: usize = 2;
const KEYS: TableDefinition<&str, u64> = TableDefinition::new("keys-v3");
/// Each live row's charge, `stored_charge`. Keeping this beside the key index lets a write enforce the library's
/// bound (`Limits::stored_bytes`) without parsing canonical JSON or confusing redb's cache with live data.
const CHARGES: TableDefinition<&str, u64> = TableDefinition::new("charges-v3");
const SEQUENCE: TableDefinition<u64, &[u8]> = TableDefinition::new("sequence-v3");
const META_U64: TableDefinition<&str, u64> = TableDefinition::new("metadata-u64-v3");
const META_BYTES: TableDefinition<&str, &[u8]> = TableDefinition::new("metadata-bytes-v3");
type Credentials = ([u8; 32], Option<[u8; 32]>);

/// What one live row of a v3 library counts against `Limits::stored_bytes`: the bytes its client stored, key and
/// sealed value. The canonical fragment and indexes around them are the store's overhead, not the library's.
pub(super) fn stored_charge(key: &str, value: &str) -> u64 {
    (key.len() + value.len()) as u64
}

/// One compaction at a time in the process: `COMPACTION_BYTES` is reserved once, not per library.
fn compaction_turn() -> &'static Mutex<()> {
    static TURN: OnceLock<Mutex<()>> = OnceLock::new();
    TURN.get_or_init(|| Mutex::new(()))
}

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Protocol {
    pub head: u64,
    pub wire_min: u64,
    pub generation: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RewriteRow {
    pub key: String,
    pub value: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct RangePage {
    pub entries: Vec<StoredRow>,
    pub head: u64,
    pub more: bool,
}

#[derive(Clone)]
pub(super) struct ChunkPage {
    pub chunks: Vec<Bytes>,
    pub len: usize,
}

struct PreparedPage {
    since: u64,
    limit: usize,
    generation: String,
    page: ChunkPage,
}

pub(super) trait LibraryStore: Send + Sync {
    #[cfg(test)]
    fn apply(&self, writes: &[Write]) -> Result<BatchResult, StoreError> {
        self.apply_bounded(writes, 8 << 20, 2)
    }
    fn apply_bounded(
        &self,
        writes: &[Write],
        live_cap: usize,
        wire_min: u64,
    ) -> Result<BatchResult, StoreError>;
    #[cfg(test)]
    fn latest(&self, key: &str) -> Result<Option<StoredRow>, StoreError>;
    fn range(&self, since: u64, limit: usize) -> Result<RangePage, StoreError>;
    fn cached_range_chunks(&self, since: u64, limit: usize, generation: &str) -> Option<ChunkPage>;
    fn range_chunks(&self, since: u64, limit: usize, generation: &str) -> Result<ChunkPage, StoreError>;
    #[cfg(test)]
    fn disk_bytes(&self) -> Result<u64, StoreError>;
    #[cfg(test)]
    fn live_bytes(&self) -> Result<usize, StoreError>;
    fn credentials(&self) -> Credentials;
    fn register_member(&self, member_hash: [u8; 32]) -> Result<bool, StoreError>;
    fn protocol(&self) -> Result<Protocol, StoreError>;
    fn rewrite(
        &self,
        base: u64,
        rows: &[RewriteRow],
        wire_min: u64,
        live_cap: usize,
    ) -> Result<Protocol, StoreError>;
    /// Compact the file when more than half of it (and at least `COMPACT_MIN_FREE`) is free pages, measuring at
    /// most once per `COMPACT_INTERVAL_MS` per open library. The caller holds the library's lock and has checked
    /// that no rewrite is staged. Returns the file's length before and after when it compacted.
    fn compact_if_sparse(&self, now: u64) -> Result<Option<(u64, u64)>, StoreError>;
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
    // Explicitly dropped while holding `database_lifecycle`. Rust normally drops fields after `Drop::drop`
    // returns, which leaves a small window where the weak process registry says no owner remains but redb still
    // holds the file lock. A cold/high-cardinality workload can otherwise reopen in that window and spuriously
    // return an internal error.
    //
    // Every transaction runs under a read guard; `Database::compact` needs the database to itself, so compaction
    // takes the write guard and no transaction is open while it runs.
    database: RwLock<Option<Database>>,
    path: PathBuf,
    token_hash: [u8; 32],
    member_hash: Mutex<Option<[u8; 32]>>,
    prepared: Mutex<Option<PreparedPage>>,
    /// When this handle last measured its file for compaction (`now` of the caller's clock); 0 is never.
    compaction_checked: AtomicU64,
}

/// A read guard that derefs to the open database. Hold it for as long as any transaction begun from it lives.
struct DatabaseRef<'a>(RwLockReadGuard<'a, Option<Database>>);

impl std::ops::Deref for DatabaseRef<'_> {
    type Target = Database;

    fn deref(&self) -> &Database {
        self.0.as_ref().expect("a live library owns its database")
    }
}

impl Drop for RedbLibrary {
    fn drop(&mut self) {
        let _lifecycle = database_lifecycle().lock().unwrap();
        drop(self.database.get_mut().unwrap().take());
        let mut databases = process_databases().lock().unwrap();
        if databases.get(&self.path).is_some_and(|database| database.strong_count() == 0) {
            databases.remove(&self.path);
        }
    }
}

/// redb intentionally permits one open handle per file. Tests model a restart by constructing a second AppState
/// before dropping the first, and embedded users may do the same during a graceful handoff, so managers in this
/// process share that handle rather than treating it as corruption.
fn process_databases() -> &'static Mutex<HashMap<PathBuf, Weak<RedbLibrary>>> {
    static DATABASES: OnceLock<Mutex<HashMap<PathBuf, Weak<RedbLibrary>>>> = OnceLock::new();
    DATABASES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serializes the gap between a redb handle's last strong reference and release of its operating-system file
/// lock. A weak entry with no strong owners means its destructor is waiting for this lock; openers yield instead
/// of racing that destructor.
fn database_lifecycle() -> &'static Mutex<()> {
    static LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();
    LIFECYCLE.get_or_init(|| Mutex::new(()))
}

fn shared_or_open(
    path: &Path,
    quota: Arc<DiskQuota>,
    file_cap: u64,
    token_hash: [u8; 32],
    initial_member_hash: Option<[u8; 32]>,
) -> Result<Arc<RedbLibrary>, StoreError> {
    loop {
        let lifecycle = database_lifecycle().lock().unwrap();
        let mut databases = process_databases().lock().unwrap();
        if let Some(weak) = databases.get(path) {
            if let Some(store) = weak.upgrade() {
                return if store.accepts(&token_hash) { Ok(store) } else { Err(StoreError::Forbidden) };
            }
            // The last Arc reached zero and its destructor is waiting for `lifecycle`. Do not attempt to take
            // redb's file lock until that destructor has run and removed the weak entry.
            drop(databases);
            drop(lifecycle);
            std::thread::yield_now();
            continue;
        }
        let store = Arc::new(RedbLibrary::open(path, quota, file_cap, token_hash, initial_member_hash)?);
        databases.insert(path.to_owned(), Arc::downgrade(&store));
        return Ok(store);
    }
}

/// Recount a store charged by an older formula as stored bytes, once, in the transaction that opens it. Each row's
/// value is read back from its canonical fragment; the key index names every live row.
fn recharge(transaction: &redb::WriteTransaction) -> Result<(), StoreError> {
    #[derive(Deserialize)]
    struct Fragment {
        k: String,
        v: String,
    }

    let charged = transaction
        .open_table(META_U64)
        .map_err(StoreError::redb)?
        .get("charge")
        .map_err(StoreError::redb)?
        .map(|value| value.value());
    if charged == Some(CHARGE_STORED) {
        return Ok(());
    }
    let mut live_bytes = 0u64;
    {
        let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
        let sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
        let mut charges = transaction.open_table(CHARGES).map_err(StoreError::redb)?;
        for entry in keys.iter().map_err(StoreError::redb)? {
            let (key, seq) = entry.map_err(StoreError::redb)?;
            let fragment = sequence
                .get(seq.value())
                .map_err(StoreError::redb)?
                .ok_or_else(|| StoreError::Invalid("v3 key points to no fragment".into()))?;
            let row: Fragment = serde_json::from_slice(fragment.value())
                .map_err(|error| StoreError::Invalid(format!("v3 fragment is not a row: {error}")))?;
            if row.k != key.value() {
                return Err(StoreError::Invalid("v3 key and fragment disagree".into()));
            }
            let charge = stored_charge(&row.k, &row.v);
            charges.insert(key.value(), charge).map_err(StoreError::redb)?;
            live_bytes += charge;
        }
    }
    let mut numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
    numbers.insert("live-bytes", live_bytes).map_err(StoreError::redb)?;
    numbers.insert("charge", CHARGE_STORED).map_err(StoreError::redb)?;
    Ok(())
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
            {
                let mut numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
                if numbers.get("wire-min").map_err(StoreError::redb)?.is_none() {
                    numbers.insert("wire-min", 2).map_err(StoreError::redb)?;
                }
                let mut bytes = transaction.open_table(META_BYTES).map_err(StoreError::redb)?;
                if bytes.get("generation").map_err(StoreError::redb)?.is_none() {
                    let generation = crate::hex(&crate::random_bytes::<16>());
                    bytes.insert("generation", generation.as_bytes()).map_err(StoreError::redb)?;
                }
            }
            recharge(&transaction)?;
            transaction.commit().map_err(StoreError::redb)?;
        } else {
            member_hash = initial_member_hash;
            {
                let mut numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
                numbers.insert("format", FORMAT_VERSION).map_err(StoreError::redb)?;
                numbers.insert("head", 0).map_err(StoreError::redb)?;
                numbers.insert("wire-min", 2).map_err(StoreError::redb)?;
                numbers.insert("charge", CHARGE_STORED).map_err(StoreError::redb)?;
                numbers.insert("live-bytes", 0).map_err(StoreError::redb)?;
                let mut bytes = transaction.open_table(META_BYTES).map_err(StoreError::redb)?;
                bytes.insert("token", token_hash.as_slice()).map_err(StoreError::redb)?;
                let generation = crate::hex(&crate::random_bytes::<16>());
                bytes.insert("generation", generation.as_bytes()).map_err(StoreError::redb)?;
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
            database: RwLock::new(Some(database)),
            path: path.to_owned(),
            token_hash,
            member_hash: Mutex::new(member_hash),
            prepared: Mutex::new(None),
            compaction_checked: AtomicU64::new(0),
        })
    }

    fn reconcile_protocol(
        &self,
        recorded: Option<&IndexedProtocol>,
        newly_created: bool,
    ) -> Result<Protocol, StoreError> {
        let current = self.protocol()?;
        let restored = !newly_created
            && recorded
                .is_none_or(|known| known.generation != current.generation || known.head != current.head);
        let remembered_min = recorded.map_or(2, |known| known.wire_min);
        if !restored && remembered_min <= current.wire_min {
            return Ok(current);
        }
        let generation = if restored { crate::hex(&crate::random_bytes::<16>()) } else { current.generation };
        let wire_min = current.wire_min.max(remembered_min);
        let database = self.database();
        let transaction = database.begin_write().map_err(StoreError::redb)?;
        transaction
            .open_table(META_U64)
            .map_err(StoreError::redb)?
            .insert("wire-min", wire_min)
            .map_err(StoreError::redb)?;
        transaction
            .open_table(META_BYTES)
            .map_err(StoreError::redb)?
            .insert("generation", generation.as_bytes())
            .map_err(StoreError::redb)?;
        transaction.commit().map_err(StoreError::redb)?;
        *self.prepared.lock().unwrap() = None;
        Ok(Protocol { head: current.head, wire_min, generation })
    }

    fn row(&self, sequence: u64, fragment: &[u8]) -> StoredRow {
        StoredRow { sequence, fragment: Arc::from(fragment) }
    }

    fn accepts(&self, token_hash: &[u8; 32]) -> bool {
        constant_time_eq(&self.token_hash, token_hash)
    }

    fn database(&self) -> DatabaseRef<'_> {
        DatabaseRef(self.database.read().unwrap())
    }

    /// Claim this handle's hourly measurement and report whether more than half the file, and at least
    /// `COMPACT_MIN_FREE`, is free pages. redb's own page count is exact and cheap (measured 2–18 ms, under 60 KB,
    /// from a 13.7 MB to a 67 MB file); the live-byte charge is not a usable proxy, because a freshly compacted file
    /// is 1.5–1.9 times its stored bytes and would sit right at the threshold.
    fn sparse(&self, now: u64) -> Result<bool, StoreError> {
        let checked = self.compaction_checked.load(Ordering::Relaxed);
        if checked != 0 && now.saturating_sub(checked) < COMPACT_INTERVAL_MS {
            return Ok(false);
        }
        self.compaction_checked.store(now.max(1), Ordering::Relaxed);
        let database = self.database();
        let file = std::fs::metadata(&self.path).map_err(StoreError::io)?.len();
        let transaction = database.begin_write().map_err(StoreError::redb)?;
        let stats = transaction.stats().map_err(StoreError::redb)?;
        transaction.abort().map_err(StoreError::redb)?;
        let free = file.saturating_sub(stats.allocated_pages() * stats.page_size() as u64);
        Ok(free > file / 2 && free >= COMPACT_MIN_FREE)
    }

    /// Rewrite the file without its free pages, holding the database to itself, and return its length before and
    /// after. Content, head and generation are unchanged, so a prepared identity page stays valid.
    fn compact(&self) -> Result<(u64, u64), StoreError> {
        let mut database = self.database.write().unwrap();
        let before = std::fs::metadata(&self.path).map_err(StoreError::io)?.len();
        database.as_mut().expect("a live library owns its database").compact().map_err(StoreError::redb)?;
        let after = std::fs::metadata(&self.path).map_err(StoreError::io)?.len();
        Ok((before, after))
    }
}

impl LibraryStore for RedbLibrary {
    fn apply_bounded(
        &self,
        writes: &[Write],
        live_cap: usize,
        wire_min: u64,
    ) -> Result<BatchResult, StoreError> {
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
        // Keep prepared-page publication ordered with commits. Without this per-library lock, a read begun before
        // the commit could publish its stale page after the writer invalidated the old cache entry.
        let mut prepared = self.prepared.lock().unwrap();
        let database = self.database();
        let transaction = database.begin_write().map_err(StoreError::redb)?;
        let mut head = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let value = metadata
                .get("head")
                .map_err(StoreError::redb)?
                .ok_or_else(|| StoreError::Invalid("v3 head is missing".into()))?;
            value.value()
        };
        let started_empty = head == 0;
        let live_rows = {
            let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            keys.len().map_err(StoreError::redb)?
        };
        let mut accepted = Vec::new();
        let mut conflicts = Vec::new();
        let mut accepted_new_rows = 0u64;
        let mut live_bytes = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let bytes =
                metadata.get("live-bytes").map_err(StoreError::redb)?.map_or(0, |value| value.value());
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
                let charge = stored_charge(&write.key, &write.value);
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
            let current_min =
                metadata.get("wire-min").map_err(StoreError::redb)?.map_or(2, |value| value.value());
            metadata.insert("head", head).map_err(StoreError::redb)?;
            metadata.insert("live-bytes", live_bytes).map_err(StoreError::redb)?;
            if started_empty && !accepted.is_empty() {
                metadata.insert("wire-min", current_min.max(wire_min)).map_err(StoreError::redb)?;
            }
        }
        transaction.commit().map_err(StoreError::redb)?;
        *prepared = None;
        Ok(BatchResult {
            head,
            applied: accepted.into_iter().map(|(write, _, seq, _, _)| (write.key.clone(), seq)).collect(),
            conflicts,
        })
    }

    #[cfg(test)]
    fn latest(&self, key: &str) -> Result<Option<StoredRow>, StoreError> {
        let database = self.database();
        let transaction = database.begin_read().map_err(StoreError::redb)?;
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
        let database = self.database();
        let transaction = database.begin_read().map_err(StoreError::redb)?;
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

    fn cached_range_chunks(&self, since: u64, limit: usize, generation: &str) -> Option<ChunkPage> {
        let prepared = self.prepared.try_lock().ok()?;
        let cached = prepared.as_ref()?;
        (cached.since == since && cached.limit == limit.min(MAX_LIMIT) && cached.generation == generation)
            .then(|| cached.page.clone())
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

        let limit = limit.min(MAX_LIMIT);
        let mut prepared = self.prepared.lock().unwrap();
        if let Some(cached) = prepared.as_ref() {
            if cached.since == since && cached.limit == limit && cached.generation == generation {
                return Ok(cached.page.clone());
            }
        }
        let database = self.database();
        let transaction = database.begin_read().map_err(StoreError::redb)?;
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
        while entries < limit {
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
        let page = ChunkPage { chunks: chunks.into_iter().map(Bytes::from).collect(), len };
        *prepared =
            Some(PreparedPage { since, limit, generation: generation.to_owned(), page: page.clone() });
        Ok(page)
    }

    #[cfg(test)]
    fn disk_bytes(&self) -> Result<u64, StoreError> {
        Ok(std::fs::metadata(&self.path).map_err(StoreError::io)?.len())
    }

    #[cfg(test)]
    fn live_bytes(&self) -> Result<usize, StoreError> {
        let database = self.database();
        let transaction = database.begin_read().map_err(StoreError::redb)?;
        let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
        let bytes = metadata.get("live-bytes").map_err(StoreError::redb)?.map_or(0, |value| value.value());
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
        let database = self.database();
        let transaction = database.begin_write().map_err(StoreError::redb)?;
        transaction
            .open_table(META_BYTES)
            .map_err(StoreError::redb)?
            .insert("member", member_hash.as_slice())
            .map_err(StoreError::redb)?;
        transaction.commit().map_err(StoreError::redb)?;
        *cached = Some(member_hash);
        Ok(true)
    }

    fn protocol(&self) -> Result<Protocol, StoreError> {
        let database = self.database();
        let transaction = database.begin_read().map_err(StoreError::redb)?;
        let numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
        let head = numbers
            .get("head")
            .map_err(StoreError::redb)?
            .ok_or_else(|| StoreError::Invalid("v3 head is missing".into()))?
            .value();
        let wire_min = numbers.get("wire-min").map_err(StoreError::redb)?.map_or(2, |value| value.value());
        let bytes = transaction.open_table(META_BYTES).map_err(StoreError::redb)?;
        let generation = bytes
            .get("generation")
            .map_err(StoreError::redb)?
            .ok_or_else(|| StoreError::Invalid("v3 generation is missing".into()))?;
        let generation = std::str::from_utf8(generation.value())
            .map_err(|_| StoreError::Invalid("v3 generation is not UTF-8".into()))?
            .to_owned();
        Ok(Protocol { head, wire_min, generation })
    }

    fn rewrite(
        &self,
        base: u64,
        rows: &[RewriteRow],
        wire_min: u64,
        live_cap: usize,
    ) -> Result<Protocol, StoreError> {
        let mut unique = HashSet::with_capacity(rows.len());
        if rows.len() > MAX_ROWS
            || rows.iter().any(|row| {
                row.value.len() > MAX_VALUE || !valid_hex_id(&row.key) || !unique.insert(row.key.as_str())
            })
        {
            return Err(StoreError::Invalid("invalid rewrite rows".into()));
        }
        let mut live_bytes = 0u64;
        let mut prepared_rows = Vec::with_capacity(rows.len());
        for (offset, row) in rows.iter().enumerate() {
            let sequence = base
                .checked_add(offset as u64 + 1)
                .ok_or_else(|| StoreError::Invalid("v3 head overflow".into()))?;
            let fragment = row_fragment(sequence, &row.key, &row.value);
            let charge = stored_charge(&row.key, &row.value);
            live_bytes = live_bytes.checked_add(charge).ok_or(StoreError::Full)?;
            prepared_rows.push((row, sequence, fragment, charge));
        }
        if live_bytes > live_cap as u64 {
            return Err(StoreError::Full);
        }
        let mut prepared = self.prepared.lock().unwrap();
        let database = self.database();
        let transaction = database.begin_write().map_err(StoreError::redb)?;
        let current = {
            let numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let current = numbers
                .get("head")
                .map_err(StoreError::redb)?
                .ok_or_else(|| StoreError::Invalid("v3 head is missing".into()))?
                .value();
            current
        };
        if current != base {
            return Err(StoreError::Invalid(format!("head_moved:{current}")));
        }
        {
            let mut keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            let mut charges = transaction.open_table(CHARGES).map_err(StoreError::redb)?;
            let mut sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
            keys.retain(|_, _| false).map_err(StoreError::redb)?;
            charges.retain(|_, _| false).map_err(StoreError::redb)?;
            sequence.retain(|_, _| false).map_err(StoreError::redb)?;
            for (row, seq, fragment, charge) in &prepared_rows {
                keys.insert(row.key.as_str(), *seq).map_err(StoreError::redb)?;
                charges.insert(row.key.as_str(), *charge).map_err(StoreError::redb)?;
                sequence.insert(*seq, fragment.as_ref()).map_err(StoreError::redb)?;
            }
        }
        let head = base + rows.len() as u64;
        let generation = crate::hex(&crate::random_bytes::<16>());
        let effective_min;
        {
            let mut numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let current_min =
                numbers.get("wire-min").map_err(StoreError::redb)?.map_or(2, |value| value.value());
            effective_min = current_min.max(wire_min);
            numbers.insert("head", head).map_err(StoreError::redb)?;
            numbers.insert("live-bytes", live_bytes).map_err(StoreError::redb)?;
            numbers.insert("wire-min", effective_min).map_err(StoreError::redb)?;
            transaction
                .open_table(META_BYTES)
                .map_err(StoreError::redb)?
                .insert("generation", generation.as_bytes())
                .map_err(StoreError::redb)?;
        }
        transaction.commit().map_err(StoreError::redb)?;
        *prepared = None;
        Ok(Protocol { head, wire_min: effective_min, generation })
    }

    /// A handle outside a manager has no memory registry to reserve in; it still compacts only in its turn.
    fn compact_if_sparse(&self, now: u64) -> Result<Option<(u64, u64)>, StoreError> {
        if !self.sparse(now)? {
            return Ok(None);
        }
        let _turn = compaction_turn().lock().unwrap();
        self.compact().map(Some)
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

#[derive(Clone, Deserialize, Serialize)]
struct IndexedProtocol {
    generation: String,
    head: u64,
    wire_min: u64,
}

struct ProtocolIndex {
    path: PathBuf,
    entries: Mutex<HashMap<String, IndexedProtocol>>,
}

impl ProtocolIndex {
    fn open(path: PathBuf) -> Result<Self, StoreError> {
        let entries = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| StoreError::Invalid(format!("invalid library protocol index: {error}")))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(StoreError::io(error)),
        };
        Ok(Self { path, entries: Mutex::new(entries) })
    }

    fn get(&self, id: &str) -> Option<IndexedProtocol> {
        self.entries.lock().unwrap().get(id).cloned()
    }

    fn record(&self, id: &str, protocol: &Protocol) -> Result<(), StoreError> {
        let mut entries = self.entries.lock().unwrap();
        entries.insert(
            id.to_owned(),
            IndexedProtocol {
                generation: protocol.generation.clone(),
                head: protocol.head,
                wire_min: protocol.wire_min,
            },
        );
        let bytes = serde_json::to_vec(&*entries).map_err(|error| StoreError::Failed(error.to_string()))?;
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes).map_err(StoreError::io)?;
        std::fs::File::open(&temporary).and_then(|file| file.sync_all()).map_err(StoreError::io)?;
        std::fs::rename(&temporary, &self.path).map_err(StoreError::io)?;
        if let Some(parent) = self.path.parent() {
            std::fs::File::open(parent).and_then(|file| file.sync_all()).map_err(StoreError::io)?;
        }
        Ok(())
    }
}

struct StoreLease {
    id: String,
    store: Arc<RedbLibrary>,
    registry: Arc<Mutex<Registry>>,
    index: Arc<ProtocolIndex>,
    memory_cap: usize,
}

impl Drop for StoreLease {
    fn drop(&mut self) {
        let mut registry = self.registry.lock().unwrap();
        while registry.bytes > RETAINED_DATABASES * OPEN_DATABASE_BYTES {
            let mut candidates: Vec<_> =
                registry.slots.iter().map(|(id, slot)| (id.clone(), Arc::clone(slot))).collect();
            candidates.sort_by_key(|(_, slot)| slot.last_used.load(Ordering::Relaxed));
            let mut removed = false;
            for (id, slot) in candidates {
                let Ok(mut stored) = slot.store.try_lock() else { continue };
                // Registry + this local candidate must be the only slot owners. A request which cloned the slot
                // but has not locked `store` yet otherwise resumes through an orphan slot and leaks this open
                // database's accounting charge until valid requests are falsely refused as full.
                let evictable = Arc::strong_count(&slot) == 2
                    && stored.as_ref().is_some_and(|store| {
                        Arc::strong_count(store) == 1
                            || Arc::ptr_eq(store, &self.store) && Arc::strong_count(store) == 2
                    });
                if evictable {
                    stored.take();
                    registry.slots.remove(&id);
                    registry.bytes -= OPEN_DATABASE_BYTES;
                    removed = true;
                    break;
                }
            }
            if !removed {
                break;
            }
        }
    }
}

impl LibraryStore for StoreLease {
    fn apply_bounded(
        &self,
        writes: &[Write],
        live_cap: usize,
        wire_min: u64,
    ) -> Result<BatchResult, StoreError> {
        let result = self.store.apply_bounded(writes, live_cap, wire_min)?;
        self.index.record(&self.id, &self.store.protocol()?)?;
        Ok(result)
    }

    #[cfg(test)]
    fn latest(&self, key: &str) -> Result<Option<StoredRow>, StoreError> {
        self.store.latest(key)
    }

    fn range(&self, since: u64, limit: usize) -> Result<RangePage, StoreError> {
        self.store.range(since, limit)
    }

    fn cached_range_chunks(&self, since: u64, limit: usize, generation: &str) -> Option<ChunkPage> {
        self.store.cached_range_chunks(since, limit, generation)
    }

    fn range_chunks(&self, since: u64, limit: usize, generation: &str) -> Result<ChunkPage, StoreError> {
        self.store.range_chunks(since, limit, generation)
    }

    #[cfg(test)]
    fn disk_bytes(&self) -> Result<u64, StoreError> {
        self.store.disk_bytes()
    }

    #[cfg(test)]
    fn live_bytes(&self) -> Result<usize, StoreError> {
        self.store.live_bytes()
    }

    fn credentials(&self) -> Credentials {
        self.store.credentials()
    }

    fn register_member(&self, member_hash: [u8; 32]) -> Result<bool, StoreError> {
        self.store.register_member(member_hash)
    }

    fn protocol(&self) -> Result<Protocol, StoreError> {
        self.store.protocol()
    }

    fn rewrite(
        &self,
        base: u64,
        rows: &[RewriteRow],
        wire_min: u64,
        live_cap: usize,
    ) -> Result<Protocol, StoreError> {
        let protocol = self.store.rewrite(base, rows, wire_min, live_cap)?;
        self.index.record(&self.id, &protocol)?;
        Ok(protocol)
    }

    /// Compaction's transient heap is reserved in the same budget as open databases, so the manager's memory cap
    /// (and the 64 MiB container it is sized for) holds while it runs. With no room it waits for a later hour.
    fn compact_if_sparse(&self, now: u64) -> Result<Option<(u64, u64)>, StoreError> {
        if !self.store.sparse(now)? {
            return Ok(None);
        }
        let _turn = compaction_turn().lock().unwrap();
        {
            let mut registry = self.registry.lock().unwrap();
            if registry.bytes + COMPACTION_BYTES > self.memory_cap {
                return Ok(None);
            }
            registry.bytes += COMPACTION_BYTES;
        }
        let compacted = self.store.compact();
        self.registry.lock().unwrap().bytes -= COMPACTION_BYTES;
        compacted.map(Some)
    }
}

/// Lazily opens independent databases and charges their measured fixed residency before opening. An active lease
/// pins only its library. Eviction closes an inactive database without blocking another library's writer.
pub(crate) struct StoreManager {
    root: PathBuf,
    registry: Arc<Mutex<Registry>>,
    clock: AtomicU64,
    memory_cap: usize,
    file_cap: u64,
    quota: Arc<DiskQuota>,
    index: Arc<ProtocolIndex>,
}

impl StoreManager {
    fn lease(&self, id: &str, store: Arc<RedbLibrary>) -> Arc<dyn LibraryStore> {
        Arc::new(StoreLease {
            id: id.to_owned(),
            store,
            registry: Arc::clone(&self.registry),
            index: Arc::clone(&self.index),
            memory_cap: self.memory_cap,
        })
    }

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
        let index = Arc::new(ProtocolIndex::open(root.join("library-v3-index.json"))?);
        Ok(Self {
            root: root.to_owned(),
            registry: Arc::new(Mutex::new(Registry { slots: HashMap::new(), bytes: 0 })),
            clock: AtomicU64::new(1),
            memory_cap,
            file_cap,
            quota: Arc::new(DiskQuota(crate::store::Quota::standalone_with_used(disk_cap, used))),
            index,
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
        let index =
            Arc::new(ProtocolIndex::open(root.parent().unwrap_or(root).join("library-v3-index.json"))?);
        Ok(Self {
            root: root.to_owned(),
            registry: Arc::new(Mutex::new(Registry { slots: HashMap::new(), bytes: 0 })),
            clock: AtomicU64::new(1),
            memory_cap,
            file_cap,
            quota: Arc::new(DiskQuota(quota)),
            index,
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
            let database = store.database();
            let transaction = database.begin_write().map_err(StoreError::redb)?;
            {
                let mut keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
                let mut charges = transaction.open_table(CHARGES).map_err(StoreError::redb)?;
                let mut sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
                let mut live_bytes = 0u64;
                for (key, row) in &library.rows {
                    let charge = stored_charge(key, &row.v);
                    keys.insert(key.as_str(), row.seq).map_err(StoreError::redb)?;
                    charges.insert(key.as_str(), charge).map_err(StoreError::redb)?;
                    sequence.insert(row.seq, row.fragment.as_ref()).map_err(StoreError::redb)?;
                    live_bytes += charge;
                }
                let mut metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
                metadata.insert("head", library.head).map_err(StoreError::redb)?;
                metadata.insert("live-bytes", live_bytes).map_err(StoreError::redb)?;
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
        let (token, member) = loop {
            let lifecycle = database_lifecycle().lock().unwrap();
            let databases = process_databases().lock().unwrap();
            if let Some(weak) = databases.get(&path) {
                if let Some(store) = weak.upgrade() {
                    let credentials = store.credentials();
                    drop(databases);
                    drop(lifecycle);
                    let _ = self.library(id, credentials.0)?;
                    return Ok(Some(credentials));
                }
                drop(databases);
                drop(lifecycle);
                std::thread::yield_now();
                continue;
            }
            let file =
                std::fs::OpenOptions::new().read(true).write(true).open(&path).map_err(StoreError::io)?;
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
            drop(databases);
            drop(lifecycle);
            break (token, member);
        };
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
            return Ok(self.lease(id, Arc::clone(store)));
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
        let created = !path.exists();
        match shared_or_open(&path, Arc::clone(&self.quota), self.file_cap, token_hash, None) {
            Ok(store) => {
                let protocol = store.reconcile_protocol(self.index.get(id).as_ref(), created)?;
                self.index.record(id, &protocol)?;
                *stored = Some(Arc::clone(&store));
                Ok(self.lease(id, store))
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

    /// Open authority that was already published. A format marker without its database is corruption, never an
    /// instruction to manufacture a new empty head and hide a stale v2 log.
    pub(super) fn existing_library(
        &self,
        id: &str,
        token_hash: [u8; 32],
    ) -> Result<Arc<dyn LibraryStore>, StoreError> {
        if !self.path(id).is_file() {
            return Err(StoreError::Invalid("published v3 database is missing".into()));
        }
        self.library(id, token_hash)
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
    const K3: &str = "cccccccccccccccc";

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
            let database = store.database();
            let transaction = database.begin_write().unwrap();
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
            let database = store.database();
            let transaction = database.begin_write().unwrap();
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
        assert_eq!(manager.cached(), (RETAINED_DATABASES, RETAINED_DATABASES * OPEN_DATABASE_BYTES, 2));
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
    fn replacements_update_the_exact_stored_charge() {
        let dir = temp_dir();
        let manager = manager(&dir, 1, 32 << 20, 8 << 20);
        let store = manager.library("1111111111111111", TOKEN).unwrap();
        assert_eq!(store.live_bytes().unwrap(), 0);
        store.apply(&[Write { key: K1.into(), base: 0, value: "short".into() }]).unwrap();
        assert_eq!(store.live_bytes().unwrap(), K1.len() + "short".len());
        store.apply(&[Write { key: K1.into(), base: 1, value: "a longer value".into() }]).unwrap();
        assert_eq!(store.live_bytes().unwrap(), K1.len() + "a longer value".len());
    }

    /// A store written while `charges-v3` held v2's in-memory formula is recounted as stored bytes when it opens,
    /// and from then on is full exactly when its keys and values reach the cap.
    #[test]
    fn an_old_formula_store_is_recharged_by_stored_bytes_and_fills_at_the_cap() {
        let dir = temp_dir();
        let id = "1111111111111111";
        let path = {
            let first = manager(&dir, 2, 32 << 20, 8 << 20);
            let store = first.library(id, TOKEN).unwrap();
            store
                .apply(&[
                    Write { key: K1.into(), base: 0, value: "x".repeat(1000) },
                    Write { key: K2.into(), base: 0, value: "y".repeat(500) },
                ])
                .unwrap();
            first.path(id)
        };
        {
            let quota = Arc::new(DiskQuota(crate::store::Quota::standalone(32 << 20)));
            let old = RedbLibrary::open(&path, quota, 8 << 20, TOKEN, None).unwrap();
            let database = old.database();
            let transaction = database.begin_write().unwrap();
            {
                let mut charges = transaction.open_table(CHARGES).unwrap();
                let mut live = super::super::LIBRARY_OVERHEAD as u64;
                for (sequence, key, value) in [(1, K1, "x".repeat(1000)), (2, K2, "y".repeat(500))] {
                    let fragment = row_fragment(sequence, key, &value);
                    let charge = super::super::row_bytes(key, &value, fragment.len()) as u64;
                    charges.insert(key, charge).unwrap();
                    live += charge;
                }
                let mut numbers = transaction.open_table(META_U64).unwrap();
                numbers.insert("live-bytes", live).unwrap();
                numbers.remove("charge").unwrap();
            }
            transaction.commit().unwrap();
        }

        let reopened = manager(&dir, 2, 32 << 20, 8 << 20);
        let store = reopened.library(id, TOKEN).unwrap();
        let stored = K1.len() + 1000 + K2.len() + 500;
        assert_eq!(store.live_bytes().unwrap(), stored, "recounted as k + v, not 2(k + v) + fragment + 192");

        // Real data fills the cap to the byte: a third row that lands exactly on it is taken, one byte more is not.
        let cap = stored + 2000;
        let exact = "z".repeat(2000 - K3.len());
        assert!(matches!(
            store.apply_bounded(&[Write { key: K3.into(), base: 0, value: format!("{exact}z") }], cap, 2),
            Err(StoreError::Full)
        ));
        store.apply_bounded(&[Write { key: K3.into(), base: 0, value: exact }], cap, 2).unwrap();
        assert_eq!(store.live_bytes().unwrap(), cap);
        assert!(matches!(
            store.apply_bounded(&[Write { key: K1.into(), base: 1, value: "x".repeat(1001) }], cap, 2),
            Err(StoreError::Full)
        ));
    }

    /// A store imported with 2,000 rows of 4 KB: ~8 MB of live data, and its head.
    fn grown(manager: &StoreManager, id: &str) -> (Arc<dyn LibraryStore>, u64) {
        let mut library = super::super::Library {
            token_hash: TOKEN,
            member_hash: None,
            head: 0,
            rows: HashMap::new(),
            sequence: std::collections::BTreeMap::new(),
            lines: 0,
            bytes: 0,
        };
        for number in 0..2000u64 {
            let key = format!("{number:016x}");
            let value: Arc<str> = Arc::from("s".repeat(4000));
            library.head += 1;
            let fragment = row_fragment(library.head, &key, &value);
            library.rows.insert(key, super::super::Row { seq: library.head, v: value, fragment });
        }
        manager.import_v2(id, &library).unwrap();
        (manager.library(id, TOKEN).unwrap(), library.head)
    }

    /// Rewrite a grown store down to four small rows, leaving most of its file free pages.
    fn shrink(store: &dyn LibraryStore, head: u64) {
        let rows: Vec<_> =
            (0..4).map(|n| RewriteRow { key: format!("{n:016x}"), value: "kept".into() }).collect();
        store.rewrite(head, &rows, 2, 32 << 20).unwrap();
    }

    #[test]
    fn a_store_that_grew_then_shrank_is_compacted_below_the_threshold_at_most_hourly() {
        let dir = temp_dir();
        let first = manager(&dir, 4, 256 << 20, 64 << 20);
        let id = "1111111111111111";
        let (store, head) = grown(&first, id);
        let start = 1_000_000;
        assert_eq!(store.compact_if_sparse(start).unwrap(), None, "a full store is left alone");
        assert!(store.disk_bytes().unwrap() > 8 << 20);

        shrink(store.as_ref(), head);
        let size = store.disk_bytes().unwrap();
        assert_eq!(store.compact_if_sparse(start + COMPACT_INTERVAL_MS - 1).unwrap(), None);
        assert_eq!(store.disk_bytes().unwrap(), size, "not measured again within the hour");

        assert_eq!(
            store.compact_if_sparse(start + COMPACT_INTERVAL_MS).unwrap().map(|(before, _)| before),
            Some(size)
        );
        let compacted = store.disk_bytes().unwrap();
        assert!(compacted < size / 4, "{size} -> {compacted}");
        assert_eq!(first.cached().1, OPEN_DATABASE_BYTES, "the compaction reservation was given back");

        // Nothing is lost, and a later write and a reopen see the same library.
        assert_eq!(store.range(0, 10).unwrap().entries.len(), 4);
        assert_eq!(value(&store.latest("0000000000000003").unwrap().unwrap())["v"], "kept");
        store.apply(&[Write { key: K1.into(), base: 0, value: "after".into() }]).unwrap();

        // Below the threshold now: the next hour measures it again and leaves it alone.
        let written = store.disk_bytes().unwrap();
        assert_eq!(store.compact_if_sparse(start + 2 * COMPACT_INTERVAL_MS).unwrap(), None);
        assert_eq!(store.disk_bytes().unwrap(), written);
        let head = store.protocol().unwrap().head;
        drop(store);
        drop(first);
        let reopened = manager(&dir, 4, 256 << 20, 64 << 20);
        let store = reopened.library(id, TOKEN).unwrap();
        assert_eq!(store.protocol().unwrap().head, head);
        assert_eq!(value(&store.latest(K1).unwrap().unwrap())["v"], "after");
    }

    #[test]
    fn compaction_waits_when_the_open_database_budget_has_no_room_for_it() {
        let dir = temp_dir();
        let tight = manager(&dir, 2, 256 << 20, 64 << 20);
        let (store, head) = grown(&tight, "1111111111111111");
        shrink(store.as_ref(), head);
        let _other = tight.library("2222222222222222", TOKEN).unwrap();
        let size = store.disk_bytes().unwrap();
        assert_eq!(store.compact_if_sparse(1_000_000).unwrap(), None);
        assert_eq!(store.disk_bytes().unwrap(), size);
        assert_eq!(tight.cached().1, 2 * OPEN_DATABASE_BYTES);
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
    fn an_exact_identity_page_is_shared_until_its_library_commits() {
        let dir = temp_dir();
        let manager = manager(&dir, 1, 32 << 20, 8 << 20);
        let store = manager.library("1111111111111111", TOKEN).unwrap();
        store.apply(&[Write { key: K1.into(), base: 0, value: "old".into() }]).unwrap();
        let first = store.range_chunks(0, 500, "generation").unwrap();
        let hit = store.cached_range_chunks(0, 500, "generation").unwrap();
        assert_eq!(first.len, hit.len);
        assert_eq!(first.chunks[0].as_ptr(), hit.chunks[0].as_ptr(), "the immutable bytes are shared");

        store.apply(&[Write { key: K1.into(), base: 1, value: "new".into() }]).unwrap();
        let after = store.range_chunks(0, 500, "generation").unwrap();
        assert_ne!(first.chunks[0].as_ptr(), after.chunks[0].as_ptr());
        let joined: Vec<u8> = after.chunks.into_iter().flatten().collect();
        let decoded: serde_json::Value = serde_json::from_slice(&joined).unwrap();
        assert_eq!(decoded["head"], 2);
        assert_eq!(decoded["entries"][0]["v"], "new");
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
    fn an_active_burst_recovers_to_two_idle_database_handles() {
        let dir = temp_dir();
        let manager = manager(&dir, 16, 128 << 20, 4 << 20);
        let leases: Vec<_> =
            (0..16).map(|id| manager.library(&format!("{id:016x}"), TOKEN).unwrap()).collect();
        assert_eq!(manager.cached(), (16, 16 * OPEN_DATABASE_BYTES, 16));
        assert!(matches!(manager.library("ffffffffffffffff", TOKEN), Err(StoreError::Full)));
        drop(leases);
        assert_eq!(manager.cached(), (RETAINED_DATABASES, RETAINED_DATABASES * OPEN_DATABASE_BYTES, 2));
    }

    #[test]
    fn closed_libraries_leave_no_dead_process_registry_keys() {
        let dir = temp_dir();
        let manager = manager(&dir, 4, 32 << 20, 4 << 20);
        for id in 0..8 {
            drop(manager.library(&format!("{id:016x}"), TOKEN).unwrap());
        }
        drop(manager);
        assert!(!process_databases().lock().unwrap().keys().any(|path| path.starts_with(&dir)));
    }

    #[test]
    fn concurrent_hot_reads_and_eviction_never_race_redb_file_close() {
        let dir = temp_dir();
        let manager = Arc::new(manager(&dir, 8, 128 << 20, 8 << 20));
        for number in 0..12 {
            let store = manager.library(&format!("{number:016x}"), TOKEN).unwrap();
            store.apply(&[Write { key: K1.into(), base: 0, value: number.to_string() }]).unwrap();
        }
        let start = Arc::new(std::sync::Barrier::new(9));
        let mut threads = Vec::new();
        for worker in 0..8 {
            let manager = Arc::clone(&manager);
            let start = Arc::clone(&start);
            threads.push(std::thread::spawn(move || {
                start.wait();
                for iteration in 0..100 {
                    let number = if worker < 2 { 0 } else { (worker + iteration) % 12 };
                    let store = manager.library(&format!("{number:016x}"), TOKEN).unwrap();
                    let page = store.range_chunks(0, 500, "generation").unwrap();
                    assert_ne!(page.len, 0);
                }
            }));
        }
        start.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(manager.cached().0 <= RETAINED_DATABASES);
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
        assert_eq!(manager.cached(), (RETAINED_DATABASES, RETAINED_DATABASES * OPEN_DATABASE_BYTES, 2));
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
