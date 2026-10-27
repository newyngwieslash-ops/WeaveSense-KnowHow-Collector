import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";

/** This volume is NOT part of a DB/object backup. Never initialize it during startup. */
export interface VideoJournalConfig { directory: string; journalId: string; key: string; lockTimeoutMs?: number }
export interface VideoRetentionEvent {
  version: 1; event_id: string; tenant_id: string; workspace_id: string;
  action: "revoked" | "erased"; source_id?: string; asset_id?: string;
  request_hash: string; actor_hash: string; requested_at: string;
}
export interface VideoRetentionRecord {
  version: 1; journal_id: string; sequence: number; previous_hash: string;
  event: VideoRetentionEvent; hash: string; mac: string;
}
export interface VideoJournalCheckpoint { version: 1; journal_id: string; sequence: number; hash: string; mac: string }
type Scope = { tenant_id: string; workspace_id: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_EVENTS = 100_000;
const canonical = (v: any): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const digest = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function fail(reason: string): never { throw Object.assign(new Error(reason), { status: 503, reason }); }
const fields = (v: any, keys: string[]) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys.sort().join(",");
const number = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= MAX_EVENTS;
const eventFile = (n: number) => `${String(n).padStart(12, "0")}.json`;

function validateEvent(v: any): asserts v is VideoRetentionEvent {
  const target = v?.source_id !== undefined ? "source_id" : "asset_id";
  if (!fields(v, ["version", "event_id", "tenant_id", "workspace_id", "action", target, "request_hash", "actor_hash", "requested_at"]) || v.version !== 1 ||
      ![v.event_id, v.tenant_id, v.workspace_id, v[target]].every(x => typeof x === "string" && ID.test(x)) ||
      !["revoked", "erased"].includes(v.action) || ![v.request_hash, v.actor_hash].every(x => typeof x === "string" && HASH.test(x)) ||
      typeof v.requested_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.requested_at) || !Number.isFinite(Date.parse(v.requested_at))) fail("video_journal_invalid_event");
}

export class FileVideoDeletionJournal {
  readonly config: VideoJournalConfig;
  private observedGenesis?: string;
  constructor(config: VideoJournalConfig) {
    if (!isAbsolute(config.directory) || !ID.test(config.journalId) || typeof config.key !== "string" || Buffer.byteLength(config.key) < 32) fail("video_journal_configuration_required");
    this.config = { ...config, directory: resolve(config.directory) };
  }
  private mac(v: unknown) { return createHmac("sha256", this.config.key).update(canonical(v)).digest("hex"); }
  private authenticated(v: any, keys: string[]) {
    if (!fields(v, [...keys, "mac"]) || typeof v.mac !== "string" || !HASH.test(v.mac)) fail("video_journal_authentication_failed");
    const { mac, ...body } = v;
    if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.mac(body), "hex"))) fail("video_journal_authentication_failed");
    return body;
  }
  private async directory(path = this.config.directory) {
    const stat = await lstat(path).catch(() => fail("video_journal_missing"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || await realpath(path) !== resolve(path)) fail("video_journal_unsafe_directory");
  }
  private async syncDirectory(path = this.config.directory) {
    const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await fd.sync(); } finally { await fd.close(); }
  }
  private async read(path: string) {
    let fd;
    try {
      fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o022)) fail("video_journal_invalid_file");
      return JSON.parse(await fd.readFile("utf8"));
    } catch { fail("video_journal_missing_or_corrupt"); }
    finally { await fd?.close(); }
  }
  private async write(path: string, v: unknown) {
    const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(canonical(v) + "\n"); await fd.sync(); } finally { await fd.close(); }
  }
  private head(sequence: number, hash: string): VideoJournalCheckpoint {
    const body = { version: 1 as const, journal_id: this.config.journalId, sequence, hash };
    return { ...body, mac: this.mac(body) };
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.directory();
    const lock = join(this.config.directory, ".lock"), until = Date.now() + (this.config.lockTimeoutMs ?? 5000);
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (e: any) {
        if (e.code !== "EEXIST") fail("video_journal_lock_failed");
        // A crashed owner is never guessed dead or evicted by a running process.
        if (Date.now() >= until) fail("video_journal_locked_or_outcome_unknown");
        await new Promise(r => setTimeout(r, 20));
      }
    }
    try { return await fn(); }
    finally { await rmdir(lock); await this.syncDirectory(); }
  }
  /** Explicit operator provisioning for an EMPTY, NEW volume only. Never call at app startup. */
  async initialize() {
    await mkdir(this.config.directory, { mode: 0o700 });
    await this.directory();
    // A reused label/key cannot recreate an old empty journal's identity after volume loss.
    const identity = { version: 1, journal_id: this.config.journalId, generation_id: randomUUID() };
    await this.write(join(this.config.directory, "identity.json"), { ...identity, mac: this.mac(identity) });
    await mkdir(join(this.config.directory, "events"), { mode: 0o700 });
    await this.write(join(this.config.directory, "head.json"), this.head(0, digest(identity)));
    await this.syncDirectory(join(this.config.directory, "events"));
    await this.syncDirectory();
    const parent = resolve(this.config.directory, "..");
    await this.syncDirectory(parent);
  }
  private async readUnlocked(allowUncommitted = false, recoveryHeads: string[] = []) {
    const names = await readdir(this.config.directory);
    if (names.some(n => !["identity.json", "head.json", "events", ".lock", ...recoveryHeads].includes(n))) fail("video_journal_outcome_unknown");
    const identity = this.authenticated(await this.read(join(this.config.directory, "identity.json")), ["version", "journal_id", "generation_id"]);
    if (identity.version !== 1 || identity.journal_id !== this.config.journalId || typeof identity.generation_id !== "string" || !/^[a-f0-9-]{36}$/.test(identity.generation_id)) fail("video_journal_identity_mismatch");
    const genesis = digest(identity);
    if (this.observedGenesis && this.observedGenesis !== genesis) fail("video_journal_identity_reset_detected");
    this.observedGenesis = genesis;
    const head = await this.read(join(this.config.directory, "head.json")) as VideoJournalCheckpoint;
    this.verifyCheckpoint(head);
    const eventsDir = join(this.config.directory, "events");
    await this.directory(eventsDir);
    const files = (await readdir(eventsDir)).sort();
    if (files.length > MAX_EVENTS || files.length < head.sequence || (!allowUncommitted && files.length !== head.sequence) || files.some((f, i) => f !== eventFile(i + 1))) fail("video_journal_watermark_uncertain");
    let hash = genesis;
    const records: VideoRetentionRecord[] = [], ids = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      const record = await this.read(join(eventsDir, files[i])) as VideoRetentionRecord;
      const body = this.authenticated(record, ["version", "journal_id", "sequence", "previous_hash", "event", "hash"]);
      const { hash: storedHash, ...payload } = body;
      validateEvent(record.event);
      if (record.version !== 1 || record.journal_id !== this.config.journalId || record.sequence !== i + 1 || record.previous_hash !== hash || storedHash !== digest(payload) || ids.has(record.event.event_id)) fail("video_journal_chain_invalid");
      ids.add(record.event.event_id); hash = record.hash; records.push(record);
    }
    if (head.hash !== (head.sequence ? records[head.sequence - 1].hash : genesis)) fail("video_journal_watermark_uncertain");
    return { head, records, genesis_hash: genesis };
  }
  private verifyCheckpoint(checkpoint: VideoJournalCheckpoint) {
    const body = this.authenticated(checkpoint, ["version", "journal_id", "sequence", "hash"]);
    if (body.version !== 1 || body.journal_id !== this.config.journalId || !number(body.sequence) || !HASH.test(body.hash)) fail("video_journal_checkpoint_invalid");
  }
  async snapshot(minimum?: VideoJournalCheckpoint) {
    return this.locked(async () => {
      const result = await this.readUnlocked();
      if (minimum) {
        this.verifyCheckpoint(minimum);
        if (minimum.sequence > result.head.sequence || minimum.hash !== (minimum.sequence ? result.records[minimum.sequence - 1]?.hash : result.genesis_hash)) fail("video_journal_behind_backup_watermark");
      }
      return result;
    });
  }
  /** Backup mounts are read-only. Accept only a lock-free, fully validated, unchanged HEAD. */
  async snapshotReadOnly(minimum?: VideoJournalCheckpoint) {
    await this.directory();
    const unlocked = async () => {
      try { await lstat(join(this.config.directory, ".lock")); fail("video_journal_locked_or_outcome_unknown"); }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
    };
    await unlocked();
    const result = await this.readUnlocked();
    await unlocked();
    const after = await this.read(join(this.config.directory, "head.json"));
    this.verifyCheckpoint(after);
    if (canonical(after) !== canonical(result.head)) fail("video_journal_watermark_uncertain");
    if (minimum) {
      this.verifyCheckpoint(minimum);
      if (minimum.sequence > result.head.sequence || minimum.hash !== (minimum.sequence ? result.records[minimum.sequence - 1]?.hash : result.genesis_hash)) fail("video_journal_behind_backup_watermark");
    }
    return result;
  }
  async append(event: VideoRetentionEvent): Promise<VideoRetentionRecord> {
    validateEvent(event);
    event = JSON.parse(canonical(event));
    return this.locked(async () => {
      const { head, records } = await this.readUnlocked();
      const prior = records.find(r => r.event.event_id === event.event_id);
      if (prior) {
        const { requested_at: _a, ...a } = prior.event, { requested_at: _b, ...b } = event;
        if (canonical(a) !== canonical(b)) throw Object.assign(new Error("video_journal_idempotency_conflict"), { status: 409, reason: "video_journal_idempotency_conflict" });
        return prior;
      }
      if (head.sequence >= MAX_EVENTS) fail("video_journal_capacity_requires_operator_migration");
      const payload = { version: 1 as const, journal_id: this.config.journalId, sequence: head.sequence + 1, previous_hash: head.hash, event };
      const body = { ...payload, hash: digest(payload) }, record = { ...body, mac: this.mac(body) };
      await this.write(join(this.config.directory, "events", eventFile(record.sequence)), record);
      await this.syncDirectory(join(this.config.directory, "events"));
      // If either write outcome is uncertain, the next reader refuses the orphan/torn HEAD.
      const temporary = join(this.config.directory, `.head-${randomUUID()}.tmp`);
      await this.write(temporary, this.head(record.sequence, record.hash));
      await rename(temporary, join(this.config.directory, "head.json"));
      await this.syncDirectory();
      return record;
    });
  }
  /** All writers/readers MUST be stopped. Only advances a fully valid chain; never drops a record. */
  async recoverOffline(acknowledgement: string) {
    if (acknowledgement !== "ALL_JOURNAL_CLIENTS_STOPPED") fail("video_journal_offline_acknowledgement_required");
    await this.directory();
    const lock = join(this.config.directory, ".lock");
    await rmdir(lock).catch((e: any) => { if (e.code !== "ENOENT") throw e; });
    return this.locked(async () => {
      // Leftover HEAD files are validated, not discarded blindly; damaged files need forensic recovery.
      const leftovers = (await readdir(this.config.directory)).filter(n => /^\.head-[a-f0-9-]+\.tmp$/.test(n));
      const heads: VideoJournalCheckpoint[] = [];
      for (const name of leftovers) { const head = await this.read(join(this.config.directory, name)); this.verifyCheckpoint(head); heads.push(head); }
      const snapshot = await this.readUnlocked(true, leftovers), last = snapshot.records.at(-1);
      for (const head of heads) if (head.sequence < snapshot.head.sequence || head.hash !== (head.sequence ? snapshot.records[head.sequence - 1]?.hash : snapshot.genesis_hash)) fail("video_journal_recovery_chain_uncertain");
      const recovered = last ? this.head(last.sequence, last.hash) : snapshot.head;
      if (last && last.sequence > snapshot.head.sequence) {
        const temporary = join(this.config.directory, `.head-${randomUUID()}.tmp`);
        await this.write(temporary, recovered);
        await rename(temporary, join(this.config.directory, "head.json")); await this.syncDirectory();
      }
      // Only redundant, authenticated heads of the verified retained chain are removed.
      for (const name of leftovers) await unlink(join(this.config.directory, name));
      await this.syncDirectory();
      return recovered;
    });
  }
}

export const initializeVideoDeletionJournal = (config: VideoJournalConfig) => new FileVideoDeletionJournal(config).initialize();
const configured = new WeakMap<Engine, { journal: FileVideoDeletionJournal; apply: (q: Q, event: VideoRetentionEvent) => Promise<unknown> }>();
export function configureVideoRetentionJournal(engine: Engine, config: VideoJournalConfig, apply: (q: Q, event: VideoRetentionEvent) => Promise<unknown>) {
  configured.set(engine, { journal: new FileVideoDeletionJournal(config), apply });
}
export async function appendVideoRetentionIntent(engine: Engine, event: VideoRetentionEvent) {
  const runtime = configured.get(engine);
  if (!runtime) fail("video_journal_configuration_required");
  return runtime.journal.append(event);
}
function receiptMatches(row: any, record: VideoRetentionRecord) {
  return row.journal_id === record.journal_id && Number(row.sequence) === record.sequence && row.event_hash === record.hash && row.event_id === record.event.event_id && row.tenant_id === record.event.tenant_id && row.workspace_id === record.event.workspace_id;
}
/** Acquire BEFORE any target row lock in live mutations and replay alike. */
export async function lockVideoRetentionTransaction(q: Q) {
  const rows = (await q.query("SELECT id FROM flow_video_deletion_journal_mutex WHERE id=1 FOR UPDATE")).rows;
  if (rows.length !== 1) fail("video_journal_database_mutex_missing");
}
export async function markVideoRetentionApplied(q: Q, record: VideoRetentionRecord) {
  await q.query(`INSERT INTO flow_video_deletion_journal_receipts(journal_id,sequence,event_hash,event_id,tenant_id,workspace_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [record.journal_id, record.sequence, record.hash, record.event.event_id, record.event.tenant_id, record.event.workspace_id]);
  const rows = (await q.query(`SELECT * FROM flow_video_deletion_journal_receipts WHERE journal_id=$1 AND sequence=$2`, [record.journal_id, record.sequence])).rows;
  if (rows.length !== 1 || !receiptMatches(rows[0], record)) fail("video_journal_database_receipt_conflict");
}
export async function replayVideoRetentionJournal(engine: Engine, scope?: Scope) {
  if (scope && ![scope.tenant_id, scope.workspace_id].every(x => typeof x === "string" && ID.test(x))) fail("video_journal_invalid_scope");
  const runtime = configured.get(engine);
  if (!runtime) {
    const existing = await engine.db.query(`SELECT 1 FROM flow_video_assets WHERE ($1::text IS NULL OR tenant_id=$1) AND ($2::text IS NULL OR workspace_id=$2) LIMIT 1`, [scope?.tenant_id ?? null, scope?.workspace_id ?? null]);
    const sources = await engine.db.query(`SELECT 1 FROM flow_sources WHERE kind IN ('bilibili','douyin') AND ($1::text IS NULL OR tenant_id=$1) AND ($2::text IS NULL OR workspace_id=$2) LIMIT 1`, [scope?.tenant_id ?? null, scope?.workspace_id ?? null]);
    const bound = await engine.db.query("SELECT 1 FROM flow_video_deletion_journal_identity LIMIT 1");
    if (engine.video.enabled || existing.rows.length || sources.rows.length || bound.rows.length) fail("video_journal_configuration_required");
    return;
  }
  // Never hold the filesystem lock while awaiting a transaction: mutation calls append inside a DB transaction.
  for (let pass = 0; pass < 8; pass++) {
    const snapshot = await runtime.journal.snapshot();
    await engine.db.tx(async q => {
      await lockVideoRetentionTransaction(q);
      const prior = (await q.query("SELECT journal_id,genesis_hash FROM flow_video_deletion_journal_identity WHERE id=1")).rows[0];
      if (!prior) {
        // Binding is a system-startup step on an empty domain, never an implicit legacy restore bypass.
        if (scope) fail("video_journal_initialization_barrier_required");
        const material = (await q.query("SELECT EXISTS(SELECT 1 FROM flow_video_assets) OR EXISTS(SELECT 1 FROM flow_sources WHERE kind IN ('bilibili','douyin')) AS present")).rows[0];
        if (material?.present) fail("video_journal_legacy_database_unbound");
      }
      await q.query("INSERT INTO flow_video_deletion_journal_identity(id,journal_id,genesis_hash) VALUES(1,$1,$2) ON CONFLICT DO NOTHING", [snapshot.head.journal_id, snapshot.genesis_hash]);
      const bound = (await q.query("SELECT journal_id,genesis_hash FROM flow_video_deletion_journal_identity WHERE id=1")).rows[0];
      if (!bound || bound.journal_id !== snapshot.head.journal_id || bound.genesis_hash !== snapshot.genesis_hash) fail("video_journal_database_identity_mismatch");
    });
    const receipts = (await engine.db.query(`SELECT * FROM flow_video_deletion_journal_receipts WHERE ($1::text IS NULL OR tenant_id=$1) AND ($2::text IS NULL OR workspace_id=$2)`, [scope?.tenant_id ?? null, scope?.workspace_id ?? null])).rows;
    const applied = new Set<number>();
    for (const receipt of receipts) {
      const record = snapshot.records[Number(receipt.sequence) - 1];
      if (!record || !receiptMatches(receipt, record)) fail("video_journal_database_watermark_uncertain");
      applied.add(record.sequence);
    }
    for (const record of snapshot.records) {
      if (scope && (record.event.tenant_id !== scope.tenant_id || record.event.workspace_id !== scope.workspace_id)) continue;
      if (applied.has(record.sequence)) continue;
      await engine.db.tx(async q => {
        await lockVideoRetentionTransaction(q);
        const prior = (await q.query(`SELECT * FROM flow_video_deletion_journal_receipts WHERE journal_id=$1 AND sequence=$2`, [record.journal_id, record.sequence])).rows[0];
        if (prior) { if (!receiptMatches(prior, record)) fail("video_journal_database_receipt_conflict"); return; }
        await runtime.apply(q, record.event);
        await markVideoRetentionApplied(q, record);
      });
    }
    const after = await runtime.journal.snapshot(snapshot.head);
    if (after.head.sequence === snapshot.head.sequence && after.head.hash === snapshot.head.hash) return;
  }
  fail("video_journal_barrier_busy");
}
export const assertVideoRetentionJournal = replayVideoRetentionJournal;

/** Projection clients may pin this head only after all scoped effects through it exist in the DB. */
export async function videoRetentionCheckpoint(engine: Engine, scope: Scope): Promise<{ journal_id: string; genesis_hash: string; head_sequence: number; head_hash: string }> {
  const runtime = configured.get(engine);
  if (!runtime) fail("video_journal_configuration_required");
  for (let pass = 0; pass < 8; pass++) {
    await replayVideoRetentionJournal(engine, scope);
    const snapshot = await runtime.journal.snapshot();
    const receipts = (await engine.db.query("SELECT * FROM flow_video_deletion_journal_receipts WHERE tenant_id=$1 AND workspace_id=$2", [scope.tenant_id, scope.workspace_id])).rows;
    const bySequence = new Map(receipts.map(row => [Number(row.sequence), row]));
    const scoped = snapshot.records.filter(r => r.event.tenant_id === scope.tenant_id && r.event.workspace_id === scope.workspace_id);
    // An append between replay and snapshot must not move the advertised head past unapplied effects.
    if (scoped.every(record => bySequence.has(record.sequence) && receiptMatches(bySequence.get(record.sequence), record))) return {
      journal_id: snapshot.head.journal_id, genesis_hash: snapshot.genesis_hash, head_sequence: snapshot.head.sequence, head_hash: snapshot.head.hash,
    };
  }
  fail("video_journal_barrier_busy");
}
