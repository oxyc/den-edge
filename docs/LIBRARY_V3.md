# Library v3 storage and wire invariants

Status: design contract and executable model only. The production format remains v2 until every promotion gate in
issue #140 passes.

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

The backend prototypes must report, rather than estimate away, fixed database/cache/mapping cost per open library,
resident capacity of retained fragments, temporary migration memory, and copy-on-write slack. Existing limits remain
hard: 8 MiB per library, 16 MiB aggregate library cache, 32 KiB value, 50,000 live rows, 512 KiB page, and the 64 MiB
container target. Reservations precede allocation and roll back on cancellation.

A changes read holds one consistent snapshot while selecting sequences greater than `since`, bounded by row count
and the existing page-byte rule. It captures head and generation with that selection. Where the backend permits,
the transaction then closes before the client can become slow. The response owns immutable fragment storage until
its last frame or cancellation and charges retained capacity, not just logical bytes.

Identity output is an envelope, comma-separated canonical fragments, and suffix. Small fragments are coalesced into
32–64 KiB chunks; a single larger fragment may be its own shared chunk. There is no whole-page assembly and no frame
per row. HEAD and 304 remain metadata-only. Gzip uses the separately bounded compression path.

## Format selection and compatibility

V2 and v3 have different filenames and are never reinterpreted in place. A durable per-library format marker selects
exactly one authority. Absence of the marker means v2. Marker version `3` means only the v3 database may answer or
accept writes. An unknown marker fails closed; it must not be guessed as v2 or partially decoded.

This is storage negotiation, not a wire protocol fork: v2 and v3 must return the same `entries`, `head`, `more`,
`generation`, applied rows, and conflict rows. Mixed-format libraries may run in one process because selection and
locking are per library. Rollback may retain a v2 file only as an explicitly stale artifact; after v3 activation it
must never receive writes or be selected as current.

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

## Implementation and promotion order

1. Keep the executable pure model and generated v2-history equivalence test as the semantic oracle.
2. Measure per-library redb against a minimal copy-on-write page file: open-library overhead, cache/mappings,
   write+fsync p50/p99, range scans, repeated replacement growth/reclamation, and independent c4/c8 writers.
3. Put the selected backend behind a library-store trait, with v2 still the production default.
4. Inject failures at every transaction and migration boundary, including corrupt/truncated inputs.
5. Add lazy migration and mixed v2/v3 operation, then bounded segmented bodies and slow-reader cancellation tests.
6. Canary one library only after semantic, crash, allocation/frame, HTTP performance, disk-growth, and 64 MiB mixed
   soak gates from issue #140 pass.
