#!/usr/bin/env bash
# Build and run the cross-repo playback e2e (`playback.spec.mjs`) from two checkouts: den-edge at $1 and den-hearth at
# $2. Both repos' CI run this, each with its own commit and the other's latest release. Remux's ffmpeg is the one the
# den-hearth image ships (`DEN_HEARTH_IMAGE`, default :latest), as segment alignment depends on exactly that build.
#
#   web/e2e-stack/ci.sh <den-edge dir> <den-hearth dir>
set -euo pipefail

edge="$(cd "$1" && pwd)"
hearth="$(cd "$2" && pwd)"
image="${DEN_HEARTH_IMAGE:-ghcr.io/oxyc/den-hearth:latest}"
work="${RUNNER_TEMP:-$(mktemp -d)}/den-stack"
mkdir -p "$work"

echo "==> den-edge $(git -C "$edge" describe --tags --always) and den-hearth $(git -C "$hearth" describe --tags --always)"

# The cast page and den-edge's frame-ancestors name the page's origin at build time, as the image's name the public one.
DEN_PARENT_ORIGINS=http://127.0.0.1:18180 cargo build --locked --manifest-path "$edge/Cargo.toml" --bin den-edge
# The one build of Hearth whose fixed TorBox origins and source guard can name local fakes (den-hearth `stub.rs`).
cargo build --locked --manifest-path "$hearth/Cargo.toml" -p den-hearth --features stub-upstreams

echo "==> Remux's ffmpeg from $image"
docker pull --quiet "$image" >/dev/null
container="$(docker create "$image")"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker cp "$container:/usr/local/bin/ffmpeg-remux" "$work/ffmpeg-remux"
# The libraries it links that the runner lacks (the image installs the same; OpenSSL and zlib are already there).
if ! dpkg -s libva2 libva-drm2 >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq --no-install-recommends libva2 libva-drm2 >/dev/null
fi
"$work/ffmpeg-remux" -hide_banner -version | sed -n 1p

cd "$edge/web"
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium webkit
npm run build

DEN_EDGE_BIN="$edge/target/debug/den-edge" \
DEN_HEARTH_BIN="$hearth/target/debug/den-hearth" \
DEN_EDGE_DIST="$edge/web/dist" \
DEN_STACK_MEDIA="$hearth/crates/remux/testdata/h264.mkv" \
DEN_REMUX_FFMPEG="$work/ffmpeg-remux" \
  npm run test:e2e:stack
