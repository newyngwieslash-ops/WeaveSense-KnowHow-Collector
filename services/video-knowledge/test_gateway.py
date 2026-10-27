import json
import unittest
from core import Failure
from synthesis import Gateway, batches


class Host:
    def __init__(self):
        self.tasks, self.posts, self.pending, self.lose_response = {}, [], False, False
    def json(self, method, path, payload=None, headers=None):
        assert headers["Authorization"].startswith("Bearer ")
        if method == "POST":
            self.posts.append(payload)
            task = "mt_" + payload["key"]
            self.tasks[task] = payload
            if self.lose_response:
                self.lose_response = False
                raise Failure("PROVIDER_UNAVAILABLE", 503)
            return {"code": 0, "data": {"task_id": task, "status": "queued"}}
        task = path.rsplit("/", 1)[-1]
        payload = self.tasks[task]
        if self.pending:
            return {"code": 0, "data": {"task_id": task, "status": "running"}}
        if payload["purpose"] == "video_vision":
            output = {"observations": [{"kind": "observation", "text": "fixture only", "frame_ids": [payload["frames"][0]["frame_id"]]}]}
        else:
            output = {"summary": "derived fixture only", "input_ids": [item["input_id"] for item in payload["input"]["inputs"]]}
        return {"code": 0, "data": {"task_id": task, "status": "succeeded", "output": output, "usage_ref": "model_task:" + task, "cost_micro": 0, "model_config_hash": "test-route"}}


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.host = Host()
        self.gateway = Gateway("http://platform", "test-key-which-is-at-least-32-bytes", self.host)
        self.body = {"tenant_id": "tn_a", "workspace_id": "ws_a", "video_job_id": "job_a", "stage_attempt": 1, "fencing_token": 1,
                     "profile": {"model_id": "fixture-model", "budget_micro": 10}, "asset": {}}
        self.frame = {"frame_id": "frame-a", "object_key": "scoped-reference", "sha256": "a" * 64, "timestamp_ms": 0}

    def test_pending_poll_and_fence_rebind_reuse_same_host_key(self):
        state = {}
        self.host.pending = True
        for _ in range(2):
            with self.assertRaises(Failure) as error:
                self.gateway.observe(self.body, [self.frame], state, lambda _: None, lambda: None)
            self.assertEqual(error.exception.code, "MODEL_PENDING")
        self.assertEqual(len(self.host.posts), 1)
        self.body.update(stage_attempt=2, fencing_token=2)
        self.host.pending = False
        output = self.gateway.observe(self.body, [self.frame], state, lambda _: None, lambda: None)
        self.assertEqual(len(output), 1)
        self.assertEqual(len(self.host.posts), 2)
        self.assertEqual(self.host.posts[0]["key"], self.host.posts[1]["key"])
        self.assertEqual(self.host.posts[1]["fencing_token"], 2)
        self.assertEqual(len(state["usage"]["model_tasks"]), 1)

    def test_unknown_host_response_recovers_by_verified_host_idempotency(self):
        self.host.lose_response = True
        state = {}
        with self.assertRaises(Failure):
            self.gateway.observe(self.body, [self.frame], state, lambda _: None, lambda: None)
        self.gateway.observe(self.body, [self.frame], state, lambda _: None, lambda: None)
        self.assertEqual(len(self.host.tasks), 1)
        self.assertEqual(self.host.posts[0]["key"], self.host.posts[1]["key"])

    def test_hierarchical_summary_accounts_for_every_input(self):
        state = {}
        segments = [{"text": str(i), "start_ms": i * 1000, "end_ms": (i + 1) * 1000} for i in range(25)]
        output = self.gateway.summarize(self.body, segments, [self.frame], state, lambda _: None, lambda: None)
        self.assertEqual(len(output["consumed_input_ids"]), 26)
        self.assertEqual(len(output["levels"]), 1)
        self.assertEqual(output["kind"], "derived_summary")
        self.assertEqual(output["review_status"], "unreviewed")
        self.assertTrue(all(p["purpose"] == "video_summary" for p in self.host.posts))

    def test_oversized_input_refused_without_silent_summary_loss(self):
        with self.assertRaises(Failure):
            batches([{"text": "x" * 40000}])
        self.assertEqual(self.host.posts, [])

    def test_local_usage_admitted_before_compute_and_settled_once(self):
        calls, state = [], {}
        def call(body, method, path, payload):
            calls.append((path, payload))
            return {"admission_id": "usage-a", "quantity_limit": 2, "quantity": 2, "may_execute": True, "status": "reserved" if path.endswith("admission") else "settled"}
        self.gateway.call = call
        count = []
        def compute():
            self.assertEqual(next(iter(state["local_usage"].values()))["phase"], "processing")
            count.append(1)
            return {"segments": []}
        for _ in range(2):
            self.gateway.local(self.body, "asr_seconds", "chunk-sha", 2, compute, state, lambda _: None, lambda: None)
        self.assertEqual(len(count), 1)
        self.assertEqual([p.rsplit("/", 1)[-1] for p, _ in calls], ["usage-admission", "usage-settle"])
        self.assertEqual(state["usage_receipts"], ["usage-a"])

    def test_lost_settlement_retries_receipt_not_compute(self):
        state, computed, settlements, admissions = {}, [], [], []
        def call(body, method, path, payload):
            if path.endswith("admission"):
                admissions.append(payload)
                return {"admission_id": "usage-a", "quantity_limit": 1, "status": "reserved", "may_execute": True}
            settlements.append(payload)
            if len(settlements) == 1:
                raise Failure("PROVIDER_UNAVAILABLE", 503, True)
            return {"admission_id": "usage-a", "status": "settled", "quantity": 1}
        self.gateway.call = call
        compute = lambda: (computed.append(1) or {"text": "fixture"})
        with self.assertRaises(Failure) as err:
            self.gateway.local(self.body, "ocr_pages", "frame-sha", 1, compute, state, lambda _: None, lambda: None)
        self.assertEqual(err.exception.code, "HOST_OUTCOME_PENDING")
        self.body.update(stage_attempt=2, fencing_token=3)
        result = self.gateway.local(self.body, "ocr_pages", "frame-sha", 1, compute, state, lambda _: None, lambda: None)
        self.assertEqual(result["text"], "fixture")
        self.assertEqual(computed, [1])
        self.assertEqual(settlements[0]["admission_id"], settlements[1]["admission_id"])
        self.assertEqual(admissions[0]["key"], admissions[1]["key"])
        self.assertEqual(admissions[1]["fencing_token"], 3)

    def test_compute_unknown_hold_never_reexecutes(self):
        state, computed, settlements = {}, [], []
        def call(body, method, path, payload):
            if path.endswith("settle"):
                settlements.append(payload)
            return {"admission_id": "usage-a", "quantity_limit": 1, "status": "reserved", "may_execute": True}
        self.gateway.call = call
        def compute():
            computed.append(1)
            raise Failure("PROVIDER_UNAVAILABLE", 503)
        for _ in range(2):
            with self.assertRaises(Failure) as err:
                self.gateway.local(self.body, "ocr_pages", "frame-sha", 1, compute, state, lambda _: None, lambda: None)
            self.assertEqual(err.exception.code, "USAGE_OUTCOME_UNKNOWN")
        self.assertEqual(computed, [1])
        self.assertTrue(all(x["outcome"] == "unknown" for x in settlements))
        self.assertTrue(all(x["quantity"] == 0 for x in settlements))

    def test_local_budget_denial_never_calls_processor(self):
        def deny(*args):
            raise Failure("BUDGET_EXCEEDED", 402)
        self.gateway.call = deny
        with self.assertRaises(Failure):
            self.gateway.local(self.body, "ocr_pages", "frame-sha", 1, lambda: self.fail("compute after denial"), {}, lambda _: None, lambda: None)

    def test_settled_admission_without_result_never_reexecutes(self):
        self.gateway.call = lambda *args: {"admission_id": "usage-a", "quantity_limit": 1, "quantity": 1, "status": "settled", "may_execute": False}
        with self.assertRaises(Failure) as err:
            self.gateway.local(self.body, "ocr_pages", "frame-sha", 1, lambda: self.fail("duplicate compute"), {}, lambda _: None, lambda: None)
        self.assertEqual(err.exception.code, "USAGE_OUTCOME_UNKNOWN")


if __name__ == "__main__":
    unittest.main()
