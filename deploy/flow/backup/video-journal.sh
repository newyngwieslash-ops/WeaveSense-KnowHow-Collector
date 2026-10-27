#!/usr/bin/env bash
# Sourced by DB/object backup tools. Uses the SAME authenticated protocol as Loom.
video_journal_cli() {
  local cli="${VIDEO_JOURNAL_CLI:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/services/loom-engine/flow/video-journal-cli.ts}"
  [ -f "$cli" ] || { echo 'video journal CLI unavailable; use the video-aware backup runtime' >&2; return 2; }
  "${VIDEO_JOURNAL_NODE:-node}" --experimental-strip-types "$cli" "$@"
}

video_database_has_material() {
  local url="$1" present
  present=$(psql "$url" -Atqc "SELECT to_regclass('public.flow_video_assets') IS NOT NULL") || return 2
  if [ "$present" = t ]; then
    present=$(psql "$url" -Atqc "SELECT EXISTS(SELECT 1 FROM flow_video_assets) OR EXISTS(SELECT 1 FROM flow_sources WHERE kind IN ('bilibili','douyin'))") || return 2
    [ "$present" = t ] && return 0
  fi
  present=$(psql "$url" -Atqc "SELECT to_regclass('public.flow_video_deletion_journal_identity') IS NOT NULL") || return 2
  if [ "$present" = t ]; then
    present=$(psql "$url" -Atqc "SELECT EXISTS(SELECT 1 FROM flow_video_deletion_journal_identity)") || return 2
    [ "$present" = t ] && return 0
  fi
  return 1
}

video_journal_required() {
  [ "${BACKUP_VIDEO_JOURNAL_REQUIRED:-false}" = true ] || [ -n "${VIDEO_DELETION_JOURNAL_DIR:-}" ] || [ "${FLOW_VIDEO_ENABLED:-false}" = true ]
}

video_restore_preflight() {
  local checkpoint="$1"
  [ "${VIDEO_JOURNAL_OFFLINE_ACK:-}" = ALL_JOURNAL_CLIENTS_STOPPED ] || { echo 'video restore requires all journal clients stopped; no live restore' >&2; return 2; }
  [ -s "$checkpoint" ] || { echo 'video snapshot journal checkpoint missing: quarantine; do not initialize a replacement journal' >&2; return 2; }
  video_journal_cli verify "$checkpoint" >/dev/null
}
