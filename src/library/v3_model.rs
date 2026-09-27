//! Executable model for the library-v3 authority described in `docs/LIBRARY_V3.md`.
//!
//! This is deliberately test-only. It establishes semantics before a storage backend can make those semantics
//! difficult to see, and gives the later redb/page-file prototypes the same oracle to satisfy.

use super::{row_fragment, PAGE_BYTES};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

#[derive(Clone, Debug)]
struct Write {
    key: String,
    base: u64,
    value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CurrentRow {
    key: String,
    sequence: u64,
    value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConflictRow {
    key: String,
    sequence: u64,
    value: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BatchResult {
    head: u64,
    applied: Vec<(String, u64)>,
    conflicts: Vec<ConflictRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Page {
    entries: Vec<CurrentRow>,
    head: u64,
    more: bool,
}

/// The v2 oracle retains append history and derives its visible state by replaying the newest write for each key.
#[derive(Default)]
struct AppendHistory {
    head: u64,
    events: Vec<CurrentRow>,
}

impl AppendHistory {
    fn live(&self) -> BTreeMap<u64, CurrentRow> {
        let mut by_key = HashMap::<&str, &CurrentRow>::new();
        for event in &self.events {
            by_key.insert(&event.key, event);
        }
        by_key.into_values().map(|row| (row.sequence, row.clone())).collect()
    }

    fn apply(&mut self, writes: &[Write]) -> BatchResult {
        // Production rejects duplicate keys before this point. Every CAS in a valid batch observes its initial
        // state, not an earlier write in the same batch.
        let live = self.live();
        let by_key: HashMap<&str, &CurrentRow> = live.values().map(|row| (row.key.as_str(), row)).collect();
        let mut applied = Vec::new();
        let mut conflicts = Vec::new();
        for write in writes {
            let current = by_key.get(write.key.as_str()).copied();
            if current.map_or(0, |row| row.sequence) != write.base {
                conflicts.push(current.map_or(
                    ConflictRow { key: write.key.clone(), sequence: 0, value: None },
                    |row| ConflictRow {
                        key: row.key.clone(),
                        sequence: row.sequence,
                        value: Some(row.value.clone()),
                    },
                ));
                continue;
            }
            self.head += 1;
            self.events.push(CurrentRow {
                key: write.key.clone(),
                sequence: self.head,
                value: write.value.clone(),
            });
            applied.push((write.key.clone(), self.head));
        }
        BatchResult { head: self.head, applied, conflicts }
    }

    fn page(&self, since: u64, limit: usize) -> Page {
        page_from_rows(self.live().into_values(), self.head, since, limit)
    }
}

/// The proposed v3 authority: a key points to its one live sequence, and that sequence owns the only payload as a
/// canonical wire fragment. A backend transaction must commit all three fields together.
#[derive(Clone, Default)]
struct FragmentAuthority {
    head: u64,
    keys: HashMap<String, u64>,
    sequence: BTreeMap<u64, Arc<[u8]>>,
}

impl FragmentAuthority {
    fn current(&self, key: &str) -> Option<CurrentRow> {
        let sequence = *self.keys.get(key)?;
        Some(decode(self.sequence.get(&sequence).expect("key index must name a fragment")))
    }

    fn apply(&mut self, writes: &[Write]) -> BatchResult {
        let mut next = self.clone();
        let mut applied = Vec::new();
        let mut conflicts = Vec::new();
        for write in writes {
            let current = self.current(&write.key);
            if current.as_ref().map_or(0, |row| row.sequence) != write.base {
                conflicts.push(current.map_or(
                    ConflictRow { key: write.key.clone(), sequence: 0, value: None },
                    |row| ConflictRow { key: row.key, sequence: row.sequence, value: Some(row.value) },
                ));
                continue;
            }
            next.head += 1;
            if let Some(old) = next.keys.insert(write.key.clone(), next.head) {
                assert!(next.sequence.remove(&old).is_some());
            }
            next.sequence.insert(next.head, row_fragment(next.head, &write.key, &write.value));
            applied.push((write.key.clone(), next.head));
        }
        // Models the single durable transaction boundary: observers see `self` or `next`, never mixed indexes.
        *self = next;
        BatchResult { head: self.head, applied, conflicts }
    }

    fn page(&self, since: u64, limit: usize) -> Page {
        page_from_fragments(
            self.sequence.range((std::ops::Bound::Excluded(since), std::ops::Bound::Unbounded)),
            self.head,
            limit,
        )
    }
}

#[derive(Deserialize)]
struct Decoded {
    k: String,
    seq: u64,
    v: String,
}

fn decode(fragment: &[u8]) -> CurrentRow {
    let row: Decoded = serde_json::from_slice(fragment).expect("the model stores canonical row JSON");
    CurrentRow { key: row.k, sequence: row.seq, value: row.v }
}

fn page_from_rows(
    rows: impl IntoIterator<Item = CurrentRow>,
    head: u64,
    since: u64,
    limit: usize,
) -> Page {
    let fragments: Vec<_> = rows
        .into_iter()
        .filter(|row| row.sequence > since)
        .map(|row| (row.sequence, row_fragment(row.sequence, &row.key, &row.value)))
        .collect();
    page_from_fragments(
        fragments.iter().map(|(sequence, fragment)| (sequence, fragment)),
        head,
        limit,
    )
}

fn page_from_fragments<'a>(
    rows: impl IntoIterator<Item = (&'a u64, &'a Arc<[u8]>)>,
    head: u64,
    limit: usize,
) -> Page {
    let mut rows = rows.into_iter().peekable();
    let mut entries = Vec::new();
    let mut bytes = 128usize;
    while entries.len() < limit {
        let Some((&sequence, fragment)) = rows.peek().copied() else { break };
        let cost = fragment.len() + usize::from(!entries.is_empty());
        if !entries.is_empty() && bytes + cost > PAGE_BYTES {
            break;
        }
        rows.next();
        let row = decode(fragment);
        assert_eq!(row.sequence, sequence, "sequence index and canonical fragment disagree");
        bytes += cost;
        entries.push(row);
    }
    Page { entries, head, more: rows.peek().is_some() }
}

fn random(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

#[test]
fn generated_histories_match_v2_for_cas_conflicts_replacements_and_pages() {
    // 2,048 batches and several wire views after each batch catch model drift without making this semantic unit
    // test dominate the ordinary suite.
    for seed in 1..=32u64 {
        let mut random_state = seed;
        let mut v2 = AppendHistory::default();
        let mut v3 = FragmentAuthority::default();
        for step in 0..64 {
            let mut writes = Vec::new();
            let mut chosen = std::collections::HashSet::new();
            for _ in 0..1 + random(&mut random_state) as usize % 4 {
                let key_number = random(&mut random_state) % 12;
                if !chosen.insert(key_number) {
                    continue;
                }
                let key = format!("{key_number:016x}");
                let current =
                    v2.live().values().find(|row| row.key == key).map_or(0, |row| row.sequence);
                let base = if random(&mut random_state).is_multiple_of(5) {
                    current.saturating_sub(1)
                } else {
                    current
                };
                let value = match random(&mut random_state) % 5 {
                    0 => String::new(), // encrypted tombstones are ordinary values to the relay
                    1 => "\"\\\n\u{0001}".to_owned(),
                    _ => format!("sealed-{seed}-{step}-{}", random(&mut random_state)),
                };
                writes.push(Write { key, base, value });
            }

            assert_eq!(v3.apply(&writes), v2.apply(&writes), "seed {seed}, step {step}");
            assert_eq!(v3.head, v2.head);
            assert_eq!(v3.sequence.len(), v3.keys.len());
            for (&sequence, fragment) in &v3.sequence {
                let row = decode(fragment);
                assert_eq!(row.sequence, sequence);
                assert_eq!(v3.keys.get(&row.key), Some(&sequence));
                assert_eq!(fragment.as_ref(), row_fragment(sequence, &row.key, &row.value).as_ref());
            }
            for since in [0, v2.head / 2, v2.head, v2.head.saturating_add(1)] {
                for limit in [1, 2, 7, 500] {
                    assert_eq!(v3.page(since, limit), v2.page(since, limit), "seed {seed}, step {step}");
                }
            }
        }
    }
}

#[test]
fn fragment_authority_removes_the_superseded_sequence() {
    let mut model = FragmentAuthority::default();
    model.apply(&[Write { key: "aaaaaaaaaaaaaaaa".into(), base: 0, value: "first".into() }]);
    model.apply(&[Write { key: "aaaaaaaaaaaaaaaa".into(), base: 1, value: "second".into() }]);
    assert!(!model.sequence.contains_key(&1));
    assert_eq!(model.page(0, 500).entries, vec![CurrentRow {
        key: "aaaaaaaaaaaaaaaa".into(),
        sequence: 2,
        value: "second".into(),
    }]);
}
