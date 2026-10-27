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
retry, denied mutation preserving draft, source modal dismissal and browser history.
Trace, screenshots on failure and JSON/HTML reports are CI artifacts.

The legacy Go `TestGeneratedAssetBrowserIdentity` is a different optional external
Node-runner test; it is not these Chromium tests and remains separately disclosed.
