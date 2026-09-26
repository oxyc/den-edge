# Title metadata store

Issue #121 replaces one JSON file per `(type, id, source)` with a single redb file. This is a durable,
reconstructible projection: it survives process and image replacement, but can be rebuilt if its volume is lost.

## Measured workload

The ignored `title_metadata_store_benchmark` test seeds 10,000 mixed-source observations, then calls the same
merge and query functions as the HTTP endpoints. These release-mode measurements were taken on the development
host's APFS volume on 2026-09-26; they are before/after evidence, not capacity promises for another disk.

| Batch | JSON files, batches/s | JSON files p95 | redb, batches/s | redb p95 |
| --- | ---: | ---: | ---: | ---: |
| PUT 1 | 8,511 | 133 us | 215 | 5.26 ms |
| PUT 25 | 249 | 4.31 ms | 204 | 5.31 ms |
| PUT 100 | 64 | 18.62 ms | 193 | 5.48 ms |
| query 1 | 29,263 | 42 us | 85,152 | 15 us |
| query 50 | 521 | 2.21 ms | 4,475 | 253 us |
| query 100 | 228 | 4.64 ms | — | — |
| query 200 | — | — | 1,320 | 848 us |

The old endpoint was capped at 100 query titles even though its client contract allows 200. The replacement's
200-title query is still 5.8 times faster than the old 100-title query, so the result clears the issue's 2x gate
without extrapolating an unmeasured old result. A 100-observation PUT has 3.0 times the throughput and 71% lower
p95 latency. A single durable observation is deliberately slower because redb commits and syncs a transaction;
page-shaped batches are the workload this store is selected for.

## Candidate decision

- An append journal makes a batch one append, but fast queries require either a resident key/offset index or an
  on-disk checkpoint. The former duplicates keys and offsets inside a 64 MiB cgroup; the latter adds custom
  recovery, checksumming, generation switching, and concurrent compaction. It was screened out before a timed
  adoption run because redb already clears both gates while supplying those mechanisms.
- heed/LMDB has the same transaction shape and remains a credible raw-read contender. It requires a fixed maximum
  map, unsafe environment setup, and a C-backed native dependency. A large virtual map is not itself resident
  memory, but page residency under the real cgroup still needs a target-host soak. It was not added after redb
  cleared the gate; it remains the fallback experiment if target-host redb measurements miss these results.
- redb is pure Rust, crash-atomic, uses concurrent MVCC read snapshots, and allows a 4 MiB userspace cache. One PUT
  is one immediate-durability transaction; one query is one read transaction. The release binary grew by about
  400 KiB in this build (4.1 MiB to 4.5 MiB).

The store has a 256 MiB file ceiling with 4 MiB of commit headroom. Expiry scans use 512-key transactions so scan
memory is bounded and readers keep using stable snapshots. Legacy JSON files are imported in the same transaction
as an import marker and retained as a rollback copy; no schema or binary upgrade purges them.

Run the fixture with:

```sh
cargo test --release title_metadata_store_benchmark -- --ignored --nocapture
```
