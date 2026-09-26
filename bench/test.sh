#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/den-edge-bench-test.XXXXXX")
UPSTREAM_PID=""
cleanup() {
  if [ -n "$UPSTREAM_PID" ]; then kill "$UPSTREAM_PID" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

bash -n "$ROOT/bench/run.sh"
python3 -m py_compile "$ROOT/bench/fixtures.py" "$ROOT/bench/load.py" "$ROOT/bench/summarize_mix.py"
python3 "$ROOT/bench/fixtures.py" "$TMP/fixtures"
test "$(wc -c < "$TMP/fixtures/web/static-1m.bin" | tr -d ' ')" = 1048576
test "$(wc -l < "$TMP/fixtures/library-cold.paths" | tr -d ' ')" = 160

rustc --edition=2021 "$ROOT/bench/upstream.rs" -o "$TMP/upstream"
PORT=19090 "$TMP/upstream" &
UPSTREAM_PID=$!
for _ in $(seq 1 20); do
  if curl -fsS 'http://127.0.0.1:19090/fast?bytes=16' >/dev/null 2>&1; then break; fi
  sleep 0.05
done
python3 "$ROOT/bench/load.py" --url 'http://127.0.0.1:19090/fast?bytes=1024' \
  --duration 0.2 --concurrency 2 >"$TMP/result.json"
python3 - "$TMP/result.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
assert row["requests"] > 0, row
assert row["payload_bytes"] >= row["requests"] * 1024, row
assert row["statuses"] == {"200": row["requests"]}, row
assert row["tmdb_outcomes"] == {}, row
assert row["p99_ms"] >= row["p50_ms"] >= 0, row
PY

rustc --edition=2021 "$ROOT/bench/probe.rs" -o "$TMP/probe"
"$TMP/probe" | grep -q '^cpu_ticks='
echo "bench harness self-test passed"
