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
RECOVERY_TIMEOUT=${RECOVERY_TIMEOUT:-15}
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
  exit_code=$?
  if [ "$TC_APPLIED" = 1 ]; then
    tc qdisc del dev "$BENCH_TC_DEVICE" root >/dev/null 2>&1 || true
  fi
  "$ENGINE" rm -f "$EDGE" "$UPSTREAM" >/dev/null 2>&1 || true
  "$ENGINE" network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ "$exit_code" -ne 0 ] && [ -d "$RUN_DIR" ]; then
    failed="$RESULTS/failed-$(basename "$RUN_DIR")"
    if mv "$RUN_DIR" "$failed"; then
      echo "failure artifacts=$failed" >&2
    else
      echo "failure artifacts remain at $RUN_DIR" >&2
    fi
  else
    rm -rf "$RUN_DIR"
  fi
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
  "$ENGINE" exec "$EDGE" /probe
}

wait_health() {
  deadline=$((SECONDS + RECOVERY_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 1 "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "GATE FAILURE: post-case health did not recover within ${RECOVERY_TIMEOUT}s" >&2
  "$ENGINE" logs "$EDGE" >&2 || true
  return 1
}

wait_recovery() {
  baseline=$1; recovered=$2
  deadline=$((SECONDS + RECOVERY_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    probe >"$recovered"
    if python3 "$ROOT/bench/gate.py" recovered --before "$baseline" --after "$recovered" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  python3 "$ROOT/bench/gate.py" recovered --before "$baseline" --after "$recovered"
}

run_case() {
  name=$1; allowed=$2; required=$3; recovery=$4; shift 4
  before="$RUN_DIR/$name.before"
  after="$RUN_DIR/$name.after"
  recovered="$RUN_DIR/$name.recovered"
  probe >"$before"
  sample="$RUN_DIR/$name.samples"
  : >"$sample"
  cat "$before" >>"$sample"; printf '%s\n' --- >>"$sample"
  output="$RUN_DIR/$name.json"
  python3 "$ROOT/bench/load.py" "$@" >"$output" &
  load_pid=$!
  while kill -0 "$load_pid" 2>/dev/null; do
    probe >>"$sample"
    printf '%s\n' --- >>"$sample"
    sleep 0.2
  done
  wait "$load_pid"
  probe >"$after"
  cat "$after" >>"$sample"; printf '%s\n' --- >>"$sample"
  wait_health
  if [ "$recovery" = 1 ]; then
    wait_recovery "$before" "$recovered"
  else
    probe >"$recovered"
  fi
  gate_args=""
  if [ "$recovery" = 1 ]; then gate_args="$gate_args --assert-recovery"; fi
  case "$name" in tmdb-*) gate_args="$gate_args --tmdb-hit" ;; esac
  # gate_args is restricted to fixed harness flags, not user input.
  # shellcheck disable=SC2086
  python3 "$ROOT/bench/gate.py" case --name "$name" --result "$output" --samples "$sample" \
    --before "$before" --after "$after" --recovered "$recovered" \
    --allowed "$allowed" --required "$required" $gate_args | tee -a "$REPORT"
}

normal() {
  name=$1; path=$2; concurrency=${3:-$CONCURRENCY}; header=${4:-}; rotate=${5:-}; expected=${6:-200}
  if [ -n "$header" ] && [ -n "$rotate" ]; then
    run_case "$name" "$expected" "$expected" 0 --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --header "$header" --rotate-ip
  elif [ -n "$header" ]; then
    run_case "$name" "$expected" "$expected" 0 --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --header "$header"
  elif [ -n "$rotate" ]; then
    run_case "$name" "$expected" "$expected" 0 --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --rotate-ip
  else
    run_case "$name" "$expected" "$expected" 0 --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency"
  fi
}

normal control-json /health
normal static-200 /static-1m.bin
normal static-304 /static-1m.bin "$CONCURRENCY" "If-None-Match: $STATIC_ETAG" '' 304
normal canonical-cache-200 /ratings/imdb/tt0137523 8 '' rotate
normal canonical-cache-304 /ratings/imdb/tt0137523 "$CONCURRENCY" "If-None-Match: $CACHE_ETAG" rotate 304
normal relay-fast '/fixture/fast?bytes=262144' "$CONCURRENCY" "$COMMON_HEADER" rotate
normal relay-slow-upstream '/fixture/slow?bytes=262144&chunk=16384&delay_ms=5' "$CONCURRENCY" "$COMMON_HEADER" rotate
normal library-exact-hot '/lib/0000000000000001/changes?since=0&limit=500' 8 'x-den-library-token: bench-token'
run_case library-cold-unique 200 200 0 --url "$BASE/" --paths-file "$RUN_DIR/library-cold.paths" \
  --duration 60 --requests 160 --concurrency 2 --header 'x-den-library-token: bench-token'
normal media-pass-through '/reel/progressive/bench.mp4?bytes=2097152' 8 "$COMMON_HEADER" rotate

# TMDB is the dominant cached provider. These are all guaranteed disk hits and
# therefore carry external_call_count=0; no provider key leaves this container.
normal tmdb-list-hit-200 '/tmdb/3/trending/all/week' 8
TMDB_LIST_ETAG=$(curl -fsSI "$BASE/tmdb/3/trending/all/week" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
normal tmdb-list-hit-304 '/tmdb/3/trending/all/week' "$CONCURRENCY" "If-None-Match: $TMDB_LIST_ETAG" '' 304
normal tmdb-search-hit-200 '/tmdb/3/search/multi?language=en-US&query=matrix' 8
TMDB_SEARCH_ETAG=$(curl -fsSI "$BASE/tmdb/3/search/multi?language=en-US&query=matrix" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
normal tmdb-search-hit-304 '/tmdb/3/search/multi?language=en-US&query=matrix' "$CONCURRENCY" "If-None-Match: $TMDB_SEARCH_ETAG" '' 304
TMDB_ALL='credits,external_ids,recommendations,release_dates,videos,watch/providers'
normal tmdb-detail-whole-exact "/tmdb/3/movie/550?append_to_response=$TMDB_ALL" 8
run_case tmdb-detail-narrow-first 200 200 0 --url "$BASE/tmdb/3/movie/550?append_to_response=credits" \
  --duration 60 --requests 1 --concurrency 1
normal tmdb-detail-narrow-repeat '/tmdb/3/movie/550?append_to_response=credits' 8
normal tmdb-concurrent-same-key '/tmdb/3/trending/all/week' 32
run_case tmdb-concurrent-mixed-key 200 200 0 --url "$BASE/" --paths-file "$RUN_DIR/tmdb-mixed.paths" \
  --duration "$DURATION" --concurrency 32
# The application currently hardcodes TMDB's public TLS origin. A deterministic
# stale/revalidation workload cannot count calls without a provider secret or
# an injectable origin, so record the acceptance-gate gap rather than faking it.
echo '{"case":"tmdb-stale-revalidation","skipped":"TMDB origin is not injectable; deterministic external-call counting requires the next TMDB slice"}' | tee -a "$REPORT"
run_case cancellation 0 0 1 --url "$BASE/fixture/slow?bytes=1048576&chunk=16384&delay_ms=5" \
  --duration "$DURATION" --concurrency 32 --mode cancel --header "$COMMON_HEADER"
run_case relay-slow-downstream-slow-reader-overload 200,429,503 200 1 --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" \
  --duration "$DURATION" --concurrency 32 --mode slow-reader --slow-read-ms 20 --header "$COMMON_HEADER"

# A compact mixed soak: independent clients keep control, disk, cache, relay, library,
# media, cancellations and slow readers live together under the same 64 MiB ceiling.
mix_pids=""
mix() {
  label=$1; shift
  python3 "$ROOT/bench/load.py" --label "$label" "$@" >>"$RUN_DIR/mixed.parts" &
  mix_pids="$mix_pids $!"
}
mix_before="$RUN_DIR/mixed.before"; probe >"$mix_before"
: >"$RUN_DIR/mixed.parts"
mix health --url "$BASE/health" --duration "$SOAK_DURATION" --concurrency 2
mix static --url "$BASE/static-1m.bin" --duration "$SOAK_DURATION" --concurrency 2
mix ratings --url "$BASE/ratings/imdb/tt0137523" --duration "$SOAK_DURATION" --concurrency 2 --rotate-ip
mix tmdb-list --url "$BASE/tmdb/3/trending/all/week" --duration "$SOAK_DURATION" --concurrency 2
mix tmdb-detail --url "$BASE/tmdb/3/movie/550?append_to_response=credits" --duration "$SOAK_DURATION" --concurrency 2
mix relay-fast --url "$BASE/fixture/fast?bytes=262144" --duration "$SOAK_DURATION" --concurrency 4 --header "$COMMON_HEADER" --rotate-ip
mix library --url "$BASE/lib/0000000000000001/changes?since=0&limit=500" --duration "$SOAK_DURATION" --concurrency 2 --header 'x-den-library-token: bench-token'
mix media --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" --duration "$SOAK_DURATION" --concurrency 4 --header "$COMMON_HEADER" --rotate-ip
mix cancellation --url "$BASE/fixture/slow?bytes=1048576&delay_ms=5" --duration "$SOAK_DURATION" --concurrency 8 --mode cancel --header "$COMMON_HEADER" --rotate-ip
mix media-slow-reader --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" --duration "$SOAK_DURATION" --concurrency 12 --mode slow-reader --slow-read-ms 20 --header "$COMMON_HEADER"
sample="$RUN_DIR/mixed.samples"
: >"$sample"; cat "$mix_before" >>"$sample"; printf '%s\n' --- >>"$sample"
for pid in $mix_pids; do
  while kill -0 "$pid" 2>/dev/null; do probe >>"$sample"; printf '%s\n' --- >>"$sample"; sleep 0.25; done
done
for pid in $mix_pids; do wait "$pid"; done
mix_after="$RUN_DIR/mixed.after"; probe >"$mix_after"
cat "$mix_after" >>"$sample"; printf '%s\n' --- >>"$sample"
wait_health
mix_recovered="$RUN_DIR/mixed.recovered"; wait_recovery "$mix_before" "$mix_recovered"
python3 "$ROOT/bench/summarize_mix.py" "$RUN_DIR/mixed.parts" "$sample" \
  "$mix_before" "$mix_after" "$mix_recovered" | tee -a "$REPORT"

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
