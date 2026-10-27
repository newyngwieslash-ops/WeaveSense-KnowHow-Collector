#!/usr/bin/env bash
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
LOG_DIR=${VIDEO_QA_LOG_DIR:-/tmp/knowhow-shared-contract}
mkdir -p "$LOG_DIR"
FIXTURE="$ROOT/services/loom-engine/validation/video-knowledge/shared-contract-v1.json"
sha256sum "$FIXTURE" | tee "$LOG_DIR/fixture.sha256"
failed=0
run() {
  local name=$1 directory=$2
  shift 2
  (cd "$directory" && "$@") >"$LOG_DIR/$name.log" 2>&1
  local result=$?
  cat "$LOG_DIR/$name.log"
  if (( result != 0 )); then failed=1; fi
}
run go "$ROOT/backend" "${GO_BIN_DIR:+$GO_BIN_DIR/}go" test ./internal/flow -run '^TestVideoQASharedContractCorpus$' -count=1 -v
run typescript "$ROOT/services/loom-engine" node --experimental-strip-types --test --test-name-pattern='shared three-language' flow/video-qa.test.ts
run python "$ROOT/services/video-knowledge" python3 -m unittest -v test_shared_contract_qa
sha256sum --check "$LOG_DIR/fixture.sha256" || failed=1
echo "Shared fixtures only; not a source-frozen full suite, platform acceptance or model-quality evaluation."
exit "$failed"
