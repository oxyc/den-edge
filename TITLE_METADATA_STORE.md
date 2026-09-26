# Title metadata store

Issue #121 replaces one JSON file per `(type, id, source)` with a single redb file. This is a durable,
reconstructible projection: it survives process and image replacement, but can be rebuilt if its volume is lost.

## Measured workload

The ignored `title_metadata_store_benchmark` test seeds 10,000 mixed-source observations, then calls the same
merge and query functions as the HTTP endpoints. These release-mode measurements were taken on the development
host's APFS volume on 2026-09-26; they are before/after evidence, not capacity promises for another disk.

| Batch | JSON files, batches/s | JSON files p95 | redb, batches/s | redb p95 |
| --- | ---: | ---: | ---: | ---: |
| PUT 1 | 8,511 | 133 us | 204 | 5.25 ms |
| PUT 25 | 249 | 4.31 ms | 200 | 5.30 ms |
| PUT 100 | 64 | 18.62 ms | 172 | 6.28 ms |
| query 1 | 29,263 | 42 us | 54,501 | 25 us |
| query 50 | 521 | 2.21 ms | 3,320 | 385 us |
| query 100 | 228 | 4.64 ms | — | — |
| query 200 | — | — | 1,264 | 918 us |

The old endpoint was capped at 100 query titles even though its client contract allows 200. The replacement's
200-title query is still 5.5 times faster than the old 100-title query, so the result clears the issue's 2x gate
without extrapolating an unmeasured old result. A 100-observation PUT has 2.7 times the throughput and 66% lower
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

The store stops admitting writes at 252 MiB and wraps redb's backend with a hard 260 MiB file limit, leaving 4 MiB
on either side for a final allocator/commit step. This backend limit is necessary because redb grows its file
geometrically; a pre-transaction size check alone is not a ceiling. Expiry scans use 512-key transactions so scan
memory is bounded and readers keep using stable snapshots. Legacy JSON import also commits at most 512 records at
a time. Its marker is written only after the complete scan; an interrupted import resumes idempotently before the
store is exposed to requests. Old JSON files remain as a rollback copy, and no schema or binary upgrade purges them.

## Constrained-container smoke test

The release image was run with the deployment limits (`--memory 64m --memory-swap 64m --pids-limit 64`) and given
100,000 metadata-query requests at concurrency 128. The endpoint rate limit admitted 60 database queries and
rejected the excess, as designed; the run completed at 21,917 requests/s with no container restart or OOM. Sampled
cgroup usage peaked at 7.74 MiB and 22 PIDs, then returned below 4 MiB. This checks overload rejection and leaves
ample headroom, but it is not the still-required target-host mixed PUT/query/sweep soak with a populated store.

Run the fixture with:

```sh
cargo test --release title_metadata_store_benchmark -- --ignored --nocapture
```
