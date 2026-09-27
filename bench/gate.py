#!/usr/bin/env python3
"""Fail-closed assertions and report assembly for the 64 MiB soak gate."""

import argparse
import json
import pathlib
import sys


EVENT_KEYS = ("oom", "oom_kill", "oom_group_kill")
PROBE_KEYS = (
    "rss_bytes",
    "cgroup_current_bytes",
    "cgroup_events_available",
    "cgroup_events_oom",
    "cgroup_events_oom_kill",
    "cgroup_events_oom_group_kill",
    "fd_count",
    "upstream_established",
    "cpu_ticks",
)


class GateFailure(RuntimeError):
    pass


def read_probe(path):
    values = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            try:
                values[key] = int(value)
            except ValueError as error:
                raise GateFailure(f"{path}: non-numeric probe value {line!r}") from error
    missing = [key for key in PROBE_KEYS if key not in values]
    if missing:
        raise GateFailure(f"{path}: incomplete probe; missing {', '.join(missing)}")
    if values["cgroup_events_available"] != 1:
        raise GateFailure("cgroup v2 memory.events is unavailable; OOM enforcement cannot be proven")
    return values


def event_deltas(before, after):
    deltas = {}
    for event in EVENT_KEYS:
        key = f"cgroup_events_{event}"
        delta = after[key] - before[key]
        if delta < 0:
            raise GateFailure(f"{key} went backwards; the measured cgroup changed during the case")
        deltas[event] = delta
    changed = {key: value for key, value in deltas.items() if value}
    if changed:
        raise GateFailure(f"cgroup OOM counters increased: {changed}")
    return deltas


def validate_result(row, allowed, required, tmdb_hit=False):
    if row.get("errors") != 0:
        raise GateFailure(f"unexplained client failures: errors={row.get('errors')!r}")
    requests = row.get("requests", 0)
    if not isinstance(requests, int) or requests <= 0:
        raise GateFailure(f"case completed no requests: requests={requests!r}")
    statuses = {int(status): int(count) for status, count in row.get("statuses", {}).items()}
    if sum(statuses.values()) != requests:
        raise GateFailure(f"status counts {sum(statuses.values())} != completed requests {requests}")
    unexpected = sorted(set(statuses) - allowed)
    if unexpected:
        raise GateFailure(f"unexpected HTTP statuses {unexpected}; allowed={sorted(allowed)}")
    missing = sorted(status for status in required if statuses.get(status, 0) == 0)
    if missing:
        raise GateFailure(f"required statuses were not observed: {missing}")
    if tmdb_hit and row.get("tmdb_outcomes", {}).get("hit", 0) != requests:
        raise GateFailure("TMDB disk-hit case did not report x-den-tmdb: hit for every response")


def recovery_failures(before, after, rss_slack, cgroup_slack, fd_slack, upstream_slack):
    checks = (
        ("rss_bytes", rss_slack),
        ("cgroup_current_bytes", cgroup_slack),
        ("fd_count", fd_slack),
        ("upstream_established", upstream_slack),
    )
    return [
        f"{key}={after[key]} exceeds baseline={before[key]} + slack={slack}"
        for key, slack in checks
        if after[key] > before[key] + slack
    ]


def assert_recovered(args):
    before, after = read_probe(args.before), read_probe(args.after)
    failures = recovery_failures(
        before, after, args.rss_slack, args.cgroup_slack, args.fd_slack, args.upstream_slack
    )
    if failures:
        raise GateFailure("resources did not recover: " + "; ".join(failures))


def sample_peaks(path):
    peaks = {
        "rss_bytes": 0,
        "cgroup_current_bytes": 0,
        "fd_count": 0,
        "tcp_established": 0,
        "upstream_established": 0,
    }
    for line in pathlib.Path(path).read_text().splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in peaks:
            peaks[key] = max(peaks[key], int(value))
    return peaks


def report_case(args):
    before, after = read_probe(args.before), read_probe(args.after)
    recovered = read_probe(args.recovered)
    # The recovery snapshot closes the case. This also catches an OOM while
    # health/recovery checks run, not only one observed before the load ended.
    deltas = event_deltas(before, recovered)
    allowed = {int(value) for value in args.allowed.split(",")}
    required = {int(value) for value in args.required.split(",") if value}
    row = json.loads(pathlib.Path(args.result).read_text())
    validate_result(row, allowed, required, args.tmdb_hit)
    if args.assert_recovery:
        failures = recovery_failures(
            before, recovered, args.rss_slack, args.cgroup_slack, args.fd_slack, args.upstream_slack
        )
        if failures:
            raise GateFailure("resources did not recover: " + "; ".join(failures))
    peaks = sample_peaks(args.samples)
    elapsed = float(row["elapsed_s"])
    row.update(
        case=args.name,
        gate="passed",
        status_contract={"allowed": sorted(allowed), "required": sorted(required)},
        cpu_cores=round((after["cpu_ticks"] - before["cpu_ticks"]) / 100 / elapsed, 3),
        rss_peak_bytes=peaks["rss_bytes"],
        cgroup_current_peak_bytes=peaks["cgroup_current_bytes"],
        cgroup_peak_bytes=after.get("cgroup_peak_bytes", 0),
        fd_peak=peaks["fd_count"],
        tcp_established_peak=peaks["tcp_established"],
        upstream_sockets_peak=peaks["upstream_established"],
        cgroup_events_low=recovered.get("cgroup_events_low", 0),
        cgroup_events_high=recovered.get("cgroup_events_high", 0),
        cgroup_events_max=recovered.get("cgroup_events_max", 0),
        cgroup_events_oom=recovered["cgroup_events_oom"],
        cgroup_events_oom_kill=recovered["cgroup_events_oom_kill"],
        cgroup_events_oom_group_kill=recovered["cgroup_events_oom_group_kill"],
        cgroup_events_oom_delta=deltas["oom"],
        cgroup_events_oom_kill_delta=deltas["oom_kill"],
        cgroup_events_oom_group_kill_delta=deltas["oom_group_kill"],
        recovery={key: recovered[key] for key in ("rss_bytes", "cgroup_current_bytes", "fd_count", "upstream_established")},
        memory_limit_bytes=67108864,
        heap_allocations=None,
        heap_allocations_note="production binary exposes no allocator counter; RSS and cgroup memory are measured",
    )
    if args.tmdb_hit:
        row["external_call_count"] = 0
        row["external_call_basis"] = "every response reported x-den-tmdb: hit"
    row.pop("_latency_histogram_ms", None)
    print(json.dumps(row, separators=(",", ":")))


def add_recovery_args(parser):
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--rss-slack", type=int, default=8 * 1024 * 1024)
    parser.add_argument("--cgroup-slack", type=int, default=8 * 1024 * 1024)
    parser.add_argument("--fd-slack", type=int, default=2)
    parser.add_argument("--upstream-slack", type=int, default=0)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    recovery = commands.add_parser("recovered")
    add_recovery_args(recovery)
    case = commands.add_parser("case")
    add_recovery_args(case)
    case.add_argument("--name", required=True)
    case.add_argument("--result", required=True)
    case.add_argument("--samples", required=True)
    case.add_argument("--recovered", required=True)
    case.add_argument("--allowed", required=True)
    case.add_argument("--required", default="")
    case.add_argument("--assert-recovery", action="store_true")
    case.add_argument("--tmdb-hit", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "recovered":
            assert_recovered(args)
        else:
            report_case(args)
    except (GateFailure, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"GATE FAILURE: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
