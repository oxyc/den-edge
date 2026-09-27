#!/usr/bin/env python3
"""Print a bridge gateway from Docker or Podman network-inspect JSON."""

import json
import sys


def gateway(document):
    network = document[0]
    docker = network.get("IPAM", {}).get("Config", [])
    if docker and docker[0].get("Gateway"):
        return docker[0]["Gateway"]
    podman = network.get("subnets", network.get("Subnets", []))
    if podman:
        return podman[0].get("gateway", podman[0].get("Gateway", ""))
    return ""


if __name__ == "__main__":
    try:
        value = gateway(json.load(sys.stdin))
    except (IndexError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"invalid network inspect JSON: {error}", file=sys.stderr)
        raise SystemExit(1)
    if not value:
        raise SystemExit(1)
    print(value)
