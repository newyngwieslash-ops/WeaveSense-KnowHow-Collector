#!/usr/bin/env bash
# Usage: restore.sh <dump-file> <empty-target-database-url>
# Verifies the dump checksum, restores in a single transaction, then compares the manifest.
set -euo pipefail
source "$(dirname "$0")/video-journal.sh"
dump="$1"; url="$2"; base="${dump%.dump}"
journal=false
if video_journal_required || [ -f "$base.video-journal.json" ]; then
  journal=true
  video_restore_preflight "$base.video-journal.json"
fi
[ -f "$dump.sha256" ] && sha256sum -c "$dump.sha256" >/dev/null
pg_restore --enable-row-security --no-owner --no-privileges --single-transaction --exit-on-error -d "$url" "$dump"
if [ -f "$base.manifest" ]; then
  diff <(sort "$base.manifest") <("$(dirname "$0")/manifest.sh" "$url" | sort)
fi
if video_database_has_material "$url"; then
  [ "$journal" = true ] || { echo 'legacy video snapshot has no journal checkpoint: database quarantined, do not expose video' >&2; exit 2; }
else
  status=$?; [ "$status" = 1 ] || exit "$status"
fi
if [ "$journal" = true ]; then
  echo 'database snapshot verified; VIDEO QUARANTINED until independent journal replay (video-restore.sh)'
else
  echo 'restore verified: manifest matches'
fi
