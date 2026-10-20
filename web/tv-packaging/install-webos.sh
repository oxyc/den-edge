#!/bin/sh
# Pair, install, and launch the release-built Den TV launcher on one LG TV.
set -eu

tv_ip=${1:-}
device=${2:-den-lg}
if [ -z "$tv_ip" ]; then
    echo "usage: ./install.sh TV_IP [DEVICE_NAME]" >&2
    exit 2
fi
command -v npm >/dev/null 2>&1 || {
    echo "npm is missing; install Node.js 24 or newer first" >&2
    exit 1
}

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ipk="$root/den-tv-webos.ipk"
[ -f "$ipk" ] || { echo "release package is missing: $ipk" >&2; exit 1; }

ares() {
    command_name=$1
    shift
    if command -v "$command_name" >/dev/null 2>&1; then
        "$command_name" "$@"
    else
        npx --yes --package=@webos-tools/cli@3.2.6 -- "$command_name" "$@"
    fi
}

if ares ares-setup-device --list \
    | awk -v target="$device" 'NR > 2 && $1 == target { found = 1 } END { exit !found }'; then
    ares ares-setup-device --modify "$device" \
        --info "host=$tv_ip" --info "port=9922" --info "username=prisoner"
else
    ares ares-setup-device --add "$device" \
        --info "host=$tv_ip" --info "port=9922" --info "username=prisoner"
fi

echo "Enter the six-character passphrase shown by the LG Developer Mode app."
ares ares-novacom --device "$device" --getkey
ares ares-install --device "$device" "$ipk"
ares ares-launch --device "$device" com.den.edge.tv
echo "Den TV is installed and running on $device."
