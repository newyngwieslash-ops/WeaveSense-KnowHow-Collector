// Read-only TEST observer, executed from /app in the real Loom container.
// Only identity/hash/count/state evidence is printed; never credentials or text.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import pg from 'pg';
import { presignGet } from './flow/gaps9.ts';

const env = process.env;
const tenant = env.FULLSTACK_TENANT_ID;
const workspace = env.FULLSTACK_WORKSPACE_ID;
const report = { schema_version: 1, evidence_kind: 'real_test_host_observation',
  synthetic_model_boundary: true, real_platform_verified: false, real_industry_verified: false,
  observed_at: new Date().toISOString(), checks: {}, failures: [] };
const check = (name, condition) => {
  report.checks[name] = Boolean(condition);
  if (!condition) report.failures.push(name);
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 10000, statement_timeout: 15000 });
let client;
let phase = 'database_connection';
try {
  if (![tenant, workspace].every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id || ''))) throw new Error('scope_required');
  client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  const query = async (sql, args = [tenant, workspace]) => (await client.query(sql, args)).rows;
  phase = 'database_snapshot';
  report.database = (await query(`SELECT current_database() AS database,current_user AS role,
    r.rolsuper AS superuser,r.rolbypassrls AS bypass_rls,current_setting('server_version_num') AS version
    FROM pg_roles r WHERE r.rolname=current_user`, []))[0];
  check('postgres_non_superuser_non_bypassrls', report.database && !report.database.superuser && !report.database.bypass_rls);
  report.migrations = (await query('SELECT name FROM flow_schema_migrations ORDER BY name', [])).map(row => row.name);
  const expectedMigrations = (await readdir('./flow/migrations')).filter(name => name.endsWith('.sql')).sort();
  check('all_checked_source_migrations_applied', JSON.stringify(report.migrations) === JSON.stringify(expectedMigrations));
  report.rls = await query(`SELECT relname AS table_name,relrowsecurity AS enabled,relforcerowsecurity AS forced
    FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname`,
    [['flow_video_jobs', 'flow_video_stages', 'flow_video_objects', 'flow_video_knowledge_runs', 'flow_knowledge_units', 'flow_knowledge_releases']]);
  check('video_and_knowledge_rls_forced', report.rls.length === 6 && report.rls.every(row => row.enabled && row.forced));
  report.jobs = await query(`SELECT id,operation_id,source_id,asset_id,state,stage,completion_level,document_id,revision,
    input_manifest_sha256,processing_manifest_sha256,verified_input_hash,verified_media_sha256,
    processing_identity,available_capabilities FROM flow_video_jobs
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY id LIMIT 100`);
  report.stages = await query(`SELECT video_job_id,stage,state,attempt,fencing_token FROM flow_video_stages
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY video_job_id,stage LIMIT 200`);
  report.manifests = await query(`SELECT video_job_id,artifact_stage,sha256 FROM flow_video_manifests
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY video_job_id,artifact_stage LIMIT 200`);
  const revisions = await query(`SELECT r.document_id,r.revision,r.content_hash,r.material_type,r.video_manifest_sha256,r.title,r.body
    FROM flow_document_revisions r JOIN flow_documents d ON d.id=r.document_id AND d.tenant_id=r.tenant_id
    WHERE d.tenant_id=$1 AND d.workspace_id=$2 AND d.video_asset_id IS NOT NULL ORDER BY r.document_id,r.revision LIMIT 100`);
  report.revisions = revisions.map(({ title, body, ...row }) => ({ ...row, content_hash_verified: hash(`${title}\n\n${body}`) === row.content_hash }));
  const evidence = await query(`SELECT e.id,e.document_id,e.revision,e.snippet_hash,e.quote,t.video_job_id,t.start_ms,t.end_ms,t.alignment_method,t.material_type
    FROM flow_evidence e JOIN flow_video_temporal_evidence t ON t.evidence_id=e.id AND t.tenant_id=e.tenant_id AND t.workspace_id=e.workspace_id
    WHERE e.tenant_id=$1 AND e.workspace_id=$2 ORDER BY e.id LIMIT 100`);
  report.evidence = evidence.map(({ quote, ...row }) => ({ ...row, snippet_hash_verified: hash(quote) === row.snippet_hash }));
  report.extractions = await query(`SELECT id,video_job_id,document_id,revision,state,input_hash,external_task_id,candidate_ids,model_config_hash
    FROM flow_video_knowledge_runs WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY id LIMIT 100`);
  report.knowledge = await query(`SELECT id,version,content_hash,state,release_id FROM flow_knowledge_units
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY id LIMIT 100`);
  report.reviews = await query(`SELECT knowledge_id,version,content_hash,decision FROM flow_knowledge_reviews
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY knowledge_id,created_at,id LIMIT 100`);
  report.releases = await query(`SELECT id,knowledge_id,version,content_hash,revoked_at IS NOT NULL AS revoked FROM flow_knowledge_releases
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY id LIMIT 100`);
  report.skill_candidates = await query(`SELECT id,candidate_hash,native_skill_hash,state,
    jsonb_array_length(receipts) AS receipt_count FROM flow_video_skill_candidates
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY id LIMIT 100`);
  // Identity and scorer metadata only: never retain case input, model output or
  // frozen method/evidence content in uploaded observation artifacts.
  report.skill_evaluation_tasks = await query(`SELECT candidate_id,case_id,variant,task_id,state,generation,
    model_request->>'key' AS request_key,result->>'run_id' AS run_id,result->>'usage_ref' AS usage_ref,
    result->>'actual_model_config_hash' AS model_config_hash,result->>'scorer' AS scorer,
    result->>'passed' AS passed FROM flow_video_skill_eval_tasks
    WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY candidate_id,case_id,variant LIMIT 100`);
  report.objects = await query(`SELECT video_job_id,object_id,object_key,sha256,bytes,content_type,state,replica_object_key
    FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY object_key LIMIT 100`);
  report.ready_events = await query(`SELECT job_id,type,count(*)::int AS count FROM flow_outbox
    WHERE tenant_id=$1 AND workspace_id=$2 AND type='video.knowledge_ready' GROUP BY job_id,type ORDER BY job_id`);
  await client.query('COMMIT');

  const completed = report.jobs.filter(job => job.state === 'completed' && job.completion_level === 'knowledge_ready' && job.document_id);
  const rejectedInputs = report.jobs.filter(job => job.stage === 'awaiting_input' && !job.document_id && job.completion_level !== 'knowledge_ready');
  check('real_material_job_completed', completed.length === 1 && report.jobs.length === 2);
  check('invalid_upload_has_no_document_or_ready_state', rejectedInputs.length >= 1 && rejectedInputs.every(job =>
    !report.evidence.some(row => row.video_job_id === job.id) && !report.manifests.some(row => row.video_job_id === job.id)
    && !report.ready_events.some(row => row.job_id === job.id)));
  check('success_has_both_worker_manifests', completed.every(job => ['input_ready', 'processing_complete'].every(stage =>
    report.manifests.some(row => row.video_job_id === job.id && row.artifact_stage === stage))));
  check('success_has_document_revision_and_temporal_evidence', completed.every(job =>
    report.revisions.some(row => row.document_id === job.document_id && row.revision === job.revision)
    && report.evidence.some(row => row.video_job_id === job.id && Number(row.start_ms) === 0 && Number(row.end_ms) === 4000)));
  check('database_content_and_snippet_hashes_match', report.revisions.length > 0 && report.evidence.length > 0
    && report.revisions.every(row => row.content_hash_verified) && report.evidence.every(row => row.snippet_hash_verified));
  check('one_ready_event_per_success', completed.every(job => report.ready_events.some(row => row.job_id === job.id && row.count === 1)));
  check('real_model_extraction_created_candidates', report.extractions.some(row => row.state === 'completed' && row.external_task_id
    && /^[a-f0-9]{64}$/.test(row.model_config_hash || '') && row.candidate_ids.length > 0));
  check('explicit_review_and_publication_persisted', report.releases.length >= 1 && report.releases.every(release =>
    report.knowledge.some(row => row.id === release.knowledge_id && row.content_hash === release.content_hash)
    && ['submit', 'approve'].every(decision => report.reviews.some(row => row.knowledge_id === release.knowledge_id && row.decision === decision))));
  check('skill_candidate_has_sixty_real_completed_comparisons_without_deployment', report.skill_candidates.length === 1
    && report.skill_candidates[0].receipt_count === 0 && report.skill_evaluation_tasks.length === 60
    && new Set(report.skill_evaluation_tasks.map(task => task.task_id)).size === 60
    && report.skill_evaluation_tasks.every(task => task.candidate_id === report.skill_candidates[0].id
      && task.state === 'completed' && task.generation === 0 && task.run_id === task.task_id
      && task.usage_ref === `model_task:${task.task_id}` && task.scorer === 'exact_expected_output_v1'
      && task.passed === 'true' && /^[a-f0-9]{64}$/.test(task.model_config_hash || '')));

  const accepted = report.objects.filter(object => object.state === 'accepted');
  phase = 'minio_object_verification';
  check('actual_object_store_artifacts_exist', accepted.length >= 2);
  for (const object of accepted) {
    const key = object.replica_object_key || object.object_key;
    if (!key.startsWith(`tenants/${tenant}/workspaces/${workspace}/video/`) || key.includes('..') || Number(object.bytes) > 10 * 1024 * 1024) throw new Error('observer_object_bounds');
    // Signed URL stays in memory only. No credentials, response text or query is logged.
    const url = presignGet({ endpoint: env.MINIO_ENDPOINT, bucket: env.MINIO_BUCKET, key,
      accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY, region: env.MINIO_REGION });
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    const digest = createHash('sha256'); let bytes = 0;
    if (response.ok && response.body) {
      for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 10 * 1024 * 1024) throw new Error('observer_object_bounds'); digest.update(chunk); }
    } else { await response.body?.cancel(); }
    object.observed_bytes = bytes;
    object.observed_sha256 = digest.digest('hex');
    object.verified = response.ok && bytes === Number(object.bytes) && object.observed_sha256 === object.sha256;
  }
  check('accepted_object_bytes_and_hashes_match_minio', accepted.length > 0 && accepted.every(object => object.verified));

  phase = 'model_fixture_receipt';
  const modelURL = new URL(env.FLOW_MODEL_GATEWAY_URL || 'http://provider-fixture:8800/v1');
  if (modelURL.hostname !== 'provider-fixture' || modelURL.port !== '8800') throw new Error('observer_fixture_origin');
  modelURL.pathname = '/__fixture/evidence'; modelURL.search = ''; modelURL.hash = '';
  const receipt = await fetch(modelURL, { headers: { authorization: `Bearer ${env.FLOW_MODEL_GATEWAY_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!receipt.ok) throw new Error('observer_fixture_receipt');
  report.model_boundary = await receipt.json();
  check('actual_go_gateway_reached_synthetic_model', report.model_boundary.synthetic_model_boundary === true
    && report.model_boundary.real_model_quality_verified === false && report.model_boundary.unique_model_calls >= 1);
  const nativeCalls = report.model_boundary.calls.filter(call => call.request_kind === 'native_canvas');
  check('actual_native_canvas_model_call_once', nativeCalls.length === 1 && nativeCalls[0].requests === 1
    && /^[a-f0-9]{64}$/.test(nativeCalls[0].skill?.hash || '') && nativeCalls[0].knowledge_snapshot?.run_id);
  check('hostile_model_tool_calls_emitted_but_exfiltration_not_dispatched', nativeCalls.length === 1
    && nativeCalls[0].attack_tool_calls === 2 && report.model_boundary.exfiltration_requests === 0);
  const evaluationCalls = report.model_boundary.calls.filter(call => call.request_kind === 'skill_evaluation');
  check('all_skill_comparisons_reached_go_managed_gateway_once', evaluationCalls.length === 60
    && evaluationCalls.every(call => call.requests === 1)
    && report.skill_evaluation_tasks.every(task => evaluationCalls.some(call =>
      call.call_id === `video-model:${hash(JSON.stringify([workspace, task.candidate_id, task.request_key]))}`
      && call.case_id === task.case_id && call.variant === task.variant
      && call.candidate_hash === report.skill_candidates[0]?.candidate_hash)));
  // Excludes lifecycle state and revocation, allowing before/after withdrawal comparison.
  report.stable_identity_sha256 = hash(JSON.stringify({
    jobs: report.jobs.map(({ id, document_id, revision, input_manifest_sha256, processing_manifest_sha256 }) => ({ id, document_id, revision, input_manifest_sha256, processing_manifest_sha256 })),
    manifests: report.manifests, revisions: report.revisions, evidence: report.evidence,
    objects: report.objects.map(({ object_id, sha256, bytes }) => ({ object_id, sha256, bytes })),
    knowledge: report.knowledge.map(({ id, version, content_hash }) => ({ id, version, content_hash })),
    releases: report.releases.map(({ id, knowledge_id, version, content_hash }) => ({ id, knowledge_id, version, content_hash })),
  }));
} catch (error) {
  // Raw connection/HTTP errors may contain URLs; do not print them into artifacts.
  report.failures.push('observer_execution_failed');
  report.failed_phase = phase;
  if (/^[A-Z0-9]{5}$/.test(error?.code || '')) report.database_error_code = error.code;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end();
}
report.passed = report.failures.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
