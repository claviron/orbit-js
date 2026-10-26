#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'HELP'
Usage: scripts/publish.sh --prepare [--target RUST_TARGET] | --dry-run | --publish

--prepare  Build and stage this host's portable release addon, then exit.
           --target selects an explicit cross target with a configured toolchain.
--dry-run  Require all five prepared targets and run npm publish --dry-run.
--publish  Require all five prepared targets and publish to npm.

The package uses npm/README.md; the repository README stays unchanged.

No action is selected by default. Prepare each target on its own host, then
use scripts/sync.sh to collect its .node and release.json before publishing.
HELP
}

if [[ $# -eq 0 || "${1:-}" == --help || "${1:-}" == -h ]]; then
  usage
  exit 0
fi
case "$1" in
  --prepare)
    if [[ $# -ne 1 && !( $# -eq 3 && "$2" == --target && -n "$3" ) ]]; then usage >&2; exit 2; fi
    source scripts/lib/cargo.sh
    prepare_cargo_target
    ;;
  --dry-run|--publish) if [[ $# -ne 1 ]]; then usage >&2; exit 2; fi ;;
  *) usage >&2; exit 2 ;;
esac
exec node scripts/release.js "$@"
