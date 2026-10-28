// Real disposable Go -> Loom -> Python -> PostgreSQL/MinIO acceptance.
// Only the input is synthetic. Never uses a model or platform acquisition.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
let phase = 'configuration';

export function longInputFixture() {
  const title = '长字幕🧪e\u0301';
  const segments = Array.from({ length: 2101 }, (_, index) => ({
    text: index === 0 ? '中'.repeat(1199) + '😀e\u0301' + '跨片段长字幕'.repeat(220) : `${index} 中文😀e\u0301 ${'材料'.repeat(100)} ${index === 2100 ? 'TAILSENTINELLONGINPUT' : '保留原文'}`,
    start_ms: index * 1000, end_ms: index === 0 ? 2101000 : (index + 1) * 1000,
  }));
  const raw = JSON.stringify({ kind: 'manual', language: 'zh', segments });
  const text = `${title}\n\n${segments.map(segment => segment.text).join('\n')}`;
  assert.ok(text.length > 400001 && Buffer.byteLength(raw) > 1000000);
  return { title, segments, raw, text };
}

export function verifyTextPage(page, offset, expected) {
  assert.equal(page.offset, offset);
  assert.equal(typeof page.text, 'string');
  assert.ok(page.text.isWellFormed());
  assert.ok(page.text.length > 0 && page.text.length <= 19999);
  assert.equal(page.text, expected.slice(offset, offset + page.text.length));
  assert.equal(page.coverage.total_chars, expected.length);
  assert.equal(page.coverage.returned_chars, page.text.length);
  const next = offset + page.text.length;
  assert.equal(page.coverage.next_offset, next < expected.length ? next : null);
  assert.equal(page.coverage.truncated, next < expected.length);
  return page.coverage.next_offset;
}

async function run() {
  assert.equal(process.env.VIDEO_FULLSTACK_TEST_ACK, 'DISPOSABLE_TEST_ONLY');
  const base = process.env.VIDEO_FULLSTACK_BASE_URL || 'http://127.0.0.1:4180';
  const url = new URL(base);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password);
  const sourceCommit = process.env.VIDEO_FULLSTACK_SOURCE_SHA;
  assert.match(sourceCommit || '', /^[a-f0-9]{40}$/);
  const state = JSON.parse(await readFile(process.env.VIDEO_FULLSTACK_STATE, 'utf8'));
  assert.ok(state.foreign?.workspaceId && state.foreign.tenantId !== state.tenantId);
  const account = state.foreign;
  let cookie;
  async function api(path, { method = 'GET', body, raw, key } = {}) {
    const response = await fetch(new URL(`/api${path}`, base), { method, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { 'X-Workspace-Id': account.workspaceId, ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'X-Idempotency-Key': key } : {}) },
      ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }) });
    const rawResponse = await response.text();
    let envelope;
    try { envelope = JSON.parse(rawResponse); } catch { throw new Error(`long_input_invalid_envelope_http_${response.status}`); }
    if (!response.ok || envelope.code !== 0) throw new Error(`long_input_api_http_${response.status}_code_${Number(envelope.code) || -1}`);
    const session = response.headers.getSetCookie().find(value => value.startsWith('open_ai_canvas_session='));
    if (session) cookie = session.split(';')[0];
    return { data: envelope.data, bytes: Buffer.byteLength(rawResponse) };
  }
  const fixture = longInputFixture();
  const report = { schema_version: 1, source_commit: sourceCommit,
    runtime: 'authenticated Go HTTP -> real Loom -> real Python worker -> PostgreSQL / MinIO',
    synthetic_boundaries: ['self-authored long Chinese/emoji/combining subtitle input'],
    real_platform_acquisition: false, real_model_quality_verified: false, real_industry_verified: false,
    browser_verified: false, production_ready: false, checks: {}, workspace_id: account.workspaceId, tenant_id: account.tenantId };
  try {
    phase = 'password_login';
    await api('/auth/login', { method: 'POST', body: { username: account.username, password: account.password } });
    assert.ok(cookie, 'real password login must establish a session');
    report.checks.authenticated_separate_tenant = true;
    phase = 'profile_and_source';
    const { data: profile } = await api('/intelligence/video/profiles', { method: 'POST', body: {
      name: 'Synthetic long subtitle acceptance', config: { language: 'zh', required_capabilities: ['transcript'], budget_micro: 10000,
        knowledge_budget_micro: 0, knowledge_model_id: '' },
    } });
    const nativeId = 'BV1LONG00001';
    const sourceURL = `https://www.bilibili.com/video/${nativeId}`;
    const { data: source } = await api('/intelligence/sources', { method: 'POST', body: { kind: 'bilibili', title: fixture.title, url: sourceURL,
      config: { source_type: 'video', native_id: nativeId, profile_id: profile.id, profile_version: profile.version,
        usage_basis: 'Self-authored synthetic subtitle; no request to a real platform or third-party media.', allowed_uses: ['knowledge'] } } });
    const input = { source_id: source.id, native_id: nativeId, canonical_url: sourceURL, title: fixture.title, content_version: 'synthetic-long-overlap-v1',
      lawful_input: { input_kind: 'platform_subtitles', bytes: Buffer.byteLength(fixture.raw), sha256: hash(fixture.raw), content_type: 'application/json' } };
    phase = 'job_and_streamed_input';
    const { data: started } = await api('/intelligence/video/jobs', { method: 'POST', body: input, key: randomUUID() });
    assert.equal(started.stage, 'awaiting_input');
    report.video_job_id = started.video_job_id; report.profile_id = profile.id; report.source_id = source.id;
    report.input_sha256 = input.lawful_input.sha256; report.input_bytes = input.lawful_input.bytes;
    await api(`/intelligence/video/jobs/${started.video_job_id}/input`, { method: 'PUT', raw: fixture.raw });
    phase = 'worker_processing';
    let ready;
    const deadline = Date.now() + 240000;
    do {
      ready = (await api(`/intelligence/video/jobs/${started.video_job_id}`)).data;
      if (['failed', 'blocked_auth', 'blocked_budget', 'reconciliation_required'].includes(ready.state)) throw new Error(`long_input_pipeline_${ready.state}`);
      if (ready.completion_level === 'knowledge_ready') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    assert.equal(ready.completion_level, 'knowledge_ready'); assert.equal(ready.input_provenance, 'authorized_user_upload');
    report.document_id = ready.document_id; report.revision = ready.revision;
    report.checks.real_worker_ready = true;
    phase = 'complete_document_paging';
    let restored = '', offset = 0, pages = 0;
    do {
      const { data: page } = await api('/intelligence/documents/read', { method: 'POST', body: {
        document_id: ready.document_id, revision: ready.revision, offset, max_chars: 19999,
      } });
      offset = verifyTextPage(page, offset, fixture.text); restored += page.text; pages++;
      assert.ok(pages <= Math.ceil(fixture.text.length / 19000) + 1, 'document paging must make bounded progress');
    } while (offset !== null);
    assert.equal(restored, fixture.text); assert.ok(pages > 20);
    report.full_text_sha256 = hash(restored); report.utf16_units = restored.length; report.document_pages = pages;
    report.checks.full_unicode_document_round_trip = true;
    phase = 'evidence_paging_and_timing';
    const evidence = []; let cursor = '0', transcriptPartCount = 0, resultPages = 0;
    do {
      const { data: page, bytes } = await api(`/intelligence/video/jobs/${ready.video_job_id}/artifacts?kind=transcript&cursor=${cursor}&limit=100`);
      assert.ok(bytes < 8000, 'normal artifact response must remain bounded');
      if (cursor === '0') transcriptPartCount = page.manifests.find(item => item.artifact_stage === 'processing_complete')?.transcript_part_count || 0;
      assert.ok(page.items.length > 0); assert.equal(page.next_cursor, evidence.length + page.items.length < fixture.segments.length ? String(evidence.length + page.items.length) : null);
      evidence.push(...page.items); cursor = page.next_cursor; resultPages++;
      assert.ok(evidence.length <= fixture.segments.length && resultPages <= fixture.segments.length);
    } while (cursor !== null);
    assert.ok(transcriptPartCount > 1); assert.equal(evidence.length, fixture.segments.length);
    assert.equal(new Set(evidence.map(item => item.evidence_id)).size, fixture.segments.length);
    let charStart = fixture.title.length + 2;
    for (const [index, item] of evidence.entries()) {
      const original = fixture.segments[index];
      assert.equal(item.char_start, charStart); assert.equal(item.char_end, charStart + original.text.length);
      assert.equal(item.start_ms, original.start_ms); assert.equal(item.end_ms, original.end_ms);
      assert.equal(item.snippet_hash, hash(original.text)); assert.ok((item.quote ?? item.quote_excerpt).isWellFormed());
      if (item.quote_complete) assert.equal(item.quote, original.text);
      charStart += original.text.length + 1;
    }
    assert.equal(evidence[0].quote_complete, false); assert.equal(evidence[0].quote_excerpt, '中'.repeat(1199));
    report.segment_count = evidence.length; report.worker_transcript_parts = transcriptPartCount; report.artifact_pages = resultPages;
    report.checks.complete_2101_segments_and_full_tail = true;
    report.checks.overlapping_caption_millisecond_envelopes = true;
    report.checks.utf16_offsets_hashes_and_safe_previews = true;
    phase = 'logout';
    await api('/auth/logout', { method: 'POST', body: {} }); cookie = undefined;
    report.passed = true;
    // Only identifiers, counts and hashes leave this script. Credentials, login
    // responses, cookies and the authored text remain out of public artifacts.
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (cookie) await api('/auth/logout', { method: 'POST', body: {} });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(() => {
  // Node AssertionError can echo full text operands. Fail without private or
  // unbounded response bodies; the service logs remain independently sanitized.
  console.log(JSON.stringify({ schema_version: 1, source_commit: /^[a-f0-9]{40}$/.test(process.env.VIDEO_FULLSTACK_SOURCE_SHA || '') ? process.env.VIDEO_FULLSTACK_SOURCE_SHA : null,
    passed: false, failed_phase: phase, real_platform_acquisition: false, production_ready: false }));
  console.error('long_input_acceptance_failed'); process.exitCode = 1;
});
