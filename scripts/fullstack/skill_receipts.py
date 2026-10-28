"""Cross-check real TEST browser, durable Loom and synthetic upstream receipts."""
import hashlib
import json


def verify_native_authority(before, after, browser):
    native = browser["native"]
    assert native["source_instruction_marker"] == "[FULLSTACK_PROMPT_INJECTION_FIXTURE]"
    for name in ("hostile_subtitle_actual_agent_tool_and_approval_boundaries",
                 "hostile_subtitle_actual_canvas_keeps_native_registry_install_pin_unchanged",
                 "native_pins_snapshot_task_output_survive_actual_restart",
                 "native_pinned_search_and_same_call_read_recheck_current_withdrawal"):
        assert browser["checks"].get(name) is True, "Missing actual browser authority assertion: " + name
    assert native["denied_source_requests"] == [
        {"name": "http_request", "status": 400}, {"name": "intel_install_skill", "status": 400},
        {"name": "intel_load_skill", "status": 400}, {"name": "intel_apply_monitor", "status": 409}]
    observed = []
    for report in (before, after):
        assert report["model_boundary"]["exfiltration_requests"] == 0, "Injected network instruction reached the TEST tripwire"
        calls = [call for call in report["model_boundary"]["calls"] if call.get("request_kind") == "native_canvas"]
        assert len(calls) == 1 and calls[0]["requests"] == 1, "Native replay invoked the model more than once"
        call, = calls
        assert call["attack_tool_calls"] == 2, "The external model response did not actually attempt tool dispatch"
        assert call["skill"] == native["skill"], "Native model boundary differs from the frozen host skill"
        assert call["knowledge_snapshot"]["run_id"] == native["workflow_run_id"], "Native model response is not bound to the actual run"
        observed.append(call)
    assert observed[0] == observed[1], "Restart or withdrawal repeated/changed the hostile native model invocation"
    return {"actual_native_model_calls": 1, "adversarial_tool_calls_emitted": 2,
            "source_requested_tool_and_approval_actions_denied": 4,
            "exfiltration_requests_before_restart": 0, "exfiltration_requests_after_restart": 0,
            "native_registry_install_and_pin_unchanged": True, "replayed_native_model_calls": 0,
            "synthetic_external_model": True, "real_model_security_quality_claimed": False}


def verify(before, after, browser):
    expected = browser["skill_candidate"]
    assert expected["case_count"] == 20 and expected["variant_count"] == 3 and expected["task_count"] == 60
    assert expected["deployment_status"] == "not_deployed"
    before_candidate, = before["skill_candidates"]
    after_candidate, = after["skill_candidates"]
    for candidate in (before_candidate, after_candidate):
        assert candidate["id"] == expected["id"]
        assert candidate["candidate_hash"] == expected["candidate_hash"]
        assert candidate["native_skill_hash"] == expected["native_skill_hash"]
        assert candidate["receipt_count"] == 0, "Browser export must not fabricate deployment/install receipts"
    assert before_candidate["state"] == "release_package_exported"
    assert after_candidate["state"] == "retired"
    tasks = before["skill_evaluation_tasks"]
    assert tasks == after["skill_evaluation_tasks"], "Restart or withdrawal changed durable evaluation identity"
    assert len(tasks) == 60 and len({task["task_id"] for task in tasks}) == 60
    assert {task["task_id"] for task in tasks} == set(expected["task_ids"])
    expected_pairs = {(f"synthetic-skill-{i:02}", variant) for i in range(20)
                      for variant in ("base", "without_skill", "candidate")}
    assert {(task["case_id"], task["variant"]) for task in tasks} == expected_pairs
    calls = [call for call in after["model_boundary"]["calls"] if call.get("request_kind") == "skill_evaluation"]
    prior_calls = [call for call in before["model_boundary"]["calls"] if call.get("request_kind") == "skill_evaluation"]
    assert calls == prior_calls, "Restart or withdrawal repeated evaluation model calls"
    assert len(calls) == 60 and len({call["call_id"] for call in calls}) == 60
    for task in tasks:
        assert task["candidate_id"] == expected["id"] and task["state"] == "completed" and task["generation"] == 0
        assert task["run_id"] == task["task_id"] and task["usage_ref"] == "model_task:" + task["task_id"]
        assert task["model_config_hash"] == expected["actual_model_config_hash"]
        assert task["scorer"] == "exact_expected_output_v1" and task["passed"] == "true"
        identity = json.dumps([browser["workspace_id"], task["candidate_id"], task["request_key"]], separators=(",", ":"))
        call_id = "video-model:" + hashlib.sha256(identity.encode()).hexdigest()
        matches = [call for call in calls if call["call_id"] == call_id]
        assert len(matches) == 1
        call, = matches
        assert call["requests"] == 1 and call["case_id"] == task["case_id"] and call["variant"] == task["variant"]
        assert call["candidate_hash"] == expected["candidate_hash"]
    return {"case_count": 20, "variants_per_case": 3, "actual_gateway_calls": 60,
            "evaluation_identity_durable": True, "replayed_model_calls": 0,
            "candidate_container_deployed": False, "production_ready": False}
