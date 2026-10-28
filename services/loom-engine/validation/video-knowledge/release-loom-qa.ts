// Independent release boundary fixture. Real domain lifecycle and durable DB;
// Seeded evidence, external model and reviewer are synthetic, not business
// acceptance. The evaluator, gateway, billing and release domain are real.
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrate, type Db } from "../../flow/db.ts";
import { Engine } from "../../flow/engine.ts";
import { handler } from "../../flow/server.ts";
import { sha } from "../../flow/video-contract.ts";
import { VideoKnowledgeService, applyVideoRetention } from "../../flow/video-knowledge.ts";
import { VideoKnowledgeSkills } from "../../flow/video-knowledge-skills.ts";
import { EVAL_KINDS } from "../../flow/video-knowledge-contract.ts";
import { VideoKnowledgeEvaluator } from "../../flow/video-knowledge-evaluator.ts";
import { closeKnowledgeBudget } from "../../flow/video-knowledge-budget.ts";
import { sign } from "../../flow/auth.ts";
import { configureVideoKnowledge, platformKnowledgeRuntime } from "../../flow/video-knowledge-runtime.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "../../flow/video-journal.ts";

const directory = process.env.VIDEO_QA_RELEASE_DIR!, signingKey = process.env.VIDEO_QA_SIGNING_KEY!;
if (!directory || signingKey.length < 32 || !process.env.VIDEO_QA_HOST_URL) throw Error("explicit QA configuration required");
const mode = process.argv[2], pg = new PGlite(join(directory, "database"));
let chain: Promise<unknown> = Promise.resolve();
const db: Db = { query: (s, p) => pg.query(s, p as any[]) as any,
  tx(fn) { const next = chain.then(() => pg.transaction(t => fn({ query: (s, p) => t.query(s, p as any[]) as any }))); chain = next.catch(() => {}); return next as any; }, close: () => pg.close() };
await migrate(db);
const engine = new Engine(db); engine.video.enabled = true;
const journal = { directory: join(directory, "journal"), journalId: "qa-native-release", key: signingKey };
if (mode === "export") await initializeVideoDeletionJournal(journal);
configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
await replayVideoRetentionJournal(engine);
const runtime = platformKnowledgeRuntime({ baseURL: process.env.VIDEO_QA_HOST_URL!, signingKey, audience: "flow-platform" });
configureVideoKnowledge(engine, runtime);
const scope = { ...JSON.parse(process.env.VIDEO_QA_SCOPE!), actor: { type: "user", id: "u_alice" }, policy_version: "qa_v1",
  scopes: ["intel.knowledge.read", "intel.knowledge.research", "intel.knowledge.write", "intel.knowledge.review", "intel.knowledge.publish", "intel.skills.release", "intel.skills.evaluate", "intel.skills.deploy", "intel.skills.install"] };
const k = new VideoKnowledgeService(engine), skills = new VideoKnowledgeSkills(k);
const server = createServer(handler(engine, { signingKey, audience: "loom-engine", issuer: "flow-platform" }));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const stop = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
async function api(path: string, input: any, key: string, expected = 200) {
  const token = sign(signingKey, { ...scope, iss: "flow-platform", aud: "loom-engine" });
  const response = await fetch(url + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-idempotency-key": key }, body: JSON.stringify(input) });
  const body: any = await response.json();
  if (response.status !== expected) throw Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body.data;
}
if (mode === "export") {
  process.stdout.write(url + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => { process.stdin.pause(); resolve(); }));
  const native = await runtime.resolveBase!(scope, { id: "video-knowledge-core", version: "1.0.0" });
  const method = { id: native.id, version: native.version, hash: native.hash };
  const body = "QA synthetic evidence 😀; not industry advice", title = "QA release fixture";
  await db.query(`INSERT INTO flow_video_profiles(id,tenant_id,workspace_id,version,name,config,content_hash,created_by) VALUES('qa-release-profile',$1,$2,1,'QA','{}',$3,'fixture')`, [scope.tenant_id, scope.workspace_id, sha("profile")]);
  await db.query(`INSERT INTO flow_sources(id,tenant_id,workspace_id,kind,url,config) VALUES('qa-release-source',$1,$2,'bilibili','https://www.bilibili.com/video/BV1QARELEASE','{"allowed_uses":["knowledge"]}')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,canonical_url,origin_cluster) VALUES('qa-release-asset',$1,$2,'bilibili','BV1QARELEASE','https://www.bilibili.com/video/BV1QARELEASE','qa-original')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_asset_sources(tenant_id,workspace_id,asset_id,source_id) VALUES($1,$2,'qa-release-asset','qa-release-source')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title,video_asset_id,video_text_access_expires_at,video_text_max_expires_at) VALUES('qa-release-doc',$1,$2,'qa-release-source','qa','https://www.bilibili.com/video/BV1QARELEASE',$3,'qa-release-asset','2030-01-01','2030-01-01')`, [scope.tenant_id, scope.workspace_id, title]);
  await db.query(`INSERT INTO flow_document_revisions(document_id,revision,tenant_id,content_hash,title,body,collected_by_run,material_type) VALUES('qa-release-doc',1,$1,$2,$3,$4,'fixture','platform_subtitles')`, [scope.tenant_id, sha(title + "\n\n" + body), title, body]);
  await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url) VALUES('qa-release-evidence',$1,$2,'qa-release-doc',1,$3,$4,$5,'fixture',$6,'https://www.bilibili.com/video/BV1QARELEASE')`, [scope.tenant_id, scope.workspace_id, title.length + 2, title.length + 2 + body.length, body, sha(body)]);
  const evidence = [{ evidence_id: "qa-release-evidence", revision: 1, snippet_hash: sha(body) }];
  let knowledge = await k.create(scope, "qa-release-knowledge", { profile_id: "qa-release-profile", profile_version: 1, method,
    unit: { type: "fact", title, domain_tags: ["qa-only"], statement: body, claim_kind: "source_statement", applicability: [], conditions: [], steps: [], parameters: [], boundaries: [], counterexamples: [], missing_fields: ["industry_validation"], evidence, valid_from: null, valid_until: null, conflict_key: "qa-release" } });
  const preKnowledge = () => ({ expected_version: knowledge.version, expected_hash: knowledge.content_hash, reason: "Synthetic QA reviewer, not human industry acceptance" });
  knowledge = await k.review(scope, knowledge.id, "submit", { ...preKnowledge(), decision: "submit" });
  knowledge = await k.review(scope, knowledge.id, "approve", { ...preKnowledge(), decision: "approve", checks: { evidence_support: true, critical_fields: true } });
  knowledge = await k.publish(scope, knowledge.id, "publish", preKnowledge());
  const summaries = [];
  for (const version of ["1.0.0", "2.0.0"]) {
  const input = { base: { ...method, required_tools: native.required_tools },
    pack: { id: "qa-loom-release", version, name: "Synthetic domain export", required_tools: ["intel_search_knowledge"], mcp_requirements: [],
      skills: [{ id: "qa-loom-method", version, name: "Synthetic domain method", method: `Use published evidence only; test version ${version}`, steps: ["Keep provenance"], references: [], output_schema: { type: "object", required: ["claims"], properties: { claims: { type: "array" } } } }] },
    knowledge_releases: [{ knowledge_id: knowledge.id, version: knowledge.version, release_id: knowledge.release_id, content_hash: knowledge.content_hash }], evidence,
    rule_evidence: [{ rule: "method", evidence_ids: [evidence[0].evidence_id] }, { rule: "step:0", evidence_ids: [evidence[0].evidence_id] }],
    eval_spec: { dataset_version: "qa-synthetic-not-gold", model_config: { model: "fixture-release-model", budget_micro: 6000000, max_tokens: 200 }, cases: Array.from({ length: 20 }, (_, i) => ({ id: `case-${i}`, kind: EVAL_KINDS[i % EVAL_KINDS.length], input: "QA synthetic case, not industry gold", expected: "fixture" })) } };
  let candidate = await api("/v1/video/skill-candidates", input, `qa-native-candidate-${version}`, 201);
  const pre = { expected_hash: candidate.candidate_hash };
  await api(`/v1/video/skill-candidates/${candidate.id}/review`, { ...pre, decision: "approve", reason: "Premature approval must fail" }, "premature-review", 409);
  candidate = await api(`/v1/video/skill-candidates/${candidate.id}/evaluation-request`, pre, "request-real-evaluator");
  const evaluator = new VideoKnowledgeEvaluator(engine), deadline = Date.now() + 120000;
  while (candidate.state === "evaluation_running" && Date.now() < deadline) {
    const worked = await evaluator.workOnce("qa-real-evaluator");
    candidate = await skills.row(scope, candidate.id);
    if (candidate.eval_result?.blocked_reason) throw Error(`actual evaluation blocked: ${JSON.stringify(candidate.eval_result)}`);
    if (!worked) await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (candidate.state !== "passed" || candidate.eval_result.scorer !== "exact_expected_output_v1") throw Error(`actual evaluator failed: ${JSON.stringify(candidate.eval_result)}`);
  const tasks = (await db.query(`SELECT case_id,variant,task_id,result FROM flow_video_skill_eval_tasks WHERE candidate_id=$1 ORDER BY case_id,variant`, [candidate.id])).rows;
  if (tasks.length !== 60 || tasks.some(t => t.result.usage_ref !== `model_task:${t.task_id}`)) throw Error("real model-task receipts incomplete");
  await closeKnowledgeBudget(engine, "video_skill_evaluate");
  candidate = await api(`/v1/video/skill-candidates/${candidate.id}/review`, { ...pre, decision: "approve", reason: "Synthetic reviewer only; actual evaluator over synthetic model responses, not industry acceptance" }, "synthetic-review");
  if (candidate.state !== "approved_for_release" || candidate.receipts.length) throw Error("approval confused with deployment");
  candidate = await api(`/v1/video/skill-candidates/${candidate.id}/export`, pre, "actual-domain-export");
  if (candidate.release_package.deployment_status !== "not_deployed") throw Error("export confused with deployment");
  await writeFile(join(directory, `candidate-${version}.json`), JSON.stringify(candidate));
  summaries.push({ version, candidate_id: candidate.id, native_skill_hash: candidate.native_skill_hash, candidate_hash: candidate.candidate_hash, tasks, budget_close_receipt: candidate.budget_close_receipt });
  }
  await writeFile(join(directory, "knowledge.json"), JSON.stringify(knowledge));
  await writeFile(join(directory, "evaluation-evidence.json"), JSON.stringify({ fixture_only: true, cases_per_version: 20, versions: summaries }));
  await stop(); process.stdout.write("EXPORTED_REAL_DOMAIN_FIXTURE\n");
} else if (mode === "serve") {
  for (const version of ["1.0.0", "2.0.0"]) {
    const candidate = JSON.parse(await readFile(join(directory, `candidate-${version}.json`), "utf8"));
    if (!["release_package_exported", "workspace_installed"].includes((await skills.get(scope, candidate.id)).state)) throw Error("durable exported or installed candidate missing");
  }
  process.stdout.write(url + "\n");
  process.once("SIGINT", () => { void stop().then(() => process.exit(0)); }); process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
} else throw Error("export or serve required");
