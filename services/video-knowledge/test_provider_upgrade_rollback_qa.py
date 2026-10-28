"""COL-031 contract-upgrade rejection and rollback with real worker checkpoints.

Only the DTK HTTP responses and object store are synthetic. This exercises the
locked adapter, real HTTP client, SQLite reopening and ffprobe; it is not a real
upstream binary upgrade, platform acquisition, authorized pilot or deployment.
"""
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core import Failure, Objects, canonical, sha
from dtk import CredentialRoutes, LOCKED_COMMIT
from media import Processor
from runtime import Executor, Tasks


class FixtureStore:
    def __init__(self):
        self.data = {}

    def put_object(self, _bucket, key, stream, length, **_kwargs):
        raw = stream.read()
        assert len(raw) == length
        self.data[key] = raw


class ProviderUpgradeRollbackQA(unittest.TestCase):
    def test_schema_drift_blocks_then_locked_contract_resumes_the_original_download(self):
        self.assertEqual(LOCKED_COMMIT, "3d540dbf3783449e638403b65d81c882c4a99575")
        phase = "locked_pending"
        token = "synthetic-provider-rollback-token"
        download_id = "synthetic-stable-provider-download"
        calls, submissions = [], []
        media = io.BytesIO()
        with wave.open(media, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b"\0\0" * 1600)
        raw = media.getvalue()

        class Provider(BaseHTTPRequestHandler):
            def send(self, status, value):
                data = canonical(value)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def authorized(self):
                return self.headers.get("X-API-Key") == token

            def do_POST(self):
                calls.append((phase, "POST", self.path))
                if not self.authorized() or self.path != "/api/v1/downloads":
                    return self.send(403, {"error": "unexpected_fixture_request"})
                submissions.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send(200, {"success": True, "data": {"download_id": download_id}})

            def do_GET(self):
                calls.append((phase, "GET", self.path))
                if not self.authorized():
                    return self.send(403, {"error": "unexpected_fixture_request"})
                if self.path == f"/api/v1/downloads/{download_id}/files/source.wav":
                    if phase != "locked_restored":
                        return self.send(409, {"error": "media_must_not_be_read_before_rollback"})
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    return self.wfile.write(raw)
                if self.path != f"/api/v1/downloads/{download_id}":
                    return self.send(404, {"error": "unexpected_download_identity"})
                if phase == "incompatible_schema":
                    # A new, unrecognized status must fail closed even though
                    # the response claims success and provides a media file.
                    state = "completed_v2"
                else:
                    state = "queued" if phase == "locked_pending" else "done"
                self.send(200, {"success": True, "data": {"id": download_id, "state": state,
                    "platform": "bilibili", "content_id": "BV1ROLLBACK1", "part": 3, "on_disk": True,
                    "files": [{"kind": "video", "state": "done", "name": "source.wav",
                               "sha256": sha(raw), "bytes": len(raw), "content_type": "audio/wav"}]}})

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix="video-provider-rollback-test-") as root:
            root = Path(root)
            secret, config, database = root / "provider-token", root / "routes.json", root / "execution.sqlite"
            secret.write_text(token)
            scope = {"tenant_id": "upgrade_t", "workspace_id": "upgrade_w", "video_job_id": "upgrade_job"}
            config.write_bytes(canonical([{k: scope[k] for k in ("tenant_id", "workspace_id")} | {
                "credential_ref": "secret:synthetic-locked-provider", "origin": f"http://127.0.0.1:{server.server_address[1]}", "token_file": str(secret)}]))
            body = {**scope, "stage": "input", "stage_attempt": 1, "fencing_token": 1, "intent_key": "upgrade:stable-input",
                "profile": {"required_capabilities": ["transcript"]}, "asset": {"credential_ref": "secret:synthetic-locked-provider",
                "platform": "bilibili", "native_id": "BV1ROLLBACK1", "part_id": "3", "canonical_url": "https://www.bilibili.com/video/BV1ROLLBACK1?p=3"}}
            store, tasks = FixtureStore(), Tasks(database)
            objects, routes = Objects(store), CredentialRoutes(config_path=config)
            route_id = routes.bind(body).route_id
            receipt = tasks.submit(body, time.time() + 120)

            def checkpoint():
                with tasks.db() as db:
                    row = db.execute("SELECT * FROM executions WHERE id=?", (receipt["task_id"],)).fetchone()
                    return dict(row), json.loads(row["checkpoint"])

            self.assertTrue(Executor(tasks, objects, Processor(objects), routes, temp_root=root).run_once())
            pending = tasks.read(receipt["task_id"], scope)
            original_row, original_checkpoint = checkpoint()
            self.assertEqual(pending["state"], "pending")
            self.assertEqual(pending["external_download_id"], download_id)
            self.assertNotIn("manifest", pending)
            self.assertEqual(original_checkpoint["provider_route_id"], route_id)
            self.assertEqual(store.data, {})
            self.assertEqual(len(submissions), 1)

            # Let the real persisted five-second polling delay elapse. Reopen
            # SQLite/router as a new worker; no direct checkpoint/state edits.
            phase = "incompatible_schema"
            tasks, routes = Tasks(database), CredentialRoutes(config_path=config)
            time.sleep(max(0, original_row["next_run"] - time.time()) + 0.02)
            self.assertTrue(Executor(tasks, objects, Processor(objects), routes, temp_root=root).run_once())
            blocked = tasks.read(receipt["task_id"], scope)
            _, blocked_checkpoint = checkpoint()
            self.assertEqual(blocked["state"], "failed")
            self.assertEqual(blocked["error"]["code"], "PROVIDER_CONTRACT_CHANGED")
            self.assertEqual(blocked["external_download_id"], download_id)
            self.assertNotIn("manifest", blocked)
            self.assertNotIn("artifacts", blocked)
            self.assertEqual(tasks.inventory(scope, scope["video_job_id"])["artifacts"], [])
            self.assertEqual(store.data, {})
            self.assertEqual(len(submissions), 1)
            self.assertFalse(any("/files/" in path for _, _, path in calls))
            self.assertFalse(Executor(tasks, objects, Processor(objects), routes, temp_root=root).run_once())
            for key in ("provider_route_id", "external_download_id", "submission_intent"):
                self.assertEqual(blocked_checkpoint[key], original_checkpoint[key])

            # Restore the *synthetic locked HTTP contract*, not a claimed new
            # DTK binary release. A host retry retains the accepted remote ID.
            phase = "locked_restored"
            tasks, routes = Tasks(database), CredentialRoutes(config_path=config)
            self.assertEqual(routes.bind(body).route_id, route_id)
            retried = tasks.retry(receipt["task_id"], scope, time.time() + 120, {"stage_attempt": 2, "fencing_token": 3})
            self.assertTrue(retried["checkpoints_preserved"])
            self.assertTrue(Executor(tasks, objects, Processor(objects), routes, temp_root=root).run_once())
            completed = tasks.read(receipt["task_id"], scope)
            final_row, final_checkpoint = checkpoint()
            self.assertEqual(completed["state"], "completed")
            self.assertEqual(completed["task_id"], receipt["task_id"])
            self.assertEqual(completed["video_job_id"], scope["video_job_id"])
            self.assertEqual(completed["external_download_id"], download_id)
            self.assertEqual(completed["manifest"]["artifact_stage"], "input_ready")
            self.assertEqual(completed["manifest"]["input_hash"], sha(raw))
            self.assertEqual(completed["manifest"]["fencing_token"], 3)
            self.assertEqual(completed["manifest"]["stage_attempt"], 2)
            self.assertEqual(completed["usage"]["execution_quanta"], 3)
            self.assertEqual(list(store.data.values()), [raw])
            self.assertEqual(len(tasks.inventory(scope, scope["video_job_id"])["artifacts"]), 1)
            for key in ("id", "tenant", "workspace", "job", "intent", "payload_hash"):
                self.assertEqual(final_row[key], original_row[key])
            for key in ("provider_route_id", "external_download_id", "submission_intent"):
                self.assertEqual(final_checkpoint[key], original_checkpoint[key])
            self.assertEqual(submissions, [{"platform": "bilibili", "content_id": "BV1ROLLBACK1", "part": 3, "skip_existing": True}])
            self.assertEqual(calls, [("locked_pending", "POST", "/api/v1/downloads"),
                ("locked_pending", "GET", f"/api/v1/downloads/{download_id}"),
                ("incompatible_schema", "GET", f"/api/v1/downloads/{download_id}"),
                ("locked_restored", "GET", f"/api/v1/downloads/{download_id}"),
                ("locked_restored", "GET", f"/api/v1/downloads/{download_id}/files/source.wav")])
            self.assertEqual(tasks.submit(body, time.time() + 120)["task_id"], receipt["task_id"])
            self.assertFalse(Executor(tasks, objects, Processor(objects), routes, temp_root=root).run_once())
            with self.assertRaises(Failure) as denied:
                tasks.read(receipt["task_id"], {**scope, "workspace_id": "foreign_w"})
            self.assertEqual(denied.exception.status, 404)
            self.assertNotIn(token.encode(), canonical({"pending": pending, "blocked": blocked, "completed": completed}))
            for path in root.glob("execution.sqlite*"):
                self.assertNotIn(token.encode(), path.read_bytes())


if __name__ == "__main__":
    unittest.main()
