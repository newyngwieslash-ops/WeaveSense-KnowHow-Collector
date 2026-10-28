import { test, expect } from '@playwright/test';
import { selectCandidateOption } from './fullstack-skill-lifecycle.mjs';

// These tests render the real application and its existing routes in Chromium.
// HTTP responses are explicit synthetic fixtures, not a live platform/Go/LLM E2E.
// No product component, router, state store or browser persistence API is mocked.
const user = { id: 'browser-reviewer', username: 'browser-reviewer', displayName: 'Browser reviewer', role: 'user', status: 'active' };
const profile = { id: 'vp_browser', name: 'Synthetic review domain', version: 1, content_hash: 'a'.repeat(64), config: { questions: ['What does the source support?'], required_capabilities: ['transcript'] } };
const features = { welcomeEnabled: false, taskCenterEnabled: false, creditsEnabled: false, pluginCenterEnabled: false, shortDramaEnabled: false, inspirationSourcesVisible: false };

async function fixtures(page, options = {}) {
  const state = { authenticated: options.authenticated !== false, profileFailure: false, writes: [], unknown: [], errors: [], profiles: [profile], sources: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  // Match the HTTP API prefix, not Vite's /src/services/api/*.ts modules.
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const method = request.method();
    const send = (data, status = 200) => route.fulfill({ status, json: { code: status === 200 ? 0 : status, data, msg: status === 200 ? '' : 'Synthetic permission failure' } });
    if (path === '/auth/session') return send({ user: state.authenticated ? user : null, features });
    if (path === '/auth/settings') return send({ registrationEnabled: false, linuxdoEnabled: false });
    if (path === '/features') return send({ features });
    if (path === '/public/appearance') return send({ appearance: {} });
    if (path === '/model-catalog') return send({ source: 'system', models: [], channels: [] });
    if (path === '/user-data/snapshot') return send({ assets: [], projects: [] });
    if (path === '/assets') return send({ assets: [], total: 0, hasMore: false });
    if (path === '/resources/storage-usage' && method === 'GET') return send({ usage: { usedBytes: 0, totalBytes: 1073741824 } });
    if (path === '/canvas-projects') return send({ projects: [], total: 0, hasMore: false });
    if (path === '/asset-folders') return send({ folders: [] });
    if (path === '/plugins') return send({ plugins: [], states: {} });
    if (path === '/plugins/status') return send({ statuses: {}, states: {} });
    if (path === '/announcements') return send({ announcements: [], unreadCount: 0 });
    if (path === '/banner-announcements') return send({ banners: [] });
    if (path === '/tasks') return send([]);
    if (path === '/agent/conversations') return send([]);
    if (path === '/intelligence/workspaces') return send([{ id: 'ws_browser', tenantId: 'tn_browser', name: 'Synthetic workspace', slug: 'browser' }]);
    if (path === '/intelligence/sources' && method === 'GET') return send(state.sources);
    if (['/intelligence/monitors', '/intelligence/schedules', '/intelligence/connector-samples'].includes(path) && method === 'GET') return send([]);
    if (path.startsWith('/intelligence/')) {
      expect(request.headers()['x-workspace-id']).toBe('ws_browser');
      if (options.skillCatalog) {
        if (path === '/intelligence/skills' && method === 'GET') return send(options.skillCatalog);
        if (path === '/intelligence/knowledge/search' && method === 'POST') return send({ items: options.publishedKnowledge });
        if (path === '/intelligence/video/skill-candidates' && method === 'GET') return send({ items: [] });
        if (path === '/intelligence/video/skill-candidates' && method === 'POST') {
          state.writes.push({ path, body: request.postDataJSON(), headers: request.headers() });
          return send(null, 422); // UI serialization only, not a fabricated release.
        }
      }
      if (path === '/intelligence/sources' && method === 'POST') {
        const body = request.postDataJSON();
        state.writes.push({ path, body, headers: request.headers() });
        const source = { ...body, id: 'source_browser', status: 'active', revision: 1 };
        state.sources.push(source);
        return send(source);
      }
      if (path === '/intelligence/video/profiles' && method === 'GET') return state.profileFailure ? send(null, 403) : send({ items: state.profiles });
      if (path === '/intelligence/video/profiles' && method === 'POST') {
        state.writes.push({ path, body: request.postDataJSON(), headers: request.headers() });
        // Keep the submission in flight long enough to exercise repeated clicks.
        await new Promise(resolve => setTimeout(resolve, 350));
        if (options.rejectWrites) return send(null, 403);
        const body = request.postDataJSON();
        state.profiles = [{ ...profile, id: body.id, name: body.name, config: body.config }];
        return send(state.profiles[0]);
      }
    }
    // New endpoints cannot silently receive a successful empty response.
    state.unknown.push(`${method} ${path}`);
    return send(null, 501);
  });
  return state;
}

test('protected route redirects an unauthenticated session to the real login page', async ({ page }) => {
  const state = await fixtures(page, { authenticated: false });
  await page.goto('/intelligence/domains');
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.locator('input[type="password"]')).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.unknown).toEqual([]);
});

test('actual domain editor validates, cancels, reopens and persists one scoped submission', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/intelligence/domains');
  await expect(page.getByText(profile.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建知识域', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(dialog.locator('.ant-form-item-explain-error').first()).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await dialog.getByLabel('领域名称', { exact: true }).fill('Discard this draft');
  await dialog.getByRole('button', { name: /取\s*消/ }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '新建知识域', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('领域名称', { exact: true })).toHaveValue('');
  await dialog.getByLabel('领域名称', { exact: true }).fill('Chromium reviewed domain');
  await dialog.getByLabel('目标问题（每行一项）', { exact: true }).fill('What does the original source support?');
  const save = dialog.getByRole('button', { name: '保存新版本', exact: true });
  await save.evaluate(button => { button.click(); button.click(); });
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Chromium reviewed domain', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].headers['x-workspace-id']).toBe('ws_browser');
  expect(state.writes[0].headers['x-idempotency-key']).toBeTruthy();
  expect(state.writes[0].body.expected_version).toBe(0);
  expect(state.writes[0].body.config.review_policy).toBe('human_approval_required');
  await page.reload();
  await expect(page.getByText('Chromium reviewed domain', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.unknown).toEqual([]);
});

test('denied profile reads show an error, not a false empty success, and retry recovers', async ({ page }) => {
  const state = await fixtures(page);
  state.profileFailure = true;
  await page.goto('/intelligence/domains');
  await expect(page.getByRole('alert').filter({ hasText: '当前工作区权限不足' })).toBeVisible();
  await expect(page.getByText('尚未配置知识域', { exact: true })).not.toBeVisible();
  state.profileFailure = false;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByText(profile.name, { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.unknown).toEqual([]);
});

test('denied writes retain the draft and do not display a successful version', async ({ page }) => {
  const state = await fixtures(page, { rejectWrites: true });
  await page.goto('/intelligence/domains');
  await page.getByRole('button', { name: '新建知识域', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('领域名称', { exact: true }).fill('Unapproved draft');
  await dialog.getByLabel('目标问题（每行一项）', { exact: true }).fill('Needs approval');
  await dialog.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('当前工作区权限不足');
  await expect(dialog.getByLabel('领域名称', { exact: true })).toHaveValue('Unapproved draft');
  expect(state.writes).toHaveLength(1);
  await dialog.getByRole('button', { name: /取\s*消/ }).click();
  await expect(page.getByText(profile.name, { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.unknown).toEqual([]);
});

test('source modal dismissal and real router back/forward do not leave overlays', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/intelligence/domains');
  await expect(page.getByText(profile.name, { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '信源', exact: true }).click();
  await expect(page).toHaveURL(/\/intelligence\/sources$/);
  await page.getByRole('button', { name: '添加视频来源', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: /取\s*消/ }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/intelligence\/domains$/);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/intelligence\/sources$/);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '添加视频来源', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(state.writes).toHaveLength(0);
  expect(state.errors).toEqual([]);
  expect(state.unknown).toEqual([]);
});

test('actual source Select uses keyboard and verifies its visible selected value, not the aria-live announcement', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/intelligence/sources');
  await page.getByRole('button', { name: '添加视频来源', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '配置视频来源', exact: true });
  await modal.getByLabel('来源名称', { exact: true }).fill('Synthetic selector diagnostic');
  await modal.getByLabel('原始链接', { exact: true }).fill('https://www.bilibili.com/video/BV1test000001');
  await modal.getByLabel('平台视频 ID', { exact: true }).fill('BV1test000001');
  const selector = modal.getByLabel('冻结知识域版本', { exact: true });
  const label = `${profile.name} · v${profile.version}`;
  await selector.click();
  await expect(page.getByRole('option', { name: label, exact: true })).toBeAttached();
  await selector.press('ArrowDown');
  await selector.press('Enter');
  await expect(selector).toHaveAttribute('aria-expanded', 'false');
  await expect(modal.getByTitle(label, { exact: true })).toBeVisible();
  await modal.getByLabel('内容使用依据', { exact: true }).fill('Synthetic UI selector diagnostic; no platform or ingestion request.');
  await modal.getByRole('button', { name: '保存来源', exact: true }).click();
  await expect(modal).not.toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].path).toBe('/intelligence/sources');
  expect(state.writes[0].body.config.profile_id).toBe(profile.id);
  expect(state.writes[0].body.config.profile_version).toBe(profile.version);
  await expect(page.getByText('Synthetic selector diagnostic', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Synthetic selector diagnostic', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.unknown).toEqual([]);
});

test('actual Skill candidate virtual single and multi Select reach offscreen options and submit exact frozen identities', async ({ page }) => {
  const skills = Array.from({ length: 20 }, (_, index) => ({ id: `skill-${index}`, pack_id: 'synthetic-pack',
    name: index === 19 ? 'Evidence-bound video knowledge organization' : `Synthetic method ${index}`,
    version: '1.0.0', hash: index.toString(16).padStart(64, '0'), method: 'Synthetic UI fixture only', steps: [] }));
  const knowledge = Array.from({ length: 30 }, (_, index) => ({ id: `knowledge-${index}`, version: 1,
    state: 'published', release_id: `release-${index}`, content_hash: 'b'.repeat(64),
    unit: { title: index === 29 ? 'Synthetic 已发布知识😀e\u0301' : `Synthetic knowledge ${index}`,
      evidence: [{ evidence_id: `evidence-${index}`, revision: 1, snippet_hash: 'c'.repeat(64) }] } }));
  const state = await fixtures(page, { skillCatalog: { packs: [{ id: 'synthetic-pack', required_tools: ['intel_search_knowledge'], skills }], installed: [] }, publishedKnowledge: knowledge });
  await page.goto('/intelligence/video-skills');
  await page.getByRole('button', { name: '创建候选', exact: true }).click();
  const form = page.getByRole('dialog', { name: '创建可执行原生方法候选', exact: true });
  const base = skills.at(-1), published = knowledge.at(-1);
  await selectCandidateOption(page, form.getByLabel('基础原生版本（已部署）', { exact: true }), `${base.name} v${base.version}`, skills.length);
  await selectCandidateOption(page, form.getByLabel('冻结已发布知识与证据', { exact: true }), `${published.unit.title} v${published.version}`, knowledge.length);
  await expect(form).toBeVisible();
  await expect(form.getByText('evidence-29', { exact: false })).toBeVisible();
  await form.getByLabel('完整原生 JSON skillpack（不是 SKILL.md，服务端执行 schema 校验）', { exact: true }).fill('{}');
  await form.getByLabel('逐规则证据映射 JSON（method 与每一步均须唯一映射）', { exact: true }).fill('[]');
  await form.getByLabel('固定评测集版本', { exact: true }).fill('synthetic-select-only');
  await form.getByLabel('固定宿主模型 ID（不填写 API key）', { exact: true }).fill('synthetic-select-only');
  await form.getByLabel('固定模型预算（micro）', { exact: true }).fill('1000');
  await form.getByLabel('评测用例 JSON（positive / negative / boundary / missing_material / regression）', { exact: true }).fill('[]');
  await form.getByRole('button', { name: '冻结候选', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body.base).toEqual({ id: base.id, version: base.version, hash: base.hash, required_tools: ['intel_search_knowledge'] });
  expect(state.writes[0].body.knowledge_releases).toEqual([{ knowledge_id: published.id, version: published.version, release_id: published.release_id, content_hash: published.content_hash }]);
  expect(state.writes[0].body.evidence).toEqual(published.unit.evidence);
  expect(state.errors).toEqual([]);
  expect(state.unknown).toEqual([]);
});
