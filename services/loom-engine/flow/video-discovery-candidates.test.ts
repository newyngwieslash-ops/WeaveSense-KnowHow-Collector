// Headless scheduler -> real media coordinator -> real extractor -> disk reopen.
// Only external account feeds, subtitle bytes and model receipts are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Db } from "./db.ts";
import { Engine } from "./engine.ts";
import { canonicalHash, sha, type VideoManifest } from "./video-contract.ts";
import type { VideoProvider } from "./video-provider.ts";
import type { ExecutionContext } from "./auth.ts";
import { configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention, VideoKnowledgeService } from "./video-knowledge.ts";
import { configureVideoKnowledge } from "./video-knowledge-runtime.ts";
import { VideoKnowledgeExtractor } from "./video-knowledge-extractor.ts";

test("AC03: two headless incremental account windows persist new unapproved candidates across disk restarts", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "video-discovery-candidates-"));
  const journal = { directory: join(root, "journal"), journalId: "candidate-window-fixture", key: "synthetic-candidate-journal-key-not-production" };
  await initializeVideoDeletionJournal(journal);
  const scope = { tenant_id: "candidate_t", workspace_id: "candidate_w", actor: { type: "user", id: "reviewer" },
    scopes: ["intel.knowledge.read", "intel.knowledge.research", "intel.knowledge.write"], policy_version: "synthetic-v1" } as ExecutionContext;
  const initial = Date.now(), objects = new Map<string, Uint8Array>(), mediaCalls: string[] = [], modelCalls: string[] = [];
  let now = initial, db: Db, engine: Engine, open = false;
  const object = (job: string, data: unknown, name: string) => {
    const raw = Buffer.from(JSON.stringify(data)), digest = sha(raw);
    const ref = { object_key: `tenants/${scope.tenant_id}/workspaces/${scope.workspace_id}/video/${job}/${digest}/${name}`, sha256: digest, bytes: raw.length, content_type: "application/json" };
    objects.set(ref.object_key, raw); return ref;
  };
  const provider: VideoProvider = {
    instance: "synthetic-account-and-subtitle-provider-not-live-platform",
    discover: async source => {
      const window = now < initial + 600000 ? 1 : 2;
      const item = (index: number) => {
        const native_id = source.kind === "bilibili" ? `BV1CANDIDATE${index}` : `726000000000000000${index}`;
        return { native_id, content_version: "synthetic-v1", title: `Synthetic ${source.kind} window ${index}`,
          canonical_url: `https://www.${source.kind === "bilibili" ? "bilibili.com" : "douyin.com"}/video/${native_id}`,
          published_at: new Date(initial - 1000 + (index - 1) * 600000).toISOString() };
      };
      return { items: window === 1 ? [item(1)] : [item(2), item(1)], complete: true, next_cursor: null,
        watermark: { published_at: new Date(now).toISOString() }, mode: "fixture" };
    },
    submit: async (job, stage, _key, _profile, input) => {
      mediaCalls.push(`${job.id}:${stage.stage}`);
      const segments = [{ text: `自编字幕🧪：${job.input.platform} 的 ${job.input.native_id} 仅用于工程验证。`, start_ms: 0, end_ms: 1000 }];
      const ref = object(job.id, { kind: "manual", language: "zh", segments }, stage.stage === "input" ? "input.json" : "segments.json");
      const manifest: VideoManifest = { schema_version: 1, artifact_stage: stage.stage === "input" ? "input_ready" : "processing_complete",
        video_job_id: job.id, stage_attempt: stage.attempt, fencing_token: Number(stage.fencing_token), input_kind: "platform_subtitles",
        input_hash: input?.input_hash ?? ref.sha256, media_sha256: null, availability: "not_acquired", objects: [ref],
        coverage: { required: stage.stage === "input" ? [] : ["transcript"], completed: stage.stage === "input" ? [] : ["transcript"], missing: [], duration_ms: 1000 },
        processors: { version: "synthetic-subtitle-receipt-v1" },
        ...(stage.stage === "input" ? {} : { parent_manifest_sha256: job.input_manifest_sha256,
          transcript: { parts: [{ object_key: ref.object_key, sha256: ref.sha256, segment_count: 1, start_ms: 0, end_ms: 1000 }] } }) };
      return { task_id: `fixture-${job.id}-${stage.stage}`, state: "completed", manifest };
    },
    poll: async () => { throw new Error("completed fixture must not be polled"); }, cancel: async () => "unsupported",
    readObject: async (_scope, _job, key, maximum) => { const bytes = objects.get(key); assert.ok(bytes); assert.ok(bytes.length <= maximum); return bytes; },
  };
  async function start() {
    const pg = new PGlite(join(root, "database")); let chain: Promise<unknown> = Promise.resolve();
    db = { query: (sql, params) => pg.query(sql, params as any[]) as any,
      tx: fn => { const result = chain.then(() => pg.transaction(q => fn({ query: (sql, params) => q.query(sql, params as any[]) as any }))); chain = result.catch(() => {}); return result as any; },
      close: async () => { await pg.close(); open = false; } };
    open = true; await migrate(db);
    engine = new Engine(db, async () => { throw new Error("Live network forbidden"); }, () => new Date(now));
    engine.video.enabled = true; engine.video.provider = provider;
    engine.authorize = async ctx => ctx.grant_actor === "user:reviewer";
    configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
    await replayVideoRetentionJournal(engine);
    configureVideoKnowledge(engine, {
      resolveBase: async () => ({ id: "video-knowledge-core", version: "1.0.0", hash: sha("synthetic native method identity"), required_tools: [] }),
      modelTask: async (_scope, id, purpose, request) => {
        assert.equal(purpose, "video_knowledge_extract"); modelCalls.push(id);
        const ev = request.input.evidence[0], taskId = `synthetic-model-${id}`;
        return { task_id: taskId, status: "succeeded", reservation_id: `synthetic-receipt-${id}`, usage_ref: `model_task:${taskId}`,
          cost_micro: 1, input_hash: canonicalHash(request), model_config_hash: sha("synthetic model configuration"),
          output: { profile_id: request.input.profile_id, profile_version: request.input.profile_version, relevance: "relevant",
            knowledge_units: [{ type: "fact", title: "自编字幕工程候选", domain_tags: ["synthetic-only"], statement: ev.quote,
              claim_kind: "source_statement", applicability: [], conditions: [], steps: [], parameters: [], boundaries: [], counterexamples: [],
              missing_fields: ["real_industry_review"], evidence: [{ evidence_id: ev.evidence_id, revision: ev.revision, snippet_hash: ev.snippet_hash }] }] } };
      },
    });
  }
  t.after(async () => { if (open) await db.close(); await rm(root, { recursive: true, force: true }); });
  await start();
  const profile = await engine!.video.saveProfile(scope, { name: "Headless candidate fixture", config: {
    required_capabilities: ["transcript"], max_reconcile_items: 0, knowledge_model_id: "synthetic-unpaid-model", knowledge_budget_micro: 1000 } });
  const sources = [];
  for (const kind of ["bilibili", "douyin"]) sources.push(await engine!.createSource(scope, {
    kind, title: `Synthetic ${kind} account`, url: kind === "bilibili" ? "https://space.bilibili.com/123456" : "https://www.douyin.com/user/synthetic-account",
    config: { source_type: "account", author_id: "synthetic-account", profile_id: profile.id, profile_version: profile.version,
      usage_basis: "Self-authored fixed account/subtitle/model fixtures, no real account", allowed_uses: ["knowledge"] } }));
  const schedule = await engine!.createSchedule(scope, "user:reviewer", "synthetic-v1", { source_ids: sources.map(s => s.id), interval_seconds: 600 });
  const candidates: string[][] = [];
  for (let window = 0; window < 2; window++) {
    assert.equal(await engine!.schedulerTick(), 2);
    for (let i = 0; i < 2; i++) assert.equal((await engine!.workOnce(`discovery-${window}-${i}`))?.status, "succeeded");
    // Drive the same durable coordinator entry point as the background worker;
    // no direct ready rows, extraction rows or candidates are seeded in SQL.
    for (let i = 0; i < 4; i++) assert.ok(await engine!.video.workOnce(`media-${window}-${i}`));
    assert.equal(await engine!.video.workOnce("idle"), null);
    const jobs = (await engine!.video.list(scope)).items;
    assert.equal(jobs.length, (window + 1) * 2);
    assert.ok(jobs.every(j => j.state === "completed" && j.document_id));
    const extractor = new VideoKnowledgeExtractor(engine!);
    for (let i = 0; i < 2; i++) assert.equal(await extractor.workOnce(`extract-${window}-${i}`), true);
    assert.equal(await extractor.workOnce("idle"), false);
    const runs = (await extractor.list(scope, {})).items;
    assert.equal(runs.length, (window + 1) * 2);
    assert.ok(runs.every(r => r.state === "completed" && r.candidate_ids.length === 1));
    const k = new VideoKnowledgeService(engine!), rows = (await k.list(scope, { state: "candidate" })).items;
    assert.equal(rows.length, (window + 1) * 2); assert.ok(rows.every(r => r.approval === null && r.release_id === null));
    candidates.push(rows.map(r => r.id));
    assert.equal((await k.list(scope, {}, true)).items.length, 0, "model completion must never approve or publish candidates");
    await db!.close(); now = initial + (window + 1) * 600000; await start();
    assert.deepEqual((await new VideoKnowledgeService(engine!).list(scope, { state: "candidate" })).items.map(r => r.id), candidates[window]);
  }
  assert.equal(candidates[1].filter(id => !candidates[0].includes(id)).length, 2);
  assert.equal(mediaCalls.length, 8); assert.equal(new Set(mediaCalls).size, 8);
  assert.equal(modelCalls.length, 4); assert.equal(new Set(modelCalls).size, 4);
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_collection_runs WHERE schedule_id=$1 AND status='succeeded'", [schedule.id])).rows[0].n, 4);
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_curated'")).rows[0].n, 4);
  t.diagnostic("Real scheduler/coordinator/extractor + two disk restarts, 4 ready jobs and 4 unapproved candidates; external feeds/media/model receipts synthetic, no live platform or quality claim.");
});
