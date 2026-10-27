import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("doctor", ROOT / "scripts/video-doctor.py")
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)


class DoctorTests(unittest.TestCase):
    def valid(self):
        return {
            "VIDEO_BACKUP_NODE_IMAGE": "node:22-bookworm-slim@sha256:" + "a" * 64,
            "VIDEO_BACKUP_POSTGRES_IMAGE": "postgres:17-bookworm@sha256:" + "b" * 64,
            "VIDEO_BACKUP_MC_IMAGE": "bitnamilegacy/minio-client:2025.7.21@sha256:" + "c" * 64,
            "FLOW_VIDEO_ENABLED": "true", "FLOW_VIDEO_WORKSPACES": "ws_a",
            "VIDEO_SERVICE_TOKEN": "s" * 32, "FLOW_INTERNAL_JWT_SIGNING_KEY": "j" * 32,
            "VIDEO_DELETION_JOURNAL_KEY": "k" * 32,
            "VIDEO_OBJECT_ACCESS_KEY": "private-access", "VIDEO_OBJECT_SECRET_KEY": "private-secret",
            "VIDEO_DELETION_JOURNAL_ID": "journal-id", "VIDEO_DELETION_JOURNAL_VOLUME": "separate-journal",
            "FLOW_MODEL_GATEWAY_EMBEDDING_MODEL": "approved-model",
            "FLOW_MODEL_GATEWAY_EMBEDDING_MICRO_PER_1K_TOKENS": "10",
            "FLOW_MODEL_GATEWAY_EMBEDDING_DIMENSIONS": "768",
        }

    def failures(self, env):
        return {c["code"] for c in doctor.check(env) if c["status"] == "fail"}

    def test_valid_static_pilot_has_explicit_limits(self):
        checks = doctor.check(self.valid())
        self.assertFalse(any(c["status"] == "fail" for c in checks))
        self.assertIn("JOURNAL_CONTENTS", {c["code"] for c in checks})

    def test_empty_allowlist_never_passes(self):
        env = self.valid(); env["FLOW_VIDEO_WORKSPACES"] = ""
        self.assertIn("PILOT_ALLOWLIST", self.failures(env))

    def test_duplicates_wildcards_and_injection_fail(self):
        for value in ("ws_a,ws_a", "*", "ws_a; touch /tmp/not-run"):
            env = self.valid(); env["FLOW_VIDEO_WORKSPACES"] = value
            self.assertIn("PILOT_ALLOWLIST", self.failures(env))

    def test_disabled_not_mislabelled_ready(self):
        env = self.valid(); env["FLOW_VIDEO_ENABLED"] = "false"
        self.assertIn("PILOT_ENABLED", self.failures(env))

    def test_zero_price_and_wrong_image_rejected(self):
        env = self.valid(); env["FLOW_MODEL_GATEWAY_EMBEDDING_MICRO_PER_1K_TOKENS"] = "0"
        env["VIDEO_BACKUP_NODE_IMAGE"] = "attacker/node:22-bookworm-slim@sha256:" + "a" * 64
        self.assertTrue({"FLOW_MODEL_GATEWAY_EMBEDDING_MICRO_PER_1K_TOKENS", "VIDEO_BACKUP_NODE_IMAGE"} <= self.failures(env))

    def test_secrets_never_echoed(self):
        env = self.valid(); env["DTK_ENABLED"] = "true"; env["DTK_URL"] = "https://user:ultra-secret@example.org/path?key=private"
        result = json.dumps(doctor.check(env))
        for value in ("private-secret", "ultra-secret", "s" * 32, "k" * 32):
            self.assertNotIn(value, result)
        self.assertIn("DTK_URL", self.failures(env))

    def test_env_literal_not_executed_or_expanded(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"
            for raw in ("KEY=$(echo secret)", "KEY=${OTHER}", "KEY=a\nKEY=b", "KEY='missing"):
                p.write_text(raw)
                with self.assertRaises(ValueError): doctor.parse_env(p)
            p.write_text("# comment\nKEY='literal'\nOTHER=value # trailing\n")
            self.assertEqual(doctor.parse_env(p), {"KEY": "literal", "OTHER": "value"})

    def test_dtk_scope_not_in_allowlist(self):
        env = self.valid(); env.update(DTK_ENABLED="true", DTK_URL="http://dtk:8080", DTK_WORKSPACE_ID="ws_other")
        self.assertIn("DTK_WORKSPACE_SCOPE", self.failures(env))

    def test_asr_missing_and_escape_fail_closed(self):
        env = self.valid(); env.update(ASR_ENABLED="true", ASR_SERVICE_TOKEN="a" * 32)
        with tempfile.TemporaryDirectory() as d:
            env["VIDEO_ASR_MODEL_HOST_DIR"] = d
            p = Path(d) / "model-lock.json"
            p.write_text(json.dumps({"revision": "a" * 40, "files": [{"name": "../secret", "bytes": 1, "sha256": "a" * 64}]}))
            checks = doctor.check(env, check_local=True)
            self.assertTrue(any(c["code"] == "ASR_LOCAL_LOCK" and c["status"] == "fail" for c in checks))

    def test_cli_failure_json_and_exit(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"; p.write_text("KEY=$(private-secret)")
            process = subprocess.run([sys.executable, str(ROOT / "scripts/video-doctor.py"), "--env-file", str(p)], capture_output=True, text=True)
            self.assertEqual(process.returncode, 1)
            output = json.loads(process.stdout)
            self.assertFalse(output["production_ready"])
            self.assertNotIn("private-secret", process.stdout + process.stderr)

    def test_complete_asr_lock_and_missing_config(self):
        env = self.valid(); env.update(ASR_ENABLED="true", ASR_SERVICE_TOKEN="a" * 32)
        with tempfile.TemporaryDirectory() as d:
            env["VIDEO_ASR_MODEL_HOST_DIR"] = d
            directory = Path(d)
            files = []
            for name in ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt"):
                raw = b"fixture"; (directory / name).write_bytes(raw)
                files.append({"name": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
            lock = {"repository": "fixture/model", "revision": "a" * 40, "files": files}
            (directory / "model-lock.json").write_text(json.dumps(lock))
            check = lambda: next(c for c in doctor.check(env, check_local=True) if c["code"] == "ASR_LOCAL_LOCK")["status"]
            self.assertEqual(check(), "pass")
            (directory / "preprocessor_config.json").write_text("{}")
            self.assertEqual(check(), "fail")
            (directory / "preprocessor_config.json").unlink()
            (directory / "config.json").unlink()
            self.assertEqual(check(), "fail")

    def test_model_price_and_long_placeholder_rejected(self):
        env = self.valid(); env.update(VIDEO_MODEL_ENABLED="true", VIDEO_SERVICE_TOKEN="change-me-" + "x" * 40)
        self.assertTrue({"MODEL_PRICE", "VIDEO_SERVICE_TOKEN"} <= self.failures(env))


if __name__ == "__main__": unittest.main()
