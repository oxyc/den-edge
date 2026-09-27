# den-edge architecture

den-edge is a single-process Rust origin for Den. It combines a small durable state
service, the Den web app, provider caches, and tightly controlled relays to LAN
addons. It is designed to run without a cluster in a 64 MiB container while still
using a fast uplink efficiently.

This document describes the production architecture at `647d47a`. See
[PERFORMANCE.md](PERFORMANCE.md) for measured results and experimental work.

## System shape

```text
                              public clients
                                    |
                             Cloudflare tunnel
                                    |
LAN / tailnet clients --------> den-edge :8080
                                    |
            +-----------------------+-----------------------+
            |                       |                       |
       local files              durable state          LAN addons
    web/provider cache       logs, redb metadata     Atlas/Reel/Scout/
            |                  grants, OAuth          Remux/den-mcp
            +-----------------------+-----------------------+
                                    |
                         selected external providers
                       TMDB / OMDb / SkipDB / warnings
```

Cloudflare, Tailscale, or another reverse proxy may terminate HTTP/2 or HTTP/3,
TLS, compression, and public caching. den-edge itself deliberately serves HTTP/1
on the trusted origin hop. LAN and tailnet clients may reach it more directly.
The application semantics and memory bounds do not rely on the proxy cache.

## Request path

Every request follows the same outer pipeline:

1. At most 256 TCP connections are accepted. Hyper's request-head buffer is capped
   at 16 KiB and a request head has a 120-second deadline.
2. Accepted socket queues are bounded: 64 KiB requested send and 32 KiB requested
   receive. This prevents slow clients from moving body-sized allocations out of
   Rust RSS and into unbounded kernel TCP memory.
3. Host classification selects the web, device-API, or combined LAN face. A public
   hostname cannot escape its route allowlist by changing ports or DNS spelling.
4. A fixed route label selects the method allowlist and body ceiling before the
   body is read. Normal bodies are at most 256 KiB; library batches are at most
   2 MiB.
5. Global request admission allows 64 live response bodies. Bulk work may use 48;
   16 positions remain available for health and control/state operations. A permit
   follows the response body until its last frame or cancellation.
6. The route handler applies its narrower storage, byte, concurrency, identity, or
   upstream-call budget.
7. The response receives security headers, a random request ID, bounded-cardinality
   metrics, and an optional fixed-label log line.

Overload is explicit. Work that cannot be admitted quickly receives a stable 429,
503, or size error with `Retry-After` where appropriate. It is not queued without
a bound.

## Delivery modes

The fastest representation is the one that already matches what the client needs.
den-edge therefore has several delivery paths instead of treating all JSON or all
files alike.

| Delivery | Examples | Body ownership | Validators and encoding | Why it exists |
|---|---|---|---|---|
| Prepared small JSON | `/config`, `/routes` | One immutable `Bytes` value prepared at startup | Strong ETag; 304 without serialization | Removes repeated JSON building and hashing from startup traffic |
| Prepared immutable asset | Vite files under `/assets/` | Chosen file streamed in 64 KiB reads | Per-representation ETag; `.br`, `.gz`, or identity; `Vary: Accept-Encoding`; one-year immutable policy | Metadata-only hot path and direct precompressed delivery |
| Mutable/unhashed web file | shell, service worker, icons, manifest | Shell retained in memory; other files streamed in 64 KiB reads | ETag cached by length/mtime; fresh sidecar compression when available; shell/SW revalidate | Allows safe hand-updated files and route-shell fallback |
| Canonical provider file | ratings, warnings, SkipDB, ordinary TMDB list/search | Open file streamed in 64 KiB reads | Strong ETag and Last-Modified from a fixed sidecar bound to inode/length/mtime | A hit does not parse JSON or allocate a body-sized buffer; a 304 reads no body |
| Prepared TMDB detail | known detail/append shapes | Exact canonical file or digest-qualified derived file streamed from disk | Source-generation-bound validators and content-aware freshness | Pays parse/serialize once for checked-in shapes, then behaves like file serving |
| Transient derived JSON | arbitrary TMDB append subsets, rewritten grant/session JSON | Bounded in-memory `Bytes` charged for the response lifetime | Validator/cache policy where safe; generally no durable variant | Avoids unbounded files for attacker-selected shapes or mandatory rewrites |
| Library sync page | `/lib/:id/changes` | Canonical row fragments are shared; one page envelope is assembled in memory, at most about 512 KiB | Identity or fast gzip; no combinatorial page cache | Latest-row semantics make pages depend on `since`, `limit`, head, and generation |
| Streaming addon response | most Atlas/Scout/MCP responses | One-frame channel between upstream and downstream | Safe upstream cache/encoding/validator headers are forwarded | Preserves backpressure without collecting an answer up to 8 MiB |
| Streaming media relay | Reel fallback media | Separate one-frame channel plus media permits; range semantics preserved | Range, length, ETag, encoding, cache and timing headers pass through | Videos may be tens of MiB and must support seeking; collecting is never valid |
| Direct external media | Reel external/native URL or signed direct-media lease | Bytes do not cross den-edge | Controlled by the external origin and capability | Preferred path: avoids spending homelab memory, CPU, and uplink twice |

### Static files and compression

At startup, den-edge indexes content-named Vite assets and their `.br` and `.gz`
sidecars. It retains only path, length, modification time, and digest. A conditional
request can therefore return 304 without opening a body file. A 200 opens exactly
one selected representation and allocates its 64 KiB buffer only when Hyper first
polls the body.

The ETag names the selected representation, not merely the source asset. A Brotli
copy cannot incorrectly validate a gzip or identity copy. `Accept-Encoding` weights,
explicit refusals, wildcard rules, and identity refusal are honored.

Cloudflare may cache or recompress a public response according to its configuration,
but origin delivery remains efficient when it does not. Hashed assets are immutable
for one year. HTML and the service worker use `no-cache`; other unhashed assets use
a one-day TTL with stale-while-revalidate.

### Canonical provider JSON

Provider cache bodies remain ordinary JSON files so they are inspectable and easy
to rebuild. A fixed 64-byte response sidecar records the body length, timestamp,
device/inode identity, encoding, and a 128-bit SHA-256 prefix. The sidecar is trusted
only when it matches the opened file generation. A missing or stale sidecar causes
one bounded 64 KiB-at-a-time rehash and is then republished.

This gives exact hits file-serving behavior:

- no `serde_json::Value` tree;
- no body-sized response allocation;
- an open inode stays self-consistent across atomic replacement;
- 304 and HEAD discard the body without reading its bytes;
- a truncated file fails rather than violating its promised `Content-Length`.

Provider data is reconstructible and intentionally outside essential backups. It
survives process restarts and normal deployments because it lives in persistent
`DATA_DIR`, not the image or an in-memory cache.

Freshness is endpoint-specific rather than one global TTL:

- settled TMDB entity details: up to 180 days;
- unfinished series or details carrying moving data: 6 hours;
- TMDB lists/trending/provider/video-style data: 6 hours;
- TMDB search: 1 hour;
- ratings and warnings: 30 days fresh, retained up to 180 days where applicable;
- SkipDB: 7 days fresh, retained for 90 days.

Stale usable data is preferred over turning an upstream outage into a user-visible
outage. Negative answers have shorter TTLs. Upstream ETags are kept with the exact
generation they validate, and concurrent cold callers share one upstream attempt.

### TMDB detail representations

A detail request may ask for a subset of a canonical whole-title answer. Serving the
whole file would change the API response, while parsing and serializing on every hit
is expensive. Known client shapes are therefore built once into digest-qualified
prepared files. Publication succeeds only while the source digest remains current.
The next request streams that derived file.

Arbitrary public subsets are built transiently under a 16 MiB derived-response byte
budget and a serialized builder. They are not persisted, preventing query-shape
cardinality from becoming disk amplification.

### Library pages

Library v2 is an append-only durable log, replayed into an in-memory latest-row
index on first use. Each row also owns its canonical serialized response fragment.
A changes request holds the per-library lock only long enough to select a bounded
page of shared fragments and capture `head`; envelope assembly and compression occur
after the lock is released. Different libraries therefore make progress independently.

Limits are part of the architecture:

- 50,000 live rows and an 8 MiB charge per library;
- 128 cached libraries and 16 MiB aggregate cached charge;
- pages bounded by row count and approximately 512 KiB;
- four non-queued compression jobs; when busy, identity is served instead;
- fast gzip is used because pages are often unique and mostly ciphertext.

There is deliberately no disk cache for every `(library, head, since, limit,
encoding)` combination. That key space grows with client progress and would turn
100,000 actor pages or 50,000 movie pages into an invalid model for library sync as
well. Exact reusable representations are persisted only where reuse is demonstrable
and bounded.

### Addon and media streaming

Ordinary addon responses stream through a channel of capacity one. The pump reserves
downstream capacity before reading the next upstream frame. It owns the upstream
body and admission permit, so cancellation, an idle source/receiver, size overflow,
or deadline drops every scarce resource together.

Only responses that must be inspected or rewritten are collected. Their combined
charge is capped at 16 MiB, and the charge follows the actual returned `Bytes` owner.
Untrusted cookies, redirects, CORS grants, and unrelated upstream headers never cross
the relay boundary.

Media uses a separate pool so a long trailer cannot occupy JSON relay capacity:

- 16 media response bodies total;
- at most 12 in the member share, leaving total capacity for guests;
- at most 3 concurrent guest viewer leases;
- range and conditional headers pass in both directions;
- upstream receive queues are explicitly bounded;
- accepted downstream send queues are explicitly bounded;
- a guest's byte ceiling is counted as frames actually leave, not from headers.

Reel prefers external/native URLs and signed direct delivery. The den-edge media
relay is the immediate compatibility fallback, not the preferred bulk-data route.

## Memory and concurrency model

The important memory figure is cgroup memory, not process RSS alone. Linux socket
queues and file pages are charged to the container but may not appear in Rust RSS.
The main hard bounds are:

| Resource | Bound |
|---|---:|
| Accepted connections | 256 |
| Hyper request-head buffer | 16 KiB per accepted connection |
| Accepted socket send/receive request | 64/32 KiB |
| Live requests | 64 total, 48 bulk |
| Normal request body | 256 KiB |
| Library batch body | 2 MiB |
| Addon requests in flight | 16 |
| Addon collected bodies | 16 MiB aggregate |
| Media response bodies | 16 |
| Provider/TMDB response | 4 MiB per TMDB answer |
| TMDB derived responses | 16 MiB aggregate |
| Cached libraries | 16 MiB aggregate, 8 MiB each |
| Title-metadata observations | 16 MiB aggregate |

The limits compose: a permit remains owned by the work or body it protects, rather
than being returned when response headers are created. Slow clients therefore retain
their own admission cost and eventually receive backpressure or a stable refusal.

## Storage and recovery

Core state is durable, local, and single-node:

- key-addressed files use SHA-256 names;
- replacement writes use temporary files, sync, and atomic rename;
- inbox/state read-modify-write operations are serialized for correctness;
- libraries use append-and-fsync logs with bounded replay and compaction;
- title metadata uses redb transactions;
- OAuth and grant secrets are stored as hashes;
- a store generation changes after restore so clients replay safely.

Provider caches are durable but reconstructible. They should persist across restarts
and deployments, but do not need to be part of disaster-recovery backups.

## Observability and validation

Prometheus metrics use fixed-cardinality labels for request class, response status,
admission outcome, provider/cache outcome, byte pools, stream lifecycle, retained
bytes, compression, and resource high-water marks. Request logs use normalized route
labels and a request ID; credentials, arbitrary keys, and query cardinality are not
labels.

`bench/run.sh` is the capacity acceptance gate. It runs the release scratch image in
a real 64 MiB cgroup with swap disabled, verifies response contracts and body lengths,
samples RSS/cgroup/FD/socket state, checks OOM counters, and requires post-case
recovery. See [bench/README.md](bench/README.md) and [PERFORMANCE.md](PERFORMANCE.md).

## Current non-goals

- Horizontal clustering or distributed consensus.
- Treating Cloudflare cache hits as origin capacity.
- Buffering complete media files in memory.
- Prebuilding every user- or pagination-selected representation.
- Raw streaming of library-v2 append events; they are not authoritative latest rows.
- Claiming zero-copy through a TLS proxy. Production currently uses bounded async
  file reads, not mmap, `sendfile`, `splice`, or io_uring.

