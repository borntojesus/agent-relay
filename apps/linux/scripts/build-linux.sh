#!/usr/bin/env bash
# Build the Linux bundles (.deb and AppImage) on an Ubuntu 24.04 machine.
# Installs nothing: checks the toolchain, builds, copies the results to
# apps/linux/dist/ and writes SHA256SUMS. See apps/linux/README.md.
set -euo pipefail

cd "$(dirname "$0")/.."
here=$(pwd)

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }
need cargo "rustup, stable"
need node "Node 22.5 or newer"
need pnpm "corepack enable && corepack prepare pnpm@11.5.2 --activate"
need pkg-config "apt install pkg-config"
for lib in webkit2gtk-4.1 gtk+-3.0 libsoup-3.0 openssl dbus-1; do
  pkg-config --exists "$lib" || { echo "missing dev package for $lib (see README: apt install ...)" >&2; exit 1; }
done

# AppImage tools are AppImages themselves; this avoids needing FUSE.
export APPIMAGE_EXTRACT_AND_RUN=1
# linuxdeploy's bundled strip fails on newer binaries on some hosts.
export NO_STRIP="${NO_STRIP:-true}"

pnpm install --frozen-lockfile
pnpm tauri build --bundles deb appimage "$@"

version=$(node -p "require('./package.json').version")
mkdir -p dist
bundle=src-tauri/target/release/bundle
# Tauri names bundles after productName ("Agent Relay"); ship them as agent-relay_<ver>_<arch>.*
for f in "$bundle"/deb/*_"${version}"_*.deb "$bundle"/appimage/*_"${version}"_*.AppImage; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  cp "$f" "dist/agent-relay_${base#*_}"
done
cd dist
sha256sum -- agent-relay_*.deb agent-relay_*.AppImage > SHA256SUMS
ls -lh
echo "artifacts in $here/dist"
