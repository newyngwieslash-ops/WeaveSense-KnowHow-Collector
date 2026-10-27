"""BiliNote-inspired bounded message organization via the host Model Gateway only."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid

from core import Failure, InternalClient, canonical, sha


def batches(items, max_bytes=32000, max_items=12):
    out, current = [], []
    for item in items:
        if len(canonical(item)) > max_bytes:
            raise Failure("SUMMARY_INPUT_TOO_LARGE", 413)
        if current and (len(current) >= max_items or len(canonical(current + [item])) > max_bytes):
            out.append(current)
            current = []
        current.append(item)
    if current:
        out.append(current)
    return out


class Gateway:
    def __init__(self, origin, signing_key, client=None, issuer="loom-engine"):
        self.key, self.issuer = signing_key, issuer
        if len(signing_key.encode()) < 32:
            raise Failure("MODEL_GATEWAY_NOT_CONFIGURED", 503)
        # The service route authenticates the short-lived host execution JWT.
        self.http = client or InternalClient(origin, "delegation-required")

    def token(self, body):
        now = int(time.time())
        claims = {"iss": self.issuer, "aud": "flow-platform", "iat": now, "exp": now + 60, "jti": "video_" + uuid.uuid4().hex,
                  "tenant_id": body["tenant_id"], "workspace_id": body["workspace_id"], "actor": {"type": "service_principal", "id": "loom-video-worker"},
                  "job_id": body["video_job_id"], "scopes": ["intel.video.model"], "policy_version": "video_v1"}
        encode = lambda x: base64.urlsafe_b64encode(canonical(x)).decode().rstrip("=")
        # Match the host's exact HS256 header serialization, not sorted canonical keys.
        header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip("=")
        unsigned = header + "." + encode(claims)
        return unsigned + "." + base64.urlsafe_b64encode(hmac.new(self.key.encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip("=")

    def call(self, body, method, path, payload=None):
        value = self.http.json(method, path, payload, headers={"Authorization": "Bearer " + self.token(body)})
        if value.get("code") != 0 or not isinstance(value.get("data"), dict):
            raise Failure("MODEL_GATEWAY_ERROR", 502)
        return value["data"]

    def model_task(self, body, purpose, payload, frames, checkpoint, save, active):
        active()
        model = body["profile"].get("model_id") or body["asset"].get("model_config", {}).get("model_id")
        budget = int(body["profile"].get("budget_micro", 0))
        if not model or budget <= 0:
            raise Failure("BUDGET_OR_MODEL_REQUIRED", 402)
        identity = sha(canonical({"purpose": purpose, "input": payload, "frames": frames, "model_id": model}))
        tasks = checkpoint.setdefault("model_tasks", {})
        saved = tasks.get(identity)
        if saved and saved.get("output") is not None:
            usage = checkpoint.setdefault("usage", {})
            usage["model_result_cache_hits"] = usage.get("model_result_cache_hits", 0) + 1
            return saved["output"]
        fence = {k: body[k] for k in ("stage_attempt", "fencing_token")}
        if not saved or not saved.get("task_id") or any(saved.get(k) != v for k, v in fence.items()):
            tasks[identity] = {"intent": True}
            save(checkpoint)
            try:
                result = self.call(body, "POST", "/api/internal/flow/video/model-tasks", {"key": identity, "purpose": purpose, "model_id": model,
                    "input": payload, "frames": frames, "budget_micro": budget, "max_tokens": min(int(body["profile"].get("max_tokens", 2048)), 16384),
                    "stage_attempt": body["stage_attempt"], "fencing_token": body["fencing_token"]})
            except Failure as exc:
                # Unlike DTK, this host endpoint has verified durable idempotency.
                # A later resume uses the identical key/payload to recover its ID.
                if exc.status in (400, 401, 402, 403, 409):
                    tasks.pop(identity, None)
                    save(checkpoint)
                    raise
                raise Failure("HOST_OUTCOME_PENDING", 202, True, 5) from None
            tasks[identity] = {"task_id": result.get("task_id"), **fence}
            save(checkpoint)
            saved = tasks[identity]
        if not saved.get("task_id"):
            raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409)
        result = self.call(body, "GET", "/api/internal/flow/video/model-tasks/" + saved["task_id"])
        status = result.get("status")
        if status in ("queued", "running", "pending", "retry_wait"):
            raise Failure("MODEL_PENDING", 202, True, 5)
        if status not in ("completed", "succeeded"):
            raise Failure("MODEL_FAILED", 502)
        output = result.get("output")
        if isinstance(output, str):
            try:
                output = json.loads(output)
            except ValueError:
                raise Failure("MODEL_INVALID_OUTPUT", 502) from None
        if not isinstance(output, dict):
            raise Failure("MODEL_INVALID_OUTPUT", 502)
        saved.update({"output": output, "usage_ref": result.get("usage_ref"), "cost_micro": result.get("cost_micro"), "model_config_hash": result.get("model_config_hash")})
        usage = checkpoint.setdefault("usage", {}).setdefault("model_tasks", [])
        if not any(t.get("task_id") == saved["task_id"] for t in usage):
            usage.append({k: saved.get(k) for k in ("task_id", "usage_ref", "cost_micro", "model_config_hash")})
        save(checkpoint)
        return output

    def local(self, body, usage_type, key, quantity, invoke, checkpoint, save, active):
        """Host-priced, durable admission around one bounded local compute quantum."""
        if usage_type not in ("asr_seconds", "ocr_pages") or type(quantity) is not int or quantity <= 0:
            raise Failure("INVALID_USAGE_QUANTITY", 400)
        active()
        identity = sha(canonical({"key": key, "usage_type": usage_type, "quantity": quantity}))
        receipts = checkpoint.setdefault("local_usage", {})
        saved = receipts.setdefault(identity, {"phase": "intent"})
        fence = {k: body[k] for k in ("stage_attempt", "fencing_token")}
        if not saved.get("admission_id") or any(saved.get(k) != v for k, v in fence.items()):
            save(checkpoint)
            try:
                admission = self.call(body, "POST", "/api/internal/flow/video/usage-admission", {"key": identity, "usage_type": usage_type, "quantity": quantity, **fence})
            except Failure as exc:
                if exc.retryable or exc.status >= 500:
                    raise Failure("HOST_OUTCOME_PENDING", 202, True, 5) from None
                raise
            if not isinstance(admission.get("admission_id"), str) or admission.get("quantity_limit", 0) < quantity or (saved.get("admission_id") and admission["admission_id"] != saved["admission_id"]):
                raise Failure("USAGE_CONTRACT_CHANGED", 502)
            if saved["phase"] in ("intent", "admitted"):
                saved["phase"] = "admitted" if admission.get("may_execute") is True and admission.get("status") == "reserved" else "unknown"
            elif saved["phase"] == "computed" and admission.get("status") == "settled" and admission.get("quantity") == quantity:
                saved.update(phase="settled", receipt=admission)
            saved.update(admission_id=admission["admission_id"], reservation_id=admission.get("reservation_id"), **fence)
            ids = checkpoint.setdefault("usage_receipts", [])
            if admission["admission_id"] not in ids:
                ids.append(admission["admission_id"])
            save(checkpoint)
        if saved["phase"] in ("processing", "unknown"):
            # A crash/timeout after the local call began is not permission to spend
            # the admission again. Keep its reservation until host reconciliation.
            try:
                self.call(body, "POST", "/api/internal/flow/video/usage-settle", {"admission_id": saved["admission_id"], "quantity": 0, "outcome": "unknown", **fence})
            except Failure:
                pass
            raise Failure("USAGE_OUTCOME_UNKNOWN", 409)
        if saved["phase"] == "admitted":
            active()
            saved["phase"] = "processing"
            save(checkpoint)
            try:
                result = invoke()
            except Exception:
                saved["phase"] = "unknown"
                save(checkpoint)
                try:
                    self.call(body, "POST", "/api/internal/flow/video/usage-settle", {"admission_id": saved["admission_id"], "quantity": 0, "outcome": "unknown", **fence})
                except Failure:
                    pass
                raise Failure("USAGE_OUTCOME_UNKNOWN", 409) from None
            saved.update(phase="computed", result=result)
            save(checkpoint)
        if saved["phase"] == "computed":
            active()
            fence = {k: body[k] for k in ("stage_attempt", "fencing_token")}
            try:
                settled = self.call(body, "POST", "/api/internal/flow/video/usage-settle", {"admission_id": saved["admission_id"], "quantity": quantity, "outcome": "completed", **fence})
            except Failure as exc:
                if exc.retryable or exc.status >= 500:
                    raise Failure("HOST_OUTCOME_PENDING", 202, True, 5) from None
                raise
            if settled.get("admission_id") != saved["admission_id"] or settled.get("status") != "settled" or settled.get("quantity") != quantity:
                raise Failure("USAGE_CONTRACT_CHANGED", 502)
            saved.update(phase="settled", receipt=settled)
            save(checkpoint)
        return saved["result"]

    def observe(self, body, frames, checkpoint, save, active):
        observations = []
        for group in batches(frames, max_items=12):
            refs = [{k: f[k] for k in ("frame_id", "object_key", "sha256", "timestamp_ms")} for f in group]
            output = self.model_task(body, "video_vision", {"task": "video_visual_observations", "prompt_version": "video-vision-v1", "frames": refs}, refs, checkpoint, save, active)
            if not isinstance(output.get("observations"), list):
                raise Failure("MODEL_INVALID_OUTPUT", 502)
            observations.extend(output["observations"])
        return observations

    def summarize(self, body, segments, frames, checkpoint, save, active):
        inputs = [{"input_id": "segment:" + str(index), "kind": "material", "segment": segment} for index, segment in enumerate(segments)]
        inputs += [{"input_id": "frame:" + frame["frame_id"], "kind": "frame", "frame": {k: frame[k] for k in ("frame_id", "object_key", "sha256", "timestamp_ms")}} for frame in frames]
        consumed, summaries = [], []
        for group in batches(inputs):
            refs = [item["frame"] for item in group if item["kind"] == "frame"]
            output = self.model_task(body, "video_summary", {"prompt_version": "video-summary-v1", "inputs": group, "output_kind": "derived_summary"}, refs, checkpoint, save, active)
            if not isinstance(output.get("summary"), str) or not isinstance(output.get("input_ids"), list) or set(output["input_ids"]) != {item["input_id"] for item in group}:
                raise Failure("SUMMARY_INCOMPLETE_CONSUMPTION", 502)
            consumed.extend(output["input_ids"])
            summaries.append({"summary": output["summary"], "input_ids": output["input_ids"], "kind": "derived_summary", "review_status": "unreviewed"})
        if set(consumed) != {item["input_id"] for item in inputs}:
            raise Failure("SUMMARY_INCOMPLETE_CONSUMPTION", 502)
        levels, current = [], summaries
        while len(current) > 1:
            next_level = []
            for group_index, group in enumerate(batches([{"input_id": f"summary:{len(levels)}:{i}", "summary": item["summary"]} for i, item in enumerate(current)])):
                output = self.model_task(body, "video_summary", {"prompt_version": "video-summary-reduce-v1", "inputs": group, "output_kind": "derived_summary"}, [], checkpoint, save, active)
                if not isinstance(output.get("summary"), str) or set(output.get("input_ids", [])) != {item["input_id"] for item in group}:
                    raise Failure("SUMMARY_INCOMPLETE_CONSUMPTION", 502)
                next_level.append({"summary": output["summary"], "input_ids": output["input_ids"], "kind": "derived_summary", "review_status": "unreviewed"})
            if len(next_level) >= len(current):
                raise Failure("SUMMARY_LIMIT_EXCEEDED", 413)
            levels.append(next_level)
            current = next_level
        return {"kind": "derived_summary", "review_status": "unreviewed", "summaries": summaries, "consumed_input_ids": consumed,
                "levels": levels, "summary": current[0]["summary"] if current else "", "input_manifest_sha256": body.get("input_manifest_sha256"), "config_sha256": sha(canonical(body["profile"]))}
