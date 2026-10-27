"""One shared corpus; actual worker auth, object, processor and SQLite validators."""
import json
from pathlib import Path
import tempfile
import time
import unittest

from core import Failure, Objects, scope_key, verify_context
from media import Processor
from runtime import Tasks
from test_video import Store

FIXTURE = json.loads((Path(__file__).parent.parent / "loom-engine/validation/video-knowledge/shared-contract-v1.json").read_text())


class SharedContractQA(unittest.TestCase):
    def test_shared_scope_and_object_boundaries(self):
        f = FIXTURE
        self.assertEqual(f["version"], 1)
        for case in f["auth"]:
            with self.subTest(token=case["id"]):
                try:
                    verify_context(case["token"], f["key"], f["scope"], f["permission"], f["job_id"], now=f["now"])
                    accepted = True
                except Failure:
                    accepted = False
                self.assertEqual(accepted, case["accept"])
        for case in f["object_keys"]:
            with self.subTest(object=case["id"]):
                try:
                    scope_key(case["key"], f["scope"], case["job_id"])
                    accepted = True
                except Failure:
                    accepted = False
                self.assertEqual(accepted, case["accept"])

    def test_shared_durable_idempotency(self):
        f, intent = FIXTURE, FIXTURE["idempotency"]
        with tempfile.TemporaryDirectory() as root:
            tasks = Tasks(Path(root) / "tasks.sqlite")
            body = {**f["scope"], "video_job_id": f["job_id"], "stage": "input", "stage_attempt": 1, "fencing_token": 1,
                    "intent_key": intent["key"], "profile": {"required_capabilities": ["transcript"]}, "asset": intent["first"]}
            first = tasks.submit(body, time.time() + 120)
            body["asset"] = intent["same"]
            self.assertEqual(tasks.submit(body, time.time() + 120)["task_id"], first["task_id"])
            body["asset"] = intent["changed"]
            with self.assertRaises(Failure) as raised:
                tasks.submit(body, time.time() + 120)
            self.assertEqual(raised.exception.code, "IDEMPOTENCY_CONFLICT")

    def test_shared_input_manifest_integrity(self):
        f = FIXTURE
        for case in f["manifest_cases"]:
            with self.subTest(manifest=case["id"]), tempfile.TemporaryDirectory() as root:
                store = Store()
                store.data[f["input"]["object_key"]] = f["input"]["raw"].encode()
                ref = {k: f["input"][k] for k in ("object_key", "sha256", "bytes")}
                ref["content_type"] = "application/json"
                manifest = {"schema_version": 1, "artifact_stage": "input_ready", "video_job_id": f["job_id"], "stage_attempt": 1, "fencing_token": 1,
                            "input_kind": "platform_subtitles", "input_hash": ref["sha256"], "media_sha256": None, "availability": "not_acquired", "objects": [ref],
                            "coverage": {"required": [], "completed": [], "missing": []}, "processors": {"version": "shared-fixture-v1"}}
                kind = case["id"]
                if kind == "wrong_object_workspace": ref["object_key"] = ref["object_key"].replace("qa_workspace", "foreign")
                if kind == "wrong_hash": ref["sha256"] = manifest["input_hash"] = "f" * 64
                if kind == "path_hash_mismatch":
                    ref["object_key"] = ref["object_key"].replace(ref["sha256"], "f" * 64)
                    store.data[ref["object_key"]] = f["input"]["raw"].encode()
                if kind == "wrong_size": ref["bytes"] += 1
                if kind == "wrong_job": manifest["video_job_id"] = "foreign_job"
                if kind == "unbacked_input_hash": manifest["input_hash"] = "e" * 64
                if kind == "invalid_subtitle_availability": manifest["availability"] = "available"
                if kind == "bad_schema": manifest["schema_version"] = 2
                body = {**f["scope"], "video_job_id": f["job_id"], "stage_attempt": 1, "fencing_token": 1, "input_manifest": manifest,
                        "profile": {"required_capabilities": ["transcript"], "processing_mode": "subtitles_first"}}
                try:
                    result = Processor(Objects(store)).process(body, Path(root), {}, lambda: None, lambda: None)
                    accepted = result["artifact_stage"] == "processing_complete"
                except Failure:
                    accepted = False
                self.assertEqual(accepted, case["accept"])

    def test_shared_path_hash_also_fences_media_materialization(self):
        f = FIXTURE
        self.assertTrue(any(case["id"] == "path_hash_mismatch" for case in f["manifest_cases"]))
        ref = {k: f["input"][k] for k in ("object_key", "sha256", "bytes")}
        ref["object_key"] = ref["object_key"].replace(ref["sha256"], "f" * 64)
        store = Store()
        store.data[ref["object_key"]] = f["input"]["raw"].encode()
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "materialized"
            with self.assertRaises(Failure) as raised:
                Objects(store).materialize(ref, f["scope"], f["job_id"], target, 10000)
            self.assertEqual(raised.exception.code, "INCOMPLETE_ARTIFACT")
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
