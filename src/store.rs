//! The durable state: one file per key, under a directory per kind of record. A write goes to a temporary
//! file, is synced, and is renamed over the old one, so a reader sees the old value or the new one and a
//! crash leaves one of them whole. Every mutation happens under `AppState::write_lock`, so there is one
//! writer at a time.
//!
//! File names are the SHA-256 of the key, not the key: an inbox key is a credential, and a name made from
//! it would put it in every directory listing and bound nothing about its length.

use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub struct Store {
    dir: PathBuf,
}

/// The kinds of record, one directory each.
pub const NAMESPACES: [&str; 4] = ["inbox", "plugins", "settings", "sync"];

impl Store {
    pub fn open(dir: &Path) -> io::Result<Store> {
        for ns in NAMESPACES {
            std::fs::create_dir_all(dir.join(ns))?;
        }
        Ok(Store { dir: dir.to_owned() })
    }

    fn path(&self, ns: &str, key: &str) -> PathBuf {
        debug_assert!(NAMESPACES.contains(&ns));
        self.dir.join(ns).join(format!("{}.json", crate::hex(&Sha256::digest(key.as_bytes()))))
    }

    pub async fn get(&self, ns: &str, key: &str) -> io::Result<Option<Vec<u8>>> {
        match tokio::fs::read(self.path(ns, key)).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn put(&self, ns: &str, key: &str, value: &[u8]) -> io::Result<()> {
        let path = self.path(ns, key);
        // One temporary name per key is enough: writes are serialised, and a leftover from a crash is
        // simply overwritten by the next write.
        let tmp = path.with_extension("json.tmp");
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(value).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, &path).await
    }

    pub async fn delete(&self, ns: &str, key: &str) -> io::Result<()> {
        match tokio::fs::remove_file(self.path(ns, key)).await {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}
