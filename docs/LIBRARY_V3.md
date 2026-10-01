# Library v3 storage and wire invariants

Status: implemented in the HTTP path with lazy v2 migration. The issue #140 Linux 64 MiB mixed-workload gate passed;
this status does not claim deployment.

## Authority and transaction

One independently writable database belongs to one library. Its committed state is:

- metadata: format version `3`, token hash, optional member hash, and `head`;
- keys: record key to its current sequence;
- sequence: current sequence to the canonical JSON row fragment `{"k":…,"seq":…,"v":…}`.

The sequence table is the payload authority. Values are not duplicated in the key index. Exactly one sequence entry
exists for each key entry, both indexes agree, every sequence is at most `head`, and no superseded sequence remains.
Encrypted tombstones are ordinary row values and obey the same rules.

A valid batch has unique keys. Every CAS observes the state at the beginning of the batch. In one storage
transaction, each accepted write removes its old sequence entry (if any), allocates the next head, inserts its
canonical fragment, updates key to sequence, and finally commits the new head. Conflict replies decode the exact
current canonical fragment; a missing key is sequence zero with a null value at the HTTP boundary. A reader sees
the complete state before or after this transaction, never a mixed head/index/fragment state.

Libraries never share a writer or durability domain. A backend with one process-wide writer is not compatible even
if its data model is otherwise correct.

## Bytes and response ownership

The backend reports, rather than estimates away, fixed database/cache/mapping cost per open library,
response ownership, temporary migration memory, and copy-on-write slack. Existing limits remain
hard: 8 MiB per library, 16 MiB aggregate library cache, 32 KiB value (256 KiB at wire minimum 4, below), 50,000 live
rows, 512 KiB page, and the 64 MiB container target. Reservations precede allocation and roll back on cancellation.

V3 admits at most 16 simultaneously leased databases. Each is charged 688 KiB: 112 KiB for the measured handle,
cache, and mapping residency, plus 576 KiB for one worst-case prepared identity page including allocation slack. It
trims back to the two most recent idle handles as soon as request leases end. Active libraries are never evicted.
This preserves independent writers during a burst while preventing a high-cardinality cold walk from retaining
mappings and file descriptors.

The Linux gate reports cgroup anonymous and filesystem-cache bytes separately. Recovery requires RSS, anonymous
memory, descriptors, and sockets to return within their bounds. Clean file pages may remain in the cgroup after a
cold durable scan because the kernel owns and reclaims them under pressure; they remain visible in every report,
and `memory.max`, zero swap, peak usage, plus `memory.events` still fail the run on real pressure or OOM.

A changes read holds one consistent snapshot while selecting sequences greater than `since`, bounded by row count
and the existing page-byte rule. It captures head and generation with that selection. Where the backend permits,
the transaction then closes before the client can become slow. The response owns immutable fragment storage until
its last frame or cancellation and charges retained capacity, not just logical bytes.

Identity output is an envelope, comma-separated canonical fragments, and suffix, coalesced into chunks no larger
than 64 KiB directly from one redb read transaction. There is no whole-page assembly and no frame per row. The
response holds a 512 KiB aggregate-budget permit until its last frame or cancellation. Gzip keeps the existing
separately bounded whole-page compression path and holds the same response permit.

An open library retains at most one exact identity representation keyed by `since`, effective `limit`, and
generation. Concurrent hits clone immutable `Bytes` references rather than the body. A writer holds that library's
prepared-page lock across its transaction and invalidation, so a pre-commit read cannot publish stale bytes after a
commit. This is per-library only; it creates no cross-library writer or cache lock.

## Wire minimum 4 (den-spec `wire/library-v4.md` §13)

The store format is unchanged; v4 is a client wire format whose rows are whole documents. den-edge still interprets
no row. What a library at minimum 4 changes:

- **Value cap 256 KiB**, measured as the value is stored, JSON-escaped in its fragment (identical for base64url), so
  one row still fits the 512 KiB page a `/changes` response reserves. Below 4 the cap stays 32 KiB of `v`.
  `parse_writes` and `rewrite_rows` admit up to 256 KiB at any minimum; the cap of the library's minimum is applied
  inside the write transaction by `apply_bounded` and the store-level `rewrite`, which read the minimum the write
  leaves (a first batch's `x-den-wire-min`, a commit's `max(current, wireMin)`). A new library's batch is also
  checked before its store is created, so a refused batch starts nothing.
- **Refusals**: an oversized batch value is `400 invalid_batch`, as a v3 client has always been told; a rewrite
  commit leaving the library below 4 with a staged row over 32 KiB is `400 value_too_large`, and the stage stays open.
- **Conflict values**: a batch response carries at most 2 MiB of them. A conflict whose value would pass that is
  `{k, seq, "omitted": true}` and the client reads the row from `/changes`; a smaller later one still carries its
  value. Below minimum 4 nothing is omitted, since no v3 client knows the marker and 200 × 32 KiB is bounded anyway.
- Unchanged: 200 writes and a 2 MiB body per batch, the 32 MiB stored-bytes charge (staging charged the same), 50,000
  rows, and v3's `426`, generation and highest-minimum rules, which take minimum 4 with no new mechanism.

## Format selection and compatibility

V2 and v3 have different filenames and are never reinterpreted in place. A durable per-library format marker selects
exactly one authority. Absence of the marker means v2. Marker version `3` means only the v3 database may answer or
accept writes. An unknown marker fails closed; it must not be guessed as v2 or partially decoded.

This is storage negotiation, not a wire protocol fork: v2 and v3 must return the same `entries`, `head`, `more`,
`generation`, applied rows, and conflict rows. Mixed-format libraries may run in one process because selection and
locking are per library. Rollback may retain a v2 file only as an explicitly stale artifact; after v3 activation it
must never receive writes or be selected as current. It is kept for 30 days after the marker's mtime (the switch: the
marker is written once and never rewritten), then removed after a write under the library's lock; never while the
marker is absent.

## Charge and compaction

A v3 library's charge is its stored bytes: `k + v` per live row, against `Limits::stored_bytes` (32 MiB). The v2
in-memory formula `2(k + v) + fragment + 192` (plus a 512-byte base) overstated a v3 library about threefold; a store
written under it carries no `charge` metadata and is recounted once, in the transaction that opens it. The rewrite
staging allowance uses the same charge. Clients deciding whether to switch still apply the old formula (den-spec
library-v3 §9), which is only stricter.

redb reuses freed pages but does not shrink its file. After a committed write (a batch or a rewrite commit) and with
no rewrite staged, an open library measures its file at most once an hour: when more than half of it, and at least
2 MiB, is free pages by redb's own page count, it runs `Database::compact` holding the database exclusively (every
transaction runs under a read guard). One compaction runs at a time in the process, and its transient heap (measured
~260 KB for a 13.7 MB file, ~1.04 MB for a 67 MB one) is reserved as 1.5 MiB in the open-database budget first; with no
room it waits for a later hour.

## Lazy migration and crash boundaries

Migration runs under only that library's write lock and existing replay/memory admission:

1. Remove an abandoned sibling temporary v3 file while v2 remains authoritative.
2. Replay v2 using its current torn-tail/glued-write repair rules and validate every existing bound.
3. Build a fresh sibling temporary v3 database from only the latest rows in sequence order.
4. Commit and fsync its metadata, indexes, and pages; close it; fsync the completed file.
5. Atomically publish the v3 filename and fsync the parent directory.
6. Atomically publish the version marker and fsync the parent directory.

Before step 6, v2 alone is authoritative and any v3 file is ignored. After step 6, v3 alone is authoritative. A crash
at any boundary therefore selects a complete old or complete new store, never two heads. Cleanup, retirement,
generation reset, backup, and restore must use the selected format and tolerate every prefix of these steps.

## Promotion evidence

Implemented: executable equivalence model, per-library redb selection, shared hard disk quota, exact live-row charge,
lease-bound open admission and idle-handle recovery, lazy v2 migration, mixed-format selection, retirement,
membership credentials, bounded identity frames, response-lifetime admission, transaction abort tests, and
migration-prefix recovery tests.

The final combined target-amd64 gate ran in a container with `memory.max=64 MiB` and swap disabled. Its 60-second
mixed phase completed 236,495 requests with zero unexpected statuses or client errors, including 14,955 durable
replacement writes and 5,878 concurrent library reads. Cgroup memory peaked at 52,416,512 bytes, process RSS peaked
at 12,378,112 bytes, no `memory.events` pressure/OOM counter moved, and descriptors recovered to 13. The preceding
named cases migrated 160 cold libraries at 540 requests/second and served the prepared 488 KiB identity page at
2,541 requests/second in the ten-second sample; the three-second smoke sample reached 3,254 requests/second.

Unit/model/fault tests, clippy, web tests, browser sync policy, and the production image builds are CI gates. The
issue and PR record the canary/rollback decision; promotion remains an operator decision and is not performed by
this implementation.
