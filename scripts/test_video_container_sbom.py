import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sbom", ROOT / "scripts/video-container-sbom.py")
sbom = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sbom)


class ImageInventoryTests(unittest.TestCase):
    def test_observed_inventory_has_explicit_limits_and_hashes(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            images = [{"Id": "sha256:" + c * 64, "RepoTags": [f"knowhow-{kind}:ci"]} for kind, c in (("backup", "a"), ("worker", "b"))]
            (directory / "images.json").write_text(json.dumps(images))
            for kind in ("backup", "worker"):
                (directory / f"{kind}-dpkg.tsv").write_text("libc6\t2.36\n")
            (directory / "backup-npm.json").write_text(json.dumps([{"name": "pg", "version": "8.13.0"}]))
            (directory / "worker-pip.json").write_text(json.dumps([{"name": "minio", "version": "7.2.15"}]))
            summary = sbom.generate(directory)
            self.assertEqual([s["installed_packages"] for s in summary], [2, 2])
            for kind in ("backup", "worker"):
                doc = json.loads((directory / f"{kind}.spdx.json").read_text())
                self.assertEqual(doc["spdxVersion"], "SPDX-2.3")
                self.assertIn("Partial installed-package", doc["documentComment"])
                self.assertTrue(all(p["licenseConcluded"] == "NOASSERTION" for p in doc["packages"]))
                ids = {p["SPDXID"] for p in doc["packages"]} | {doc["SPDXID"]}
                self.assertEqual(len(ids), len(doc["packages"]) + 1)
                self.assertTrue(all(r["spdxElementId"] in ids and r["relatedSpdxElement"] in ids for r in doc["relationships"]))

    def test_missing_actual_image_evidence_does_not_emit_fake_sbom(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(FileNotFoundError):
                sbom.generate(Path(d))


if __name__ == "__main__": unittest.main()
