import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("check-flow-tests.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

PASS = """ok 1 - RLS: tenant context hides and blocks other tenants' rows (non-superuser role)
ok 2 - A18: backup/restore dump → restore into an empty database → manifest and app reads match
ok 3 - RLS: HTTP API end-to-end on real Postgres as non-superuser
ok 4 - legacy import (real PostgreSQL, FORCE RLS app role)
ok 5 - QA PostgreSQL: real independent connections serialize claims, preserve restart fence and enforce video FORCE RLS
ok 6 - QA K017 PostgreSQL: coordinator required embedding gates FTS, vectors and ready event on verified host receipt
ok 7 - QA R25/K025 PostgreSQL: pre-erasure backup cannot resurrect data before latest external journal replay
# tests 7
# fail 0
# skipped 0
"""


class GateTests(unittest.TestCase):
    def test_success(self):
        gate.verify(PASS)

    def test_skipped(self):
        with self.assertRaises(ValueError):
            gate.verify(PASS.replace("# skipped 0", "# skipped 1"))

    def test_missing_summary(self):
        with self.assertRaises(ValueError):
            gate.verify(PASS.replace("# tests 7", ""))

    def test_missing_required(self):
        with self.assertRaises(ValueError):
            gate.verify(PASS.replace("ok 4", "not ok 4"))

    def test_inline_skip(self):
        with self.assertRaises(ValueError):
            gate.verify(PASS.replace("replay\n# tests", "replay # SKIP\n# tests"))

    def test_missing_video_restore(self):
        with self.assertRaises(ValueError):
            gate.verify(PASS.replace("ok 7", "not ok 7"))


if __name__ == "__main__":
    unittest.main()
