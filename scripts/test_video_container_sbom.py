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
    def fixture(self, directory):
        commit = 'c' * 40
        images = [{"Id": "sha256:" + c * 64, "RepoTags": [f"knowhow-{kind}:ci"],
                   "Architecture": "amd64", "Os": "linux",
                   "Config": {"Labels": {"org.opencontainers.image.revision": commit}}}
                  for kind, c in (("backup", "a"), ("worker", "b"))]
        (directory / "images.json").write_text(json.dumps(images))
        (directory / "source-commit.txt").write_text(commit + '\n')
        (directory / "source-inputs.json").write_text(json.dumps({'source_commit': commit, 'tracked_inputs_match_commit': True}))
        for kind in ("backup", "worker"):
            (directory / f"{kind}-dpkg.tsv").write_text("libc6\t2.36\n")
        (directory / "backup-npm.json").write_text(json.dumps({'evidence_kind': 'observed_installed_npm', 'versions_match_lock': True,
                                                              'packages': [{"name": "pg", "version": "8.13.0"}]}))
        worker = [{"name": "minio", "version": "7.2.15"}]
        (directory / "worker-pip.json").write_text(json.dumps({'evidence_kind': 'observed_installed_python', 'packages': worker}))
        (directory / "worker-lock.json").write_text(json.dumps({'packages': worker}))
        return images

    def test_observed_inventory_has_explicit_limits_and_hashes(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            self.fixture(directory)
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

    def test_source_image_and_architecture_mismatches_fail_closed(self):
        for field, value in [('Id', 'sha256:invalid'), ('Architecture', 'arm64'), ('Os', 'windows'), ('Config', {'Labels': {}})]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as d:
                directory = Path(d)
                images = self.fixture(directory)
                images[0][field] = value
                (directory / 'images.json').write_text(json.dumps(images))
                with self.assertRaisesRegex(ValueError, 'image_identity_or_source_mismatch'):
                    sbom.generate(directory)

    def test_worker_resolution_drift_or_unlocked_package_rejected(self):
        for packages in [[{'name': 'minio', 'version': 'changed'}],
                         [{'name': 'minio', 'version': '7.2.15'}, {'name': 'surprise', 'version': '1'}]]:
            with self.subTest(packages=packages), tempfile.TemporaryDirectory() as d:
                directory = Path(d)
                self.fixture(directory)
                (directory / 'worker-pip.json').write_text(json.dumps({'evidence_kind': 'observed_installed_python', 'packages': packages}))
                with self.assertRaisesRegex(ValueError, 'worker_installed_lock_mismatch'):
                    sbom.generate(directory)

    def test_mismatched_source_commit_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            self.fixture(directory)
            (directory / 'source-commit.txt').write_text('d' * 40)
            with self.assertRaisesRegex(ValueError, 'source_evidence_mismatch'):
                sbom.generate(directory)

    def test_missing_actual_image_evidence_does_not_emit_fake_sbom(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(FileNotFoundError):
                sbom.generate(Path(d))


if __name__ == "__main__": unittest.main()
