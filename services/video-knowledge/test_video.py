import base64
from contextlib import contextmanager
from collections import namedtuple
import copy
import hashlib
import hmac
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlencode

from core import Failure, Objects, canonical, scope_key, sha, verify_context, disk_guard
from dtk import DTK, CredentialRoutes, share_url
from media import Processor, chunk_plan, command, extract_frames, frame_grids, merge_chunks, normalize_subtitles, probe, numeric_disagreements
from runtime import Executor, Tasks
from server import handler

SCOPE = {"tenant_id": "tn_a", "workspace_id": "ws_a"}
JOB = "vjob_a"
KEY = "test-signing-key-32-bytes-minimum-value"


class Response(io.BytesIO):
    def release_conn(self):
        pass


class Store:
    def __init__(self):
        self.data = {}
    def put_object(self, bucket, key, data, length, **kwargs):
        self.data[key] = data.read()
        assert len(self.data[key]) == length
    def get_object(self, bucket, key):
        return Response(self.data[key])
    def remove_object(self, bucket, key):
        self.data.pop(key, None)


def token(scope=SCOPE, permission="video.execute", job=JOB, expires=120):
    now = int(time.time())
    claims = {"iss": "loom-engine", "aud": "video-knowledge", "actor": {"type": "service_principal", "id": "loom-engine"}, "iat": now,
              "exp": now + expires, "scopes": [permission], "job_id": job, "stage_attempt": 1, "fencing_token": 1, **scope}
    enc = lambda value: base64.urlsafe_b64encode(canonical(value)).decode().rstrip("=")
    unsigned = enc({"alg": "HS256", "typ": "JWT"}) + "." + enc(claims)
    return unsigned + "." + base64.urlsafe_b64encode(hmac.new(KEY.encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def body():
    return {**SCOPE, "video_job_id": JOB, "stage": "input", "stage_attempt": 1, "fencing_token": 1, "intent_key": "input:a", "profile": {"required_capabilities": ["transcript"], "version": 1}, "asset": {}}


class VideoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store()
        self.objects = Objects(self.store)
        self.tasks = Tasks(self.root / "execution.sqlite")
    def tearDown(self):
        self.tmp.cleanup()

    def media(self, seconds=2.4, name="video.mp4"):
        path = self.root / name
        command(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", str(seconds), "-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", "-y", str(path)])
        return path

    def input(self, path):
        b = body()
        ref = self.objects.put_file(b, JOB, path, "source.mp4", "video/mp4", 1024 * 1024)
        return {"schema_version": 1, "artifact_stage": "input_ready", "video_job_id": JOB, "stage_attempt": 1, "fencing_token": 1,
                "input_kind": "media", "input_hash": ref["sha256"], "media_sha256": ref["sha256"], "availability": "available", "objects": [ref]}

    @contextmanager
    def http(self):
        executor = Executor(self.tasks, self.objects, Processor(self.objects), temp_root=self.root)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler(self.tasks, executor, self.objects, None, "service", KEY))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            def request(path, raw=None, permission="video.read", method=None, headers=None):
                req = Request(f"http://127.0.0.1:{server.server_address[1]}" + path, raw,
                              {"Authorization": "Bearer service", "X-Flow-Execution-Context": token(permission=permission), **(headers or {})}, method=method)
                return urlopen(req)
            yield request
        finally:
            server.shutdown()
            server.server_close()

    def test_lawful_upload_stream_hash_reconcile_range_and_tombstone(self):
        raw = self.media(seconds=.4).read_bytes()
        descriptor = {"video_job_id": JOB, "input_kind": "media", "bytes": len(raw), "sha256": sha(raw), "content_type": "video/mp4"}
        with self.http() as request:
            with request("/v1/inputs?" + urlencode(descriptor), raw, "video.upload", "PUT") as response:
                ref = json.load(response)
                self.assertEqual(response.status, 201)
            with request("/v1/inputs?" + urlencode({"video_job_id": JOB, "sha256": sha(raw)})) as response:
                self.assertEqual(json.load(response), ref)
            path = "/v1/objects?" + urlencode({"key": ref["object_key"], "video_job_id": JOB})
            with request(path, headers={"Range": "bytes=3-17"}) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers["Content-Type"], "video/mp4")
                self.assertEqual(response.read(), raw[3:18])
            for bad in ("bytes=99-5", "bytes=0-1,3-4", "bytes=-0", "bytes=999999999-"):
                with self.assertRaises(HTTPError) as error:
                    request(path, headers={"Range": bad})
                self.assertEqual(error.exception.code, 416)
            with self.assertRaises(HTTPError) as error:
                request("/v1/inputs?" + urlencode({**descriptor, "sha256": "a" * 64}), raw, "video.upload", "PUT")
            self.assertEqual(error.exception.code, 422)
            # A failed/ambiguous upload remains a cleanup-only inventory entry.
            self.assertEqual(len(self.tasks.inventory(SCOPE, JOB)["artifacts"]), 2)
            with self.tasks.db() as db:
                db.execute("UPDATE artifact_inventory SET lease_until=0")
            for item in self.tasks.inventory(SCOPE, JOB)["artifacts"]:
                with request("/v1/objects/delete", canonical({"video_job_id": JOB, "object_key": item["object_key"], "sha256": item["sha256"]}), "video.delete") as response:
                    self.assertTrue(json.load(response)["deleted"])
            with request("/v1/jobs/erase", canonical({"video_job_id": JOB}), "video.delete") as response:
                self.assertTrue(json.load(response)["erased"])
            with self.assertRaises(HTTPError) as error:
                request("/v1/inputs?" + urlencode(descriptor), raw, "video.upload", "PUT")
            self.assertEqual(error.exception.code, 410)

    def test_upload_subtitles_are_not_media_and_bad_mime_rejected(self):
        raw = canonical({"kind": "manual", "language": "zh", "segments": [{"text": "legal supplied text", "start_ms": 0, "end_ms": 1000}]})
        with self.http() as request:
            descriptor = {"video_job_id": JOB, "input_kind": "platform_subtitles", "bytes": len(raw), "sha256": sha(raw), "content_type": "application/json"}
            with request("/v1/inputs?" + urlencode(descriptor), raw, "video.upload", "PUT") as response:
                ref = json.load(response)
            b = body()
            b["asset"] = {"input_kind": "platform_subtitles", "input_object": ref}
            executor = Executor(self.tasks, self.objects, Processor(self.objects))
            result = executor.acquire(b, self.root, {}, lambda _: None, lambda: None)
            self.assertIsNone(result["media_sha256"])
            self.assertEqual(result["processors"]["processing_identity"], executor.processor.identity(b, "platform_subtitles"))
            with self.assertRaises(HTTPError) as error:
                request("/v1/inputs?" + urlencode({**descriptor, "input_kind": "media", "content_type": "video/mp4"}), raw, "video.upload", "PUT")
            self.assertEqual(error.exception.code, 415)

    def test_free_watermark_before_and_during_spool(self):
        disk = namedtuple("Disk", "total used free")
        with patch("core.shutil.disk_usage", return_value=disk(1000000000, 999999999, 1)):
            with self.assertRaises(Failure) as error:
                disk_guard(self.root, 1)
            self.assertEqual(error.exception.code, "STORAGE_PRESSURE")
        ref = self.objects.put(SCOPE, JOB, b"x" * (2 * 1024 * 1024), "media.bin")
        with patch("core.shutil.disk_usage", side_effect=[disk(1000000000, 0, 1000000000), disk(1000000000, 999999999, 1)]):
            with self.assertRaises(Failure) as error:
                self.objects.materialize(ref, SCOPE, JOB, self.root / "copy.bin", ref["bytes"])
            self.assertEqual(error.exception.status, 507)
        self.assertFalse((self.root / "copy.bin.partial").exists())

    def test_temp_cleanup_never_deletes_live_flock_or_other_scope(self):
        with self.tasks.temporary(SCOPE, JOB, self.root) as path:
            (path / "chunk").write_bytes(b"sample")
            with self.tasks.db() as db:
                db.execute("UPDATE temporary_paths SET created_at=1")
            receipt = self.tasks.sweep_temporary(SCOPE, JOB, time.time())
            self.assertEqual(len(receipt["skipped_active_ids"]), 1)
            self.assertTrue(path.exists())
            with self.assertRaises(Failure):
                self.tasks.assert_cleanup_allowed(SCOPE, JOB)
        identity = "a" * 32
        stale = self.root / ("video-" + identity + "-abandoned")
        stale.mkdir()
        (stale / ".lease.lock").touch()
        with self.tasks.db() as db:
            db.execute("INSERT INTO temporary_paths VALUES(?,?,?,?,?,?,?,?)", (identity, SCOPE["tenant_id"], SCOPE["workspace_id"], JOB, None, None, str(stale), 1))
        self.assertFalse(self.tasks.sweep_temporary({**SCOPE, "workspace_id": "foreign"}, JOB, time.time())["deleted_temporary_ids"])
        self.assertTrue(stale.exists())
        self.assertEqual(self.tasks.sweep_temporary(SCOPE, JOB, time.time())["deleted_temporary_ids"], [identity])
        self.assertFalse(stale.exists())

    def test_visual_parts_bound_pages_and_keep_derived_distinct(self):
        b = body()
        b["profile"]["required_capabilities"] = ["vision", "ocr", "vlm"]
        b["input_manifest"] = self.input(self.media(seconds=.4))
        class Gateway:
            def observe(self, body, frames, checkpoint, save, active):
                return [{"kind": "inference", "text": "synthetic model inference", "frame_ids": [frames[0]["frame_id"]]}]
        processor = Processor(self.objects, ocr=lambda ref, scope: {"text": "observed synthetic glyphs"}, gateway=Gateway())
        result = processor.process(b, self.root, {}, lambda _: None, lambda: None)
        records = [r for part in result["visual"]["parts"] for r in json.loads(self.objects.read(part, SCOPE, JOB))["records"]]
        self.assertTrue(any(r["type"] == "ocr" and r["observed_text"] == r["text"] for r in records))
        self.assertTrue(any(r["type"] == "model_inference" and r["derived"] for r in records))
        self.assertTrue(all(r.get("semantic_relation") == "not_assessed" for r in records if r["type"] == "alignment"))
        self.assertNotIn("synthetic model inference", " ".join(json.loads(self.objects.read(p, SCOPE, JOB))["segments"][0]["text"] for p in result["transcript"]["parts"]))
        many = [{"type": "frame", "start_ms": i, "end_ms": i, "frame_id": str(i)} for i in range(205)]
        pages = processor.visual_parts(SCOPE, JOB, many)["parts"]
        self.assertEqual([p["record_count"] for p in pages], [100, 100, 5])
        self.assertIsNone(result["processors"]["processing_identity"])

    def test_recheck_refresh_then_reacquire_never_joins_stored_cache(self):
        calls = []
        class Client:
            def json(self, method, path, body=None):
                calls.append((method, path, body))
                if "/parse?" in path:
                    return {"success": True, "data": {"task_id": "refresh-1", "state": "queued"}}
                if "/tasks/" in path:
                    return {"success": True, "data": {"state": "done", "data": {"content_id": "BVtest", "platform": "bilibili", "title": "changed title", "description": "changed body"}}}
                if method == "POST":
                    return {"success": True, "data": {"download_id": "fresh-1", "task_id": "download-1"}}
                return {"success": True, "data": {"id": "fresh-1", "state": "running", "platform": "bilibili", "content_id": "BVtest", "part": 2}}
        b = body()
        b["asset"] = {"platform": "bilibili", "native_id": "BVtest", "part_id": "2", "canonical_url": "https://www.bilibili.com/video/BVtest?p=2", "reacquire": True}
        provider = DTK("http://dtk", "token", Client(), allowed_scopes={(SCOPE["tenant_id"], SCOPE["workspace_id"])})
        executor = Executor(self.tasks, self.objects, Processor(self.objects), provider)
        checkpoint = {}
        for _ in range(3):
            self.assertIsNone(executor.acquire(b, self.root, checkpoint, lambda _: None, lambda: None))
        self.assertEqual(sum("/parse?" in c[1] for c in calls), 1)
        self.assertIn("refresh=true", calls[0][1])
        submits = [c[2] for c in calls if c[0] == "POST" and c[1] == "/api/v1/downloads"]
        self.assertEqual(submits, [{"platform": "bilibili", "content_id": "BVtest", "part": 2, "skip_existing": False}])
        self.assertEqual(checkpoint["source_metadata"]["description"], "changed body")

    def test_numeric_conflicts_preserve_both_sides_without_truth_claim(self):
        frame = {"timestamp_ms": 100, "object_key": "fixture-frame"}
        audio = [{"text": "速度：２０ km/h", "start_ms": 0, "end_ms": 200}]
        result, _ = numeric_disagreements(audio, "速度: 30 km/h", frame)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["truth_status"], "not_asserted")
        self.assertEqual(result[0]["audio"]["text"], audio[0]["text"])
        self.assertEqual(result[0]["visual"]["text"], "速度: 30 km/h")
        for not_conflict in ("速度: 20.0 km/h", "距离: 30 km/h", "速度: 30 m/s", "30 km/h", "速度: 20 km/h; 速度: 30 km/h"):
            self.assertEqual(numeric_disagreements(audio, not_conflict, frame)[0], [])

    def test_scoped_credential_alias_routes_actual_auth_without_payload_secrets(self):
        secret = self.root / "dtk-token"
        secret.write_text("synthetic-test-api-key-not-a-real-secret")
        config = self.root / "routes.json"
        config.write_bytes(canonical([{**SCOPE, "credential_ref": "secret:dtk-a", "origin": "http://dtk-a:8000", "token_file": str(secret)}]))
        router = CredentialRoutes(config_path=config)
        b = body()
        b["asset"] = {"credential_ref": "secret:dtk-a", "platform": "bilibili", "native_id": "BVtest", "canonical_url": "https://www.bilibili.com/video/BVtest"}
        provider = router.bind(b)
        requests = []
        def open_request(request, timeout):
            requests.append(request)
            return Response(canonical({"success": True, "data": {"task_id": "resolved", "state": "queued"}}))
        provider.http.opener.open = open_request
        provider.resolve("bilibili", b["asset"])
        self.assertEqual(requests[0].get_header("X-api-key"), secret.read_text())
        self.assertEqual(requests[0].full_url, "http://dtk-a:8000/api/v1/parse?wait=0")
        for changed in ({**b, "workspace_id": "foreign"}, {**b, "asset": {"credential_ref": "secret:missing"}}):
            with self.assertRaises(Failure) as error:
                router.bind(changed)
            self.assertEqual(error.exception.status, 403)
        self.tasks.submit(b, time.time() + 100)
        with self.tasks.db() as db:
            self.assertNotIn(secret.read_text(), db.execute("SELECT body FROM executions").fetchone()[0])
        row = self.tasks.claim()
        checkpoint = {"provider_route_id": "wrong-instance-route"}
        with self.assertRaises(Failure) as error:
            Executor(self.tasks, self.objects, Processor(self.objects), router).acquire(b, self.root, checkpoint, lambda _: None, lambda: None)
        self.assertEqual(error.exception.code, "PROVIDER_ROUTE_CHANGED")

    def test_share_text_and_single_video_discovery_use_actual_parse_identity(self):
        text = "分享作品 https://b23.tv/fixture。 打开应用查看"
        self.assertEqual(share_url(text, "bilibili"), "https://b23.tv/fixture")
        for unsafe in ("https://b23.tv/a https://b23.tv/b", "https://127.0.0.1/video", "https://www.bilibili.com@evil.invalid/x", "http://www.bilibili.com/video/BVtest", "x" * 4097):
            with self.assertRaises(Failure):
                share_url(unsafe, "bilibili")
        calls = []
        class Client:
            def json(self, method, path, body=None):
                calls.append(path)
                if "/parse?" in path:
                    return {"success": True, "data": {"task_id": "parse-real-fixture", "state": "queued"}}
                return {"success": True, "data": {"state": "done", "data": {"content_id": "BVresolved", "title": "actual provider identity fixture", "description": "full metadata body", "web_url": "https://www.bilibili.com/video/BVresolved", "parts": [{"part": 1}, {"part": 2}]}}}
        dtk = DTK("http://dtk", "synthetic", Client(), allowed_scopes={(SCOPE["tenant_id"], SCOPE["workspace_id"])})
        b = {**SCOPE, "platform": "bilibili", "source": {"source_type": "video", "part_id": "2"}, "url": "https://b23.tv/fixture"}
        pending = dtk.discover(b)
        complete = dtk.discover({**b, "cursor": pending["next_cursor"]})
        self.assertEqual(calls, ["/api/v1/parse?wait=0", "/api/v1/tasks/parse-real-fixture"])
        self.assertEqual(complete["items"][0]["native_id"], "BVresolved")
        self.assertEqual(complete["items"][0]["part_id"], "2")
        self.assertEqual(complete["items"][0]["description"], "full metadata body")

    def test_missing_registered_object_is_explicit_404_and_tamper_422(self):
        ref = self.objects.put(SCOPE, JOB, b"immutable", "test.json")
        self.tasks.inventory_put(SCOPE, JOB, ref)
        path = "/v1/objects?" + urlencode({"key": ref["object_key"], "video_job_id": JOB})
        with self.http() as request:
            self.store.data[ref["object_key"]] = b"tampered"
            with self.assertRaises(HTTPError) as error:
                request(path)
            self.assertEqual(error.exception.code, 422)
            del self.store.data[ref["object_key"]]
            with self.assertRaises(HTTPError) as error:
                request(path)
            self.assertEqual(error.exception.code, 404)

    def test_scope_auth_and_hash_rejects_forgery(self):
        ref = self.objects.put(SCOPE, JOB, b"sample", "sample.txt")
        self.assertEqual(self.objects.read(ref, SCOPE, JOB), b"sample")
        for key in (ref["object_key"].replace("tn_a", "tn_b"), ref["object_key"].replace("sample.txt", "../sample.txt")):
            with self.assertRaises(Failure):
                scope_key(key, SCOPE, JOB)
        self.assertEqual(verify_context(token(), KEY, SCOPE, "video.execute", JOB)["job_id"], JOB)
        for args in [(token(), {**SCOPE, "workspace_id": "ws_b"}), (token(expires=-1), SCOPE)]:
            with self.assertRaises(Failure):
                verify_context(args[0], KEY, args[1], "video.execute", JOB)
        self.store.data[ref["object_key"]] = b"tamper"
        with self.assertRaises(Failure):
            self.objects.read(ref, SCOPE, JOB)

    def test_object_cleanup_is_scoped_hashed_and_idempotent(self):
        ref = self.objects.put(SCOPE, JOB, b"content", "content.txt")
        with self.assertRaises(Failure):
            self.objects.delete(ref["object_key"], ref["sha256"], {**SCOPE, "workspace_id": "foreign"}, JOB)
        self.assertIn(ref["object_key"], self.store.data)
        with self.assertRaises(Failure):
            self.objects.delete(ref["object_key"], "a" * 64, SCOPE, JOB)
        self.assertTrue(self.objects.delete(ref["object_key"], ref["sha256"], SCOPE, JOB)["deleted"])
        self.assertTrue(self.objects.delete(ref["object_key"], ref["sha256"], SCOPE, JOB)["deleted"])

    def test_durable_idempotency_recovery_and_conflict(self):
        b = body()
        first = self.tasks.submit(b, time.time() + 100)
        reopened = Tasks(self.tasks.path)
        self.assertEqual(first["task_id"], reopened.submit(b, time.time() + 100)["task_id"])
        self.assertEqual(first["task_id"], reopened.reconcile({**SCOPE, "video_job_id": JOB}, b["intent_key"])["task_id"])
        b["profile"]["language"] = "zh"
        with self.assertRaises(Failure) as err:
            reopened.submit(b, time.time() + 100)
        self.assertEqual(err.exception.code, "IDEMPOTENCY_CONFLICT")

    def test_expired_owner_and_cancel_cannot_commit(self):
        created = self.tasks.submit(body(), time.time() + 100)
        old = self.tasks.claim()
        with self.tasks.db() as db:
            db.execute("UPDATE executions SET lease_until=0 WHERE id=?", (old["id"],))
        with self.assertRaises(Failure):
            self.tasks.active(old)
        fresh = self.tasks.claim()
        self.assertFalse(self.tasks.finish(old, "completed", result={"forged": True}))
        self.tasks.cancel(created["task_id"], {**SCOPE, "video_job_id": JOB})
        self.assertFalse(self.tasks.finish(fresh, "completed", result={"forged": True}))
        self.assertEqual(self.tasks.read(created["task_id"], {**SCOPE, "video_job_id": JOB})["state"], "cancelled")

    def test_subtitles_only_never_claim_media_or_knowledge_ready(self):
        raw = canonical({"kind": "manual", "language": "zh", "segments": [{"text": "中文😀原文", "start_ms": 0, "end_ms": 1000}]})
        b = body()
        b["asset"] = {"input_kind": "platform_subtitles", "input_object": self.objects.put(SCOPE, JOB, raw, "subtitles.json")}
        start = self.tasks.submit(b, time.time() + 100)
        executor = Executor(self.tasks, self.objects, Processor(self.objects))
        executor.run_once()
        result = self.tasks.read(start["task_id"], {**SCOPE, "video_job_id": JOB})
        self.assertEqual(result["state"], "completed")
        source = result["manifest"]
        self.assertIsNone(source["media_sha256"])
        self.assertEqual(source["availability"], "not_acquired")
        b.update(stage="process", stage_attempt=2, fencing_token=2, intent_key="process:a", input_manifest=source)
        start = self.tasks.submit(b, time.time() + 100)
        executor.run_once()
        result = self.tasks.read(start["task_id"], {**SCOPE, "video_job_id": JOB})["manifest"]
        self.assertEqual(result["parent_manifest_sha256"], sha(canonical({**source, "stage_attempt": 0, "fencing_token": 0})))
        self.assertNotIn("knowledge_ready", result)
        self.assertNotIn("evidence_id", str(result))
        self.assertEqual(result["transcript"]["parts"][0]["segment_count"], 1)

    def test_invalid_subtitles_and_language(self):
        for data in [{"kind": "manual", "segments": []}, {"kind": "manual", "segments": [{"text": "x", "start_ms": -1, "end_ms": 2}]}]:
            with self.assertRaises(Failure):
                normalize_subtitles(data)
        automatic = {"kind": "automatic", "language": "zh", "segments": [{"text": "auto", "start_ms": 0, "end_ms": 10}]}
        manual = {**automatic, "kind": "manual", "segments": [{"text": "manual", "start_ms": 0, "end_ms": 10}]}
        self.assertEqual(normalize_subtitles({"tracks": [automatic, manual]}, "zh")[0]["text"], "manual")
        manual["segments"][0]["end_ms"] = -1
        self.assertEqual(normalize_subtitles({"tracks": [manual, automatic]}, "zh")[0]["subtitle_kind"], "automatic")

    def test_real_ffmpeg_short_tail_grid_and_isolated_directories(self):
        path = self.media(seconds=0.4)
        info = probe(path)
        first, coverage = extract_frames(path, self.root / "job-a", info, interval_ms=1000)
        second, _ = extract_frames(path, self.root / "job-b", info, interval_ms=1000)
        grids = frame_grids(first, self.root / "grids")
        self.assertGreaterEqual(len(first), 1)
        self.assertEqual(sum(len(g["frame_ids"]) for g in grids), len(first))
        self.assertFalse(coverage["full_frame_analysis"])
        first[0]["path"].unlink()
        self.assertTrue(second[0]["path"].is_file())

    def test_real_ffmpeg_concurrent_jobs_cancel_one_preserves_other_live_frames(self):
        media = self.media()
        entered = {job: threading.Event() for job in ("concurrent_a", "concurrent_b")}
        release = {job: threading.Event() for job in entered}
        specs, task_ids = {}, {}
        for job in entered:
            spec = body()
            spec.update(video_job_id=job, stage="process", intent_key="concurrent:" + job,
                        workspace_id="concurrent_workspace_a" if job.endswith("a") else "concurrent_workspace_b",
                        profile={"required_capabilities": ["vision", "ocr"], "frame_interval_ms": 1000, "max_frames": 10})
            ref = self.objects.put_file(spec, job, media, "source.mp4", "video/mp4", 1024 * 1024)
            spec["input_manifest"] = {"schema_version": 1, "artifact_stage": "input_ready", "video_job_id": job,
                                      "input_kind": "media", "input_hash": ref["sha256"], "media_sha256": ref["sha256"],
                                      "availability": "available", "objects": [ref]}
            specs[job] = spec
            task_ids[job] = self.tasks.submit(spec, time.time() + 120)["task_id"]

        def ocr(ref, scope):
            job = scope["video_job_id"]
            entered[job].set()
            if not release[job].wait(15):
                raise Failure("SYNTHETIC_OCR_BARRIER_TIMEOUT", 504)
            return {"text": "synthetic OCR for " + job, "engine": "explicit-test-fixture"}

        executor = Executor(self.tasks, self.objects, Processor(self.objects, ocr=ocr), temp_root=self.root)
        workers = [threading.Thread(target=executor.run_once, daemon=True) for _ in entered]
        try:
            for worker in workers:
                worker.start()
            self.assertTrue(all(event.wait(10) for event in entered.values()), "both real FFmpeg executions must reach their OCR boundaries concurrently")
            with self.tasks.db() as db:
                rows = {row["job"]: dict(row) for row in db.execute("SELECT * FROM temporary_paths")}
            self.assertEqual(set(rows), set(entered))
            paths = {job: Path(row["path"]) for job, row in rows.items()}
            self.assertNotEqual(paths["concurrent_a"], paths["concurrent_b"])
            live_frames = {path.relative_to(paths["concurrent_b"]): sha(path.read_bytes()) for path in paths["concurrent_b"].rglob("*.jpg")}
            self.assertGreaterEqual(len(live_frames), 3, "real second-job sampled frames and grid must exist before cancellation")
            self.tasks.cancel(task_ids["concurrent_a"], specs["concurrent_a"])
            release["concurrent_a"].set()
            deadline = time.time() + 10
            while paths["concurrent_a"].exists() and time.time() < deadline:
                time.sleep(.02)
            self.assertFalse(paths["concurrent_a"].exists(), "cancelled execution must release only its temporary directory")
            self.assertTrue(paths["concurrent_b"].exists(), "the other execution is still live, not a previously completed fixture")
            self.assertEqual({path: sha((paths["concurrent_b"] / path).read_bytes()) for path in live_frames}, live_frames)
            self.assertFalse(release["concurrent_b"].is_set())
            release["concurrent_b"].set()
        finally:
            for event in release.values():
                event.set()
            for worker in workers:
                worker.join(timeout=15)
            self.assertFalse(any(worker.is_alive() for worker in workers))
        with self.tasks.db() as db:
            finished = {row["job"]: dict(row) for row in db.execute("SELECT * FROM executions")}
            self.assertEqual(db.execute("SELECT count(*) FROM temporary_paths").fetchone()[0], 0)
        self.assertEqual(finished["concurrent_a"]["state"], "cancelled")
        self.assertIsNone(finished["concurrent_a"]["result"])
        self.assertEqual(finished["concurrent_b"]["state"], "completed")
        manifest = json.loads(finished["concurrent_b"]["result"])
        self.assertGreaterEqual(len(manifest["frames"]), 2)
        self.assertEqual(set(manifest["coverage"]["completed"]), {"vision", "ocr"})
        for ref in manifest["objects"]:
            self.assertIn("/workspaces/concurrent_workspace_b/video/concurrent_b/", ref["object_key"])
            self.assertEqual(sha(self.objects.read(ref, specs["concurrent_b"], "concurrent_b", 1024 * 1024)), ref["sha256"])
        transcript = [segment for part in manifest["transcript"]["parts"] for segment in json.loads(self.objects.read(part, specs["concurrent_b"], "concurrent_b"))["segments"]]
        self.assertTrue(transcript and all(segment["text"] == "synthetic OCR for concurrent_b" for segment in transcript))
        self.assertTrue(self.tasks.inventory(specs["concurrent_a"], "concurrent_a")["artifacts"], "temporary cleanup is not a claim that retained output objects were erased")

    def test_real_scene_change_and_actual_frame_timestamps(self):
        path = self.root / "scenes.mp4"
        command(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=10:d=1", "-f", "lavfi", "-i", "color=white:s=160x90:r=10:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "mpeg4", "-threads", "1", "-y", str(path)])
        frames, coverage = extract_frames(path, self.root / "scenes", probe(path), interval_ms=60000)
        scenes = [f for f in frames if f["sample_reason"] == "scene"]
        self.assertTrue(any(f["timestamp_ms"] == 1000 for f in scenes))
        self.assertTrue(all(f["timestamp_ms"] < 2000 for f in frames))
        self.assertFalse(coverage["full_frame_analysis"])

    def test_mode_controls_real_processing_and_optional_failure(self):
        b = body()
        b.update(stage="process", input_manifest=self.input(self.media(seconds=0.4)))
        b["asset"]["processing_mode"] = "audio"
        b["profile"].update(optional_capabilities=["vision", "ocr"])
        asr = lambda *_: {"segments": [], "language": "en", "engine": "fixture"}
        with patch("media.extract_frames", side_effect=AssertionError("audio must not inspect frames")):
            result = Processor(self.objects, asr=asr).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertEqual(result["coverage"]["optional_missing"], ["ocr", "vision"])
        b["profile"]["required_capabilities"] = ["vision"]
        with self.assertRaises(Failure) as err:
            Processor(self.objects).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertEqual(err.exception.code, "PROCESSING_MODE_CONFLICT")
        b["asset"]["processing_mode"] = "visual_required"
        b["profile"]["optional_capabilities"] = ["ocr", "summary"]
        result = Processor(self.objects).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertIn("vision", result["coverage"]["completed"])
        self.assertEqual(result["coverage"]["optional_missing"], ["ocr", "summary"])

    def test_retry_preserves_checkpoint_and_refreshes_fence(self):
        start = self.tasks.submit(body(), time.time() + 100)
        row = self.tasks.claim()
        self.tasks.save(row, {"chunks": {"0": "verified-object"}})
        self.tasks.finish(row, "failed", error={"code": "ASR_TEMPORARY"})
        self.tasks.retry(start["task_id"], {**SCOPE, "video_job_id": JOB}, time.time() + 100, {"stage_attempt": 2, "fencing_token": 3})
        fresh = self.tasks.claim()
        self.assertEqual(json.loads(fresh["body"])["fencing_token"], 3)
        self.assertEqual(json.loads(fresh["checkpoint"])["chunks"], {"0": "verified-object"})
        self.tasks.finish(fresh, "failed", error={"code": "EXTERNAL_OUTCOME_UNKNOWN"})
        with self.assertRaises(Failure):
            self.tasks.retry(start["task_id"], {**SCOPE, "video_job_id": JOB}, time.time() + 100)

    def test_real_ffmpeg_chunk_resume_only_failed_chunk_recomputed(self):
        b = body()
        b.update(stage="process", input_manifest=self.input(self.media()), profile={"required_capabilities": ["transcript"], "chunk_ms": 1000})
        # Short chunks use a smaller overlap; production default is 60 seconds.
        calls, state = [], {}
        def asr(ref, scope, language):
            calls.append(ref["sha256"])
            if len(calls) == 2:
                raise Failure("ASR_TEMPORARY", 503)
            return {"segments": [{"text": "tone fixture", "start": 0.1, "end": 0.5}], "language": "en", "engine": "test-fixture"}
        p = Processor(self.objects, asr=asr)
        folder = self.root / "work"
        folder.mkdir()
        with self.assertRaises(Failure):
            p.process(b, folder, state, lambda _: None, lambda: None)
        self.assertEqual(len(state["chunks"]), 1)
        result = p.process(b, folder, state, lambda _: None, lambda: None)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len(result["coverage"]["chunk_manifest"]), 3)
        self.assertEqual(result["coverage"]["intervals"]["processed"], [[0, 2400]])
        self.assertEqual(result["coverage"]["intervals"]["silence"], [])

    def test_required_visual_failure_blocks_and_optional_is_gap(self):
        source = {"kind": "manual", "segments": [{"text": "words", "start_ms": 0, "end_ms": 1000}]}
        ref = self.objects.put(SCOPE, JOB, canonical(source), "subtitles.json")
        b = body()
        b["input_manifest"] = {"schema_version": 1, "artifact_stage": "input_ready", "video_job_id": JOB, "input_kind": "platform_subtitles", "media_sha256": None, "availability": "not_acquired", "input_hash": ref["sha256"], "objects": [ref]}
        b["profile"]["required_capabilities"] = ["transcript", "vision"]
        with self.assertRaises(Failure) as err:
            Processor(self.objects).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertEqual(err.exception.code, "REQUIRED_MODALITY_MISSING")
        b["profile"].update(required_capabilities=["transcript"], optional_capabilities=["vision"])
        result = Processor(self.objects).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertEqual(result["coverage"]["optional_missing"], ["vision"])

    def test_vlm_fabricated_frame_reference_is_rejected(self):
        class Gateway:
            def observe(self, *args):
                return [{"kind": "observation", "text": "fixture", "frame_ids": ["invented-frame"]}]
        b = body()
        b.update(stage="process", input_manifest=self.input(self.media(seconds=0.4)), profile={"required_capabilities": ["vision", "vlm"]})
        with self.assertRaises(Failure) as err:
            Processor(self.objects, gateway=Gateway()).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertEqual(err.exception.code, "INVALID_VISUAL_OBSERVATION")

    def test_vlm_nonchronological_frame_references_preserve_pairing_and_reject_duplicates(self):
        b = body()
        b.update(stage="process", input_manifest=self.input(self.media()), profile={"required_capabilities": ["vision", "vlm"], "frame_interval_ms": 1000, "max_frames": 10})
        class Gateway:
            duplicate = False
            def observe(self, body, frames, checkpoint, save, active):
                self.frames = frames
                ids = [frames[-1]["frame_id"], frames[0]["frame_id"]]
                return [{"kind": "observation", "text": "synthetic reverse-order frame observation", "frame_ids": [ids[0], ids[0]] if self.duplicate else ids}]
        gateway = Gateway()
        result = Processor(self.objects, gateway=gateway).process(b, self.root, {}, lambda _: None, lambda: None)
        records = [record for part in result["visual"]["parts"] for record in json.loads(self.objects.read(part, SCOPE, JOB))["records"]]
        record = next(record for record in records if record["type"] == "model_observation")
        by_id = {frame["frame_id"]: frame for frame in result["frames"]}
        self.assertEqual(record["frame_refs"], [by_id[identity]["object_key"] for identity in record["frame_ids"]])
        self.assertEqual(record["start_ms"], min(by_id[identity]["timestamp_ms"] for identity in record["frame_ids"]))
        self.assertEqual(record["end_ms"], max(by_id[identity]["timestamp_ms"] for identity in record["frame_ids"]))
        gateway.duplicate = True
        with self.assertRaises(Failure) as error:
            Processor(self.objects, gateway=gateway).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertEqual(error.exception.code, "INVALID_VISUAL_OBSERVATION")

    def test_optional_asr_and_ocr_failures_do_not_skip_required_vlm(self):
        class Gateway:
            def observe(self, body, frames, *args):
                return [{"kind": "observation", "text": "fixture", "frame_ids": [frames[0]["frame_id"]]}]
        def unavailable(*args):
            raise Failure("UNSUPPORTED_MEDIA", 415)
        b = body()
        b.update(stage="process", input_manifest=self.input(self.media(seconds=0.4)), profile={"required_capabilities": ["vision", "vlm"], "optional_capabilities": ["transcript", "ocr"]})
        result = Processor(self.objects, asr=unavailable, ocr=unavailable, gateway=Gateway()).process(b, self.root, {}, lambda _: None, lambda: None)
        self.assertIn("vlm", result["coverage"]["completed"])
        self.assertEqual(set(result["coverage"]["optional_missing"]), {"transcript", "ocr"})

    def test_dtk_pending_never_resubmits_download(self):
        class Provider:
            calls = 0
            def submit_download(self, asset):
                self.calls += 1
                return {"download_id": "external-a"}
            def download(self, ident):
                return {"id": ident, "state": "running"}
        provider = Provider()
        executor = Executor(self.tasks, self.objects, Processor(self.objects), provider)
        checkpoint = {}
        for _ in range(3):
            self.assertIsNone(executor.acquire(body(), self.root, checkpoint, lambda _: None, lambda: None))
        self.assertEqual(provider.calls, 1)

    def test_dtk_auth_header_matches_locked_source(self):
        provider = DTK("http://dtk:8000", "fixture-api-key")
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return Response(canonical({"success": True, "data": {"task_id": "a", "state": "running"}}))
        provider.http.opener = Opener()
        provider.resolve("bilibili", {"canonical_url": "https://www.bilibili.com/video/BV123"})
        self.assertEqual(requests[0].get_header("X-api-key"), "fixture-api-key")
        self.assertIsNone(requests[0].get_header("Authorization"))
        self.assertEqual(requests[0].full_url, "http://dtk:8000/api/v1/parse?wait=0")

    def test_erasure_scrubs_worker_cache_but_preserves_tombstone(self):
        b = body()
        b["asset"]["title"] = "private title"
        start = self.tasks.submit(b, time.time() + 100)
        with self.assertRaises(Failure):
            self.tasks.erase(SCOPE, JOB)
        row = self.tasks.claim()
        self.tasks.save(row, {"summary": "private model output"})
        self.tasks.finish(row, "completed", result={"secret": "private result"})
        self.assertTrue(self.tasks.erase(SCOPE, JOB)["erased"])
        with self.tasks.db() as db:
            stored = dict(db.execute("SELECT * FROM executions WHERE id=?", (start["task_id"],)).fetchone())
        self.assertEqual(stored["body"], "{}")
        self.assertEqual(stored["checkpoint"], "{}")
        self.assertIsNone(stored["result"])
        self.assertEqual(stored["state"], "erased")
        self.assertNotIn(b"private", Path(self.tasks.path).read_bytes())
        self.assertTrue(self.tasks.erase(SCOPE, JOB)["erased"])
        with self.assertRaises(Failure) as err:
            self.tasks.read(start["task_id"], {**SCOPE, "video_job_id": JOB}, time.time() + 100, {"stage_attempt": 3, "fencing_token": 3})
        self.assertEqual(err.exception.status, 410)
        with self.tasks.db() as db:
            self.assertEqual(db.execute("SELECT authorization_until FROM executions WHERE id=?", (start["task_id"],)).fetchone()[0], 0)
        unknown = body()
        unknown["video_job_id"] = "vjob_unknown"
        self.tasks.submit(unknown, time.time() + 100)
        row = self.tasks.claim()
        self.tasks.save(row, {"local_usage": {"receipt": {"phase": "unknown"}}})
        self.tasks.finish(row, "failed", error={"code": "USAGE_OUTCOME_UNKNOWN"})
        with self.assertRaises(Failure) as err:
            self.tasks.erase(SCOPE, "vjob_unknown")
        self.assertEqual(err.exception.code, "EXECUTION_OUTCOME_UNKNOWN")

    def test_artifact_receipts_are_bounded_and_paged(self):
        created = self.tasks.submit(body(), time.time() + 100)
        row = self.tasks.claim()
        refs = {str(i): {"object_key": str(i)} for i in range(203)}
        self.tasks.save(row, {"artifacts": refs})
        scope = {**SCOPE, "video_job_id": JOB}
        first = self.tasks.read(created["task_id"], scope)
        second = self.tasks.artifacts(created["task_id"], scope, first["next_artifact_cursor"])
        third = self.tasks.artifacts(created["task_id"], scope, second["next_artifact_cursor"])
        self.assertEqual([len(p["artifacts"]) for p in (first, second, third)], [100, 100, 3])
        self.assertIsNone(third["next_artifact_cursor"])

    def test_dtk_unknown_outcome_never_retried(self):
        class Provider:
            calls = 0
            def submit_download(self, asset):
                self.calls += 1
                raise Failure("PROVIDER_UNAVAILABLE", 503)
        provider = Provider()
        executor = Executor(self.tasks, self.objects, Processor(self.objects), provider)
        checkpoint = {}
        for _ in range(2):
            with self.assertRaises(Failure) as err:
                executor.acquire(body(), self.root, checkpoint, lambda _: None, lambda: None)
            self.assertEqual(err.exception.code, "EXTERNAL_OUTCOME_UNKNOWN")
        self.assertEqual(provider.calls, 1)

    def test_explicit_terminal_download_retry_preserves_part_and_polls_only(self):
        class Provider:
            calls = []
            def download(self, ident):
                return {"id": ident, "state": "failed" if ident == "old" else "running"}
            def submit_download(self, asset):
                self.calls.append(copy.deepcopy(asset))
                return {"download_id": "new"}
        b = body()
        b["asset"] = {"platform": "bilibili", "native_id": "BV123", "part_id": "3"}
        provider = Provider()
        executor = Executor(self.tasks, self.objects, Processor(self.objects), provider)
        state = {"external_download_id": "old", "download_retry_requested": True}
        for _ in range(3):
            self.assertIsNone(executor.acquire(b, self.root, state, lambda _: None, lambda: None))
        self.assertEqual(provider.calls, [b["asset"]])
        self.assertEqual(state["previous_download_ids"], ["old"])

    def test_lost_terminal_download_retry_response_is_not_repeated(self):
        class Provider:
            calls = 0
            def download(self, ident):
                return {"id": ident, "state": "failed"}
            def submit_download(self, asset):
                self.calls += 1
                raise Failure("PROVIDER_UNAVAILABLE", 503)
        provider = Provider()
        executor = Executor(self.tasks, self.objects, Processor(self.objects), provider)
        state = {"external_download_id": "old", "download_retry_requested": True}
        for _ in range(2):
            with self.assertRaises(Failure) as err:
                executor.acquire(body(), self.root, state, lambda _: None, lambda: None)
            self.assertEqual(err.exception.code, "EXTERNAL_OUTCOME_UNKNOWN")
        self.assertEqual(provider.calls, 1)

    def test_dtk_discovery_pending_preserves_handle(self):
        class Client:
            paths = []
            def json(self, method, path, body=None):
                self.paths.append(path)
                return {"success": True, "data": {"task_id": "task-a", "state": "running"}}
        client = Client()
        dtk = DTK("http://dtk", "secret", client, allowed_scopes={("tn_a", "ws_a")})
        b = {**SCOPE, "platform": "bilibili", "source": {"author_id": "123"}, "limit": 20}
        first = dtk.discover(b)
        dtk.discover({**b, "cursor": first["next_cursor"]})
        self.assertIn("/user/posts?", client.paths[0])
        self.assertEqual(client.paths[1], "/api/v1/tasks/task-a")

    def test_http_auth_cross_scope_and_large_streamed_object(self):
        executor = Executor(self.tasks, self.objects, Processor(self.objects))
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler(self.tasks, executor, self.objects, None, "service", KEY))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            req = Request(origin + "/v1/jobs", canonical(body()), {"Authorization": "Bearer service", "X-Flow-Execution-Context": token()})
            created = json.load(urlopen(req))
            self.assertEqual(created["state"], "pending")
            req = Request(origin + "/v1/jobs", canonical(body()), {"Authorization": "Bearer service", "X-Flow-Execution-Context": token(scope={**SCOPE, "workspace_id": "foreign"})})
            with self.assertRaises(HTTPError) as err:
                urlopen(req)
            self.assertEqual(err.exception.code, 403)
            ref = self.objects.put(SCOPE, JOB, b"x" * (9 * 1024 * 1024), "large.mp4")
            self.tasks.inventory_put(SCOPE, JOB, ref)
            req = Request(origin + "/v1/objects?key=" + ref["object_key"], headers={"Authorization": "Bearer service", "X-Flow-Execution-Context": token(permission="video.read")})
            with urlopen(req) as response:
                self.assertEqual(len(response.read()), 9 * 1024 * 1024)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
