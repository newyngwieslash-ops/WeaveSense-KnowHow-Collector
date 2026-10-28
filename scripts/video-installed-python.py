#!/usr/bin/env python3
"""Read installed wheel metadata/notices without importing dependency modules."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re


def collect(distributions=None):
    packages = []
    for dist in distributions if distributions is not None else importlib.metadata.distributions():
        name, version = dist.metadata['Name'], dist.version
        if not name or not version:
            raise ValueError('installed_package_identity_missing')
        notices = []
        metadata_hash = None
        for item in dist.files or []:
            parts = Path(str(item)).parts
            is_metadata = str(item).endswith('.dist-info/METADATA')
            is_notice = re.fullmatch(r'(licen[cs]e|notice|copying|copyright)([._-].*)?', parts[-1], re.I)
            in_notices = any(p.lower() == 'licenses' for p in parts)
            if not (is_metadata or is_notice or in_notices):
                continue
            file = Path(dist.locate_file(item))
            if file.is_symlink() or not file.is_file():
                raise ValueError('installed_metadata_or_notice_missing')
            data = file.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if is_metadata:
                metadata_hash = digest
            else:
                notices.append({'path': str(item), 'bytes': len(data), 'sha256': digest})
        if not metadata_hash:
            raise ValueError('installed_metadata_missing')
        packages.append({'name': name, 'version': version, 'metadata_sha256': metadata_hash,
                         'requires_dist': dist.metadata.get_all('Requires-Dist', []),
                         'license_expression': dist.metadata.get('License-Expression'),
                         'license_declared': dist.metadata.get('License'),
                         'license_classifiers': [s for s in dist.metadata.get_all('Classifier', []) if s.startswith('License ::')],
                         'notices': sorted(notices, key=lambda x: x['path']), 'license_review': 'not_performed'})
    if not packages:
        raise ValueError('installed_packages_missing')
    return {'schema_version': 1, 'evidence_kind': 'observed_installed_python',
            'packages': sorted(packages, key=lambda x: (x['name'].lower(), x['version'])),
            'limits': 'Metadata and notice bytes only; hashes do not approve license compatibility or all bundled native libraries.'}


if __name__ == '__main__':
    print(json.dumps(collect(), sort_keys=True))
