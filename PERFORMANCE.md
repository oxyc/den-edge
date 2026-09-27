# Performance and resource bounds

den-edge chooses a delivery path by ownership and payload shape. The goal is predictable memory at high concurrency,
not one universal cache.

| Delivery | Current path | Memory and cancellation behavior |
|---|---|---|
| Small JSON/control responses | Validate and serialize once in the handler | Bounded by route body and object limits |
| Hot exact web files, 64–512 KiB | Read-only anonymous mmap generation | Shared immutable bytes; 8 MiB/32-file global caps; active responses pin their generation |
| Other web files | Async file reads in chunks of at most 64 KiB | No whole-file buffer; backpressure limits live chunks |
| Library identity changes page | Canonical row fragments coalesced into immutable chunks of at most 64 KiB | One exact prepared page per open library; a 512 KiB aggregate response permit lives through cancellation |
| Library gzip changes page | Separately bounded whole-page compression | Same response permit; compression and slow readers cannot escape admission |
| Addon/MCP relay | Upstream-to-client streaming | No whole-response assembly; permit remains until EOF, cancellation, or idle timeout |

The mmap path copies a hot file once into an anonymous mapping. That avoids a per-hit filesystem read/copy while
also avoiding `SIGBUS` if an atomically replaced file's old inode is truncated. Budget pressure falls back to the
64 KiB streaming path. Library prepared pages are exact query representations, not a cache of every actor/movie or
every historical row; a write invalidates only its library's retained page.

## Hard bounds

- Container design target: 64 MiB with swap disabled.
- Exact-file mmap cache: 8 MiB resident, 32 files.
- Library admission: 16 simultaneously leased databases, two retained idle handles, 688 KiB reservation per open
  database.
- Library state: 8 MiB charged per library, 16 MiB aggregate library charge, 50,000 rows, 32 KiB per value.
- Changes response: 512 KiB, additionally bounded by requested row count; identity frames are at most 64 KiB.
- Request bodies: 256 KiB generally and 2 MiB for a library batch.

These are admission limits, not monitoring aspirations. Reservations precede allocation and are released on every
normal, error, cancellation, and eviction path.

## Validated results

All numbers below are target-amd64 measurements, not capacity promises. Payload, concurrency, TLS/proxy placement,
storage, and client behavior change production throughput.

The final combined library-v3 and mmap 60-second mixed gate ran with `memory.max=64 MiB` and no swap. It completed
236,495 requests with no unexpected status, client error, OOM, or memory pressure event. That included 14,955
durable replacement writes and 5,878 concurrent library reads. Cgroup memory peaked at 52,416,512 bytes, process RSS
at 12,378,112 bytes, and file descriptors recovered to 13. A separate cold case migrated 160 libraries at 540
requests/second. A hot prepared 488 KiB identity page sustained 2,541 requests/second for ten seconds; a three-second
smoke sample reached 3,254 requests/second.

For hot exact files, the mmap implementation measured 1,418 to 4,300 requests/second (+203%), CPU time per GiB
from 6.99 to 1.259 seconds (-82%), and p99 from 13.94 to 10.63 ms in its matched benchmark. A five-minute 64 MiB
soak completed 1.088 million requests with zero errors or OOM and a 28.61 MiB peak. The cancellation/replacement
stress observed an 8 MiB resident mmap high-water mark, file descriptors recovering from 134 to 11, 211,981
cancellations, and hash parity across 100 replacements; its whole-run cgroup peak was 58.8 MB.

Compare only matched rows: the library figures include transactional storage and JSON semantics, while the mmap
figures are exact immutable-file delivery. Current CI gates Rust tests, model/fault tests, clippy, browser sync
policy, web tests, and production image builds. Promotion additionally requires the 64 MiB mixed workload.
