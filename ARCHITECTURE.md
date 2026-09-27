# Architecture

den-edge is one Rust process with bounded in-process admission and one durable data directory. It serves the Den
web app, device sync APIs, pairing and inbox traffic, guest grants, OAuth/MCP, and allowlisted addon relays. Host
classification separates public web, public device API, and combined LAN/tailnet surfaces before route dispatch.

## Request and data flow

Requests pass through body-size, rate, concurrency, and storage admission before reaching a handler. Small control
answers are serialized in memory. Exact web files use the mmap/file paths described in
[Performance](PERFORMANCE.md). Relay responses remain streams and retain their concurrency permit until completion,
cancellation, or idle timeout.

Most durable namespaces use one SHA-256-named file per key. Updates write and fsync a sibling temporary file,
rename it into place, then fsync the parent directory. Read-modify-write operations hold only the affected key's
lock. All namespaces share `STORE_CAP_BYTES`; reservations occur before allocation and roll back on failure.

## Transactional libraries

Each library is an independent redb database, so unrelated libraries never share a database writer. Three
authoritative structures commit atomically:

- metadata: format, credentials, and `head`;
- current key to sequence;
- sequence to canonical encrypted JSON row fragment.

A batch evaluates every CAS against the transaction's starting state. Accepted replacements remove the superseded
sequence, allocate new sequences, update both indexes, and advance `head` in the same commit. Readers therefore see
the complete state before or after a batch. Current rows are authoritative; normal startup does not replay a log,
and superseded rows need no compaction. The wire contract remains library-v2: the same entries, conflicts, head,
`more`, and generation behavior.

Libraries open lazily. At most 16 databases may be leased concurrently, and only the two most recent idle handles
remain open. Each open library reserves 688 KiB, including a worst-case prepared identity response. Other hard
bounds include 8 MiB live charge per library, 16 MiB aggregate library charge, 50,000 current rows, 32 KiB values,
and 512 KiB changes pages. Slow clients retain response admission until the final frame or cancellation.

An exact identity changes page may be retained per library and shared as immutable byte chunks. Writers serialize
commit and invalidation through that library's prepared-page lock, so a pre-commit reader cannot publish a stale
page after a commit. Gzip uses a separately bounded whole-page representation.

## Format selection and migration

A per-library marker selects exactly one authority: no marker means the legacy v2 file; version 3 means only the
v3 database. Unknown versions fail closed, and a request never reads two heads.

The first request to a v2 library performs migration under that library's lock. It streams and validates v2 into a
sibling temporary v3 database, commits and fsyncs it, publishes and fsyncs the database, then atomically publishes
and fsyncs the marker. Before the marker, v2 alone is authoritative; afterward, v3 alone is authoritative. Recovery
removes abandoned temporary files and deterministically selects the old or new complete store after every crash
prefix. Migration is per library, so v2 and v3 libraries can coexist during rollout and startup scans none of them.

`DATA_DIR/generation` is deliberately excluded from backups. Restoring data creates a new generation, forcing
clients that observed a later head to read from sequence zero and reconcile. Library retirement removes the selected
authority and its marker under the same per-library coordination.

## Browser delivery

HTML, the service worker, and other mutable entry files revalidate; hashed JS, CSS, images, and WASM are immutable
and served from prebuilt Brotli or gzip representations when accepted. CSS is one small cacheable transfer. Route
JavaScript remains split: Detail and Search may preload in an idle slice on a fast connection only after the Home
hero has decoded; other screens load on navigation or pointer intent. HLS remains demand-only.

The billboard gives its current still priority. Adjacent stills and metadata wait for that image and an idle slice;
ambient video resolution waits for the still, and the following trailer warms only after the current trailer is
playing. Browse mounts two rows at a time near the viewport. Posters load lazily, and person photo metadata is
requested only as its card approaches the viewport. The router retains at most two inactive detail/person/service
pages while preserving reusable top-level browsing surfaces.

## Operational invariants

- Stored library values, inbox messages, and backups remain device-sealed ciphertext.
- There is no process-wide library writer or unbounded response cache.
- Active database handles, mmap generations, relay streams, and prepared responses retain their permits until the
  owner finishes or is cancelled.
- `/metrics` is token-protected and exposes bounded-cache outcomes, faults, residency, and high-water marks.
- A full store fails writes with `507`; an over-limit library fails with `413`; concurrency pressure is explicit
  rather than converted into unbounded queues.

The exact library transaction and crash invariants are specified in [Library v3](LIBRARY_V3.md).
