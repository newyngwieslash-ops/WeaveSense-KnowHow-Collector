"""Verifier regression tests; generated rows are not full-stack evidence."""
import copy
import hashlib
import json
import unittest

from fullstack.skill_receipts import verify, verify_native_authority


def fixture():
    candidate = {"id": "vsk_fixture", "candidate_hash": "a" * 64, "native_skill_hash": "b" * 64,
                 "state": "release_package_exported", "receipt_count": 0}
    browser = {"workspace_id": "ws_fixture", "skill_candidate": {
        **{key: candidate[key] for key in ("id", "candidate_hash", "native_skill_hash")},
        "actual_model_config_hash": "c" * 64, "case_count": 20, "variant_count": 3, "task_count": 60,
        "deployment_status": "not_deployed", "task_ids": []}}
    report = {"skill_candidates": [candidate], "skill_evaluation_tasks": [], "model_boundary": {"calls": []}}
    for i in range(20):
        for variant in ("base", "without_skill", "candidate"):
            task_id = f"mt_{i}_{variant}"
            task = {"candidate_id": candidate["id"], "case_id": f"synthetic-skill-{i:02}", "variant": variant,
                    "task_id": task_id, "state": "completed", "generation": 0, "request_key": f"fixture-{i}-{variant}",
                    "run_id": task_id, "usage_ref": "model_task:" + task_id, "model_config_hash": "c" * 64,
                    "scorer": "exact_expected_output_v1", "passed": "true"}
            report["skill_evaluation_tasks"].append(task)
            browser["skill_candidate"]["task_ids"].append(task_id)
            identity = json.dumps([browser["workspace_id"], candidate["id"], task["request_key"]], separators=(",", ":"))
            report["model_boundary"]["calls"].append({"request_kind": "skill_evaluation",
                "call_id": "video-model:" + hashlib.sha256(identity.encode()).hexdigest(), "requests": 1,
                "case_id": task["case_id"], "variant": variant, "candidate_hash": candidate["candidate_hash"]})
    after = copy.deepcopy(report)
    after["skill_candidates"][0]["state"] = "retired"
    return report, after, browser


def native_fixture():
    skill = {"id": "video-knowledge-core", "version": "1.0.0", "hash": "a" * 64}
    browser = {"native": {"skill": skill, "workflow_run_id": "cw_fixture",
        "source_instruction_marker": "[FULLSTACK_PROMPT_INJECTION_FIXTURE]", "denied_source_requests": [
            {"name": "http_request", "status": 400}, {"name": "intel_install_skill", "status": 400},
            {"name": "intel_load_skill", "status": 400}, {"name": "intel_apply_monitor", "status": 409}]},
        "checks": {name: True for name in ("hostile_subtitle_actual_agent_tool_and_approval_boundaries",
            "hostile_subtitle_actual_canvas_keeps_native_registry_install_pin_unchanged",
            "native_pins_snapshot_task_output_survive_actual_restart",
            "native_pinned_search_and_same_call_read_recheck_current_withdrawal")}}
    report = {"model_boundary": {"exfiltration_requests": 0, "calls": [{"request_kind": "native_canvas",
        "requests": 1, "attack_tool_calls": 2, "skill": skill,
        "knowledge_snapshot": {"run_id": "cw_fixture", "content_hash": "b" * 64}}]}}
    return copy.deepcopy(report), copy.deepcopy(report), copy.deepcopy(browser)


class SkillReceiptTests(unittest.TestCase):
    def test_native_authority_verifier_requires_real_attack_and_zero_dispatch_before_and_after_restart(self):
        result = verify_native_authority(*native_fixture())
        self.assertEqual(result["adversarial_tool_calls_emitted"], 2)
        self.assertEqual(result["source_requested_tool_and_approval_actions_denied"], 4)
        self.assertEqual(result["exfiltration_requests_after_restart"], 0)
        self.assertFalse(result["real_model_security_quality_claimed"])

    def test_native_authority_rejects_missing_browser_evidence_replay_or_tool_execution(self):
        changes = [
            lambda b, a, u: b["model_boundary"].update(exfiltration_requests=1),
            lambda b, a, u: a["model_boundary"].update(exfiltration_requests=1),
            lambda b, a, u: a["model_boundary"]["calls"][0].update(requests=2),
            lambda b, a, u: b["model_boundary"]["calls"][0].update(attack_tool_calls=0),
            lambda b, a, u: a["model_boundary"]["calls"][0]["skill"].update(hash="c" * 64),
            lambda b, a, u: a["model_boundary"]["calls"][0]["knowledge_snapshot"].update(run_id="different-run"),
            lambda b, a, u: a["model_boundary"]["calls"][0]["knowledge_snapshot"].update(content_hash="c" * 64),
            lambda b, a, u: u["checks"].clear(),
            lambda b, a, u: u["native"]["denied_source_requests"][0].update(status=200),
            lambda b, a, u: u["native"].update(source_instruction_marker="no-actual-hostile-source"),
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                values = native_fixture()
                change(*values)
                with self.assertRaises(AssertionError):
                    verify_native_authority(*values)

    def test_binds_browser_durable_tasks_and_all_three_gateway_variants(self):
        result = verify(*fixture())
        self.assertEqual(result["actual_gateway_calls"], 60)
        self.assertEqual(result["replayed_model_calls"], 0)
        self.assertFalse(result["candidate_container_deployed"])
        self.assertFalse(result["production_ready"])

    def test_rejects_duplicate_cross_scope_changed_or_fabricated_receipts(self):
        changes = [
            lambda b, a, u: a["model_boundary"]["calls"][0].update(requests=2),
            lambda b, a, u: a["skill_evaluation_tasks"][0].update(task_id="replayed-after-restart"),
            lambda b, a, u: u.update(workspace_id="other-workspace"),
            lambda b, a, u: u["skill_candidate"].update(task_ids=["forged"] * 60),
            lambda b, a, u: a["skill_candidates"][0].update(receipt_count=1),
            lambda b, a, u: a["skill_candidates"][0].update(state="workspace_installed"),
        ]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                values = fixture()
                change(*values)
                with self.assertRaises(AssertionError):
                    verify(*values)

    def test_rejects_identical_corruption_before_and_after_restart(self):
        for target, field, value in (("calls", "call_id", "unbound"), ("calls", "candidate_hash", "d" * 64),
                                     ("calls", "variant", "wrong"), ("tasks", "model_config_hash", "d" * 64),
                                     ("tasks", "passed", "false"), ("tasks", "scorer", "model_self_score"),
                                     ("tasks", "case_id", "synthetic-skill-01"), ("tasks", "generation", 1)):
            with self.subTest(target=target, field=field):
                before, after, browser = fixture()
                for report in (before, after):
                    rows = report["model_boundary"]["calls"] if target == "calls" else report["skill_evaluation_tasks"]
                    rows[0][field] = value
                with self.assertRaises(AssertionError):
                    verify(before, after, browser)


if __name__ == "__main__":
    unittest.main()
