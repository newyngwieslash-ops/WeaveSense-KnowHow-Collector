"""Immutable execution artifacts. No business database or evidence identifiers."""
from __future__ import annotations

import base64
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.error import HTTPError, URLError

ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
HASH = re.compile(r"[a-f0-9]{64}")
OBJECT = re.compile(r"tenants/([A-Za-z0-9_-]{1,64})/workspaces/([A-Za-z0-9_-]{1,64})/video/([A-Za-z0-9_-]{1,80})/([a-f0-9]{64})/([A-Za-z0-9_.-]{1,120})")
ARTIFACT_RECEIPT = ContextVar("artifact_receipt", default=None)
ARTIFACT_INTENT = ContextVar("artifact_intent", default=None)
SCRATCH_BUDGET = ContextVar("scratch_budget", default=None)


class Failure(Exception):
    def __init__(self, code, status=422, retryable=False, retry_after=None):
        super().__init__(code)
        self.code, self.status, self.retryable, self.retry_after = code, status, retryable, retry_after

    def payload(self):
        return {"code": self.code, "retryable": self.retryable, "retry_after": self.retry_after}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def disk_guard(path, incoming=0):
    """An execution-local guard, not the host's daily quota authority."""
    root = Path(path)
    while not root.exists():
        root = root.parent
    floor = int(os.environ.get("VIDEO_MIN_FREE_BYTES", str(256 * 1024 * 1024)))
    fraction = float(os.environ.get("VIDEO_MIN_FREE_RATIO", "0.05"))
    if floor < 0 or not 0 <= fraction < 1 or incoming < 0:
        raise Failure("INVALID_DISK_WATERMARK", 503)
    capacity = shutil.disk_usage(root)
    if capacity.free - incoming < max(floor, int(capacity.total * fraction)):
        raise Failure("STORAGE_PRESSURE", 507, True, 60)
    budget = SCRATCH_BUDGET.get()
    if budget:
        files = list(budget["root"].rglob("*"))
        if len(files) > 10000:
            raise Failure("TEMPORARY_RESOURCE_LIMIT", 413)
        total = sum(p.stat().st_size for p in files if p.is_file() and not p.is_symlink())
        budget["peak_bytes_observed"] = max(budget["peak_bytes_observed"], total)
        if total + incoming > budget["max_bytes"]:
            raise Failure("TEMPORARY_RESOURCE_LIMIT", 413)


@contextmanager
def scratch_budget(root):
    budget = {"root": Path(root), "max_bytes": int(os.environ.get("VIDEO_MAX_TEMP_BYTES", str(4 * 1024 * 1024 * 1024))), "peak_bytes_observed": 0}
    if budget["max_bytes"] <= 0:
        raise Failure("INVALID_TEMPORARY_LIMIT", 503)
    token = SCRATCH_BUDGET.set(budget)
    try:
        yield budget
    finally:
        SCRATCH_BUDGET.reset(token)


def typed_object(ref):
    if not isinstance(ref.get("content_type"), str) or not re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", ref["content_type"]) or type(ref.get("bytes")) is not int or ref["bytes"] < 0 or not HASH.fullmatch(ref.get("sha256", "")):
        raise Failure("INVALID_OBJECT", 400)
    name = ref["object_key"].rsplit("/", 1)[-1]
    mime = ref["content_type"]
    kind = ("frame" if name.startswith("frame-") else "grid" if name.startswith("grid-") else
            "audio" if name == "audio.wav" else "media" if mime.startswith(("video/", "audio/")) else
            "visual_metadata" if name.startswith("visual-") else "derived_summary" if name == "summary.json" else
            "transcript" if name in ("segments.json", "asr-part.json", "chunk.json", "input.json", "subtitles.json", "subtitle.json") else "metadata")
    return {**ref, "artifact_type": kind, "retention_class": "frame" if kind in ("frame", "grid") else kind if kind in ("media", "audio", "transcript") else "derived"}


def scope_key(key, scope, job_id=None):
    m = OBJECT.fullmatch(key) if isinstance(key, str) else None
    if not m or ".." in key or (m[1], m[2]) != (scope["tenant_id"], scope["workspace_id"]) or (job_id and m[3] != job_id):
        raise Failure("SCOPE_DENIED", 403)
    return m


def verify_context(token, key, scope, permission, job_id=None, now=None):
    now = time.time() if now is None else now
    if len(key.encode()) < 32:
        raise Failure("AUTH_NOT_CONFIGURED", 503)
    try:
        header, body, signature = token.split(".")
        decode = lambda x: base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))
        if json.loads(decode(header)) != {"alg": "HS256", "typ": "JWT"}:
            raise ValueError()
        expected = hmac.new(key.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, decode(signature)):
            raise ValueError()
        c = json.loads(decode(body))
        if not isinstance(c.get("scopes"), list) or any(not isinstance(c.get(k), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", c[k]) for k in ("tenant_id", "workspace_id")) or type(c.get("iat")) is not int or type(c.get("exp")) is not int:
            raise ValueError()
        if c.get("iss") != "loom-engine" or c["aud"] != "video-knowledge" or c["actor"] != {"type": "service_principal", "id": "loom-engine"} or c["exp"] <= now or c["iat"] > now + 5 or not 0 < c["exp"] - c["iat"] <= 300:
            raise ValueError()
        if permission not in c["scopes"] or any(c[k] != scope[k] for k in ("tenant_id", "workspace_id")) or (job_id and c.get("job_id") != job_id):
            raise Failure("SCOPE_DENIED", 403)
        return c
    except Failure:
        raise
    except (ValueError, KeyError, TypeError):
        raise Failure("AUTH_REQUIRED", 401) from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Failure("REDIRECT_DENIED", 502)


class InternalClient:
    """Only a deployment-fixed origin; operation methods own all paths."""
    def __init__(self, origin, token, timeout=20, auth_header="Authorization"):
        parsed = urlsplit(origin)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise Failure("INVALID_SERVICE_ORIGIN", 503)
        if not token:
            raise Failure("PROVIDER_NOT_CONFIGURED", 503)
        if auth_header not in ("Authorization", "X-API-Key"):
            raise Failure("INVALID_SERVICE_AUTH", 503)
        self.origin, self.token, self.timeout = origin.rstrip("/"), token, min(timeout, 25)
        self.auth_header = auth_header
        self.opener = build_opener(NoRedirect)

    def open(self, method, path, body=None, headers=None):
        if not path.startswith("/") or path.startswith("//") or ".." in path:
            raise Failure("INVALID_SERVICE_PATH", 400)
        req = Request(self.origin + path, data=canonical(body) if body is not None else None,
                      headers={self.auth_header: ("Bearer " if self.auth_header == "Authorization" else "") + self.token, "Content-Type": "application/json", **(headers or {})}, method=method)
        try:
            return self.opener.open(req, timeout=self.timeout)
        except HTTPError as exc:
            code = {401: "AUTH_REQUIRED", 403: "SCOPE_DENIED", 404: "SOURCE_UNAVAILABLE", 429: "RATE_LIMITED"}.get(exc.code, "PROVIDER_ERROR")
            retry = exc.headers.get("Retry-After", "")
            retry_seconds = int(retry) if retry.isdigit() else None
            if retry and retry_seconds is None:
                try:
                    retry_seconds = max(0, int(parsedate_to_datetime(retry).timestamp() - time.time()))
                except (ValueError, TypeError, OverflowError):
                    pass
            raise Failure(code, exc.code, exc.code in (429, 500, 502, 503, 504), retry_seconds) from None
        except (URLError, TimeoutError, OSError):
            raise Failure("PROVIDER_UNAVAILABLE", 503, True) from None

    def json(self, method, path, body=None, headers=None, maximum=2 * 1024 * 1024):
        with self.open(method, path, body, headers) as response:
            raw = response.read(maximum + 1)
        if len(raw) > maximum:
            raise Failure("PROVIDER_OUTPUT_TOO_LARGE", 502)
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise Failure("PROVIDER_CONTRACT_CHANGED", 502) from None
        if not isinstance(value, dict):
            raise Failure("PROVIDER_CONTRACT_CHANGED", 502)
        return value


class Objects:
    """Host-controlled MinIO objects; local implementation is test-only."""
    def __init__(self, store, bucket="flow-media"):
        self.store, self.bucket = store, bucket

    def open(self, key):
        try:
            return self.store.get_object(self.bucket, key)
        except (FileNotFoundError, KeyError):
            raise Failure("OBJECT_NOT_FOUND", 404) from None
        except Exception as exc:
            if getattr(exc, "code", None) in ("NoSuchKey", "NoSuchObject"):
                raise Failure("OBJECT_NOT_FOUND", 404) from None
            raise Failure("OBJECT_STORE_UNAVAILABLE", 503, True) from None

    @contextmanager
    def journal(self, receipt, intent=None):
        token = ARTIFACT_RECEIPT.set(receipt)
        intent_token = ARTIFACT_INTENT.set(intent)
        try:
            yield
        finally:
            ARTIFACT_RECEIPT.reset(token)
            ARTIFACT_INTENT.reset(intent_token)

    def intent(self, ref):
        ref = typed_object(ref)
        callback = ARTIFACT_INTENT.get()
        if callback:
            callback(ref)
        return ref

    def record(self, ref):
        ref = typed_object(ref)
        receipt = ARTIFACT_RECEIPT.get()
        if receipt:
            receipt(ref)
        return ref

    def put(self, scope, job, raw, name, content_type="application/json"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", job) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", name):
            raise Failure("INVALID_OBJECT", 400)
        digest = sha(raw)
        disk_guard(os.environ.get("VIDEO_TEMP_ROOT") or tempfile.gettempdir())
        key = f"tenants/{scope['tenant_id']}/workspaces/{scope['workspace_id']}/video/{job}/{digest}/{name}"
        scope_key(key, scope, job)
        ref = self.intent({"object_key": key, "sha256": digest, "bytes": len(raw), "content_type": content_type})
        try:
            self.store.put_object(self.bucket, key, io.BytesIO(raw), len(raw), content_type=content_type)
        except Exception:
            raise Failure("OBJECT_STORE_WRITE_UNCERTAIN", 503, True) from None
        return self.record(ref)

    def put_file(self, scope, job, path, name, content_type, maximum):
        disk_guard(Path(path).parent)
        size, digest = 0, hashlib.sha256()
        with open(path, "rb") as stream:
            while block := stream.read(1024 * 1024):
                size += len(block)
                if size > maximum:
                    raise Failure("LIMIT_EXCEEDED", 413)
                digest.update(block)
        key = f"tenants/{scope['tenant_id']}/workspaces/{scope['workspace_id']}/video/{job}/{digest.hexdigest()}/{name}"
        scope_key(key, scope, job)
        ref = self.intent({"object_key": key, "sha256": digest.hexdigest(), "bytes": size, "content_type": content_type})
        try:
            with open(path, "rb") as stream:
                self.store.put_object(self.bucket, key, stream, size, content_type=content_type)
        except Exception:
            raise Failure("OBJECT_STORE_WRITE_UNCERTAIN", 503, True) from None
        return self.record(ref)

    def read(self, ref, scope, job, maximum=1024 * 1024):
        if scope_key(ref["object_key"], scope, job)[4] != ref.get("sha256"):
            raise Failure("INCOMPLETE_ARTIFACT", 422)
        resp = self.open(ref["object_key"])
        try:
            raw = resp.read(maximum + 1)
        finally:
            resp.close()
            resp.release_conn()
        if len(raw) > maximum or len(raw) != ref["bytes"] or sha(raw) != ref["sha256"]:
            raise Failure("INCOMPLETE_ARTIFACT", 422)
        return raw

    def delete(self, key, expected_hash, scope, job):
        match = scope_key(key, scope, job)
        if match[4] != expected_hash:
            raise Failure("INCOMPLETE_ARTIFACT")
        # MinIO remove_object is idempotent for a missing key. No prefix deletion.
        try:
            self.store.remove_object(self.bucket, key)
        except Exception as exc:
            if getattr(exc, "code", None) not in ("NoSuchKey", "NoSuchObject"):
                raise Failure("OBJECT_DELETE_UNCONFIRMED", 503, True) from None
        return {"deleted": True, "sha256": expected_hash}

    def materialize(self, ref, scope, job, target, maximum):
        if scope_key(ref["object_key"], scope, job)[4] != ref.get("sha256"):
            raise Failure("INCOMPLETE_ARTIFACT", 422)
        resp = self.open(ref["object_key"])
        size, digest = 0, hashlib.sha256()
        partial = Path(str(target) + ".partial")
        disk_guard(partial.parent, min(maximum, ref["bytes"]))
        try:
            with partial.open("wb") as out:
                while block := resp.read(1024 * 1024):
                    size += len(block)
                    if size > maximum:
                        raise Failure("LIMIT_EXCEEDED", 413)
                    disk_guard(partial.parent, len(block))
                    out.write(block)
                    digest.update(block)
            if size != ref["bytes"] or digest.hexdigest() != ref["sha256"]:
                raise Failure("INCOMPLETE_ARTIFACT", 422)
            partial.replace(target)
        finally:
            resp.close()
            resp.release_conn()
            partial.unlink(missing_ok=True)


def default_objects():
    from minio import Minio
    return Objects(Minio(os.environ.get("MINIO_ENDPOINT", "minio:9000"),
                         access_key=os.environ.get("MINIO_ACCESS_KEY", ""), secret_key=os.environ.get("MINIO_SECRET_KEY", ""),
                         secure=os.environ.get("MINIO_SECURE", "false") == "true"), os.environ.get("MINIO_BUCKET", "flow-media"))


def segment_parts(objects, scope, job, segments, max_bytes=256 * 1024):
    refs, parts, batch = [], [], []
    def flush():
        nonlocal batch
        if not batch:
            return
        ref = objects.put(scope, job, canonical({"segments": batch}), "segments.json")
        refs.append(ref)
        starts = [s["start_ms"] for s in batch if s.get("start_ms") is not None]
        ends = [s["end_ms"] for s in batch if s.get("end_ms") is not None]
        parts.append({**ref, "segment_count": len(batch), "start_ms": min(starts) if starts else None, "end_ms": max(ends) if ends else None})
        batch = []
    for seg in segments:
        if len(canonical({"segments": [seg]})) > max_bytes:
            raise Failure("SEGMENT_TOO_LARGE", 413)
        if len(canonical({"segments": batch + [seg]})) > max_bytes:
            flush()
        batch.append(seg)
    flush()
    return refs, parts
