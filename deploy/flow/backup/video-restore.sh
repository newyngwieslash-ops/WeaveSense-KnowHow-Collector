#!/usr/bin/env bash
# Usage: video-restore.sh <dump-file> <empty-target-database-url> <object-snapshot-dir> <mc-alias>
# All video services/workers and journal writers MUST be stopped for the entire operation.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/video-journal.sh"
dump="$1"; url="$2"; objects="$3"; alias="$4"
export BACKUP_VIDEO_JOURNAL_REQUIRED=true
video_restore_preflight "${dump%.dump}.video-journal.json"
video_restore_preflight "$objects/objects.video-journal.json"
# Never copy an old object snapshot AFTER replay has recorded physical deletion receipts.
"$here/objects-restore.sh" "$objects" "$alias"
"$here/restore.sh" "$dump" "$url"
DATABASE_URL="$url" video_journal_cli replay "${dump%.dump}.video-journal.json"
echo 'Video local restore barrier replayed; resume controlled cleanup/outbox delivery and verify receipts before claiming erasure complete.'
