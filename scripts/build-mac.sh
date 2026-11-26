#!/usr/bin/env bash
# Build a standalone macOS executable (Node Single Executable Application).
#
#   scripts/build-mac.sh          # dist/agent-relay-macos-arm64
#   scripts/build-mac.sh --x64    # also dist/agent-relay-macos-x64
#
# The base is always the official Node binary from nodejs.org (checksum
# verified, cached in dist/.cache): a Homebrew node links shared libraries and
# has no SEA fuse. NODE_VERSION picks the version (default: the local node,
# must be 25.5+ for --build-sea). The person running the result needs nothing
# installed.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname -s)" == Darwin ]] || { echo "build-mac.sh runs on macOS only" >&2; exit 1; }

WANT_X64=0
for a in "$@"; do
  case "$a" in
    --x64) WANT_X64=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

NODE_VERSION="${NODE_VERSION:-$(node --version)}"
OUT=dist
CACHE="$OUT/.cache"
mkdir -p "$CACHE"

# fetch_node <arch>: prints the path of the official node binary for darwin-<arch>.
fetch_node() {
  local arch="$1" dir="node-$NODE_VERSION-darwin-$1"
  local base_url="https://nodejs.org/dist/$NODE_VERSION"
  if [[ ! -x "$CACHE/$dir/bin/node" ]]; then
    curl -fsSL -o "$CACHE/$dir.tar.gz" "$base_url/$dir.tar.gz"
    curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "$base_url/SHASUMS256.txt"
    local want have
    want="$(grep " $dir.tar.gz\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)"
    have="$(shasum -a 256 "$CACHE/$dir.tar.gz" | cut -d' ' -f1)"
    [[ -n "$want" && "$want" == "$have" ]] || { echo "checksum mismatch for $dir.tar.gz" >&2; exit 1; }
    tar -xzf "$CACHE/$dir.tar.gz" -C "$CACHE" "$dir/bin/node"
    rm -f "$CACHE/$dir.tar.gz"
  fi
  echo "$CACHE/$dir/bin/node"
}

[[ "$(uname -m)" == arm64 ]] || { echo "build on Apple silicon (the builder is the arm64 node)" >&2; exit 1; }
echo "==> official node $NODE_VERSION darwin-arm64"
BUILDER="$(fetch_node arm64)"
"$BUILDER" --help | grep -q -- '--build-sea' || { echo "node $NODE_VERSION has no --build-sea; use 25.5 or newer" >&2; exit 1; }

echo "==> bundle src/cli.ts"
pnpm exec esbuild src/cli.ts \
  --bundle --platform=node --format=cjs --target=node22 \
  --packages=bundle --legal-comments=none \
  --outfile="$OUT/agent-relay.cjs" --log-level=warning

# build_sea <base node binary> <output> <useCodeCache>
build_sea() {
  local base="$1" output="$2" codecache="$3"
  local cfg="$CACHE/sea-config.json"
  cat > "$cfg" <<JSON
{
  "main": "$OUT/agent-relay.cjs",
  "output": "$output",
  "executable": "$base",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": $codecache,
  "useSnapshot": false
}
JSON
  rm -f "$output"
  "$BUILDER" --build-sea "$cfg"
  codesign --remove-signature "$output"
  codesign --sign - "$output"
  echo "    $output ($(du -h "$output" | cut -f1 | tr -d ' '))"
}

echo "==> SEA darwin-arm64"
build_sea "$BUILDER" "$OUT/agent-relay-macos-arm64" true

if [[ "$WANT_X64" == 1 ]]; then
  echo "==> SEA darwin-x64"
  # The code cache is tied to the builder's arch: off for the cross build.
  build_sea "$(fetch_node x64)" "$OUT/agent-relay-macos-x64" false
fi
