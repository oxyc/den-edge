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
python3 -m py_compile "$ROOT/bench/fixtures.py" "$ROOT/bench/gate.py" "$ROOT/bench/load.py" \
  "$ROOT/bench/network_gateway.py" "$ROOT/bench/summarize_mix.py"
python3 "$ROOT/bench/fixtures.py" "$TMP/fixtures"
test "$(wc -c < "$TMP/fixtures/web/static-1m.bin" | tr -d ' ')" = 1048576
test "$(wc -l < "$TMP/fixtures/library-cold.paths" | tr -d ' ')" = 160

rustc --edition=2021 "$ROOT/bench/upstream.rs" -o "$TMP/upstream"
rustc --edition=2021 "$ROOT/bench/stage.rs" -o "$TMP/stage"
PORT=19090 "$TMP/upstream" &
UPSTREAM_PID=$!
for ((attempt = 0; attempt < 20; attempt++)); do
  if curl -fsS 'http://127.0.0.1:19090/fast?bytes=16' >/dev/null 2>&1; then break; fi
  sleep 0.05
done
python3 "$ROOT/bench/load.py" --url 'http://127.0.0.1:19090/fast?bytes=1024' \
  --duration 0.2 --concurrency 2 --expect-200-bytes 1024 >"$TMP/result.json"
curl -fsS 'http://127.0.0.1:19090/stats' >"$TMP/upstream-stats.json"
python3 - "$TMP/result.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
assert row["requests"] > 0, row
assert row["payload_bytes"] >= row["requests"] * 1024, row
assert row["statuses"] == {"200": row["requests"]}, row
assert row["tmdb_outcomes"] == {}, row
assert row["p99_ms"] >= row["p50_ms"] >= 0, row
PY
python3 - "$TMP/upstream-stats.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
assert {"accepted", "active", "completed", "aborted", "cancel_accepted", "cancel_active",
        "cancel_completed", "cancel_aborted"} == set(row), row
PY

python3 - "$ROOT" <<'PY'
import json, pathlib, socket, sys, tempfile, threading
sys.path.insert(0, sys.argv[1] + "/bench")
import gate
import load
import network_gateway

assert network_gateway.gateway([{"IPAM": {"Config": [{"Gateway": "172.20.0.1"}]}}]) == "172.20.0.1"
assert network_gateway.gateway([{"subnets": [{"gateway": "10.89.0.1"}]}]) == "10.89.0.1"
assert load.decode_chunked(b"3\r\nabc\r\n0\r\n\r\n") == b"abc"
try:
    load.decode_chunked(b"3\r\nabc\r\n0\r\n")
except OSError:
    pass
else:
    raise AssertionError("truncated chunk terminator unexpectedly passed")

probe = {
    "rss_bytes": 10, "cgroup_current_bytes": 20, "cgroup_events_available": 1,
    "cgroup_peak_bytes": 30,
    "cgroup_events_oom": 4, "cgroup_events_oom_kill": 2,
    "cgroup_events_oom_group_kill": 1, "fd_count": 5,
    "upstream_established": 0, "cpu_ticks": 100,
    "memory_max_bytes": 64 * 1024 * 1024, "memory_swap_max_bytes": 0,
}
gate.validate_result(
    {"requests": 2, "errors": 0, "statuses": {"200": 1, "503": 1},
     "refusal_codes": {"503:server_busy": 1}},
    {200, 503}, {200}, allowed_refusals={"503:server_busy"},
)
assert gate.event_deltas(probe, dict(probe)) == {"oom": 0, "oom_kill": 0, "oom_group_kill": 0}
assert gate.recovery_failures(probe, dict(probe), 0, 0, 0, 0) == []
gate.assert_initial({**probe, "cgroup_events_oom": 0, "cgroup_events_oom_kill": 0,
                     "cgroup_events_oom_group_kill": 0})
for operation in (
    lambda: gate.validate_result({"requests": 1, "errors": 0, "statuses": {"500": 1}}, {200}, {200}),
    lambda: gate.validate_result(
        {"requests": 1, "errors": 0, "statuses": {"503": 1},
         "refusal_codes": {"503:wrong_code": 1}},
        {503}, {503}, allowed_refusals={"503:server_busy"},
    ),
    lambda: gate.event_deltas(probe, {**probe, "cgroup_events_oom_kill": 3}),
    lambda: gate.assert_initial(probe),
):
    try:
        operation()
    except gate.GateFailure:
        pass
    else:
        raise AssertionError("negative gate contract unexpectedly passed")

before = {"cancel_accepted": 3, "cancel_active": 0, "cancel_completed": 2, "cancel_aborted": 1}
after = {"cancel_accepted": 4, "cancel_active": 0, "cancel_completed": 2, "cancel_aborted": 2}
with tempfile.TemporaryDirectory() as directory:
    before_path = pathlib.Path(directory) / "before.json"
    after_path = pathlib.Path(directory) / "after.json"
    before_path.write_text(json.dumps(before))
    after_path.write_text(json.dumps(after))
    gate.assert_cancellation(before_path, after_path)
    after_path.write_text(json.dumps({**after, "cancel_completed": 3}))
    try:
        gate.assert_cancellation(before_path, after_path)
    except gate.GateFailure:
        pass
    else:
        raise AssertionError("completed cancellation work unexpectedly passed")
    zero_path = pathlib.Path(directory) / "zero.probe"
    zero_path.write_text("\n".join(f"{key}={value}" for key, value in {
        **probe, "rss_bytes": 0, "cgroup_current_bytes": 0,
        "cgroup_peak_bytes": 0, "fd_count": 0,
        "cgroup_events_oom": 0, "cgroup_events_oom_kill": 0,
        "cgroup_events_oom_group_kill": 0,
    }.items()))
    try:
        gate.read_probe(zero_path)
    except gate.GateFailure:
        pass
    else:
        raise AssertionError("zero-valued probe unexpectedly passed")

# A slow-reader response that closes before its declared body length must be a
# client failure, never a successful 200 included in throughput.
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
port = listener.getsockname()[1]
def truncate():
    connection, _ = listener.accept()
    connection.recv(4096)
    connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc")
    connection.close()
    listener.close()
thread = threading.Thread(target=truncate)
thread.start()
try:
    load.raw_request(type("URL", (), {"hostname": "127.0.0.1", "port": port, "netloc": f"127.0.0.1:{port}"})(),
                     "/", [], "slow-reader", 0, 0)
except OSError as error:
    assert "truncated response" in str(error), error
else:
    raise AssertionError("truncated Content-Length unexpectedly passed")
thread.join()

# EOF framing cannot prove completeness. A nonempty 200 without Content-Length
# or a complete chunked terminator must fail closed too.
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
port = listener.getsockname()[1]
def unframed():
    connection, _ = listener.accept()
    connection.recv(4096)
    connection.sendall(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npartial")
    connection.close()
    listener.close()
thread = threading.Thread(target=unframed)
thread.start()
try:
    load.raw_request(type("URL", (), {"hostname": "127.0.0.1", "port": port, "netloc": f"127.0.0.1:{port}"})(),
                     "/", [], "slow-reader", 0, 0)
except OSError as error:
    assert "unframed" in str(error), error
else:
    raise AssertionError("unframed partial response unexpectedly passed")
thread.join()
PY

# A request-count workload has a deadline, but may never quietly turn its
# requested coverage into a smaller successful sample.
if python3 "$ROOT/bench/load.py" --url 'http://127.0.0.1:19090/fast?bytes=1024' \
  --duration 0 --requests 10 --concurrency 1 --expect-200-bytes 1024 >/dev/null 2>&1; then
  echo "request-count deadline unexpectedly passed" >&2
  exit 1
fi

rustc --edition=2021 "$ROOT/bench/probe.rs" -o "$TMP/probe"
echo "bench harness self-test passed"
