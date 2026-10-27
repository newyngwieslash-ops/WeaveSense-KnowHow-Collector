#!/usr/bin/env python3
"""Read-only video pilot/build preflight. Never prints configuration values."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
IMAGE_KEYS = ("VIDEO_BACKUP_NODE_IMAGE", "VIDEO_BACKUP_POSTGRES_IMAGE", "VIDEO_BACKUP_MC_IMAGE")
PLACEHOLDERS = {"changeme", "change-me", "replace-me", "placeholder", "synthetic", "example"}


def parse_env(path):
    """Parse literal dotenv assignments, never source/eval or expand secrets."""
    result = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError(f"ENV_SYNTAX_LINE_{number}")
        value = value.strip()
        if value[:1] in ("'", '"'):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError(f"ENV_QUOTE_LINE_{number}")
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, 1)[0].rstrip()
        if "$" in value or "`" in value or "\x00" in value:
            raise ValueError(f"ENV_NONLITERAL_LINE_{number}")
        if key in result:
            raise ValueError(f"ENV_DUPLICATE_LINE_{number}")
        result[key] = value
    return result


def check(env, mode="pilot", root=ROOT, check_local=False):
    checks = []

    def add(code, ok, message, warning=False):
        checks.append({"code": code, "status": "pass" if ok else "warning" if warning else "fail", "message": message})

    def required(key, minimum=1):
        value = env.get(key, "")
        ok = len(value) >= minimum and not any(value.lower().startswith(p) for p in PLACEHOLDERS) and not re.search(r"<[^>]+>", value)
        add(key, ok, f"{key}: required non-placeholder value ({minimum}+ characters); value withheld")
        return ok

    patterns = (
        r"(?:docker.io/library/)?node:22(?:\.\d+){0,2}-bookworm(?:-slim)?@sha256:[a-f0-9]{64}",
        r"(?:docker.io/library/)?postgres:17(?:\.\d+){0,2}-bookworm@sha256:[a-f0-9]{64}",
        r"(?:(?:docker.io/)?minio/mc|quay.io/minio/mc|(?:docker.io/)?bitnamilegacy/minio-client):[^@\s]+@sha256:[a-f0-9]{64}",
    )
    for key, pattern in zip(IMAGE_KEYS, patterns):
        add(key, bool(re.fullmatch(pattern, env.get(key, ""))), f"{key}: compatible immutable digest reference required")
    if mode == "build":
        return checks

    add("PILOT_ENABLED", env.get("FLOW_VIDEO_ENABLED") == "true", "Pilot check requires FLOW_VIDEO_ENABLED=true; this tool never enables it")
    workspaces = [s.strip() for s in env.get("FLOW_VIDEO_WORKSPACES", "").split(",") if s.strip()]
    add("PILOT_ALLOWLIST", bool(workspaces) and len(workspaces) == len(set(workspaces)) and all(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", s) for s in workspaces), "Explicit unique workspace allowlist required; an empty list would globally enable video")
    for key in ("VIDEO_SERVICE_TOKEN", "FLOW_INTERNAL_JWT_SIGNING_KEY", "VIDEO_DELETION_JOURNAL_KEY"):
        required(key, 32)
    for key in ("VIDEO_OBJECT_ACCESS_KEY", "VIDEO_OBJECT_SECRET_KEY", "VIDEO_DELETION_JOURNAL_ID", "VIDEO_DELETION_JOURNAL_VOLUME"):
        required(key)
    required("FLOW_MODEL_GATEWAY_EMBEDDING_MODEL")
    for key in ("FLOW_MODEL_GATEWAY_EMBEDDING_MICRO_PER_1K_TOKENS", "FLOW_MODEL_GATEWAY_EMBEDDING_DIMENSIONS"):
        add(key, bool(re.fullmatch(r"[1-9][0-9]*", env.get(key, ""))), f"{key}: positive integer required for embedding-ready profiles")
    for key, default in (("VIDEO_MAX_BYTES", "2147483648"), ("VIDEO_MIN_FREE_BYTES", "268435456"), ("VIDEO_MAX_TEMP_BYTES", "4294967296")):
        add(key, bool(re.fullmatch(r"[1-9][0-9]*", env.get(key, default))), f"{key}: positive resource bound required")
    try:
        ratio = float(env.get("VIDEO_MIN_FREE_RATIO", "0.05"))
        add("VIDEO_MIN_FREE_RATIO", 0 < ratio < 1, "Disk free-space ratio must be between zero and one")
    except ValueError:
        add("VIDEO_MIN_FREE_RATIO", False, "Disk free-space ratio must be numeric")

    if env.get("DTK_ENABLED") == "true":
        for key in ("DTK_SERVICE_TOKEN", "DTK_TENANT_ID", "DTK_WORKSPACE_ID"):
            required(key)
        try:
            url = urlsplit(env.get("DTK_URL", ""))
            ok = url.scheme in ("http", "https") and bool(url.hostname) and not url.username and not url.password and not url.query and not url.fragment
        except ValueError:
            ok = False
        add("DTK_URL", ok, "DTK URL must be HTTP(S), without embedded credentials/query/fragment; reachability is not checked")
        add("DTK_WORKSPACE_SCOPE", env.get("DTK_WORKSPACE_ID") in workspaces, "Default DTK workspace must belong to the pilot allowlist")
    else:
        add("DTK_DISABLED", False, "Live Bili/Douyin provider is disabled; local lawful-input tests only", warning=True)

    for capability in ("ASR", "OCR"):
        if env.get(capability + "_ENABLED") == "true":
            required(capability + "_SERVICE_TOKEN", 32)
    if env.get("VIDEO_MODEL_ENABLED") == "true":
        for key in ("FLOW_MODEL_GATEWAY_URL", "FLOW_MODEL_GATEWAY_KEY", "FLOW_MODEL_GATEWAY_MODEL"):
            required(key)
        add("VISION_CAPABILITY", env.get("FLOW_MODEL_GATEWAY_SUPPORTS_VISION") == "true", "Visual model processing requires explicitly enabled host vision support")
        add("MODEL_PRICE", bool(re.fullmatch(r"[1-9][0-9]*", env.get("FLOW_MODEL_MICRO_PER_1K_TOKENS", ""))), "Model processing requires a positive host token price")
    if env.get("ASR_ENABLED") == "true":
        if check_local:
            directory = Path(env.get("VIDEO_ASR_MODEL_HOST_DIR", ".local/models/asr"))
            if not directory.is_absolute():
                directory = root / directory
            try:
                lock = json.loads((directory / "model-lock.json").read_text())
                files = lock["files"]
                ok = bool(files) and bool(re.fullmatch(r"[a-f0-9]{40}", lock.get("revision", ""))) and bool(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", lock.get("repository", "")))
                names = set()
                for item in files:
                    name = item["name"]
                    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in (".", "..") or name in names:
                        ok = False
                        break
                    names.add(name)
                    path = directory / name
                    if path.is_symlink() or not path.is_file():
                        ok = False
                        break
                    with path.open("rb") as stream:
                        actual = hashlib.file_digest(stream, "sha256").hexdigest()
                    ok = ok and actual == item["sha256"] and path.stat().st_size == item["bytes"]
                ok = ok and {"model.bin", "config.json", "tokenizer.json", "vocabulary.txt"} <= names
                ok = ok and (not (directory / "preprocessor_config.json").exists() or "preprocessor_config.json" in names)
                add("ASR_LOCAL_LOCK", ok, "Local ASR model file size/hash/revision lock validation")
            except (OSError, ValueError, KeyError, TypeError):
                add("ASR_LOCAL_LOCK", False, "Local ASR model lock or files missing/invalid; contents withheld")
        else:
            add("ASR_LOCAL_LOCK", False, "Use --check-local-files on the deployment host to verify ASR bytes", warning=True)
    add("JOURNAL_CONTENTS", False, "Journal ID/key presence is not integrity validation: run existing journal CLI verify against the separately retained volume; never auto-init", warning=True)
    add("PREFLIGHT_LIMITS", False, "Static configuration checks do not prove service connectivity, permissions, model quality, restore safety or PRD acceptance", warning=True)
    return checks


def docker_checks(env):
    """Only read daemon/volume metadata. Never create, initialize or repair."""
    result = []
    if not shutil.which("docker"):
        return [{"code": "DOCKER", "status": "fail", "message": "Docker CLI unavailable"}]
    commands = [("DOCKER", ["docker", "info", "--format", "{{.ServerVersion}}"])]
    volume = env.get("VIDEO_DELETION_JOURNAL_VOLUME", "")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", volume):
        commands.append(("JOURNAL_VOLUME", ["docker", "volume", "inspect", "--format", "{{.Name}}", volume]))
    else:
        result.append({"code": "JOURNAL_VOLUME", "status": "fail", "message": "Valid external journal volume name required"})
    for code, command in commands:
        try:
            p = subprocess.run(command, capture_output=True, timeout=15, check=False)
            ok = p.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            ok = False
        result.append({"code": code, "status": "pass" if ok else "fail", "message": "Read-only Docker metadata check; command output withheld"})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, help="Literal dotenv file; overrides same keys from process environment")
    parser.add_argument("--mode", choices=("pilot", "build"), default="pilot")
    parser.add_argument("--check-local-files", action="store_true")
    parser.add_argument("--check-docker", action="store_true", help="Read-only daemon/external-volume checks; no Docker mutation")
    args = parser.parse_args()
    env = dict(os.environ)
    try:
        if args.env_file:
            env.update(parse_env(args.env_file))
        checks = check(env, args.mode, check_local=args.check_local_files)
        if args.check_docker:
            checks.extend(docker_checks(env))
    except (OSError, ValueError):
        checks = [{"code": "ENV_INPUT", "status": "fail", "message": "Cannot read literal env file (syntax/duplicate/interpolation rejected); values withheld"}]
    failed = any(c["status"] == "fail" for c in checks)
    print(json.dumps({"schema_version": 1, "mode": args.mode, "static_preflight_passed": not failed, "production_ready": False, "checks": checks}, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
