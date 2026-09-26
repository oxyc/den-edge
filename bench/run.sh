#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENGINE=${CONTAINER_ENGINE:-}
if [ -z "$ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then ENGINE=podman
  else
    echo "SKIP: Docker or Podman is required for the enforced 64 MiB run" >&2
    exit 77
  fi
fi

for tool in python3 curl awk; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: required host tool $tool is unavailable" >&2
    exit 77
  fi
done

if ! "$ENGINE" info >/dev/null 2>&1; then
  echo "SKIP: $ENGINE is installed but its engine is unavailable" >&2
  exit 77
fi

DURATION=${DURATION:-10}
SOAK_DURATION=${SOAK_DURATION:-60}
CONCURRENCY=${CONCURRENCY:-16}
PORT=${PORT:-18080}
BANDWIDTH_MODES=${BANDWIDTH_MODES-1gbit,10gbit}
RUN_ID="den-edge-bench-$$"
EDGE="$RUN_ID-edge"
UPSTREAM="$RUN_ID-upstream"
NETWORK="$RUN_ID-net"
EDGE_IMAGE="den-edge-bench:$RUN_ID"
UPSTREAM_IMAGE="den-edge-upstream:$RUN_ID"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/den-edge-bench.XXXXXX")
RESULTS=${RESULTS:-$ROOT/bench/results}
mkdir -p "$RESULTS"
REPORT="$RESULTS/$(date -u +%Y%m%dT%H%M%SZ).jsonl"

TC_APPLIED=0
cleanup() {
  if [ "$TC_APPLIED" = 1 ]; then
    tc qdisc del dev "$BENCH_TC_DEVICE" root >/dev/null 2>&1 || true
  fi
  "$ENGINE" rm -f "$EDGE" "$UPSTREAM" >/dev/null 2>&1 || true
  "$ENGINE" network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT INT TERM

python3 "$ROOT/bench/fixtures.py" "$RUN_DIR"
"$ENGINE" build --target edge -f "$ROOT/bench/Dockerfile" -t "$EDGE_IMAGE" "$ROOT"
"$ENGINE" build --target upstream -f "$ROOT/bench/Dockerfile" -t "$UPSTREAM_IMAGE" "$ROOT"
"$ENGINE" network create "$NETWORK" >/dev/null
GATEWAY=$("$ENGINE" network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)
"$ENGINE" run -d --name "$UPSTREAM" --network "$NETWORK" --network-alias upstream "$UPSTREAM_IMAGE" >/dev/null
"$ENGINE" run -d --name "$EDGE" --network "$NETWORK" \
  --memory 64m --memory-swap 64m --pids-limit 256 \
  -p "127.0.0.1:$PORT:8080" \
  -v "$RUN_DIR/data:/data" -v "$RUN_DIR/web:/web:ro" \
  -e ADDON_RELAY=/fixture=http://upstream:9090,/reel=http://upstream:9090 \
  ${GATEWAY:+-e TRUSTED_PROXIES="$GATEWAY"} \
  -e DATA_DIR=/data -e WEB_DIR=/web -e PORT=8080 -e LOG_REQUESTS=0 \
  -e TMDB_KEY=benchmark-never-sent-on-seeded-hits \
  "$EDGE_IMAGE" >/dev/null

BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 100); do
  if curl -fsS "$BASE/health" >/dev/null; then break; fi
  sleep 0.1
done
curl -fsS "$BASE/health" >/dev/null || { "$ENGINE" logs "$EDGE"; exit 1; }

LIMIT=$("$ENGINE" inspect "$EDGE" --format '{{.HostConfig.Memory}}' 2>/dev/null || echo 0)
if [ "$LIMIT" != 67108864 ]; then
  echo "ERROR: requested 64 MiB but engine reports memory limit $LIMIT" >&2
  exit 1
fi

STATIC_ETAG=$(curl -fsSI "$BASE/static-1m.bin" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
CACHE_ETAG=$(curl -fsSI "$BASE/ratings/imdb/tt0137523" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
MEMBER="0000000000000001:bench-token"
COMMON_HEADER="x-den-library-member: $MEMBER"
# Warm both exact representations before the named hot cases.
curl -fsS -H 'x-den-library-token: bench-token' "$BASE/lib/0000000000000001/changes?since=0&limit=500" >/dev/null

probe() {
  "$ENGINE" exec "$EDGE" /probe 2>/dev/null || true
}

field() {
  printf '%s\n' "$1" | awk -F= -v key="$2" '$1==key {print $2; exit}'
}

run_case() {
  name=$1; shift
  before=$(probe)
  cpu_before=$(field "$before" cpu_ticks); cpu_before=${cpu_before:-0}
  sample="$RUN_DIR/$name.samples"
  output="$RUN_DIR/$name.json"
  python3 "$ROOT/bench/load.py" "$@" >"$output" &
  load_pid=$!
  while kill -0 "$load_pid" 2>/dev/null; do
    probe >>"$sample"
    printf '%s\n' --- >>"$sample"
    sleep 0.2
  done
  wait "$load_pid"
  after=$(probe)
  cpu_after=$(field "$after" cpu_ticks); cpu_after=${cpu_after:-0}
  elapsed=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["elapsed_s"])' "$output")
  cpu_cores=$(awk -v a="$cpu_before" -v b="$cpu_after" -v s="$elapsed" 'BEGIN {if (s>0) printf "%.3f", (b-a)/100/s; else print 0}')
  rss_peak=$(awk -F= '$1=="rss_bytes" && $2>m {m=$2} END {print m+0}' "$sample")
  current_peak=$(awk -F= '$1=="cgroup_current_bytes" && $2>m {m=$2} END {print m+0}' "$sample")
  fd_peak=$(awk -F= '$1=="fd_count" && $2>m {m=$2} END {print m+0}' "$sample")
  tcp_peak=$(awk -F= '$1=="tcp_established" && $2>m {m=$2} END {print m+0}' "$sample")
  sockets_peak=$(awk -F= '$1=="upstream_established" && $2>m {m=$2} END {print m+0}' "$sample")
  cgroup_peak=$(field "$after" cgroup_peak_bytes); cgroup_peak=${cgroup_peak:-0}
  oom=$(field "$after" cgroup_events_oom); oom=${oom:-0}
  oom_kill=$(field "$after" cgroup_events_oom_kill); oom_kill=${oom_kill:-0}
  event_low=$(field "$after" cgroup_events_low); event_low=${event_low:-0}
  event_high=$(field "$after" cgroup_events_high); event_high=${event_high:-0}
  event_max=$(field "$after" cgroup_events_max); event_max=${event_max:-0}
  oom_group=$(field "$after" cgroup_events_oom_group_kill); oom_group=${oom_group:-0}
  python3 - "$name" "$output" "$cpu_cores" "$rss_peak" "$current_peak" "$cgroup_peak" "$fd_peak" "$tcp_peak" "$sockets_peak" "$event_low" "$event_high" "$event_max" "$oom" "$oom_kill" "$oom_group" <<'PY' | tee -a "$REPORT"
import json, sys
name, source, cpu, rss, current, peak, fds, tcp, sockets, low, high, maximum, oom, killed, group = sys.argv[1:]
row = json.load(open(source))
row.update(case=name, cpu_cores=float(cpu), rss_peak_bytes=int(rss),
           cgroup_current_peak_bytes=int(current), cgroup_peak_bytes=int(peak),
           fd_peak=int(fds), tcp_established_peak=int(tcp), upstream_sockets_peak=int(sockets),
           cgroup_events_low=int(low), cgroup_events_high=int(high), cgroup_events_max=int(maximum),
           cgroup_events_oom=int(oom), cgroup_events_oom_kill=int(killed),
           cgroup_events_oom_group_kill=int(group), memory_limit_bytes=67108864)
if name.startswith("tmdb-"):
    hits = row.get("tmdb_outcomes", {}).get("hit", 0)
    if hits == row["requests"]:
        row["external_call_count"] = 0
        row["external_call_basis"] = "every response reported x-den-tmdb: hit"
    else:
        row["external_call_count"] = None
        row["external_call_basis"] = "not proven: not every response reported a cache hit"
row["heap_allocations"] = None
row["heap_allocations_note"] = "production binary exposes no allocator counter; RSS and cgroup memory are measured"
row.pop("_latency_histogram_ms", None)
print(json.dumps(row, separators=(",", ":")))
PY
}

normal() {
  name=$1; path=$2; concurrency=${3:-$CONCURRENCY}; header=${4:-}; rotate=${5:-}
  if [ -n "$header" ] && [ -n "$rotate" ]; then
    run_case "$name" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --header "$header" --rotate-ip
  elif [ -n "$header" ]; then
    run_case "$name" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --header "$header"
  elif [ -n "$rotate" ]; then
    run_case "$name" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --rotate-ip
  else
    run_case "$name" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency"
  fi
}

normal control-json /health
normal static-200 /static-1m.bin
normal static-304 /static-1m.bin "$CONCURRENCY" "If-None-Match: $STATIC_ETAG"
normal canonical-cache-200 /ratings/imdb/tt0137523 8 '' rotate
normal canonical-cache-304 /ratings/imdb/tt0137523 "$CONCURRENCY" "If-None-Match: $CACHE_ETAG" rotate
normal relay-fast '/fixture/fast?bytes=262144' "$CONCURRENCY" "$COMMON_HEADER" rotate
normal relay-slow-upstream '/fixture/slow?bytes=262144&chunk=16384&delay_ms=5' "$CONCURRENCY" "$COMMON_HEADER" rotate
normal library-exact-hot '/lib/0000000000000001/changes?since=0&limit=500' 8 'x-den-library-token: bench-token'
run_case library-cold-unique --url "$BASE/" --paths-file "$RUN_DIR/library-cold.paths" \
  --duration 60 --requests 160 --concurrency 2 --header 'x-den-library-token: bench-token'
normal media-pass-through '/reel/progressive/bench.mp4?bytes=2097152' 8 "$COMMON_HEADER" rotate

# TMDB is the dominant cached provider. These are all guaranteed disk hits and
# therefore carry external_call_count=0; no provider key leaves this container.
normal tmdb-list-hit-200 '/tmdb/3/trending/all/week' 8
TMDB_LIST_ETAG=$(curl -fsSI "$BASE/tmdb/3/trending/all/week" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
normal tmdb-list-hit-304 '/tmdb/3/trending/all/week' "$CONCURRENCY" "If-None-Match: $TMDB_LIST_ETAG"
normal tmdb-search-hit-200 '/tmdb/3/search/multi?language=en-US&query=matrix' 8
TMDB_SEARCH_ETAG=$(curl -fsSI "$BASE/tmdb/3/search/multi?language=en-US&query=matrix" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
normal tmdb-search-hit-304 '/tmdb/3/search/multi?language=en-US&query=matrix' "$CONCURRENCY" "If-None-Match: $TMDB_SEARCH_ETAG"
TMDB_ALL='credits,external_ids,recommendations,release_dates,videos,watch/providers'
normal tmdb-detail-whole-exact "/tmdb/3/movie/550?append_to_response=$TMDB_ALL" 8
run_case tmdb-detail-narrow-first --url "$BASE/tmdb/3/movie/550?append_to_response=credits" \
  --duration 60 --requests 1 --concurrency 1
normal tmdb-detail-narrow-repeat '/tmdb/3/movie/550?append_to_response=credits' 8
normal tmdb-concurrent-same-key '/tmdb/3/trending/all/week' 32
run_case tmdb-concurrent-mixed-key --url "$BASE/" --paths-file "$RUN_DIR/tmdb-mixed.paths" \
  --duration "$DURATION" --concurrency 32
# The application currently hardcodes TMDB's public TLS origin. A deterministic
# stale/revalidation workload cannot count calls without a provider secret or
# an injectable origin, so record the acceptance-gate gap rather than faking it.
echo '{"case":"tmdb-stale-revalidation","skipped":"TMDB origin is not injectable; deterministic external-call counting requires the next TMDB slice"}' | tee -a "$REPORT"
run_case cancellation --url "$BASE/fixture/slow?bytes=1048576&chunk=16384&delay_ms=5" \
  --duration "$DURATION" --concurrency 32 --mode cancel --header "$COMMON_HEADER"
run_case relay-slow-downstream-slow-reader-overload --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" \
  --duration "$DURATION" --concurrency 32 --mode slow-reader --slow-read-ms 20 --header "$COMMON_HEADER"

# A compact mixed soak: independent clients keep control, disk, cache, relay, library,
# media, cancellations and slow readers live together under the same 64 MiB ceiling.
mix_pids=""
mix() {
  python3 "$ROOT/bench/load.py" "$@" >>"$RUN_DIR/mixed.parts" &
  mix_pids="$mix_pids $!"
}
before=$(probe); cpu_before=$(field "$before" cpu_ticks); cpu_before=${cpu_before:-0}
mix --url "$BASE/health" --duration "$SOAK_DURATION" --concurrency 2
mix --url "$BASE/static-1m.bin" --duration "$SOAK_DURATION" --concurrency 2
mix --url "$BASE/ratings/imdb/tt0137523" --duration "$SOAK_DURATION" --concurrency 2 --rotate-ip
mix --url "$BASE/tmdb/3/trending/all/week" --duration "$SOAK_DURATION" --concurrency 2
mix --url "$BASE/tmdb/3/movie/550?append_to_response=credits" --duration "$SOAK_DURATION" --concurrency 2
mix --url "$BASE/fixture/fast?bytes=262144" --duration "$SOAK_DURATION" --concurrency 4 --header "$COMMON_HEADER" --rotate-ip
mix --url "$BASE/lib/0000000000000001/changes?since=0&limit=500" --duration "$SOAK_DURATION" --concurrency 2 --header 'x-den-library-token: bench-token'
mix --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" --duration "$SOAK_DURATION" --concurrency 4 --header "$COMMON_HEADER" --rotate-ip
mix --url "$BASE/fixture/slow?bytes=1048576&delay_ms=5" --duration "$SOAK_DURATION" --concurrency 8 --mode cancel --header "$COMMON_HEADER" --rotate-ip
mix --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" --duration "$SOAK_DURATION" --concurrency 12 --mode slow-reader --slow-read-ms 20 --header "$COMMON_HEADER"
sample="$RUN_DIR/mixed.samples"
for pid in $mix_pids; do
  while kill -0 "$pid" 2>/dev/null; do probe >>"$sample"; printf '%s\n' --- >>"$sample"; sleep 0.25; done
done
for pid in $mix_pids; do wait "$pid"; done
after=$(probe)
python3 "$ROOT/bench/summarize_mix.py" "$RUN_DIR/mixed.parts" "$sample" "$before" "$after" "$SOAK_DURATION" | tee -a "$REPORT"

shape_skips() {
  reason=$1
  old_ifs=$IFS; IFS=,
  for rate in $BANDWIDTH_MODES; do
    printf '{"case":"media-shaped-%s","skipped":"%s"}\n' "$rate" "$reason" | tee -a "$REPORT"
  done
  IFS=$old_ifs
}

if ! command -v tc >/dev/null 2>&1; then
  shape_skips 'tc is unavailable on the host'
elif [ -z "${BENCH_TC_DEVICE:-}" ]; then
  shape_skips 'set BENCH_TC_DEVICE to the dedicated benchmark veth'
elif [ "$(id -u)" != 0 ]; then
  shape_skips 'tc shaping requires root'
else
  old_ifs=$IFS; IFS=,
  for rate in $BANDWIDTH_MODES; do
      tc qdisc replace dev "$BENCH_TC_DEVICE" root tbf rate "$rate" burst 1mb latency 50ms
      TC_APPLIED=1
      normal "media-shaped-$rate" '/reel/progressive/bench.mp4?bytes=8388608' 8 "$COMMON_HEADER" rotate
  done
  IFS=$old_ifs
  tc qdisc del dev "$BENCH_TC_DEVICE" root
  TC_APPLIED=0
fi

echo "report=$REPORT"
