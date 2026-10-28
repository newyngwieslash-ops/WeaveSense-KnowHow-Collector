"""Private, disposable TEST configuration; refuses an existing environment."""
import json
import os
from pathlib import Path
import secrets
import sys

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / ".local/video-fullstack"
ENV = ROOT / ".env.flow"


def write_private(path, value, exclusive=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC), 0o600)
    with os.fdopen(fd, "w") as target:
        target.write(value)


def env_read():
    return dict(line.split("=", 1) for line in ENV.read_text().splitlines() if line and not line.startswith("#"))


def save(values, exclusive=False):
    write_private(ENV, "\n".join(f"{k}={v}" for k, v in values.items()) + "\n", exclusive)


def prepare():
    PRIVATE.mkdir(parents=True, mode=0o700, exist_ok=False)
    values = {
        "COMPOSE_PROFILES": "core,video", "FLOW_HTTP_PORT": "4180",
        "POSTGRES_SUPERUSER": "postgres", "PLATFORM_DB_NAME": "flow_platform",
        "PLATFORM_DB_USER": "flow_platform", "INTEL_DB_NAME": "flow_intel", "INTEL_DB_USER": "flow_intel",
        "MINIO_ROOT_USER": "fullstack-root", "VIDEO_OBJECT_ACCESS_KEY": "fullstack-video",
        "PLATFORM_BUCKET": "flow-platform", "INTEL_BUCKET": "flow-intel",
        "FLOW_INTERNAL_JWT_ISSUER": "flow-platform", "FLOW_INTERNAL_JWT_AUDIENCE": "loom-engine",
        "FLOW_VIDEO_ENABLED": "true", "FLOW_VIDEO_WORKSPACES": "not-yet-bootstrapped",
        "VIDEO_DELETION_JOURNAL_VOLUME": os.environ["COMPOSE_PROJECT_NAME"] + "-journal",
        "VIDEO_DELETION_JOURNAL_ID": "", "LOOM_AUTO_MIGRATE": "true",
        "CANVAS_REGISTRATION_ENABLED": "false", "CANVAS_CORS_ORIGINS": "http://127.0.0.1:4180",
        "CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS": "provider-fixture",
        "CANVAS_LOG_LEVEL": "info", "FLOW_MODEL_GATEWAY_URL": "http://provider-fixture:8800/v1",
        "FLOW_MODEL_GATEWAY_MODEL": "fullstack-synthetic", "FLOW_MODEL_MICRO_PER_1K_TOKENS": "2000",
        "ASR_ENABLED": "false", "OCR_ENABLED": "false", "DTK_ENABLED": "false", "VIDEO_MODEL_ENABLED": "false",
        "LOOM_SPLIT_ROLES": "false", "LOOM_DIRECT_PROVIDER_KEYS": "disabled", "TZ": "UTC",
    }
    for name in ("POSTGRES_SUPERUSER_PASSWORD", "PLATFORM_DB_PASSWORD", "INTEL_DB_PASSWORD", "REDIS_PASSWORD",
                 "MINIO_ROOT_PASSWORD", "VIDEO_OBJECT_SECRET_KEY", "FLOW_INTERNAL_JWT_SIGNING_KEY",
                 "VIDEO_DELETION_JOURNAL_KEY", "VIDEO_SERVICE_TOKEN", "FLOW_MODEL_GATEWAY_KEY"):
        values[name] = secrets.token_hex(32)
    save(values, exclusive=True)


def scope():
    values = env_read()
    state = json.loads((PRIVATE / "state.json").read_text())
    values["FLOW_VIDEO_WORKSPACES"] = state["workspaceId"]
    save(values)
    prefix = f"tenants/{state['tenantId']}/workspaces/{state['workspaceId']}/video/"
    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["s3:GetBucketLocation"], "Resource": ["arn:aws:s3:::flow-intel"]},
        {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::flow-intel"],
         "Condition": {"StringLike": {"s3:prefix": [prefix + "*"]}}},
        {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
         "Resource": ["arn:aws:s3:::flow-intel/" + prefix + "*"]},
    ]}
    write_private(PRIVATE / "object-policy.json", json.dumps(policy))


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        prepare()
    elif sys.argv[1] == "scope":
        scope()
    elif sys.argv[1] == "journal":
        values = env_read()
        result = json.loads(sys.stdin.read().splitlines()[-1])
        values["VIDEO_DELETION_JOURNAL_ID"] = result["journal_id"]
        save(values)
    else:
        raise SystemExit("usage: configure.py prepare|scope|journal")
