import { expect } from '@playwright/test';

// Actual host UI and authenticated production APIs. Only the external model
// responses, source text and reviewer account are synthetic TEST inputs.
async function api(page, state, path) {
  const result = await page.evaluate(async ({ workspaceId, path }) => {
    const response = await fetch(`/api/intelligence${path}`, { credentials: 'same-origin', headers: { 'X-Workspace-Id': workspaceId } });
    return { status: response.status, ...await response.json() };
  }, { workspaceId: state.workspaceId, path });
  expect(result.status, `candidate API ${path}`).toBe(200);
  expect(result.code).toBe(0);
  return result.data;
}

async function mutation(page, action, suffix) {
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() === 'POST'),
    action(),
  ]);
  const result = await response.json();
  expect(response.ok(), JSON.stringify({ status: response.status(), reason: result.reason })).toBe(true);
  expect(result.code).toBe(0);
  return result.data;
}

export async function selectCandidateOption(page, control, label, optionCount, { multiple = false } = {}) {
  expect(Number.isSafeInteger(optionCount) && optionCount > 0 && optionCount <= 1000).toBe(true);
  await control.click();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  // Virtual Select only mounts the current viewport. Navigate its real
  // combobox, then verify the active option's full label before selecting it.
  for (let index = 0; index < optionCount; index++) {
    await expect(control).toHaveAttribute('aria-activedescendant', /.+/);
    const activeId = await control.getAttribute('aria-activedescendant');
    const active = page.locator(`[id=${JSON.stringify(activeId)}]`);
    await expect(active).toBeAttached();
    if (await active.getAttribute('aria-label') === label) {
      await control.press('Enter');
      const select = control.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
      await expect(select.getByTitle(label, { exact: true })).toBeVisible();
      // Single Select closes asynchronously after Enter. Never infer its mode
      // from a transient aria-expanded read: a late Escape can close the modal.
      if (multiple) {
        await expect(control).toHaveAttribute('aria-expanded', 'true');
        await control.press('Escape');
      }
      await expect(control).toHaveAttribute('aria-expanded', 'false');
      await expect(control.locator('xpath=ancestor::*[@role="dialog"][1]')).toBeVisible();
      return;
    }
    if (index + 1 < optionCount) {
      await control.press('ArrowDown');
      await expect(control).not.toHaveAttribute('aria-activedescendant', activeId);
    }
  }
  throw new Error(`Candidate Select did not contain the expected option: ${label}`);
}

export async function exerciseSkillCandidate(page, state, evidence) {
  const catalog = await api(page, state, '/skills');
  const base = catalog.packs.find(p => p.id === 'video-knowledge-core')?.skills.find(s => s.id === 'video-knowledge-core');
  expect(base?.hash).toBe(evidence.native.skill.hash);
  const kinds = ['positive', 'negative', 'boundary', 'missing_material', 'regression'];
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `synthetic-skill-${String(i).padStart(2, '0')}`, kind: kinds[i % kinds.length],
    input: `Synthetic Skill evaluation fixture: ${kinds[i % kinds.length]}`,
    expected: `Synthetic fixture: ${['negative', 'missing_material'].includes(kinds[i % kinds.length]) ? 'insufficient material.' : 'evidence acknowledged.'}` }));
  const pack = { id: 'fullstack-synthetic-method', version: '1.0.0', name: 'Synthetic browser release fixture',
    required_tools: ['intel_search_knowledge'], mcp_requirements: [], skills: [{ id: 'fullstack-synthetic-method', version: '1.0.0',
      name: 'Synthetic browser method', method: 'Use only published synthetic evidence; disclose missing material.', steps: ['Preserve evidence identity'], references: [],
      output_schema: { type: 'object', required: ['claims'], properties: { claims: { type: 'array' } } } }] };
  await page.goto('/intelligence/video-skills');
  await expect(page.getByRole('button', { name: '创建候选', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '创建候选', exact: true }).click();
  const form = page.getByRole('dialog', { name: '创建可执行原生方法候选', exact: true });
  await selectCandidateOption(page, form.getByLabel('基础原生版本（已部署）', { exact: true }), `${base.name} v${base.version}`, catalog.packs.flatMap(p => p.skills).length, { multiple: false });
  await selectCandidateOption(page, form.getByLabel('冻结已发布知识与证据', { exact: true }), `${evidence.knowledge_title} v${evidence.knowledge_version}`, 30, { multiple: true });
  await form.getByLabel('完整原生 JSON skillpack（不是 SKILL.md，服务端执行 schema 校验）', { exact: true }).fill(JSON.stringify(pack));
  await form.getByLabel('逐规则证据映射 JSON（method 与每一步均须唯一映射）', { exact: true }).fill(JSON.stringify([
    { rule: 'method', evidence_ids: [evidence.evidence[0].evidence_id] }, { rule: 'step:0', evidence_ids: [evidence.evidence[0].evidence_id] },
  ]));
  await form.getByLabel('固定评测集版本', { exact: true }).fill('synthetic-browser-not-industry-gold-v1');
  await form.getByLabel('固定宿主模型 ID（不填写 API key）', { exact: true }).fill(process.env.VIDEO_FULLSTACK_MODEL || 'fullstack-synthetic');
  // Admission prices the full frozen base template, not the cheap fixture reply.
  await form.getByLabel('固定模型预算（micro）', { exact: true }).fill('3000000');
  await form.getByLabel('单次输出 token 上限', { exact: true }).fill('200');
  await form.getByLabel('评测用例 JSON（positive / negative / boundary / missing_material / regression）', { exact: true }).fill(JSON.stringify(cases));
  let candidate = await mutation(page, () => form.getByRole('button', { name: '冻结候选', exact: true }).click(), '/video/skill-candidates');
  await expect(form).not.toBeVisible();
  const detail = page.getByRole('dialog', { name: '方法候选审阅', exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: '批准发布候选', exact: true })).toBeDisabled();
  await expect(detail.getByRole('button', { name: '安装 / 回滚到此候选版本', exact: true })).toBeDisabled();
  expect(candidate.state).toBe('draft');
  expect(candidate.proposal.evidence).toEqual(evidence.evidence.map(({ evidence_id, revision, snippet_hash }) => ({ evidence_id, revision, snippet_hash })));
  const frozenHash = candidate.candidate_hash;
  await mutation(page, () => detail.getByRole('button', { name: '请求固定评测', exact: true }).click(), `/video/skill-candidates/${candidate.id}/evaluation-request`);
  await expect.poll(async () => {
    candidate = await api(page, state, `/video/skill-candidates/${candidate.id}`);
    if (candidate.eval_result?.blocked_reason || candidate.state === 'rejected') throw new Error(`Real evaluation blocked/rejected: ${JSON.stringify(candidate.eval_result)}`);
    return candidate.state;
  }, { timeout: 180000, intervals: [500, 1000, 2000] }).toBe('passed');
  expect(candidate.candidate_hash).toBe(frozenHash);
  expect(candidate.eval_result.scorer).toBe('exact_expected_output_v1');
  expect(candidate.eval_result.cases).toHaveLength(20);
  const runs = candidate.eval_result.cases.flatMap(c => ['base', 'without_skill', 'candidate'].map(variant => ({ case_id: c.id, variant, ...c[variant] })));
  expect(new Set(runs.map(r => r.run_id)).size).toBe(60);
  for (const run of runs) {
    expect(run.passed).toBe(true);
    expect(run.usage_ref).toBe(`model_task:${run.run_id}`);
    expect(run.actual_model_config_hash).toBe(candidate.eval_result.actual_model_config_hash);
  }
  await detail.getByRole('button', { name: '刷新实际状态', exact: true }).click();
  await expect(detail.getByText('评测通过', { exact: true })).toBeVisible();
  await expect(detail.getByRole('columnheader', { name: '原版本', exact: true })).toBeVisible();
  await expect(detail.getByRole('columnheader', { name: '无 Skill', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '批准发布候选', exact: true }).click();
  const approval = page.getByRole('dialog', { name: '批准候选进入源控发布', exact: true });
  await expect(approval.getByRole('button', { name: /^(确\s*定|OK)$/ })).toBeDisabled();
  await approval.getByLabel('方法候选审阅理由', { exact: true }).fill('Disposable TEST reviewer of synthetic cases; not industry acceptance or production approval.');
  await mutation(page, () => approval.getByRole('button', { name: /^(确\s*定|OK)$/ }).click(), `/video/skill-candidates/${candidate.id}/review`);
  await expect(approval).not.toBeVisible();
  await expect(detail.getByText('已批准发布', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '安装 / 回滚到此候选版本', exact: true })).toBeDisabled();
  await mutation(page, () => detail.getByRole('button', { name: '生成源控发布包', exact: true }).click(), `/video/skill-candidates/${candidate.id}/export`);
  await expect(detail.getByText('源控发布包已导出', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '安装 / 回滚到此候选版本', exact: true })).toBeDisabled();
  candidate = await api(page, state, `/video/skill-candidates/${candidate.id}`);
  expect(candidate.release_package.deployment_status).toBe('not_deployed');
  expect(candidate.receipts).toHaveLength(0);
  expect(candidate.approval.candidate_hash).toBe(frozenHash);
  const current = await api(page, state, '/skills');
  expect(current.packs.flatMap(p => p.skills).some(s => s.id === pack.skills[0].id)).toBe(false);
  expect(current.installed.find(i => i.skillId === base.id)?.hash).toBe(base.hash);
  evidence.skill_candidate = { id: candidate.id, candidate_hash: frozenHash, native_skill_hash: candidate.native_skill_hash,
    eval_dataset: candidate.proposal.eval_spec.dataset_version, actual_model_config_hash: candidate.eval_result.actual_model_config_hash,
    case_count: 20, variant_count: 3, task_count: 60, task_ids: runs.map(r => r.run_id),
    state: candidate.state, deployment_status: 'not_deployed', not_claimed: ['industry evaluation', 'candidate container deployment', 'production installation'] };
  evidence.checks.skill_candidate_ui_real_evaluation_approval_export_without_false_install = true;
  await detail.getByRole('button', { name: /^(关闭|close)$/i }).click();
  await expect(detail).not.toBeVisible();
}

export async function verifySkillCandidateAfterRestart(page, state, evidence) {
  const expected = evidence.skill_candidate;
  expect(expected).toBeTruthy();
  const candidate = await api(page, state, `/video/skill-candidates/${expected.id}`);
  expect(candidate.state).toBe('release_package_exported');
  expect(candidate.candidate_hash).toBe(expected.candidate_hash);
  expect(candidate.native_skill_hash).toBe(expected.native_skill_hash);
  expect(candidate.eval_result.cases).toHaveLength(20);
  expect(candidate.receipts).toHaveLength(0);
  evidence.checks.skill_candidate_evaluation_and_export_durable_after_restart = true;
}

export async function verifySkillCandidateAfterWithdrawal(page, state, evidence) {
  const candidate = await api(page, state, `/video/skill-candidates/${evidence.skill_candidate.id}`);
  expect(candidate.state).toBe('retired');
  expect(candidate.unavailable).toBe(true);
  expect(candidate.proposal).toBeNull();
  expect(candidate.release_package).toBeNull();
  await page.goto('/intelligence/video-skills');
  const row = page.locator('.ant-list-item').filter({ hasText: evidence.skill_candidate.id });
  await row.getByRole('button', { name: '审阅版本与评测', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '方法候选审阅', exact: true });
  await expect(detail.getByText('候选内容或依赖已不可用', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '安装 / 回滚到此候选版本', exact: true })).toHaveCount(0);
  evidence.checks.withdrawal_retires_exported_skill_candidate_and_removes_install_ui = true;
  await detail.getByRole('button', { name: /^(关闭|close)$/i }).click();
}
