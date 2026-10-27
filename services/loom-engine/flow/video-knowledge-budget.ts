import type { Engine } from "./engine.ts";
import { knowledgeRuntime } from "./video-knowledge-runtime.ts";

/** Durable reconciliation; host refuses settlement while any child remains unknown/open. */
export async function closeKnowledgeBudget(engine: Engine, purpose: "video_knowledge_extract" | "video_skill_evaluate") {
  const close = knowledgeRuntime(engine).closeModelBudget;
  if (!close) return;
  const extraction = purpose === "video_knowledge_extract";
  const table = extraction ? "flow_video_knowledge_runs" : "flow_video_skill_candidates";
  // Blocked/failed extraction is resumable and intentionally keeps its bounded reservation.
  const predicate = extraction ? "state IN ('completed','cancelled')" : "state NOT IN ('draft','evaluation_running')";
  const row = (await engine.db.query(`SELECT id,tenant_id,workspace_id FROM ${table} WHERE ${predicate} AND budget_closed_at IS NULL AND budget_close_next_at<=now() ORDER BY budget_close_next_at,id LIMIT 1`)).rows[0];
  if (!row) return;
  let receipt: any, closed = false;
  try {
    receipt = await close(row, row.id, purpose);
    closed = receipt.status === "settled" && typeof receipt.reservation_id === "string" && Number.isSafeInteger(receipt.cost_micro) && receipt.cost_micro >= 0;
    if (!closed) receipt = { error: "budget_close_receipt_invalid" };
  } catch (error: any) {
    closed = error.status === 404 && error.reason === "model_parent_budget_not_found";
    receipt = { status: closed ? "not_reserved" : "pending", error: closed ? "no_model_budget_created" : "model_budget_close_pending" };
  }
  await engine.db.query(`UPDATE ${table} SET budget_closed_at=CASE WHEN $4 THEN now() ELSE NULL END,budget_close_receipt=$5,budget_close_next_at=now()+interval '30 seconds' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_closed_at IS NULL`,
    [row.tenant_id, row.workspace_id, row.id, closed, JSON.stringify(receipt)]);
}
