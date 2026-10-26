#!/bin/sh
# Maintainer build: consumers load prebuilt binaries and never run Cargo.
set -eu
cd "$(dirname "$0")/.."
mode=${1:-release}
case "$mode" in
    release|debug) ;;
    *) echo "Usage: scripts/build.sh [release|debug]" >&2; exit 2 ;;
esac
case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) target=aarch64-apple-darwin; library=liborbit_js_addon.dylib ;;
    Linux/x86_64) target=x86_64-unknown-linux-gnu; library=liborbit_js_addon.so ;;
    *) echo "Supported build hosts: macOS arm64 and Linux x64 (glibc)." >&2; exit 2 ;;
esac
if [ "$mode" = release ]; then
    cargo build --manifest-path addon/Cargo.toml --release --target "$target"
else
    cargo build --manifest-path addon/Cargo.toml --target "$target"
fi
node scripts/stage-native.js "$target" "${CARGO_TARGET_DIR:-target}/$target/$mode/$library"
