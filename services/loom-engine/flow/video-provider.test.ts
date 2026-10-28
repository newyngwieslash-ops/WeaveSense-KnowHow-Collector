import test from "node:test";
import assert from "node:assert/strict";
import { HTTPVideoProvider } from "./video-provider.ts";

const job = { id: "job_test", tenant_id: "tenant_test", workspace_id: "workspace_test", policy_version: "policy_v1" };
const descriptor = { sha256: "a".repeat(64), bytes: 2, content_type: "application/json", input_kind: "platform_subtitles" };
const provider = new HTTPVideoProvider("http://worker.test", "synthetic-service-token", "synthetic-signing-key-at-least-32-bytes");
async function* input() { yield Buffer.from("{}"); }

test("worker input validation preserves only known 422 codes, never error details", async t => {
  for (const code of ["INPUT_HASH_MISMATCH", "INCOMPLETE_ARTIFACT", "NO_SUBTITLES", "INVALID_SUBTITLES", "INVALID_SUBTITLE_TIME", "SUBTITLE_LANGUAGE_MISMATCH"]) {
    await t.test(code, async t => {
      t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { code, message: "private-worker-detail", retryable: false } }), { status: 422 }));
      await assert.rejects(provider.uploadInput(job, descriptor, input()), (error: any) => {
        assert.equal(error.status, 422); assert.equal(error.reason, code);
        assert.equal(error.message, code); assert.ok(!JSON.stringify(error).includes("private-worker-detail"));
        return true;
      });
    });
  }
});

test("unknown, malformed and non-validation upload errors retain safe status-based reasons", async t => {
  for (const [status, body, reason] of [
    [422, '{"error":{"code":"private-token-or-new-code"}}', "INPUT_UPLOAD_FAILED"],
    [422, '{"error":{"code":{"NO_SUBTITLES":true}}}', "INPUT_UPLOAD_FAILED"],
    [422, '{"code":"NO_SUBTITLES"}', "INPUT_UPLOAD_FAILED"],
    [422, "not JSON private-worker-detail", "INPUT_UPLOAD_FAILED"],
    [422, "null", "INPUT_UPLOAD_FAILED"],
    [413, '{"error":{"code":"NO_SUBTITLES"}}', "LIMIT_EXCEEDED"],
    [500, '{"error":{"code":"NO_SUBTITLES"}}', "INPUT_UPLOAD_FAILED"],
    [403, '{"error":{"code":"INPUT_HASH_MISMATCH"}}', "INPUT_UPLOAD_FAILED"],
  ] as const) {
    await t.test(`${status} ${body}`, async t => {
      t.mock.method(globalThis, "fetch", async () => new Response(body, { status }));
      await assert.rejects(provider.uploadInput(job, descriptor, input()), (error: any) => error.status === status && error.reason === reason && error.message === reason);
    });
  }
});

test("upload rejection envelopes are bounded and unread response bodies are cancelled", async t => {
  for (const declared of [false, true]) {
    await t.test(`oversized content length ${declared}`, async t => {
      let cancelled = false;
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(JSON.stringify({ error: { code: "NO_SUBTITLES", message: "x".repeat(5000) } }))); },
        cancel() { cancelled = true; },
      });
      t.mock.method(globalThis, "fetch", async () => new Response(stream, { status: 422, headers: declared ? { "content-length": "6000" } : {} }));
      await assert.rejects(provider.uploadInput(job, descriptor, input()), (error: any) => error.status === 422 && error.reason === "INPUT_UPLOAD_FAILED");
      assert.equal(cancelled, true);
    });
  }
});

test("successful upload receipts remain unchanged", async t => {
  const receipt = { object_key: "test-object", sha256: descriptor.sha256, bytes: 2, content_type: "application/json" };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(receipt), { status: 201 }));
  assert.deepEqual(await provider.uploadInput(job, descriptor, input()), receipt);
});
