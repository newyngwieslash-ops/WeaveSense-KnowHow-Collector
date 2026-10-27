import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("video_ledger", Path(__file__).with_name("video-task-ledger.py"))
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)


class TaskLedgerTests(unittest.TestCase):
    def setUp(self):
        self.raw = (ledger.DOCS / "spec/tasks.baseline.json").read_bytes()
        self.baseline = json.loads(self.raw)
        self.progress = ledger.read_json(ledger.DOCS / "PROGRESS.json")

    def test_exact_scope_and_all_task_gate(self):
        ledger.validate(self.baseline, self.progress, self.raw)
        gate = ledger.release_gate(self.baseline, self.progress)
        self.assertEqual((gate["required_tasks"], gate["required_cases"]), (100, 29))
        self.assertEqual(gate["status"], "blocked")
        self.assertIn("COL-020", gate["pending_tasks"])
        self.assertIn("K-014", gate["pending_tasks"])

    def test_fixture_code_does_not_make_task_complete(self):
        self.progress["tasks"]["COL-001"]["status"] = "已完成"
        self.progress["tasks"]["COL-001"]["code_evidence"] = ["fixture-only"]
        # Isolate the acceptance guard from current live blocking notes.
        self.progress["tasks"]["COL-001"]["blocking_notes"] = []
        for check in self.progress["tasks"]["COL-001"]["acceptance_checks"].values():
            check.update(status="未执行", evidence=[])
        with self.assertRaisesRegex(ValueError, "unpassed acceptance"):
            ledger.validate(self.baseline, self.progress, self.raw)

    def test_original_spec_notes_are_not_runtime_blockers(self):
        first = self.baseline["tasks"][0]
        self.progress["tasks"][first["id"]]["blocking_notes"] = ["runtime-only"]
        merged = ledger.merge(self.baseline, self.progress)["tasks"][0]
        self.assertEqual(merged["notes"], first["notes"])
        self.assertEqual(merged["execution"]["blocking_notes"], ["runtime-only"])

    def test_no_removed_acceptance_clause(self):
        self.progress["tasks"]["COL-001"]["acceptance_checks"].pop("1")
        with self.assertRaisesRegex(ValueError, "clauses missing"):
            ledger.validate(self.baseline, self.progress, self.raw)

    def test_p2_cannot_silently_expand_v1(self):
        task = next(task for task in self.baseline["tasks"] if task["phase"] == "P2")
        self.progress["tasks"][task["id"]]["status"] = "进行中"
        with self.assertRaisesRegex(ValueError, "P2"):
            ledger.validate(self.baseline, self.progress, self.raw)

    def test_baseline_hash_and_ids_are_bound(self):
        with self.assertRaisesRegex(ValueError, "exact baseline"):
            ledger.validate(self.baseline, self.progress, self.raw + b" ")
        self.progress["tasks"].pop("K-027")
        with self.assertRaisesRegex(ValueError, "removed"):
            ledger.validate(self.baseline, self.progress, self.raw)


if __name__ == "__main__":
    unittest.main()
