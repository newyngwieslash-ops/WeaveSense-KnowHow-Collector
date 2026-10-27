"""Durable execution receipts only. Loom owns scheduling, jobs, grants and ready."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit

from core import Failure, ID, canonical, sha, scope_key, typed_object, disk_guard, scratch_budget
from media import Processor, media_limits, processing_mode, probe


class Tasks:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS executions (
                id TEXT PRIMARY KEY, tenant TEXT NOT NULL, workspace TEXT NOT NULL, job TEXT NOT NULL,
                stage TEXT NOT NULL, intent TEXT NOT NULL, payload_hash TEXT NOT NULL, body TEXT NOT NULL,
                state TEXT NOT NULL, checkpoint TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT,
                authorization_until REAL NOT NULL, lease_until REAL NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
                next_run REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL,
                UNIQUE(tenant,workspace,job,stage,intent))""")
            db.execute("""CREATE TABLE IF NOT EXISTS artifact_inventory (
                object_key TEXT PRIMARY KEY, tenant TEXT NOT NULL, workspace TEXT NOT NULL, job TEXT NOT NULL,
                ref TEXT NOT NULL, state TEXT NOT NULL, updated_at REAL NOT NULL, lease_until REAL NOT NULL DEFAULT 0)""")
            db.execute("""CREATE TABLE IF NOT EXISTS temporary_paths (
                id TEXT PRIMARY KEY, tenant TEXT NOT NULL, workspace TEXT NOT NULL, job TEXT NOT NULL,
                task TEXT, generation INTEGER, path TEXT NOT NULL, created_at REAL NOT NULL)""")
            db.execute("CREATE TABLE IF NOT EXISTS erasure_tombstones (tenant TEXT, workspace TEXT, job TEXT, erased_at REAL NOT NULL, PRIMARY KEY(tenant,workspace,job))")

    def inventory_put(self, scope, job, ref, state="stored", lease_until=0):
        scope_key(ref["object_key"], scope, job)
        ref = typed_object(ref)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM erasure_tombstones WHERE tenant=? AND workspace=? AND job=?", (scope["tenant_id"], scope["workspace_id"], job)).fetchone():
                raise Failure("EXECUTION_ERASED", 410)
            previous = db.execute("SELECT ref FROM artifact_inventory WHERE object_key=?", (ref["object_key"],)).fetchone()
            if previous and any(json.loads(previous[0]).get(k) != ref.get(k) for k in ("sha256", "bytes", "content_type")):
                raise Failure("OBJECT_IDENTITY_CONFLICT", 409)
            db.execute("INSERT INTO artifact_inventory VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(object_key) DO UPDATE SET ref=excluded.ref,state=excluded.state,updated_at=excluded.updated_at,lease_until=excluded.lease_until",
                       (ref["object_key"], scope["tenant_id"], scope["workspace_id"], job, canonical(ref).decode(), state, time.time(), lease_until))
        return ref

    def inventory(self, scope, job, key=None, cursor="0"):
        if not str(cursor).isdigit() or not 0 <= int(cursor) <= 100000:
            raise Failure("INVALID_CURSOR", 400)
        with self.db() as db:
            args = (scope["tenant_id"], scope["workspace_id"], job)
            if key:
                scope_key(key, scope, job)
                row = db.execute("SELECT * FROM artifact_inventory WHERE tenant=? AND workspace=? AND job=? AND object_key=? AND state='stored'", (*args, key)).fetchone()
                if row is None:
                    raise Failure("OBJECT_NOT_REGISTERED", 404)
                return json.loads(row["ref"])
            rows = db.execute("SELECT * FROM artifact_inventory WHERE tenant=? AND workspace=? AND job=? AND state!='deleted' ORDER BY object_key LIMIT 101 OFFSET ?", (*args, int(cursor))).fetchall()
        return {"artifacts": [{**json.loads(r["ref"]), "inventory_state": r["state"]} for r in rows[:100]], "next_artifact_cursor": str(int(cursor) + 100) if len(rows) > 100 else None}

    @contextmanager
    def temporary(self, scope, job, root=None, task=None, generation=None):
        if root:
            Path(root).mkdir(parents=True, exist_ok=True)
        disk_guard(root or tempfile.gettempdir())
        identity = uuid.uuid4().hex
        path = Path(tempfile.mkdtemp(prefix="video-" + identity + "-", dir=root)).resolve()
        lock = (path / ".lease.lock").open("w")
        fcntl.flock(lock, fcntl.LOCK_EX)
        with self.db() as db:
            db.execute("INSERT INTO temporary_paths VALUES(?,?,?,?,?,?,?,?)", (identity, scope["tenant_id"], scope["workspace_id"], job, task, generation, str(path), time.time()))
        try:
            yield path
        finally:
            # Keep the advisory lock while removing: a sweep never races a live
            # process merely because its scheduling lease has expired.
            shutil.rmtree(path)
            lock.close()
            with self.db() as db:
                db.execute("DELETE FROM temporary_paths WHERE id=?", (identity,))

    def sweep_temporary(self, scope, job, before):
        if not isinstance(before, (int, float)) or not 0 < before <= time.time():
            raise Failure("INVALID_CLEANUP_DEADLINE", 400)
        removed, skipped = [], []
        with self.db() as db:
            rows = db.execute("SELECT * FROM temporary_paths WHERE tenant=? AND workspace=? AND job=? AND created_at<=? LIMIT 100", (scope["tenant_id"], scope["workspace_id"], job, before)).fetchall()
        for row in rows:
            with self.db() as db:
                live = db.execute("SELECT 1 FROM executions WHERE id=? AND generation=? AND state='running' AND lease_until>?", (row["task"], row["generation"], time.time())).fetchone()
            path = Path(row["path"])
            if live or path.is_symlink() or not path.name.startswith("video-" + row["id"] + "-"):
                skipped.append(row["id"])
                continue
            try:
                if path.exists():
                    with (path / ".lease.lock").open("a") as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        shutil.rmtree(path)
                with self.db() as db:
                    db.execute("DELETE FROM temporary_paths WHERE id=?", (row["id"],))
                removed.append(row["id"])
            except (BlockingIOError, FileNotFoundError):
                skipped.append(row["id"])
        return {"video_job_id": job, "deleted_temporary_ids": removed, "skipped_active_ids": skipped, "complete": len(rows) < 100}

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def submit(self, body, authorization_until):
        required = {"tenant_id", "workspace_id", "video_job_id", "stage", "stage_attempt", "fencing_token", "intent_key", "profile", "asset"}
        if not isinstance(body, dict) or not required <= body.keys():
            raise Failure("INVALID_REQUEST", 400)
        if any(not isinstance(body[k], str) or not ID.fullmatch(body[k]) for k in ("tenant_id", "workspace_id", "video_job_id")):
            raise Failure("INVALID_REQUEST", 400)
        if body["stage"] not in ("input", "acquire", "transcript", "vision", "process", "normalize") or not isinstance(body["intent_key"], str) or not 1 <= len(body["intent_key"]) <= 200:
            raise Failure("INVALID_REQUEST", 400)
        if type(body["stage_attempt"]) is not int or type(body["fencing_token"]) is not int or min(body["stage_attempt"], body["fencing_token"]) < 1:
            raise Failure("INVALID_FENCE", 400)
        # Fence renewals don't change immutable work; the host attaches the current
        # lease only after checking the durable receipt identity.
        fingerprint = {k: v for k, v in body.items() if k not in ("stage_attempt", "fencing_token")}
        digest = sha(canonical(fingerprint))
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM erasure_tombstones WHERE tenant=? AND workspace=? AND job=?", (body["tenant_id"], body["workspace_id"], body["video_job_id"])).fetchone():
                raise Failure("EXECUTION_ERASED", 410)
            row = db.execute("SELECT * FROM executions WHERE tenant=? AND workspace=? AND job=? AND stage=? AND intent=?",
                             (body["tenant_id"], body["workspace_id"], body["video_job_id"], body["stage"], body["intent_key"])).fetchone()
            if row:
                if row["state"] == "erased":
                    raise Failure("EXECUTION_ERASED", 410)
                if row["payload_hash"] != digest:
                    raise Failure("IDEMPOTENCY_CONFLICT", 409)
                return self.public(row)
            for ref in ([body.get("asset", {}).get("input_object")] + body.get("input_manifest", {}).get("objects", [])):
                if ref:
                    scope_key(ref["object_key"], body, body["video_job_id"])
                    db.execute("INSERT OR IGNORE INTO artifact_inventory VALUES(?,?,?,?,?,?,?,0)", (ref["object_key"], body["tenant_id"], body["workspace_id"], body["video_job_id"], canonical(typed_object(ref)).decode(), "stored", time.time()))
            task = "exec_" + uuid.uuid4().hex
            db.execute("INSERT INTO executions(id,tenant,workspace,job,stage,intent,payload_hash,body,state,authorization_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (task, body["tenant_id"], body["workspace_id"], body["video_job_id"], body["stage"], body["intent_key"], digest, canonical(body).decode(), "pending", authorization_until, time.time()))
        return {"task_id": task, "state": "pending", "video_job_id": body["video_job_id"], "intent_key": body["intent_key"]}

    @staticmethod
    def public(row):
        result = {"task_id": row["id"], "state": "pending" if row["state"] == "running" else row["state"],
                  "video_job_id": row["job"], "intent_key": row["intent"], "next_poll_after": 5}
        if row["result"]:
            result["manifest"] = json.loads(row["result"])
        if row["error"]:
            result["error"] = json.loads(row["error"])
        checkpoint = json.loads(row["checkpoint"])
        if checkpoint.get("artifacts"):
            refs = list(checkpoint["artifacts"].values())
            result["artifacts"] = refs[:100]
            result["next_artifact_cursor"] = "100" if len(refs) > 100 else None
        if checkpoint.get("usage"):
            result["usage"] = {**checkpoint["usage"]}
            models = result["usage"].get("model_tasks", [])
            result["usage"].update(model_tasks=models[:100], model_task_count=len(models), model_task_receipts_complete=len(models) <= 100)
        if checkpoint.get("usage_receipts"):
            ids = checkpoint["usage_receipts"]
            result.update(usage_receipts=ids[:100], usage_receipt_count=len(ids), usage_receipts_complete=len(ids) <= 100)
        if checkpoint.get("external_download_id"):
            result["external_download_id"] = checkpoint["external_download_id"]
        return result

    def read(self, task, scope, authorization_until=None, envelope=None):
        with self.db() as db:
            row = db.execute("SELECT * FROM executions WHERE id=? AND tenant=? AND workspace=? AND job=?",
                             (task, scope["tenant_id"], scope["workspace_id"], scope["video_job_id"])).fetchone()
            if row is None:
                raise Failure("NOT_FOUND", 404)
            if row["state"] == "erased":
                raise Failure("EXECUTION_ERASED", 410)
            if authorization_until:
                db.execute("UPDATE executions SET authorization_until=? WHERE id=?", (authorization_until, task))
            if envelope:
                body = json.loads(row["body"])
                if envelope["stage_attempt"] < body["stage_attempt"] or envelope["fencing_token"] < body["fencing_token"]:
                    raise Failure("STALE_FENCE", 409)
                body.update(envelope)
                db.execute("UPDATE executions SET body=? WHERE id=?", (canonical(body).decode(), task))
            return self.public(row)

    def reconcile(self, scope, intent):
        with self.db() as db:
            rows = db.execute("SELECT * FROM executions WHERE tenant=? AND workspace=? AND job=? AND intent=?",
                              (scope["tenant_id"], scope["workspace_id"], scope["video_job_id"], intent)).fetchall()
            if len(rows) != 1:
                raise Failure("NOT_FOUND" if not rows else "IDEMPOTENCY_CONFLICT", 404 if not rows else 409)
            if rows[0]["state"] == "erased":
                raise Failure("EXECUTION_ERASED", 410)
            return self.public(rows[0])

    def execution_spec(self, task, scope):
        self.read(task, scope)
        with self.db() as db:
            return json.loads(db.execute("SELECT body FROM executions WHERE id=?", (task,)).fetchone()[0])

    def artifacts(self, task, scope, cursor="0"):
        if not isinstance(cursor, str) or not cursor.isdigit() or not 0 <= int(cursor) <= 100000:
            raise Failure("INVALID_CURSOR", 400)
        with self.db() as db:
            row = db.execute("SELECT checkpoint FROM executions WHERE id=? AND tenant=? AND workspace=? AND job=?", (task, scope["tenant_id"], scope["workspace_id"], scope["video_job_id"])).fetchone()
            if row is None:
                raise Failure("NOT_FOUND", 404)
            refs = list(json.loads(row[0]).get("artifacts", {}).values())
        start = int(cursor)
        return {"artifacts": refs[start:start + 100], "next_artifact_cursor": str(start + 100) if start + 100 < len(refs) else None}

    def cancel(self, task, scope):
        self.read(task, scope)
        with self.db() as db:
            db.execute("UPDATE executions SET state='cancelled',generation=generation+1,authorization_until=0 WHERE id=?", (task,))
            row = db.execute("SELECT checkpoint FROM executions WHERE id=?", (task,)).fetchone()
            return json.loads(row[0])

    def retry(self, task, scope, authorization_until, envelope=None):
        self.read(task, scope, authorization_until, envelope)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM executions WHERE id=?", (task,)).fetchone()
            error = json.loads(row["error"] or "{}")
            if row["state"] in ("running", "pending", "completed"):
                return self.public(row)
            if row["state"] != "failed" or error.get("code") in ("EXTERNAL_OUTCOME_UNKNOWN", "USAGE_OUTCOME_UNKNOWN"):
                raise Failure("RETRY_NOT_ALLOWED", 409)
            checkpoint = json.loads(row["checkpoint"])
            if error.get("code") == "PROVIDER_REFRESH_FAILED":
                checkpoint.pop("refresh_task_id", None)
                checkpoint.pop("refresh_intent", None)
                db.execute("UPDATE executions SET checkpoint=? WHERE id=?", (canonical(checkpoint).decode(), task))
            if error.get("code") == "DOWNLOAD_TERMINAL" and checkpoint.get("external_download_id"):
                checkpoint["download_retry_requested"] = True
                db.execute("UPDATE executions SET checkpoint=? WHERE id=?", (canonical(checkpoint).decode(), task))
            db.execute("UPDATE executions SET state='pending',error=NULL,authorization_until=?,lease_until=0,next_run=0,generation=generation+1 WHERE id=?", (authorization_until, task))
        return {"task_id": task, "state": "pending", "checkpoints_preserved": True}

    def assert_cleanup_allowed(self, scope, job):
        with self.db() as db:
            active = db.execute("SELECT 1 FROM executions WHERE tenant=? AND workspace=? AND job=? AND state IN ('pending','running') LIMIT 1", (scope["tenant_id"], scope["workspace_id"], job)).fetchone()
            uploading = db.execute("SELECT 1 FROM artifact_inventory WHERE tenant=? AND workspace=? AND job=? AND lease_until>? LIMIT 1", (scope["tenant_id"], scope["workspace_id"], job, time.time())).fetchone()
        if active or uploading:
            raise Failure("ACTIVE_EXECUTION_REFERENCES_OBJECT", 409)
        # Cancellation fences publication, not an in-flight OS/file operation.
        # A live worker holds this lock until its finally block has stopped work.
        with self.db() as db:
            paths = db.execute("SELECT path FROM temporary_paths WHERE tenant=? AND workspace=? AND job=?", (scope["tenant_id"], scope["workspace_id"], job)).fetchall()
        for row in paths:
            try:
                with (Path(row[0]) / ".lease.lock").open("r") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure("ACTIVE_EXECUTION_REFERENCES_OBJECT", 409) from None
            except FileNotFoundError:
                pass

    def erase(self, scope, job):
        """Delete execution content, retaining only minimal idempotency tombstones.

        Deployment backups and provider-side DTK storage have separate retention
        policies; this receipt only covers this worker's live SQLite database.
        """
        self.assert_cleanup_allowed(scope, job)
        with self.db() as db:
            db.execute("PRAGMA secure_delete=ON")
            db.execute("BEGIN IMMEDIATE")
            args = (scope["tenant_id"], scope["workspace_id"], job)
            if db.execute("SELECT 1 FROM executions WHERE tenant=? AND workspace=? AND job=? AND state IN ('pending','running')", args).fetchone():
                raise Failure("ACTIVE_EXECUTION_REFERENCES_OBJECT", 409)
            for row in db.execute("SELECT checkpoint FROM executions WHERE tenant=? AND workspace=? AND job=?", args):
                usage = json.loads(row[0]).get("local_usage", {})
                if any(item.get("phase") in ("processing", "unknown") for item in usage.values()):
                    # A synchronous external local-worker call can still publish
                    # late parts after our cancellation. A tombstone is not proof
                    # that this compute stopped or every orphan was removed.
                    raise Failure("EXECUTION_OUTCOME_UNKNOWN", 409)
            db.execute("UPDATE executions SET body='{}',checkpoint='{}',result=NULL,error=NULL,state='erased',authorization_until=0,lease_until=0,generation=generation+1 WHERE tenant=? AND workspace=? AND job=?", args)
            if db.execute("SELECT 1 FROM artifact_inventory WHERE tenant=? AND workspace=? AND job=? AND state!='deleted'", args).fetchone():
                raise Failure("ARTIFACT_CLEANUP_PENDING", 409)
            db.execute("INSERT OR IGNORE INTO erasure_tombstones VALUES(?,?,?,?)", (*args, time.time()))
        with self.db() as db:
            busy, _, _ = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            if busy:
                raise Failure("ERASURE_CHECKPOINT_PENDING", 409, True)
        return {"erased": True, "video_job_id": job, "live_execution_content_scrubbed": True, "backups_and_provider_storage": "separate_retention_required"}

    def claim(self, now=None):
        now = now or time.time()
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM executions WHERE state IN ('pending','running') AND next_run<=? AND lease_until<? AND authorization_until>? ORDER BY created_at LIMIT 1", (now, now, now)).fetchone()
            if row is None:
                return None
            generation = row["generation"] + 1
            db.execute("UPDATE executions SET state='running',generation=?,lease_until=? WHERE id=?", (generation, now + 45, row["id"]))
            return {**dict(row), "generation": generation}

    def active(self, row):
        with self.db() as db:
            changed = db.execute("UPDATE executions SET lease_until=? WHERE id=? AND generation=? AND state='running' AND authorization_until>? AND lease_until>?",
                                 (time.time() + 45, row["id"], row["generation"], time.time(), time.time())).rowcount
            current = db.execute("SELECT body FROM executions WHERE id=?", (row["id"],)).fetchone()
        if not changed:
            raise Failure("EXECUTION_AUTHORIZATION_LOST", 409)
        body = json.loads(current[0])
        return {k: body[k] for k in ("stage_attempt", "fencing_token")}

    def save(self, row, checkpoint):
        with self.db() as db:
            changed = db.execute("UPDATE executions SET checkpoint=? WHERE id=? AND generation=? AND state='running' AND authorization_until>? AND lease_until>?", (canonical(checkpoint).decode(), row["id"], row["generation"], time.time(), time.time())).rowcount
        if not changed:
            raise Failure("EXECUTION_FENCED", 409)

    def finish(self, row, state, *, result=None, error=None, delay=0):
        with self.db() as db:
            changed = db.execute("UPDATE executions SET state=?,result=?,error=?,lease_until=0,next_run=? WHERE id=? AND generation=? AND state='running' AND authorization_until>? AND lease_until>?",
                                 (state, canonical(result).decode() if result else None, canonical(error).decode() if error else None, time.time() + delay, row["id"], row["generation"], time.time(), time.time())).rowcount
        return bool(changed)


class Executor:
    def __init__(self, tasks, objects, processor, provider=None, temp_root=None):
        self.tasks, self.objects, self.processor, self.provider = tasks, objects, processor, provider
        self.temp_root = temp_root

    def run_once(self):
        row = self.tasks.claim()
        if row is None:
            return False
        body, checkpoint = json.loads(row["body"]), json.loads(row["checkpoint"])
        began = time.monotonic()
        def active():
            body.update(self.tasks.active(row))
        save = lambda value: self.tasks.save(row, value)
        def measured():
            usage = checkpoint.setdefault("usage", {})
            usage["execution_seconds_total"] = usage.get("execution_seconds_total", 0) + time.monotonic() - began
            usage["execution_quanta"] = usage.get("execution_quanta", 0) + 1
            save(checkpoint)
        def receipt(ref):
            from core import scope_key
            scope_key(ref["object_key"], body, body["video_job_id"])
            self.tasks.inventory_put(body, body["video_job_id"], ref)
            checkpoint.setdefault("artifacts", {})[ref["object_key"]] = ref
            save(checkpoint)
        # The heartbeat is an execution lease, not permission renewal. Only a
        # fresh signed Loom poll extends authorization_until.
        stop, lease_lost = threading.Event(), threading.Event()
        def heartbeat():
            while not stop.wait(10):
                try:
                    active()
                except Failure:
                    lease_lost.set()
                    return
        threading.Thread(target=heartbeat, daemon=True).start()
        def check():
            if lease_lost.is_set():
                raise Failure("EXECUTION_AUTHORIZATION_LOST", 409)
            active()
        try:
            with self.objects.journal(receipt, lambda ref: self.tasks.inventory_put(body, body["video_job_id"], ref, "write_pending")), self.tasks.temporary(body, body["video_job_id"], self.temp_root, row["id"], row["generation"]) as directory, scratch_budget(directory) as resources:
                if body.get("input_manifest"):
                    manifest = self.processor.process(body, directory, checkpoint, save, check)
                else:
                    manifest = self.acquire(body, directory, checkpoint, save, check)
                    if manifest is None:
                        measured()
                        self.tasks.finish(row, "pending", delay=5)
                        return True
                check()
                disk_guard(directory)
                checkpoint.setdefault("usage", {})["temporary_peak_bytes_observed"] = resources["peak_bytes_observed"]
                save(checkpoint)
                manifest["usage"] = checkpoint["usage"]
                manifest["objects"] = list({ref["object_key"]: ref for ref in manifest["objects"] + list(checkpoint.get("artifacts", {}).values())}.values())
                manifest["usage_receipts"] = checkpoint.get("usage_receipts", [])
                if len(canonical(manifest)) > 1500000:
                    raise Failure("OUTPUT_LIMIT_EXCEEDED", 413)
                measured()
                self.tasks.finish(row, "completed", result=manifest)
        except Failure as exc:
            if exc.code not in ("EXECUTION_AUTHORIZATION_LOST", "EXECUTION_FENCED"):
                try:
                    measured()
                except Failure:
                    return True
            if exc.code in ("MODEL_PENDING", "HOST_OUTCOME_PENDING"):
                self.tasks.finish(row, "pending", delay=5)
            elif exc.code not in ("EXECUTION_AUTHORIZATION_LOST", "EXECUTION_FENCED"):
                self.tasks.finish(row, "failed", error=exc.payload())
        except Exception:
            self.tasks.finish(row, "failed", error=Failure("PROCESSOR_FAILED", 500).payload())
        finally:
            stop.set()
        return True

    def acquire(self, body, directory, checkpoint, save, active):
        asset, job = body["asset"], body["video_job_id"]
        mode = processing_mode(body)
        maximum, max_seconds = media_limits(body["profile"])
        disk_guard(directory)
        # Legally supplied originals/subtitles must already be host-scoped objects.
        ref = asset.get("input_object")
        kind = asset.get("input_kind", "media")
        if ref:
            if kind == "platform_subtitles":
                if mode != "subtitles_first":
                    raise Failure("PROCESSING_MODE_REQUIRES_MEDIA", 422)
                from media import normalize_subtitles
                raw = self.objects.read(ref, body, job, 8 * 1024 * 1024)
                normalize_subtitles(json.loads(raw), body["profile"].get("language"))
                media_hash, availability = None, "not_acquired"
            elif kind == "media":
                path = directory / "input.media"
                self.objects.materialize(ref, body, job, path, maximum)
                info = probe(path, max_seconds)
                checkpoint.setdefault("usage", {}).update(input_bytes=ref["bytes"], media_duration_ms=info["duration_ms"])
                media_hash, availability = ref["sha256"], "available"
            else:
                raise Failure("INVALID_INPUT_KIND")
        else:
            if not self.provider:
                raise Failure("PROVIDER_NOT_CONFIGURED", 503)
            provider = self.provider.bind(body) if hasattr(self.provider, "bind") else self.provider
            if hasattr(provider, "authorize_scope"):
                provider.authorize_scope(body)
            if asset.get("credential_ref") and not hasattr(self.provider, "bind"):
                raise Failure("CREDENTIAL_MAPPING_UNAVAILABLE", 403)
            route = getattr(provider, "route_id", None)
            if checkpoint.get("provider_route_id") and checkpoint["provider_route_id"] != route:
                raise Failure("PROVIDER_ROUTE_CHANGED", 409)
            if route and not checkpoint.get("provider_route_id"):
                checkpoint["provider_route_id"] = route
                save(checkpoint)
            shortlink = urlsplit(asset.get("canonical_url", "")).hostname in ("b23.tv", "v.douyin.com")
            if (asset.get("reacquire") or shortlink) and not checkpoint.get("metadata_refreshed"):
                if not hasattr(provider, "resolve"):
                    raise Failure("PROVIDER_REFRESH_UNSUPPORTED", 503)
                if checkpoint.get("refresh_intent") and not checkpoint.get("refresh_task_id"):
                    raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409)
                if checkpoint.get("refresh_task_id"):
                    refresh = provider.task(checkpoint["refresh_task_id"])
                    if refresh.get("state") in ("queued", "running"):
                        return None
                    if refresh.get("state") == "failed":
                        raise Failure("PROVIDER_REFRESH_FAILED", 502)
                    refreshed = refresh.get("data")
                else:
                    checkpoint["refresh_intent"] = {"intent_key": body["intent_key"], "at": time.time()}
                    save(checkpoint)
                    active()
                    try:
                        refreshed = provider.resolve(asset["platform"], asset)
                    except Failure as exc:
                        if exc.code in ("AUTH_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED"):
                            checkpoint.pop("refresh_intent", None)
                            save(checkpoint)
                            raise
                        raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409) from None
                    if refreshed.get("task_id"):
                        checkpoint["refresh_task_id"] = refreshed["task_id"]
                        save(checkpoint)
                        return None
                if not isinstance(refreshed, dict) or refreshed.get("content_id") != asset["native_id"] or refreshed.get("platform", asset["platform"]) != asset["platform"]:
                    raise Failure("PROVIDER_ASSET_MISMATCH", 422)
                checkpoint["metadata_refreshed"] = True
                checkpoint["source_metadata"] = {k: refreshed.get(k) for k in ("title", "description", "created_at", "duration_ms")}
                if refreshed.get("web_url"):
                    from dtk import platform_url
                    checkpoint["source_metadata"]["canonical_url"] = platform_url(refreshed["web_url"], asset["platform"])
                checkpoint["source_metadata"]["resolution"] = {"provider_route_id": route, "task_id": checkpoint.get("refresh_task_id"), "submitted_url_sha256": sha(asset.get("canonical_url", "").encode()), "native_id": refreshed["content_id"], "refresh": bool(asset.get("reacquire"))}
                checkpoint["source_metadata"]["metadata_sha256"] = sha(canonical(checkpoint["source_metadata"]))
                save(checkpoint)
            if checkpoint.get("retry_submission_intent"):
                raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409)
            if checkpoint.get("submission_intent") and not checkpoint.get("external_download_id"):
                # Crash after send is indistinguishable from accepted+lost. Do not resubmit.
                raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409)
            if not checkpoint.get("external_download_id"):
                checkpoint["submission_intent"] = {"intent_key": body["intent_key"], "asset_sha256": sha(canonical(asset)), "at": time.time()}
                save(checkpoint)
                active()
                try:
                    external = provider.submit_download(asset)
                except Failure as exc:
                    if exc.code in ("AUTH_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED"):
                        checkpoint.pop("submission_intent", None)
                        save(checkpoint)
                        raise
                    raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409) from None
                checkpoint.update({"external_download_id": external["download_id"], "external_task_id": external.get("task_id")})
                save(checkpoint)
            download = provider.download(checkpoint["external_download_id"])
            if hasattr(provider, "authorize_scope") and (download.get("platform") != asset.get("platform") or download.get("content_id") != asset.get("native_id") or str(download.get("part") or 1) != str(asset.get("part_id") or "1")):
                raise Failure("PROVIDER_ASSET_MISMATCH", 422)
            if download["state"] in ("queued", "running"):
                return None
            if download["state"] != "done":
                if checkpoint.get("download_retry_requested"):
                    # Only an explicit host retry and a freshly confirmed terminal
                    # receipt permit a new download. DTK's /retry drops part_id in
                    # this locked revision; resubmit the exact frozen asset instead.
                    prior = checkpoint["external_download_id"]
                    checkpoint["retry_submission_intent"] = {"previous_download_id": prior, "at": time.time()}
                    save(checkpoint)
                    active()
                    try:
                        external = provider.submit_download(asset)
                    except Failure as exc:
                        if exc.code in ("AUTH_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED"):
                            checkpoint.pop("retry_submission_intent", None)
                            save(checkpoint)
                            raise
                        raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409) from None
                    checkpoint.setdefault("previous_download_ids", []).append(prior)
                    checkpoint.update(external_download_id=external["download_id"], external_task_id=external.get("task_id"))
                    checkpoint.pop("download_retry_requested", None)
                    checkpoint.pop("retry_submission_intent", None)
                    save(checkpoint)
                    return None
                raise Failure("DOWNLOAD_TERMINAL", 422)
            active()
            path = directory / "download.media"
            copied = provider.copy_media(download, path, maximum)
            info = probe(path, max_seconds)
            active()
            ref = self.objects.put_file(body, job, path, "source.media", copied["content_type"], maximum)
            checkpoint.setdefault("usage", {}).update(download_bytes=copied["bytes"], input_bytes=copied["bytes"], media_duration_ms=info["duration_ms"])
            save(checkpoint)
            media_hash, availability = ref["sha256"], "available"
        return {"schema_version": 1, "artifact_stage": "input_ready", "input_kind": kind, "video_job_id": job,
                "stage_attempt": body["stage_attempt"], "fencing_token": body["fencing_token"], "input_hash": ref["sha256"],
                "media_sha256": media_hash, "availability": availability, "objects": [ref],
                "coverage": {"required": [], "completed": [], "missing": [], "processing_mode": mode,
                             "duration_ms": checkpoint.get("usage", {}).get("media_duration_ms"),
                             "acquisition": "provided_subtitles" if kind == "platform_subtitles" else "full_media",
                             "subtitle_fallback_reason": "provider_subtitles_unsupported" if mode == "subtitles_first" and not asset.get("input_object") else None},
                "processors": {"version": "weavesense-acquire-v1", "processing_identity": self.processor.identity(body, kind), "acquisition_path": "authorized_user_upload" if asset.get("lawful_input") else "provided_scoped_artifact" if asset.get("input_object") else "dtk_download"}, "source_metadata": checkpoint.get("source_metadata"), "usage": checkpoint.get("usage", {})}
