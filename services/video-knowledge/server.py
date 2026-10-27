"""Internal video execution service. Business authorization is delegated by Loom."""
from __future__ import annotations

import base64
import hmac
import hashlib
import json
import os
import threading
import time
import tempfile
from pathlib import Path
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from core import Failure, HASH, InternalClient, canonical, default_objects, scope_key, sha, verify_context, disk_guard
from dtk import CAPABILITIES, DTK, CredentialRoutes
from media import Processor, normalize_subtitles, probe
from runtime import Executor, Tasks
from synthesis import Gateway


def asr_adapter(client, objects=None):
    def recognize(ref, scope, language):
        request = {"object_key": ref["object_key"], "tenant_id": scope["tenant_id"], "workspace_id": scope["workspace_id"], "output_format": "manifest"}
        if language:
            request["language"] = language
        value = client.json("POST", "/v1/asr", request)
        if value.get("object_key") != ref["object_key"] or value.get("sha256") != ref["sha256"] or value.get("complete") is not True or not isinstance(value.get("parts"), list):
            raise Failure("ASR_CONTRACT_CHANGED", 502)
        segments = []
        for part in value["parts"]:
            key = part.get("object_key", "")
            job = scope_key(ref["object_key"], scope)[3]
            match = scope_key(key, scope, job)
            if match[4] != part.get("sha256") or match[5] != "asr-part.json":
                raise Failure("SCOPE_DENIED", 403)
            payload = client.json("POST", "/v1/asr/parts", {"object_key": key, "tenant_id": scope["tenant_id"], "workspace_id": scope["workspace_id"]})
            if len(canonical(payload)) != part.get("bytes") or sha(canonical(payload)) != part["sha256"] or len(payload.get("segments", [])) != part["segment_count"]:
                raise Failure("INCOMPLETE_ARTIFACT")
            if objects:
                objects.record({k: part[k] for k in ("object_key", "sha256", "bytes")} | {"content_type": "application/json"})
            segments.extend(payload["segments"])
        text = " ".join(s["text"] for s in segments).strip()
        if len(segments) != value.get("segment_count") or sha(text.encode()) != value.get("text_sha256"):
            raise Failure("INCOMPLETE_ARTIFACT")
        return {**value, "segments": segments, "text": text}
    return recognize


def ocr_adapter(client):
    def recognize(ref, scope):
        value = client.json("POST", "/v1/ocr", {"object_key": ref["object_key"], "tenant_id": scope["tenant_id"], "workspace_id": scope["workspace_id"]})
        if value.get("object_key") != ref["object_key"] or value.get("sha256") != ref["sha256"] or not isinstance(value.get("text"), str):
            raise Failure("OCR_CONTRACT_CHANGED", 502)
        return value
    return recognize


def handler(tasks, executor, objects, provider, token, signing_key):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, value):
            raw = canonical(value)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def context(self, permission, body=None, job=None):
            if not token or not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode()):
                raise Failure("AUTH_REQUIRED", 401)
            signed = self.headers.get("X-Flow-Execution-Context", "")
            try:
                piece = signed.split(".")[1]
                claims = json.loads(base64.urlsafe_b64decode(piece + "=" * (-len(piece) % 4)))
            except (IndexError, ValueError):
                raise Failure("AUTH_REQUIRED", 401) from None
            scope = body or {"tenant_id": claims.get("tenant_id"), "workspace_id": claims.get("workspace_id")}
            return verify_context(signed, signing_key, scope, permission, job)

        def body(self):
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2 * 1024 * 1024:
                raise Failure("INVALID_REQUEST", 400)
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise Failure("INVALID_REQUEST", 400)
            return value

        def do_POST(self):
            try:
                body = self.body()
                if self.path == "/v1/discover":
                    self.context("video.discover", body)
                    if not provider:
                        raise Failure("PROVIDER_NOT_CONFIGURED", 503)
                    return self.send(200, provider.discover(body))
                if self.path == "/v1/objects/delete":
                    claims = self.context("video.delete", job=body.get("video_job_id"))
                    tasks.assert_cleanup_allowed(claims, body["video_job_id"])
                    with tasks.db() as db:
                        pending = db.execute("SELECT ref FROM artifact_inventory WHERE object_key=? AND state IN ('write_pending','uploading')", (body["object_key"],)).fetchone()
                    if pending:
                        # A missing key after a lost write acknowledgement does
                        # not prove the remote store cannot commit it later.
                        ref = json.loads(pending[0])
                        try:
                            with tasks.temporary(claims, body["video_job_id"], executor.temp_root) as directory:
                                objects.materialize(ref, claims, body["video_job_id"], directory / "verify-before-delete", int(os.environ.get("VIDEO_MAX_BYTES", str(2 * 1024 * 1024 * 1024))))
                        except Failure as exc:
                            if exc.status == 404:
                                raise Failure("OBJECT_WRITE_OUTCOME_UNKNOWN", 409) from None
                            raise
                    receipt = objects.delete(body["object_key"], body["sha256"], claims, body["video_job_id"])
                    with tasks.db() as db:
                        db.execute("UPDATE artifact_inventory SET state='deleted',lease_until=0,updated_at=? WHERE object_key=?", (time.time(), body["object_key"]))
                    return self.send(200, receipt)
                if self.path == "/v1/jobs/cleanup":
                    claims = self.context("video.delete", job=body.get("video_job_id"))
                    return self.send(200, tasks.sweep_temporary(claims, body["video_job_id"], body["temp_before"]))
                if self.path == "/v1/jobs/erase":
                    claims = self.context("video.delete", job=body.get("video_job_id"))
                    return self.send(200, tasks.erase(claims, body["video_job_id"]))
                if self.path == "/v1/jobs":
                    claims = self.context("video.execute", body, body.get("video_job_id"))
                    if any(claims.get(k) != body.get(k) for k in ("stage_attempt", "fencing_token")):
                        raise Failure("STALE_FENCE", 409)
                    return self.send(202, tasks.submit(body, claims["exp"]))
                if self.path.startswith("/v1/jobs/") and self.path.endswith("/cancel"):
                    claims = self.context("video.cancel", job=body.get("video_job_id"))
                    task = self.path.split("/")[3]
                    spec = tasks.execution_spec(task, {**claims, "video_job_id": body["video_job_id"]})
                    checkpoint = tasks.cancel(task, {**claims, "video_job_id": body["video_job_id"]})
                    selected = provider.bind(spec) if provider and hasattr(provider, "bind") else provider
                    if selected and checkpoint.get("provider_route_id") and checkpoint["provider_route_id"] != getattr(selected, "route_id", None):
                        raise Failure("PROVIDER_ROUTE_CHANGED", 409)
                    remote = selected.cancel(checkpoint["external_download_id"]) if selected and checkpoint.get("external_download_id") else {"status": "unsupported"}
                    return self.send(200, {"status": remote["status"], "host_execution": "cancelled"})
                if self.path.startswith("/v1/jobs/") and self.path.endswith("/retry"):
                    claims = self.context("video.execute", job=body.get("video_job_id"))
                    envelope = {k: claims.get(k) for k in ("stage_attempt", "fencing_token")}
                    if any(type(v) is not int or v < 1 for v in envelope.values()):
                        raise Failure("STALE_FENCE", 409)
                    return self.send(202, tasks.retry(self.path.split("/")[3], {**claims, "video_job_id": body["video_job_id"]}, claims["exp"], envelope))
                raise Failure("NOT_FOUND", 404)
            except Failure as exc:
                self.send(exc.status, {"error": exc.payload()})
            except (ValueError, KeyError, TypeError):
                self.send(400, {"error": {"code": "INVALID_REQUEST", "retryable": False}})

        def do_PUT(self):
            upload_ref, write_started = None, False
            try:
                url = urlsplit(self.path)
                if url.path != "/v1/inputs":
                    raise Failure("NOT_FOUND", 404)
                query = parse_qs(url.query, strict_parsing=True)
                if any(len(v) != 1 for v in query.values()) or self.headers.get("Transfer-Encoding"):
                    raise Failure("INVALID_REQUEST", 400)
                job, digest = query["video_job_id"][0], query["sha256"][0]
                claims = self.context("video.upload", job=job)
                length, mime = int(query["bytes"][0]), query["content_type"][0]
                kind = query.get("input_kind", ["media"])[0]
                suffix = {"application/json": "json", "video/mp4": "mp4", "audio/wav": "wav", "audio/mpeg": "mp3"}.get(mime)
                maximum = 8 * 1024 * 1024 if kind == "platform_subtitles" else int(os.environ.get("VIDEO_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))
                if not suffix or not HASH.fullmatch(digest) or not 0 < length <= maximum or int(self.headers.get("Content-Length", "0")) != length or (mime == "application/json") != (kind == "platform_subtitles") or kind not in ("media", "platform_subtitles"):
                    raise Failure("INVALID_INPUT_DESCRIPTOR", 400)
                key = f"tenants/{claims['tenant_id']}/workspaces/{claims['workspace_id']}/video/{job}/{digest}/input.{suffix}"
                ref = {"object_key": key, "sha256": digest, "bytes": length, "content_type": mime}
                # Record the exact destination before any object-store write. An
                # accepted write with a lost reply remains discoverable for cleanup.
                tasks.inventory_put(claims, job, ref, "uploading", claims["exp"])
                upload_ref = ref
                with tasks.temporary(claims, job, executor.temp_root) as directory:
                    disk_guard(directory, length)
                    path, size, hasher = directory / ("input." + suffix), 0, hashlib.sha256()
                    self.connection.settimeout(30)
                    with path.open("wb") as out:
                        while size < length:
                            if time.time() >= claims["exp"]:
                                raise Failure("EXECUTION_AUTHORIZATION_LOST", 409)
                            block = self.rfile.read(min(1024 * 1024, length - size))
                            if not block:
                                raise Failure("INCOMPLETE_ARTIFACT")
                            disk_guard(directory, len(block))
                            size += len(block)
                            hasher.update(block)
                            out.write(block)
                    if hasher.hexdigest() != digest:
                        raise Failure("INPUT_HASH_MISMATCH")
                    if kind == "platform_subtitles":
                        normalize_subtitles(json.loads(path.read_bytes()))
                    else:
                        with path.open("rb") as stream:
                            head = stream.read(16)
                        if (mime == "video/mp4" and head[4:8] != b"ftyp") or (mime == "audio/wav" and not (head[:4] == b"RIFF" and head[8:12] == b"WAVE")) or (mime == "audio/mpeg" and not (head.startswith(b"ID3") or head[0] == 255 and head[1] & 224 == 224)):
                            raise Failure("INPUT_MIME_MISMATCH", 415)
                        probe(path, 43200)
                    if time.time() >= claims["exp"]:
                        raise Failure("EXECUTION_AUTHORIZATION_LOST", 409)
                    def intent(value):
                        nonlocal write_started
                        tasks.inventory_put(claims, job, value, "write_pending", claims["exp"])
                        write_started = True
                    with objects.journal(lambda value: tasks.inventory_put(claims, job, value), intent):
                        ref = objects.put_file(claims, job, path, "input." + suffix, mime, maximum)
                return self.send(201, ref)
            except Failure as exc:
                if upload_ref and not write_started:
                    tasks.inventory_put(claims, job, upload_ref, "not_written")
                self.send(exc.status, {"error": exc.payload()})
            except (ValueError, KeyError, TypeError, IndexError, TimeoutError):
                if upload_ref and not write_started:
                    tasks.inventory_put(claims, job, upload_ref, "not_written")
                self.send(400, {"error": {"code": "INVALID_REQUEST", "retryable": False}})

        def do_GET(self):
            try:
                url = urlsplit(self.path)
                if url.path == "/healthz":
                    return self.send(200, {"ok": True, "schema_version": 1, "provider_configured": provider is not None})
                query = parse_qs(url.query, strict_parsing=True)
                job = query.get("video_job_id", [None])[0]
                if url.path == "/v1/objects":
                    key = query.get("key", [""])[0]
                    claims = self.context("video.read", job=job)
                    match = scope_key(key, claims, claims.get("job_id"))
                    ref = tasks.inventory(claims, match[3], key)
                    # Spool and verify before streaming: large input verification must
                    # not require a whole media object in worker or Loom memory.
                    response = objects.open(key)
                    try:
                        disk_guard(executor.temp_root or tempfile.gettempdir(), ref["bytes"])
                        with tempfile.TemporaryFile(dir=executor.temp_root) as spool:
                            size, digest = 0, hashlib.sha256()
                            while block := response.read(1024 * 1024):
                                size += len(block)
                                if size > int(os.environ.get("VIDEO_MAX_BYTES", str(2 * 1024 * 1024 * 1024))):
                                    raise Failure("OBJECT_TOO_LARGE", 413)
                                disk_guard(executor.temp_root or tempfile.gettempdir(), len(block))
                                digest.update(block)
                                spool.write(block)
                            if digest.hexdigest() != match[4] or size != ref["bytes"]:
                                raise Failure("INCOMPLETE_ARTIFACT")
                            start, end = 0, size - 1
                            range_header = self.headers.get("Range")
                            if range_header:
                                requested = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
                                if not requested or not any(requested.groups()):
                                    raise Failure("INVALID_RANGE", 416)
                                start = int(requested[1]) if requested[1] else max(0, size - int(requested[2]))
                                end = min(size - 1, int(requested[2])) if requested[1] and requested[2] else size - 1
                                if start > end or start >= size:
                                    raise Failure("INVALID_RANGE", 416)
                            self.send_response(206 if range_header else 200)
                            self.send_header("Content-Type", ref["content_type"])
                            self.send_header("Content-Length", str(end - start + 1))
                            self.send_header("Accept-Ranges", "bytes")
                            self.send_header("ETag", '"' + ref["sha256"] + '"')
                            self.send_header("X-Content-Type-Options", "nosniff")
                            if range_header:
                                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                            self.end_headers()
                            spool.seek(start)
                            remaining = end - start + 1
                            while remaining and (block := spool.read(min(1024 * 1024, remaining))):
                                self.wfile.write(block)
                                remaining -= len(block)
                            return
                    finally:
                        response.close()
                        response.release_conn()
                claims = self.context("video.read", job=job)
                scope = {**claims, "video_job_id": job or claims.get("job_id")}
                if not scope["video_job_id"]:
                    raise Failure("SCOPE_DENIED", 403)
                if url.path == "/v1/inputs":
                    digest = query.get("sha256", [""])[0]
                    if not HASH.fullmatch(digest):
                        raise Failure("INVALID_INPUT_DESCRIPTOR", 400)
                    with tasks.db() as db:
                        rows = db.execute("SELECT ref,state FROM artifact_inventory WHERE tenant=? AND workspace=? AND job=? AND object_key LIKE ? AND state!='deleted'", (claims["tenant_id"], claims["workspace_id"], scope["video_job_id"], '%/' + digest + '/input.%')).fetchall()
                    if len(rows) != 1:
                        raise Failure("NOT_FOUND", 404)
                    ref = json.loads(rows[0][0])
                    if rows[0][1] != "stored":
                        # Lost object-store acknowledgement: prove exact bytes,
                        # never turn an upload intent alone into a completion.
                        with tasks.temporary(claims, scope["video_job_id"], executor.temp_root) as directory:
                            path = directory / "reconciled-input"
                            objects.materialize(ref, claims, scope["video_job_id"], path, int(os.environ.get("VIDEO_MAX_BYTES", str(2 * 1024 * 1024 * 1024))))
                            if ref["content_type"] == "application/json":
                                if ref["bytes"] > 8 * 1024 * 1024:
                                    raise Failure("LIMIT_EXCEEDED", 413)
                                normalize_subtitles(json.loads(path.read_bytes()))
                            else:
                                probe(path, 43200)
                            tasks.inventory_put(claims, scope["video_job_id"], ref)
                    return self.send(200, ref)
                if url.path == "/v1/jobs/inventory":
                    return self.send(200, tasks.inventory(claims, scope["video_job_id"], cursor=query.get("cursor", ["0"])[0]))
                if url.path == "/v1/jobs/reconcile":
                    return self.send(200, tasks.reconcile(scope, query.get("intent_key", [""])[0]))
                if url.path.startswith("/v1/jobs/") and url.path.endswith("/artifacts"):
                    return self.send(200, tasks.artifacts(url.path.split("/")[3], scope, query.get("cursor", ["0"])[0]))
                if url.path.startswith("/v1/jobs/"):
                    envelope = None
                    if "stage_attempt" in query and "fencing_token" in query:
                        envelope = {k: int(query[k][0]) for k in ("stage_attempt", "fencing_token")}
                        if any(value < 1 for value in envelope.values()) or any(claims.get(k) != value for k, value in envelope.items()):
                            raise Failure("STALE_FENCE", 409)
                    return self.send(200, tasks.read(url.path.split("/")[3], scope, claims["exp"], envelope))
                raise Failure("NOT_FOUND", 404)
            except Failure as exc:
                self.send(exc.status, {"error": exc.payload()})
            except (ValueError, KeyError, TypeError):
                self.send(400, {"error": {"code": "INVALID_REQUEST", "retryable": False}})
    return Handler


def configured_client(prefix):
    if os.environ.get(prefix + "_ENABLED") != "true":
        return None
    return InternalClient(os.environ[prefix + "_URL"], os.environ[prefix + "_SERVICE_TOKEN"])


def main():
    objects = default_objects()
    tasks = Tasks(os.environ.get("VIDEO_EXECUTION_DB", "/data/executions.sqlite3"))
    asr, ocr = configured_client("ASR"), configured_client("OCR")
    provider = None
    if os.environ.get("DTK_ENABLED") == "true":
        default = DTK(os.environ["DTK_URL"], os.environ["DTK_SERVICE_TOKEN"], allowed_scopes={(os.environ.get("DTK_TENANT_ID", ""), os.environ.get("DTK_WORKSPACE_ID", ""))}) if os.environ.get("DTK_URL") and os.environ.get("DTK_SERVICE_TOKEN") else None
        provider = CredentialRoutes(default, os.environ.get("DTK_CREDENTIAL_ROUTES_FILE"))
    gateway = Gateway(os.environ["FLOW_PLATFORM_URL"], os.environ["FLOW_INTERNAL_JWT_SIGNING_KEY"]) if os.environ.get("VIDEO_MODEL_ENABLED") == "true" else None
    meter = Gateway(os.environ["FLOW_PLATFORM_URL"], os.environ["FLOW_INTERNAL_JWT_SIGNING_KEY"]) if asr or ocr else None
    processor = Processor(objects, asr_adapter(asr, objects) if asr else None, ocr_adapter(ocr) if ocr else None, gateway, meter)
    executor = Executor(tasks, objects, processor, provider, os.environ.get("VIDEO_TEMP_ROOT") or None)
    def work():
        while True:
            if not executor.run_once():
                time.sleep(1)
    threading.Thread(target=work, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("VIDEO_PORT", "8799"))), handler(tasks, executor, objects, provider, os.environ.get("VIDEO_SERVICE_TOKEN", ""), os.environ.get("FLOW_INTERNAL_JWT_SIGNING_KEY", ""))).serve_forever()


if __name__ == "__main__":
    main()
