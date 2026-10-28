"""Supply-chain evidence contracts; not legal approval or container execution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('provenance', ROOT / 'scripts/video-build-provenance.py')
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)


class SupplyChainTests(unittest.TestCase):
    def test_worker_hash_lock_matches_published_release_evidence(self):
        directory = ROOT / 'services/video-knowledge'
        lock = (directory / 'requirements.lock').read_text()
        records = json.loads((directory / 'requirements-lock-provenance.json').read_text())
        normalize = lambda name: re.sub(r'[-_.]+', '-', name.lower())
        actual = {}
        for line in lock.splitlines():
            if '==' in line:
                name, version = line.removesuffix(' \\').split('==')
                actual[normalize(name)] = {'version': version, 'hashes': set()}
                current = actual[normalize(name)]
            elif '--hash=sha256:' in line:
                digest = line.split('--hash=sha256:', 1)[1].removesuffix(' \\')
                self.assertRegex(digest, '^[a-f0-9]{64}$')
                current['hashes'].add(digest)
        expected = {normalize(p['name']): {'version': p['version'], 'hashes': {w['sha256'] for w in p['allowed_wheels']}} for p in records['packages']}
        self.assertEqual(actual, expected)
        for p in records['packages']:
            self.assertIn(p['verified_download']['sha256'], expected[normalize(p['name'])]['hashes'])
            self.assertRegex(p['metadata_url'], '^https://pypi.org/pypi/[^/]+/[^/]+/json$')
        for line in (directory / 'requirements.txt').read_text().splitlines():
            name, version = line.split('==')
            self.assertEqual(actual[normalize(name)]['version'], version)
        dockerfile = (directory / 'Dockerfile').read_text()
        self.assertIn('--require-hashes -r requirements.lock', dockerfile)
        self.assertIn('requirements.lock NOTICE', dockerfile)

    def test_source_manifest_hashes_exact_commit_and_rejects_dirty_input(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            worker = root / 'services/video-knowledge'
            worker.mkdir(parents=True)
            (worker / 'NOTICE').write_text('Synthetic notice\n')
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            result = provenance.source_manifest(root)
            self.assertTrue(result['tracked_inputs_match_commit'])
            self.assertEqual(result['files'][0]['sha256'], hashlib.sha256(b'Synthetic notice\n').hexdigest())
            (worker / 'NOTICE').write_text('Changed after checkout\n')
            with self.assertRaisesRegex(ValueError, 'build_inputs_not_committed'):
                provenance.source_manifest(root)

    def npm_fixture(self, root, version='1.0.0'):
        directory = root / 'node_modules/pkg'
        directory.mkdir(parents=True)
        (directory / 'package.json').write_text(json.dumps({'name': 'pkg', 'version': version, 'license': 'MIT'}))
        (directory / 'LICENSE').write_text('Synthetic notice, not a real license grant')
        (root / 'package-lock.json').write_text(json.dumps({'packages': {'node_modules/pkg': {'version': '1.0.0', 'integrity': 'sha512-YQ=='}}}))

    def test_npm_inventory_observes_actual_versions_and_notice_hashes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.npm_fixture(root)
            result = subprocess.run(['node', str(ROOT / 'scripts/video-installed-npm.mjs')], cwd=root, capture_output=True, text=True, check=True)
            doc = json.loads(result.stdout)
            self.assertTrue(doc['versions_match_lock'])
            self.assertEqual(doc['packages'][0]['version'], '1.0.0')
            self.assertEqual(doc['packages'][0]['notices'][0]['sha256'], hashlib.sha256((root / 'node_modules/pkg/LICENSE').read_bytes()).hexdigest())
            self.assertFalse(doc['package_bytes_integrity_verified'])

    def test_npm_inventory_rejects_installed_version_drift(self):
        with tempfile.TemporaryDirectory() as d:
            self.npm_fixture(Path(d), '2.0.0')
            result = subprocess.run(['node', str(ROOT / 'scripts/video-installed-npm.mjs')], cwd=d, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('installed_version_lock_mismatch', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_npm_inventory_rejects_missing_required_but_allows_omitted_dev_and_optional(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.npm_fixture(root)
            lock_path = root / 'package-lock.json'
            lock = json.loads(lock_path.read_text())
            for flag in ['dev', 'optional', 'devOptional']:
                lock['packages'][f'node_modules/{flag}'] = {'version': '1.0.0', flag: True}
            lock_path.write_text(json.dumps(lock))
            subprocess.run(['node', str(ROOT / 'scripts/video-installed-npm.mjs')], cwd=d, capture_output=True, check=True)
            lock['packages']['node_modules/missing'] = {'version': '1.0.0', 'integrity': 'sha512-YQ=='}
            lock_path.write_text(json.dumps(lock))
            result = subprocess.run(['node', str(ROOT / 'scripts/video-installed-npm.mjs')], cwd=d, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('required_installed_package_missing', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_missing_evidence_does_not_get_a_success_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'source-commit.txt').write_text('a' * 40)
            (root / 'source-inputs.json').write_text(json.dumps({'source_commit': 'a' * 40, 'tracked_inputs_match_commit': True}))
            with self.assertRaisesRegex(ValueError, 'incomplete_build_evidence'):
                provenance.seal(root)
            self.assertFalse((root / 'build-evidence-manifest.json').exists())

    def seal_fixture(self, root):
        commit = 'a' * 40
        (root / 'source-commit.txt').write_text(commit)
        inputs = [{'path': path, 'sha256': 'b' * 64} for path in ['services/loom-engine/LICENSE', 'services/video-knowledge/NOTICE', 'services/video-knowledge/requirements.lock']]
        binary_sources = json.dumps({'images': [{'notices': [{'image_destination': '/usr/local/share/licenses/video-backup/node/LICENSE', 'sha256': 'c' * 64}]}],
                                     'supplemental_notices': [{'source_path': 'deploy/flow/backup/licenses/minio-mc.LICENSE', 'image_destination': '/usr/local/share/licenses/video-backup/minio-client/LICENSE', 'sha256': 'd' * 64}]})
        (root / 'backup-binary-notice-sources.json').write_text(binary_sources)
        inputs.append({'path': 'deploy/flow/backup/binary-notice-sources.json', 'sha256': hashlib.sha256(binary_sources.encode()).hexdigest()})
        inputs.append({'path': 'deploy/flow/backup/licenses/minio-mc.LICENSE', 'sha256': 'd' * 64})
        (root / 'backup-binary-notices.sha256').write_text('c' * 64 + '  /usr/local/share/licenses/video-backup/node/LICENSE\n' + 'd' * 64 + '  /usr/local/share/licenses/video-backup/minio-client/LICENSE\n')
        (root / 'source-inputs.json').write_text(json.dumps({'source_commit': commit, 'tracked_inputs_match_commit': True, 'files': inputs}))
        for name in ['images.json', 'backup-npm.json', 'worker-pip.json', 'video-image-lock.json', 'worker-lock.json']:
            (root / name).write_text('{}')
        summary = []
        for kind in ('backup', 'worker'):
            name = f'{kind}.spdx.json'
            (root / name).write_text('{}')
            summary.append({'file': name, 'source_commit': commit, 'sha256': hashlib.sha256(b'{}').hexdigest()})
            for suffix in ['dpkg.tsv', 'smoke.txt']:
                (root / f'{kind}-{suffix}').write_text('synthetic fixture')
        (root / 'inventory-summary.json').write_text(json.dumps(summary))
        (root / 'backup-runtime.txt').write_text('synthetic fixture')
        (root / 'backup-notice.sha256').write_text('b' * 64 + '  /app/LICENSE\n')
        (root / 'worker-notice.sha256').write_text('b' * 64 + '  /app/NOTICE\n' + 'b' * 64 + '  /app/requirements.lock\n')

    def test_seal_hashes_attachment_bytes_without_license_approval(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.seal_fixture(root)
            result = provenance.seal(root)
            self.assertFalse(result['license_approval'])
            self.assertFalse(result['production_ready'])
            self.assertNotIn('build-evidence-manifest.json', [row['path'] for row in result['files']])
            for row in result['files']:
                self.assertEqual(row['sha256'], hashlib.sha256((root / row['path']).read_bytes()).hexdigest())

    def test_supplemental_binary_license_is_exact_immutable_upstream_blob(self):
        doc = json.loads((ROOT / 'deploy/flow/backup/binary-notice-sources.json').read_text())
        self.assertFalse(doc['license_approval'])
        notice = doc['supplemental_notices'][0]
        data = (ROOT / notice['source_path']).read_bytes()
        self.assertEqual(len(data), notice['bytes'])
        self.assertEqual(hashlib.sha256(data).hexdigest(), notice['sha256'])
        self.assertEqual(hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest(), notice['git_blob'])
        self.assertEqual(notice['source_commit'], 'ee72571936f15b0e65dc8b4a231a4dd445e5ccb6')
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.seal_fixture(root)
            inputs = json.loads((root / 'source-inputs.json').read_text())
            inputs['files'] = [row for row in inputs['files'] if row['path'] != notice['source_path']]
            (root / 'source-inputs.json').write_text(json.dumps(inputs))
            with self.assertRaisesRegex(ValueError, 'supplemental_binary_notice_source_mismatch'):
                provenance.seal(root)

    def test_seal_rejects_sbom_tamper_and_missing_packaged_notice(self):
        for filename, replacement, reason in [('worker.spdx.json', '{"tampered":true}', 'inventory_summary_hash_mismatch'),
                                              ('backup-notice.sha256', '', 'packaged_notice_or_lock_mismatch'),
                                              ('backup-binary-notice-sources.json', '{}', 'binary_notice_source_mismatch'),
                                              ('backup-binary-notices.sha256', '', 'packaged_binary_notice_mismatch')]:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                self.seal_fixture(root)
                (root / filename).write_text(replacement)
                with self.assertRaisesRegex(ValueError, reason):
                    provenance.seal(root)
                self.assertFalse((root / 'build-evidence-manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
