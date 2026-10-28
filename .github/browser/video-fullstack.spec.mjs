import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Live production routes only: no route interception, injected session, in-memory
// engine or direct database writes. The model upstream alone is synthetic.
const statePath = process.env.VIDEO_FULLSTACK_STATE;
const phase = process.env.VIDEO_FULLSTACK_PHASE || 'initial';
const quote = 'Synthetic fixture: the reference temperature is 20 degrees Celsius.';
const model = process.env.VIDEO_FULLSTACK_MODEL || 'fullstack-synthetic';
const nativeId = 'BV1test000001';
const sourceURL = `https://www.bilibili.com/video/${nativeId}`;
const digest = value => createHash('sha256').update(value).digest('hex');

async function browserAPI(page, workspaceId, path, { method = 'GET', body, raw, key, anonymous = false } = {}) {
  return page.evaluate(async args => {
    const response = await fetch(`/api/intelligence${args.path}`, {
      method: args.method,
      credentials: args.anonymous ? 'omit' : 'same-origin',
      headers: {
        'X-Workspace-Id': args.workspaceId,
        ...(args.body === undefined && args.raw === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(args.key ? { 'X-Idempotency-Key': args.key } : {}),
      },
      ...(args.raw === undefined ? args.body === undefined ? {} : { body: JSON.stringify(args.body) } : { body: args.raw }),
    });
    const envelope = await response.json();
    return { status: response.status, code: envelope.code, data: envelope.data, reason: envelope.reason || envelope.msg };
  }, { workspaceId, path, method, body, raw, key, anonymous });
}

function accepted(response, label) {
  expect(response.status, `${label}: ${response.reason}`).toBeGreaterThanOrEqual(200);
  expect(response.status, `${label}: ${response.reason}`).toBeLessThan(300);
  expect(response.code, label).toBe(0);
  return response.data;
}

async function login(page, credentials) {
  await page.goto('/intelligence/domains');
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('用户名 / 邮箱', { exact: true }).fill(credentials.username);
  await page.locator('#login-password').fill(credentials.password);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login' && r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(/\/intelligence\/domains$/);
  await expect(page.getByRole('button', { name: '新建知识域', exact: true })).toBeEnabled();
}

async function saveProfile(page) {
  await page.getByRole('button', { name: '新建知识域', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '新建知识域', exact: true });
  await modal.getByLabel('领域名称', { exact: true }).fill('Synthetic full-stack domain');
  await modal.getByLabel('目标问题（每行一项）', { exact: true }).fill('What reference temperature is stated in this synthetic fixture?');
  await modal.getByLabel('每任务预算（micro，0 不代表无限额）', { exact: true }).fill('10000');
  await modal.getByLabel('宿主知识整理模型 ID（须为已配置可用模型）', { exact: true }).fill(model);
  await modal.getByLabel('资料就绪后知识整理总预算（micro）', { exact: true }).fill('10000');
  await modal.getByLabel('每次整理输出 token 上限', { exact: true }).fill('1000');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/intelligence/video/profiles' && r.request().method() === 'POST');
  await modal.getByRole('button', { name: '保存新版本', exact: true }).click();
  const out = await response;
  expect(out.ok()).toBe(true);
  const envelope = await out.json();
  expect(envelope.code).toBe(0);
  await expect(modal).not.toBeVisible();
  await expect(page.getByText('Synthetic full-stack domain', { exact: true })).toBeVisible();
  return envelope.data;
}

async function saveSource(page, profile) {
  await page.goto('/intelligence/sources');
  await page.getByRole('button', { name: '添加视频来源', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '配置视频来源', exact: true });
  await modal.getByLabel('来源名称', { exact: true }).fill('Synthetic lawful-input source (not a platform acquisition)');
  await modal.getByLabel('原始链接', { exact: true }).fill(sourceURL);
  await modal.getByLabel('平台视频 ID', { exact: true }).fill(nativeId);
  await modal.getByLabel('冻结知识域版本', { exact: true }).click();
  await page.getByRole('option', { name: `${profile.name} · v${profile.version}`, exact: true }).click();
  await modal.getByLabel('内容使用依据', { exact: true }).fill('Self-authored synthetic test subtitle; no platform request, account or rights assertion about real media.');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/intelligence/sources' && r.request().method() === 'POST');
  await modal.getByRole('button', { name: '保存来源', exact: true }).click();
  const out = await response;
  expect(out.ok()).toBe(true);
  const envelope = await out.json();
  expect(envelope.code).toBe(0);
  await expect(modal).not.toBeVisible();
  return envelope.data;
}

async function decision(page, action, title, approve = false) {
  const detail = page.getByRole('dialog', { name: '知识复核与发布', exact: true });
  await detail.getByRole('button', { name: action, exact: true }).click();
  const modal = page.getByRole('dialog', { name: title, exact: true });
  await modal.getByLabel('复核或发布理由', { exact: true }).fill('Isolated engineering acceptance of self-authored synthetic source; not industry validation.');
  if (approve) {
    await modal.getByRole('checkbox', { name: '我已核对原文证据支持该结论', exact: true }).check();
    await modal.getByRole('checkbox', { name: '我已核对关键数值、单位与适用条件', exact: true }).check();
  }
  await modal.getByRole('button', { name: /^(确\s*定|OK)$/ }).click();
  await expect(modal).not.toBeVisible();
}

async function publishedUI(page, title) {
  await page.goto('/intelligence/video-knowledge');
  await expect(page.getByText('普通检索只返回有效的已发布知识', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '检索已发布知识', exact: true }).fill('Synthetic');
  await page.getByRole('textbox', { name: '检索已发布知识', exact: true }).press('Enter');
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看与复核', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '知识复核与发布', exact: true });
  await detail.getByRole('button', { name: '核对原文与时间', exact: true }).first().click();
  const evidence = page.getByRole('dialog', { name: '时间轴与原文证据', exact: true });
  await expect(evidence.locator('mark')).toHaveText(quote);
  await expect(evidence.getByText('UTF-16 偏移', { exact: true })).toBeVisible();
  await evidence.getByRole('button', { name: '展开按需读取', exact: true }).click();
  await expect(evidence.getByText(quote, { exact: true }).last()).toBeVisible();
  await evidence.getByRole('tab', { name: '受权播放', exact: true }).click();
  await expect(evidence.getByText('本页没有音视频对象；字幕输入可能从未采集媒体，可继续翻页核对', { exact: true })).toBeVisible();
  // Subtitle-only input must not grow an invented player or platform URL.
  await expect(evidence.locator('video,audio')).toHaveCount(0);
  await evidence.getByRole('button', { name: /close/i }).click();
  return detail;
}

test(`live host lawful-input pipeline (${phase})`, async ({ page }, testInfo) => {
  if (!statePath) throw new Error('VIDEO_FULLSTACK_STATE is required');
  if (!/^[a-f0-9]{40}$/.test(process.env.VIDEO_FULLSTACK_SOURCE_SHA || '')) throw new Error('VIDEO_FULLSTACK_SOURCE_SHA must be the checked-out git rev-parse HEAD');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const resultPath = process.env.VIDEO_FULLSTACK_RESULT || join(dirname(statePath), 'result.json');
  const events = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/intelligence/')) events.push({ method: response.request().method(), path, status: response.status() });
  });
  const evidence = phase === 'restart' ? JSON.parse(await readFile(resultPath, 'utf8')) : {
    schema_version: 1,
    source_commit: process.env.VIDEO_FULLSTACK_SOURCE_SHA,
    runtime: 'Chromium -> built host UI / same-origin Go -> real Loom -> real Python worker -> PostgreSQL / MinIO',
    synthetic_boundaries: ['self-authored timed subtitle input', 'deterministic model HTTP provider'],
    not_claimed: ['real platform acquisition', 'ASR accuracy', 'audio/video playback', 'industry quality', 'native Skill execution', 'production deployment'],
    workspace_id: state.workspaceId, tenant_id: state.tenantId,
    checks: {},
  };
  try {
    await login(page, state);
    evidence.checks[`${phase}_real_password_login`] = true;
    const api = (path, options) => browserAPI(page, state.workspaceId, path, options);
    if (phase === 'initial') {
      const profile = await saveProfile(page);
      const source = await saveSource(page, profile);
      evidence.profile_id = profile.id;
      evidence.profile_version = profile.version;
      evidence.profile_hash = profile.content_hash;
      evidence.source_id = source.id;
      evidence.checks.ui_profile_and_source_creation = true;

      const raw = JSON.stringify({ kind: 'manual', language: 'en', segments: [{ text: quote, start_ms: 0, end_ms: 4000 }] });
      const input = { source_id: source.id, native_id: nativeId, canonical_url: sourceURL, profile_id: profile.id, profile_version: profile.version,
        lawful_input: { input_kind: 'platform_subtitles', sha256: digest(raw), bytes: Buffer.byteLength(raw), content_type: 'application/json' } };
      const key = randomUUID();
      const job = accepted(await api('/video/jobs', { method: 'POST', body: input, key }), 'lawful start');
      evidence.video_job_id = job.video_job_id;
      evidence.operation_id = job.operation_id;
      evidence.input_sha256 = input.lawful_input.sha256;
      expect(job.stage).toBe('awaiting_input');
      const replay = accepted(await api('/video/jobs', { method: 'POST', body: input, key }), 'same-key replay');
      expect(replay.video_job_id).toBe(job.video_job_id);
      expect((await api('/video/jobs', { method: 'POST', body: { ...input, content_version: 'changed' }, key })).status).toBe(409);
      evidence.checks.same_key_same_job_and_changed_request_conflict = true;
      const uploaded = accepted(await api(`/video/jobs/${job.video_job_id}/input`, { method: 'PUT', raw }), 'streamed lawful input');
      expect(uploaded.input_received).toBe(true);
      evidence.checks.browser_authenticated_http_ingest_not_ui_upload_form = true;
      const invalidRaw = JSON.stringify({ kind: 'manual', language: 'en', segments: [] });
      const invalidInput = { ...input, content_version: 'invalid-required-transcript', lawful_input: { ...input.lawful_input, sha256: digest(invalidRaw), bytes: Buffer.byteLength(invalidRaw) } };
      const invalidJob = accepted(await api('/video/jobs', { method: 'POST', body: invalidInput, key: randomUUID() }), 'negative lawful start');
      expect((await api(`/video/jobs/${invalidJob.video_job_id}/input`, { method: 'PUT', raw: invalidRaw })).status).toBe(422);
      const invalidResult = accepted(await api(`/video/jobs/${invalidJob.video_job_id}`), 'negative task remains blocked');
      expect(invalidResult.stage).toBe('awaiting_input');
      expect(invalidResult.completion_level).not.toBe('knowledge_ready');
      expect(invalidResult.document_id).toBeFalsy();
      evidence.invalid_input_job_id = invalidJob.video_job_id;
      evidence.checks.invalid_required_subtitle_rejected_without_ready_document = true;
      let ready;
      await expect.poll(async () => {
        ready = accepted(await api(`/video/jobs/${job.video_job_id}`), 'read real task');
        if (['failed', 'blocked_auth', 'blocked_budget', 'reconciliation_required'].includes(ready.state)) throw new Error(`Pipeline blocked: ${ready.state}/${ready.stage} (${JSON.stringify(ready.error)})`);
        return ready.completion_level;
      }, { timeout: 180000, intervals: [1000, 2000, 3000] }).toBe('knowledge_ready');
      expect(ready.input_provenance).toBe('authorized_user_upload');
      evidence.document_id = ready.document_id;
      evidence.document_revision = ready.revision;
      evidence.checks.real_worker_to_knowledge_ready = true;
      const jobs = accepted(await api(`/video/jobs?source_id=${source.id}`), 'list jobs');
      expect(jobs.items.filter(item => item.video_job_id === job.video_job_id)).toHaveLength(1);
      expect(jobs.items.map(item => item.video_job_id).sort()).toEqual([job.video_job_id, invalidJob.video_job_id].sort());
      const artifactPage = accepted(await api(`/video/jobs/${job.video_job_id}/artifacts`), 'registered artifacts');
      evidence.temporal_evidence_count = artifactPage.items.length;
      expect(evidence.temporal_evidence_count).toBeGreaterThan(0);
      evidence.manifests = artifactPage.manifests;
      expect(artifactPage.manifests.reduce((total, item) => total + item.object_count, 0)).toBeGreaterThan(0);
      expect(artifactPage.manifests.some(item => item.input_kind === 'platform_subtitles' && item.availability === 'not_acquired')).toBe(true);
      evidence.media_availability = 'not_acquired';
      const revision = accepted(await api(`/documents/${ready.document_id}/revisions/${ready.revision}`), 'immutable document');
      expect(revision.body).toContain(quote);
      evidence.document_hash = revision.content_hash;

      let extraction;
      await expect.poll(async () => {
        const page = accepted(await api(`/knowledge/extractions?video_job_id=${job.video_job_id}`), 'extraction runs');
        extraction = page.items[0];
        if (extraction && ['failed', 'blocked_auth', 'blocked_budget'].includes(extraction.state)) throw new Error(`Extraction blocked: ${extraction.state} (${JSON.stringify(extraction.error)})`);
        return extraction?.state;
      }, { timeout: 120000, intervals: [1000, 2000, 3000] }).toBe('completed');
      expect(extraction.candidate_ids).toHaveLength(1);
      evidence.extraction_id = extraction.id;
      evidence.knowledge_id = extraction.candidate_ids[0];
      const recordPath = `/knowledge/${evidence.knowledge_id}`;
      const candidate = accepted(await api(`${recordPath}?mode=review`), 'candidate');
      expect(candidate.unit.statement).toBe(quote);
      expect(candidate.state).toBe('candidate');
      expect(accepted(await api('/knowledge/search', { method: 'POST', body: { q: '', limit: 30 } }), 'unpublished search').items).toHaveLength(0);
      expect((await api(recordPath)).status).toBe(404);
      expect((await api(`/video/jobs/${job.video_job_id}`, { anonymous: true })).status).toBe(401);
      expect((await browserAPI(page, `ws_outside_${randomUUID().replaceAll('-', '')}`, `/video/jobs/${job.video_job_id}`)).status).toBe(404);
      evidence.checks.unpublished_not_in_default_search = true;
      evidence.checks.anonymous_and_nonexistent_nonmember_workspace_selector_denied = true;

      await page.goto(`/intelligence/video-knowledge?review=${evidence.knowledge_id}`);
      let detail = page.getByRole('dialog', { name: '知识复核与发布', exact: true });
      await expect(detail.getByText(candidate.unit.title, { exact: true })).toBeVisible();
      await decision(page, '提交复核', '提交复核');
      await decision(page, '批准', '批准此版本', true);
      await expect(detail.getByRole('button', { name: '发布', exact: true })).toBeEnabled();
      const approved = accepted(await api(`${recordPath}?mode=review`), 'approved snapshot');
      await detail.getByRole('button', { name: '编辑为新版本', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '编辑知识 · 产生新版本并使旧批准失效', exact: true });
      await editor.getByLabel('完整知识结构 JSON', { exact: true }).fill(JSON.stringify({ ...approved.unit, title: 'Synthetic acceptance knowledge revised' }));
      await editor.getByRole('button', { name: /^(确\s*定|OK)$/ }).click();
      await expect(editor).not.toBeVisible();
      const stale = await api(`${recordPath}/publish`, { method: 'POST', key: randomUUID(), body: { expected_version: approved.version, expected_hash: approved.content_hash, reason: 'Test stale approval rejection only' } });
      expect(stale.status).toBe(409);
      evidence.checks.edit_invalidates_approval_and_stale_publish_rejected = true;
      await decision(page, '提交复核', '提交复核');
      await decision(page, '批准', '批准此版本', true);
      await decision(page, '发布', '发布此批准版本');
      const published = accepted(await api(recordPath), 'published snapshot');
      expect(published.state).toBe('published');
      evidence.knowledge_title = published.unit.title;
      evidence.knowledge_version = published.version;
      evidence.knowledge_hash = published.content_hash;
      evidence.release_id = published.release_id;
      evidence.evidence = published.evidence.map(item => ({ evidence_id: item.evidence_id, document_id: item.document_id, revision: item.revision, snippet_hash: item.snippet_hash, char_start: item.char_start, char_end: item.char_end, start_ms: item.start_ms, end_ms: item.end_ms }));
      evidence.checks.ui_review_approve_publish = true;
      await publishedUI(page, evidence.knowledge_title);
      await page.screenshot({ path: testInfo.outputPath('published-knowledge.png'), fullPage: true });
      await page.reload();
      await expect(page.getByText(evidence.knowledge_title, { exact: true })).toBeVisible();
      evidence.checks.ui_search_fixed_evidence_no_invented_media_and_reload = true;
      evidence.status = 'initial_passed_published_awaiting_real_service_restart';
    } else if (phase === 'restart') {
      expect(evidence.source_commit).toBe(process.env.VIDEO_FULLSTACK_SOURCE_SHA);
      expect(evidence.status).toBe('initial_passed_published_awaiting_real_service_restart');
      const job = accepted(await api(`/video/jobs/${evidence.video_job_id}`), 'restarted job');
      expect(job.completion_level).toBe('knowledge_ready');
      expect(job.document_id).toBe(evidence.document_id);
      const revision = accepted(await api(`/documents/${evidence.document_id}/revisions/${evidence.document_revision}`), 'restarted revision');
      expect(revision.content_hash).toBe(evidence.document_hash);
      const record = accepted(await api(`/knowledge/${evidence.knowledge_id}`), 'restarted publication');
      expect(record.content_hash).toBe(evidence.knowledge_hash);
      expect(record.release_id).toBe(evidence.release_id);
      expect(record.state).toBe('published');
      await publishedUI(page, evidence.knowledge_title);
      evidence.checks.post_service_restart_published_record_revision_evidence_durable = true;
      await decision(page, '撤回', '撤回已发布知识');
      await page.goto('/intelligence/video-knowledge');
      await expect(page.getByText('未找到已发布知识；不会回退未审核材料', { exact: true })).toBeVisible();
      expect(accepted(await api('/knowledge/search', { method: 'POST', body: { q: '', limit: 30 } }), 'withdrawn search').items).toHaveLength(0);
      const withdrawn = await api(`/knowledge/${evidence.knowledge_id}`);
      expect([404, 410]).toContain(withdrawn.status);
      await page.reload();
      await expect(page.getByText('未找到已发布知识；不会回退未审核材料', { exact: true })).toBeVisible();
      evidence.checks.ui_withdraw_removes_default_search_after_reload = true;
      evidence.status = 'passed';
      await page.screenshot({ path: testInfo.outputPath('withdrawn-default-search.png'), fullPage: true });
    } else throw new Error('VIDEO_FULLSTACK_PHASE must be initial or restart');
    expect(pageErrors).toEqual([]);
  } finally {
    evidence[`${phase}_http_observations`] = events;
    evidence[`${phase}_page_error_count`] = pageErrors.length;
    await writeFile(resultPath, JSON.stringify(evidence, null, 2));
    await testInfo.attach(`fullstack-${phase}-sanitized`, { path: resultPath, contentType: 'application/json' });
  }
});
