import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Real authenticated host routes. No synthetic host, approval authority,
// database rows or model-selected tools are substituted by this harness.
// The deterministic upstream is a model protocol fixture, not a real LLM.
async function host(page, state, path, { method = 'GET', body } = {}) {
  return page.evaluate(async ({ workspaceId, path, method, body }) => {
    const response = await fetch(`/api${path}`, { method, credentials: 'same-origin',
      headers: { 'X-Workspace-Id': workspaceId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = await response.json();
    return { status: response.status, ...envelope };
  }, { workspaceId: state.workspaceId, path, method, body });
}

function data(response, label) {
  expect(response.status, `${label}: ${response.reason || response.msg}`).toBeLessThan(300);
  expect(response.status, label).toBeGreaterThanOrEqual(200);
  expect(response.code, label).toBe(0);
  return response.data;
}

async function invoke(page, state, conversationId, callId, name, args) {
  return data(await host(page, state, `/agent/conversations/${conversationId}/tool-calls`, {
    method: 'POST', body: { callId, name, arguments: args },
  }), name);
}

function successful(result, label) {
  expect(result.status, `${label}: ${result.error}`).toBe('succeeded');
  expect(result.truncated, label).not.toBe(true);
  return result.output;
}

function exactRefs(output, expected) {
  expect(output.knowledge_units).toHaveLength(1);
  expect(output.knowledge_units[0].evidence).toEqual(expected.map(({ evidence_id, revision, snippet_hash }) => ({ evidence_id, revision, snippet_hash })));
}

export async function exerciseNativeSkill(page, state, evidence) {
  const catalog = data(await host(page, state, '/intelligence/skills'), 'native catalog');
  const skill = catalog.packs.find(pack => pack.id === 'video-knowledge-core')?.skills.find(item => item.id === 'video-knowledge-core');
  expect(skill?.version).toBe('1.0.0');
  expect(skill?.hash).toMatch(/^[a-f0-9]{64}$/);
  const ref = { id: skill.id, version: skill.version, hash: skill.hash };
  data(await host(page, state, '/intelligence/skills/install', { method: 'POST', body: { skillId: skill.id, version: skill.version } }), 'native install');
  const conversation = data(await host(page, state, '/agent/conversations', { method: 'POST', body: {
    subject: { kind: 'intelligence_workspace', id: state.workspaceId }, title: 'Synthetic native evidence acceptance',
  } }), 'intelligence conversation');
  const loaded = successful(await invoke(page, state, conversation.id, 'native-load-initial', 'intel_load_skill', { skill_id: skill.id }), 'native load');
  expect({ id: loaded.id, version: loaded.version, hash: loaded.hash }).toEqual(ref);
  expect(loaded.knowledge_snapshot.method).toEqual(ref);
  expect(loaded.knowledge_snapshot.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(loaded.knowledge_snapshot.run_id).toBe(`conv:${conversation.id}`);
  const search = successful(await invoke(page, state, conversation.id, 'native-search', 'intel_search_knowledge', { query: '', profile_id: evidence.profile_id, limit: 10 }), 'native published search');
  expect(search.material_scope).toBe('published_knowledge_only');
  expect(search.fallback_used).toBe(false);
  expect(search.items.map(item => item.id)).toContain(evidence.knowledge_id);
  const knowledge = successful(await invoke(page, state, conversation.id, 'native-read', 'intel_read_knowledge', { knowledge_id: evidence.knowledge_id }), 'native evidence read');
  expect(knowledge.content_hash).toBe(evidence.knowledge_hash);
  expect(knowledge.evidence.map(item => item.evidence_id)).toEqual(evidence.evidence.map(item => item.evidence_id));
  const input = { profile_id: evidence.profile_id, profile_version: evidence.profile_version,
    material_scope: { document_ids: [evidence.document_id] },
    evidence: knowledge.evidence.map(item => ({ evidence_id: item.evidence_id, revision: item.revision, snippet_hash: item.snippet_hash,
      quote: item.quote, document_id: item.document_id })) };
  expect(input.evidence[0].quote).toMatch(/^Synthetic fixture:/);
  const canvasId = `native-${randomUUID()}`;
  const mutation = data(await host(page, state, `/canvas-projects/${canvasId}/operations`, { method: 'PATCH', body: {
    mutationId: randomUUID(), baseRevision: 0, operations: [
      { type: 'create_canvas', id: canvasId, patch: { title: 'Synthetic video native Skill acceptance' } },
      { type: 'create_node', node: { id: 'native-input', type: 'data-source', x: 0, y: 0, width: 320, height: 200,
        metadata: { dataSource: { format: 'json', rawText: JSON.stringify([input]) } } } },
      { type: 'create_node', node: { id: 'native-skill', type: 'skill', x: 400, y: 0, width: 320, height: 200,
        metadata: { skillId: skill.id, skillVersion: skill.version, skillHash: skill.hash } } },
      { type: 'create_connection', connection: { id: 'native-edge', fromNodeId: 'native-input', toNodeId: 'native-skill' } },
    ],
  } }), 'persistent native canvas');
  const approval = data(await host(page, state, `/canvas-workflows/${canvasId}/approvals`, { method: 'POST', body: {
    expected_revision: mutation.project.revision, ops: [], run: { budget_micro: 100000 },
  } }), 'actual Canvas approval request');
  expect(approval.status).toBe('waiting_approval');
  const runBody = { agent_run_id: approval.agent_run_id, approval_id: approval.approval_id };
  expect((await host(page, state, `/canvas-workflows/${canvasId}/run`, { method: 'POST', body: runBody })).status).toBeGreaterThanOrEqual(400);
  data(await host(page, state, `/agent/runs/${approval.agent_run_id}/approvals/${approval.approval_id}/decision`, {
    method: 'POST', body: { decision: 'approve', reason: 'Authorized disposable synthetic TEST only' },
  }), 'actual Canvas approval decision');
  const admitted = data(await host(page, state, `/canvas-workflows/${canvasId}/run`, { method: 'POST', body: runBody }), 'approved native execution');
  let result;
  await expect.poll(async () => {
    result = data(await host(page, state, `/canvas-workflows/${canvasId}/runs/${admitted.run_id}`), 'native workflow result');
    if (['failed', 'cancelled'].includes(result.status)) throw new Error(`Native workflow ${result.status}: ${JSON.stringify(result.result || result.error)}`);
    return result.status;
  }, { timeout: 120000, intervals: [500, 1000, 2000] }).toBe('succeeded');
  const node = result.result.nodes['native-skill'];
  expect(node.skill.skill).toEqual(ref);
  expect(node.skill.status).toBe('succeeded');
  expect(node.skill.task_status).toBe('succeeded');
  expect(node.skill.prompt_hash).toMatch(/^[a-f0-9]{64}$/);
  exactRefs(node.skill.output, evidence.evidence);
  const replay = data(await host(page, state, `/canvas-workflows/${canvasId}/run`, { method: 'POST', body: runBody }), 'native execution replay');
  expect(replay.run_id).toBe(admitted.run_id);
  const saved = data(await host(page, state, `/canvas-projects/${canvasId}`), 'saved native Canvas').project;
  exactRefs(saved.nodes.find(item => item.id === 'native-skill').metadata.skillOutput, evidence.evidence);
  evidence.native = { mode: 'authenticated Agent tool bridge + actual CloudAgent approval + managed Canvas runtime',
    not_claimed: ['LLM autonomous tool selection', 'real model quality'], skill: ref,
    conversation_id: conversation.id, intelligence_snapshot: loaded.knowledge_snapshot,
    canvas_id: canvasId, agent_run_id: approval.agent_run_id, approval_id: approval.approval_id,
    workflow_run_id: admitted.run_id, task_id: node.skill.task_id, prompt_hash: node.skill.prompt_hash,
    request_hash: node.skill.request_hash, canvas_revision: saved.revision,
    evidence: node.skill.output.knowledge_units[0].evidence };
  evidence.checks.intelligence_native_version_hash_snapshot_and_host_evidence = true;
  evidence.checks.canvas_real_approval_managed_native_execution_and_idempotent_replay = true;
}

export async function verifyNativeAfterRestart(page, state, evidence) {
  expect(evidence.native).toBeTruthy();
  const pin = evidence.native;
  const loaded = successful(await invoke(page, state, pin.conversation_id, 'native-load-restarted', 'intel_load_skill', { skill_id: pin.skill.id }), 'restarted native load');
  expect({ id: loaded.id, version: loaded.version, hash: loaded.hash }).toEqual(pin.skill);
  expect(loaded.knowledge_snapshot).toEqual(pin.intelligence_snapshot);
  const result = data(await host(page, state, `/canvas-workflows/${pin.canvas_id}/runs/${pin.workflow_run_id}`), 'restarted native result');
  expect(result.status).toBe('succeeded');
  expect(result.result.nodes['native-skill'].skill.task_id).toBe(pin.task_id);
  expect(result.result.nodes['native-skill'].skill.prompt_hash).toBe(pin.prompt_hash);
  exactRefs(result.result.nodes['native-skill'].skill.output, evidence.evidence);
  evidence.checks.native_pins_snapshot_task_output_survive_actual_restart = true;
}

export async function verifyNativeAfterWithdrawal(page, state, evidence) {
  // Reuse the exact original call IDs: persisted old tool results must not bypass
  // current publication withdrawal, even for a frozen native knowledge snapshot.
  const pin = evidence.native;
  const search = successful(await invoke(page, state, pin.conversation_id, 'native-search', 'intel_search_knowledge', { query: '', profile_id: evidence.profile_id, limit: 10 }), 'withdrawn native search');
  expect(search.items).toEqual([]);
  expect(search.fallback_used).toBe(false);
  const read = await invoke(page, state, pin.conversation_id, 'native-read', 'intel_read_knowledge', { knowledge_id: evidence.knowledge_id });
  expect(read.status).toBe('failed');
  expect(read.output?.data?.unit).toBeFalsy();
  evidence.checks.native_pinned_search_and_same_call_read_recheck_current_withdrawal = true;
}
