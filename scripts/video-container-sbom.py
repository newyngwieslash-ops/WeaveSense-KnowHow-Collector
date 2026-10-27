#!/usr/bin/env python3
"""Emit package-inventory SPDX from actually built CI images, not source guesses."""
import datetime
import hashlib
import json
from pathlib import Path
import sys
import uuid


def generate(directory):
    images = json.loads((directory / "images.json").read_text())
    output = []
    for kind in ("backup", "worker"):
        image = next(x for x in images if f"knowhow-{kind}:ci" in x["RepoTags"])
        digest = image["Id"].removeprefix("sha256:")
        packages = [{"SPDXID": "SPDXRef-Image", "name": f"knowhow-{kind}", "versionInfo": digest,
                     "downloadLocation": "NOASSERTION", "filesAnalyzed": False,
                     "licenseConcluded": "NOASSERTION", "licenseDeclared": "NOASSERTION",
                     "copyrightText": "NOASSERTION", "checksums": [{"algorithm": "SHA256", "checksumValue": digest}]}]
        relationships = [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Image"}]
        rows = []
        for line in (directory / f"{kind}-dpkg.tsv").read_text().splitlines():
            name, version = line.split("\t", 1)
            rows.append(("deb", name, version))
        app = json.loads((directory / ("backup-npm.json" if kind == "backup" else "worker-pip.json")).read_text())
        rows.extend(("npm" if kind == "backup" else "pypi", row["name"], row["version"]) for row in app)
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
                    "creationInfo": {"created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "creators": ["Tool: video-container-sbom.py-1"]},
                    "documentComment": "Partial installed-package inventory of this exact image config ID, not a vulnerability scan, legal approval, complete file-level SBOM or reproducible-build proof. Copied Node/mc binaries are recorded in backup-runtime.txt; npm integrity is in backup-npm.json. Source commit in source-commit.txt.",
                    "packages": packages, "relationships": relationships}
        path = directory / f"{kind}.spdx.json"
        path.write_text(json.dumps(document, indent=2) + "\n")
        output.append({"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "installed_packages": len(rows), "image_config_id": image["Id"]})
    (directory / "inventory-summary.json").write_text(json.dumps(output, indent=2) + "\n")
    return output


if __name__ == "__main__":
    print(json.dumps(generate(Path(sys.argv[1])), indent=2))
