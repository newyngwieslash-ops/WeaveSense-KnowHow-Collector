import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "check", Path(__file__).with_name("check-dependency-tests.py")
)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class DependencyChecks(unittest.TestCase):
    def test_summary_does_not_double_count_subtests_or_hide_skips(self):
        events = [
            {"Package": "example/app", "Test": "TestParent", "Action": "pass"},
            {"Package": "example/app", "Test": "TestParent/child", "Action": "pass"},
            {"Package": "example/app", "Test": "TestOptional", "Action": "skip"},
            {"Package": "example/app", "Test": "TestParent/optional", "Action": "skip"},
            {"Package": "example/app", "Action": "pass"},
        ]
        summary = check.test_summary(events)
        self.assertEqual(summary["top_level"], {"pass": 1, "fail": 0, "skip": 1})
        self.assertEqual(len(summary["skipped_tests"]), 2)
        self.assertEqual(check.test_summary([])["top_level"], {"pass": 0, "fail": 0, "skip": 0})

    def test_requires_run_and_pass_for_every_exact_name(self):
        events = [
            {"Package": "example/internal/" + package, "Test": name, "Action": action}
            for package, name in check.REQUIRED
            for action in ("run", "pass")
        ]
        self.assertFalse(check.missing_tests(events))
        self.assertTrue(check.missing_tests([]))
        self.assertTrue(check.missing_tests(events[1:]))
        self.assertTrue(check.missing_tests(events[:-1]))
        for action in ("skip", "fail"):
            self.assertTrue(check.missing_tests(events + [dict(events[-1], Action=action)]))
        self.assertTrue(check.missing_tests([dict(e, Test=e["Test"] + "Renamed") for e in events]))

    def test_video_gate_requires_actual_crosslayer_and_compiled_lifecycle_execution(self):
        required = check.REQUIRED | check.VIDEO_REQUIRED
        events = [{"Package": "example/internal/" + package, "Test": name, "Action": action}
                  for package, name in required for action in ("run", "pass")]
        self.assertFalse(check.missing_tests(events, required))
        for package, name in check.VIDEO_REQUIRED:
            omitted = [e for e in events if e["Test"] != name]
            self.assertIn((package, name), check.missing_tests(omitted, required))
            self.assertIn((package, name), check.missing_tests(events + [{"Package": "example/internal/" + package, "Test": name, "Action": "skip"}], required))


if __name__ == "__main__":
    unittest.main()
