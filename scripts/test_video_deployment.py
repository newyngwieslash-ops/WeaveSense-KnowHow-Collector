"""Static deployment contracts only; these tests do not claim a Docker run."""
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


class VideoDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.overlay = yaml.safe_load((ROOT / "docker-compose.video.yml").read_text())

    def test_independent_journal_and_all_readers(self):
        volume = self.overlay["volumes"]["video-deletion-journal"]
        self.assertIs(volume["external"], True)
        for role in ("loom-engine", "loom-scheduler", "loom-enrich", "loom-research"):
            service = self.overlay["services"][role]
            self.assertEqual(service["environment"]["VIDEO_DELETION_JOURNAL_DIR"], "/var/lib/flow-deletion-journal/journal")
            self.assertIn("video-deletion-journal:/var/lib/flow-deletion-journal", service["volumes"])
            self.assertEqual(service["environment"]["FLOW_VIDEO_ENABLED"], "${FLOW_VIDEO_ENABLED:-false}")

    def test_backup_has_real_runtime_and_read_only_authority(self):
        for role in ("flow-backup", "flow-backup-objects"):
            service = self.overlay["services"][role]
            self.assertIn("weavesense-video-backup", service["image"])
            self.assertEqual(service["build"]["dockerfile"], "deploy/flow/backup/Dockerfile.video")
            self.assertEqual(service["build"]["target"], "video-backup")
            self.assertEqual(set(service["build"]["args"]), {"NODE_IMAGE", "POSTGRES_IMAGE", "MC_IMAGE"})
            self.assertEqual(service["environment"]["BACKUP_VIDEO_JOURNAL_REQUIRED"], "true")
            self.assertIn("video-deletion-journal:/var/lib/flow-deletion-journal:ro", service["volumes"])

    def test_untrusted_decoder_has_no_journal_public_port_or_large_tmpfs(self):
        service = self.overlay["services"]["video-worker"]
        self.assertNotIn("ports", service)
        self.assertIs(service["read_only"], True)
        self.assertEqual(service["environment"]["VIDEO_TEMP_ROOT"], "/data/tmp")
        self.assertTrue(all("journal" not in entry for entry in service["volumes"]))
        self.assertEqual(service["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", service["security_opt"])

    def test_no_automatic_image_publication(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/publish-images.yml").read_text())
        # YAML 1.1 treats the GitHub key `on` as bool; accept either parser form.
        events = workflow.get("on", workflow.get(True))
        self.assertIn("workflow_dispatch", events)
        self.assertNotIn("push", events)


if __name__ == "__main__":
    unittest.main()
