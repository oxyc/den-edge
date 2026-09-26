#!/usr/bin/env python3
"""Combine independent mixed-soak clients and the service resource samples."""

import json
import pathlib
import sys

parts_path, samples_path, before_raw, after_raw, duration = sys.argv[1:]
parts = [json.loads(line) for line in pathlib.Path(parts_path).read_text().splitlines() if line]


def hist_percentile(parts, fraction):
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


def kv(text):
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


samples = []
current = {}
for line in pathlib.Path(samples_path).read_text().splitlines():
    if line == "---":
        samples.append(current)
        current = {}
    elif "=" in line:
        key, value = line.split("=", 1)
        current[key] = int(value)
before, after = kv(before_raw), kv(after_raw)
elapsed = max(float(part["elapsed_s"]) for part in parts)
requests = sum(part["requests"] for part in parts)
payload = sum(part["payload_bytes"] for part in parts)
statuses = {}
for part in parts:
    for status, count in part["statuses"].items():
        statuses[status] = statuses.get(status, 0) + count
row = {
    "case": "mixed-64m-soak",
    "elapsed_s": round(elapsed, 3),
    "requests": requests,
    "req_s": round(requests / elapsed, 2),
    "payload_bytes": payload,
    "gib_s": round(payload / elapsed / 1024**3, 6),
    "p50_ms": hist_percentile(parts, 0.50),
    "p95_ms": hist_percentile(parts, 0.95),
    "p99_ms": hist_percentile(parts, 0.99),
    "statuses": statuses,
    "errors": sum(part["errors"] for part in parts),
    "cpu_cores": round((int(after.get("cpu_ticks", 0)) - int(before.get("cpu_ticks", 0))) / 100 / elapsed, 3),
    "rss_peak_bytes": max((sample.get("rss_bytes", 0) for sample in samples), default=0),
    "cgroup_current_peak_bytes": max((sample.get("cgroup_current_bytes", 0) for sample in samples), default=0),
    "cgroup_peak_bytes": int(after.get("cgroup_peak_bytes", 0)),
    "fd_peak": max((sample.get("fd_count", 0) for sample in samples), default=0),
    "tcp_established_peak": max((sample.get("tcp_established", 0) for sample in samples), default=0),
    "upstream_sockets_peak": max((sample.get("upstream_established", 0) for sample in samples), default=0),
    "cgroup_events_low": int(after.get("cgroup_events_low", 0)),
    "cgroup_events_high": int(after.get("cgroup_events_high", 0)),
    "cgroup_events_max": int(after.get("cgroup_events_max", 0)),
    "cgroup_events_oom": int(after.get("cgroup_events_oom", 0)),
    "cgroup_events_oom_kill": int(after.get("cgroup_events_oom_kill", 0)),
    "cgroup_events_oom_group_kill": int(after.get("cgroup_events_oom_group_kill", 0)),
    "memory_limit_bytes": 67108864,
    "heap_allocations": None,
    "heap_allocations_note": "production binary exposes no allocator counter; RSS and cgroup memory are measured",
    "components": [{key: value for key, value in part.items() if key != "_latency_histogram_ms"} for part in parts],
}
print(json.dumps(row, separators=(",", ":")))
