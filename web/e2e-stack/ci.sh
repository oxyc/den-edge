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

cd "$edge/web"
npm ci --ignore-scripts --no-audit --no-fund
npm run build

# The suite runs in Playwright's image for the lockfile's Playwright and this runner's Ubuntu release, which carries
# Chromium, WebKit and their system libraries (and the libva that ffmpeg-remux links). `playwright install --with-deps`
# fetched ~150 packages from the Ubuntu archive on every run instead, and a slow mirror ran the job out of time before a
# test started. The same release as the host, so the binaries built above run in it unchanged; the host's network,
# because the stack listens on fixed ports; the checkouts and $work at their own paths, so every path above holds.
playwright="$(node -p "require('./node_modules/@playwright/test/package.json').version")"
release="$(. /etc/os-release && echo "$VERSION_CODENAME")"
browsers="mcr.microsoft.com/playwright:v$playwright-$release"
echo "==> Playwright from $browsers"
docker pull --quiet "$browsers" >/dev/null
docker run --rm --network host --ipc=host \
  -v "$edge:$edge" -v "$hearth:$hearth" -v "$work:$work" -w "$edge/web" \
  -e CI \
  -e DEN_EDGE_BIN="$edge/target/debug/den-edge" \
  -e DEN_HEARTH_BIN="$hearth/target/debug/den-hearth" \
  -e DEN_EDGE_DIST="$edge/web/dist" \
  -e DEN_STACK_MEDIA="$hearth/crates/remux/testdata/h264.mkv" \
  -e DEN_REMUX_FFMPEG="$work/ffmpeg-remux" \
  "$browsers" \
  bash -c 'set -euo pipefail; "$DEN_REMUX_FFMPEG" -hide_banner -version | sed -n 1p; npm run test:e2e:stack'
