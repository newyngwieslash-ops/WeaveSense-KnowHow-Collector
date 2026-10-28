// Self-authored subtitles through the actual signed Python service and Loom
// HTTP APIs. No platform acquisition, model quality or Go/browser claim.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.ts";
import { migrate, pgliteDb } from "./db.ts";
import { sign } from "./auth.ts";
import { handler } from "./server.ts";
import { HTTPVideoProvider } from "./video-provider.ts";
import { canonicalTranscript, sha } from "./video-contract.ts";
import { applyVideoRetention } from "./video-knowledge.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";

test("QA AC09/12: real Python long-subtitle parts round-trip all UTF16 text, overlapping time envelopes and evidence over HTTP", { timeout: 120_000 }, async t => {
  const scope = { tenant_id: "long_input_tenant", workspace_id: "long_input_workspace", actor: { type: "user", id: "synthetic_author" }, policy_version: "long_input_v1" };
  const key = "synthetic-long-input-signing-key-over-32-bytes", token = "synthetic-long-input-service-token";
  const child = spawn("python3", ["-u", fileURLToPath(new URL("../../video-knowledge/qa_fixture_service.py", import.meta.url))], {
    env: { ...process.env, VIDEO_QA_SIGNING_KEY: key, VIDEO_QA_SERVICE_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  t.after(async () => { if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; } });
  const lines = createInterface({ input: child.stdout });
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Python startup timed out: ${stderr}`)), 15_000);
    lines.once("line", line => { clearTimeout(timer); resolve(line); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Python exited ${code}: ${stderr}`)); });
  });
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  const db = await pgliteDb(); t.after(() => db.close()); await migrate(db);
  let now = new Date();
  const engine = new Engine(db, async () => { throw new Error("No live provider permitted in this fixture"); }, () => now);
  engine.video.enabled = true;
  engine.video.provider = new HTTPVideoProvider(endpoint, token, key);
  const root = await mkdtemp(join(tmpdir(), "weavesense-long-input-journal-")); t.after(() => rm(root, { recursive: true, force: true }));
  const journal = { directory: join(root, "journal"), journalId: "synthetic-long-input-journal", key };
  await initializeVideoDeletionJournal(journal);
  configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
  await replayVideoRetentionJournal(engine);
  const profile = await engine.video.saveProfile(scope, { name: "Synthetic long UTF16 subtitle fixture", config: { required_capabilities: ["transcript"], language: "zh" } });
  const title = "长字幕🧪e\u0301";
  const source = await engine.createSource(scope, { kind: "bilibili", title, url: "https://www.bilibili.com/video/BV1LONG00001",
    config: { source_type: "video", native_id: "BV1LONG00001", profile_id: profile.id, profile_version: profile.version,
      usage_basis: "Self-authored synthetic subtitle only; no platform request or third-party media", allowed_uses: ["knowledge"] } });
  const segments = Array.from({ length: 2101 }, (_, index) => ({
    text: index === 0 ? "中".repeat(1199) + "😀e\u0301" + "跨片段长字幕".repeat(220) : `${index} 中文😀e\u0301 ${"材料".repeat(100)} ${index === 2100 ? "TAILSENTINELLONGINPUT" : "保留原文"}`,
    start_ms: index * 1000, end_ms: index === 0 ? 2_101_000 : (index + 1) * 1000,
  }));
  const expected = canonicalTranscript(title, segments);
  assert.ok(expected.text.length > 400001);
  const raw = JSON.stringify({ kind: "manual", language: "zh", segments });
  assert.ok(Buffer.byteLength(raw) > 1_000_000, "streamed upload exceeds the ordinary small JSON request limit");
  const http = createServer(handler(engine, { signingKey: key, audience: "loom-engine", issuer: "flow-platform" }));
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const base = `http://127.0.0.1:${(http.address() as any).port}`;
  const request = async (path: string, method = "GET", body?: unknown, rawBody?: string) => {
    const response = await fetch(base + path, { method, headers: { authorization: "Bearer " + sign(key, { ...scope, iss: "flow-platform", aud: "loom-engine", job_id: /^\/v1\/video\/jobs\/([\w-]+)\/input$/.exec(path)?.[1],
      scopes: ["intel.video.read", "intel.video.process", "intel.documents.read"] }), "content-type": "application/json", "x-idempotency-key": "synthetic-long-input" },
      ...(body === undefined && rawBody === undefined ? {} : { body: rawBody ?? JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status >= 200 && response.status < 300, true, `${response.status}: ${text}`);
    const envelope = JSON.parse(text); assert.equal(envelope.code, 0);
    return { data: envelope.data, bytes: Buffer.byteLength(text) };
  };
  const { data: started } = await request("/v1/video/jobs", "POST", { source_id: source.id, title, content_version: "long-overlapping-v1",
    lawful_input: { input_kind: "platform_subtitles", bytes: Buffer.byteLength(raw), sha256: sha(raw), content_type: "application/json" } });
  assert.equal(started.stage, "awaiting_input");
  await request(`/v1/video/jobs/${started.video_job_id}/input`, "PUT", undefined, raw);
  let checkedParts = 0;
  const importer = engine.video.importManifest.bind(engine.video);
  engine.video.importManifest = async (s, id, manifest, stage) => {
    if (manifest.artifact_stage === "processing_complete") {
      assert.ok(manifest.transcript!.parts.length > 1, "real worker must split large output into bounded objects");
      checkedParts = manifest.transcript!.parts.length;
      assert.equal(manifest.transcript!.parts.reduce((count, part) => count + part.segment_count, 0), segments.length);
      const malformed = structuredClone(manifest); malformed.transcript!.parts[0].end_ms!--;
      await assert.rejects(importer(s, id, malformed, stage), (error: any) => error.reason === "TRANSCRIPT_RANGE_MISMATCH");
      const incomplete = structuredClone(manifest); incomplete.coverage.missing = ["transcript"];
      await assert.rejects(importer(s, id, incomplete, stage), (error: any) => error.reason === "INCOMPLETE_ARTIFACT");
      assert.equal((await db.query("SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_ready'")).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int n FROM flow_document_revisions")).rows[0].n, 0);
    }
    return importer(s, id, manifest, stage);
  };
  let ready: any;
  const deadline = Date.now() + 75_000;
  do {
    await engine.video.workOnce("synthetic-long-input-worker");
    ready = (await request(`/v1/video/jobs/${started.video_job_id}`)).data;
    if (["failed", "blocked_auth", "blocked_budget", "reconciliation_required"].includes(ready.state)) assert.fail(JSON.stringify(ready));
    if (ready.completion_level === "knowledge_ready") break;
    await new Promise(resolve => setTimeout(resolve, 100)); now = new Date(now.getTime() + 6000);
  } while (Date.now() < deadline);
  assert.equal(ready.completion_level, "knowledge_ready"); assert.ok(checkedParts > 1);
  assert.equal(ready.input_provenance, "authorized_user_upload");

  let text = "", offset: number | null = 0, pages = 0;
  while (offset !== null) {
    const { data: page } = await request("/v1/documents/read", "POST", { document_id: ready.document_id, revision: ready.revision, offset, max_chars: 19999 });
    assert.equal(page.offset, offset); assert.ok(page.text.isWellFormed()); assert.ok(page.text.length <= 19999);
    assert.equal(page.coverage.total_chars, expected.text.length); assert.equal(page.coverage.returned_chars, page.text.length);
    assert.notEqual(page.coverage.next_offset, offset); text += page.text; offset = page.coverage.next_offset; pages++;
  }
  assert.ok(pages > 20); assert.equal(text, expected.text); assert.equal(sha(text), sha(expected.text));
  const evidence: any[] = []; let cursor: string | null = "0";
  while (cursor !== null) {
    const { data: page, bytes } = await request(`/v1/video/jobs/${ready.video_job_id}/result?kind=transcript&cursor=${cursor}&limit=100`);
    assert.ok(bytes < 8000, "long text does not overflow a normal result page");
    assert.notEqual(page.next_cursor, cursor); evidence.push(...page.items); cursor = page.next_cursor;
  }
  assert.equal(evidence.length, segments.length); assert.equal(new Set(evidence.map(row => row.evidence_id)).size, segments.length);
  for (const [index, row] of evidence.entries()) {
    assert.equal(row.char_start, expected.spans[index].char_start); assert.equal(row.char_end, expected.spans[index].char_end);
    assert.equal(row.start_ms, segments[index].start_ms); assert.equal(row.end_ms, segments[index].end_ms);
    assert.equal(row.snippet_hash, sha(text.slice(row.char_start, row.char_end)));
    assert.ok((row.quote ?? row.quote_excerpt).isWellFormed());
    if (row.quote_complete) assert.equal(row.quote, segments[index].text);
  }
  assert.equal(evidence[0].quote_complete, false); assert.equal(evidence[0].quote_excerpt, "中".repeat(1199));
  const surrogateOffset = expected.spans[0].char_start + 1200;
  await assert.rejects(engine.readDocument(scope, { document_id: ready.document_id, revision: ready.revision, offset: surrogateOffset }), (error: any) => error.status === 400);
  const chunks = (await db.query("SELECT text FROM flow_document_chunks WHERE document_id=$1 ORDER BY chunk_index", [ready.document_id])).rows;
  assert.equal(chunks.map(chunk => chunk.text).join(""), text); assert.ok(chunks.at(-1)!.text.includes("TAILSENTINELLONGINPUT"));
  assert.equal((await db.query("SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_ready' AND job_id=$1", [ready.video_job_id])).rows[0].n, 1);
  t.diagnostic(`Actual Python HTTP/SQLite/Processor -> Loom/PGlite/HTTP: ${segments.length} segments, ${text.length} UTF16 units, ${checkedParts} verified worker parts, ${pages} document pages; synthetic lawful input only, no platform/model/browser claim.`);
});
