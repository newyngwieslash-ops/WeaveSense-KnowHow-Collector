# Independent verification — 2026-10-26

> Historical test report. The working-tree description below records the state at
> execution time, not the present publication state. The complete source was later
> published as [`cf2aad9`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/cf2aad9c5926500bfaae7bb39e48316ccd192269).
> Publication verified file parity; it did not rerun these tests. Subsequent checks
> and unresolved boundaries are tracked separately in [ROUND2.md](ROUND2.md).

This report concerns the **uncommitted implementation working tree**, based on host commit
`514c70f666cb04e3e72cbfb967fac74d9f350747`, branch `feat/video-knowledge-v1`.
It is not a release, deployment, live-platform certification, model-quality evaluation or
completion declaration for the 100 P0/P1 tasks. The seven P2 tasks remain outside V1.
`PROGRESS.json` remains the task-status authority; this report supplies bounded evidence.
Completed-run logs are also preserved under `/workspace/shared/knowhow-qa/logs/` with
the filenames referenced below. Logs are fixture diagnostics, not production telemetry.

## Latest frozen-source verification — completed 18:38 UTC

Delivered evidence: [validation-results.json](evidence/validation/validation-results.json),
[sanitized log bundle](evidence/validation/sanitized-logs.tar.gz) and
[reproduction/redaction notes](evidence/validation/README.md). Raw and sanitized hashes,
redaction counts, commands, versions, skip names and source manifests are retained there.

| Final component | Observed result |
|---|---|
| Full Loom, fresh PostgreSQL17.11 plus PGlite | **203 passed,0 failed,0 skipped**,500.772s |
| Full Go, fresh PostgreSQL, cross-layer/restore/compiled-release flags enabled | **33 tested packages passed;1,949 top-level tests passed,7 skipped,0 failed**; nested/echoed child tests are not double-counted |
| Video provider/gateway/common-contract Python | **46 passed**,6.319s |
| ASR worker system-Python suite | **7 passed,1 skipped**,0.549s; `faster-whisper` not installed in this interpreter |
| Strict production Flow TypeScript | Exit0 |
| Fresh compiled full host, real cookie login, Vite proxy and Loom | API smoke passed, including retention preview/batch and native registry snapshot; **not browser acceptance** |

Both final component runs have identical before/after manifests for1,868 scoped
backend/services/deploy source/config/test files:
`569d0fe8ebede44def1305b7cc0c9c124fdfa350cf01f0737b7395c5e20b59e1`.
Web and documentation have separate verification boundaries. Actual PostgreSQL tests
include non-superuser FORCE RLS, independent pools, SIGKILL worker replacement, required
embedding readiness and old-backup restoration against the newer external deletion journal.
Both disposable database clusters were stopped.

The seven Go skips are explicit: two Redis tests (earlier real attempts were denied Unix
IPC), one paid live-provider test, one browser-runner test, two child-only entrypoints
(executed through their actual compiler harnesses), and one Linux-alternate executable
test whose main classification test runs. No denied browser/Redis operation was retried.
The earlier200-test combined run passed its assertions but experienced the final COL024
source change; it is preserved as **intermediate**, not relabeled frozen acceptance.

## Earlier focused independent evidence

| Evidence | Actual execution boundary | Result |
|---|---|---|
| `backend/internal/flow/video_qa_test.go`, `video_ready_event_test.go` | Real Go MCPGateway, pinned internal transport, actual MCP HTTP, signed delegation, EngineClient/Loom/PGlite; wrong issuer rejected; actual scheduled Loom ready outbox creates exactly one Go Canvas command | 3/3 passed,6.03 s; `/tmp/knowhow-go-crosslayer-final.log` |
| `services/loom-engine/flow/video-qa.test.ts` | Actual coordinator/database: malformed signed auth claims; UTF-16 emoji/combining spans; invalid platform/part IDs; file-backed DB close/reopen and fencing; input/parent lineage; 2,101 segments and >400,001 UTF-16 code units; exact hashes/quotes and indexed tail; injected indexing rollback/retry; mode freeze and correction | Expanded suite 9/9 passed,17.45 s; `/tmp/knowhow-video-qa-final.log` |
| Same file, `cross-language media` | Actual HTTPVideoProvider → signed Python HTTP → SQLite Tasks/Executor → FFmpeg → object verification → Loom readiness; then actual object deletion, live worker SQLite erasure receipt, host revision404 and worker tombstone410 | Final expanded run passed,3.54 s; `/tmp/knowhow-crosslayer-erasure-final.log` |
| Same file, `human correction` | Actual correction CAS/reviewer gate; indexing fault rollback; immutable old body/evidence/hash retained; one idempotent new revision | Passed, 3.11 s; `/tmp/knowhow-correction-qa.log` |
| `services/video-knowledge/test_video.py` | Independently rerun provider tests: persistent task recovery, unknown outcomes, scoped auth/objects, real FFmpeg chunk resume, actual frame timestamps, processing modes and object deletion | Together with model-adapter tests, final run20/20 passed,2.79 s; `/tmp/knowhow-python-final-qa.log` |
| `services/video-knowledge/test_gateway.py` | Model-adapter unit fixtures: hierarchy covers all inputs, oversize refusal, same-key fence rebind, unknown-response recovery | 4/4 passed; `/tmp/knowhow-python-model-gateway-qa.log`; no actual model execution |
| `validation/video-knowledge/host-api-qa.mjs` | **Compiled actual full Go host**, Vite proxy, Loom/PGlite, fresh synthetic cookie sessions; K026 native registry callback/snapshot; schedule pause/resume CAS | Passed; `/workspace/shared/knowhow-qa/host-api-qa.json` and `/tmp/knowhow-host-schedule-qa.log` |
| Five host Node Agent runtime cases | Actual host CreateCloudAgentRun→Node Pi runtime→model/tool bridge, approval continuation, streaming recall, retry/no-retry; deterministic upstream fixture, not real model quality | 5/5 passed,17.38 s after locked runtime dependency install; `/tmp/knowhow-agent-runtime-recheck.log` |
| `flow/pg.test.ts`, `legacy-import-full.test.ts`, `video-qa-pg.test.ts` | Actual PostgreSQL17.11, non-superuser app role, FORCE RLS, real HTTP tenant isolation, dump/restore, legacy import, independent-pool video claims | 6/6 passed, no skips (five PostgreSQL cases and one PGlite control), `/tmp/knowhow-real-pg-loom.log` |
| `flow/video-qa-pg.test.ts` expanded fault run | Spawned an actual Node worker against PostgreSQL, confirmed durable claim, sent SIGKILL, reclaimed after lease expiry, rejected old fence; separate connection-pool race and FORCE RLS checks | 1/1 passed,0.98 s; `/tmp/knowhow-pg-worker-kill-qa.log` |

The Python/FFmpeg test substitutes deterministic **platform download and ASR fixtures**.
It proves production-handler/schema/worker integration, not a real platform download,
speech recognition accuracy, licensed material availability or visual-model quality.

The full-host run performed real synthetic registration, logout/login and cookie-session
resolution; profile optimistic concurrency; signed source/job/replay/reconcile/cancel;
tenant-argument rejection and foreign-workspace non-disclosure; native JSON pack install;
an actual persisted conversation `intel_load_skill` execution; and published-knowledge
search with no raw-video promotion. The final rerun also exercised host extraction listing,
origin association and rejection of corrections to non-ready material. The newest rerun
includes the real Loom→Go native registry callback, a persisted knowledge snapshot/hash,
and identical snapshot pin on a second tool call. It served real Vite SPA route documents but did **not**
execute or visually inspect them in a browser. No persistent grant or real user credential
was used. Its child processes and disposable host database were cleaned up.

Correlating IDs (synthetic fixture runs only):

- Go/MCP/Loom: operation `op_e1a209d2e510f47b389d827a`, job `vj_5edd75f0ce2687dd9cbac879`.
- Python/Loom: operation `op_733e62959376cfa8e664cf3b`, job `vj_e944d710c37c091ec0556f3b`.
- Actual host (schedule+K026 rerun): operation `op_8705dd69b03863e4f8f71e9c`, job `vj_550c0ac22ef902b04b3638b7`.
- Python/Loom ready→erasure rerun: operation `op_c93bc91c415cfca697d9b8bb`, job `vj_cf34a760a0ddab39a1b30670`.

## Findings closed with independent regression

- Fresh signed JWT claim differences were included in the business fingerprint: identical
  content submitted with a different idempotency key created duplicate jobs. The real
  cross-language test reproduced this, then passed after identity canonicalization.
- Missing/malformed token validity could escape expiry comparisons. Signed malformed
  `iat`/`exp` fixtures now reject; this is not a claim that every deployment issuer is configured.
- Invalid Bilibili parts and unsupported platform identities could silently collapse.
  Invalid/unsafe values now reject.
- Import lineage now rejects a forged input hash even when individual object hashes are
  otherwise valid, and rejects processing results detached from their accepted input.
- Long transcript/evidence and index rollback tests establish that the final segment is
  not silently lost and a failed new revision does not replace the previous ready revision.
- Human correction creates a new revision through the index/evidence barrier rather than
  overwriting the original transcript or evidence snapshot.
- New Loom correction/extraction/origin routes initially lacked Go host proxies, which
  would make their real UI calls fail. Missing routes were added by the gateway owner;
  the rebuilt full-host HTTP rerun verified the integrated routes.

Other implementation-owner tests, including native Canvas loading, current-grant model
authorization, governed publication, extraction and comparative evaluation, should be
cited separately with their actual result logs. Code existence is not an independent pass.

## Existing baseline failures, not concealed regressions

The earlier full Loom run produced **121 tests: 112 passed, 5 failed, 4 skipped**
(`/tmp/knowhow-flow-qa-final.log`). The five failures were old A20 repository identity,
cron-window interval handling, and three stale evidence/report fixtures.

An untouched `git archive HEAD services/loom-engine` was tested under
`/tmp/knowhow-baseline-qa`. `/tmp/knowhow-baseline-qa.log` and
`/tmp/knowhow-baseline-focused.log` preserve evidence that the cron/report/evidence failures
also existed at the exact baseline. Some concurrent runs additionally experienced process
termination; those are not recorded as passing assertions.

With coordinator approval, QA changed **test fixtures only** for the stale expectations:

- A20 parameterizes the expected repository via `FLOW_EXPECTED_REPOSITORY`, defaulting to
  the authorized new repository. No Git origin was rewritten and no remote publication is claimed.
- Evidence uses the exact `Acme` 0–4 span; mixed foreign-workspace batch rejection remains
  atomic and is explicitly asserted, followed by a valid own-workspace idempotency check.
- Report/evidence inputs include the contract-required body and material scope; forged
  quote/URL rejection assertions remain intact.

The focused corrected fixtures passed **4/4** in `/tmp/knowhow-stale-fixtures-fixed.log`.
The actual cron defect was assigned to the Loom owner, not hidden by disabling a constraint
or inserting an arbitrary fixed interval. Final regression evidence is recorded separately.

The next full run (`/tmp/knowhow-flow-qa-final2.log`, concurrency 2) completed with
**131 tests: 125 passed, 2 process-level file failures, 4 skipped**. All eight independent
video QA tests passed, as did video-core and knowledge tests. The two failed files were
`gaps5.test.ts` and `gaps6.test.ts`, without an assertion diagnostic. A serial rerun of those
two files passed **21/21** (`/tmp/knowhow-loom-failedfiles-recheck.log`), including the repaired
real cron-window test. This does not retroactively make the concurrent full run green or
prove the cause of its process failures.

The serial full-suite run (`/tmp/knowhow-flow-qa-serial-final.log`) then completed with
**137 tests: 132 passed, 1 failed, 4 skipped** in 372.35 s. Its sole failure was the newly
added processing-mode regression below. After the owner fix, the complete independent
video QA file passed **9/9**, including that assertion, real Python/FFmpeg integration and
correction duration validation. This focused recheck does not rewrite the full-run result.

A later serial run recorded **145 tests:139 passed,1 failed,5 skipped**; the failure was a
new QA erasure fixture initially missing the declared `intel.sources.write` scope, not an
application authorization regression. After correcting the fixture scope, the focused test
exposed an erased-task envelope read defect, fixed by the media owner; the final production
HTTP erasure recheck passed. Earlier skips have independent real PostgreSQL passes above.

The full Go run with actual PostgreSQL enabled passed every package except `internal/app`,
whose five Node runtime cases lacked the separate runtime's `undici` dependency.
`backend/agent-runtime/pi/package-lock.json` was installed with `npm ci --ignore-scripts`
and a workspace-local cache (230 packages, no lock changes); all five then passed. The
original full-run log is preserved as `/tmp/knowhow-real-pg-go-all.log`, not relabelled green.
A new combined full Loom+Go verification with real PostgreSQL and the installed runtime
is running through `validation/video-knowledge/postgres-qa.sh`; final logs are
`/workspace/shared/knowhow-qa/logs/final-loom-postgres-all.log` and
`/workspace/shared/knowhow-qa/logs/final-go-postgres-all.log`.

## Additional findings and bounded closure evidence

- **Profile processing mode — fixed/retested:** an independent database test reproduced
  selected `full_video` freezing as `subtitle_first`. Canonical source override/profile
  fallback was fixed, and the assertion passed in the 9/9 rerun. Initial failure remains
  in `/tmp/knowhow-profile-mode-qa.log`.
- **Budget semantics:** admission reservations and priced usage are distinct. The final
  focused video suite covers unknown/open child holds, authoritative settlement,
  non-duplicated charges and retry using only remaining cumulative budget. The actual
  embedding cross-layer run obtains its billed host receipt through the real Go task
  queue/ledger. These synthetic tariff/provider fixtures do not establish real paid
  provider invoices or production cost accuracy.
- **Required embedding positive path independently verified:** the host-billed
  bridge and durable embedding stage now exist. Independent
  `/tmp/knowhow-embedding-coordinator-qa.log` passes the actual PGlite coordinator import →
  embedding queue → verified synthetic host receipt → exact vectors/FTS → single ready
  event. The vector/model/budget receipt in this test is explicitly a fixture, not paid
  model quality or billing acceptance. The real-PG variant also passes. Independent
  `logs/knowhow-independent-embedding-gateway-final.log` additionally passes actual
  Loom coordinator → signed Go async model tasks → local HTTP embeddings provider →
  host-billed receipt → exact vectors/FTS/ready, with no premature ready and one provider
  call. Earlier `/tmp/knowhow-embedding-gap-qa.log` established fail-closed behavior:
  required embedding rejects503 `EMBEDDING_UNAVAILABLE`; optional embedding reports a gap
  and ignores a worker's fabricated completion flag. That negative test alone was not
  successful required embedding; the later positive path is separate evidence.
- **Operational erasure — fixed/retested:** Python execution payload/checkpoint caches
  retained content after host/object cleanup. The production signed erasure receipt now
  precedes Loom cleanup completion; the cross-layer test passes and erased-task GET410
  cannot refresh authorization or revive its payload. Deployment backups and DTK-owned
  remote copies remain separately governed and were not erased or certified by this fixture.
- **Restore no-resurrection gap fixed and independently tested:** the earlier reviewed
  `restore.sh` and `objects-restore.sh` only verify snapshots. A pre-erasure backup lacks
  later in-DB tombstones/outbox entries. Those entries alone cannot establish R25/K025.
  Acceptance requires an authoritative deletion journal outside the overwritten snapshot,
  replay before serving data, and quarantine if its current watermark is unavailable.
  `logs/final-loom-postgres-restore.log` now records a passing actual pre-delete PG
  dump/restore regression, not a same-DB SQL test. A real old database and filesystem
  object backup contain a private canary and no later tombstone. After restoration,
  an unavailable journal makes the first production HTTP revision read503. Latest
  external-journal replay denies revisions, evidence, published/research knowledge,
  frozen run knowledge, fixture installed-skill pins and raw objects; maintenance then
  removes the restored object bytes. Repeated replay is idempotent. This does **not**
  certify the deployment's independent journal volume/backups or DTK-owned copies.
  The expanded regression also proves unrelated actual RSS content remains readable
  during video quarantine and now invokes the real operator `backup.sh`/`restore.sh`
  with an authenticated sidecar checkpoint. The journal's fresh generation must match
  the database identity; replacing it with a newly initialized same-name journal is not
  an accepted recovery path.

## Explicit unexecuted/blocking states

New independent coverage review (16:53 UTC) identified implementation work, not merely
unexecuted visual acceptance: IF-024 lacked paged frame/observation data and authorized
lazy media rendering; IF-021 lacked an available-media host playback path; K-013 worker
observations were not imported into host evidence. Their API/worker path now passes the
expanded independent test below; UI implementation and real browser acceptance remain
separate and must not be hidden behind that API result. A separate host-only SQLite
restore regression now passes independently: restoring old Go caches reconciles the
unchanged authoritative Loom deletion history before notifications/history are served.
`logs/knowhow-host-only-restore-genesis.log` records the actual pre-erasure SQLite
`VACUUM INTO` snapshot/file restore, real Loom coordinator/reports/journal/feed and real
Go routes/tool cache. An unavailable feed blocks notifications/history while an unrelated
RSS report remains available; restored feed removes private assistant/tool history,
summary/plans and model payloads while preserving the user question and cost audit.
This is synthetic cache-retention verification, not production restore acceptance.
The latest full-host API rerun also passed the new retention-preview/batch proxy path:
fresh real register/logout/login cookie auth, exact dependency preview, stale-hash409,
partial per-target results and stable replay (`logs/knowhow-host-impact-api.log`).
Its actual compiled binary SHA256 was
`a64a7aca74928c5ea2ad382e3339badfbfbd8ea4bb6e1b93147a408581a19610`.
This remains HTTP integration, not browser rendering/interaction acceptance.
The subsequent native-Agent audit found linked CloudAgent execution checkpoints, Pi JSONL
sessions, native event/message records and legacy task canonical-input/result/delta caches
outside that original proof. The expanded independent regression now registers the real
repository purger/barrier and restores typed root/child native cache fixtures from the old
physical SQLite file. Both erase and revoke-then-erase cases passed (4.05s/3.76s), including
missing-feed denial, late Pi-session write denial, preserved user-authored canonical
messages, financial facts, unrelated runs and foreign-user caches. The revoke case also
exposed and closed a separate Flow history/notification visibility gap after tool-cache
redaction. `logs/knowhow-host-native-restore-recheck.log` records this result. These are
persisted cache fixtures, **not actual model-run/resume execution**; app/runtime-owner
tests provide that separate coverage. The initial native test failure was an invalid QA
fixture missing the real `Operation=cloud_agent` marker; its log is retained and no guard
was weakened.

Follow-on native undo audit added `CloudAgentCanvasMutation.BeforeJSON` to that same
restore fixture. It first failed because `LatestCloudAgentCanvasMutation` returned the
old snapshot while the authoritative feed was unavailable
(`logs/knowhow-native-undo-negative.log`,3.80s). After exact-run snapshot scrubbing and
read/undo/late-write fences, the unchanged wider regression passed2/2 (3.94s/3.98s),
`logs/knowhow-native-undo-restore-recheck.log`. This additional store is now covered;
current user-owned Canvas drawings are not globally deleted.

Independent actual app/repository entry-point regressions also passed eight top-level
tests (`logs/knowhow-native-app-independent.log`): warmed text replay, run/resume/scheduler,
late Pi/event/delta writes and actual undo execution. A separate real-clock source grant
expiry test passed9.52s (`logs/knowhow-source-expiry-host.log`): a future six-second source
authorization expires naturally after the old SQLite backup; the real Loom feed journals
the expiry and fences restored native/Flow caches without a manually inserted tombstone
or explicit revoke request. Unrelated RSS remains available.

The typed-retention variant also passed63.75s (`logs/knowhow-typed-ttl-host-restore.log`):
the minimum valid60-second access policy expires by real wall clock after the host backup.
The frozen policy hash and actual deadline are asserted; the actual Loom journal/feed
blocks restored Flow/native/undo caches. A later explicit erase scrubs them. No deadline
SQL mutation, artificial clock or manually delivered tombstone was used. This validates
access expiry and subsequent cache erasure, not automatic physical deletion at hard max.

### Native release: actual Loom domain to compiled running host

`video_release_loom_qa_test.go` and `validation/video-knowledge/release-loom-qa.ts`
passed17.39s (`logs/knowhow-release-real-domain.log`). The fixture obtains its base from
the real Go registry, creates/reviews/publishes knowledge and exports a candidate through
the actual Loom domain, then closes its file-backed database. The actual release CLI
writes an isolated source archive; Go compiles a new executable embedding that archive.
The running child reopens the same Loom database/journal, refuses install before
attestation, records its actual executable SHA256 through real deployment-check/receipt
handlers, installs the scoped method and obtains a native run knowledge snapshot through
the real registry callback. Actual knowledge withdrawal subsequently denies the old pin.
A wrong service actor with deployment scope is rejected403.

Evidence, evaluation outcomes and reviewer identity are explicitly synthetic fixtures:
this verifies domain/build/runtime integration, **not model quality, actual human approval,
source-controlled production release or deployment**. Earlier invalid QA tool/schema and
archive-directory attempts are retained. The new retention-preview module's unsupported
Node strip-only parameter-property syntax was also caught and corrected before rerun.
The separate owner test exercises two compiled versions, CAS installation and rollback.

### K-013/K-015/IF-021/IF-024 media-path regression

`logs/knowhow-visual-media-crosslanguage-recheck.log`:1/1 passed5.42s. Real Python signed
HTTP/SQLite/FFmpeg and Loom coordinator/HTTP imported frame, OCR, model-observation,
model-inference and alignment artifacts. Platform acquisition and ASR/OCR/VLM callbacks
are explicitly deterministic fixtures: **not actual model quality or billing evidence**.
The test preserves a2400-character CJK OCR body, reads its full tail through bounded
fixed-record continuations, checks unique two-record pages, unreviewed/derived labels and
`unaligned`/`not_assessed` semantics. Opaque authenticated lazy media descriptors expose
no object keys; actual full/range/suffix streams return200/206, invalid ranges416,
foreign scope404 and missing permission403. Deleting accepted frame bytes yields404,
marks the object missing and removes its advertised link. Later erasure invalidates an
old media path, cleans stored artifacts and gets worker410.

The subsequent controlled-repair regression also passed1/1 in9.65s
(`logs/knowhow-visual-media-changed-repair.log`): explicit repair creates bounded new work,
same/different-key repeated clicks deduplicate, reacquisition restores the old opaque
frame only from an exact hash/size/type replica and never rewrites an old cited revision.
A second repair deliberately changes the synthetic source's actual video bytes; it reports
`changed_media`, restores0 historical objects and leaves the old missing frame404. The
initial repair fixture lacked the required refresh/resolve method; that fixture-only
failure is retained, and the production refresh requirement was not relaxed.

`logs/knowhow-visual-validator-independent-recheck.log`:2/2 passed. The test caught a
real missing host check: invented `frame_ids` could accompany valid `frame_refs` despite
a correct content hash. The owner added exact identity/ref uniqueness and time-envelope
validation. Earlier failing logs, including the new0028 SQL dollar-quote migration split
failure, are retained. No malformed artifact assertion was weakened.

| Scope/task | State and reason | Required next action |
|---|---|---|
| Browser interactions/layout, QA-001 | **Blocked before browser launch.** Chromium reported `socket() failed: Operation not permitted (1)`. One supported elevated retry failed with `bwrap: Can't create file at /home/agent/.codex/sessions: Read-only file system`. No forbidden directory was read and no bypass attempted. | Run retained `host-browser-qa.mjs` in an authorized executor with Chromium IPC and a functioning escalation environment. Do not relabel HTTP/SPA delivery as browser success. |
| M0 dual-platform discovery/download and COL-028 real sample loop | **Pending external inputs and actual tests.** Synthetic media is not either real platform. | Freeze authorized Bilibili/Douyin sources, allowed uses, credential references and sample manifest; execute actual host path and retain scoped receipts. |
| Real PostgreSQL FORCE RLS cases | **Executed**, replacing the earlier environment skips with the separate6/6 run above. A non-superuser role owned disposable test databases; FORCE RLS was verified, not bypassed with a superuser. | Retain the logs and rerun in deployment-equivalent infrastructure before release. |
| QA-001 real model/Agent answers and industry review | **Pending**, not established by deterministic ASR or native skill loading. | Supply approved model configuration, budget, frozen domain questions and authorized human reviewer; execute and evaluate real runs. |
| QA-002 source-controlled deployment/history | **No commit, push, build deployment or production install performed by QA.** Runtime fixture receipt checks are not deployment proof. | Authorized source-controlled release/build/deploy/install/rollback rehearsal with actual immutable commit/image receipts. |
| QA-003 / M4 pilot and release | **Not accepted.** No seven-day pilot, human business gold set or production metrics exist from these fixture runs. | Freeze pilot acceptance period/sample/configuration and complete the actual observation and review. |

## Reproduction

### G14 common cross-language contract corpus

`validation/video-knowledge/shared-contract-v1.json` is consumed by production validators,
not independent mock parsers: Go `Verify`/`HasScope` and durable command outbox; TypeScript
`verify`/`requireScope`/`assertVideoObject` and real coordinator admission/import; Python
`verify_context`/`scope_key`, SQLite `Tasks` and `Processor.process`. Ten signed-context
cases are shared across all three. Same-key replay/conflicting immutable input is checked
against each runtime's actual durable owner. Seven object-key boundaries and nine input
manifest cases are shared by TS/Python; the thin Go gateway deliberately does **not** own a
duplicate manifest parser. The corpus caught Python's differing job/filename lengths and
missing schema-version rejection; production owners corrected those three drifts. A later
negative case stored valid bytes under a scoped content-address key with the wrong digest.
Both TS import and Python read/materialize now require path digest, declared digest and
actual bytes to agree; the unchanged negative fixture passes.

Latest independent focused results: Go root plus ten context subtests passed0.228s;
TS composite passed2.84s; Python4 tests passed0.005s. Logs under
`logs/shared-contract-final/` preserve them; earlier failing logs remain. The broader
Python suite passed46/46 in6.72s (`logs/knowhow-python-content-address-final.log`).
The TS fixture explicitly reserves small synthetic
input limits instead of weakening the new daily-resource admission guard. Reproduce all
three from the repo root (with dependencies and Go toolchain configured):

```sh
bash services/loom-engine/validation/video-knowledge/shared-contract-qa.sh
```

From `services/loom-engine`:

```sh
node --experimental-strip-types --test --test-concurrency=1 flow/video-qa.test.ts
node --experimental-strip-types --test --test-concurrency=1 flow/*.test.ts
VIDEO_QA_HOST_BINARY=/absolute/path/to/actual-built-host node validation/video-knowledge/host-api-qa.mjs
```

From `backend`, with the provisioned Go toolchain/cache:

```sh
FLOW_VIDEO_CROSSLAYER_TEST=1 go test ./internal/flow -run TestVideoQA -count=1 -v
FLOW_VIDEO_RELEASE_BUILD_TEST=1 go test ./internal/flow -run '^TestVideoQALoomExportBuildAndRunningRegistry$' -count=1 -v
go build -o /tmp/knowhow-qa-server ./cmd/server
```

From `services/video-knowledge`: `python -m unittest -v test_video`.
The host integration script discovers ephemeral loopback ports and launches/cleans up its
own servers. Use only a fresh fixture database; never point this script at production.

### PostgreSQL runtime evidence

The coordinator identified an already-provisioned isolated PostgreSQL runtime; QA did
not install it into the OS or reuse another project's data. The executable reports
`PostgreSQL17.11 (Debian17.11-0+deb13u1)`; freshly measured SHA256:

- `postgres`: `6468a969338215cb3912cf9c0b894bdbbd37b9a709926db078e9a5bf8bdc3e16`
- `psql`: `3c94c29652ea7ff8803ab1ca35e48c38a39c8a94a8c8eeadbb1d87c68494506c`

Each cluster used a fresh `mktemp` data directory, synthetic `qa_admin`/`qa_app` identities,
loopback TCP only, `unix_socket_directories=''`, and trust authentication **only inside this
disposable local fixture**. Cleanup stops the fixture server and deletes that temporary
cluster. `FLOW_VIDEO_TEST_PG_URL` enables the new independent video test; existing tests use
`FLOW_TEST_PG_ADMIN_URL` and `FLOW_TEST_PG_APP_ROLE`. Full Go PostgreSQL branches also use
`CANVAS_TEST_POSTGRES_DSN` and `FLOW_TEST_PG_RLS_DSN` (non-superuser CREATEDB role).
The reproducible coordinator is `bash validation/video-knowledge/postgres-qa.sh all` from
the Loom directory, with trusted `PG_BIN`, optional `PG_LIB_PATH`, `GO_BIN_DIR`, `GOPATH`
and `GOCACHE` set. It always creates a new cluster and refuses an existing-data input.

### Intermediate all-PostgreSQL suite, 2026-10-26 16:23 UTC

`logs/final-go-postgres-all.log`: **all backend packages passed**, including actual
non-superuser PostgreSQL branches and the actual Node/Pi runtime fixtures after installing
their existing lockfile dependencies (app224.636s, flow67.281s, database6.864s).

`logs/final-loom-postgres-all.log`:152 tests,151 passed,0 skipped,1 process-level failure
for `engine.test.ts` after all11 of its assertions printed pass. No assertion diagnostic
was emitted. Standalone TAP recheck `/tmp/knowhow-engine-tap-recheck.log` passed11/11 in33.52s.
The process failure is retained, not silently relabelled as an all-green suite.

Owners were still modifying budget/embedding/retention during this run: this is
**intermediate source-drift evidence**, not a frozen release acceptance result.

Focused video-only actual-PG rerun: `logs/final-loom-postgres-video.log`,44/44 passed,
0 skipped,82.83s, including positive required embedding on both PG and PGlite. The
separate restore mode `postgres-qa.sh restore` passed1/1,858.67ms. Every mode provisions
and removes its own fresh loopback PostgreSQL cluster.
The later final-journal focused run replaces that log with **53/53 passed,0 skipped,
89.98s**, including actual operator backup/restore2.71s. The earlier44-test log is
preserved as `logs/video44-before-final-journal.log`.

### COL-031 bounded control-plane measurement

Independent `control-benchmark-independent.json` (2026-10-26T16:35:53Z): actual Go
MCPGateway → SDK HTTP → MCP handler → EngineClient → Loom HTTP → migrated PGlite;
10 concurrent starts,10 concurrent status reads,10 concurrent cancels,30 requests total,
0 errors. Observed p95: start199.186ms, status222.690ms, cancel191.950ms, all below the
unchanged3000ms threshold. CPU reported AMD EPYC9V74,9 logical CPUs,GOMAXPROCS9.
End-of-workload RSS snapshots: Go49,106,944 bytes, Loom784,556,032 bytes; **not peak RSS**.
Schema/connections were warm. This is a synthetic control-plane measurement, not
platform/media/model throughput, production scale, queue-processing latency, or a pilot.

Reproduce from `backend`:

```sh
FLOW_VIDEO_CROSSLAYER_TEST=1 FLOW_VIDEO_CONTROL_BENCHMARK=1 \
VIDEO_QA_CONTROL_REPORT=/tmp/control-benchmark.json \
go test ./internal/flow -run '^TestVideoQACrossLanguageGateway$' -count=1 -v
```
