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


class FixtureContractTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
