#!/usr/bin/env python3
"""Bind isolated image evidence to exact tracked build inputs and attachment bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


PREFIXES = ('services/loom-engine/flow/', 'services/loom-engine/src/', 'services/loom-engine/scripts/',
            'deploy/flow/backup/', 'services/video-knowledge/')
FILES = {'services/loom-engine/LICENSE', 'services/loom-engine/package.json', 'services/loom-engine/package-lock.json'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_manifest(root):
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root, text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}', commit) or not re.fullmatch('[a-f0-9]{40}', tree):
        raise ValueError('invalid_source_identity')
    changes = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all', '--', *PREFIXES, *sorted(FILES)], cwd=root)
    if changes:
        raise ValueError('build_inputs_not_committed')
    entries = subprocess.check_output(['git', 'ls-tree', '-r', '-z', 'HEAD'], cwd=root).split(b'\0')
    rows = []
    for entry in entries:
        if not entry:
            continue
        meta, raw_path = entry.split(b'\t', 1)
        path = raw_path.decode('utf-8')
        if path not in FILES and not path.startswith(PREFIXES):
            continue
        mode, kind, blob = meta.decode('ascii').split()
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError('unsupported_build_input_type')
        file = root / path
        if file.is_symlink() or not file.is_file():
            raise ValueError('build_input_missing_or_symlink')
        data = file.read_bytes()
        actual_blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if actual_blob != blob:
            raise ValueError('build_input_differs_from_commit')
        rows.append({'path': path, 'git_blob': blob, 'bytes': len(data), 'sha256': sha(data)})
    if not rows:
        raise ValueError('build_inputs_missing')
    return {'schema_version': 1, 'source_commit': commit, 'source_tree': tree, 'files': rows,
            'selected_input_sha256': sha(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()),
            'scope': 'Tracked backup and video-worker source inputs; not the complete application distribution or dependency file SBOM.',
            'tracked_inputs_match_commit': True}


def seal(directory):
    commit = (directory / 'source-commit.txt').read_text().strip()
    source = json.loads((directory / 'source-inputs.json').read_text())
    if not re.fullmatch('[a-f0-9]{40}', commit) or source.get('source_commit') != commit or source.get('tracked_inputs_match_commit') is not True:
        raise ValueError('source_evidence_mismatch')
    required = {'images.json', 'backup.spdx.json', 'worker.spdx.json', 'inventory-summary.json',
                'backup-npm.json', 'worker-pip.json', 'backup-dpkg.tsv', 'worker-dpkg.tsv',
                'backup-notice.sha256', 'worker-notice.sha256', 'backup-smoke.txt', 'worker-smoke.txt',
                'backup-runtime.txt', 'video-image-lock.json', 'worker-lock.json'}
    if not all((directory / name).is_file() for name in required):
        raise ValueError('incomplete_build_evidence')
    summaries = json.loads((directory / 'inventory-summary.json').read_text())
    if len(summaries) != 2 or {row['file'] for row in summaries} != {'backup.spdx.json', 'worker.spdx.json'}:
        raise ValueError('invalid_inventory_summary')
    for row in summaries:
        if row.get('source_commit') != commit or sha((directory / row['file']).read_bytes()) != row.get('sha256'):
            raise ValueError('inventory_summary_hash_mismatch')
    inputs = {row['path']: row['sha256'] for row in source['files']}
    notice_paths = {'backup-notice.sha256': {'/app/LICENSE': 'services/loom-engine/LICENSE'},
                    'worker-notice.sha256': {'/app/NOTICE': 'services/video-knowledge/NOTICE', '/app/requirements.lock': 'services/video-knowledge/requirements.lock'}}
    for output, mapping in notice_paths.items():
        lines = (directory / output).read_text().splitlines()
        observed = dict((line.split()[1], line.split()[0]) for line in lines)
        if set(observed) != set(mapping) or any(observed[path] != inputs.get(source_path) for path, source_path in mapping.items()):
            raise ValueError('packaged_notice_or_lock_mismatch')
    rows = []
    for file in sorted(directory.iterdir()):
        if file.name == 'build-evidence-manifest.json':
            continue
        if file.is_symlink() or not file.is_file():
            raise ValueError('unexpected_evidence_member')
        data = file.read_bytes()
        if file.suffix == '.json':
            json.loads(data)
        rows.append({'path': file.name, 'bytes': len(data), 'sha256': sha(data)})
    result = {'schema_version': 1, 'source_commit': commit, 'files': rows,
              'manifest_sha256': sha(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()),
              'license_approval': False, 'production_ready': False,
              'scope': 'Hash closure for this actual CI build evidence, not a signed attestation or reproducible-build claim.'}
    (directory / 'build-evidence-manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['source', 'seal'])
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    result = source_manifest(Path(__file__).resolve().parents[1]) if args.mode == 'source' else seal(args.directory)
    if args.mode == 'source':
        args.directory.mkdir(parents=True, exist_ok=True)
        (args.directory / 'source-inputs.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'source_commit': result['source_commit'], 'files': len(result['files']), 'mode': args.mode}))
