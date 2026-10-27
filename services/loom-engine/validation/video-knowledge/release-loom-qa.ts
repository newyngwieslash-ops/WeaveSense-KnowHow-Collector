// Independent release boundary fixture. Real domain lifecycle and durable DB;
// seeded evidence/evaluator/reviewer are synthetic, not business acceptance.
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
import { knowledgeHash, EVAL_KINDS } from "../../flow/video-knowledge-contract.ts";
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
if (mode === "export") {
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
  const input = { base: { ...method, required_tools: native.required_tools },
    pack: { id: "qa-loom-release", version: "1.0.0", name: "Synthetic domain export", required_tools: ["intel_search_knowledge"], mcp_requirements: [],
      skills: [{ id: "qa-loom-method", version: "1.0.0", name: "Synthetic domain method", method: "Use published evidence only", steps: ["Keep provenance"], references: [], output_schema: { type: "object", required: ["claims"], properties: { claims: { type: "array" } } } }] },
    knowledge_releases: [{ knowledge_id: knowledge.id, version: knowledge.version, release_id: knowledge.release_id, content_hash: knowledge.content_hash }], evidence,
    rule_evidence: [{ rule: "method", evidence_ids: [evidence[0].evidence_id] }, { rule: "step:0", evidence_ids: [evidence[0].evidence_id] }],
    eval_spec: { dataset_version: "qa-synthetic-not-gold", model_config: { model: "fixture-no-model" }, cases: EVAL_KINDS.map((kind, i) => ({ id: `case-${i}`, kind, input: "QA", expected: "fixture" })) } };
  let candidate = await skills.create(scope, "qa-native-candidate", input);
  const pre = { expected_hash: candidate.candidate_hash };
  candidate = await skills.requestEvaluation(scope, candidate.id, "request-fixture-eval", pre);
  const report = { candidate_hash: candidate.candidate_hash, eval_spec_hash: knowledgeHash(input.eval_spec), model_config_hash: knowledgeHash(input.eval_spec.model_config), actual_model_config_hash: "b".repeat(64), dataset_version: input.eval_spec.dataset_version, base_hash: method.hash,
    cases: input.eval_spec.cases.map(c => ({ id: c.id, input_hash: knowledgeHash({ input: c.input, expected: c.expected }), critical_failure: false,
      ...Object.fromEntries(["base", "without_skill", "candidate"].map(v => [v, { score: 1, passed: true, run_id: `qa-fixture-${v}`, usage_ref: "qa-fixture-not-billing", actual_model_config_hash: "b".repeat(64) }])) })) };
  candidate = await skills.evaluate({ ...scope, actor: { type: "service_principal", id: "video-model-evaluator" } }, candidate.id, "synthetic-eval", { ...pre, report });
  candidate = await skills.review(scope, candidate.id, "synthetic-review", { ...pre, decision: "approve", reason: "Synthetic fixture only, not human industry acceptance" });
  candidate = await skills.export(scope, candidate.id, "actual-domain-export", pre);
  await writeFile(join(directory, "candidate.json"), JSON.stringify(candidate));
  await writeFile(join(directory, "knowledge.json"), JSON.stringify(knowledge));
  await db.close(); process.stdout.write("EXPORTED_REAL_DOMAIN_FIXTURE\n");
} else if (mode === "serve") {
  const candidate = JSON.parse(await readFile(join(directory, "candidate.json"), "utf8"));
  if ((await skills.get(scope, candidate.id)).state !== "release_package_exported") throw Error("durable export missing");
  const server = createServer(handler(engine, { signingKey, audience: "loom-engine", issuer: "flow-platform" }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.stdout.write(`http://127.0.0.1:${(server.address() as any).port}\n`);
  const stop = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); process.exit(0); };
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
} else throw Error("export or serve required");
