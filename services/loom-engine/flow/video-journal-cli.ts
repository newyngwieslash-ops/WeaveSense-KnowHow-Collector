// Maintenance entrypoint; no API exposes provisioning or recovery operations.
import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { FileVideoDeletionJournal, configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal } from "./video-journal.ts";

const command = process.argv[2], file = process.argv[3];
const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`missing_${key}`); return value; };
const config = { directory: required("VIDEO_DELETION_JOURNAL_DIR"), key: required("VIDEO_DELETION_JOURNAL_KEY"),
  journalId: command === "init" ? randomUUID() : required("VIDEO_DELETION_JOURNAL_ID") };
const journal = new FileVideoDeletionJournal(config);
const checkpoint = async () => { if (!file) throw new Error("video_journal_checkpoint_file_required"); return JSON.parse(await readFile(file, "utf8")); };
try {
  if (command === "init") {
    await initializeVideoDeletionJournal(config);
    console.log(JSON.stringify({ journal_id: config.journalId, directory: config.directory, next: "Pin VIDEO_DELETION_JOURNAL_ID before enabling video. Do not include this volume in DB/object restore." }));
  } else if (command === "checkpoint") {
    if (!file) throw new Error("video_journal_checkpoint_file_required");
    const head = (await journal.snapshotReadOnly()).head, temp = `${file}.${randomUUID()}.tmp`;
    const fd = await open(temp, "wx", 0o600);
    try { await fd.writeFile(JSON.stringify(head) + "\n"); await fd.sync(); } finally { await fd.close(); }
    await rename(temp, file);
    const dir = await open(dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); }
    console.log(JSON.stringify({ checkpoint: file, journal_id: head.journal_id, sequence: head.sequence }));
  } else if (command === "verify") {
    const head = (await journal.snapshotReadOnly(await checkpoint())).head;
    console.log(JSON.stringify({ verified: true, journal_id: head.journal_id, sequence: head.sequence }));
  } else if (command === "recover-offline") {
    console.log(JSON.stringify(await journal.recoverOffline(required("VIDEO_JOURNAL_OFFLINE_ACK"))));
  } else if (command === "replay") {
    if (required("VIDEO_JOURNAL_OFFLINE_ACK") !== "ALL_JOURNAL_CLIENTS_STOPPED") throw new Error("video_journal_offline_acknowledgement_required");
    await journal.snapshotReadOnly(await checkpoint());
    const { pgDb, migrate } = await import("./db.ts"), { Engine } = await import("./engine.ts"), { applyVideoRetention } = await import("./video-knowledge.ts");
    const db = await pgDb(required("DATABASE_URL"));
    try {
      await migrate(db);
      const engine = new Engine(db);
      configureVideoRetentionJournal(engine, config, (q, event) => applyVideoRetention(engine, q, event, event));
      await replayVideoRetentionJournal(engine);
      const pending = (await db.query("SELECT count(*)::int AS count FROM flow_video_objects WHERE state='delete_pending'")).rows[0].count;
      console.log(JSON.stringify({ local_access_barrier: "replayed", physical_cleanup: pending ? "pending" : "no_pending_objects", pending_objects: pending,
        host_outbox: "must_dispatch_and_verify", complete_erasure: false }));
    } finally { await db.close(); }
  } else throw new Error("usage: video-journal-cli.ts init|checkpoint FILE|verify FILE|replay FILE|recover-offline");
} catch (e: any) {
  // Neither environment credentials nor arbitrary downstream/DB text is printed.
  console.error(typeof e?.reason === "string" ? e.reason : "video_journal_maintenance_failed");
  process.exitCode = 1;
}
