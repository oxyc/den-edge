# den-edge 64 MiB benchmark and soak harness

This harness measures the release binary in a real container memory cgroup. Its
fixture upstream and load client are local and deterministic: no TMDB, OMDb,
SkipDB, Reel, or other provider key is read or required.

Run it from the repository root:

```sh
bench/run.sh
```

Docker or Podman must be running. The harness builds scratch images, verifies
from inside the measured cgroup that `memory.max` is exactly 64 MiB and
`memory.swap.max` is zero, and writes one
JSON object per case to `bench/results/<UTC timestamp>.jsonl`. Override the
defaults with `DURATION=30 SOAK_DURATION=300 CONCURRENCY=32 PORT=18081`.
`CONTAINER_ENGINE=podman` selects Podman explicitly. Exit 77 means the required
container engine was unavailable, so a misleading host-only run was not made.

This is a closure gate, not a reporting-only benchmark. Any unexplained client
error, unexpected status or refusal code, body-size/`Content-Length` mismatch,
cgroup OOM/kill increment, failed post-case health check, or failed post-case
resource recovery exits nonzero. Cancellation must also produce server-side
evidence that upstream work was accepted, aborted, and returned to baseline.
Every passing row carries `"gate":"passed"` and includes completed requests, status/refusal counts, body payload
bytes, requests/s, GiB/s, p50/p95/p99 latency, process CPU in cores, sampled
RSS, sampled cgroup current, the kernel cgroup peak and OOM events, open file
descriptors, all established TCP sockets, and established port-9090 upstream
sockets. The cgroup peak and event counters are cumulative for the container;
the report also records per-case OOM/kill deltas and requires each delta to be zero.
the sampled RSS/current/FD/socket peaks are local to each named case. The tiny
`/probe` observer runs only for a sample and is not resident in the server.
On Docker Desktop the Linux VM owns the cgroup; the in-container counters are
still the authoritative ones.
CPU cores are the change in Linux process CPU ticks divided by elapsed time
(`USER_HZ=100`, Linux's stable `/proc` ABI convention).

Exact allocator-call counts are deliberately `null`: the production binary has
no allocator instrumentation, and rebuilding it with a profiling allocator
would change the footprint being measured. RSS and cgroup current/peak are the
allocation-pressure acceptance measurements. Seeded TMDB rows additionally
report `external_call_count: 0` only when every response carried
`x-den-tmdb: hit`; a missing hit now fails the seeded-provider case.

The cases cover:

- `/health` as small control JSON;
- a prepared 1 MiB static file, both 200 and metadata-only 304;
- a seeded near-limit `/ratings/imdb/:id` canonical file, both 200 and 304;
- a fast relay and a chunk-delayed upstream relay;
- a prepared exact hot library page and 160 rotating cold library logs;
- a 2 MiB Reel-shaped media pass-through;
- isolated TMDB list/search 200+304 hits, whole-detail hits, first and repeated
  large-detail narrowing, and concurrent same-key/mixed-key hits;
- clients that cancel immediately and clients that deliberately read slowly;
- all of those classes competing in one mixed 64 MiB soak.

The fixture generation writes valid store paths/logs directly so the cold run
is not capped by the public five-new-libraries-per-minute policy. The image
does not serve those host bind-mounted files directly: its PID 1 staging helper
copies them into initially empty runtime mounts before starting `den-edge`.
Those writes and the destination file pages therefore belong to the same
64 MiB cgroup being measured, and the baseline is captured only after staging
and warmup. Throughput
cases model many independent callers by rotating `X-Forwarded-For` through the
dedicated, trusted benchmark bridge. The slow-reader overload intentionally
uses one identity. It and the two media components competing for the shared
budget in the mixed soak are the only cases allowed stable overload statuses:
HTTP 429 (`too_many_sources`) and 503 (`media_busy`/`relay_busy`/`server_busy`). They must
still serve at least one HTTP 200. Control/cache/library/relay components in
that same mixed saturation case remain strictly 200-only.
Cancellation cases require the driver's explicit status 0; every other case
requires only its documented 200 or 304. Refusals cannot pass as throughput.

After every case `/health` and resources must recover, both relative to the
case boundary and the post-staging run baseline. The harness waits up to
`RECOVERY_TIMEOUT` (15 seconds by default) for RSS and cgroup current to return
within 8 MiB of baseline, file
descriptors within two, and established port-9090 sockets exactly to baseline.
The tolerances accommodate allocator/page-cache noise while still detecting
leaked bodies, permits, descriptors, and upstream streams. OOM enforcement
requires cgroup v2 `memory.events`; the run fails clearly rather than silently
pretending zero events on an unsupported engine.

TMDB's origin is currently a hardcoded public HTTPS URL. The harness records an
explicit skipped `tmdb-stale-revalidation` row rather than contacting it with a
real key or pretending to count calls. That row becomes a required acceptance
case when the next TMDB slice provides a test-only/local origin seam or a
provider-call counter. Fresh seeded hits, including concurrent same/mixed keys,
are fully enforced today and require zero external calls.

## 1 and 10 Gbit shaping

The 1 and 10 Gbit cases are part of every report. Linux `tc` shaping remains
opt-in because choosing a host interface incorrectly can affect unrelated
traffic: without a dedicated device each case is recorded as skipped. Give the
harness a dedicated benchmark veth and run:

```sh
sudo BENCH_TC_DEVICE=veth-bench bench/run.sh
```

Each mode runs an 8 MiB media pass-through under a token-bucket qdisc and the
trap removes it. If `tc`, root, or `BENCH_TC_DEVICE` is missing, the JSONL report
contains an explicit skipped row. macOS `dnctl` is deliberately not changed
automatically because its global pipe/firewall rules are not isolated to this
run.
Set `BANDWIDTH_MODES=` to omit shaping cases entirely, or provide a
comma-separated replacement list.

## Lightweight validation

`bench/test.sh` checks shell/Python syntax, fixture sizes, the load-result and
gate contracts (including expected rejection), the deterministic upstream, and
the process probe without requiring a container engine. It is suitable for CI;
the full enforced soak remains an explicit capacity job.
