# Library v3 backend bakeoff

Measured 2026-09-27 by `bench/library_v3.rs` at commit `25981fe` plus this benchmark slice. Production v2 was not
changed or exercised by the benchmark.

## Method

Both candidates implement one independently writable store per library with a key index, live sequence index,
canonical-fragment payloads, durable commits, sequence-range reads, reopen, and compaction:

- **redb** uses three tables in one database, a 64 KiB configured cache, and redb's default durable transaction.
- **CoW** is the smallest credible custom alternative: append-only fragment pages plus an atomically replaced live
  index snapshot. A transaction fsyncs payload first, then index, then the directory. Compaction writes a complete
  new generation and atomically switches a durable `CURRENT` marker.

The range case holds 500 live rows with 768-byte values and reads all 500, 500 times. The write cases first seed each
library with 500 rows, then durably replace one live row per transaction. Concurrency 4 and 8 use distinct stores and
threads so they measure independent-library progress, not concurrent writers in one database. Churn replaces ten
keys 500 times. Open-cardinality stores contain one row and stay open together. Crash children abort before or after
publication; reopen checks head, live-row cardinality, and exact payload checksum.

Linux measurements ran in separate backend containers with `memory.max=67108864` and `memory.swap.max=0` on Docker
29.4.0, Linux aarch64, OrbStack/overlay2. `memory.peak` includes the process, mappings, allocator, and charged file
cache accumulated across that backend's cases. Absolute fsync latency is specific to this virtual disk; each backend
ran alone in a fresh container on the same engine, and the ratios are the useful result.

## 64 MiB results

| Case | redb | custom CoW | Result |
|---|---:|---:|---|
| Range 500, operations/s | 1,518 | 2,222 | CoW 1.46x faster |
| Range 500, p50 / p99 | 651 / 879 µs | 448 / 502 µs | CoW lower read cost |
| Durable replace c1, operations/s | 769 | 202 | redb 3.81x faster |
| Durable replace c1, p50 / p99 | 1.22 / 1.87 ms | 4.71 / 5.95 ms | redb materially lower |
| Durable replace c4, operations/s | 1,699 | 354 | redb 4.80x faster |
| Durable replace c4, p50 / p99 | 2.21 / 5.27 ms | 10.36 / 17.90 ms | redb materially lower |
| Durable replace c8, operations/s | 2,685 | 400 | redb 6.71x faster |
| Durable replace c8, p50 / p99 | 2.87 / 5.33 ms | 20.78 / 29.03 ms | redb materially lower |
| 500 replacements: before / churned / compacted | 676 / 676 / 557 KiB | 424 / 829 / 424 KiB | both reclaim; CoW grows until compaction |
| Compaction latency | 28 ms | 9 ms | CoW faster for this small generation |
| 128 one-row open libraries, RSS | 13.2 MiB | 5.5 MiB | CoW saves about 7.7 MiB |
| 128 one-row open libraries, cgroup current | 28.0 MiB | 11.9 MiB | CoW saves about 16.1 MiB |
| Whole-run cgroup peak | 29.5 MiB | 11.9 MiB | both pass 64 MiB alone |
| OOM / OOM kill / cgroup max events | 0 / 0 / 0 | 0 / 0 / 0 | pass |
| Abort before publish | old head and payload | old head and payload | pass |
| Abort after publish | new head and payload | new head and payload | pass |

The redb open-cardinality slope from 1 to 128 stores was about 69 KiB RSS and 105 KiB cgroup memory per additional
open database in this run. Its minimum file was 1,056,768 bytes versus 871 bytes for the custom prototype. Those are
real costs even though sparse/on-disk bytes are not resident bytes.

## Decision

Select **one redb database per active library** for the next implementation slice. The evidence is decisive for the
required workload: redb is 3.8–6.7x faster on the durable write path, scales across independent libraries, bounds
replacement growth without a custom compaction policy, and supplies the ACID/crash machinery the custom design would
otherwise have to reproduce and fault-test. The custom prototype's 1.47x range-read advantage does not outweigh its
write/fsync cost or the correctness surface of a new storage engine. Response segmentation remains above the backend
and can remove most whole-page assembly independently.

This selection has conditions:

- Charge at least **112 KiB fixed capacity per open redb library**, in addition to retained fragments and indexes;
  do not keep the old 512-byte `LIBRARY_OVERHEAD` fiction.
- Open lazily and close/evict by the existing aggregate reservation. With a 16 MiB library-cache budget, 128 open
  databases leave little room for rows; cardinality must fall naturally as the byte reservation fills.
- Keep the 64 KiB redb cache explicit and remeasure if it changes.
- Treat the roughly 1 MiB minimum file per created library as a disk/quota and backup concern even though v3 stores
  are never pre-created for every household.
- Run the full den-edge mixed workload, migration, 48 slow readers, cancellation, and production filesystem fsync
  tests before promotion. This isolated bakeoff proves candidate selection, not the final #140 promotion gate.

## Reproduction

```sh
docker build -f bench/library-v3.Dockerfile -t den-edge-library-v3-bench .
docker run --rm --memory 64m --memory-swap 64m \
  -e LIBRARY_V3_BACKEND=redb den-edge-library-v3-bench
docker run --rm --memory 64m --memory-swap 64m \
  -e LIBRARY_V3_BACKEND=cow den-edge-library-v3-bench
```

The binary emits JSON Lines so later runs can be compared without scraping prose. The benchmark target requires the
`library-v3-bench` feature and is not built into or invoked by the production default.
