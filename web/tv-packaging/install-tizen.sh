#!/bin/sh
# Sign the release-built Den TV widget for one Samsung TV, install it, and launch it.
set -eu

profile=${1:-}
serial=${2:-}
if [ -z "$profile" ] || [ -z "$serial" ]; then
    echo "usage: ./install.sh CERTIFICATE_PROFILE TV_SERIAL" >&2
    exit 2
fi
for command in tizen sdb; do
    command -v "$command" >/dev/null 2>&1 || {
        echo "$command is missing; install Tizen Studio's Web CLI and add its tools to PATH" >&2
        exit 1
    }
done

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app="$root/app"
signed=$(mktemp -d "${TMPDIR:-/tmp}/den-tv-tizen.XXXXXX")
trap 'rm -rf "$signed"' EXIT INT TERM

tizen install-permit -s "$serial"
tizen build-web -- "$app"
tizen package -t wgt -s "$profile" -o "$signed" -- "$app/.buildResult"
wgt=$(find "$signed" -type f -name '*.wgt' -print | head -n 1)
[ -n "$wgt" ] || { echo "Tizen did not produce a .wgt" >&2; exit 1; }
tizen install -s "$serial" --name "$(basename "$wgt")" -- "$(dirname "$wgt")"
tizen run -s "$serial" -p DenTvApp1X.Den
