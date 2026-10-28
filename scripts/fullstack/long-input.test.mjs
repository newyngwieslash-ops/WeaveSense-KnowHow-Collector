import test from 'node:test';
import assert from 'node:assert/strict';
import { longInputFixture, verifyTextPage, longInputProfileRequest, LongInputAPIError, safeLongInputFailure } from './long-input.mjs';

test('long-input profile mutation supplies a unique explicit host idempotency key and zero model budget', () => {
  const first = longInputProfileRequest(), second = longInputProfileRequest();
  assert.equal(first.method, 'POST'); assert.match(first.key, /^[a-f0-9-]{36}$/); assert.notEqual(first.key, second.key);
  assert.equal(first.body.config.knowledge_budget_micro, 0); assert.equal(first.body.config.knowledge_model_id, '');
  assert.equal(first.body.config.language, 'zh'); assert.deepEqual(first.body, second.body);
});

test('failure diagnostics retain only numeric status and allowlisted machine reasons, never bodies or assertion operands', () => {
  assert.deepEqual(safeLongInputFailure(new LongInputAPIError(400, 400, 'idempotency_key_required')),
    { kind: 'api_error', http_status: 400, code: 400, reason: 'idempotency_key_required' });
  const secret = 'private_cookie_and_auth_payload';
  const error = new LongInputAPIError(secret, secret, secret);
  error.body = secret; error.message = secret;
  assert.deepEqual(safeLongInputFailure(error), { kind: 'api_error', http_status: null, code: null, reason: 'unlisted_reason' });
  const assertion = Object.assign(new Error(secret), { code: 'ERR_ASSERTION', actual: secret, expected: secret });
  assert.deepEqual(safeLongInputFailure(assertion), { kind: 'assertion_failed' });
  assert.ok(!JSON.stringify([safeLongInputFailure(error), safeLongInputFailure(assertion)]).includes(secret));
});

test('long input fixture exceeds legacy text and segment bounds with overlapping Unicode material', () => {
  const fixture = longInputFixture();
  assert.equal(fixture.segments.length, 2101); assert.equal(fixture.text.length, 459242);
  assert.ok(fixture.text.isWellFormed()); assert.ok(fixture.raw.includes('TAILSENTINELLONGINPUT'));
  assert.equal(fixture.segments[0].end_ms, fixture.segments.at(-1).end_ms);
});

test('fullstack pagination verifier rejects skipped, repeated, truncated or split Unicode pages', () => {
  const expected = '前😀后e\u0301尾';
  const good = { offset: 0, text: '前😀', coverage: { total_chars: expected.length, returned_chars: 3, next_offset: 3, truncated: true } };
  assert.equal(verifyTextPage(good, 0, expected), 3);
  for (const change of [{ offset: 1 }, { text: '前\ud83d' }, { text: '前后' }, { text: '' },
    { coverage: { ...good.coverage, next_offset: 0 } }, { coverage: { ...good.coverage, total_chars: expected.length - 1 } },
    { coverage: { ...good.coverage, next_offset: null, truncated: false } }]) {
    assert.throws(() => verifyTextPage({ ...good, ...change }, 0, expected));
  }
});
