import type { Db } from "../../flow/db.ts";

// pg-pool can resolve end() after removing clients from its list but before
// their sockets finish closing. Never FORCE-drop a disposable database while
// those real backend sessions still exist: that aborts a closing idle socket.
export async function closeIsolatedPostgresDatabase(maintenance: Db, name: string, pools: Db[], timeoutMs = 5000): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error("invalid isolated PostgreSQL database name");
  try {
    await Promise.all(pools.map(pool => pool.close()));
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const count = Number((await maintenance.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1", [name])).rows[0].n);
      if (count === 0) break;
      if (Date.now() >= deadline) throw new Error(`isolated PostgreSQL cleanup still has ${count} backend sessions`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await maintenance.query(`DROP DATABASE "${name}"`);
  } finally {
    await maintenance.close();
  }
}
