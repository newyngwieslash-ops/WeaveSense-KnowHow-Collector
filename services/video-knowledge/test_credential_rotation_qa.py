"""AC21 synthetic credential rotation over actual HTTP and durable worker retry.

The DTK HTTP server and object storage are explicit fixtures; Executor, SQLite
checkpoints, scoped credential resolution, HTTP client and ffprobe are real.
"""
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import tempfile
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core import Failure, Objects, canonical, sha
from dtk import CredentialRoutes
from media import Processor
from runtime import Executor, Tasks


class FixtureStore:
    def __init__(self):
        self.data = {}
    def put_object(self, _bucket, key, stream, length, **_kwargs):
        raw = stream.read()
        assert len(raw) == length
        self.data[key] = raw


class CredentialRotationQA(unittest.TestCase):
    def test_expired_key_rotate_restart_rate_limit_then_resume_same_download(self):
        old, new = "synthetic-expired-provider-key", "synthetic-rotated-provider-key"
        requests, submissions = [], []
        phase = "expired"
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
                self.send_header("Retry-After", "9")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def do_POST(self):
                requests.append(("POST", self.path, self.headers.get("X-API-Key")))
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                submissions.append(payload)
                self.send(200, {"success": True, "data": {"download_id": "synthetic-existing-download"}})
            def do_GET(self):
                requests.append(("GET", self.path, self.headers.get("X-API-Key")))
                if self.headers.get("X-API-Key") != new:
                    self.send(401, {"error": f"synthetic expired credential detail echoes {old} and {new}"})
                elif phase == "limited":
                    self.send(429, {"error": f"synthetic capacity detail echoes {old} and {new}"})
                elif self.path.endswith("/files/source.wav"):
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                else:
                    self.send(200, {"success": True, "data": {"id": "synthetic-existing-download", "state": "done", "platform": "bilibili", "content_id": "BV1ROTATE001", "part": 3,
                        "on_disk": True, "files": [{"kind": "video", "state": "done", "name": "source.wav", "sha256": sha(raw), "bytes": len(raw), "content_type": "audio/wav"}]}})
            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix="video-rotation-test-") as root:
            root = Path(root)
            secret, config, database = root / "provider-token", root / "routes.json", root / "execution.sqlite"
            secret.write_text(old)
            scope = {"tenant_id": "rotation_t", "workspace_id": "rotation_w", "video_job_id": "rotation_job"}
            config.write_bytes(canonical([{k: scope[k] for k in ("tenant_id", "workspace_id")} | {
                "credential_ref": "secret:synthetic-dtk", "origin": f"http://127.0.0.1:{server.server_address[1]}", "token_file": str(secret)}]))
            body = {**scope, "stage": "input", "stage_attempt": 1, "fencing_token": 1, "intent_key": "rotation:stable-input",
                "profile": {"required_capabilities": ["transcript"]}, "asset": {"credential_ref": "secret:synthetic-dtk", "platform": "bilibili", "native_id": "BV1ROTATE001", "part_id": "3", "canonical_url": "https://www.bilibili.com/video/BV1ROTATE001?p=3"}}
            store, tasks = FixtureStore(), Tasks(database)
            objects = Objects(store)
            routes = CredentialRoutes(config_path=config)
            original_route = routes.bind(body).route_id
            receipt = tasks.submit(body, time.time() + 120)
            executor = Executor(tasks, objects, Processor(objects), routes, temp_root=root)
            stdout, stderr = io.StringIO(), io.StringIO()
            def run(worker):
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    self.assertTrue(worker.run_once())
            run(executor)
            failed = tasks.read(receipt["task_id"], scope)
            self.assertEqual(failed["state"], "failed")
            self.assertEqual(failed["error"]["code"], "AUTH_REQUIRED")
            self.assertEqual(failed["external_download_id"], "synthetic-existing-download")
            self.assertEqual(len(submissions), 1)
            self.assertEqual(store.data, {})

            # Operator rotates the mounted key, then restarts the worker/router.
            # The route identity intentionally excludes the key, so the already
            # accepted remote download remains the only operational identity.
            secret.write_text(new)
            tasks, routes = Tasks(database), CredentialRoutes(config_path=config)
            self.assertEqual(routes.bind(body).route_id, original_route)
            phase = "limited"
            retried = tasks.retry(receipt["task_id"], scope, time.time() + 120, {"stage_attempt": 2, "fencing_token": 3})
            self.assertTrue(retried["checkpoints_preserved"])
            executor = Executor(tasks, objects, Processor(objects), routes, temp_root=root)
            run(executor)
            limited = tasks.read(receipt["task_id"], scope)
            self.assertEqual(limited["error"]["code"], "RATE_LIMITED")
            self.assertEqual(limited["error"]["retry_after"], 9)
            self.assertEqual(limited["external_download_id"], failed["external_download_id"])
            self.assertEqual(len(submissions), 1)
            self.assertEqual(store.data, {})
            phase = "ready"
            tasks.retry(receipt["task_id"], scope, time.time() + 120, {"stage_attempt": 3, "fencing_token": 4})
            run(executor)
            finished = tasks.read(receipt["task_id"], scope)
            self.assertEqual(finished["state"], "completed")
            self.assertEqual(finished["task_id"], receipt["task_id"])
            self.assertEqual(finished["external_download_id"], failed["external_download_id"])
            self.assertEqual(finished["manifest"]["input_hash"], sha(raw))
            self.assertEqual(finished["manifest"]["fencing_token"], 4)
            self.assertEqual(finished["usage"]["execution_quanta"], 3)
            self.assertGreater(finished["usage"]["execution_seconds_total"], 0)
            self.assertEqual(finished["usage"]["download_bytes"], len(raw))
            self.assertEqual(len(store.data), 1)
            self.assertEqual(list(store.data.values()), [raw])
            self.assertEqual(len(submissions), 1)
            self.assertEqual(submissions[0]["part"], 3)
            self.assertEqual([key for _, _, key in requests], [old, old, new, new, new])
            self.assertEqual(tasks.submit(body, time.time() + 120)["task_id"], receipt["task_id"])
            before = len(requests)
            with self.assertRaises(Failure) as denied:
                routes.bind({**body, "workspace_id": "foreign_workspace"})
            self.assertEqual(denied.exception.status, 403)
            self.assertEqual(len(requests), before)
            # Public task/error projection is exactly what the worker read API
            # serializes. Even a provider body echoing BOTH keys must be reduced
            # to allowlisted codes/retry metadata, never forwarded as detail.
            self.assertEqual(set(failed["error"]), {"code", "retryable", "retry_after"})
            self.assertEqual(set(limited["error"]), {"code", "retryable", "retry_after"})
            visible = canonical({"failed": failed, "limited": limited, "finished": finished, "retry": retried})
            for value in (old, new, "expired credential detail", "capacity detail"):
                self.assertNotIn(value.encode(), visible)
                self.assertNotIn(value, stdout.getvalue())
                self.assertNotIn(value, stderr.getvalue())
            for path in root.glob("execution.sqlite*"):
                contents = path.read_bytes()
                self.assertNotIn(old.encode(), contents)
                self.assertNotIn(new.encode(), contents)


if __name__ == "__main__":
    unittest.main()
