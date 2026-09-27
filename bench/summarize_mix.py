#!/usr/bin/env python3
"""Validate and combine independent clients in the mixed 64 MiB soak."""

import json
import pathlib
import sys

import gate

parts_path, samples_path, before_path, after_path, recovered_path, upstream_before, upstream_after = sys.argv[1:]
parts = [json.loads(line) for line in pathlib.Path(parts_path).read_text().splitlines() if line]


def hist_percentile(fraction):
    hist = {}
    for part in parts:
        for millis, count in part.get("_latency_histogram_ms", {}).items():
            hist[int(millis)] = hist.get(int(millis), 0) + count
    wanted = max(1, int(sum(hist.values()) * fraction + 0.999999))
    seen = 0
    for millis, count in sorted(hist.items()):
        seen += count
        if seen >= wanted:
            return float(millis)
    return 0.0


try:
    by_label = {part.get("label"): part for part in parts}
    expected_labels = {
        "health", "static", "ratings", "tmdb-list", "tmdb-detail", "relay-fast",
        "library", "media", "cancellation", "media-slow-reader",
    }
    if set(by_label) != expected_labels or len(parts) != len(expected_labels):
        raise gate.GateFailure(
            f"mixed component labels mismatch: got={sorted(str(key) for key in by_label)}"
        )
    for label, part in by_label.items():
        if label == "cancellation":
            gate.validate_result(part, {0}, {0})
        elif label in ("media", "media-slow-reader"):
            # Slow readers deliberately saturate the shared media budget, so
            # both media clients can see stable admission-control outcomes.
            # Control, cache, library and relay components may not.
            gate.validate_result(
                part,
                {200, 429, 503},
                {200},
                allowed_refusals={
                    "429:too_many_sources", "503:media_busy", "503:relay_busy", "503:server_busy"
                },
            )
        else:
            gate.validate_result(part, {200}, {200}, label.startswith("tmdb-"))
    before, after, recovered = (
        gate.read_probe(before_path), gate.read_probe(after_path), gate.read_probe(recovered_path)
    )
    deltas = gate.event_deltas(before, recovered)
    failures = gate.recovery_failures(before, recovered, 8 * 1024 * 1024, 8 * 1024 * 1024, 2, 0)
    if failures:
        raise gate.GateFailure("resources did not recover: " + "; ".join(failures))
    gate.assert_cancellation(upstream_before, upstream_after)
    peaks = gate.sample_peaks(samples_path)
except (gate.GateFailure, OSError, ValueError, json.JSONDecodeError) as error:
    print(f"GATE FAILURE: {error}", file=sys.stderr)
    raise SystemExit(1)

elapsed = max(float(part["elapsed_s"]) for part in parts)
requests = sum(part["requests"] for part in parts)
payload = sum(part["payload_bytes"] for part in parts)
statuses = {}
for part in parts:
    for status, count in part["statuses"].items():
        statuses[status] = statuses.get(status, 0) + count
row = {
    "case": "mixed-64m-soak", "gate": "passed", "elapsed_s": round(elapsed, 3),
    "requests": requests, "req_s": round(requests / elapsed, 2), "payload_bytes": payload,
    "gib_s": round(payload / elapsed / 1024**3, 6), "p50_ms": hist_percentile(0.50),
    "p95_ms": hist_percentile(0.95), "p99_ms": hist_percentile(0.99),
    "statuses": statuses, "errors": 0,
    "cpu_cores": round((after["cpu_ticks"] - before["cpu_ticks"]) / 100 / elapsed, 3),
    "rss_peak_bytes": peaks["rss_bytes"], "cgroup_current_peak_bytes": peaks["cgroup_current_bytes"],
    "cgroup_peak_bytes": after.get("cgroup_peak_bytes", 0), "fd_peak": peaks["fd_count"],
    "tcp_established_peak": peaks["tcp_established"],
    "upstream_sockets_peak": peaks["upstream_established"],
    "cgroup_events_low": recovered.get("cgroup_events_low", 0),
    "cgroup_events_high": recovered.get("cgroup_events_high", 0),
    "cgroup_events_max": recovered.get("cgroup_events_max", 0),
    "cgroup_events_oom": recovered["cgroup_events_oom"],
    "cgroup_events_oom_kill": recovered["cgroup_events_oom_kill"],
    "cgroup_events_oom_group_kill": recovered["cgroup_events_oom_group_kill"],
    "cgroup_events_oom_delta": deltas["oom"],
    "cgroup_events_oom_kill_delta": deltas["oom_kill"],
    "cgroup_events_oom_group_kill_delta": deltas["oom_group_kill"],
    "recovery": {key: recovered[key] for key in ("rss_bytes", "cgroup_current_bytes", "fd_count", "upstream_established")},
    "memory_limit_bytes": 67108864, "heap_allocations": None,
    "heap_allocations_note": "production binary exposes no allocator counter; RSS and cgroup memory are measured",
    "components": [{key: value for key, value in part.items() if key != "_latency_histogram_ms"} for part in parts],
}
print(json.dumps(row, separators=(",", ":")))
