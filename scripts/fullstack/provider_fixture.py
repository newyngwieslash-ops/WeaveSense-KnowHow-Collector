"""Isolated TEST-only model upstream; never a host API or business-state stub.

This deterministic boundary is not an LLM, industry validation, or real platform
evidence. Go still owns authentication, model admission, accounting and receipts;
Loom still validates evidence, creates candidates and enforces review/publish.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "fullstack-synthetic"
MARKER = "Synthetic fixture:"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def knowledge_response(request):
    """Copy only the submitted fixture quote and its immutable references."""
    if not isinstance(request, dict) or request.get("model") != MODEL or request.get("stream") is True:
        raise ValueError("unsupported_fixture_request")
    messages = request.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        raise ValueError("invalid_fixture_messages")
    system, user = messages
    if not isinstance(system, dict) or not isinstance(user, dict) or system.get("role") != "system" or not isinstance(system.get("content"), str) or "video-knowledge-core" not in system["content"] or user.get("role") != "user":
        raise ValueError("not_knowledge_extraction")
    frozen = json.loads(user["content"])
    if not isinstance(frozen, dict) or not isinstance(frozen.get("profile_id"), str) or type(frozen.get("profile_version")) is not int:
        raise ValueError("invalid_fixture_profile")
    evidence = frozen.get("evidence")
    if not isinstance(evidence, list) or not evidence or len(evidence) > 100:
        raise ValueError("invalid_fixture_evidence")
    first = evidence[0]
    if not isinstance(first, dict) or not isinstance(first.get("quote"), str) or not first["quote"].startswith(MARKER):
        raise ValueError("non_fixture_material_rejected")
    if not isinstance(first.get("evidence_id"), str) or type(first.get("revision")) is not int or first["revision"] < 1 or not isinstance(first.get("snippet_hash"), str) or not re.fullmatch(r"[a-f0-9]{64}", first["snippet_hash"]):
        raise ValueError("invalid_fixture_evidence_identity")
    unit = {
        "type": "fact", "title": "Synthetic acceptance knowledge",
        "domain_tags": ["synthetic-test-only"], "statement": first["quote"],
        "claim_kind": "source_statement", "applicability": [], "conditions": [],
        "steps": [], "parameters": [], "boundaries": ["Synthetic test; not industry guidance"],
        "counterexamples": [], "missing_fields": ["real_industry_validation"],
        "evidence": [{k: first[k] for k in ("evidence_id", "revision", "snippet_hash")}],
        "valid_from": None, "valid_until": None, "conflict_key": None,
    }
    output = {"profile_id": frozen["profile_id"], "profile_version": frozen["profile_version"],
              "relevance": "relevant", "knowledge_units": [unit],
              "missing_information": ["real_industry_validation"],
              "coverage_limitations": ["Deterministic TEST model boundary; not actual model quality evidence"]}
    # Valid nonzero usage is deliberate: the real host must price/settle it.
    return {"id": "fixture_" + hashlib.sha256(canonical(request)).hexdigest()[:24],
            "object": "chat.completion", "model": MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": canonical(output).decode()}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}}


def make_handler(token):
    if not isinstance(token, str) or len(token) < 24:
        raise ValueError("ephemeral_fixture_token_required")
    lock = threading.Lock()
    calls = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log headers, material or temporary credentials.

        def send(self, status, value):
            raw = canonical(value)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode())

        def do_GET(self):
            if self.path == "/healthz":
                return self.send(200, {"ok": True, "synthetic_model_boundary": True, "model": MODEL})
            if self.path == "/__fixture/evidence":
                if not self.authorized():
                    return self.send(401, {"error": "fixture_auth_required"})
                with lock:
                    records = [dict(value) for value in calls.values()]
                return self.send(200, {"synthetic_model_boundary": True, "real_model_quality_verified": False,
                                       "unique_model_calls": len(records), "calls": records})
            self.send(404, {"error": "fixture_not_found"})

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                return self.send(404, {"error": "fixture_not_found"})
            if not self.authorized():
                return self.send(401, {"error": "fixture_auth_required"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.headers.get("Transfer-Encoding") or not 0 < length <= 1024 * 1024:
                    raise ValueError("invalid_fixture_size")
                request = json.loads(self.rfile.read(length))
                response = knowledge_response(request)
                call_id = self.headers.get("X-Flow-Call-Id", "")
                if not call_id or not self.headers.get("X-Flow-Reservation-Id") or not self.headers.get("X-Flow-Price-Version"):
                    raise ValueError("host_accounting_headers_required")
                digest = hashlib.sha256(canonical(request)).hexdigest()
                with lock:
                    previous = calls.get(call_id)
                    if previous and previous["request_sha256"] != digest:
                        return self.send(409, {"error": "fixture_call_identity_conflict"})
                    calls[call_id] = {"call_id": call_id, "request_sha256": digest,
                                      "response_sha256": hashlib.sha256(canonical(response)).hexdigest(),
                                      "requests": (previous or {}).get("requests", 0) + 1,
                                      "synthetic": True, "total_tokens": 150}
                return self.send(200, response)
            except (ValueError, KeyError, TypeError, UnicodeError):
                return self.send(400, {"error": "invalid_or_non_fixture_model_request"})

    return Handler


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("FIXTURE_PORT", "8800"))),
                        make_handler(os.environ.get("FLOW_MODEL_GATEWAY_KEY", ""))).serve_forever()
