#!/usr/bin/env bash
# Usage: objects-restore.sh <backup-dir> <mc-alias>
# Verifies the local backup against objects.manifest, uploads every bucket, then
# downloads the restored buckets again and compares checksums end to end.
set -euo pipefail
source "$(dirname "$0")/video-journal.sh"
src="$1"; alias="$2"
if video_journal_required || [ -f "$src/objects.video-journal.json" ]; then video_restore_preflight "$src/objects.video-journal.json"; fi
( cd "$src" && sha256sum --quiet -c objects.manifest )
buckets=$(cd "$src" && awk '{print $2}' objects.manifest | cut -d/ -f1 | sort -u)
for b in $buckets; do
  mc mb -p "$alias/$b" >/dev/null
  mc mirror --quiet --overwrite "$src/$b" "$alias/$b" >/dev/null
done
check="$(mktemp -d)"; trap 'rm -rf "$check"' EXIT
for b in $buckets; do mkdir -p "$check/$b"; mc mirror --quiet "$alias/$b" "$check/$b" >/dev/null; done
( cd "$check" && sha256sum --quiet -c "$src/objects.manifest" )
if video_journal_required || [ -f "$src/objects.video-journal.json" ]; then
  echo 'objects snapshot verified; VIDEO QUARANTINED; restore database then replay journal before access'
else
  echo "objects restore verified: $(wc -l < "$src/objects.manifest") files match"
fi
