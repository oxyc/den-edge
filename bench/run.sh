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

for tool in python3 curl awk wc; do
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
UPSTREAM_PORT=${UPSTREAM_PORT:-19090}
BANDWIDTH_MODES=${BANDWIDTH_MODES-1gbit,10gbit}
RUN_ID="den-edge-bench-$$"
EDGE="$RUN_ID-edge"
UPSTREAM="$RUN_ID-upstream"
NETWORK="$RUN_ID-net"
EDGE_IMAGE="den-edge-bench:$RUN_ID"
UPSTREAM_IMAGE="den-edge-upstream:$RUN_ID"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/den-edge-bench.XXXXXX")
# Podman resolves bind sources through this parent as the container's unprivileged
# uid. `mktemp -d` creates it as 0700, so otherwise correctly world-accessible
# fixture/runtime children are still unreachable on a rootful Podman host.
chmod 755 "$RUN_DIR"
RESULTS=${RESULTS:-$ROOT/bench/results}
mkdir -p "$RESULTS"
REPORT_NAME="$(date -u +%Y%m%dT%H%M%SZ)-$$.jsonl"
REPORT_FINAL="$RESULTS/$REPORT_NAME"
# Hidden until every case and the terminal record pass. Failed partial rows
# move with the other artifacts instead of resembling a complete report.
REPORT="$RESULTS/.$REPORT_NAME.partial"
REPORT_PUBLISHED=0

TC_APPLIED=0
CHILD_PIDS=""
forget_child() {
  forgotten=$1
  remaining=""
  for child in $CHILD_PIDS; do
    if [ "$child" != "$forgotten" ]; then remaining="$remaining $child"; fi
  done
  CHILD_PIDS=$remaining
}
cleanup() {
  exit_code=$?
  if [ "$TC_APPLIED" = 1 ]; then
    tc qdisc del dev "$BENCH_TC_DEVICE" root >/dev/null 2>&1 || true
  fi
  for pid in $CHILD_PIDS; do kill "$pid" >/dev/null 2>&1 || true; done
  for pid in $CHILD_PIDS; do wait "$pid" >/dev/null 2>&1 || true; done
  "$ENGINE" rm -f "$EDGE" "$UPSTREAM" >/dev/null 2>&1 || true
  "$ENGINE" network rm "$NETWORK" >/dev/null 2>&1 || true
  "$ENGINE" image rm -f "$EDGE_IMAGE" "$UPSTREAM_IMAGE" >/dev/null 2>&1 || true
  if [ "$exit_code" -ne 0 ] && [ -f "$REPORT" ] && [ -d "$RUN_DIR" ]; then
    mv "$REPORT" "$RUN_DIR/report.partial.jsonl" || true
  elif [ "$REPORT_PUBLISHED" != 1 ]; then
    rm -f "$REPORT"
  fi
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

FIXTURES="$RUN_DIR/fixtures"
python3 "$ROOT/bench/fixtures.py" "$FIXTURES"
mkdir -p "$RUN_DIR/runtime-data" "$RUN_DIR/runtime-web"
chmod 777 "$RUN_DIR/runtime-data" "$RUN_DIR/runtime-web"
"$ENGINE" build --target edge -f "$ROOT/bench/Dockerfile" -t "$EDGE_IMAGE" "$ROOT"
"$ENGINE" build --target upstream -f "$ROOT/bench/Dockerfile" -t "$UPSTREAM_IMAGE" "$ROOT"
"$ENGINE" network create "$NETWORK" >/dev/null
if ! GATEWAY=$("$ENGINE" network inspect "$NETWORK" | python3 "$ROOT/bench/network_gateway.py"); then
  echo "ERROR: cannot determine benchmark bridge gateway; trusted caller rotation would be invalid" >&2
  exit 1
fi
VOLUME_RELABEL=""
if [ "$(basename "$ENGINE")" = podman ] \
  && [ -r /sys/fs/selinux/enforce ] \
  && [ "$(cat /sys/fs/selinux/enforce)" = 1 ]; then
  VOLUME_RELABEL=",Z"
fi
"$ENGINE" run -d --name "$UPSTREAM" --network "$NETWORK" --network-alias upstream \
  -p "127.0.0.1:$UPSTREAM_PORT:9090" "$UPSTREAM_IMAGE" >/dev/null
"$ENGINE" run -d --name "$EDGE" --network "$NETWORK" \
  --memory 64m --memory-swap 64m --pids-limit 256 \
  -p "127.0.0.1:$PORT:8080" \
  -v "$FIXTURES:/fixtures:ro$VOLUME_RELABEL" \
  -v "$RUN_DIR/runtime-data:/data$VOLUME_RELABEL" -v "$RUN_DIR/runtime-web:/web$VOLUME_RELABEL" \
  -e ADDON_RELAY=/fixture=http://upstream:9090,/reel=http://upstream:9090 \
  ${GATEWAY:+-e TRUSTED_PROXIES="$GATEWAY"} \
  -e DATA_DIR=/data -e WEB_DIR=/web -e PORT=8080 -e LOG_REQUESTS=0 \
  -e TMDB_KEY=benchmark-never-sent-on-seeded-hits \
  "$EDGE_IMAGE" >/dev/null

BASE="http://127.0.0.1:$PORT"
for ((attempt = 0; attempt < 100; attempt++)); do
  if curl -fsS "$BASE/health" >/dev/null; then break; fi
  sleep 0.1
done
curl -fsS "$BASE/health" >/dev/null || { "$ENGINE" logs "$EDGE"; exit 1; }

RUN_BASELINE="$RUN_DIR/initial.probe"
probe() {
  "$ENGINE" exec "$EDGE" /probe
}
probe >"$RUN_BASELINE"

STATIC_ETAG=$(curl -fsSI "$BASE/static-1m.bin" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
CACHE_ETAG=$(curl -fsSI "$BASE/ratings/imdb/tt0137523" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
MEMBER="0000000000000001:bench-token"
COMMON_HEADER="x-den-library-member: $MEMBER"
# Warm both exact representations before the named hot cases.
curl -fsS -H 'x-den-library-token: bench-token' "$BASE/lib/0000000000000001/changes?since=0&limit=500" >/dev/null
STATIC_SIZE=$(wc -c <"$FIXTURES/web/static-1m.bin" | tr -d ' ')
RATINGS_SIZE=$(wc -c <"$FIXTURES/data/ratings/tt0137523.json" | tr -d ' ')
CONTROL_SIZE=$(curl -fsS "$BASE/health" | wc -c | tr -d ' ')
LIBRARY_SIZE=$(curl -fsS -H 'x-den-library-token: bench-token' "$BASE/lib/0000000000000001/changes?since=0&limit=500" | wc -c | tr -d ' ')
COLD_LIBRARY_SIZE=$(curl -fsS -H 'x-den-library-token: bench-token' "$BASE/lib/0000000000000162/changes?since=0&limit=500" | wc -c | tr -d ' ')
TMDB_MIXED_SIZE=$(curl -fsS "$BASE/tmdb/3/movie/1064/credits" | wc -c | tr -d ' ')
probe >"$RUN_BASELINE"
python3 "$ROOT/bench/gate.py" initial --probe "$RUN_BASELINE"

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
    if python3 "$ROOT/bench/gate.py" recovered --before "$baseline" --after "$recovered" >/dev/null 2>&1 \
      && python3 "$ROOT/bench/gate.py" recovered --before "$RUN_BASELINE" --after "$recovered" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  python3 "$ROOT/bench/gate.py" recovered --before "$baseline" --after "$recovered"
  python3 "$ROOT/bench/gate.py" recovered --before "$RUN_BASELINE" --after "$recovered"
}

upstream_stats() {
  curl -fsS --max-time 2 "http://127.0.0.1:$UPSTREAM_PORT/stats"
}

run_case() {
  name=$1; allowed=$2; required=$3; shift 3
  before="$RUN_DIR/$name.before"
  after="$RUN_DIR/$name.after"
  recovered="$RUN_DIR/$name.recovered"
  probe >"$before"
  upstream_before="$RUN_DIR/$name.upstream.before"
  upstream_after="$RUN_DIR/$name.upstream.after"
  if [ "$name" = cancellation ]; then upstream_stats >"$upstream_before"; fi
  sample="$RUN_DIR/$name.samples"
  : >"$sample"
  cat "$before" >>"$sample"; printf '%s\n' --- >>"$sample"
  output="$RUN_DIR/$name.json"
  python3 "$ROOT/bench/load.py" "$@" >"$output" &
  load_pid=$!
  CHILD_PIDS="$CHILD_PIDS $load_pid"
  while kill -0 "$load_pid" 2>/dev/null; do
    probe >>"$sample"
    printf '%s\n' --- >>"$sample"
    sleep 0.2
  done
  wait "$load_pid"
  forget_child "$load_pid"
  probe >"$after"
  cat "$after" >>"$sample"; printf '%s\n' --- >>"$sample"
  wait_health
  wait_recovery "$before" "$recovered"
  gate_args=" --assert-recovery"
  case "$name" in tmdb-*) gate_args="$gate_args --tmdb-hit" ;; esac
  if [ "$name" = cancellation ]; then
    upstream_stats >"$upstream_after"
    gate_args="$gate_args --assert-cancellation --upstream-before $upstream_before --upstream-after $upstream_after"
  fi
  case "$name" in
    relay-slow-downstream-slow-reader-overload)
      gate_args="$gate_args --allowed-refusals 503:media_busy,503:server_busy"
      ;;
  esac
  # gate_args is restricted to fixed harness flags, not user input.
  # shellcheck disable=SC2086
  python3 "$ROOT/bench/gate.py" case --name "$name" --result "$output" --samples "$sample" \
    --before "$before" --after "$after" --recovered "$recovered" \
    --allowed "$allowed" --required "$required" $gate_args | tee -a "$REPORT"
}

normal() {
  name=$1; path=$2; concurrency=${3:-$CONCURRENCY}; header=${4:-}; rotate=${5:-}; expected=${6:-200}
  if [ "$#" -gt 6 ]; then shift 6; else set --; fi
  if [ -n "$header" ] && [ -n "$rotate" ]; then
    run_case "$name" "$expected" "$expected" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --header "$header" --rotate-ip "$@"
  elif [ -n "$header" ]; then
    run_case "$name" "$expected" "$expected" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --header "$header" "$@"
  elif [ -n "$rotate" ]; then
    run_case "$name" "$expected" "$expected" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" --rotate-ip "$@"
  else
    run_case "$name" "$expected" "$expected" --url "$BASE$path" --duration "$DURATION" --concurrency "$concurrency" "$@"
  fi
}

normal control-json /health "$CONCURRENCY" '' '' 200 --expect-200-bytes "$CONTROL_SIZE"
normal static-200 /static-1m.bin "$CONCURRENCY" '' '' 200 --expect-200-bytes "$STATIC_SIZE"
normal static-304 /static-1m.bin "$CONCURRENCY" "If-None-Match: $STATIC_ETAG" '' 304 --expect-304-bytes 0
normal canonical-cache-200 /ratings/imdb/tt0137523 8 '' rotate 200 \
  --rotate-ip-pool 5000 --expect-200-bytes "$RATINGS_SIZE"
normal canonical-cache-304 /ratings/imdb/tt0137523 "$CONCURRENCY" "If-None-Match: $CACHE_ETAG" rotate 304 \
  --rotate-ip-pool 5000 --expect-304-bytes 0
normal relay-fast '/fixture/fast?bytes=262144' "$CONCURRENCY" "$COMMON_HEADER" rotate 200 --expect-200-bytes 262144
normal relay-slow-upstream '/fixture/slow?bytes=262144&chunk=16384&delay_ms=5' "$CONCURRENCY" "$COMMON_HEADER" rotate 200 --expect-200-bytes 262144
normal library-exact-hot '/lib/0000000000000001/changes?since=0&limit=500' 8 'x-den-library-token: bench-token' '' 200 --expect-200-bytes "$LIBRARY_SIZE"
run_case library-cold-unique 200 200 --url "$BASE/" --paths-file "$FIXTURES/library-cold.paths" \
  --duration 60 --requests 160 --concurrency 2 --header 'x-den-library-token: bench-token' --expect-200-bytes "$COLD_LIBRARY_SIZE"
normal media-pass-through '/reel/progressive/bench.mp4?bytes=2097152' 8 "$COMMON_HEADER" rotate 200 --expect-200-bytes 2097152

# TMDB is the dominant cached provider. These are all guaranteed disk hits and
# therefore carry external_call_count=0; no provider key leaves this container.
TMDB_LIST_SIZE=$(curl -fsS "$BASE/tmdb/3/trending/all/week" | wc -c | tr -d ' ')
normal tmdb-list-hit-200 '/tmdb/3/trending/all/week' 8 '' '' 200 --expect-200-bytes "$TMDB_LIST_SIZE"
TMDB_LIST_ETAG=$(curl -fsSI "$BASE/tmdb/3/trending/all/week" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
normal tmdb-list-hit-304 '/tmdb/3/trending/all/week' "$CONCURRENCY" "If-None-Match: $TMDB_LIST_ETAG" '' 304 --expect-304-bytes 0
TMDB_SEARCH_SIZE=$(curl -fsS "$BASE/tmdb/3/search/multi?language=en-US&query=matrix" | wc -c | tr -d ' ')
normal tmdb-search-hit-200 '/tmdb/3/search/multi?language=en-US&query=matrix' 8 '' '' 200 --expect-200-bytes "$TMDB_SEARCH_SIZE"
TMDB_SEARCH_ETAG=$(curl -fsSI "$BASE/tmdb/3/search/multi?language=en-US&query=matrix" | awk -F': ' 'tolower($1)=="etag" {gsub("\r", "", $2); print $2; exit}')
normal tmdb-search-hit-304 '/tmdb/3/search/multi?language=en-US&query=matrix' "$CONCURRENCY" "If-None-Match: $TMDB_SEARCH_ETAG" '' 304 --expect-304-bytes 0
TMDB_ALL='credits,external_ids,recommendations,release_dates,videos,watch/providers'
TMDB_WHOLE_SIZE=$(curl -fsS "$BASE/tmdb/3/movie/550?append_to_response=$TMDB_ALL" | wc -c | tr -d ' ')
normal tmdb-detail-whole-exact "/tmdb/3/movie/550?append_to_response=$TMDB_ALL" 8 '' '' 200 --expect-200-bytes "$TMDB_WHOLE_SIZE"
run_case tmdb-detail-narrow-first 200 200 --url "$BASE/tmdb/3/movie/550?append_to_response=credits" \
  --duration 60 --requests 1 --concurrency 1 --min-200-bytes 1000
TMDB_NARROW_SIZE=$(curl -fsS "$BASE/tmdb/3/movie/550?append_to_response=credits" | wc -c | tr -d ' ')
normal tmdb-detail-narrow-repeat '/tmdb/3/movie/550?append_to_response=credits' 8 '' '' 200 --expect-200-bytes "$TMDB_NARROW_SIZE"
normal tmdb-concurrent-same-key '/tmdb/3/trending/all/week' 32 '' '' 200 --expect-200-bytes "$TMDB_LIST_SIZE"
run_case tmdb-concurrent-mixed-key 200 200 --url "$BASE/" --paths-file "$FIXTURES/tmdb-mixed.paths" \
  --duration 60 --requests 640 --concurrency 32 --expect-200-bytes "$TMDB_MIXED_SIZE"
# The application currently hardcodes TMDB's public TLS origin. A deterministic
# stale/revalidation workload cannot count calls without a provider secret or
# an injectable origin, so record the acceptance-gate gap rather than faking it.
echo '{"case":"tmdb-stale-revalidation","skipped":"TMDB origin is not injectable; deterministic external-call counting requires the next TMDB slice"}' | tee -a "$REPORT"
run_case cancellation 0 0 --url "$BASE/fixture/slow?cancel=1&bytes=8388608&chunk=16384&delay_ms=5" \
  --duration "$DURATION" --concurrency 32 --mode cancel --header "$COMMON_HEADER"
run_case relay-slow-downstream-slow-reader-overload 200,503 200 --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" \
  --duration "$DURATION" --concurrency 32 --mode slow-reader --slow-read-ms 20 --header "$COMMON_HEADER" --rotate-ip --expect-200-bytes 2097152

# A compact mixed soak: independent clients keep control, disk, cache, relay, library,
# media, cancellations and slow readers live together under the same 64 MiB ceiling.
mix_pids=""
mix() {
  label=$1; shift
  python3 "$ROOT/bench/load.py" --label "$label" "$@" >>"$RUN_DIR/mixed.parts" &
  mix_pids="$mix_pids $!"
  CHILD_PIDS="$CHILD_PIDS $!"
}
mix_before="$RUN_DIR/mixed.before"; probe >"$mix_before"
mix_upstream_before="$RUN_DIR/mixed.upstream.before"; upstream_stats >"$mix_upstream_before"
: >"$RUN_DIR/mixed.parts"
mix health --url "$BASE/health" --duration "$SOAK_DURATION" --concurrency 2 --expect-200-bytes "$CONTROL_SIZE"
mix static --url "$BASE/static-1m.bin" --duration "$SOAK_DURATION" --concurrency 2 --expect-200-bytes "$STATIC_SIZE"
mix ratings --url "$BASE/ratings/imdb/tt0137523" --duration "$SOAK_DURATION" --concurrency 2 --rotate-ip --expect-200-bytes "$RATINGS_SIZE"
mix tmdb-list --url "$BASE/tmdb/3/trending/all/week" --duration "$SOAK_DURATION" --concurrency 2 --expect-200-bytes "$TMDB_LIST_SIZE"
mix tmdb-detail --url "$BASE/tmdb/3/movie/550?append_to_response=credits" --duration "$SOAK_DURATION" --concurrency 2 --expect-200-bytes "$TMDB_NARROW_SIZE"
mix relay-fast --url "$BASE/fixture/fast?bytes=262144" --duration "$SOAK_DURATION" --concurrency 4 --header "$COMMON_HEADER" --rotate-ip --expect-200-bytes 262144
mix library --url "$BASE/lib/0000000000000001/changes?since=0&limit=500" --duration "$SOAK_DURATION" --concurrency 2 --header 'x-den-library-token: bench-token' --expect-200-bytes "$LIBRARY_SIZE"
python3 "$ROOT/bench/library_write.py" --url "$BASE" --duration "$SOAK_DURATION" --concurrency 4 >>"$RUN_DIR/mixed.parts" &
mix_pids="$mix_pids $!"; CHILD_PIDS="$CHILD_PIDS $!"
mix media --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" --duration "$SOAK_DURATION" --concurrency 4 --header "$COMMON_HEADER" --rotate-ip --expect-200-bytes 2097152
mix cancellation --url "$BASE/fixture/slow?cancel=1&bytes=8388608&delay_ms=5" --duration "$SOAK_DURATION" --concurrency 8 --mode cancel --header "$COMMON_HEADER" --rotate-ip
mix media-slow-reader --url "$BASE/reel/progressive/bench.mp4?bytes=2097152" --duration "$SOAK_DURATION" --concurrency 12 --mode slow-reader --slow-read-ms 20 --header "$COMMON_HEADER" --rotate-ip --expect-200-bytes 2097152
sample="$RUN_DIR/mixed.samples"
: >"$sample"; cat "$mix_before" >>"$sample"; printf '%s\n' --- >>"$sample"
for pid in $mix_pids; do
  while kill -0 "$pid" 2>/dev/null; do probe >>"$sample"; printf '%s\n' --- >>"$sample"; sleep 0.25; done
done
for pid in $mix_pids; do wait "$pid"; forget_child "$pid"; done
mix_after="$RUN_DIR/mixed.after"; probe >"$mix_after"
cat "$mix_after" >>"$sample"; printf '%s\n' --- >>"$sample"
wait_health
mix_recovered="$RUN_DIR/mixed.recovered"; wait_recovery "$mix_before" "$mix_recovered"
mix_upstream_after="$RUN_DIR/mixed.upstream.after"; upstream_stats >"$mix_upstream_after"
python3 "$ROOT/bench/summarize_mix.py" "$RUN_DIR/mixed.parts" "$sample" \
  "$mix_before" "$mix_after" "$mix_recovered" "$mix_upstream_before" "$mix_upstream_after" | tee -a "$REPORT"

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
      normal "media-shaped-$rate" '/reel/progressive/bench.mp4?bytes=8388608' 8 "$COMMON_HEADER" rotate 200 --expect-200-bytes 8388608
  done
  IFS=$old_ifs
  tc qdisc del dev "$BENCH_TC_DEVICE" root
  TC_APPLIED=0
fi

printf '{"run":"%s","gate":"passed","complete":true}\n' "$RUN_ID" >>"$REPORT"
mv "$REPORT" "$REPORT_FINAL"
REPORT_PUBLISHED=1
echo "report=$REPORT_FINAL"
