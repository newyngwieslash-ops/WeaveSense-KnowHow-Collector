# Real-browser CI boundary

`npm ci --ignore-scripts && npx playwright install --with-deps chromium && npm test`
from this directory starts the repository's actual Vite application and navigates
its existing `/intelligence` routes in Chromium. Install the locked Web dependencies
with Bun first. The separate npm lock here does not modify `web/bun.lock`.

These are **browser interaction tests with synthetic HTTP fixtures**, not a claim
of live Bilibili/Douyin, Go authentication, knowledge quality or end-to-end industry
acceptance. The real router, React components, forms, persistent browser stores,
session hydration and shared HTTP client are exercised. No alternate HTML page or
test-only product route is installed. Unexpected API calls and uncaught page errors
fail; permission denials are explicit negative fixtures.

Coverage: unauthenticated routing, required-field validation, cancel/reopen, duplicate
submission guard, workspace/idempotency headers, reload after save, denied read and
retry, denied mutation preserving draft, source modal dismissal and browser history,
and virtual profile selection with persisted source configuration (not aria-live text).
Trace, screenshots on failure and JSON/HTML reports are CI artifacts.

The candidate Select regression also checks offscreen single/multiple options,
the exact frozen identities submitted, and the parent dialog staying open. In
[job 122933538159](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40721555588/job/122933538159),
the helper read a stale `aria-expanded=true` just after a single-select Enter.
By the time its Escape arrived the popup had closed, so Escape dismissed the
parent modal. The fix follows the declared selection mode rather than this
time-of-check/time-of-use snapshot: single selection waits for its normal close;
multiple selection closes its popup only after the selected value is committed.
This is test-driver synchronization, not a product permission or state change.
It must not be replaced by force-clicks, longer timeouts, hidden UI bypasses or
automatic retries that hide a failed attempt.

The legacy Go `TestGeneratedAssetBrowserIdentity` is a different optional external
Node-runner test; it is not these Chromium tests and remains separately disclosed.

## Isolated live-stack acceptance

`playwright.fullstack.config.mjs` is a separate, non-mocked suite for the built
application on the loopback TEST Compose stack. It never starts Vite or intercepts
application routes. The runner invokes it twice, first to publish synthetic
knowledge, then after a real service restart to verify persistence and withdraw it:

```sh
export VIDEO_FULLSTACK_BASE_URL=http://127.0.0.1:4180
export VIDEO_FULLSTACK_STATE=/private/test-run/state.json
export VIDEO_FULLSTACK_SOURCE_SHA="$(git rev-parse HEAD)"
node fullstack-bootstrap.mjs
# Configure only the returned temporary workspace in the TEST stack allowlist.
npx playwright test --config playwright.fullstack.config.mjs
# Restart the real TEST services using the deployment runner, not a browser reload.
VIDEO_FULLSTACK_PHASE=restart npx playwright test --config playwright.fullstack.config.mjs
```

Bootstrap refuses a non-clean database and uses supported first-admin registration,
lazy personal-workspace provisioning and logout. The private state contains only
that disposable account's credentials and IDs; never upload it as an artifact.
`VIDEO_FULLSTACK_RESULT` optionally names the sanitized result JSON (default:
`result.json` beside state). There are no Playwright traces, videos, HAR files or
automatic login screenshots, since these could retain secrets.

This suite creates the profile/source through the real UI. Lawful timed-subtitle
ingest uses authenticated same-origin browser HTTP calls to the existing Go API
because the existing UI has no upload control; it is **not UI upload-form evidence**.
The real Python worker persists and processes the uploaded bytes through MinIO and
Loom/PostgreSQL. Only the model provider response is synthetic. Review, approval,
publication, ordinary search, fixed-revision evidence and withdrawal use the real
host UI. Subtitle-only input must report no acquired media or player; this does not
prove audio/video playback, live platform acquisition, model quality or industry
acceptance. The additional `fullstack-native.mjs` and
`fullstack-skill-lifecycle.mjs` paths exercise actual Agent/Canvas authorization,
managed native execution, frozen candidate evaluation and restart/withdrawal
receipts; their external model remains synthetic. Actual execution evidence is
recorded separately from the existence of these scripts in
[`V1-CLOSURE.md`](../../docs/video-ingestion/V1-CLOSURE.md).
