// Opt-in actual offline tiny model, not a mock transcription. See AC08-ASR.md.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../../flow/engine.ts";
import { migrate, pgliteDb } from "../../flow/db.ts";
import { sign } from "../../flow/auth.ts";
import { handler } from "../../flow/server.ts";
import { HTTPVideoProvider } from "../../flow/video-provider.ts";
import { canonicalTranscript, sha } from "../../flow/video-contract.ts";
import { applyVideoRetention } from "../../flow/video-knowledge.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "../../flow/video-journal.ts";

test("AC08: subtitle-free Mandarin video uses actual offline ASR and preserves segments, times and evidence references", {
  timeout: 120_000,
}, async t => {
  assert.equal(process.env.VIDEO_MANDARIN_ASR_TEST, "1", "explicit local licensed-fixture smoke acknowledgement required");
  for (const key of ["VIDEO_MANDARIN_PYTHON", "VIDEO_MANDARIN_AUDIO", "VIDEO_MANDARIN_OUTPUT", "ASR_MODEL_DIR", "ASR_MODEL_MANIFEST"]) assert.ok(process.env[key], `${key} required`);
  assert.equal(process.env.HF_HUB_OFFLINE, "1");
  const root = resolve(process.env.VIDEO_MANDARIN_OUTPUT!); await mkdir(root, { recursive: true });
  const scope = { tenant_id: "mandarin_t", workspace_id: "mandarin_w", actor: { type: "user", id: "licensed_fixture_operator" }, policy_version: "ac08_fixture" };
  const key = "synthetic-mandarin-signing-key-over-32-bytes", token = "synthetic-mandarin-video-service-token";
  const child = spawn(process.env.VIDEO_MANDARIN_PYTHON!, ["-u", fileURLToPath(new URL("../../../video-knowledge/mandarin_asr_smoke.py", import.meta.url)),
    "--audio", resolve(process.env.VIDEO_MANDARIN_AUDIO!), "--work-dir", root], {
    env: { ...process.env, VIDEO_QA_SIGNING_KEY: key, VIDEO_QA_SERVICE_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  t.after(async () => { if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; } });
  const lines = createInterface({ input: child.stdout });
  const processWarnings: string[] = [];
  lines.on("line", line => { if (!line.startsWith("http://127.0.0.1:")) processWarnings.push(line); });
  const endpoint = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`Python startup timed out: ${stderr}`)), 20_000);
    lines.once("line", line => { clearTimeout(timer); accept(line); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Python exited ${code}: ${stderr}`)); });
  });
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  const fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
  assert.deepEqual(fixture.streams.sort(), ["audio", "video"]);
  assert.equal(fixture.source.license, "CC-BY-4.0"); assert.ok(fixture.duration_seconds > 1 && fixture.duration_seconds < 60);
  const raw = await readFile(join(root, "mandarin-no-subtitles.mp4")); assert.equal(sha(raw), fixture.media_sha256);
  const db = await pgliteDb(); t.after(() => db.close()); await migrate(db);
  let now = new Date();
  const engine = new Engine(db, async () => { throw new Error("no external acquisition allowed"); }, () => now);
  engine.video.enabled = true;
  const provider = new HTTPVideoProvider(endpoint, token, key); engine.video.provider = provider;
  const journal = { directory: join(root, "journal"), journalId: "mandarin-asr-fixture", key };
  await initializeVideoDeletionJournal(journal);
  configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event)); await replayVideoRetentionJournal(engine);
  const profile = await engine.video.saveProfile(scope, { name: "AC08 actual Mandarin ASR", config: { language: "zh", required_capabilities: ["transcript"], knowledge_budget_micro: 0, knowledge_model_id: "" } });
  const title = "CC-BY-4.0 FLEURS Mandarin no-subtitle fixture";
  const source = await engine.createSource(scope, { kind: "bilibili", title, url: "https://www.bilibili.com/video/BV1MANDARIN1", config: {
    source_type: "video", native_id: "BV1MANDARIN1", profile_id: profile.id, profile_version: profile.version,
    usage_basis: "Conneau et al. FLEURS CC-BY-4.0 licensed test audio; generated video; no platform acquisition", allowed_uses: ["knowledge"],
  } });
  const http = createServer(handler(engine, { signingKey: key, audience: "loom-engine", issuer: "flow-platform" }));
  http.listen(0, "127.0.0.1"); await once(http, "listening"); t.after(() => new Promise<void>(done => http.close(() => done())));
  const base = `http://127.0.0.1:${(http.address() as any).port}`;
  const request = async (path: string, method = "GET", body?: unknown, bytes?: Buffer) => {
    const response = await fetch(base + path, { method, headers: { authorization: "Bearer " + sign(key, { ...scope, iss: "flow-platform", aud: "loom-engine",
      job_id: /^\/v1\/video\/jobs\/([\w-]+)\/input$/.exec(path)?.[1], scopes: ["intel.video.read", "intel.video.process", "intel.documents.read"] }),
      "content-type": bytes ? "video/mp4" : "application/json", "x-idempotency-key": "mandarin-asr-fixture" },
      ...(body === undefined && !bytes ? {} : { body: bytes ? new Uint8Array(bytes) : JSON.stringify(body) }) });
    const out = await response.json(); assert.equal(response.status < 400, true, JSON.stringify(out)); assert.equal(out.code, 0); return out.data;
  };
  const started = await request("/v1/video/jobs", "POST", { source_id: source.id, title, lawful_input: {
    input_kind: "media", sha256: sha(raw), bytes: raw.length, content_type: "video/mp4",
  } });
  assert.equal(started.stage, "awaiting_input"); await request(`/v1/video/jobs/${started.video_job_id}/input`, "PUT", undefined, raw);
  let ready: any;
  const deadline = Date.now() + 75_000;
  do {
    await engine.video.workOnce("mandarin-offline-model-worker"); ready = await request(`/v1/video/jobs/${started.video_job_id}`);
    if (["failed", "blocked_auth", "blocked_budget", "reconciliation_required"].includes(ready.state)) assert.fail(JSON.stringify(ready));
    if (ready.completion_level === "knowledge_ready") break;
    await new Promise(done => setTimeout(done, 100)); now = new Date(now.getTime() + 6000);
  } while (Date.now() < deadline);
  assert.equal(ready.completion_level, "knowledge_ready"); assert.equal(ready.input_provenance, "authorized_user_upload");
  const receipts = JSON.parse(await readFile(join(root, "asr-receipts.json"), "utf8"));
  const calls = receipts.filter((r: any) => r.path === "/v1/asr"); assert.equal(calls.length, 1);
  const recognition = calls[0].response; assert.equal(recognition.language, "zh"); assert.equal(recognition.status, "ok");
  assert.equal(recognition.engine, "faster-whisper:1.1.1"); assert.equal(recognition.model_lock.revision, fixture.model_lock.revision);
  const original = receipts.filter((r: any) => r.path === "/v1/asr/parts").flatMap((r: any) => r.response.segments);
  assert.ok(original.length > 0); assert.equal(original.length, recognition.segment_count);
  for (const part of recognition.parts) {
    const bytes = await provider.readObject(scope, ready.video_job_id, part.object_key, 256 * 1024);
    assert.equal(sha(bytes), part.sha256); assert.equal(bytes.length, part.bytes);
  }
  const segments = original.map((segment: any) => ({ text: segment.text, start_ms: Math.round(segment.start * 1000), end_ms: Math.round(segment.end * 1000), kind: "asr" as const, alignment_method: "asr_segment" }));
  for (const segment of segments) {
    assert.ok(/[\u3400-\u9fff]/u.test(segment.text));
    assert.ok(segment.start_ms >= 0 && segment.end_ms > segment.start_ms && segment.end_ms <= fixture.duration_seconds * 1000);
  }
  const expected = canonicalTranscript(title, segments);
  const page = await request("/v1/documents/read", "POST", { document_id: ready.document_id, revision: ready.revision, offset: 0, max_chars: 20000 });
  assert.equal(page.text, expected.text); assert.equal(page.coverage.truncated, false);
  const artifacts = await request(`/v1/video/jobs/${ready.video_job_id}/artifacts?kind=transcript&limit=100`);
  assert.equal(artifacts.items.length, original.length); assert.equal(artifacts.next_cursor, null);
  for (const [index, evidence] of artifacts.items.entries()) {
    const span = expected.spans[index];
    assert.equal(evidence.quote, span.text); assert.equal(evidence.snippet_hash, sha(span.text));
    assert.equal(evidence.char_start, span.char_start); assert.equal(evidence.char_end, span.char_end);
    assert.equal(evidence.start_ms, span.start_ms); assert.equal(evidence.end_ms, span.end_ms); assert.equal(evidence.alignment_method, "asr_segment");
    const recovered = await request("/v1/documents/read", "POST", evidence.read_ref); assert.equal(recovered.text, span.text);
  }
  const sourceHashes: Record<string, string> = {};
  for (const path of ["validation/video-knowledge/mandarin-asr-qa.ts", "flow/video.ts", "flow/video-contract.ts", "flow/engine.ts", "flow/server.ts", "flow/video-provider.ts",
    "workers/asr/server.py", "../video-knowledge/mandarin_asr_smoke.py", "../video-knowledge/media.py", "../video-knowledge/server.py", "../video-knowledge/runtime.py", "../video-knowledge/core.py", "../../scripts/prepare-mandarin-asr.py"]) {
    sourceHashes[path] = sha(await readFile(new URL("../../" + path, import.meta.url)));
  }
  const report = { schema_version: 1, passed: true, checkout_base_commit: process.env.VIDEO_MANDARIN_SOURCE_SHA || null, working_source_sha256: sourceHashes,
    pipeline: "licensed Mandarin -> generated subtitle-free MP4 -> signed Python HTTP/SQLite/FFmpeg -> production ASR HTTP/offline tiny -> Loom HTTP/PGlite -> exact evidence read_ref",
    fixture, recognition, original_segments: original, canonical_segments: segments,
    document_id: ready.document_id, revision: ready.revision, video_job_id: ready.video_job_id, full_text_sha256: sha(page.text), evidence: artifacts.items,
    checks: { no_subtitle_stream: true, real_model_nonempty_chinese: true, original_asr_parts_preserved: true, exact_millisecond_mapping: true, evidence_reference_round_trip: true },
    real_platform_acquisition: false, business_accuracy_threshold: "not specified by AC08; original reference and model recognition are retained without correction", production_ready: false,
    runtime_warnings: processWarnings.some(line => line.includes("failed to create VFS socket: Operation not permitted")) ? ["UCX_VFS_SOCKET_PERMISSION_DENIED"] : [],
    unclassified_stdout_lines: processWarnings.filter(line => !line.includes("failed to create VFS socket: Operation not permitted")).length,
    stderr_line_count: stderr.trim() ? stderr.trim().split("\n").length : 0,
    boundaries: ["generated plain-color video", "local filesystem object store", "PGlite host database", "no Go/browser/session claim", "no paid model API"] };
  await writeFile(join(root, "acceptance.json"), JSON.stringify(report, null, 2));
  await writeFile(join(root, "local-process-diagnostics.json"), JSON.stringify({ stdout: processWarnings, stderr }, null, 2));
  t.diagnostic(`Actual Mandarin tiny ASR: ${original.length} original segments -> ${artifacts.items.length} exact evidence references; ${fixture.duration_seconds}s no-subtitle video.`);
});
