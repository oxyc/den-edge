# Library v3 store implementation slice

This was the initial isolated implementation note. Library v3 is now compiled into and selected by the production
HTTP path in PR #147; [LIBRARY_V3.md](LIBRARY_V3.md) is the current authority for activation, migration, response
ownership, and promotion gates.

Each active library owns one redb database and therefore one independent writer. Four tables hold format/head,
credentials, key-to-current-sequence, and sequence-to-canonical-fragment. A batch evaluates all CAS operations against
its initial snapshot, then removes superseded sequences, inserts canonical fragments, updates keys and head in one
durable transaction. `latest` returns the exact stored fragment; `range` copies only the bounded page selected by
`since`, limit, and the existing 512 KiB page rule and does not parse or re-escape fragments.

The manager opens databases lazily. Every open database uses an explicit 64 KiB redb cache and reserves 688 KiB:
112 KiB of measured handle/cache/mapping residency plus a worst-case exact prepared identity page. Active leases pin
their library. Sixteen distinct libraries may be active concurrently; the manager immediately returns to two idle
handles, removes dead process-registry keys, and releases file descriptors. Response bodies separately hold the
existing 512 KiB aggregate-budget permit until completion or cancellation.

Disk limits are enforced twice: each database has a file cap, and every resize reserves against one aggregate atomic
quota shared by independent library writers. Existing `.redb` files seed that accounting on manager startup. A failed
first open removes its partial file and refunds exactly its observed bytes. Database filenames are SHA-256 of library
IDs; credentials are stored in the database and checked again on cached opens.

Tests additionally cover v2 model equivalence, exact live-payload charges, CAS-filtered row admission, every lazy
migration publication prefix, unknown/missing format authority, mixed-format retirement and membership, generation
reset, bounded HTTP chunks, prepared-page invalidation, response cancellation, and active/idle handle recovery.

The dedicated 64 MiB/no-swap Linux gate creates and writes 64 unique databases while allowing 16 open at once. The
measured run used 8,941,568 bytes at assertion time and peaked at 8,945,664 bytes, with `max=0`, `oom=0`, and
`oom_kill=0`. Reproduce it with:

```sh
docker build -f bench/library-v3-store.Dockerfile -t den-edge-library-v3-store-test .
docker run --rm --memory 64m --memory-swap 64m den-edge-library-v3-store-test
```

The isolated numbers above remain historical evidence for selecting redb, not current production measurements. See
#140 and PR #147 for the complete HTTP comparison and 64 MiB mixed-workload evidence.
