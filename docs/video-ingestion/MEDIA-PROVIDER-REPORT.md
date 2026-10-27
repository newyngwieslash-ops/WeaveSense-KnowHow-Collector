# Media/provider lane — implementation and verification

Original-task evidence, exact test commands and remaining criteria are in
`evidence/media-provider.json` (14 original task IDs; all still 待验收).
Provider source/fixture/live distinctions and exact endpoints/auth are in
`upstream-media-lock.json`. This is not a V1 acceptance or deployment report.

## Implemented

- Reused existing ASR/OCR host workers; fixed ASR 400k-character/2k-segment and
  OCR200k-character silent slicing in both workers and host client. Content parts
  have count/hash validation, explicit inline/individual-part limits and streaming
  host callbacks. Actual HTTP part serialization is canonical and hash-stable.
- New internal Python service uses durable operational-only SQLite tasks,
  signed scope/job/attempt/fence, bounded fixed-origin calls, verified streamed
  objects, input_ready→processing_complete parent hash, per-job FFmpeg workspaces,
  checkpointed ASR chunks, real decoded frame timestamps, scene+grid sampling,
  tail grids, frame OCR, typed VLM observations and derived hierarchical summaries.
- Required/optional branch coverage, speech/processed/unknown intervals, subtitle
  media_hash=null/not_acquired, actual processor/model locks and scoped usage
  receipts remain distinct from Loom's knowledge_ready decision.
- DTK requests use its actual X-API-Key contract, not an assumed Bearer header.
  Pending task handles are polled, not resubmitted. Unknown submission outcomes
  remain blocked. The pinned normalized API does not offer platform subtitles or
  independent audio; no false capability claim or imported platform cookies.
- Production ASR/OCR quantums require host-priced parent-budget admission and
  settlement. Durable result replay avoids recomputation after a lost settle
  response. True compute-outcome unknown preserves the hold and forbids retry.
- Every acknowledged intermediate object has an operational receipt; bounded
  pages can be registered by Loom for cancellation/retention cleanup. Signed
  exact-key deletion and execution-cache erasure scrub live worker content;
  erased reads return410 without renewing authorization.

## Verification

Latest audit-gap regression:45 tests passed (42 worker tests plus3 independent
shared-contract tests), log `/tmp/knowhow-media-gap-tests.log`. Covers actual
generated-media upload/range/inventory/erasure, lease+flock cleanup, storage
watermarks, paged visual/alignment records, scoped credential alias routing,
async share-link identity and fresh recheck download intent. Actual pinned local
ASR/OCR smoke re-passed after bounded FFmpeg output-spooling changes. These are
focused local proofs, not a new full cross-language/production acceptance claim.

- Initial Python service:32 tests passed, including generated FFmpeg scene transitions,
  subsecond/tail frames, isolated workspaces, chunk retry, expiry/cancel fencing,
  nine-MiB streamed object, scoped cleanup, SQLite cache erasure, VLM forged-frame
  rejection, host-model idempotency and local usage admission/unknown-hold faults.
- Host enrichment:7 tests passed. ASR:7 passed plus1 explicitly skipped optional
  image-level model test; real model was tested separately. OCR:4 passed,
  including actual installed Tesseract against generated text.
- Actual local smoke: official pinned faster-whisper-tiny CPU/int8 recognized
  generated speech and Tesseract read `WEAVE TEST 42`. Two-second silence produced
  zero segments/empty text. Speech included an honest `dog`→`log` error. This is
  neither Chinese/industry accuracy nor real Bilibili/Douyin acceptance.
- Independent QA runs the real Python production handler/SQLite/FFmpeg through
  the TS provider into Loom, with deterministic acquisition/ASR fixtures. Its
  separate evidence owns cross-language readiness and erasure results.
- The gateway agent's actual Python Gateway.local/Tasks→Go Billing→Loom fence
  test passed with two Python processes: a successful settlement response was
  deliberately lost, then the same receipt/output recovered after restart.
  Synthetic ASR/OCR each ran once, host-priced2200 micro total; over-cap work was
  blocked before compute. This is real local accounting, not paid inference.

## Pending or explicitly unsupported

1. **Pending real platform acceptance:** configure an authorized fixed DTK
   instance, minimally scoped API key and user-approved Bilibili/Douyin samples.
   No instance/account call or platform success-rate benchmark was performed.
2. **Pending release reproducibility:** Python base digest was registry-verified,
   but images were not built/deployed. Full transitive SBOM, immutable system
   packages, clean-environment build digest and production resource limits remain.
3. **Required legacy-ASR migration:** rebuilding no longer downloads floating
   `small`. Provision a read-only model directory and exact revision/file-hash
   lock per `workers/asr/README.md`. Tested tiny lock is supplied; small untested.
4. **No actual remote model acceptance:** VLM/summary adapters are tested with
   controlled host fixtures only; paid/private remote inference was outside scope.
5. **Unknown local compute:** existing synchronous ASR/OCR has no accepted-task
   output/status lookup. A billing reservation/settlement alone does not prove
   output or non-processing. Without an authoritative receipt, do not rerun it;
   hold/manual reconciliation is required. Lost admission/settle HTTP responses,
   by contrast, safely recover via the host's same-key durable idempotency.
   Final physical-erasure receipt is also refused while a local quantum is
   processing/unknown, since a late synchronous worker may still create parts.
   Logical host revocation is immediate; physical cleanup remains pending proof.
6. **Deletion scope:** live worker SQLite and registered host objects are covered.
   DTK-owned copies, external backups and objects written immediately before a
   lost acknowledgement need their own authorized retention/orphan reconciliation.

No commit, push, public deployment, platform-cookie import or upstream code
execution occurred in this lane. Downloaded public upstreams/official model
weights remain outside the repository; retained code is minimal host integration,
not BiliNote UI/Chroma/scheduler or DTK watchlist.
