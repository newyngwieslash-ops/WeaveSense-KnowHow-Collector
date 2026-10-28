import test from 'node:test';
import assert from 'node:assert/strict';
import { longInputFixture, verifyTextPage } from './long-input.mjs';

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
