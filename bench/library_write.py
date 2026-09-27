#!/usr/bin/env python3
"""Concurrent durable library writers for the 64 MiB mixed gate."""

import argparse
import collections
import http.client
import json
import math
import threading
import time
import urllib.parse


parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--duration", type=float, required=True)
parser.add_argument("--concurrency", type=int, default=4)
parser.add_argument("--label", default="library-writes")
args = parser.parse_args()
parsed = urllib.parse.urlsplit(args.url)
deadline = time.monotonic() + args.duration
lock = threading.Lock()
latencies = []
statuses = collections.Counter()
requests = payload_bytes = errors = 0


def writer(number):
    global requests, payload_bytes, errors
    library_id = f"{0x300 + number:016x}"
    key = f"{1:016x}"
    base = 1  # fixtures contain the seed row; the first request also exercises lazy v2 migration.
    value_number = 0
    while time.monotonic() < deadline:
        value_number += 1
        body = json.dumps(
            {"writes": [{"k": key, "base": base, "v": f"writer-{number}-{value_number}"}]},
            separators=(",", ":"),
        ).encode()
        started = time.monotonic()
        try:
            connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=5)
            connection.request(
                "POST",
                f"/lib/{library_id}/batch",
                body,
                {"Content-Type": "application/json", "x-den-library-token": "bench-token"},
            )
            response = connection.getresponse()
            payload = response.read()
            connection.close()
            status = response.status
            if status == 200:
                decoded = json.loads(payload)
                applied = decoded.get("applied")
                if not isinstance(applied, list) or len(applied) != 1:
                    raise ValueError("write response has no single applied row")
                base = int(applied[0]["seq"])
            with lock:
                requests += 1
                payload_bytes += len(payload)
                statuses[status] += 1
                latencies.append((time.monotonic() - started) * 1000)
        except (OSError, ValueError, json.JSONDecodeError):
            with lock:
                errors += 1


threads = [threading.Thread(target=writer, args=(number,)) for number in range(args.concurrency)]
started = time.monotonic()
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
elapsed = time.monotonic() - started
histogram = collections.Counter(max(0, math.ceil(value)) for value in latencies)


def percentile(fraction):
    if not latencies:
        return 0.0
    ordered = sorted(latencies)
    return round(ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)], 3)


print(
    json.dumps(
        {
            "elapsed_s": round(elapsed, 3),
            "requests": requests,
            "req_s": round(requests / elapsed, 2),
            "payload_bytes": payload_bytes,
            "gib_s": round(payload_bytes / elapsed / 1024**3, 6),
            "p50_ms": percentile(0.50),
            "p95_ms": percentile(0.95),
            "p99_ms": percentile(0.99),
            "statuses": {str(status): count for status, count in statuses.items()},
            "errors": errors,
            "error_outcomes": {},
            "refusal_codes": {},
            "mode": "durable-writes",
            "concurrency": args.concurrency,
            "label": args.label,
            "_latency_histogram_ms": {str(millis): count for millis, count in histogram.items()},
        },
        separators=(",", ":"),
    )
)
