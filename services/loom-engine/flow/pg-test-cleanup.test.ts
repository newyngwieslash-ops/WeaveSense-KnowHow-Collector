import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "./db.ts";
import { closeIsolatedPostgresDatabase } from "../validation/video-knowledge/pg-test-cleanup.ts";

test("isolated PG cleanup observes drained backend sessions before non-forced DROP", async () => {
  const actions: string[] = [];
  let reads = 0;
  const pool = { close: async () => { actions.push("pool-end"); } } as Db;
  const maintenance = { query: async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("SELECT")) {
      assert.deepEqual(params, ["qa_cleanup"]); actions.push("observe");
      return { rows: [{ n: ++reads < 2 ? 1 : 0 }] };
    }
    assert.equal(sql, 'DROP DATABASE "qa_cleanup"'); actions.push("drop"); return { rows: [] };
  }, close: async () => { actions.push("maintenance-end"); } } as unknown as Db;
  await closeIsolatedPostgresDatabase(maintenance, "qa_cleanup", [pool]);
  assert.deepEqual(actions, ["pool-end", "observe", "observe", "drop", "maintenance-end"]);
});

test("isolated PG cleanup reports leaked sessions rather than FORCE-dropping or hiding failure", async () => {
  let dropped = false, closed = false;
  const maintenance = { query: async (sql: string) => {
    if (sql.startsWith("DROP")) dropped = true;
    return { rows: [{ n: 1 }] };
  }, close: async () => { closed = true; } } as unknown as Db;
  await assert.rejects(closeIsolatedPostgresDatabase(maintenance, "qa_cleanup", [], 0), /still has 1 backend sessions/);
  assert.equal(dropped, false); assert.equal(closed, true);
});

test("isolated PG cleanup propagates database observation errors", async () => {
  const failure = new Error("synthetic maintenance query failed"); let closed = false;
  const maintenance = { query: async () => { throw failure; }, close: async () => { closed = true; } } as unknown as Db;
  await assert.rejects(closeIsolatedPostgresDatabase(maintenance, "qa_cleanup", []), error => error === failure);
  assert.equal(closed, true);
});

test("isolated PG cleanup rejects unsafe database identifiers before touching connections", async () => {
  let touched = false;
  const maintenance = { query: async () => { touched = true; return { rows: [] }; }, close: async () => { touched = true; } } as unknown as Db;
  for (const name of ["", 'qa";DROP DATABASE other;--', "qa-name", "q".repeat(64)]) {
    await assert.rejects(closeIsolatedPostgresDatabase(maintenance, name, [maintenance]), /invalid isolated PostgreSQL database name/);
  }
  assert.equal(touched, false);
});
