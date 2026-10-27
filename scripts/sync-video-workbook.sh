#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${CODEX_PRIMARY_RUNTIME_NODE:?Primary runtime is required}"
: "${CODEX_PRIMARY_RUNTIME_NODE_MODULES:?Primary runtime is required}"
work=$(mktemp -d "${TMPDIR:-/tmp}/weavesense-workbook.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
ln -s "$CODEX_PRIMARY_RUNTIME_NODE_MODULES" "$work/node_modules"
cp "$repo/scripts/sync-video-workbook.mjs" "$work/sync-video-workbook.mjs"
cd "$work"
export XDG_CACHE_HOME="$work/cache"
mkdir -p "$XDG_CACHE_HOME"
"$CODEX_PRIMARY_RUNTIME_NODE" "$work/sync-video-workbook.mjs" --repo "$repo" "$@"
