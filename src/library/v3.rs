//! Feature-gated library-v3 storage. Nothing in the HTTP path selects this module yet.

use super::{constant_time_eq, row_fragment, valid_hex_id, MAX_LIMIT, MAX_ROWS, MAX_VALUE, MAX_WRITES, PAGE_BYTES};
use redb::backends::FileBackend;
use redb::{
    BackendError, Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, StorageBackend, TableDefinition,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io;
use std::ops::Bound::{Excluded, Unbounded};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const FORMAT_VERSION: u64 = 3;
pub(super) const DATABASE_CACHE_BYTES: usize = 64 * 1024;
pub(super) const OPEN_DATABASE_BYTES: usize = 112 * 1024;
const KEYS: TableDefinition<&str, u64> = TableDefinition::new("keys-v3");
const SEQUENCE: TableDefinition<u64, &[u8]> = TableDefinition::new("sequence-v3");
const META_U64: TableDefinition<&str, u64> = TableDefinition::new("metadata-u64-v3");
const META_BYTES: TableDefinition<&str, &[u8]> = TableDefinition::new("metadata-bytes-v3");

#[derive(Debug)]
pub(super) enum StoreError {
    Full,
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

pub(super) trait LibraryStore: Send + Sync {
    fn apply(&self, writes: &[Write]) -> Result<BatchResult, StoreError>;
    fn latest(&self, key: &str) -> Result<Option<StoredRow>, StoreError>;
    fn range(&self, since: u64, limit: usize) -> Result<RangePage, StoreError>;
    fn disk_bytes(&self) -> Result<u64, StoreError>;
}

/// Aggregate disk reservation shared by every v3 database. File growth is reserved atomically before redb may
/// perform it, so independent library writers cannot each consume the last bytes.
#[derive(Debug)]
struct DiskQuota {
    used: AtomicU64,
    cap: u64,
}

impl DiskQuota {
    fn resize(&self, old: u64, new: u64) -> io::Result<()> {
        if new <= old {
            let removing = old - new;
            let mut used = self.used.load(Ordering::Acquire);
            loop {
                let Some(next) = used.checked_sub(removing) else {
                    return Err(io::Error::other("v3 disk accounting underflow"));
                };
                match self.used.compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire) {
                    Ok(_) => return Ok(()),
                    Err(actual) => used = actual,
                }
            }
        }
        let adding = new - old;
        let mut used = self.used.load(Ordering::Acquire);
        loop {
            let Some(next) = used.checked_add(adding) else { return Err(io::ErrorKind::StorageFull.into()) };
            if next > self.cap {
                return Err(io::ErrorKind::StorageFull.into());
            }
            match self.used.compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return Ok(()),
                Err(actual) => used = actual,
            }
        }
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

    fn try_lock_range(&self, start: std::ops::Bound<u64>, end: std::ops::Bound<u64>) -> Result<bool, BackendError> {
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

    fn unlock_range(&self, start: std::ops::Bound<u64>, end: std::ops::Bound<u64>) -> Result<(), BackendError> {
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
    path: PathBuf,
    token_hash: [u8; 32],
    member_hash: Option<[u8; 32]>,
}

impl RedbLibrary {
    fn open(
        path: &Path,
        quota: Arc<DiskQuota>,
        file_cap: u64,
        token_hash: [u8; 32],
        member_hash: Option<[u8; 32]>,
    ) -> Result<Self, StoreError> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(StoreError::io)?;
        let backend = QuotaBackend {
            inner: FileBackend::new(file).map_err(StoreError::redb)?,
            quota,
            file_cap,
        };
        let mut builder = Database::builder();
        builder.set_cache_size(DATABASE_CACHE_BYTES);
        let database = builder.create_with_backend(backend).map_err(StoreError::redb)?;
        let transaction = database.begin_write().map_err(StoreError::redb)?;
        let version = {
            let metadata = transaction.open_table(META_U64).map_err(StoreError::redb)?;
            let value = metadata.get("format").map_err(StoreError::redb)?.map(|value| value.value());
            value
        };
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
                    return Err(StoreError::Invalid("v3 token does not match".into()));
                }
                let stored_member = metadata.get("member").map_err(StoreError::redb)?;
                let member_matches = match (stored_member.as_ref(), member_hash.as_ref()) {
                    (None, None) => true,
                    (Some(stored), Some(expected)) => constant_time_eq(stored.value(), expected),
                    _ => false,
                };
                if !member_matches {
                    return Err(StoreError::Invalid("v3 member proof does not match".into()));
                }
            }
            transaction.abort().map_err(StoreError::redb)?;
        } else {
            {
                let mut numbers = transaction.open_table(META_U64).map_err(StoreError::redb)?;
                numbers.insert("format", FORMAT_VERSION).map_err(StoreError::redb)?;
                numbers.insert("head", 0).map_err(StoreError::redb)?;
                let mut bytes = transaction.open_table(META_BYTES).map_err(StoreError::redb)?;
                bytes.insert("token", token_hash.as_slice()).map_err(StoreError::redb)?;
                if let Some(member) = member_hash {
                    bytes.insert("member", member.as_slice()).map_err(StoreError::redb)?;
                }
                transaction.open_table(KEYS).map_err(StoreError::redb)?;
                transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
            }
            transaction.commit().map_err(StoreError::redb)?;
        }
        Ok(Self { database, path: path.to_owned(), token_hash, member_hash })
    }

    fn row(&self, sequence: u64, fragment: &[u8]) -> StoredRow {
        StoredRow { sequence, fragment: Arc::from(fragment) }
    }

    fn accepts(&self, token_hash: &[u8; 32], member_hash: Option<&[u8; 32]>) -> bool {
        constant_time_eq(&self.token_hash, token_hash)
            && match (self.member_hash.as_ref(), member_hash) {
                (None, None) => true,
                (Some(stored), Some(expected)) => constant_time_eq(stored, expected),
                _ => false,
            }
    }
}

impl LibraryStore for RedbLibrary {
    fn apply(&self, writes: &[Write]) -> Result<BatchResult, StoreError> {
        let mut unique = HashSet::with_capacity(writes.len());
        if writes.len() > MAX_WRITES
            || writes.iter().any(|write| {
                write.value.len() > MAX_VALUE || !valid_hex_id(&write.key) || !unique.insert(write.key.as_str())
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
        let (live_rows, new_rows) = {
            let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            let live = keys.len().map_err(StoreError::redb)?;
            let mut new = 0;
            for write in writes {
                new += u64::from(keys.get(write.key.as_str()).map_err(StoreError::redb)?.is_none());
            }
            (live, new)
        };
        if live_rows + new_rows > MAX_ROWS as u64 {
            return Err(StoreError::Full);
        }
        let mut accepted = Vec::new();
        let mut conflicts = Vec::new();
        {
            let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            let sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
            for write in writes {
                let current_sequence = keys.get(write.key.as_str()).map_err(StoreError::redb)?.map(|v| v.value());
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
                accepted.push((write, current_sequence, head, row_fragment(head, &write.key, &write.value)));
            }
        }
        {
            let mut keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
            let mut sequence = transaction.open_table(SEQUENCE).map_err(StoreError::redb)?;
            for (write, old, new, fragment) in &accepted {
                if let Some(old) = old {
                    sequence.remove(*old).map_err(StoreError::redb)?;
                }
                sequence.insert(*new, fragment.as_ref()).map_err(StoreError::redb)?;
                keys.insert(write.key.as_str(), *new).map_err(StoreError::redb)?;
            }
        }
        transaction
            .open_table(META_U64)
            .map_err(StoreError::redb)?
            .insert("head", head)
            .map_err(StoreError::redb)?;
        transaction.commit().map_err(StoreError::redb)?;
        Ok(BatchResult {
            head,
            applied: accepted.into_iter().map(|(write, _, seq, _)| (write.key.clone(), seq)).collect(),
            conflicts,
        })
    }

    fn latest(&self, key: &str) -> Result<Option<StoredRow>, StoreError> {
        let transaction = self.database.begin_read().map_err(StoreError::redb)?;
        let keys = transaction.open_table(KEYS).map_err(StoreError::redb)?;
        let Some(sequence_number) = keys.get(key).map_err(StoreError::redb)?.map(|value| value.value()) else {
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

    fn disk_bytes(&self) -> Result<u64, StoreError> {
        Ok(std::fs::metadata(&self.path).map_err(StoreError::io)?.len())
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
pub(super) struct StoreManager {
    root: PathBuf,
    registry: Mutex<Registry>,
    clock: AtomicU64,
    memory_cap: usize,
    file_cap: u64,
    quota: Arc<DiskQuota>,
}

impl StoreManager {
    pub fn open(root: &Path, memory_cap: usize, disk_cap: u64, file_cap: u64) -> Result<Self, StoreError> {
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
            quota: Arc::new(DiskQuota { used: AtomicU64::new(used), cap: disk_cap }),
        })
    }

    pub fn library(
        &self,
        id: &str,
        token_hash: [u8; 32],
        member_hash: Option<[u8; 32]>,
    ) -> Result<Arc<dyn LibraryStore>, StoreError> {
        if !valid_hex_id(id) {
            return Err(StoreError::Invalid("invalid v3 library id".into()));
        }
        let now = self.clock.fetch_add(1, Ordering::Relaxed);
        let slot = {
            let mut registry = self.registry.lock().unwrap();
            Arc::clone(registry.slots.entry(id.to_owned()).or_insert_with(|| {
                Arc::new(Slot { store: Mutex::new(None), last_used: AtomicU64::new(now) })
            }))
        };
        slot.last_used.store(now, Ordering::Relaxed);
        let mut stored = slot.store.lock().unwrap();
        if let Some(store) = stored.as_ref() {
            if !store.accepts(&token_hash, member_hash.as_ref()) {
                return Err(StoreError::Invalid("v3 credentials do not match".into()));
            }
            let store: Arc<dyn LibraryStore> = Arc::clone(store) as Arc<dyn LibraryStore>;
            return Ok(store);
        }
        self.reserve_open(id)?;
        let path = self.path(id);
        let created = !path.exists();
        match RedbLibrary::open(&path, Arc::clone(&self.quota), self.file_cap, token_hash, member_hash) {
            Ok(store) => {
                let store = Arc::new(store);
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

    fn path(&self, id: &str) -> PathBuf {
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
        let open = registry
            .slots
            .values()
            .filter(|slot| slot.store.lock().unwrap().is_some())
            .count();
        (open, registry.bytes, registry.slots.len())
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
        let store = first.library(id, TOKEN, None).unwrap();
        assert_eq!(
            store.apply(&[Write { key: K1.into(), base: 0, value: "one".into() }]).unwrap().applied,
            vec![(K1.into(), 1)]
        );
        let conflict = store.apply(&[Write { key: K1.into(), base: 0, value: "lost".into() }]).unwrap();
        assert_eq!(value(conflict.conflicts[0].current.as_ref().unwrap())["v"], "one");
        store.apply(&[
            Write { key: K1.into(), base: 1, value: "two".into() },
            Write { key: K2.into(), base: 0, value: "three".into() },
        ])
        .unwrap();
        assert_eq!(store.range(0, 500).unwrap().entries.len(), 2);
        drop(store);
        drop(first);

        let reopened = manager(&dir, 4, 32 << 20, 8 << 20);
        let store = reopened.library(id, TOKEN, None).unwrap();
        assert!(matches!(reopened.library(id, [8; 32], None), Err(StoreError::Invalid(_))));
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
        let quota = Arc::new(DiskQuota { used: AtomicU64::new(0), cap: 32 << 20 });
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
                .library("cccccccccccccccc", TOKEN, None)
                .unwrap()
                .apply(&[Write { key: K1.into(), base: 1, value: "new".into() }])
                .unwrap();
            std::process::abort();
        } else {
            let path = manager.path("cccccccccccccccc");
            let used = std::fs::metadata(&path).unwrap().len();
            let quota = Arc::new(DiskQuota { used: AtomicU64::new(used), cap: 32 << 20 });
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
                .library("cccccccccccccccc", TOKEN, None)
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
            let store = reopened.library("cccccccccccccccc", TOKEN, None).unwrap();
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
        assert!(matches!(too_small.library("aaaaaaaaaaaaaaaa", TOKEN, None), Err(StoreError::Full)));

        let root = dir.join("aggregate");
        let one = manager(&root, 2, 1200 << 10, 1100 << 10);
        let first = one.library("aaaaaaaaaaaaaaaa", TOKEN, None).unwrap();
        assert!(first.disk_bytes().unwrap() <= 1100 << 10);
        assert!(matches!(one.library("bbbbbbbbbbbbbbbb", TOKEN, None), Err(StoreError::Full)));
    }

    #[test]
    fn open_databases_are_charged_and_inactive_ones_are_evicted() {
        let dir = temp_dir();
        let manager = manager(&dir, 3, 64 << 20, 4 << 20);
        for id in 0..40 {
            let store = manager.library(&format!("{id:016x}"), TOKEN, None).unwrap();
            store.apply(&[Write { key: K1.into(), base: 0, value: id.to_string() }]).unwrap();
            let (open, bytes, slots) = manager.cached();
            assert!(open <= 3);
            assert_eq!(bytes, open * OPEN_DATABASE_BYTES);
            assert!(slots <= 3);
        }
        assert_eq!(manager.cached(), (3, 3 * OPEN_DATABASE_BYTES, 3));
    }

    #[test]
    fn active_leases_cannot_be_evicted_or_exceed_the_reservation() {
        let dir = temp_dir();
        let manager = manager(&dir, 2, 32 << 20, 4 << 20);
        let first = manager.library("aaaaaaaaaaaaaaaa", TOKEN, None).unwrap();
        let second = manager.library("bbbbbbbbbbbbbbbb", TOKEN, None).unwrap();
        assert!(matches!(manager.library("cccccccccccccccc", TOKEN, None), Err(StoreError::Full)));
        drop(first);
        assert!(manager.library("cccccccccccccccc", TOKEN, None).is_ok());
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
            let store = manager.library(&format!("{id:016x}"), TOKEN, None).unwrap();
            store.apply(&[Write { key: K1.into(), base: 0, value: "x".repeat(4096) }]).unwrap();
        }
        assert!(manager.cached().1 <= 16 * OPEN_DATABASE_BYTES);
        assert!(manager.cached().2 <= 16);
        let current: u64 = std::fs::read_to_string("/sys/fs/cgroup/memory.current")
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(current < 64 << 20, "cgroup used {current} bytes");
        let events = std::fs::read_to_string("/sys/fs/cgroup/memory.events").unwrap();
        let peak: u64 = std::fs::read_to_string("/sys/fs/cgroup/memory.peak").unwrap().trim().parse().unwrap();
        assert!(peak < 64 << 20, "cgroup peaked at {peak} bytes");
        assert!(events.lines().all(|line| !line.starts_with("max ") || line == "max 0"));
        assert!(events.lines().all(|line| !line.starts_with("oom ") || line == "oom 0"));
        assert!(events.lines().all(|line| !line.starts_with("oom_kill ") || line == "oom_kill 0"));
        eprintln!("library-v3 cgroup current={current} peak={peak} {events:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
