"""Artifact integrity and redaction contracts; no Docker or platform accounts."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from fullstack import configure, sanitize

ROOT = Path(__file__).resolve().parents[1]


class FullstackSanitizerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.private = self.root / ".local/video-fullstack"
        self.env = self.root / ".env.flow"
        with patch.multiple(configure, ROOT=self.root, PRIVATE=self.private, ENV=self.env), patch.dict(os.environ, {"COMPOSE_PROJECT_NAME": "knowhow-ci-1-1"}):
            configure.prepare()
        self.username = "ci_sanitizer_fixture"
        self.password = "synthetic_account_password_never_real"
        (self.private / "state.json").write_text(json.dumps({"username": self.username, "password": self.password}))
        self.config = dict(line.split("=", 1) for line in self.env.read_text().splitlines())
        self.values = sanitize.secret_values(self.root)
        self.out = self.root / "evidence"
        self.out.mkdir()
        self.scripts = self.root / "scripts/fullstack"
        self.scripts.mkdir(parents=True)
        for filename in ("configure.py", "sanitize.py"):
            shutil.copyfile(ROOT / "scripts/fullstack" / filename, self.scripts / filename)

    def test_generation_and_redaction_share_exact_secret_contract(self):
        self.assertEqual(len(configure.GENERATED_SECRET_NAMES), 10)
        self.assertEqual(sanitize.GENERATED_SECRET_NAMES, configure.GENERATED_SECRET_NAMES)
        expected = {self.config[name] for name in configure.GENERATED_SECRET_NAMES} | {self.username, self.password}
        self.assertEqual(set(self.values), expected)
        self.assertTrue(all(len(self.config[name]) == 64 for name in configure.GENERATED_SECRET_NAMES))
        self.assertNotIn("2000", self.values)
        self.assertNotIn("disabled", self.values)
        self.assertNotIn("fullstack-video", self.values)

    def test_preserves_numbers_timestamps_hashes_and_switches_while_redacting_credentials(self):
        document = {"tokens": 2000, "timestamp": 1793157592000,
                    "sha256": "a" * 28 + "2000" + "b" * 32, "policy": "disabled",
                    "credentials": {name: self.config[name] for name in configure.GENERATED_SECRET_NAMES},
                    "username": self.username, "password": self.password}
        path = self.out / "playwright-results.json"
        path.write_text(json.dumps(document))
        lines = self.out / "containers.jsonl"
        lines.write_text(json.dumps({"timestamp": document["timestamp"], "tokens": 2000}) + "\n" +
                         json.dumps({"password": self.password, "policy": "disabled"}) + "\n")
        sanitize.sanitize_artifacts([self.out], self.values)
        cleaned = json.loads(path.read_text())
        for name in ("tokens", "timestamp", "sha256", "policy"):
            self.assertEqual(cleaned[name], document[name])
        self.assertEqual(set(cleaned["credentials"].values()), {"[REDACTED]"})
        self.assertEqual(cleaned["username"], "[REDACTED]")
        self.assertEqual(cleaned["password"], "[REDACTED]")
        rows = [json.loads(line) for line in lines.read_text().splitlines()]
        self.assertEqual(rows, [{"timestamp": 1793157592000, "tokens": 2000}, {"password": "[REDACTED]", "policy": "disabled"}])
        self.assertTrue(all(value not in path.read_text() for value in self.values))

    def test_public_evidence_is_byte_preserved(self):
        original = '{"timestamp":1793157592000,"tokens":2000,"hash":"2000abcd","flag":"disabled"}\n'
        for suffix in (".json", ".jsonl", ".txt", ".html"):
            path = self.out / ("facts" + suffix)
            path.write_text(original)
        sanitize.sanitize_artifacts([self.out], self.values)
        for path in self.out.iterdir():
            self.assertEqual(path.read_text(), original)

    def test_streaming_cli_redacts_credentials_without_changing_public_facts(self):
        original = "2000 disabled 1793157592000 " + " ".join(self.values) + "\n"
        result = subprocess.run([sys.executable, str(self.scripts / "sanitize.py")], input=original,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "2000 disabled 1793157592000 " + " ".join("[REDACTED]" for _ in self.values) + "\n")
        self.assertEqual(result.stderr, "")

    def test_validation_rejects_invalid_json_jsonl_and_nonfinite_values(self):
        for suffix, content in ((".json", '{"timestamp":179315759[REDACTED]}'),
                                (".jsonl", '{}\n{"broken":}\n'),
                                (".json", '{"value":NaN}'),
                                (".json", '{"value":Infinity}'),
                                (".json", "")):
            with self.subTest(suffix=suffix, content=content):
                path = self.out / ("invalid" + suffix)
                path.write_text(content)
                with self.assertRaises(ValueError):
                    sanitize.sanitize_artifacts([self.out], self.values)
                self.assertEqual(path.read_text(), content)
                path.unlink()

    def test_validation_runs_after_redaction_and_cli_never_reports_success(self):
        # A credential in a numeric JSON position must fail closed, not be
        # retained unredacted or uploaded as malformed JSON.
        numeric_secret = "1" * 64
        path = self.out / "numeric-secret.json"
        original = '{"credential":' + numeric_secret + '}'
        path.write_text(original)
        with self.assertRaises(ValueError):
            sanitize.sanitize_artifacts([self.out], [numeric_secret])
        self.assertEqual(path.read_text(), original)
        path.write_text('{"timestamp":179315759[REDACTED]}')
        result = subprocess.run([sys.executable, str(self.scripts / "sanitize.py"), "--artifacts", str(self.out)],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("upload must remain disabled", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("179315759", result.stderr)

    def test_missing_generated_credential_fails_closed_but_prebootstrap_state_is_optional(self):
        (self.private / "state.json").unlink()
        self.assertEqual(len(sanitize.secret_values(self.root)), 10)
        self.env.write_text("\n".join(line for line in self.env.read_text().splitlines()
                                     if not line.startswith("FLOW_MODEL_GATEWAY_KEY=")))
        stderr = io.StringIO()
        with patch.object(sanitize, "ROOT", self.root), contextlib.redirect_stderr(stderr):
            self.assertEqual(sanitize.main(["--artifacts", str(self.out)]), 1)
        self.assertIn("upload must remain disabled", stderr.getvalue())

    def test_cleanup_removes_private_credentials_when_artifact_validation_fails(self):
        runner = (ROOT / "scripts/fullstack/run.sh").read_text()
        cleanup = re.search(r"(cleanup\(\) \{\n.*?\n\})\ntrap cleanup EXIT", runner, re.S).group(1)
        (self.out / "invalid.json").write_text('{"timestamp":179315759[REDACTED]}')
        output = self.root / "github-output"
        script = "\n".join([
            "set -euo pipefail",
            f"cd {shlex.quote(str(self.root))}",
            f"out={shlex.quote(str(self.out))}",
            f"private={shlex.quote(str(self.private))}",
            'VIDEO_FULLSTACK_RESULT="$private/result.json"',
            f"GITHUB_OUTPUT={shlex.quote(str(output))}",
            "COMPOSE_PROJECT_NAME=knowhow-ci-1-1",
            "created=true", "journal_created=false", "journal=knowhow-ci-1-1-journal",
            "compose=(true)",
            "docker() { return 0; }",
            f"python() {{ {shlex.quote(sys.executable)} \"$@\"; }}",
            cleanup, "trap cleanup EXIT", "exit 0",
        ])
        result = subprocess.run(["bash", "-c", script], text=True, capture_output=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(self.env.exists())
        self.assertFalse((self.private / "state.json").exists())
        self.assertFalse(output.exists() and "sanitized=true" in output.read_text())
        self.assertEqual(json.loads((self.out / "outcome.json").read_text())["exit_code"], 1)
        self.assertTrue(json.loads((self.out / "cleanup-verification.json").read_text())["verified"])


if __name__ == "__main__":
    unittest.main()
