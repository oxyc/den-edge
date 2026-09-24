//! The durable state: one file per key, under a directory per kind of record. A write goes to a temporary
//! file, is synced, and is renamed over the old one, so a reader sees the old value or the new one and a
//! crash leaves one of them whole. Each read-modify-write happens under its owner's lock — the inbox and `/sync`
//! under `AppState::write_lock`, a library under `AppState::libraries`, grants, OAuth and title metadata under their
//! own — so one record has one writer at a time, but different owners write at once. What they share is the cap,
//! and room under it is reserved atomically before a write and given back if the write fails.
//!
//! File names are the SHA-256 of the key, not the key: an inbox key is a credential, and a name made from
//! it would put it in every directory listing and bound nothing about its length.
//!
//! The store holds at most `cap` bytes: a write that would grow it past that fails as `StorageFull`, so
//! whoever can reach den-edge can't fill the host's disk (issue #8, audit #5). The inbox, where anyone may start
//! a queue, holds at most a share of it, so filling the inbox leaves room for libraries, grants and connections.

use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Store {
    dir: PathBuf,
    /// Bytes on disk across every namespace.
    used: AtomicU64,
    /// Bytes on disk in the inbox, which is also in `used`.
    inbox_used: AtomicU64,
    cap: u64,
    generation: String,
}

/// The inbox holds at most this part of the cap: a quarter.
const INBOX_SHARE: u64 = 4;

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
pub const NAMESPACES: [&str; 7] = ["inbox", "plugins", "settings", "sync", "lib", "grants", "oauth"];

/// The cap unless `STORE_CAP_BYTES` sets one: far past one household's few MB.
pub const DEFAULT_CAP: u64 = 1 << 30;

impl Store {
    pub fn open(dir: &Path, cap: u64) -> io::Result<Store> {
        let mut used = 0;
        let mut inbox_used = 0;
        for ns in NAMESPACES {
            std::fs::create_dir_all(dir.join(ns))?;
            // Guest grants hold a bearer copy of a host's addon installs (`grants.rs`); the assistants' connections
            // hold which library or grant each one speaks for (`oauth.rs`).
            #[cfg(unix)]
            if ns == "grants" || ns == "oauth" {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(dir.join(ns), std::fs::Permissions::from_mode(0o700))?;
            }
            for entry in std::fs::read_dir(dir.join(ns))? {
                let len = entry?.metadata()?.len();
                used += len;
                if ns == "inbox" {
                    inbox_used += len;
                }
            }
        }
        let generation = load_generation(dir)?;
        Ok(Store {
            dir: dir.to_owned(),
            used: AtomicU64::new(used),
            inbox_used: AtomicU64::new(inbox_used),
            cap,
            generation,
        })
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    /// Takes `bytes` of room in `ns` before they are written, or refuses them when that takes the store past its
    /// cap, or the inbox past its share. Taken in one step, not checked and counted later: writers in different
    /// namespaces hold different locks, and two that each saw room for one would both have written.
    fn reserve(&self, ns: &str, bytes: u64) -> io::Result<()> {
        let full = || io::Error::new(io::ErrorKind::StorageFull, "den-edge's storage cap is reached");
        if ns == "inbox" && !take(&self.inbox_used, bytes, self.cap / INBOX_SHARE) {
            return Err(full());
        }
        if !take(&self.used, bytes, self.cap) {
            if ns == "inbox" {
                give_back(&self.inbox_used, bytes);
            }
            return Err(full());
        }
        Ok(())
    }

    /// Gives back `bytes` of `ns`: a file shrank or went, or a write that reserved them failed.
    fn release(&self, ns: &str, bytes: u64) {
        give_back(&self.used, bytes);
        if ns == "inbox" {
            give_back(&self.inbox_used, bytes);
        }
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

    /// Add to the end of a file, creating it, and sync before returning — an append-only log's write. One that
    /// fails is cut back to where it started, so what landed of it is not left for the next append to be glued
    /// onto.
    pub async fn append_file(&self, ns: &str, key: &str, ext: &str, bytes: &[u8]) -> io::Result<()> {
        let len = bytes.len() as u64;
        self.reserve(ns, len)?;
        let opened = async {
            let file =
                tokio::fs::OpenOptions::new().create(true).append(true).open(self.path(ns, key, ext)).await?;
            let before = file.metadata().await?.len();
            Ok::<_, io::Error>((file, before))
        };
        let (mut file, before) = match opened.await {
            Ok(opened) => opened,
            Err(e) => {
                self.release(ns, len);
                return Err(e);
            }
        };
        let written = async {
            file.write_all(bytes).await?;
            file.sync_data().await
        };
        if let Err(e) = written.await {
            let after = match file.set_len(before).await {
                Ok(()) => before,
                Err(_) => file.metadata().await.map_or(before + len, |m| m.len()),
            };
            self.release(ns, (before + len).saturating_sub(after));
            return Err(e);
        }
        Ok(())
    }

    pub async fn replace_file(&self, ns: &str, key: &str, ext: &str, value: &[u8]) -> io::Result<()> {
        let path = self.path(ns, key, ext);
        let old = file_len(&path).await;
        let new = value.len() as u64;
        self.reserve(ns, new.saturating_sub(old))?;
        // One temporary name per key is enough: writes are serialised, and a leftover from a crash is
        // simply overwritten by the next write.
        let tmp = path.with_extension(format!("{ext}.tmp"));
        let written = async {
            let mut file = tokio::fs::File::create(&tmp).await?;
            file.write_all(value).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&tmp, &path).await
        };
        if let Err(e) = written.await {
            // The temporary file is not counted, so it does not stay.
            let _ = tokio::fs::remove_file(&tmp).await;
            self.release(ns, new.saturating_sub(old));
            return Err(e);
        }
        self.release(ns, old.saturating_sub(new));
        Ok(())
    }

    /// Make a rename or removal in `ns` durable: `replace_file` syncs the data, but the directory entry that
    /// names it is only on disk once the directory is synced too.
    pub async fn sync_dir(&self, ns: &str) -> io::Result<()> {
        tokio::fs::File::open(self.dir.join(ns)).await?.sync_all().await
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
                self.release(ns, old);
                Ok(())
            }
        }
    }

    /// Reclaim expired inbox files even when their original link never returns. Each file is looked at under the
    /// inbox's write lock on its own — so a refreshed queue cannot be removed using its previous expiry, and a
    /// sweep does not hold every append and drain for the whole directory — and one that cannot be read is
    /// reported and passed over, not the end of the sweep.
    pub async fn sweep_inboxes(&self, now: u64, write_lock: &tokio::sync::Mutex<()>) -> io::Result<usize> {
        let mut entries = tokio::fs::read_dir(self.dir.join("inbox")).await?;
        let mut removed = 0;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let _write = write_lock.lock().await;
            match self.sweep_inbox(&path, now).await {
                Ok(true) => removed += 1,
                Ok(false) => {}
                Err(e) => eprintln!("inbox expiry sweep: {}: {e}", path.display()),
            }
        }
        Ok(removed)
    }

    /// Remove one inbox file if it has expired; whether it did. One drained since it was listed is not there.
    async fn sweep_inbox(&self, path: &Path, now: u64) -> io::Result<bool> {
        let file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        };
        let size = file.metadata().await?.len();
        // Fifty 4 KiB messages plus the envelope; avoid reading corrupt oversized files wholesale.
        let mut bytes = Vec::new();
        file.take(256 * 1024 + 1).read_to_end(&mut bytes).await?;
        let expired = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| v.get("expiresAt").and_then(serde_json::Value::as_u64))
            .is_none_or(|expiry| expiry <= now);
        if !expired {
            return Ok(false);
        }
        tokio::fs::remove_file(path).await?;
        self.release("inbox", size);
        Ok(true)
    }
}

/// Adds `bytes` to `counter` unless that passes `limit`; whether it did.
fn take(counter: &AtomicU64, bytes: u64, limit: u64) -> bool {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
            used.checked_add(bytes).filter(|total| bytes == 0 || *total <= limit)
        })
        .is_ok()
}

/// Takes `bytes` off `counter`, never below nothing: a count that drifted must not wrap around to "full".
fn give_back(counter: &AtomicU64, bytes: u64) {
    let _ =
        counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| Some(used.saturating_sub(bytes)));
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
        store.put("settings", "a", b"12345678").await.unwrap();
        assert_eq!(store.put("settings", "b", b"123").await.unwrap_err().kind(), StorageFull);
        store.put("settings", "a", b"1").await.unwrap();
        store.put("settings", "b", b"123").await.unwrap();
        store.delete("settings", "a").await.unwrap();
        store.append_file("lib", "c", "log", b"123456").await.unwrap();
        assert_eq!(store.append_file("lib", "c", "log", b"12").await.unwrap_err().kind(), StorageFull);

        // Reopened, it counts what is on disk: 3 + 6 bytes.
        let reopened = Store::open(&dir, 10).unwrap();
        assert_eq!(reopened.put("settings", "d", b"12").await.unwrap_err().kind(), StorageFull);
        reopened.put("settings", "d", b"1").await.unwrap();
    }

    /// Anyone may start an inbox queue, so the inbox has a share of the cap and not the whole of it: filled, it
    /// leaves the rest for the libraries, grants and connections. Its share is counted again on reopening.
    #[tokio::test]
    async fn the_inbox_cannot_take_more_than_its_share() {
        let dir = crate::handler::tests::temp_dir();
        let store = Store::open(&dir, 40).unwrap();
        store.put("inbox", "a", b"12345678").await.unwrap();
        assert_eq!(store.put("inbox", "b", b"123").await.unwrap_err().kind(), StorageFull);
        store.put("inbox", "b", b"12").await.unwrap();
        store.append_file("lib", "c", "log", &[b'x'; 30]).await.unwrap();

        let reopened = Store::open(&dir, 40).unwrap();
        assert_eq!(reopened.put("inbox", "d", b"1").await.unwrap_err().kind(), StorageFull);
        reopened.delete("inbox", "a").await.unwrap();
        reopened.put("inbox", "d", b"1").await.unwrap();
    }

    /// Writers in different namespaces hold different locks, so two may be at the store at once. Room is taken
    /// before either writes: of two that each fit alone but not together, one is refused.
    #[tokio::test]
    async fn two_writes_at_once_cannot_both_take_the_last_room() {
        let store = Store::open(&crate::handler::tests::temp_dir(), 10).unwrap();
        let (a, b) = tokio::join!(store.put("settings", "a", b"123456"), store.put("sync", "b", b"123456"));
        assert!(a.is_ok() != b.is_ok(), "{a:?} {b:?}");
        assert_eq!(store.put("settings", "c", b"12345").await.unwrap_err().kind(), StorageFull);
    }
}
