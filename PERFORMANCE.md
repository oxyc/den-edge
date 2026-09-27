# den-edge performance

This is the measured production baseline and the decision record for experimental
performance work. It complements [ARCHITECTURE.md](ARCHITECTURE.md).

## Measurement conditions

The baseline was measured on 2026-09-27 from the tree merged as `647d47a`:

- release, static scratch image on the homelab Linux target;
- one den-edge process, no horizontal scaling;
- hard cgroup v2 `memory.max=64 MiB` and `memory.swap.max=0`;
- local deterministic upstream and seeded provider files;
- 48-client general load unless the endpoint has a narrower intentional setting;
- 30 seconds per throughput case;
- a final 300-second mixed workload;
- direct origin measurement, so Cloudflare cache hits are not counted as server work.

Requests per second are useful only with payload size, bandwidth, latency, and memory.
A 304 and a 1 MiB 200 are deliberately reported separately. These numbers describe
this target and harness, not a universal SLA.

## Endpoint results

| Case | Throughput | p99 | Cgroup current peak |
|---|---:|---:|---:|
| Control JSON | 5,230 req/s | 36.6 ms | 13.75 MiB |
| Static 1 MiB 200 | 1,917 req/s; 1.872 GiB/s | 94.1 ms | 31.16 MiB |
| Static 304 | 5,836 req/s | 29.1 ms | 15.02 MiB |
| Ratings exact 200 (~239 KiB) | 2,761 req/s; 0.631 GiB/s | 10.1 ms | 16.29 MiB |
| Ratings 304 | 5,689 req/s | 24.8 ms | 15.81 MiB |
| Fast addon relay (256 KiB) | 1,829 req/s; 0.446 GiB/s | 56.0 ms | 21.18 MiB |
| Delayed addon relay | 199.7 req/s | 280.1 ms | 17.73 MiB |
| Hot library page (~438 KiB) | 3,361 req/s; 1.403 GiB/s | 4.62 ms | 19.03 MiB |
| 160 cold unique libraries | 2,448 req/s | 2.62 ms | 12.72 MiB |
| Media pass-through (2 MiB) | 608.6 req/s; 1.189 GiB/s | 45.9 ms | 17.53 MiB |
| TMDB list exact 200 | 4,788 req/s | 3.92 ms | 16.11 MiB |
| TMDB list 304 | 2,926 req/s | 68.4 ms | 16.95 MiB |
| TMDB search exact 200 | 4,802 req/s | 4.16 ms | 16.06 MiB |
| TMDB search 304 | 4,464 req/s | 43.2 ms | 17.18 MiB |
| TMDB whole detail (~590 KiB) | 1,407 req/s; 0.792 GiB/s | 13.7 ms | 18.51 MiB |
| TMDB first narrow preparation | one request in 20.2 ms | 20.2 ms | 16.08 MiB |
| TMDB prepared narrow repeat | 1,352 req/s; 0.754 GiB/s | 13.9 ms | 19.24 MiB |
| TMDB concurrent same key | 4,737 req/s | 17.5 ms | 18.17 MiB |
| TMDB concurrent mixed keys | 4,363 req/s | 14.6 ms | 17.35 MiB |
| Cancellation storm | 5,972 cancellations/s | 6.47 ms | 19.96 MiB |
| 32-client slow-reader overload | 436.7 req/s, bounded 200/503 | 770 ms | 27.65 MiB |

All seeded TMDB responses reported `x-den-tmdb: hit`; external call count was zero.
Stale revalidation is not faked: TMDB's public TLS origin is not currently injectable,
so that deterministic harness row remains explicitly skipped.

## Five-minute mixed soak

Ten workload classes competed in one container for 300.7 seconds:

| Measure | Result |
|---|---:|
| Total requests | 1,134,963 |
| Aggregate throughput | 3,774.8 req/s; 0.663 GiB/s |
| Successful responses | 686,845 |
| Intended `media_busy` refusals | 1,850 |
| Propagated cancellations | 446,268 |
| Unexpected errors | 0 |
| Latency | p50 5 ms; p95 24 ms; p99 55 ms |
| RSS peak | 15.68 MiB |
| Cgroup current peak | 31.24 MiB |
| Cgroup lifetime peak | 32.49 MiB |
| OOM/max event increments | 0 |
| Peak FDs / downstream / upstream sockets | 81 / 60 / 22 |
| Recovered state | 9.70 MiB RSS; 19.03 MiB cgroup; 11 FDs; 0 upstream sockets |

The result shows headroom for a high uplink without hiding slow-reader or kernel
memory behind low process RSS.

## Why the memory result matters

Before accepted and upstream TCP buffers were bounded, the 32-client slow-reader
case reached 62.65 MiB cgroup memory and killed the 64 MiB container while Rust RSS
was only 7.34 MiB. After the fix, the same 30-second case peaked at 27.65 MiB, a
55.9% reduction, served 890 complete 2 MiB responses, returned 12,508 intentional
`503 media_busy` refusals, and recovered with zero OOM events.

RSS alone is therefore not an acceptance metric. The gate measures cgroup current,
kernel cgroup peak, event counters, descriptors, and sockets as well.

## Interpreting the delivery paths

- Small 304 and prepared-JSON results are request/metadata limited.
- Large static, library, provider, and media results are better compared in GiB/s.
- Provider exact hits approach static-file behavior because they do not parse JSON.
- The first known TMDB narrow shape pays one parse/serialization/publication cost;
  repeats stream the resulting file.
- Library pages remain exceptionally fast because canonical row fragments avoid
  repeated per-row serialization, even though the bounded envelope is assembled.
- A relay includes two HTTP stacks and socket movement, so it should not be compared
  to a local file as though they perform the same work.
- Cloudflare can make repeated public requests faster for users, but it does not
  increase measured origin capacity and is not required for these numbers.

## Experimental work

### #137: bounded mmap exact-file bodies

[Issue #137](https://github.com/oxyc/den-edge/issues/137) and draft
[PR #149](https://github.com/oxyc/den-edge/pull/149) are worth completing as the
next focused performance experiment.

Evidence so far:

| Prototype case | Current file body | mmap prototype | Change |
|---|---:|---:|---:|
| 177 KiB static | 4,536 req/s | 7,594 req/s | +67.4% |
| 245 KiB provider JSON | 3,514 req/s | 6,263 req/s | +78.2% |
| 488 KiB library | 5,399 req/s | 5,653 req/s | noise |
| 8 MiB media | 293 req/s | 314 req/s | noise |
| 245 KiB body-production microbenchmark | 243.5 ms | 44.8 ms | 5.44x |

The prototype is not generic mmap serving. It copies an eligible immutable opened
generation into a prefaulted anonymous read-only mapping, avoiding SIGBUS if an
external actor truncates the original inode. It is limited to Linux, 64–512 KiB
exact files, 8 MiB/32 mappings globally, and falls back to the existing file body.

Recommendation: finish the live amd64 HTTP/cgroup gate. Merge only if at least one
real eligible endpoint keeps a 50% CPU/GiB improvement with acceptable p99 and no
mixed-soak memory regression. The provider prototype increased cgroup peak from
11.42 to 18.91 MiB, so the budget and workload mix matter. Do not extend it to
library logs, arbitrary paths, or media.

### #140: library-v3 authoritative fragments

[Issue #140](https://github.com/oxyc/den-edge/issues/140) and draft
[PR #147](https://github.com/oxyc/den-edge/pull/147) are strategically worthwhile,
but not an immediate production performance change.

The important result is architectural. It does **not** yet show that v3 is faster
than production v2. The 3.8–6.7x durable-write result compares redb with the custom
v3 candidate, not with today's append log.

### Production v2 versus proposed v3

| Dimension | Production library v2 | Proposed library v3 |
|---|---|---|
| Durable authority | Append log containing current and superseded writes until compaction | One redb database per library; metadata, key→sequence, and sequence→canonical fragment commit together |
| Hot authority | In-memory latest-row map plus sequence index and canonical `Arc` fragments | Durable sequence table is authoritative; a small lazy-open database/cache serves ranges |
| Write shape | Append and fsync accepted lines; later rewrite-compaction | ACID copy-on-write transaction removes old sequence, inserts new fragment, updates key and head |
| Crash model | Torn-tail/glued-write repair during replay | Transaction is wholly old or new; migration still needs an atomic format marker |
| Read shape | Select shared fragments under the library lock, then assemble one ≤512 KiB page | Range-scan a consistent snapshot, then emit bounded 32–64 KiB envelope/fragment chunks |
| Slow-reader ownership | Whole assembled identity page remains resident; gzip owns another complete representation while built | Intended to retain and charge only bounded chunks/shared fragment owners; not implemented yet |
| Open-library memory | Existing 8 MiB per-library / 16 MiB aggregate charge includes live rows/fragments | At least 112 KiB fixed charge per open database, then fragments/response owners; same aggregate target |
| On-disk minimum | Compact logs can be tiny | Measured redb minimum 1,056,768 bytes per library |
| Production HTTP result | 3,361 req/s and 1.403 GiB/s for the measured ~438 KiB hot page | Not measured; no v3 HTTP route exists yet |
| Deployment state | Default and battle-tested | Compile-time feature only; no marker, migration, route, or runtime switch can activate it |

### What the prototype actually proves

In the storage-candidate bakeoff, one redb database per library delivered 3.8–6.7x
the custom prototype's durable-write throughput at concurrency 1/4/8. The custom
candidate was 1.46x faster at a 500-row range read and used much less open-cardinality
memory. This is why redb won the backend decision, not proof of a production speedup:

| Isolated v3 bakeoff | redb | Custom CoW |
|---|---:|---:|
| 500-row range | 1,518 ops/s; p99 879 µs | 2,222 ops/s; p99 502 µs |
| Durable replace c1 | 769 ops/s; p99 1.87 ms | 202 ops/s; p99 5.95 ms |
| Durable replace c4 | 1,699 ops/s; p99 5.27 ms | 354 ops/s; p99 17.90 ms |
| Durable replace c8 | 2,685 ops/s; p99 5.33 ms | 400 ops/s; p99 29.03 ms |
| 128 open databases, cgroup current | 28.0 MiB | 11.9 MiB |
| Minimum file | 1,056,768 bytes | 871 bytes |

A separate manager gate created 64 redb databases, kept at most 16 open, and measured
8.95 MiB peak under a hard 64 MiB/no-swap cgroup with zero max/OOM events. Redb also
supplies ACID recovery and bounded growth that a custom store would have to recreate.

The response-side evidence is weaker. Segmented fragment assembly improved its inner
loop 2.3–2.5x, from 15.147 µs to 5.994–6.664 µs, while a complete hot HTTP request
still costs roughly 170–260 µs. Production v2 already serves the measured hot page
at 3,361 req/s and 1.403 GiB/s. A faster assembly loop alone is therefore unlikely
to produce a 2x endpoint gain.

Recommendation:

1. Keep v3 feature-gated and unreachable from production traffic.
2. Finish crash-injected lazy migration, format-marker publication, deletion/restore,
   and mixed-v2/v3 correctness before discussing activation.
3. Implement bounded 32–64 KiB segmented HTTP bodies and measure full requests,
   allocations, slow readers, and writes—not just the assembly loop.
4. Canary one library only after the complete 64 MiB migration/write/cancellation
   soak passes.
5. Promote it for transactional latest-row authority, predictable storage growth,
   or a measured full-request improvement. Do not promote it merely because redb is
   faster than the custom storage prototype.

### Pros

- The durable format directly represents the state the wire protocol exposes: one
  latest row per key, ordered by its current sequence.
- Head, CAS indexes, and response fragment change in one transaction; no replay has
  to reconstruct agreement after a normal restart.
- Superseded rows disappear transactionally instead of accumulating until a log
  compaction threshold.
- One database per library preserves independent writers; a shared redb database
  would reintroduce the global write serialization already removed from v2.
- Canonical fragments can feed a segmented response without reparsing, re-escaping,
  or copying an entire page for a slow client.
- redb is already in the shipped dependency graph and has much less correctness
  surface than maintaining a new storage engine.

### Cons and risks

- There is no measured v2-versus-v3 durable-write result yet. The headline 6.7x is
  easy to misread and must not be used as a production claim.
- Current hot v2 reads are already faster than the isolated redb range benchmark,
  although the workloads are not directly comparable.
- The roughly 1 MiB minimum file is substantial for many tiny libraries and affects
  disk quotas, backup policy, snapshot traffic, and inode/page-cache behavior.
- redb's 128-open-database cgroup cost was 16.1 MiB above the custom candidate. Lazy
  open and aggressive inactive eviction are mandatory, not optional tuning.
- Migration has two durable publications—the database and then its format marker.
  Every crash prefix, deletion, retirement, restore, and abandoned temporary file
  needs a deterministic authority rule.
- The current prototype copies range results and has no HTTP integration. The main
  memory/latency promise—response-lifetime fragment admission and bounded chunks—is
  still future work.
- Adding an inactive storage format to main too early creates code that production
  cannot exercise and that can silently rot as v2 semantics evolve.

In short: #137 has a plausible near-term 1.5–1.8x win on a narrow hot path and needs
one decisive benchmark. #140 is a sound longer-term format project whose durability
and response-ownership work is more valuable than its current endpoint-speed claim.

## Reproducing the gate

See [bench/README.md](bench/README.md). The full acceptance form is:

```sh
CONTAINER_ENGINE=podman \
  DURATION=30 SOAK_DURATION=300 CONCURRENCY=48 \
  BANDWIDTH_MODES= bench/run.sh
```

Run 1/10 Gbit shaping only on a dedicated benchmark interface as documented there.
