import test from "node:test";
import assert from "node:assert/strict";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { VideoKnowledgeEvaluator } from "./video-knowledge-evaluator.ts";
import { configureVideoKnowledge } from "./video-knowledge-runtime.ts";
import { EVAL_KINDS } from "./video-knowledge-contract.ts";

// Unit boundary for durable retry selection; the compiled-release integration
// separately exercises actual evidence, authorization and host billing.
test("skill evaluator retries only confirmed terminal tasks and preserves uncertain identities", async t => {
  for (const status of ["failed", "cancelled", "reconciliation_required", "succeeded", "transport_error"]) {
    await t.test(status, async () => {
      const db = await pgliteDb(); await migrate(db);
      try {
        const engine = new Engine(db); engine.video.enabled = true;
        const evaluator = new VideoKnowledgeEvaluator(engine);
        evaluator.skills.dependencies = async () => [];
        evaluator.k.resolveEvidence = async () => [];
        const scope: any = { tenant_id: "retry-tenant", workspace_id: "retry-workspace", actor: { type: "user", id: "reviewer" }, scopes: ["intel.skills.release"], policy_version: "test" };
        const base = { id: "base", version: "1.0.0", hash: "a".repeat(64) };
        const caseID = status === "transport_error" ? "用例😀".repeat(25) : "case";
        const proposal = { base, pack: { skills: [{ method: "fixture" }] }, knowledge_releases: [], evidence: [], eval_spec: { model_config: { model: "fixture", budget_micro: 3000 }, cases: [{ id: caseID, input: "fixture", expected: "fixture" }] } };
        await db.query(`INSERT INTO flow_video_skill_candidates(id,tenant_id,workspace_id,skill_id,skill_version,candidate_hash,native_skill_hash,proposal,state,eval_result,created_by)
          VALUES('candidate',$1,$2,'method','1.0.0',$3,$3,$4,'evaluation_running','{"grant_actor":"user:reviewer"}','fixture')`, [scope.tenant_id, scope.workspace_id, base.hash, JSON.stringify(proposal)]);
        await db.query(`INSERT INTO flow_video_skill_eval_tasks(tenant_id,workspace_id,candidate_id,case_id,variant,request_hash) VALUES($1,$2,'candidate',$3,'base','fixture')`, [scope.tenant_id, scope.workspace_id, caseID]);
        const calls: any[] = [];
        configureVideoKnowledge(engine, { resolveBase: async () => ({ ...base, required_tools: [], skill: base } as any), modelTask: async (_ctx, id, _purpose, request, taskID) => {
          calls.push({ id, key: request.key, taskID, budget: request.budget_micro });
          assert.ok(Buffer.byteLength(request.key) <= 200, "Unicode case IDs must not exceed the host idempotency-key bound");
          assert.equal(request.input.case_id, caseID);
          if (calls.length > 1) return { task_id: taskID ?? "replacement-task", status: "queued" };
          if (status === "transport_error") throw Object.assign(new Error("connection lost"), { status: 502 });
          return { task_id: "original-task", status, reservation_id: "reservation", usage_ref: "model_task:original-task", cost_micro: 1, model_config_hash: "b".repeat(64), input_hash: "c".repeat(64), output: {} };
        } });
        await evaluator.workOnce("first-worker");
        const row = async () => (await db.query(`SELECT * FROM flow_video_skill_eval_tasks WHERE candidate_id='candidate' AND variant='base'`)).rows[0];
        const first = await row();
        assert.equal(first.task_id, status === "transport_error" ? null : "original-task");
        if (status === "transport_error") {
          assert.equal(first.state, "queued");
          await db.query(`UPDATE flow_video_skill_eval_tasks SET next_poll_at=now()`);
        } else {
          assert.equal(first.state, "blocked");
          assert.equal(first.result.model_status, status);
          await evaluator.skills.requestEvaluation(scope, "candidate", "explicit-retry", { expected_hash: base.hash });
        }
        const retry = await row(), terminal = status === "failed" || status === "cancelled";
        assert.equal(retry.generation, terminal ? 1 : 0);
        assert.equal(retry.attempt_history.length, terminal ? 1 : 0);
        if (terminal) {
          assert.equal(retry.attempt_history[0].task_id, "original-task");
          assert.equal(retry.attempt_history[0].result.model_status, status);
          assert.equal(retry.attempt_history[0].request_key, calls[0].key);
          assert.equal(retry.attempt_history[0].request_hash, "fixture");
          assert.equal(Object.hasOwn(retry.attempt_history[0], "request"), false);
          assert.equal(retry.attempt_history[0].requested_by, "user:reviewer");
        }
        await evaluator.workOnce("restarted-worker");
        assert.equal(calls.length, 2);
        assert.equal(calls[1].id, calls[0].id, "retry must keep the same host parent-budget identity");
        assert.equal(calls[1].budget, calls[0].budget);
        assert.equal(calls[1].key, terminal ? `${calls[0].key}:retry:1` : calls[0].key);
        assert.equal(calls[1].taskID, terminal || status === "transport_error" ? undefined : "original-task");
        assert.equal((await row()).task_id, terminal || status === "transport_error" ? "replacement-task" : "original-task");
      } finally { await db.close(); }
    });
  }
});

test("actual evaluator blocks release for critical or regressed output despite model-claimed success", async t => {
  for (const failure of ["unsupported_claim", "permission_violation", "wrong_answer"]) {
    await t.test(failure, async () => {
      const db = await pgliteDb(); await migrate(db);
      try {
        const engine = new Engine(db); engine.video.enabled = true;
        const evaluator = new VideoKnowledgeEvaluator(engine);
        evaluator.skills.dependencies = async () => [];
        evaluator.k.resolveEvidence = async () => [];
        const scope: any = { tenant_id: "negative-tenant", workspace_id: "negative-workspace", actor: { type: "user", id: "reviewer" }, scopes: ["intel.skills.release"], policy_version: "test" };
        const base = { id: "base", version: "1.0.0", hash: "a".repeat(64) };
        const cases = EVAL_KINDS.map((kind, i) => ({ id: `c${i}`, kind, input: "synthetic", expected: "evidence-bound output" }));
        const proposal = { base, pack: { skills: [{ method: "fixture" }] }, knowledge_releases: [], evidence: [], eval_spec: { dataset_version: "synthetic-not-gold", model_config: { model: "fixture", budget_micro: 1500 }, cases } };
        await db.query(`INSERT INTO flow_video_skill_candidates(id,tenant_id,workspace_id,skill_id,skill_version,candidate_hash,native_skill_hash,proposal,state,created_by)
          VALUES('negative',$1,$2,'method','1.0.0',$3,$3,$4,'draft','fixture')`, [scope.tenant_id, scope.workspace_id, base.hash, JSON.stringify(proposal)]);
        let count = 0;
        configureVideoKnowledge(engine, { resolveBase: async () => ({ ...base, required_tools: [], skill: base } as any), modelTask: async (_ctx, _id, _purpose, request) => {
          const bad = request.input.variant === "candidate" && request.input.case_id === "c0";
          const id = `negative-task-${++count}`;
          return { task_id: id, status: "succeeded", reservation_id: "fixture-reservation", usage_ref: `model_task:${id}`, cost_micro: 1, input_hash: "c".repeat(64), model_config_hash: "b".repeat(64),
            output: { case_id: request.input.case_id, output: bad && failure === "wrong_answer" ? "hallucination" : "evidence-bound output", passed: true, score: 1,
              unsupported_claims: bad && failure === "unsupported_claim" ? ["unsupported"] : [], permission_violations: bad && failure === "permission_violation" ? ["foreign scope"] : [], missing_evidence: [] } };
        } });
        const pre = { expected_hash: base.hash };
        await evaluator.skills.requestEvaluation(scope, "negative", "evaluate", pre);
        for (let i = 0; i < 15; i++) assert.equal(await evaluator.workOnce(`worker-${i}`), true);
        const candidate = await evaluator.skills.row(scope, "negative");
        assert.equal(candidate.state, "rejected");
        assert.equal(candidate.eval_result.passed, false);
        assert.equal(candidate.eval_result.scorer, "exact_expected_output_v1");
        const bad = candidate.eval_result.cases.find((c: any) => c.id === "c0");
        assert.equal(bad.candidate.score, 0);
        assert.equal(bad.base.score, 1);
        assert.equal(bad.without_skill.score, 1);
        await assert.rejects(evaluator.skills.review(scope, "negative", "approve-failed", { ...pre, decision: "approve", reason: "must fail" }), /passed_evaluation_required/);
        await assert.rejects(evaluator.skills.export(scope, "negative", "export-failed", pre), /approved_release_required/);
        assert.equal(candidate.approval, null);
        assert.equal(candidate.release_package, null);
      } finally { await db.close(); }
    });
  }
});
