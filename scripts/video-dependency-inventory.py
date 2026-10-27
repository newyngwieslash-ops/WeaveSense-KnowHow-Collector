#!/usr/bin/env python3
"""Read-only dependency/source evidence; standard library only, no package imports.

Never installs, resolves, contacts registries, runs project code, or reads env files.
An inventory is evidence, not a complete SBOM, license opinion, or clean build.
"""
import argparse
import base64
import collections
import email
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
PINNED_UPSTREAM_COMMIT = "514c70f666cb04e3e72cbfb967fac74d9f350747"
GO_MANIFESTS = ["backend/go.mod", "backend/third_party/go-sms-sender/go.mod",
                "services/loom-engine/workers/agent/go.mod"]
JS_PROJECTS = ["backend/agent-runtime/pi", "services/loom-engine", "web"]
PY_MANIFESTS = ["services/loom-engine/workers/ocr/requirements.txt",
                "services/loom-engine/workers/telethon/requirements.txt",
                "services/loom-engine/workers/subtitle/requirements.txt",
                "services/loom-engine/workers/asr/requirements.txt",
                "services/loom-engine/workers/asr/requirements-model.txt",
                "services/video-knowledge/requirements.txt"]
EVIDENCE = ["third_party/upstreams.lock.json", "docs/video-ingestion/upstream-media-lock.json",
            "docs/video-ingestion/evidence/local-model-dependencies.json",
            "docs/video-ingestion/evidence/local-model-smoke.json",
            "services/loom-engine/workers/asr/model-lock.tiny.json",
            "services/loom-engine/validation/agent/opencode/runtime-lock.json",
            "deploy/flow/backup/video-build-manifest.json",
            "docs/video-ingestion/evidence/pi-lock-integrity-verification.json",
            "docs/video-ingestion/evidence/bun-declared-validation.json"]


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def file_record(path, base=None):
    base = ROOT if base is None else base
    return {"path": path.relative_to(base).as_posix(), "bytes": path.stat().st_size,
            "sha256": digest(path)}


def safe_url(value):
    """Retain public provenance, not URL credentials/query/fragment."""
    if not isinstance(value, str) or "://" not in value:
        return value
    parsed = urllib.parse.urlsplit(value)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1],
                                    parsed.path, "", ""))


def jsonc(text):
    # Bun's text lock has trailing commas. Do not eval it or rewrite quoted URLs.
    out, i, quoted, escaped = [], 0, False, False
    while i < len(text):
        c = text[i]
        if quoted:
            out.append(c)
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                quoted = False
            i += 1
        elif c == '"':
            quoted = True
            out.append(c)
            i += 1
        elif text[i:i + 2] == "//":
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
        elif text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            if end < 0:
                raise ValueError("unclosed JSONC comment")
            out.append(" ")
            i = end + 2
        elif c == "," and re.match(r"\s*[}\]]", text[i + 1:]):
            i += 1
        else:
            out.append(c)
            i += 1
    return json.loads("".join(out))


def is_license_notice_name(name):
    return bool(re.fullmatch(r"(?:licen[cs]es?|notices?|copying|copyright|third[-_]party[-_]licen[cs]es)(?:[.\-_].*)?", name, re.I))


def license_files(directory, base):
    if not directory.is_dir():
        return []
    return [file_record(p, base) for p in sorted(directory.iterdir())
            if p.is_file() and not p.is_symlink() and is_license_notice_name(p.name)]


def license_family(files, base):
    """Text-family hints only; do not infer coverage or a legal SPDX conclusion."""
    hints = set()
    for record in files:
        text = (base / record["path"]).read_text(errors="replace")
        if "Permission is hereby granted, free of charge" in text:
            hints.add("MIT-style")
        if "Apache License" in text and "Version 2.0" in text:
            hints.add("Apache-2.0-style")
        if "Redistribution and use in source and binary forms" in text:
            hints.add("BSD-style; clause count not inferred")
        if "GNU GENERAL PUBLIC LICENSE" in text:
            hints.add("GPL-family; version not inferred")
    return sorted(hints)


def go_inventory(runtime):
    projects = []
    for name in GO_MANIFESTS:
        path = ROOT / name
        content = path.read_text()
        sums_path = path.with_name("go.sum")
        sums = collections.defaultdict(list)
        if sums_path.exists():
            for line in sums_path.read_text().splitlines():
                module, version, checksum = line.split()
                sums[(module, version.removesuffix("/go.mod"))].append(
                    {"scope": "go.mod" if version.endswith("/go.mod") else "module_zip", "h1": checksum})
        replaces = dict(re.findall(r"^replace\s+(\S+)\s+=>\s+(\S+)\s*$", content, re.M))
        requirements = []
        in_require = False
        for line in content.splitlines():
            line = line.strip()
            if line == "require (":
                in_require = True
                continue
            if line == ")":
                in_require = False
                continue
            if line.startswith("require "):
                line = line[len("require "):]
            elif not in_require:
                continue
            match = re.match(r"(\S+)\s+(v\S+)(.*)$", line)
            if not match:
                continue
            module, version, suffix = match.groups()
            escaped = re.sub(r"[A-Z]", lambda m: "!" + m[0].lower(), module)
            cache_dir = runtime / "gopath/pkg/mod" / (escaped + "@" + version)
            replacement = replaces.get(module)
            directory = (path.parent / replacement).resolve() if replacement else cache_dir
            base = ROOT if replacement else runtime
            licenses = license_files(directory, base)
            requirements.append({"module": module, "version_declared": version,
                                 "relationship": "indirect_declared" if "// indirect" in suffix else "direct_declared",
                                 "replace": replacement, "source": "local_repository_replacement" if replacement else "module_cache" if directory.is_dir() else "not_locally_observed",
                                 "sum_entries": sums[(module, version)],
                                 "license": None, "license_status": "text_evidence_not_full_review" if licenses else "unknown_no_local_license_evidence",
                                 "license_text_family_hints": license_family(licenses, base),
                                 "license_files_base": "repository" if replacement else "runtime",
                                 "license_files": licenses,
                                 "local_replacement_source_files": [file_record(p) for p in sorted(directory.rglob("*")) if p.is_file() and (p.suffix == ".go" or p.name == "go.mod")] if replacement else []})
        projects.append({"manifest": file_record(path),
                         "sum": file_record(sums_path) if sums_path.exists() else None,
                         "go_version": re.search(r"^go (\S+)", content, re.M)[1],
                         "lock_status": "module_versions_and_checksums_not_full_artifact_lock" if sums_path.exists() else "local_replacement_manifest_no_own_sum",
                         "requirements": requirements})
    return projects


def installed_js(directory):
    results, seen = [], set()

    def visit(modules):
        if not modules.is_dir():
            return
        for item in sorted(modules.iterdir()):
            if item.name.startswith(".") or not item.is_dir():
                continue
            packages = sorted(item.iterdir()) if item.name.startswith("@") else [item]
            for package in packages:
                manifest = package / "package.json"
                if not manifest.is_file() or manifest.resolve() in seen:
                    continue
                seen.add(manifest.resolve())
                data = json.loads(manifest.read_text())
                licenses = license_files(package, ROOT)
                results.append({"name": data.get("name"), "version": data.get("version"),
                                "license_declared": data.get("license", data.get("licenses")),
                                "repository_declared": safe_url(data.get("repository", {}).get("url")) if isinstance(data.get("repository"), dict) else safe_url(data.get("repository")),
                                "manifest": file_record(manifest),
                                "license_files": licenses,
                                "license_text_family_hints": license_family(licenses, ROOT) if not data.get("license") else []})
                visit(package / "node_modules")
    visit(directory / "node_modules")
    return results


def js_inventory():
    projects = []
    for name in JS_PROJECTS:
        directory = ROOT / name
        manifest = directory / "package.json"
        data = json.loads(manifest.read_text())
        lock_path = directory / ("bun.lock" if name == "web" else "package-lock.json")
        lock = jsonc(lock_path.read_text())
        direct = {n: {"requested": v, "group": group} for group in
                  ("dependencies", "devDependencies", "optionalDependencies") for n, v in data.get(group, {}).items()}
        packages = []
        for key, record in sorted(lock["packages"].items()):
            if not key:
                continue
            if isinstance(record, list):
                pkg_name, version = record[0].rsplit("@", 1)
                item = {"name": pkg_name, "version": version, "resolved": safe_url(record[1]) or None,
                        "integrity": record[3] if len(record) > 3 else None,
                        "license_declared_in_lock": None}
                top = key == pkg_name
            else:
                pkg_name = record.get("name") or key.rsplit("node_modules/", 1)[-1]
                item = {"name": pkg_name, "version": record.get("version"), "resolved": safe_url(record.get("resolved")),
                        "integrity": record.get("integrity"), "license_declared_in_lock": record.get("license"),
                        "dev": record.get("dev", False), "optional": record.get("optional", False),
                        "in_bundle": record.get("inBundle", False)}
                top = key == "node_modules/" + pkg_name
            item.update({"lock_key": key, "relationship": "direct_declared" if top and pkg_name in direct else "transitive_or_peer_or_optional"})
            packages.append(item)
        installed = installed_js(directory)
        exact = {(p["name"], p["version"]) for p in packages}
        for item in installed:
            item["exact_name_version_in_lock"] = (item["name"], item["version"]) in exact
            item["relationship"] = "direct_declared" if item["manifest"]["path"] == name + "/node_modules/" + str(item["name"]) + "/package.json" and item["name"] in direct else "transitive_or_nested"
        projects.append({"project": name, "manifest": file_record(manifest), "lock": file_record(lock_path),
                         "lock_version": lock.get("lockfileVersion"), "package_manager_declared": data.get("packageManager"),
                         "lock_status": "exact_version_resolution_and_integrity_records; not_a_reproduced_image",
                         "direct_requests": direct, "locked_packages": packages, "installed_packages": installed,
                         "installed_hidden_lock": file_record(directory / "node_modules/.package-lock.json") if (directory / "node_modules/.package-lock.json").is_file() else None,
                         "installed_status": "local_fixture_metadata_only; not_imported_or_executed"})
    return projects


def python_inventory(runtime):
    requirements = []
    for name in PY_MANIFESTS:
        records = []
        for line in (ROOT / name).read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s]+)", line)
                records.append({"name": match[1] if match else None, "version": match[2] if match else None, "requirement": line})
        requirements.append({"manifest": file_record(ROOT / name), "requirements": records,
                             "lock_status": "declared_test_environment_closure_without_hashes" if "/telethon/" in name else "selected_exact_requirements_not_transitive_hash_lock"})
    installed = []
    for meta_path in sorted((runtime / "asr-site").glob("*.dist-info/METADATA")):
        message = email.message_from_bytes(meta_path.read_bytes())
        declared = message.get("License-Expression") or message.get("License")
        classifiers = [v for v in message.get_all("Classifier", []) if v.startswith("License ::")]
        installed.append({"name": message["Name"], "version": message["Version"],
                          "license_expression_declared": message.get("License-Expression"),
                          "license_declared": declared if declared and len(declared) < 512 else None,
                          "license_status": "metadata_declared_not_bundled_code_audit" if declared else "classifier_only_no_exact_license_expression" if classifiers else "unknown_no_metadata_license_field",
                          "license_long_text_omitted": bool(declared and len(declared) >= 512),
                          "license_field_sha256": hashlib.sha256(declared.encode()).hexdigest() if declared else None,
                          "license_classifiers": classifiers,
                          "requires_dist": message.get_all("Requires-Dist", []),
                          "metadata": file_record(meta_path, runtime),
                          "license_files": license_files(meta_path.parent, runtime) + license_files(meta_path.parent / "licenses", runtime)})
    prior = json.loads((ROOT / EVIDENCE[2]).read_text())
    wheels = []
    for record in prior["wheels"]:
        candidates = [runtime / subdir / record["file"] for subdir in ("asr-pinned-wheels", "asr-wheels")]
        found = next((p for p in candidates if p.is_file() and digest(p) == record["sha256"]), None)
        wheels.append({"file": record["file"], "expected_sha256": record["sha256"],
                       "status": "matching_local_bytes" if found else "not_locally_verified", "path_base": "runtime",
                       "path": found.relative_to(runtime).as_posix() if found else None})
    versions = collections.defaultdict(list)
    for item in installed:
        versions[item["name"].lower().replace("_", "-")].append(item["version"])
    host_selected = []
    for name in ("minio", "Pillow", "Telethon", "aiohttp", "yt-dlp", "yt-dlp-ejs"):
        try:
            distribution = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            host_selected.append({"name": name, "status": "not_observed_in_isolated_inventory_python"})
            continue
        message = distribution.metadata
        # Hash metadata without importing the package or disclosing host paths.
        metadata_bytes = (distribution.read_text("METADATA") or "").encode()
        host_selected.append({"name": message["Name"], "version": message["Version"],
                              "license_declared": message.get("License-Expression") or message.get("License"),
                              "metadata_text_sha256": hashlib.sha256(metadata_bytes).hexdigest(),
                              "status": "inventory_python_host_metadata_not_worker_environment_proof"})
    return {"requirements": requirements, "installed_fixture_distributions": installed,
            "host_selected_worker_requirements": host_selected,
            "duplicate_distribution_metadata": {k: v for k, v in versions.items() if len(v) > 1},
            "recorded_wheel_verification": wheels,
            "recorded_smoke": {"evidence": EVIDENCE[3], "scope": "synthetic_local_fixture_not_platform_acceptance_or_container_build",
                               "ctranslate2_executed_version": "4.8.4", "ctranslate2_4_5_0": "rejected_for_executable_stack; metadata_residue_not_execution_proof"}}


def docker_inventory():
    files = []
    # Filename-only discovery skips all env/secret files and dependency caches.
    for directory, subdirs, names in os.walk(ROOT):
        subdirs[:] = sorted(d for d in subdirs if d not in {".git", "node_modules", ".local", "__pycache__", "dist", ".venv"})
        for name in sorted(names):
            if (name.startswith("Dockerfile") and not name.endswith("dockerignore")) or (name.startswith("docker-compose") and name.endswith((".yml", ".yaml"))):
                path = Path(directory) / name
                images = []
                for number, line in enumerate(path.read_text().splitlines(), 1):
                    match = re.match(r"\s*FROM\s+(?:--platform=\S+\s+)?(\S+)", line, re.I) or re.match(r"\s*image:\s*[\"']?([^\s\"']+)", line)
                    if match:
                        value = match[1]
                        images.append({"line": number, "reference_declared": value,
                                       "digest_literal": bool(re.search(r"@sha256:[a-f0-9]{64}", value)),
                                       "variable_reference": "$" in value})
                files.append({**file_record(path), "image_declarations": images})
    return {"files": files, "status": "source_declarations_only; no_image_pull_build_or_os_package_audit",
            "backup": {"required_verified_digest_args": ["NODE_IMAGE", "POSTGRES_IMAGE", "MC_IMAGE"],
                       "resolved_digests": None, "build_status": "not_executed",
                       "remaining_gate": "operator_verified_pins_then_build_and_capture_image_OS_SBOM"}}


def source_inventory():
    # A local implementation commit must not expand this fixed upstream tree
    # or introduce the inventory itself into its own source baseline.
    commit = subprocess.check_output(
        ["git", "rev-parse", "--verify", PINNED_UPSTREAM_COMMIT + "^{commit}"],
        cwd=ROOT, text=True).strip()
    if commit != PINNED_UPSTREAM_COMMIT:
        raise RuntimeError("Pinned upstream commit verification returned a different object")
    raw = subprocess.check_output(["git", "ls-tree", "-r", "-l", "-z", commit], cwd=ROOT)
    records, groups, artifacts = [], collections.defaultdict(lambda: {"files": 0, "bytes": 0}), []
    for entry in raw.decode().split("\0"):
        if not entry:
            continue
        header, path = entry.split("\t", 1)
        mode, kind, oid, size = header.split()
        record = {"path": path, "mode": mode, "git_object": oid, "bytes": int(size) if size != "-" else None}
        records.append(record)
        group = path.split("/", 1)[0] if "/" in path else "(root)"
        groups[group]["files"] += 1
        groups[group]["bytes"] += record["bytes"] or 0
        candidate = path == "backend/server" or path == "services/loom-engine/public/zhishi-loom-source.zip" or bool(re.fullmatch(r"plugin-packages/official-payment-[^/]+(?:\.yingce-plugin|/backend/provider(?:-[^/]+)?)", path))
        if candidate and (ROOT / path).is_file():
            current = ROOT / path
            with current.open("rb") as stream:
                magic = stream.read(4).hex()
            artifacts.append({**file_record(current), "magic_first_four_bytes": magic,
                              "source_archive_proposal": "exclude_only_in_explicit_source_only_bundle" if path == "backend/server" else "optional_nested_generated_archive_exclusion; changes_source_download_link" if path.endswith("zhishi-loom-source.zip") else "retain_in_default_full_host; source_only_omission_requires_rebuild_contract",
                              "build_evidence": "backend/Dockerfile" if path == "backend/server" else "services/loom-engine/scripts/pack-source.mjs" if path.endswith("zhishi-loom-source.zip") else "plugin-packages/build-packages.sh; backend/Dockerfile"})
    notice_records = [file_record(ROOT / r["path"]) for r in records if is_license_notice_name(Path(r["path"]).name) and (ROOT / r["path"]).is_file()]
    return {"baseline_commit": commit, "baseline_reference": "explicit_pinned_upstream_commit_not_HEAD",
            "scope": "tracked_git_tree_baseline_only; not_final_modified_release_manifest",
            "artifact_and_notice_hash_scope": "observed_worktree_bytes_at_paths_selected_from_pinned_baseline",
            "tracked_count": len(records), "tracked_bytes": sum(r["bytes"] or 0 for r in records),
            "groups": dict(sorted(groups.items())), "tracked_files": records,
            "generated_artifact_candidates": artifacts,
            "tracked_license_notice_files": notice_records,
            "tracked_cache_paths": [r["path"] for r in records if any(p in {"node_modules", "__pycache__", ".cache", "dist"} for p in Path(r["path"]).parts) or r["path"].endswith((".pyc", ".tsbuildinfo"))],
            "contents_policy": "git metadata only except explicitly identified build artifacts; no env/credentials/token files read",
            "source_archive_exclusions_applied": False}


def toolchain_inventory(runtime):
    records = {"inventory_python": ".".join(map(str, sys.version_info[:3])),
               "scope": "local_metadata_and_archive_hashes; not_tool_execution_or_fresh_official_lookup"}
    go_meta = runtime / "go-download.json"
    if go_meta.is_file():
        meta = json.loads(go_meta.read_text())
        archive = runtime / Path(meta["filename"]).name
        version_file = runtime / "go-toolchain/go/VERSION"
        records["go"] = {"download_record": file_record(go_meta, runtime),
                         "version_recorded": meta.get("version"),
                         "version_file": file_record(version_file, runtime) if version_file.is_file() else None,
                         "archive": file_record(archive, runtime) if archive.is_file() else None,
                         "archive_matches_recorded_sha256": archive.is_file() and digest(archive) == meta.get("sha256")}
    bun_meta = runtime / "bun-download.json"
    bun_manifest = runtime / "bun-toolchain/package/package.json"
    if bun_meta.is_file() and bun_manifest.is_file():
        meta = json.loads(bun_meta.read_text())
        package = json.loads(bun_manifest.read_text())
        archive = runtime / ("bun-" + str(meta["version"]) + ".tgz")
        sha512 = hashlib.sha512()
        if archive.is_file():
            with archive.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    sha512.update(block)
        records["bun"] = {"download_record": file_record(bun_meta, runtime),
                          "package_manifest": file_record(bun_manifest, runtime),
                          "version_observed": package.get("version"), "version_declared_by_web": json.loads((ROOT / "web/package.json").read_text()).get("packageManager"),
                          "tarball_url_recorded": safe_url(meta.get("dist.tarball")),
                          "archive": file_record(archive, runtime) if archive.is_file() else None,
                          "archive_matches_recorded_integrity": archive.is_file() and "sha512-" + base64.b64encode(sha512.digest()).decode() == meta.get("dist.integrity")}
    declared_meta = runtime / "bun-declared/pack.json"
    validation_path = ROOT / "docs/video-ingestion/evidence/bun-declared-validation.json"
    if declared_meta.is_file() and validation_path.is_file():
        meta = json.loads(declared_meta.read_text())[0]
        archive = declared_meta.parent / Path(meta["filename"]).name
        binary = declared_meta.parent / "package/bin/bun"
        validation = json.loads(validation_path.read_text())
        sha512 = hashlib.sha512()
        if archive.is_file():
            with archive.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    sha512.update(block)
        records["bun_declared"] = {
            "package_version": meta["version"],
            "pack_metadata": file_record(declared_meta, runtime),
            "archive": file_record(archive, runtime) if archive.is_file() else None,
            "binary": file_record(binary, runtime) if binary.is_file() else None,
            "archive_matches_recorded_integrity": archive.is_file() and "sha512-" + base64.b64encode(sha512.digest()).decode() == meta.get("integrity"),
            "validation_evidence": file_record(validation_path),
            "runtime_validations": [{"version": item["version"], "tests": item["tests"]["status"],
                                     "production_build": item["production_build"]["status"]}
                                    for item in validation["runtime_validations"]],
            "fresh_dependency_install_with_declared_runtime": validation["dependency_installation"]["fresh_install_with_1_3_9"],
            "scope": "recorded_parent_execution_and_local_archive_hashes; collector_does_not_execute_binary_or_tests"}
    return records


def inventory(runtime):
    go, js, py = go_inventory(runtime), js_inventory(), python_inventory(runtime)
    model = json.loads((ROOT / EVIDENCE[4]).read_text())
    model_check = [{"name": f["name"], "expected_sha256": f["sha256"],
                    "matching_local_bytes": (runtime / "models/faster-whisper-tiny" / f["name"]).is_file() and digest(runtime / "models/faster-whisper-tiny" / f["name"]) == f["sha256"]} for f in model["files"]]
    summary = {"go_manifests": len(go), "go_declared_requirement_records": sum(len(p["requirements"]) for p in go),
               "npm_locks": 2, "bun_locks": 1, "python_requirements_files": len(py["requirements"]),
               "js_projects": [{"project": p["project"], "direct_requests": len(p["direct_requests"]),
                                "locked_records": len(p["locked_packages"]), "installed_records": len(p["installed_packages"]),
                                "installed_license_missing": sum(not i["license_declared"] for i in p["installed_packages"]),
                                "lock_missing_integrity": sum(not i["integrity"] for i in p["locked_packages"]),
                                "lock_missing_integrity_not_marked_bundled": sum(not i["integrity"] and not i.get("in_bundle") for i in p["locked_packages"]),
                                "installed_name_version_absent_from_lock": sum(not i["exact_name_version_in_lock"] for i in p["installed_packages"])} for p in js],
               "python_installed_metadata_records": len(py["installed_fixture_distributions"]),
               "recorded_wheels_verified": sum(i["status"] == "matching_local_bytes" for i in py["recorded_wheel_verification"]),
               "model_files_verified": sum(i["matching_local_bytes"] for i in model_check)}
    return {"schema_version": 1, "generator": file_record(Path(__file__).resolve()),
            "method": "offline_standard_library_metadata_inventory; no_package_execution_install_or_network",
            "limitations": ["Not a complete SPDX/CycloneDX SBOM or legal/commercial-compatibility opinion.",
                            "Declared licenses and text hashes do not prove bundled transitive-code coverage or notice sufficiency.",
                            "Go manifest requirements are not an executed module graph; local replaces need source hashes.",
                            "JS name/version match does not establish installed-byte integrity; platform optional packages can be absent.",
                            "Python fixture metadata, model/wheel pins and source locks do not establish container reproducibility.",
                            "Baseline tree excludes current untracked modifications; release packager must inventory final staged files."],
            "summary": summary, "evidence_files": [file_record(ROOT / n) for n in EVIDENCE],
            "project_notice_files": [file_record(ROOT / n) for n in ["LICENSE", "NOTICE", "THIRD_PARTY_UPSTREAMS.md", "services/loom-engine/LICENSE", "web/public/live2d/NOTICE.txt"]],
            "go": go, "javascript": js, "python": py,
            "model": {"repository": model["repository"], "revision": model["revision"], "local_files": model_check,
                      "license_declared_in_model_card": next((line.split(":", 1)[1].strip() for line in (runtime / "models/faster-whisper-tiny/README.md").read_text().splitlines() if line.startswith("license:")), None) if (runtime / "models/faster-whisper-tiny/README.md").exists() else None,
                      "license_evidence": "pinned model card README.md; declaration is not an audit of model/data rights"},
            "toolchains": toolchain_inventory(runtime),
            "containers": docker_inventory(), "source_release": source_inventory()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True, help="Existing audited runtime/cache directory; nothing is installed")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/video-ingestion/evidence/dependency-inventory.json")
    parser.add_argument("--check", action="store_true", help="Compare without writing; cache-dependent metadata must still exist")
    args = parser.parse_args()
    result = inventory(args.runtime.resolve())
    payload = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not args.output.is_file() or args.output.read_text() != payload:
            print("Dependency inventory differs; regenerate against the intended release/cache snapshot.", file=sys.stderr)
            return 1
        print("Dependency inventory matches current bounded inputs.")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload)
        print(json.dumps(result["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
