#!/usr/bin/env bash
# Fresh local cluster only. Never accepts an existing database URL/data directory.
# PG_BIN must point to a trusted PostgreSQL distribution; PG_LIB_PATH is optional.
set -euo pipefail
MODE=${1:-all}
case "$MODE" in all|loom|backend|video|restore) ;; *) echo "usage: postgres-qa.sh [all|loom|backend|video|restore]" >&2; exit 2;; esac
: "${PG_BIN:?Set PG_BIN to a trusted PostgreSQL bin directory}"
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
OUT=${VIDEO_QA_OUTPUT:-/workspace/shared/knowhow-qa}
mkdir -p "$OUT/logs"
source_manifest() {
  python3 - "$ROOT" "$1" <<'PY'
import hashlib, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1])
paths=subprocess.check_output(['git','ls-files','-c','-o','--exclude-standard','-z'],cwd=root).decode().split('\0')
extensions={'.go','.sum','.mod','.ts','.tsx','.js','.mjs','.cjs','.py','.sh','.sql','.json','.yaml','.yml','.txt','.toml','.lock','.example','.conf','.ini','.cfg','.html','.css','.svg'}
with open(sys.argv[2],'w') as out:
    for name in sorted(set(paths)):
        p=root/name
        # Frontend has a separate freeze/run; docs and evidence are not source.
        if not name.startswith(('backend/','services/','deploy/')) or not p.is_file():
            continue
        if p.suffix not in extensions and not p.name.startswith('Dockerfile') and p.name not in ('.dockerignore','NOTICE'):
            continue
        if any(x in p.parts for x in ('node_modules','.local','dist','build','__pycache__')):
            continue
        out.write(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+name+'\n')
PY
}
source_manifest "$OUT/logs/source-$MODE-before.sha256"
export PATH="$PG_BIN:${GO_BIN_DIR:-/usr/bin}:$PATH"
if [[ -n ${PG_LIB_PATH:-} ]]; then export LD_LIBRARY_PATH="$PG_LIB_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi
DATA=$(mktemp -d /tmp/knowhow-isolated-pg-XXXXXX)
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
cleanup() { pg_ctl -D "$DATA" -m immediate -w stop >>"$OUT/logs/postgres-cluster.log" 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT
postgres --version > "$OUT/logs/postgres-runtime.txt"
sha256sum "$PG_BIN/postgres" "$PG_BIN/psql" >> "$OUT/logs/postgres-runtime.txt"
initdb -D "$DATA" --no-locale --encoding=UTF8 --auth=trust -U qa_admin > "$OUT/logs/postgres-init.log"
pg_ctl -D "$DATA" -l "$OUT/logs/postgres-cluster.log" -o "-h 127.0.0.1 -p $PORT -c unix_socket_directories='' -c max_connections=80 -c shared_buffers=64MB" -w start
ADMIN="postgres://qa_admin@127.0.0.1:$PORT/postgres?sslmode=disable"
psql "$ADMIN" -v ON_ERROR_STOP=1 -c "CREATE ROLE qa_app LOGIN CREATEDB NOSUPERUSER PASSWORD 'synthetic';" \
  -c "CREATE DATABASE video_qa OWNER qa_app;" -c "CREATE DATABASE canvas_qa OWNER qa_app;" -c "CREATE DATABASE rls_qa OWNER qa_app;"
export FLOW_TEST_PG_ADMIN_URL="$ADMIN" FLOW_TEST_PG_APP_ROLE=qa_app:synthetic
export FLOW_VIDEO_TEST_PG_URL="postgres://qa_app:synthetic@127.0.0.1:$PORT/video_qa?sslmode=disable"
export CANVAS_TEST_POSTGRES_DSN="postgres://qa_app:synthetic@127.0.0.1:$PORT/canvas_qa?sslmode=disable"
export FLOW_TEST_PG_RLS_DSN="postgres://qa_app:synthetic@127.0.0.1:$PORT/rls_qa?sslmode=disable"
export FLOW_VIDEO_CROSSLAYER_TEST=1
export FLOW_VIDEO_RELEASE_BUILD_TEST=1
export FLOW_VIDEO_RESTORE_TEST=1
LOOM=0; BACKEND=0
set +e
if [[ $MODE != backend ]]; then
  (cd "$ROOT/services/loom-engine" && if [[ $MODE == restore ]]; then node --experimental-strip-types --test --test-name-pattern='QA R25/K025' flow/video-qa.test.ts; elif [[ $MODE == video ]]; then node --experimental-strip-types --test --test-concurrency=1 flow/video*.test.ts; else node --experimental-strip-types --test --test-concurrency=1 flow/*.test.ts; fi) > "$OUT/logs/final-loom-postgres-$MODE.log" 2>&1
  LOOM=$?
  tail -35 "$OUT/logs/final-loom-postgres-$MODE.log"
fi
if [[ $MODE == all || $MODE == backend ]]; then
  (cd "$ROOT/backend" && go test -p 2 -count=1 -v ./...) > "$OUT/logs/final-go-postgres-all.log" 2>&1
  BACKEND=$?
  tail -35 "$OUT/logs/final-go-postgres-all.log"
fi
printf 'Actual isolated PostgreSQL verification: Loom exit=%s; Go exit=%s\n' "$LOOM" "$BACKEND"
source_manifest "$OUT/logs/source-$MODE-after.sha256"
DRIFT=0
if ! cmp -s "$OUT/logs/source-$MODE-before.sha256" "$OUT/logs/source-$MODE-after.sha256"; then
  DRIFT=1
  echo 'SOURCE DRIFT: this run is intermediate evidence, not frozen-source acceptance.'
  diff -u "$OUT/logs/source-$MODE-before.sha256" "$OUT/logs/source-$MODE-after.sha256" > "$OUT/logs/source-$MODE-drift.diff" || true
else
  echo 'Source manifest unchanged across this run.'
fi
exit $((LOOM || BACKEND || DRIFT))
