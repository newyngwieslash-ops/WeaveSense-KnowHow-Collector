"""ASR worker for WeaveSense-Flow (PRD §6.4 media_fetch→extract, compose profile "asr").

POST /v1/asr  {"object_key", "tenant_id", "workspace_id", "language"?}  (Bearer ASR_SERVICE_TOKEN)
  -> 200 {"object_key", "text", "seconds", "language", "segments", "sha256", "engine"}

Same isolation rules as the OCR worker: the object must live under
tenants/<tenant>/workspaces/<workspace>/ of the caller's scope (§10.4), is read from
the private bucket with the worker's own credentials and size-capped. Only audio/video
containers are accepted (415 "unsupported" otherwise). Speech recognition runs locally
with faster-whisper (CPU int8); the model must be mounted at ASR_MODEL_DIR with
an explicit revision/hash lock. No implicit model download is permitted.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import io
from importlib.metadata import version
import os
from pathlib import Path
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("ASR_SERVICE_TOKEN", "")
BUCKET = os.environ.get("MINIO_BUCKET", "flow-media")
MAX_BYTES = int(os.environ.get("ASR_MAX_BYTES", str(200 * 1024 * 1024)))
MAX_SECONDS = int(os.environ.get("ASR_MAX_SECONDS", str(3 * 3600)))
MODEL = os.environ.get("ASR_MODEL", "operator-pinned")
SCOPE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
KEY = re.compile(r"tenants/([A-Za-z0-9_-]{1,64})/workspaces/([A-Za-z0-9_-]{1,64})/[A-Za-z0-9_./-]{1,300}")
LANG = re.compile(r"[a-z]{2}(-[A-Za-z]{2,4})?")
PART_BYTES = 256 * 1024
INLINE_BYTES = 1024 * 1024


class AsrError(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code, self.status = code, status


def is_media(data: bytes) -> bool:
    """Audio/video container magic: MP3 (ID3 / frame sync), Ogg, WAV, FLAC, MP4/M4A (ftyp), WebM/Matroska, AAC ADTS."""
    if data.startswith((b"ID3", b"OggS", b"fLaC", b"\x1a\x45\xdf\xa3")):
        return True
    if data[:4] == b"RIFF" and data[8:12] in (b"WAVE", b"AVI "):
        return True
    if data[4:8] == b"ftyp":
        return True
    return len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0  # MPEG audio / ADTS frame sync


def default_store():
    from minio import Minio  # lazy: tests do not need the SDK

    return Minio(os.environ.get("MINIO_ENDPOINT", "minio:9000"), access_key=os.environ.get("MINIO_ACCESS_KEY", ""),
                 secret_key=os.environ.get("MINIO_SECRET_KEY", ""), secure=os.environ.get("MINIO_SECURE", "false") == "true")


def read_object(store, key: str) -> bytes:
    try:
        resp = store.get_object(BUCKET, key)
    except Exception as exc:
        raise AsrError("not_found", 404) from exc
    try:
        data = resp.read(MAX_BYTES + 1)
    finally:
        resp.close()
        resp.release_conn()
    if len(data) > MAX_BYTES:
        raise AsrError("too_large", 413)
    return data


_model = {}


def verified_model_directory():
    """Validate an operator-controlled offline model mount before loading code/data."""
    try:
        directory = Path(os.environ["ASR_MODEL_DIR"]).resolve(strict=True)
        lock = json.loads(Path(os.environ.get("ASR_MODEL_MANIFEST", str(directory / "model-lock.json"))).read_text())
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", lock["repository"]) or not re.fullmatch(r"[a-f0-9]{40}", lock["revision"]):
            raise ValueError()
        files = {item["name"]: item for item in lock["files"]}
        if not {"model.bin", "config.json", "tokenizer.json", "vocabulary.txt"} <= files.keys():
            raise ValueError()
        # faster-whisper optionally loads this preprocessing configuration. An
        # unlisted file must not silently alter the locked inference behavior.
        if (directory / "preprocessor_config.json").exists() and "preprocessor_config.json" not in files:
            raise ValueError()
        for name, item in files.items():
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in (".", "..") or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                raise ValueError()
            path = directory / name
            if path.is_symlink() or not path.is_file() or path.stat().st_size != item["bytes"]:
                raise ValueError()
            with path.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                    raise ValueError()
        return directory, lock
    except (OSError, ValueError, KeyError, TypeError):
        raise AsrError("model_lock_invalid", 503) from None


def run_whisper(data: bytes, language: str | None):
    """Returns (text, seconds, language, segments) using faster-whisper on CPU."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise AsrError("unavailable", 503) from exc
    if "m" not in _model:
        directory, lock = verified_model_directory()
        _model["m"] = WhisperModel(str(directory), device="cpu", compute_type="int8", local_files_only=True)
        _model["lock"] = {"repository": lock["repository"], "revision": lock["revision"], "model_sha256": next(f["sha256"] for f in lock["files"] if f["name"] == "model.bin")}
    with tempfile.NamedTemporaryFile(suffix=".media") as f:
        f.write(data)
        f.flush()
        try:
            segs, info = _model["m"].transcribe(f.name, language=language, vad_filter=True)
            if info.duration > MAX_SECONDS:
                raise AsrError("too_long", 413)
            out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
        except AsrError:
            raise
        except Exception as exc:
            raise AsrError("unsupported", 415) from exc
    return " ".join(s["text"] for s in out).strip(), int(round(info.duration)), info.language, out


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def write_parts(store, body, segments):
    """Bounded objects, never a sliced transcript masquerading as a complete one."""
    parts, batch, size = [], [], 16
    prefix = body["object_key"].rsplit("/", 1)[0] + "/asr-parts/"
    video = re.fullmatch(r"(tenants/[^/]+/workspaces/[^/]+/video/[A-Za-z0-9_-]{1,100})/[a-f0-9]{64}/[A-Za-z0-9_.-]+", body["object_key"])
    def flush():
        nonlocal batch, size
        if not batch:
            return
        raw = json_bytes({"segments": batch})
        digest = hashlib.sha256(raw).hexdigest()
        key = video[1] + "/" + digest + "/asr-part.json" if video else prefix + digest + ".json"
        try:
            store.put_object(BUCKET, key, io.BytesIO(raw), len(raw), content_type="application/json")
        except Exception as exc:
            raise AsrError("storage_error", 503) from exc
        parts.append({"object_key": key, "sha256": digest, "bytes": len(raw), "segment_count": len(batch)})
        batch, size = [], 16
    for segment in segments:
        encoded = json_bytes(segment)
        if len(encoded) > PART_BYTES:
            # A single huge model segment is refused, not silently split with invented times.
            raise AsrError("segment_too_large", 413)
        if size + len(encoded) + 1 > PART_BYTES:
            flush()
        batch.append(segment)
        size += len(encoded) + 1
    flush()
    return parts


def asr_part(body, store):
    if not isinstance(body, dict) or set(body) != {"object_key", "tenant_id", "workspace_id"}:
        raise AsrError("invalid_request", 400)
    if not all(isinstance(v, str) for v in body.values()):
        raise AsrError("invalid_request", 400)
    m = KEY.fullmatch(body["object_key"])
    video = re.fullmatch(r"tenants/[^/]+/workspaces/[^/]+/video/[A-Za-z0-9_-]{1,100}/([a-f0-9]{64})/asr-part.json", body["object_key"])
    if not m or ".." in body["object_key"] or m.groups() != (body["tenant_id"], body["workspace_id"]) or (not video and "/asr-parts/" not in body["object_key"]):
        raise AsrError("forbidden", 403)
    raw = read_object(store, body["object_key"])
    expected = video[1] if video else body["object_key"].rsplit("/", 1)[-1].removesuffix(".json")
    if len(raw) > PART_BYTES + 32 or hashlib.sha256(raw).hexdigest() != expected:
        raise AsrError("invalid_artifact", 422)
    return json.loads(raw)


def asr(body, store, runner=run_whisper) -> dict:
    if not isinstance(body, dict) or not {"object_key", "tenant_id", "workspace_id"} <= set(body) or set(body) - {"object_key", "tenant_id", "workspace_id", "language", "output_format"}:
        raise AsrError("invalid_request", 400)
    if not all(isinstance(v, str) for v in body.values()):
        raise AsrError("invalid_request", 400)
    if not SCOPE_ID.fullmatch(body["tenant_id"]) or not SCOPE_ID.fullmatch(body["workspace_id"]):
        raise AsrError("invalid_request", 400)
    if body.get("output_format", "inline") not in ("inline", "manifest"):
        raise AsrError("invalid_request", 400)
    lang = body.get("language") or None
    if lang is not None and not LANG.fullmatch(lang):
        raise AsrError("invalid_request", 400)
    m = KEY.fullmatch(body["object_key"])
    if not m or ".." in body["object_key"] or m.group(1) != body["tenant_id"] or m.group(2) != body["workspace_id"]:
        raise AsrError("forbidden", 403)
    data = read_object(store, body["object_key"])
    if not is_media(data):
        raise AsrError("unsupported", 415)
    text, seconds, detected, segments = runner(data, lang.split("-")[0] if lang else None)
    result = {"object_key": body["object_key"], "text": text, "seconds": max(0, int(seconds)), "language": detected or lang or "",
              "segments": segments, "sha256": hashlib.sha256(data).hexdigest(), "engine": f"faster-whisper:{MODEL}",
              "complete": True, "segment_count": len(segments), "status": "ok" if text.strip() else "no_speech"}
    if runner is run_whisper and "lock" in _model:
        result["model_lock"] = _model["lock"]
        result["engine"] = "faster-whisper:" + version("faster-whisper")
    if body.get("output_format") == "manifest":
        # Text is reconstructed from the identical canonical segment sequence by clients.
        canonical = " ".join(s["text"] for s in segments).strip()
        if canonical != text:
            raise AsrError("invalid_transcript", 422)
        parts = write_parts(store, body, segments)
        result.pop("text")
        result.pop("segments")
        result.update({"output_format": "manifest", "parts": parts, "text_sha256": hashlib.sha256(canonical.encode()).hexdigest()})
    elif len(json_bytes(result)) > INLINE_BYTES:
        raise AsrError("output_requires_manifest", 413)
    return result


def make_handler(store_factory=default_store, runner=run_whisper, token: str | None = None):
    state: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: dict):
            raw = json_bytes(payload)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):  # object keys are tenant data
            pass

        def do_GET(self):
            self._send(200, {"ok": True}) if self.path == "/healthz" else self._send(404, {"error": "not_found"})

        def do_POST(self):
            tok = TOKEN if token is None else token
            if self.path not in ("/v1/asr", "/v1/asr/parts"):
                return self._send(404, {"error": "not_found"})
            if not tok:
                return self._send(503, {"error": "unavailable"})
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {tok}".encode()):
                return self._send(401, {"error": "unauthorized"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(min(length, 8192)) or b"null") if 0 < length <= 8192 else None
                if "store" not in state:
                    state["store"] = store_factory()
                self._send(200, asr_part(body, state["store"]) if self.path == "/v1/asr/parts" else asr(body, state["store"], runner))
            except AsrError as exc:
                self._send(exc.status, {"error": exc.code})
            except (ValueError, json.JSONDecodeError):
                self._send(400, {"error": "invalid_request"})

    return Handler


if __name__ == "__main__":
    port = int(os.environ.get("ASR_PORT", "8797"))
    ThreadingHTTPServer(("0.0.0.0", port), make_handler()).serve_forever()
