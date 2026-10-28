import { test } from "node:test";
import assert from "node:assert/strict";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { longInputProfileRequest } from "../../../scripts/fullstack/long-input.mjs";

test("fullstack long-input profile uses the actual validator with Chinese language and disabled curation", async t => {
  const db = await pgliteDb(); t.after(() => db.close()); await migrate(db);
  const engine = new Engine(db, async () => { throw new Error("no external provider calls in profile contract"); });
  engine.video.enabled = true;
  const scope = { tenant_id: "profile_contract_t", workspace_id: "profile_contract_w", actor: { type: "user", id: "fixture" } };
  const request = longInputProfileRequest();
  const saved = await engine.video.saveProfile(scope, request.body);
  assert.equal(saved.config.language, "zh"); assert.equal(saved.config.knowledge_model_id, "");
  assert.equal(saved.config.knowledge_budget_micro, 0); assert.equal(saved.config.budget_micro, 10000);
  assert.deepEqual(saved.config.required_capabilities, ["transcript"]);
  assert.equal(saved.version, 1);
  assert.equal((await engine.video.profile(scope, saved.id, saved.version)).content_hash, saved.content_hash);
  await assert.rejects(engine.video.saveProfile(scope, { ...request.body, config: { ...request.body.config, max_video_bytes: 0 } }),
    (error: any) => error.reason === "INVALID_PROFILE_LIMIT");
});
