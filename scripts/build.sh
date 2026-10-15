#!/bin/sh
# Build the native module and place it where index.js loads it. No network
# install: Cargo builds it, and the library is copied under the name Node-API
# runtimes load.
set -eu
cd "$(dirname "$0")/.."
mode=${1:-release}
if [ "$mode" = release ]; then
    cargo build --release
else
    cargo build
fi
case "$(uname -s)" in
    Darwin) library=liborbit_js.dylib ;;
    *) library=liborbit_js.so ;;
esac
# Replace, never overwrite in place: macOS kills a process that loads a
# signed library whose file changed under the same inode.
rm -f orbit.node
cp "target/$mode/$library" orbit.node
echo "orbit.node built ($mode)"
