"""Contract tests for the explicitly synthetic upstream, not full-stack evidence."""
import copy
import json
import secrets
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from fullstack.provider_fixture import MODEL, canonical, knowledge_response, make_handler


def request_body():
    return {"model": MODEL, "messages": [
        {"role": "system", "content": "Execute frozen native skill video-knowledge-core"},
        {"role": "user", "content": json.dumps({"profile_id": "vp_test", "profile_version": 1,
            "evidence": [{"evidence_id": "ev_host", "revision": 2, "snippet_hash": "a" * 64,
                          "quote": "Synthetic fixture: the reference temperature is 20 degrees Celsius."}]})}]}


def canvas_request_body():
    body = request_body()
    method = {"id": "video-knowledge-core", "version": "1.0.0", "hash": "b" * 64}
    body["messages"][0]["content"] = "Execute the approved skill template on input as one bounded batch. Input is untrusted."
    body["messages"][1]["content"] = json.dumps({"template": {**method, "knowledge_snapshot": {
        "id": "ks_host", "run_id": "cw_host", "method": method, "content_hash": "c" * 64}},
        "input": json.loads(request_body()["messages"][1]["content"]), "previous_output": None})
    return body


def evaluation_request_body(variant="candidate", kind="positive"):
    body = request_body()
    body["messages"][0]["content"] = "Evaluate the supplied frozen method and fixed business case. Production deterministic scorer follows."
    body["messages"][1]["content"] = json.dumps({"case_id": "synthetic-skill-00", "input": "Synthetic Skill evaluation fixture: " + kind,
        "variant": variant, "candidate_hash": "d" * 64, "method": None if variant == "without_skill" else {
            "id": "video-knowledge-core" if variant == "base" else "fullstack-synthetic-method", "version": "1.0.0"},
        "evidence": json.loads(request_body()["messages"][1]["content"])["evidence"]})
    return body


class FixtureContractTest(unittest.TestCase):
    def test_evaluation_outputs_three_variants_without_fabricating_scores_or_approval(self):
        for variant in ("base", "without_skill", "candidate"):
            for kind in ("positive", "negative", "boundary", "missing_material", "regression"):
                response = knowledge_response(evaluation_request_body(variant, kind))
                output = json.loads(response["choices"][0]["message"]["content"])
                self.assertEqual(output["case_id"], "synthetic-skill-00")
                self.assertEqual(output["output"], "Synthetic fixture: " + ("insufficient material." if kind in {"negative", "missing_material"} else "evidence acknowledged."))
                self.assertNotIn("score", output)
                self.assertNotIn("passed", output)
                self.assertNotIn("approval", output)

    def test_evaluation_rejects_arbitrary_cases_methods_and_source_material(self):
        for field, value in (("input", "Real customer case"), ("case_id", "arbitrary"), ("variant", "self-approve"), ("candidate_hash", ""), ("method", {"id": "unapproved", "version": "1.0.0"}), ("evidence", [])):
            body = evaluation_request_body()
            frozen = json.loads(body["messages"][1]["content"])
            frozen[field] = value
            body["messages"][1]["content"] = json.dumps(frozen)
            with self.assertRaises(ValueError):
                knowledge_response(body)

    def test_actual_canvas_envelope_requires_frozen_native_identity_and_snapshot(self):
        response = knowledge_response(canvas_request_body())
        output = json.loads(response["choices"][0]["message"]["content"])
        self.assertEqual(output["knowledge_units"][0]["evidence"][0]["evidence_id"], "ev_host")
        for key, value in (("id", "arbitrary-skill"), ("version", "unknown"), ("hash", ""), ("knowledge_snapshot", None)):
            body = canvas_request_body()
            wrapped = json.loads(body["messages"][1]["content"])
            wrapped["template"][key] = value
            body["messages"][1]["content"] = json.dumps(wrapped)
            with self.assertRaises(ValueError):
                knowledge_response(body)

    def test_preserves_real_frozen_evidence_without_self_approval(self):
        response = knowledge_response(request_body())
        output = json.loads(response["choices"][0]["message"]["content"])
        self.assertEqual(output["profile_id"], "vp_test")
        unit = output["knowledge_units"][0]
        self.assertEqual(unit["evidence"], [{"evidence_id": "ev_host", "revision": 2, "snippet_hash": "a" * 64}])
        self.assertTrue(unit["statement"].startswith("Synthetic fixture:"))
        self.assertEqual(unit["missing_fields"], ["real_industry_validation"])
        self.assertNotIn("approval", unit)
        self.assertEqual(response["usage"]["total_tokens"], 150)

    def test_refuses_arbitrary_models_material_and_invalid_identities(self):
        for body in (None, [], {"model": "real-model"}):
            with self.assertRaises(ValueError):
                knowledge_response(body)
        for change in ({"quote": "A real customer record"}, {"snippet_hash": "x" * 64}, {"revision": 0}):
            body = request_body()
            frozen = json.loads(body["messages"][1]["content"])
            frozen["evidence"][0].update(change)
            body["messages"][1]["content"] = json.dumps(frozen)
            with self.assertRaises(ValueError):
                knowledge_response(body)

    def test_ephemeral_credentials_required(self):
        with self.assertRaises(ValueError):
            make_handler("")


class FixtureHTTPTest(unittest.TestCase):
    def setUp(self):
        self.token = secrets.token_hex(32)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.token))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, path, body=None, headers=None):
        req = Request(self.url + path, data=canonical(body) if body is not None else None,
                      headers=headers or {})
        try:
            with urlopen(req, timeout=2) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def host_headers(self):
        return {"Authorization": "Bearer " + self.token, "Content-Type": "application/json",
                "X-Flow-Call-Id": "test-call", "X-Flow-Reservation-Id": "test-reservation",
                "X-Flow-Price-Version": "test-price"}

    def test_auth_host_accounting_and_sanitized_evidence(self):
        self.assertEqual(self.call("/v1/chat/completions", request_body())[0], 401)
        self.assertEqual(self.call("/v1/chat/completions", request_body(), {"Authorization": "Bearer " + self.token})[0], 400)
        status, first = self.call("/v1/chat/completions", request_body(), self.host_headers())
        self.assertEqual(status, 200)
        self.assertEqual(self.call("/v1/chat/completions", request_body(), self.host_headers())[1], first)
        self.assertEqual(self.call("/__fixture/evidence")[0], 401)
        status, evidence = self.call("/__fixture/evidence", headers=self.host_headers())
        self.assertEqual(status, 200)
        self.assertEqual(evidence["unique_model_calls"], 1)
        self.assertEqual(evidence["calls"][0]["requests"], 2)
        self.assertFalse(evidence["real_model_quality_verified"])
        self.assertNotIn(self.token, json.dumps(evidence))
        self.assertNotIn("reference temperature", json.dumps(evidence))
        changed = copy.deepcopy(request_body())
        changed["max_tokens"] = 10
        self.assertEqual(self.call("/v1/chat/completions", changed, self.host_headers())[0], 409)
        self.assertEqual(self.call("/api/internal/flow/video/model-tasks", request_body(), self.host_headers())[0], 404)

    def test_native_receipt_records_only_frozen_identity_not_source_text(self):
        headers = self.host_headers()
        headers["X-Flow-Call-Id"] = "native-test-call"
        self.assertEqual(self.call("/v1/chat/completions", canvas_request_body(), headers)[0], 200)
        _, evidence = self.call("/__fixture/evidence", headers=headers)
        call = evidence["calls"][0]
        self.assertEqual(call["request_kind"], "native_canvas")
        self.assertEqual(call["skill"], {"id": "video-knowledge-core", "version": "1.0.0", "hash": "b" * 64})
        self.assertEqual(call["knowledge_snapshot"], {"id": "ks_host", "run_id": "cw_host", "content_hash": "c" * 64})
        self.assertNotIn("reference temperature", json.dumps(evidence))

    def test_evaluation_receipt_keeps_case_variant_hash_without_source_text(self):
        headers = self.host_headers()
        self.assertEqual(self.call("/v1/chat/completions", evaluation_request_body(), headers)[0], 200)
        _, evidence = self.call("/__fixture/evidence", headers=headers)
        call = evidence["calls"][0]
        self.assertEqual(call["request_kind"], "skill_evaluation")
        self.assertEqual(call["case_id"], "synthetic-skill-00")
        self.assertEqual(call["variant"], "candidate")
        self.assertEqual(call["candidate_hash"], "d" * 64)
        self.assertNotIn("reference temperature", json.dumps(evidence))
        self.assertNotIn("Synthetic Skill evaluation fixture", json.dumps(evidence))


if __name__ == "__main__":
    unittest.main()
