#!/usr/bin/env bash
# Usage: backup.sh <database-url> <out-dir>
# Consistent snapshot (pg_dump uses one repeatable-read transaction) in custom format,
# plus a manifest of per-table row counts and content checksums for restore verification.
set -euo pipefail
source "$(dirname "$0")/video-journal.sh"
url="$1"; out="$2"; ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
journal=false
if video_journal_required; then journal=true
elif video_database_has_material "$url"; then journal=true
else status=$?; [ "$status" = 1 ] || exit "$status"
fi
if [ "$journal" = true ]; then
  video_journal_cli checkpoint "$out/flow-$ts.video-journal.json" >/dev/null
fi
pg_dump --enable-row-security --format=custom --no-owner --no-privileges --file "$out/flow-$ts.dump" "$url"
"$(dirname "$0")/manifest.sh" "$url" > "$out/flow-$ts.manifest"
sha256sum "$out/flow-$ts.dump" > "$out/flow-$ts.dump.sha256"
# Capture the latest durable watermark AFTER the snapshot too; the independent volume is never copied.
if [ "$journal" = true ]; then video_journal_cli checkpoint "$out/flow-$ts.video-journal.json" >/dev/null; fi
echo "$out/flow-$ts.dump"
