//! The durable state: one file per key, under a directory per kind of record. A write goes to a temporary
//! file, is synced, and is renamed over the old one, so a reader sees the old value or the new one and a
//! crash leaves one of them whole. Every mutation happens under `AppState::write_lock`, so there is one
//! writer at a time.
//!
//! File names are the SHA-256 of the key, not the key: an inbox key is a credential, and a name made from
//! it would put it in every directory listing and bound nothing about its length.
//!
//! The store holds at most `cap` bytes: a write that would grow it past that fails as `StorageFull`, so
//! whoever can reach den-edge can't fill the host's disk (issue #8, audit #5).

use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Store {
    dir: PathBuf,
    /// Bytes on disk across every namespace.
    used: AtomicU64,
    cap: u64,
    generation: String,
}

/// The file holding the store's generation, beside the namespaces.
const GENERATION: &str = "generation";

/// The store's generation: a random id, made the first time the store opens and kept after that. The backup leaves
/// its file out, so a store restored from a backup — or one that lost its data and started over — opens with a new
/// one, and a client that remembers how far it read knows those numbers belong to another store (den-spec
/// library-v2 §2).
fn load_generation(dir: &Path) -> io::Result<String> {
    let path = dir.join(GENERATION);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let id = text.trim();
        if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(id.to_owned());
        }
    }
    let id = crate::hex(&crate::random_bytes::<16>());
    std::fs::write(&path, format!("{id}\n"))?;
    Ok(id)
}

/// The kinds of record, one directory each.
pub const NAMESPACES: [&str; 5] = ["inbox", "plugins", "settings", "sync", "lib"];

/// The cap unless `STORE_CAP_BYTES` sets one: far past one household's few MB.
pub const DEFAULT_CAP: u64 = 1 << 30;

impl Store {
    pub fn open(dir: &Path, cap: u64) -> io::Result<Store> {
        let mut used = 0;
        for ns in NAMESPACES {
            std::fs::create_dir_all(dir.join(ns))?;
            for entry in std::fs::read_dir(dir.join(ns))? {
                used += entry?.metadata()?.len();
            }
        }
        let generation = load_generation(dir)?;
        Ok(Store { dir: dir.to_owned(), used: AtomicU64::new(used), cap, generation })
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    /// Refuses a file growing from `old` to `new` bytes when that takes the store past its cap.
    fn check(&self, old: u64, new: u64) -> io::Result<()> {
        if new > old && self.used.load(Ordering::Relaxed) + (new - old) > self.cap {
            return Err(io::Error::new(io::ErrorKind::StorageFull, "den-edge's storage cap is reached"));
        }
        Ok(())
    }

    /// Counts a file that went from `old` to `new` bytes.
    fn account(&self, old: u64, new: u64) {
        self.used.fetch_add(new, Ordering::Relaxed);
        self.used.fetch_sub(old, Ordering::Relaxed);
    }

    fn path(&self, ns: &str, key: &str, ext: &str) -> PathBuf {
        debug_assert!(NAMESPACES.contains(&ns));
        self.dir.join(ns).join(format!("{}.{ext}", crate::hex(&Sha256::digest(key.as_bytes()))))
    }

    pub async fn get(&self, ns: &str, key: &str) -> io::Result<Option<Vec<u8>>> {
        self.get_file(ns, key, "json").await
    }

    pub async fn put(&self, ns: &str, key: &str, value: &[u8]) -> io::Result<()> {
        self.replace_file(ns, key, "json", value).await
    }

    pub async fn get_file(&self, ns: &str, key: &str, ext: &str) -> io::Result<Option<Vec<u8>>> {
        match tokio::fs::read(self.path(ns, key, ext)).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Stream an append-only log without materializing its historical versions in memory.
    pub async fn open_file(&self, ns: &str, key: &str, ext: &str) -> io::Result<Option<tokio::fs::File>> {
        match tokio::fs::File::open(self.path(ns, key, ext)).await {
            Ok(file) => Ok(Some(file)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Add to the end of a file, creating it, and sync before returning — an append-only log's write.
    pub async fn append_file(&self, ns: &str, key: &str, ext: &str, bytes: &[u8]) -> io::Result<()> {
        self.check(0, bytes.len() as u64)?;
        let mut file =
            tokio::fs::OpenOptions::new().create(true).append(true).open(self.path(ns, key, ext)).await?;
        file.write_all(bytes).await?;
        file.sync_data().await?;
        self.account(0, bytes.len() as u64);
        Ok(())
    }

    pub async fn replace_file(&self, ns: &str, key: &str, ext: &str, value: &[u8]) -> io::Result<()> {
        let path = self.path(ns, key, ext);
        let old = file_len(&path).await;
        self.check(old, value.len() as u64)?;
        // One temporary name per key is enough: writes are serialised, and a leftover from a crash is
        // simply overwritten by the next write.
        let tmp = path.with_extension(format!("{ext}.tmp"));
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(value).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, &path).await?;
        self.account(old, value.len() as u64);
        Ok(())
    }

    pub async fn delete(&self, ns: &str, key: &str) -> io::Result<()> {
        self.delete_file(ns, key, "json").await
    }

    pub async fn delete_file(&self, ns: &str, key: &str, ext: &str) -> io::Result<()> {
        let path = self.path(ns, key, ext);
        let old = file_len(&path).await;
        match tokio::fs::remove_file(path).await {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => {
                self.account(old, 0);
                Ok(())
            }
        }
    }

    /// Reclaim expired inbox files even when their original link never returns. Called under the
    /// inbox write lock, so a refreshed queue cannot be removed using its previous expiry.
    pub async fn sweep_inboxes(&self, now: u64) -> io::Result<usize> {
        let mut entries = tokio::fs::read_dir(self.dir.join("inbox")).await?;
        let mut removed = 0;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let file = tokio::fs::File::open(&path).await?;
            let size = file.metadata().await?.len();
            // Fifty 4 KiB messages plus the envelope; avoid reading corrupt oversized files wholesale.
            let mut bytes = Vec::new();
            file.take(256 * 1024 + 1).read_to_end(&mut bytes).await?;
            let expired = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| v.get("expiresAt").and_then(serde_json::Value::as_u64))
                .is_none_or(|expiry| expiry <= now);
            if expired {
                tokio::fs::remove_file(&path).await?;
                self.account(size, 0);
                removed += 1;
            }
        }
        Ok(removed)
    }
}

/// A file's size, or 0 when there is none.
async fn file_len(path: &Path) -> u64 {
    tokio::fs::metadata(path).await.map_or(0, |m| m.len())
}

#[cfg(test)]
mod tests {
    use super::Store;
    use std::io::ErrorKind::StorageFull;

    #[tokio::test]
    async fn a_write_past_the_cap_is_refused_and_freed_room_is_counted() {
        let dir = crate::handler::tests::temp_dir();
        let store = Store::open(&dir, 10).unwrap();
        store.put("inbox", "a", b"12345678").await.unwrap();
        assert_eq!(store.put("inbox", "b", b"123").await.unwrap_err().kind(), StorageFull);
        store.put("inbox", "a", b"1").await.unwrap();
        store.put("inbox", "b", b"123").await.unwrap();
        store.delete("inbox", "a").await.unwrap();
        store.append_file("lib", "c", "log", b"123456").await.unwrap();
        assert_eq!(store.append_file("lib", "c", "log", b"12").await.unwrap_err().kind(), StorageFull);

        // Reopened, it counts what is on disk: 3 + 6 bytes.
        let reopened = Store::open(&dir, 10).unwrap();
        assert_eq!(reopened.put("inbox", "d", b"12").await.unwrap_err().kind(), StorageFull);
        reopened.put("inbox", "d", b"1").await.unwrap();
    }
}
