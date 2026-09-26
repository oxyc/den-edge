#!/usr/bin/env python3
"""Small dependency-free HTTP load driver, including cancellation and slow readers."""

import argparse
import collections
import http.client
import json
import math
import pathlib
import socket
import threading
import time
import urllib.parse


def percentile(values, p):
    if not values:
        return 0.0
    values = sorted(values)
    return values[min(len(values) - 1, math.ceil(len(values) * p) - 1)]


def raw_request(parsed, path, headers, mode, slow_read_ms):
    sock = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=5)
    request = [f"GET {path} HTTP/1.1", f"Host: {parsed.netloc}", "Connection: close"]
    request.extend(f"{key}: {value}" for key, value in headers)
    sock.sendall(("\r\n".join(request) + "\r\n\r\n").encode())
    if mode == "cancel":
        sock.close()
        return 0, 0
    body = bytearray()
    while True:
        block = sock.recv(65536)
        if not block:
            break
        body.extend(block)
        time.sleep(slow_read_ms / 1000)
    sock.close()
    head, _, payload = body.partition(b"\r\n\r\n")
    status = int(head.split(None, 2)[1]) if head else 0
    return status, len(payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--duration", type=float, default=10)
    parser.add_argument("--requests", type=int, help="stop after this many claimed requests, for a cold one-pass set")
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--header", action="append", default=[])
    parser.add_argument("--paths-file")
    parser.add_argument("--mode", choices=("normal", "cancel", "slow-reader"), default="normal")
    parser.add_argument("--slow-read-ms", type=float, default=25)
    parser.add_argument("--rotate-ip", action="store_true", help="model independent callers behind the trusted test proxy")
    args = parser.parse_args()

    parsed = urllib.parse.urlsplit(args.url)
    base_path = parsed.path + (("?" + parsed.query) if parsed.query else "")
    paths = [line.strip() for line in pathlib.Path(args.paths_file).read_text().splitlines() if line.strip()] if args.paths_file else [base_path]
    headers = [item.split(":", 1) for item in args.header]
    deadline = time.monotonic() + args.duration
    lock = threading.Lock()
    latencies = []
    statuses = collections.Counter()
    tmdb_outcomes = collections.Counter()
    payload_bytes = 0
    errors = 0
    sequence = 0

    def worker():
        nonlocal payload_bytes, errors, sequence
        connection = None
        while time.monotonic() < deadline:
            with lock:
                if args.requests is not None and sequence >= args.requests:
                    return
                path = paths[sequence % len(paths)]
                sequence += 1
            started = time.perf_counter()
            try:
                request_headers = list(headers)
                if args.rotate_ip:
                    request_headers.append(("x-forwarded-for", f"198.18.{(sequence // 250) % 254}.{sequence % 250 + 1}"))
                if args.mode == "normal":
                    if connection is None:
                        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=10)
                    connection.request("GET", path, headers=dict(request_headers))
                    response = connection.getresponse()
                    body = response.read()
                    status, size = response.status, len(body)
                    tmdb_outcome = response.getheader("x-den-tmdb")
                else:
                    status, size = raw_request(parsed, path, request_headers, args.mode, args.slow_read_ms)
                    tmdb_outcome = None
                elapsed = time.perf_counter() - started
                with lock:
                    statuses[status] += 1
                    if tmdb_outcome:
                        tmdb_outcomes[tmdb_outcome] += 1
                    payload_bytes += size
                    latencies.append(elapsed)
            except (OSError, http.client.HTTPException):
                connection = None
                with lock:
                    errors += 1

    began = time.monotonic()
    threads = [threading.Thread(target=worker) for _ in range(args.concurrency)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    elapsed = time.monotonic() - began
    completed = len(latencies)
    result = {
        "elapsed_s": round(elapsed, 3),
        "requests": completed,
        "req_s": round(completed / elapsed, 2),
        "payload_bytes": payload_bytes,
        "gib_s": round(payload_bytes / elapsed / (1024**3), 6),
        "p50_ms": round(percentile(latencies, 0.50) * 1000, 3),
        "p95_ms": round(percentile(latencies, 0.95) * 1000, 3),
        "p99_ms": round(percentile(latencies, 0.99) * 1000, 3),
        "statuses": dict(sorted(statuses.items())),
        "tmdb_outcomes": dict(sorted(tmdb_outcomes.items())),
        "errors": errors,
        "mode": args.mode,
        "concurrency": args.concurrency,
    }
    histogram = collections.Counter(min(60_000, int(value * 1000)) for value in latencies)
    result["_latency_histogram_ms"] = dict(sorted(histogram.items()))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
