//! Isolated storage bakeoff for issue #140. This target is absent from ordinary production builds.

use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const KEYS: TableDefinition<&str, u64> = TableDefinition::new("keys-v3");
const SEQUENCE: TableDefinition<u64, &[u8]> = TableDefinition::new("sequence-v3");
const META: TableDefinition<&str, u64> = TableDefinition::new("metadata-v3");
const CACHE_BYTES: usize = 64 * 1024;
const ROWS: usize = 500;
const VALUE_BYTES: usize = 768;

type AnyError = Box<dyn std::error::Error + Send + Sync>;
type CowSequence = BTreeMap<u64, (String, Location)>;

trait Store: Send + Sync {
    fn batch(&self, writes: &[(String, Vec<u8>)]) -> Result<(), AnyError>;
    fn range(&self, since: u64, limit: usize) -> Result<(u64, usize, usize, u64), AnyError>;
    fn size(&self) -> Result<u64, AnyError>;
    fn compact(&self) -> Result<(), AnyError>;
}

struct RedbStore {
    database: Mutex<Database>,
    path: PathBuf,
}

impl RedbStore {
    fn open(path: &Path) -> Result<Self, AnyError> {
        let mut builder = Database::builder();
        builder.set_cache_size(CACHE_BYTES);
        let database = builder.create(path)?;
        let transaction = database.begin_write()?;
        transaction.open_table(KEYS)?;
        transaction.open_table(SEQUENCE)?;
        transaction.open_table(META)?;
        transaction.commit()?;
        Ok(Self { database: Mutex::new(database), path: path.to_owned() })
    }
}

impl Store for RedbStore {
    fn batch(&self, writes: &[(String, Vec<u8>)]) -> Result<(), AnyError> {
        let database = self.database.lock().unwrap();
        let transaction = database.begin_write()?;
        let mut head = {
            let metadata = transaction.open_table(META)?;
            let value = metadata.get("head")?.map_or(0, |value| value.value());
            value
        };
        {
            let mut keys = transaction.open_table(KEYS)?;
            let mut sequence = transaction.open_table(SEQUENCE)?;
            for (key, fragment) in writes {
                if let Some(old) = keys.get(key.as_str())?.map(|value| value.value()) {
                    sequence.remove(old)?;
                }
                head += 1;
                sequence.insert(head, fragment.as_slice())?;
                keys.insert(key.as_str(), head)?;
            }
        }
        transaction.open_table(META)?.insert("head", head)?;
        transaction.commit()?;
        Ok(())
    }

    fn range(&self, since: u64, limit: usize) -> Result<(u64, usize, usize, u64), AnyError> {
        let database = self.database.lock().unwrap();
        let transaction = database.begin_read()?;
        let metadata = transaction.open_table(META)?;
        let head = metadata.get("head")?.map_or(0, |value| value.value());
        let table = transaction.open_table(SEQUENCE)?;
        let mut count = 0;
        let mut bytes = 0;
        let mut checksum = 0;
        for item in table.range((std::ops::Bound::Excluded(since), std::ops::Bound::Unbounded))? {
            let (_, fragment) = item?;
            bytes += fragment.value().len();
            checksum = checksum_bytes(checksum, fragment.value());
            count += 1;
            if count == limit {
                break;
            }
        }
        Ok((head, count, bytes, checksum))
    }

    fn size(&self) -> Result<u64, AnyError> {
        Ok(std::fs::metadata(&self.path)?.len())
    }

    fn compact(&self) -> Result<(), AnyError> {
        self.database.lock().unwrap().compact()?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct Location {
    offset: u64,
    len: u32,
}

struct CowState {
    generation: u64,
    head: u64,
    keys: HashMap<String, u64>,
    sequence: CowSequence,
}

/// Minimal copy-on-write indexed fragment file. Payload pages append; a compact index snapshot is atomically
/// replaced after payload fsync. Compaction writes a new generation and switches one durable marker.
struct CowStore {
    dir: PathBuf,
    state: Mutex<CowState>,
}

impl CowStore {
    fn open(dir: &Path) -> Result<Self, AnyError> {
        std::fs::create_dir_all(dir)?;
        let marker = dir.join("CURRENT");
        if !marker.exists() {
            std::fs::write(dir.join("data.0"), [])?;
            write_index(dir, 0, 0, &BTreeMap::new())?;
            atomic_file(&marker, b"0\n")?;
            sync_dir(dir)?;
        }
        let generation: u64 = std::fs::read_to_string(&marker)?.trim().parse()?;
        let (head, sequence) = read_index(&dir.join(format!("index.{generation}")))?;
        let data_len = std::fs::metadata(dir.join(format!("data.{generation}")))?.len();
        if sequence.values().any(|(_, location)| {
            location.offset.checked_add(u64::from(location.len)).is_none_or(|end| end > data_len)
        }) {
            return Err("CoW index points outside its payload file".into());
        }
        let keys = sequence.iter().map(|(&seq, (key, _))| (key.clone(), seq)).collect();
        Ok(Self { dir: dir.to_owned(), state: Mutex::new(CowState { generation, head, keys, sequence }) })
    }

    fn batch_stage(&self, writes: &[(String, Vec<u8>)], publish: bool) -> Result<(), AnyError> {
        let mut state = self.state.lock().unwrap();
        let data_path = self.dir.join(format!("data.{}", state.generation));
        let mut data = OpenOptions::new().append(true).read(true).open(data_path)?;
        let mut next_sequence = state.sequence.clone();
        let mut next_keys = state.keys.clone();
        let mut head = state.head;
        for (key, fragment) in writes {
            let offset = data.seek(SeekFrom::End(0))?;
            data.write_all(fragment)?;
            head += 1;
            if let Some(old) = next_keys.insert(key.clone(), head) {
                next_sequence.remove(&old);
            }
            next_sequence.insert(head, (key.clone(), Location { offset, len: fragment.len().try_into()? }));
        }
        data.sync_all()?;
        if !publish {
            return Ok(());
        }
        write_index(&self.dir, state.generation, head, &next_sequence)?;
        sync_dir(&self.dir)?;
        state.head = head;
        state.keys = next_keys;
        state.sequence = next_sequence;
        Ok(())
    }
}

impl Store for CowStore {
    fn batch(&self, writes: &[(String, Vec<u8>)]) -> Result<(), AnyError> {
        self.batch_stage(writes, true)
    }

    fn range(&self, since: u64, limit: usize) -> Result<(u64, usize, usize, u64), AnyError> {
        let state = self.state.lock().unwrap();
        let mut data = File::open(self.dir.join(format!("data.{}", state.generation)))?;
        let mut count = 0;
        let mut bytes = 0;
        let mut checksum = 0;
        for (_, (_, location)) in state.sequence.range((std::ops::Bound::Excluded(since), std::ops::Bound::Unbounded)) {
            let mut fragment = vec![0; location.len as usize];
            data.seek(SeekFrom::Start(location.offset))?;
            data.read_exact(&mut fragment)?;
            bytes += fragment.len();
            checksum = checksum_bytes(checksum, &fragment);
            count += 1;
            if count == limit {
                break;
            }
        }
        Ok((state.head, count, bytes, checksum))
    }

    fn size(&self) -> Result<u64, AnyError> {
        let state = self.state.lock().unwrap();
        Ok(std::fs::metadata(self.dir.join(format!("data.{}", state.generation)))?.len()
            + std::fs::metadata(self.dir.join(format!("index.{}", state.generation)))?.len())
    }

    fn compact(&self) -> Result<(), AnyError> {
        let mut state = self.state.lock().unwrap();
        let old_generation = state.generation;
        let generation = old_generation + 1;
        let mut old = File::open(self.dir.join(format!("data.{old_generation}")))?;
        let data_path = self.dir.join(format!("data.{generation}"));
        let mut data = OpenOptions::new().create_new(true).write(true).open(&data_path)?;
        let mut sequence = BTreeMap::new();
        for (&seq, (key, location)) in &state.sequence {
            let mut fragment = vec![0; location.len as usize];
            old.seek(SeekFrom::Start(location.offset))?;
            old.read_exact(&mut fragment)?;
            let offset = data.seek(SeekFrom::End(0))?;
            data.write_all(&fragment)?;
            sequence.insert(seq, (key.clone(), Location { offset, len: location.len }));
        }
        data.sync_all()?;
        write_index(&self.dir, generation, state.head, &sequence)?;
        atomic_file(&self.dir.join("CURRENT"), format!("{generation}\n").as_bytes())?;
        sync_dir(&self.dir)?;
        state.generation = generation;
        state.sequence = sequence;
        drop(state);
        let _ = std::fs::remove_file(self.dir.join(format!("data.{old_generation}")));
        let _ = std::fs::remove_file(self.dir.join(format!("index.{old_generation}")));
        sync_dir(&self.dir)?;
        Ok(())
    }
}

fn write_index(
    dir: &Path,
    generation: u64,
    head: u64,
    sequence: &CowSequence,
) -> io::Result<()> {
    let final_path = dir.join(format!("index.{generation}"));
    let temp = dir.join(format!("index.{generation}.next"));
    let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(&temp)?;
    file.write_all(b"LV3I\0\0\0\x01")?;
    file.write_all(&head.to_le_bytes())?;
    file.write_all(&(sequence.len() as u64).to_le_bytes())?;
    for (&seq, (key, location)) in sequence {
        file.write_all(&seq.to_le_bytes())?;
        file.write_all(&location.offset.to_le_bytes())?;
        file.write_all(&location.len.to_le_bytes())?;
        file.write_all(&(key.len() as u32).to_le_bytes())?;
        file.write_all(key.as_bytes())?;
    }
    file.sync_all()?;
    std::fs::rename(temp, final_path)?;
    Ok(())
}

fn read_index(path: &Path) -> Result<(u64, CowSequence), AnyError> {
    let mut file = File::open(path)?;
    let mut magic = [0; 8];
    file.read_exact(&mut magic)?;
    if &magic != b"LV3I\0\0\0\x01" {
        return Err("bad CoW index version".into());
    }
    let head = read_u64(&mut file)?;
    let count = read_u64(&mut file)?;
    if count > 50_000 {
        return Err("CoW index row limit exceeded".into());
    }
    let mut sequence = BTreeMap::new();
    for _ in 0..count {
        let seq = read_u64(&mut file)?;
        let offset = read_u64(&mut file)?;
        let len = read_u32(&mut file)?;
        let key_len = read_u32(&mut file)? as usize;
        if len > 200 * 1024 || key_len > 256 || seq > head {
            return Err("invalid CoW index bounds".into());
        }
        let mut key = vec![0; key_len];
        file.read_exact(&mut key)?;
        sequence.insert(seq, (String::from_utf8(key)?, Location { offset, len }));
    }
    Ok((head, sequence))
}

fn read_u64(reader: &mut impl Read) -> io::Result<u64> {
    let mut bytes = [0; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn atomic_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = path.with_extension("next");
    let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temp, path)
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

fn fragment(seq: u64, key: &str, fill: u8) -> Vec<u8> {
    let value: String = std::iter::repeat_n(char::from(fill), VALUE_BYTES).collect();
    serde_json::to_vec(&serde_json::json!({"k": key, "seq": seq, "v": value})).unwrap()
}

fn checksum_bytes(mut checksum: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        checksum = checksum.rotate_left(5) ^ u64::from(*byte);
    }
    checksum
}

fn seed(store: &dyn Store) -> Result<(), AnyError> {
    for chunk in (0..ROWS).collect::<Vec<_>>().chunks(50) {
        let writes: Vec<_> = chunk
            .iter()
            .map(|&row| {
                let key = format!("{row:016x}");
                (key.clone(), fragment(row as u64 + 1, &key, b'x'))
            })
            .collect();
        store.batch(&writes)?;
    }
    Ok(())
}

fn percentile(samples: &mut [u128], numerator: usize, denominator: usize) -> u128 {
    samples.sort_unstable();
    samples[(samples.len() - 1) * numerator / denominator]
}

#[derive(Serialize)]
struct Timing {
    backend: &'static str,
    case: &'static str,
    concurrency: usize,
    operations: usize,
    elapsed_ms: u128,
    ops_per_second: f64,
    p50_us: u128,
    p99_us: u128,
    bytes: u64,
    rss_bytes: Option<u64>,
    cgroup_bytes: Option<u64>,
}

fn emit(value: impl Serialize) {
    println!("{}", serde_json::to_string(&value).unwrap());
}

fn timed_writes(
    backend: &'static str,
    root: &Path,
    concurrency: usize,
    operations: usize,
) -> Result<(), AnyError> {
    let mut stores: Vec<Arc<dyn Store>> = Vec::new();
    for worker in 0..concurrency {
        let path = root.join(format!("{backend}-c{concurrency}-{worker}"));
        let store = open_store(backend, &path)?;
        seed(store.as_ref())?;
        stores.push(store);
    }
    let start = Instant::now();
    let mut threads = Vec::new();
    for store in &stores {
        let store = Arc::clone(store);
        threads.push(std::thread::spawn(move || -> Result<Vec<u128>, AnyError> {
            let mut samples = Vec::new();
            for operation in 0..operations {
                let key = format!("{:016x}", operation % 64);
                let write = vec![(key.clone(), fragment(operation as u64 + 1, &key, b'w'))];
                let at = Instant::now();
                store.batch(&write)?;
                samples.push(at.elapsed().as_micros());
            }
            Ok(samples)
        }));
    }
    let mut samples = Vec::new();
    for thread in threads {
        samples.extend(thread.join().unwrap()?);
    }
    let elapsed = start.elapsed();
    let total = operations * concurrency;
    let bytes = stores.iter().map(|store| store.size()).collect::<Result<Vec<_>, _>>()?.into_iter().sum();
    let p50 = percentile(&mut samples.clone(), 50, 100);
    let p99 = percentile(&mut samples, 99, 100);
    emit(Timing {
        backend,
        case: "durable-single-row-write",
        concurrency,
        operations: total,
        elapsed_ms: elapsed.as_millis(),
        ops_per_second: total as f64 / elapsed.as_secs_f64(),
        p50_us: p50,
        p99_us: p99,
        bytes,
        rss_bytes: rss_bytes(),
        cgroup_bytes: cgroup_bytes(),
    });
    Ok(())
}

fn benchmark_backend(backend: &'static str, root: &Path) -> Result<(), AnyError> {
    let path = root.join(format!("{backend}-range"));
    let store = open_store(backend, &path)?;
    seed(store.as_ref())?;
    let mut samples = Vec::new();
    let start = Instant::now();
    let mut read_bytes = 0u64;
    for _ in 0..500 {
        let at = Instant::now();
        let (_, count, bytes, _) = store.range(0, 500)?;
        assert_eq!(count, 500);
        read_bytes += bytes as u64;
        samples.push(at.elapsed().as_micros());
    }
    let elapsed = start.elapsed();
    let p50 = percentile(&mut samples.clone(), 50, 100);
    let p99 = percentile(&mut samples, 99, 100);
    emit(Timing {
        backend,
        case: "sequence-range-500",
        concurrency: 1,
        operations: 500,
        elapsed_ms: elapsed.as_millis(),
        ops_per_second: 500.0 / elapsed.as_secs_f64(),
        p50_us: p50,
        p99_us: p99,
        bytes: read_bytes,
        rss_bytes: rss_bytes(),
        cgroup_bytes: cgroup_bytes(),
    });

    let before = store.size()?;
    for operation in 0..500 {
        let row = operation % 10;
        let key = format!("{row:016x}");
        store.batch(&[(key.clone(), fragment((ROWS + operation + 1) as u64, &key, b'c'))])?;
    }
    let churned = store.size()?;
    let at = Instant::now();
    store.compact()?;
    let compact_ms = at.elapsed().as_millis();
    let compacted = store.size()?;
    emit(serde_json::json!({"backend":backend,"case":"replacement-churn","before_bytes":before,
        "churned_bytes":churned,"compacted_bytes":compacted,"compact_ms":compact_ms}));
    Ok(())
}

fn open_cardinality(backend: &'static str, root: &Path) -> Result<(), AnyError> {
    let mut stores = Vec::new();
    for count in [1, 8, 32, 128] {
        while stores.len() < count {
            let path = root.join(format!("{backend}-open-{}", stores.len()));
            let store = open_store(backend, &path)?;
            store.batch(&[("0000000000000000".into(), fragment(1, "0000000000000000", b'o'))])?;
            stores.push(store);
        }
        emit(serde_json::json!({"backend":backend,"case":"open-libraries","libraries":count,
            "rss_bytes":rss_bytes(),"cgroup_bytes":cgroup_bytes(),
            "file_bytes":stores.iter().map(|store| store.size().unwrap()).sum::<u64>()}));
    }
    Ok(())
}

fn crash_checks(backend: &'static str, root: &Path) -> Result<(), AnyError> {
    for point in ["before-publish", "after-publish"] {
        let path = root.join(format!("{backend}-crash-{point}"));
        let store = open_store(backend, &path)?;
        store.batch(&[("0000000000000000".into(), fragment(1, "0000000000000000", b'a'))])?;
        drop(store);
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--crash-child", backend, point, path.to_str().unwrap()])
            .status()?;
        assert!(!status.success());
        let reopened = open_store(backend, &path)?;
        let (head, count, _, checksum) = reopened.range(0, 500)?;
        let expected = if point == "after-publish" { 2 } else { 1 };
        assert_eq!((head, count), (expected, 1), "{backend} {point}");
        let expected_fragment = fragment(expected, "0000000000000000", if expected == 2 { b'b' } else { b'a' });
        assert_eq!(checksum, checksum_bytes(0, &expected_fragment), "{backend} {point} payload");
        emit(serde_json::json!({"backend":backend,"case":"crash-reopen","point":point,"head":head,
            "payload_checksum":checksum,"passed":true}));
    }
    Ok(())
}

fn crash_child(args: &[String]) -> Result<(), AnyError> {
    let backend = args[2].as_str();
    let point = args[3].as_str();
    let path = Path::new(&args[4]);
    let write = [("0000000000000000".into(), fragment(2, "0000000000000000", b'b'))];
    if backend == "cow" {
        let store = CowStore::open(path)?;
        store.batch_stage(&write, point == "after-publish")?;
    } else {
        let store = RedbStore::open(&path.with_extension("redb"))?;
        if point == "before-publish" {
            let database = store.database.lock().unwrap();
            let transaction = database.begin_write()?;
            transaction.open_table(SEQUENCE)?.insert(2, write[0].1.as_slice())?;
        } else {
            store.batch(&write)?;
        }
    }
    std::process::abort();
}

fn open_store(backend: &str, path: &Path) -> Result<Arc<dyn Store>, AnyError> {
    if backend == "redb" {
        Ok(Arc::new(RedbStore::open(&path.with_extension("redb"))?))
    } else {
        Ok(Arc::new(CowStore::open(path)?))
    }
}

fn rss_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/status").ok()?;
    let kb: u64 = text.lines().find(|line| line.starts_with("VmRSS:"))?.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

fn cgroup_bytes() -> Option<u64> {
    std::fs::read_to_string("/sys/fs/cgroup/memory.current").ok()?.trim().parse().ok()
}

fn cgroup_value(name: &str) -> Option<String> {
    std::fs::read_to_string(format!("/sys/fs/cgroup/{name}")).ok().map(|value| value.trim().to_owned())
}

fn main() -> Result<(), AnyError> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--crash-child") {
        return crash_child(&args);
    }
    let root = std::env::var_os("LIBRARY_V3_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("den-library-v3-bench-{}", std::process::id())));
    std::fs::create_dir_all(&root)?;
    emit(serde_json::json!({"case":"environment","root":root,"cache_bytes":CACHE_BYTES,
        "rows":ROWS,"value_bytes":VALUE_BYTES,"rss_bytes":rss_bytes(),"cgroup_bytes":cgroup_bytes(),
        "memory_max":cgroup_value("memory.max"),"swap_max":cgroup_value("memory.swap.max")}));
    let selected = std::env::var("LIBRARY_V3_BACKEND").ok();
    for backend in ["redb", "cow"].into_iter().filter(|backend| selected.as_deref().is_none_or(|only| only == *backend)) {
        benchmark_backend(backend, &root)?;
        for concurrency in [1, 4, 8] {
            timed_writes(backend, &root, concurrency, 40)?;
        }
        crash_checks(backend, &root)?;
        open_cardinality(backend, &root)?;
    }
    std::thread::sleep(Duration::from_millis(100));
    emit(serde_json::json!({"case":"complete","passed":true,"rss_bytes":rss_bytes(),
        "cgroup_bytes":cgroup_bytes(),"cgroup_peak":cgroup_value("memory.peak"),
        "memory_events":cgroup_value("memory.events")}));
    Ok(())
}
