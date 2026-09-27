//! A Linux-only exact-file fast path. Plain file-backed mappings are not safe here: truncating a mapped inode can
//! raise SIGBUS in safe Rust. An eligible opened generation is therefore copied once, off the Tokio workers, into a
//! prefaulted anonymous mapping and made read-only. Hot responses share that mapping; ordinary file streaming remains
//! the fallback for every platform, miss, budget refusal, and build failure.

use axum::body::Bytes;
use http_body::{Frame, SizeHint};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

pub(crate) const MIN_BYTES: u64 = 64 * 1024;
pub(crate) const MAX_BYTES: u64 = 512 * 1024;
#[cfg(target_os = "linux")]
pub(crate) const BUDGET_BYTES: usize = 8 * 1024 * 1024;
#[cfg(target_os = "linux")]
pub(crate) const BUDGET_COUNT: usize = 32;
#[cfg(target_os = "linux")]
const CHUNK: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct Cache {
    inner: Arc<Inner>,
}

struct Inner {
    metrics: Arc<crate::metrics::Metrics>,
    #[cfg(target_os = "linux")]
    entries: tokio::sync::Mutex<Entries>,
    #[cfg(target_os = "linux")]
    bytes: Arc<tokio::sync::Semaphore>,
    #[cfg(target_os = "linux")]
    count: Arc<tokio::sync::Semaphore>,
    #[cfg(all(test, target_os = "linux"))]
    build_gate: std::sync::Mutex<Option<Arc<TestBuildGate>>>,
}

#[cfg(all(test, target_os = "linux"))]
#[derive(Default)]
struct TestBuildGate {
    started: std::sync::atomic::AtomicBool,
    release: std::sync::atomic::AtomicBool,
}

impl Cache {
    pub(crate) fn new(metrics: Arc<crate::metrics::Metrics>) -> Self {
        Self {
            inner: Arc::new(Inner {
                metrics,
                #[cfg(target_os = "linux")]
                entries: tokio::sync::Mutex::new(Entries::default()),
                #[cfg(target_os = "linux")]
                bytes: Arc::new(tokio::sync::Semaphore::new(BUDGET_BYTES)),
                #[cfg(target_os = "linux")]
                count: Arc::new(tokio::sync::Semaphore::new(BUDGET_COUNT)),
                #[cfg(all(test, target_os = "linux"))]
                build_gate: std::sync::Mutex::new(None),
            }),
        }
    }

    pub(crate) fn body(&self, file: tokio::fs::File, len: u64) -> ExactBody {
        ExactBody::new(file, len, self.clone())
    }
}

pub(crate) struct ExactBody {
    state: State,
    len: u64,
}

enum State {
    Start(Option<(tokio::fs::File, Cache)>),
    #[cfg(target_os = "linux")]
    Building(Pin<Box<dyn std::future::Future<Output = Result<MappedBody, tokio::fs::File>> + Send>>),
    #[cfg(target_os = "linux")]
    Mapped(MappedBody),
    File(crate::web::FileBody),
}

impl ExactBody {
    fn new(file: tokio::fs::File, len: u64, cache: Cache) -> Self {
        Self { state: State::Start(Some((file, cache))), len }
    }
}

impl http_body::Body for ExactBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        loop {
            match &mut self.state {
                State::Start(start) => {
                    let (file, cache) = start.take().expect("an exact body starts once");
                    if !(MIN_BYTES..=MAX_BYTES).contains(&self.len) {
                        cache.inner.metrics.mmap_outcome(2);
                        self.state = State::File(crate::web::FileBody::from_file(file, self.len));
                        continue;
                    }
                    #[cfg(target_os = "linux")]
                    {
                        let len = self.len;
                        self.state = State::Building(Box::pin(async move { cache.mapping(file, len).await }));
                        continue;
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        cache.inner.metrics.mmap_outcome(2);
                        self.state = State::File(crate::web::FileBody::from_file(file, self.len));
                        continue;
                    }
                }
                #[cfg(target_os = "linux")]
                State::Building(build) => match build.as_mut().poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Ok(mapped)) => {
                        self.state = State::Mapped(mapped);
                        continue;
                    }
                    Poll::Ready(Err(file)) => {
                        self.state = State::File(crate::web::FileBody::from_file(file, self.len));
                        continue;
                    }
                },
                #[cfg(target_os = "linux")]
                State::Mapped(body) => return Pin::new(body).poll_frame(cx),
                State::File(body) => return Pin::new(body).poll_frame(cx),
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.state {
            #[cfg(target_os = "linux")]
            State::Mapped(body) => body.is_end_stream(),
            State::File(body) => body.is_end_stream(),
            State::Start(_) => self.len == 0,
            #[cfg(target_os = "linux")]
            State::Building(_) => false,
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.state {
            #[cfg(target_os = "linux")]
            State::Mapped(body) => body.size_hint(),
            State::File(body) => body.size_hint(),
            State::Start(_) => SizeHint::with_exact(self.len),
            #[cfg(target_os = "linux")]
            State::Building(_) => SizeHint::with_exact(self.len),
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Seek};
    use std::os::unix::fs::MetadataExt;

    #[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
    struct Key {
        device: u64,
        inode: u64,
        len: u64,
        modified_seconds: i64,
        modified_nanos: i64,
    }

    impl Key {
        fn of(metadata: &std::fs::Metadata) -> Self {
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                len: metadata.len(),
                modified_seconds: metadata.mtime(),
                modified_nanos: metadata.mtime_nsec(),
            }
        }
    }

    #[derive(Default)]
    pub(super) struct Entries {
        values: HashMap<Key, (Arc<Mapping>, u64)>,
        clock: u64,
        bytes: usize,
    }

    struct Mapping {
        bytes: memmap2::Mmap,
        metrics: Arc<crate::metrics::Metrics>,
        _bytes: tokio::sync::OwnedSemaphorePermit,
        _count: tokio::sync::OwnedSemaphorePermit,
    }

    impl Drop for Mapping {
        fn drop(&mut self) {
            self.metrics.mmap_resident_remove(self.bytes.len());
        }
    }

    struct ChunkOwner(Arc<Mapping>);

    impl AsRef<[u8]> for ChunkOwner {
        fn as_ref(&self) -> &[u8] {
            &self.0.bytes
        }
    }

    pub(super) struct MappedBody {
        mapping: Arc<Mapping>,
        offset: usize,
    }

    impl http_body::Body for MappedBody {
        type Data = Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
            if self.offset == self.mapping.bytes.len() {
                return Poll::Ready(None);
            }
            let end = (self.offset + CHUNK).min(self.mapping.bytes.len());
            let frame = Bytes::from_owner(ChunkOwner(Arc::clone(&self.mapping))).slice(self.offset..end);
            self.offset = end;
            Poll::Ready(Some(Ok(Frame::data(frame))))
        }

        fn is_end_stream(&self) -> bool {
            self.offset == self.mapping.bytes.len()
        }

        fn size_hint(&self) -> SizeHint {
            SizeHint::with_exact((self.mapping.bytes.len() - self.offset) as u64)
        }
    }

    enum Fault {
        Map,
        Read,
        Generation,
    }

    impl Cache {
        pub(super) async fn mapping(
            self,
            file: tokio::fs::File,
            len: u64,
        ) -> Result<MappedBody, tokio::fs::File> {
            let mut file = file.into_std().await;
            let initial = match file.metadata() {
                Ok(metadata) if metadata.is_file() && metadata.len() == len => Key::of(&metadata),
                _ => {
                    self.inner.metrics.mmap_fault(2);
                    return Err(tokio::fs::File::from_std(file));
                }
            };
            {
                let mut entries = self.inner.entries.lock().await;
                entries.clock = entries.clock.wrapping_add(1);
                let clock = entries.clock;
                if let Some((mapping, touched)) = entries.values.get_mut(&initial) {
                    *touched = clock;
                    self.inner.metrics.mmap_outcome(0);
                    return Ok(MappedBody { mapping: Arc::clone(mapping), offset: 0 });
                }
                while self.inner.bytes.available_permits() < len as usize
                    || self.inner.count.available_permits() == 0
                {
                    let Some(key) = entries
                        .values
                        .iter()
                        .filter(|(_, (mapping, _))| Arc::strong_count(mapping) == 1)
                        .min_by_key(|(_, (_, touched))| *touched)
                        .map(|(key, _)| *key)
                    else {
                        self.inner.metrics.mmap_outcome(3);
                        let _ = file.seek(std::io::SeekFrom::Start(0));
                        return Err(tokio::fs::File::from_std(file));
                    };
                    if let Some((removed, _)) = entries.values.remove(&key) {
                        entries.bytes = entries.bytes.saturating_sub(removed.bytes.len());
                        self.inner.metrics.mmap_outcome(5);
                    }
                }
                self.inner.metrics.mmap_cached(entries.values.len(), entries.bytes);
            }
            let Ok(bytes) = u32::try_from(len) else {
                self.inner.metrics.mmap_outcome(2);
                return Err(tokio::fs::File::from_std(file));
            };
            let Ok(bytes_permit) = Arc::clone(&self.inner.bytes).try_acquire_many_owned(bytes) else {
                self.inner.metrics.mmap_outcome(3);
                return Err(tokio::fs::File::from_std(file));
            };
            let Ok(count_permit) = Arc::clone(&self.inner.count).try_acquire_owned() else {
                self.inner.metrics.mmap_outcome(3);
                return Err(tokio::fs::File::from_std(file));
            };
            let mut build_file = match file.try_clone() {
                Ok(file) => file,
                Err(_) => {
                    self.inner.metrics.mmap_fault(1);
                    return Err(tokio::fs::File::from_std(file));
                }
            };
            #[cfg(test)]
            let build_gate = crate::lock(&self.inner.build_gate).clone();
            // The blocking owner, rather than the requesting future, holds both permits. Cancellation may detach a
            // spawn_blocking job, but it cannot make that job's allocation invisible to either hard budget.
            let built = tokio::task::spawn_blocking(move || {
                #[cfg(test)]
                if let Some(gate) = build_gate {
                    use std::sync::atomic::Ordering;
                    gate.started.store(true, Ordering::Release);
                    while !gate.release.load(Ordering::Acquire) {
                        std::thread::yield_now();
                    }
                }
                let result = (|| {
                    build_file.seek(std::io::SeekFrom::Start(0)).map_err(|_| Fault::Read)?;
                    let mut mapped = memmap2::MmapMut::map_anon(len as usize).map_err(|_| Fault::Map)?;
                    build_file.read_exact(&mut mapped).map_err(|_| Fault::Read)?;
                    if Key::of(&build_file.metadata().map_err(|_| Fault::Generation)?) != initial {
                        return Err(Fault::Generation);
                    }
                    mapped.make_read_only().map_err(|_| Fault::Map)
                })();
                result.map(|mapped| (mapped, bytes_permit, count_permit))
            })
            .await;
            let mapped = match built {
                Ok(result) => result,
                Err(_) => {
                    self.inner.metrics.mmap_fault(1);
                    let _ = file.seek(std::io::SeekFrom::Start(0));
                    return Err(tokio::fs::File::from_std(file));
                }
            };
            let mapped = match mapped {
                Ok(mapped) => mapped,
                Err(fault) => {
                    self.inner.metrics.mmap_fault(match fault {
                        Fault::Map => 0,
                        Fault::Read => 1,
                        Fault::Generation => 2,
                    });
                    return Err(tokio::fs::File::from_std(file));
                }
            };
            let (mapped, bytes_permit, count_permit) = mapped;
            self.inner.metrics.mmap_resident_add(mapped.len());
            let mapping = Arc::new(Mapping {
                bytes: mapped,
                metrics: Arc::clone(&self.inner.metrics),
                _bytes: bytes_permit,
                _count: count_permit,
            });
            let mut entries = self.inner.entries.lock().await;
            entries.clock = entries.clock.wrapping_add(1);
            let clock = entries.clock;
            let mapping = if let Some((existing, touched)) = entries.values.get_mut(&initial) {
                *touched = clock;
                Arc::clone(existing)
            } else {
                entries.bytes += mapping.bytes.len();
                entries.values.insert(initial, (Arc::clone(&mapping), clock));
                mapping
            };
            self.inner.metrics.mmap_cached(entries.values.len(), entries.bytes);
            self.inner.metrics.mmap_outcome(1);
            Ok(MappedBody { mapping, offset: 0 })
        }
    }
}

#[cfg(target_os = "linux")]
use linux::{Entries, MappedBody};

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use http_body_util::BodyExt as _;

    fn fixture(byte: u8, len: usize) -> (std::path::PathBuf, tokio::fs::File) {
        let dir = crate::handler::tests::temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{byte}.bin"));
        std::fs::write(&path, vec![byte; len]).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        (path, tokio::fs::File::from_std(file))
    }

    fn value(rendered: &str, name: &str) -> usize {
        rendered
            .lines()
            .find_map(|line| line.strip_prefix(name).and_then(|rest| rest.strip_prefix(' ')))
            .unwrap_or_else(|| panic!("missing {name} in {rendered}"))
            .parse()
            .unwrap()
    }

    #[tokio::test]
    async fn an_unpolled_exact_body_never_maps() {
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let cache = Cache::new(Arc::clone(&metrics));
        let (_, file) = fixture(1, MIN_BYTES as usize);
        drop(cache.body(file, MIN_BYTES));
        let rendered = metrics.render();
        assert!(rendered.contains("den_edge_mmap_total{outcome=\"built\"} 0\n"));
        assert_eq!(value(&rendered, "den_edge_mmap_resident_bytes"), 0);
    }

    #[tokio::test]
    async fn cancellation_keeps_a_detached_build_charged_until_it_drops() {
        use std::sync::atomic::Ordering;

        let metrics = Arc::new(crate::metrics::Metrics::default());
        let cache = Cache::new(metrics);
        let gate = Arc::new(TestBuildGate::default());
        *crate::lock(&cache.inner.build_gate) = Some(Arc::clone(&gate));
        let (_, file) = fixture(2, MAX_BYTES as usize);
        let body = cache.body(file, MAX_BYTES);
        let task = tokio::spawn(async move { body.collect().await });
        while !gate.started.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        assert_eq!(cache.inner.bytes.available_permits(), BUDGET_BYTES - MAX_BYTES as usize);
        assert_eq!(cache.inner.count.available_permits(), BUDGET_COUNT - 1);

        task.abort();
        let _ = task.await;
        // The request is gone, but its detached blocking job remains charged.
        assert_eq!(cache.inner.bytes.available_permits(), BUDGET_BYTES - MAX_BYTES as usize);
        assert_eq!(cache.inner.count.available_permits(), BUDGET_COUNT - 1);
        gate.release.store(true, Ordering::Release);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while cache.inner.bytes.available_permits() != BUDGET_BYTES {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(cache.inner.count.available_permits(), BUDGET_COUNT);
    }

    #[tokio::test]
    async fn truncate_after_mapping_cannot_sigbus_or_change_the_response() {
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let cache = Cache::new(metrics);
        let len = MAX_BYTES as usize;
        let (path, file) = fixture(7, len);
        let mut body = cache.body(file, len as u64);
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(first.as_ref(), &vec![7; CHUNK]);

        std::fs::OpenOptions::new().write(true).open(path).unwrap().set_len(0).unwrap();
        let mut received = first.len();
        while let Some(frame) = body.frame().await {
            let frame = frame.unwrap().into_data().unwrap();
            assert!(frame.iter().all(|byte| *byte == 7));
            received += frame.len();
        }
        assert_eq!(received, len);
    }

    #[tokio::test]
    async fn atomic_replacement_keeps_each_open_generation_exact() {
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let cache = Cache::new(metrics);
        let len = MIN_BYTES as usize;
        let (path, file) = fixture(3, len);
        let mut old = cache.body(file, len as u64);
        let first = old.frame().await.unwrap().unwrap().into_data().unwrap();

        let replacement = path.with_extension("new");
        std::fs::write(&replacement, vec![9; len]).unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let new_file = tokio::fs::File::open(&path).await.unwrap();
        let new = cache.body(new_file, len as u64).collect().await.unwrap().to_bytes();
        assert!(new.iter().all(|byte| *byte == 9));

        let mut old_bytes = first.to_vec();
        while let Some(frame) = old.frame().await {
            old_bytes.extend_from_slice(&frame.unwrap().into_data().unwrap());
        }
        assert_eq!(old_bytes.len(), len);
        assert!(old_bytes.iter().all(|byte| *byte == 3));
    }

    #[tokio::test]
    async fn live_mappings_never_cross_the_byte_budget_and_churn_falls_back() {
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let cache = Cache::new(Arc::clone(&metrics));
        let mut held = Vec::new();
        for byte in 0..48 {
            let (_, file) = fixture(byte, MAX_BYTES as usize);
            let mut body = cache.body(file, MAX_BYTES);
            let frame = body.frame().await.unwrap().unwrap();
            held.push((body, frame));
        }
        let rendered = metrics.render();
        assert_eq!(value(&rendered, "den_edge_mmap_resident_bytes"), BUDGET_BYTES);
        assert_eq!(value(&rendered, "den_edge_mmap_resident_count"), BUDGET_BYTES / MAX_BYTES as usize);
        assert!(rendered.contains("den_edge_mmap_total{outcome=\"budget\"} 32\n"));

        drop(held);
        for byte in 32..49 {
            let (_, file) = fixture(byte, MAX_BYTES as usize);
            cache.body(file, MAX_BYTES).collect().await.unwrap();
        }
        let rendered = metrics.render();
        assert!(value(&rendered, "den_edge_mmap_total{outcome=\"evicted\"}") > 0);
        assert!(value(&rendered, "den_edge_mmap_resident_bytes") <= BUDGET_BYTES);
        assert!(value(&rendered, "den_edge_mmap_resident_count") <= BUDGET_COUNT);
    }

    #[tokio::test]
    async fn count_budget_is_independent_and_ineligible_files_stream_normally() {
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let cache = Cache::new(Arc::clone(&metrics));
        let mut held = Vec::new();
        for byte in 64..=96 {
            let (_, file) = fixture(byte, MIN_BYTES as usize);
            let mut body = cache.body(file, MIN_BYTES);
            let frame = body.frame().await.unwrap().unwrap();
            held.push((body, frame));
        }
        let (_, tiny) = fixture(127, MIN_BYTES as usize - 1);
        let bytes = cache.body(tiny, MIN_BYTES - 1).collect().await.unwrap().to_bytes();
        assert_eq!(bytes.len(), MIN_BYTES as usize - 1);
        let rendered = metrics.render();
        assert_eq!(value(&rendered, "den_edge_mmap_resident_count"), BUDGET_COUNT);
        assert!(value(&rendered, "den_edge_mmap_total{outcome=\"budget\"}") >= 1);
        assert_eq!(value(&rendered, "den_edge_mmap_total{outcome=\"ineligible\"}"), 1);
    }

    async fn drain<B>(mut body: B) -> usize
    where
        B: http_body::Body<Data = Bytes> + Unpin,
        B::Error: std::fmt::Debug,
    {
        let mut bytes = 0;
        while let Some(frame) = body.frame().await {
            bytes += frame.unwrap().data_ref().map_or(0, Bytes::len);
        }
        bytes
    }

    /// Manual release probe for the hot-body work this optimization removes. This is deliberately not a substitute
    /// for the issue's target-host HTTP/cgroup gate.
    #[tokio::test]
    #[ignore]
    async fn exact_file_hot_body_benchmark() {
        let len = 245 * 1024;
        let (path, _) = fixture(42, len);
        let iterations = 2_000;

        let started = std::time::Instant::now();
        for _ in 0..iterations {
            let file = tokio::fs::File::open(&path).await.unwrap();
            assert_eq!(drain(crate::web::FileBody::from_file(file, len as u64)).await, len);
        }
        let ordinary = started.elapsed();

        let cache = Cache::new(Arc::new(crate::metrics::Metrics::default()));
        assert_eq!(drain(cache.body(tokio::fs::File::open(&path).await.unwrap(), len as u64)).await, len);
        let started = std::time::Instant::now();
        for _ in 0..iterations {
            let file = tokio::fs::File::open(&path).await.unwrap();
            assert_eq!(drain(cache.body(file, len as u64)).await, len);
        }
        let mapped = started.elapsed();
        eprintln!(
            "{iterations} x {len} bytes: ordinary={ordinary:?} mapped={mapped:?} speedup={:.2}x",
            ordinary.as_secs_f64() / mapped.as_secs_f64()
        );
    }
}
