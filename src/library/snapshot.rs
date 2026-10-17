//! A library's authenticated source: the durable exclusive-operation generation and the SHA-256 of its canonical
//! current-row snapshot (den-spec profiles-v1). Every exclusive operation fences on it, so it lives apart from any
//! one of them.

use super::v3::LibrarySnapshot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub(super) enum SnapshotError {
    /// A stored row does not decode, or its sequence disagrees with its own.
    Corrupt,
    Invalid(&'static str),
    Storage(io::Error),
}

impl From<io::Error> for SnapshotError {
    fn from(value: io::Error) -> Self {
        Self::Storage(value)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct SnapshotRow {
    #[serde(rename = "k")]
    pub key: String,
    #[serde(rename = "seq")]
    pub sequence: u64,
    #[serde(rename = "v")]
    pub value: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct SnapshotAuthority<'a> {
    #[serde(rename = "libraryId")]
    pub library_id: &'a str,
    #[serde(rename = "generation")]
    pub migration_generation: u64,
    #[serde(rename = "base")]
    pub head: u64,
    #[serde(rename = "wireMin")]
    pub wire_minimum: u64,
    pub rows: &'a [SnapshotRow],
}

#[derive(Deserialize)]
struct Fragment {
    k: String,
    seq: u64,
    v: String,
}

/// The current rows in key byte order.
pub(super) fn snapshot_rows(snapshot: &LibrarySnapshot) -> Result<Vec<SnapshotRow>, SnapshotError> {
    let mut rows = snapshot
        .rows
        .iter()
        .map(|stored| {
            let fragment: Fragment =
                serde_json::from_slice(&stored.fragment).map_err(|_| SnapshotError::Corrupt)?;
            if fragment.seq != stored.sequence {
                return Err(SnapshotError::Corrupt);
            }
            Ok(SnapshotRow { key: fragment.k, sequence: fragment.seq, value: fragment.v })
        })
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by(|left, right| left.key.as_bytes().cmp(right.key.as_bytes()));
    Ok(rows)
}

pub(super) fn authenticated_head(
    library_id: &str,
    snapshot: &LibrarySnapshot,
) -> Result<String, SnapshotError> {
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

/// The library's source as `(generation, head)`: what an exclusive operation's `expectedSource` must equal.
pub(super) fn source(library_id: &str, snapshot: &LibrarySnapshot) -> Result<(u64, String), SnapshotError> {
    let generation = snapshot.protocol.migration_generation;
    if generation > MAX_SAFE_INTEGER {
        return Err(SnapshotError::Invalid("invalid library source"));
    }
    Ok((generation, authenticated_head(library_id, snapshot)?))
}

/// serde_json's value maps are ordered without the `preserve_order` feature. Round-tripping through `Value` sorts
/// every object recursively, yielding RFC 8785's representation for this integer/string-only schema.
pub(super) fn canonical_json<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    let value = serde_json::to_value(value).map_err(io::Error::other)?;
    serde_json::to_vec(&value).map_err(io::Error::other)
}

pub(super) fn hex_digest(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_authority_uses_jcs_key_order() {
        const LIBRARY: &str = "0123456789abcdef0123456789abcdef";
        const ROW: &str = "aaaaaaaaaaaaaaaa";
        let rows = [SnapshotRow { key: ROW.into(), sequence: 1, value: "é".into() }];
        let authority = SnapshotAuthority {
            library_id: LIBRARY,
            migration_generation: 7,
            head: 1,
            wire_minimum: 4,
            rows: &rows,
        };
        assert_eq!(
            String::from_utf8(canonical_json(&authority).unwrap()).unwrap(),
            format!(
                r#"{{"base":1,"generation":7,"libraryId":"{LIBRARY}","rows":[{{"k":"{ROW}","seq":1,"v":"é"}}],"wireMin":4}}"#
            )
        );
    }
}
