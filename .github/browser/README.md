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
prove audio/video playback, live platform acquisition, model quality, industry
acceptance or native Skill execution. Execution must be reported separately from
the existence of this harness.
