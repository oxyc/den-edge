# Library v3 store implementation slice

This slice implements the selected redb backend behind `LibraryStore`, compiled only with the `library-v3` feature.
No production configuration enables that feature, no format marker selects v3, and no HTTP or migration path calls
the store. Production remains v2.

Each active library owns one redb database and therefore one independent writer. Four tables hold format/head,
credentials, key-to-current-sequence, and sequence-to-canonical-fragment. A batch evaluates all CAS operations against
its initial snapshot, then removes superseded sequences, inserts canonical fragments, updates keys and head in one
durable transaction. `latest` returns the exact stored fragment; `range` copies only the bounded page selected by
`since`, limit, and the existing 512 KiB page rule and does not parse or re-escape fragments.

The manager opens databases lazily. Every open database reserves 112 KiB before allocation, uses an explicit 64 KiB
redb cache, and is pinned by an active lease. LRU eviction closes only inactive databases and removes their registry
slots, so a stream of unique IDs cannot leave an unbounded empty registry. The later response-body slice must add a
separate response-lifetime reservation for fragments returned by `range`; that ownership is intentionally not hidden
inside the fixed database charge.

Disk limits are enforced twice: each database has a file cap, and every resize reserves against one aggregate atomic
quota shared by independent library writers. Existing `.redb` files seed that accounting on manager startup. A failed
first open removes its partial file and refunds exactly its observed bytes. Database filenames are SHA-256 of library
IDs; credentials are stored in the database and checked again on cached opens.

Tests cover exact CAS conflicts, superseded-row removal, canonical escaping, latest/range/reopen, incompatible cached
credentials, transaction abort, process abort before commit, process abort after durable commit, per-file and aggregate
disk exhaustion, active-lease pinning, LRU/high-cardinality eviction, and bounded slot cardinality.

The dedicated 64 MiB/no-swap Linux gate creates and writes 64 unique databases while allowing 16 open at once. The
measured run used 8,941,568 bytes at assertion time and peaked at 8,945,664 bytes, with `max=0`, `oom=0`, and
`oom_kill=0`. Reproduce it with:

```sh
docker build -f bench/library-v3-store.Dockerfile -t den-edge-library-v3-store-test .
docker run --rm --memory 64m --memory-swap 64m den-edge-library-v3-store-test
```

Remaining before activation: crash-point injection around migration/marker publication, deletion and retirement,
backup/restore policy, response-lifetime byte admission, bounded 32–64 KiB HTTP frames, mixed-format operation, and
the complete #140 promotion soak.
