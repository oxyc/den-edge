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


def refusal_code(payload):
    try:
        value = json.loads(payload)
        return value.get("error") if isinstance(value, dict) and isinstance(value.get("error"), str) else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def decode_chunked(payload):
    decoded = bytearray()
    rest = payload
    while True:
        line, separator, rest = rest.partition(b"\r\n")
        if not separator:
            raise OSError("truncated chunk header")
        try:
            size = int(line.split(b";", 1)[0], 16)
        except ValueError as error:
            raise OSError("invalid chunk header") from error
        if size == 0:
            # A zero chunk is followed by trailers (possibly none) and the
            # final CRLF. Reject extra bytes: Connection: close makes them an
            # ambiguous second response, not payload for this one.
            if rest == b"\r\n":
                return bytes(decoded)
            if rest.endswith(b"\r\n\r\n"):
                trailers = rest[:-4].split(b"\r\n")
                if trailers and all(line and b":" in line for line in trailers):
                    return bytes(decoded)
            raise OSError("truncated or malformed chunk trailer")
        if len(rest) < size + 2 or rest[size : size + 2] != b"\r\n":
            raise OSError(f"truncated chunk: declared={size} available={len(rest)}")
        decoded.extend(rest[:size])
        rest = rest[size + 2 :]


def framed_payload(status, fields, payload):
    length = fields.get(b"content-length")
    transfer = fields.get(b"transfer-encoding")
    if length is not None and transfer is not None:
        raise OSError("ambiguous response framing")
    if transfer is not None:
        if transfer.lower() != b"chunked":
            raise OSError(f"unsupported transfer-encoding: {transfer!r}")
        return decode_chunked(payload)
    if length is not None:
        try:
            declared = int(length)
        except ValueError as error:
            raise OSError("invalid Content-Length") from error
        if len(payload) != declared:
            raise OSError(f"truncated response: declared={declared} received={len(payload)}")
        return payload
    if status == 200:
        raise OSError("unframed 200 response")
    return payload


def raw_request(parsed, path, headers, mode, slow_read_ms, cancel_delay_ms):
    sock = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=5)
    request = [f"GET {path} HTTP/1.1", f"Host: {parsed.netloc}", "Connection: close"]
    request.extend(f"{key}: {value}" for key, value in headers)
    sock.sendall(("\r\n".join(request) + "\r\n\r\n").encode())
    if mode == "cancel":
        # Give the server a small, explicit window to accept and dispatch the
        # request, then disappear long before the slow 8 MiB answer can
        # complete. Without this, saturation can cancel every connection in
        # the accept queue and prove nothing about upstream cancellation.
        time.sleep(cancel_delay_ms / 1000)
        sock.close()
        return 0, 0, None
    body = bytearray()
    while True:
        block = sock.recv(65536)
        if not block:
            break
        body.extend(block)
        time.sleep(slow_read_ms / 1000)
    sock.close()
    head, _, payload = bytes(body).partition(b"\r\n\r\n")
    status = int(head.split(None, 2)[1]) if head else 0
    fields = {}
    for line in head.split(b"\r\n")[1:]:
        if b":" in line:
            name, value = line.split(b":", 1)
            name = name.strip().lower()
            if name in fields:
                raise OSError(f"duplicate response header: {name!r}")
            fields[name] = value.strip()
    payload = framed_payload(status, fields, payload)
    return status, len(payload), refusal_code(payload) if status >= 400 else None


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
    parser.add_argument("--cancel-delay-ms", type=float, default=5)
    parser.add_argument("--rotate-ip", action="store_true", help="model independent callers behind the trusted test proxy")
    parser.add_argument(
        "--rotate-ip-pool",
        type=int,
        default=512,
        help="bounded caller pool; route-specific overrides must leave headroom in den-edge's fixed throttle registry",
    )
    parser.add_argument("--rotate-ip-offset", type=int, default=0, help="first synthetic caller in the benchmark range")
    parser.add_argument("--label", help="stable component name for mixed-soak gate contracts")
    parser.add_argument("--expect-200-bytes", type=int)
    parser.add_argument("--min-200-bytes", type=int)
    parser.add_argument("--expect-304-bytes", type=int, default=0)
    args = parser.parse_args()
    synthetic_ips = 254 * 250
    if not 1 <= args.rotate_ip_pool <= synthetic_ips:
        parser.error(f"--rotate-ip-pool must be between 1 and {synthetic_ips}")
    if not 0 <= args.rotate_ip_offset <= synthetic_ips - args.rotate_ip_pool:
        parser.error("--rotate-ip-offset plus --rotate-ip-pool exceeds the benchmark address range")

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
    error_outcomes = collections.Counter()
    refusal_codes = collections.Counter()
    sequence = 0
    fatal = []

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
                    caller = args.rotate_ip_offset + (sequence - 1) % args.rotate_ip_pool
                    request_headers.append(("x-forwarded-for", f"198.18.{caller // 250}.{caller % 250 + 1}"))
                if args.mode == "normal":
                    if connection is None:
                        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=10)
                    connection.request("GET", path, headers=dict(request_headers))
                    response = connection.getresponse()
                    body = response.read()
                    status, size = response.status, len(body)
                    framing = {}
                    content_length = response.getheader("content-length")
                    transfer_encoding = response.getheader("transfer-encoding")
                    if content_length is not None and transfer_encoding is not None:
                        raise OSError("ambiguous response framing")
                    if content_length is not None:
                        framing[b"content-length"] = content_length.encode()
                    if transfer_encoding is not None:
                        # http.client has already decoded a chunked body, so
                        # its successful read is the terminator proof. Keep a
                        # sentinel length for the shared framing assertion.
                        if transfer_encoding.lower() != "chunked":
                            raise OSError("unsupported transfer-encoding")
                        framing[b"content-length"] = str(size).encode()
                    framed_payload(status, framing, body)
                    code = refusal_code(body) if status >= 400 else None
                    tmdb_outcome = response.getheader("x-den-tmdb")
                else:
                    status, size, code = raw_request(
                        parsed, path, request_headers, args.mode, args.slow_read_ms, args.cancel_delay_ms
                    )
                    tmdb_outcome = None
                if status == 200 and args.expect_200_bytes is not None and size != args.expect_200_bytes:
                    raise OSError(f"wrong 200 body size: expected={args.expect_200_bytes} received={size}")
                if status == 200 and args.min_200_bytes is not None and size < args.min_200_bytes:
                    raise OSError(f"short 200 body: minimum={args.min_200_bytes} received={size}")
                if status == 304 and size != args.expect_304_bytes:
                    raise OSError(f"wrong 304 body size: expected={args.expect_304_bytes} received={size}")
                elapsed = time.perf_counter() - started
                with lock:
                    statuses[status] += 1
                    if status >= 400:
                        refusal_codes[f"{status}:{code or 'missing'}"] += 1
                    if tmdb_outcome:
                        tmdb_outcomes[tmdb_outcome] += 1
                    payload_bytes += size
                    latencies.append(elapsed)
            except (OSError, http.client.HTTPException) as error:
                connection = None
                with lock:
                    errors += 1
                    detail = str(error) or str(getattr(error, "errno", None))
                    error_outcomes[f"{type(error).__name__}:{detail}"] += 1
            except Exception as error:
                with lock:
                    fatal.append(repr(error))
                return

    began = time.monotonic()
    threads = [
        threading.Thread(target=worker, daemon=args.requests is not None)
        for _ in range(args.concurrency)
    ]
    for thread in threads:
        thread.start()
    if args.requests is None:
        for thread in threads:
            thread.join()
    else:
        # The claim deadline is `duration`; one already-claimed HTTP exchange
        # gets its configured ten-second socket timeout to unwind. Daemon
        # workers make this a real process deadline rather than an unbounded
        # join if a client/library regression wedges despite that timeout.
        watchdog = deadline + 11
        for thread in threads:
            thread.join(max(0, watchdog - time.monotonic()))
        if any(thread.is_alive() for thread in threads):
            raise RuntimeError("request-count workload exceeded its hard watchdog")
    if fatal:
        raise RuntimeError(f"load worker failed unexpectedly: {fatal[0]}")
    elapsed = time.monotonic() - began
    if args.requests is not None and sequence != args.requests:
        raise RuntimeError(
            f"request-count workload missed its hard deadline: claimed={sequence} required={args.requests}"
        )
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
        "error_outcomes": dict(sorted(error_outcomes.items())),
        "refusal_codes": dict(sorted(refusal_codes.items())),
        "mode": args.mode,
        "concurrency": args.concurrency,
        "label": args.label,
    }
    histogram = collections.Counter(min(60_000, int(value * 1000)) for value in latencies)
    result["_latency_histogram_ms"] = dict(sorted(histogram.items()))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
