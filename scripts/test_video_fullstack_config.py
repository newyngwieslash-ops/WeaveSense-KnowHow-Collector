"""Configuration safety checks; not a substitute for the actual Compose job."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fullstack_config", ROOT / "scripts/fullstack/configure.py")
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class FullstackConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / ".local/video-fullstack"
        self.env = self.root / ".env.flow"
        self.paths = patch.multiple(config, ROOT=self.root, PRIVATE=self.private, ENV=self.env)
        self.paths.start()
        self.project = patch.dict(os.environ, {"COMPOSE_PROJECT_NAME": "knowhow-ci-unit-test"})
        self.project.start()

    def tearDown(self):
        self.project.stop()
        self.paths.stop()
        self.temp.cleanup()

    def test_random_private_configuration_is_scoped_and_not_production(self):
        config.prepare()
        values = config.env_read()
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)
        self.assertEqual(values["FLOW_VIDEO_WORKSPACES"], "not-yet-bootstrapped")
        self.assertEqual(values["CANVAS_REGISTRATION_ENABLED"], "false")
        self.assertEqual(values["FLOW_MODEL_GATEWAY_URL"], "http://provider-fixture:8800/v1")
        secrets = [values[k] for k in ("MINIO_ROOT_PASSWORD", "VIDEO_OBJECT_SECRET_KEY", "VIDEO_SERVICE_TOKEN", "VIDEO_DELETION_JOURNAL_KEY", "FLOW_INTERNAL_JWT_SIGNING_KEY")]
        self.assertEqual(len(set(secrets)), len(secrets))
        self.assertTrue(all(len(value) == 64 for value in secrets))

    def test_never_overwrites_operator_environment_or_existing_state(self):
        self.env.write_text("operator-owned\n")
        with self.assertRaises(FileExistsError):
            config.prepare()
        self.assertEqual(self.env.read_text(), "operator-owned\n")
        with self.assertRaises(FileExistsError):
            config.prepare()

    def test_worker_object_policy_is_only_the_bootstrapped_video_prefix(self):
        config.prepare()
        (self.private / "state.json").write_text(json.dumps({"tenantId": "tn_test", "workspaceId": "ws_test"}))
        config.scope()
        values = config.env_read()
        self.assertEqual(values["FLOW_VIDEO_WORKSPACES"], "ws_test")
        policy = json.loads((self.private / "object-policy.json").read_text())
        actions = [statement for statement in policy["Statement"] if "s3:PutObject" in statement["Action"]]
        self.assertEqual(actions[0]["Resource"], ["arn:aws:s3:::flow-intel/tenants/tn_test/workspaces/ws_test/video/*"])
        self.assertNotIn("s3:*", json.dumps(policy))

    def test_cleanup_requires_successful_queries_and_no_owned_resources(self):
        runner = (ROOT / "scripts/fullstack/run.sh").read_text()
        body = re.search(r"if ! python - .*? <<'PY'\n(.*?)\nPY\n", runner, re.S).group(1)
        cases = [
            ([0, 0, 0, 0, 0], ["", "", ""], True),
            ([1, 0, 0, 0, 0], ["", "", ""], False),
            ([0, 1, 0, 0, 0], ["", "", ""], False),
            ([0, 0, 1, 0, 0], ["", "", ""], False),
            ([0, 0, 0, 1, 0], ["", "", ""], False),
            ([0, 0, 0, 0, 1], ["", "", ""], False),
            ([0, 0, 0, 0, 0], ["container-id", "", ""], False),
            ([0, 0, 0, 0, 0], ["", "project-volume", ""], False),
            ([0, 0, 0, 0, 0], ["", "", "knowhow-ci-1-1-journal"], False),
            ([0, 0, 0, 0, 0], ["", "", "knowhow-ci-1-1-journal-unowned"], True),
        ]
        for statuses, remaining, valid in cases:
            with self.subTest(statuses=statuses, remaining=remaining):
                result = subprocess.run([sys.executable, "-", str(self.root), "knowhow-ci-1-1", *map(str, statuses), *remaining], input=body, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0 if valid else 1, result.stderr)
                report = json.loads((self.root / "cleanup-verification.json").read_text())
                self.assertEqual(report["verified"], valid)
        self.assertIn('name=$journal', runner)
        self.assertIn('^knowhow-ci-[0-9]+-[0-9]+$', runner)


if __name__ == "__main__":
    unittest.main()
