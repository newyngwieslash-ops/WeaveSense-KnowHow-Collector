import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { asrClient, ocrClient } from "./enrichment.ts";

const scope = { tenant_id: "tn_a", workspace_id: "ws_a" };
const objectKey = "tenants/tn_a/workspaces/ws_a/video/job_a/" + "a".repeat(64) + "/audio.wav";
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");

test("ASR manifest preserves 2101 segments and >400000 characters through the host client", async () => {
  const segments = Array.from({ length: 2101 }, (_, i) => ({ text: "中😀".repeat(100) + i, start: i, end: i + 1 }));
  const pages = Array.from({ length: 22 }, (_, i) => segments.slice(i * 100, (i + 1) * 100)).filter(x => x.length);
  const raw = pages.map(segments => JSON.stringify({ segments }));
  const parts = raw.map((r, i) => ({ object_key: objectKey.split("/").slice(0, 6).join("/") + "/" + digest(r) + "/asr-part.json", sha256: digest(r), bytes: Buffer.byteLength(r), segment_count: pages[i].length }));
  const text = segments.map(s => s.text).join(" ");
  const fetchImpl: typeof fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(init.redirect, "error");
    if (String(url).endsWith("/v1/asr")) {
      assert.equal(body.output_format, "manifest");
      return new Response(JSON.stringify({ object_key: objectKey, seconds: 2101, language: "zh", sha256: "a".repeat(64), complete: true, output_format: "manifest", segment_count: segments.length, text_sha256: digest(text), parts }));
    }
    return new Response(raw[parts.findIndex(p => p.object_key === body.object_key)]);
  }) as any;
  const result = await asrClient({ enabled: true, endpoint: "http://asr-worker/", token: "test", fetchImpl })(objectKey, scope);
  assert.equal(result.text, text);
  assert.deepEqual(result.segments, segments);
  assert.equal(result.complete, true);
  let streamed = 0;
  const streaming = await asrClient({ enabled: true, endpoint: "http://asr-worker/", token: "test", fetchImpl, onPart: async rows => { streamed += rows.length; } })(objectKey, scope);
  assert.equal(streamed, 2101);
  assert.equal(streaming.text, "");
  assert.equal(streaming.segments, undefined);
});

test("ASR refuses unproven legacy completeness and tampered or foreign manifest parts", async () => {
  const make = (data: any) => asrClient({ enabled: true, endpoint: "http://asr-worker/", token: "test", fetchImpl: (async () => new Response(JSON.stringify(data))) as any })(objectKey, scope);
  await assert.rejects(make({ object_key: objectKey, text: "silently sliced", seconds: 1, segments: [] }), /asr_invalid_response/);
  await assert.rejects(make({ object_key: objectKey, seconds: 1, complete: true, output_format: "manifest", segment_count: 1, parts: [{ object_key: "tenants/foreign/workspaces/ws_a/asr-parts/a.json", sha256: "a".repeat(64), bytes: 1, segment_count: 1 }] }), /asr_invalid_response/);
});

test("OCR host adapter does not silently slice long worker text", async () => {
  const text = "x".repeat(200001);
  const result = await ocrClient({ enabled: true, endpoint: "http://ocr-worker/", token: "test", fetchImpl: (async () => new Response(JSON.stringify({ object_key: objectKey, text, pages: 1, sha256: "a".repeat(64) }))) as any })(objectKey, scope);
  assert.equal(result.text, text);
});
