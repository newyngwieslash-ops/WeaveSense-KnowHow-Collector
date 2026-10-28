import tempfile
import unittest
import subprocess
import sys

from capacity import calibrate, percentile, process_tree_rss


class MediaCapacityTest(unittest.TestCase):
    def test_memory_sampler_includes_a_live_child_not_only_python_worker(self):
        before = process_tree_rss()
        child = subprocess.Popen([sys.executable, "-c", "import sys; data=bytearray(32*1024*1024); print('ready',flush=True); sys.stdin.read()"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            self.assertGreater(process_tree_rss(), before + 24 * 1024 * 1024)
        finally:
            child.communicate(timeout=10)

    def test_capacity_rejects_unbounded_load_before_execution(self):
        with tempfile.TemporaryDirectory() as root:
            for args in ({"jobs": 1000}, {"concurrency": 20}, {"jobs": 20, "seconds": 30}, {"width": 4096}):
                with self.assertRaises(ValueError):
                    calibrate(root, **args)
        self.assertEqual(percentile([1, 2, 3, 4]), 4)

    def test_real_media_queue_objects_metrics_and_watermark_recovery(self):
        with tempfile.TemporaryDirectory() as root:
            result = calibrate(root, jobs=3, concurrency=2, seconds=.4, width=160, height=90)
        self.assertTrue(result["passed"])
        self.assertFalse(result["production_ready"])
        self.assertFalse(result["slo_frozen"])
        self.assertEqual(result["workload"]["jobs"], 3)
        self.assertEqual(result["workload"]["observed_peak_claimed"], 2)
        self.assertGreater(result["metrics"]["submit_p95_ms"], 0)
        self.assertGreater(result["metrics"]["queue_wait_p95_ms"], 0)
        self.assertGreater(result["metrics"]["output_object_bytes_written"], 0)
        self.assertGreater(result["metrics"]["process_tree_sum_rss_bytes"], 0)
        self.assertTrue(all(job["state"] == "completed" and job["frames"] for job in result["jobs"]))
        self.assertEqual(result["storage_watermark_probe"]["explicit_retry_after_restore"], "completed")
