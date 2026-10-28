#!/usr/bin/env python3
"""Emit package-inventory SPDX from actually built CI images, not source guesses."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys
import uuid


def generate(directory):
    images = json.loads((directory / "images.json").read_text())
    commit = (directory / "source-commit.txt").read_text().strip()
    source = json.loads((directory / "source-inputs.json").read_text())
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or source.get("source_commit") != commit or source.get("tracked_inputs_match_commit") is not True:
        raise ValueError("source_evidence_mismatch")
    output = []
    for kind in ("backup", "worker"):
        matches = [x for x in images if f"knowhow-{kind}:ci" in (x.get("RepoTags") or [])]
        if len(matches) != 1:
            raise ValueError("missing_or_ambiguous_image")
        image = matches[0]
        if (not re.fullmatch(r"sha256:[a-f0-9]{64}", image.get("Id", ""))
                or image.get("Architecture") != "amd64" or image.get("Os") != "linux"
                or image.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != commit):
            raise ValueError("image_identity_or_source_mismatch")
        digest = image["Id"].removeprefix("sha256:")
        packages = [{"SPDXID": "SPDXRef-Image", "name": f"knowhow-{kind}", "versionInfo": digest,
                     "downloadLocation": "NOASSERTION", "filesAnalyzed": False,
                     "licenseConcluded": "NOASSERTION", "licenseDeclared": "NOASSERTION",
                     "copyrightText": "NOASSERTION", "checksums": [{"algorithm": "SHA256", "checksumValue": digest}]}]
        relationships = [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Image"}]
        rows = []
        for line in (directory / f"{kind}-dpkg.tsv").read_text().splitlines():
            name, version = line.split("\t", 1)
            if not name or not version:
                raise ValueError("invalid_installed_package")
            rows.append(("deb", name, version))
        app = json.loads((directory / ("backup-npm.json" if kind == "backup" else "worker-pip.json")).read_text())
        expected = "observed_installed_npm" if kind == "backup" else "observed_installed_python"
        if app.get("evidence_kind") != expected or not app.get("packages"):
            raise ValueError("installed_application_evidence_missing")
        if kind == "backup" and app.get("versions_match_lock") is not True:
            raise ValueError("installed_lock_mismatch")
        if kind == "worker":
            locked = json.loads((directory / "worker-lock.json").read_text())
            normalize = lambda name: re.sub(r"[-_.]+", "-", name.lower())
            expected_packages = {normalize(row['name']): row['version'] for row in locked['packages']}
            installed = {normalize(row['name']): row['version'] for row in app['packages']}
            if (len(installed) != len(app['packages']) or not expected_packages
                    or any(installed.get(name) != version for name, version in expected_packages.items())
                    or set(installed) - set(expected_packages) - {'pip', 'setuptools', 'wheel'}):
                raise ValueError("worker_installed_lock_mismatch")
        rows.extend(("npm" if kind == "backup" else "pypi", row["name"], row["version"]) for row in app["packages"])
        for index, (ecosystem, name, version) in enumerate(rows):
            identifier = f"SPDXRef-Package-{index}"
            packages.append({"SPDXID": identifier, "name": name, "versionInfo": version,
                             "downloadLocation": "NOASSERTION", "filesAnalyzed": False,
                             "licenseConcluded": "NOASSERTION", "licenseDeclared": "NOASSERTION",
                             "copyrightText": "NOASSERTION", "comment": f"Observed installed {ecosystem} package; license review not performed by this inventory generator"})
            relationships.append({"spdxElementId": "SPDXRef-Image", "relationshipType": "CONTAINS", "relatedSpdxElement": identifier})
        document = {"spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
                    "name": f"knowhow-{kind}-installed-package-inventory",
                    "documentNamespace": "https://spdx.org/spdxdocs/knowhow-" + str(uuid.uuid5(uuid.NAMESPACE_URL, digest)),
                    "creationInfo": {"created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "creators": ["Tool: video-container-sbom.py-2"]},
                    "documentComment": "Partial installed-package inventory of this exact image config ID, not a registry manifest digest, vulnerability scan, legal approval, complete file-level SBOM or reproducible-build proof. Copied Node/mc binaries are recorded in backup-runtime.txt; installed metadata/notices are in backup-npm.json and worker-pip.json. Source commit and tracked-input hashes are independently checked. License declarations are evidence, not conclusions.",
                    "packages": packages, "relationships": relationships}
        path = directory / f"{kind}.spdx.json"
        path.write_text(json.dumps(document, indent=2) + "\n")
        output.append({"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "installed_packages": len(rows), "image_config_id": image["Id"], "source_commit": commit})
    (directory / "inventory-summary.json").write_text(json.dumps(output, indent=2) + "\n")
    return output


if __name__ == "__main__":
    print(json.dumps(generate(Path(sys.argv[1])), indent=2))
