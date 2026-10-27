#!/usr/bin/env python3
"""Validate one execution ledger and render read-only views of the approved tasks.

This does not infer completion from code files or successful fixture tests.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs/video-ingestion"
TASK_STATES = {"未开始", "进行中", "阻塞", "待验收", "已完成", "暂停"}
CASE_STATES = {"未执行", "执行中", "通过", "失败", "阻塞", "不适用"}
EVIDENCE_FIELDS = ("code_evidence", "automated_evidence", "real_host_evidence",
                   "real_platform_evidence", "pilot_evidence", "deployment_evidence")


def read_json(path: Path):
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)


def validate(baseline, ledger, baseline_bytes: bytes):
    tasks = baseline["tasks"]
    ids = [task["id"] for task in tasks]
    phases = Counter(task["phase"] for task in tasks)
    if len(ids) != len(set(ids)) or phases != {"P0": 81, "P1": 19, "P2": 7}:
        raise ValueError("approved task count/phase identity changed")
    if ledger.get("schema_version") != "weavesense.video-progress/1":
        raise ValueError("unsupported execution ledger")
    if ledger.get("baseline_sha256") != hashlib.sha256(baseline_bytes).hexdigest():
        raise ValueError("execution ledger is not bound to this exact baseline")
    if set(ledger.get("tasks", {})) != set(ids):
        raise ValueError("tasks may not be removed, duplicated or substituted")
    case_ids = [case["id"] for case in baseline["acceptance"]]
    if len(case_ids) != 30 or set(ledger.get("acceptance", {})) != set(case_ids):
        raise ValueError("acceptance case identities changed")
    for task in tasks:
        state = ledger["tasks"][task["id"]]
        if state.get("status") not in TASK_STATES:
            raise ValueError(f"invalid task status: {task['id']}")
        if task["phase"] == "P2" and state["status"] != "未开始":
            raise ValueError(f"P2 is outside the authorized V1: {task['id']}")
        expected = {str(index) for index in range(1, len(task["acceptance"]) + 1)}
        checks = state.get("acceptance_checks", {})
        if set(checks) != expected:
            raise ValueError(f"task acceptance clauses missing: {task['id']}")
        for check in checks.values():
            if check.get("status") not in CASE_STATES or not isinstance(check.get("evidence"), list):
                raise ValueError(f"invalid task acceptance record: {task['id']}")
            if check["status"] == "通过" and not check["evidence"]:
                raise ValueError(f"acceptance needs explicit evidence: {task['id']}")
        for field in EVIDENCE_FIELDS:
            if not isinstance(state.get(field), list):
                raise ValueError(f"missing evidence category: {task['id']} {field}")
        if not isinstance(state.get("blocking_notes"), list):
            raise ValueError(f"invalid blocking notes: {task['id']}")
        if state["status"] == "已完成":
            if state["blocking_notes"] or not state["code_evidence"]:
                raise ValueError(f"completed task still blocked or lacks delivery evidence: {task['id']}")
            if any(check["status"] != "通过" for check in checks.values()):
                raise ValueError(f"completed task has unpassed acceptance: {task['id']}")
            if any(ledger["tasks"][dep]["status"] != "已完成" for dep in task["deps"]):
                raise ValueError(f"completed task has incomplete dependency: {task['id']}")
    for case_id, state in ledger["acceptance"].items():
        if state.get("status") not in CASE_STATES or not isinstance(state.get("evidence"), list):
            raise ValueError(f"invalid global acceptance: {case_id}")
        if state["status"] == "通过" and (not state["evidence"] or not state.get("reviewer")):
            raise ValueError(f"global acceptance needs evidence and reviewer: {case_id}")


def merge(baseline, ledger):
    result = deepcopy(baseline)
    for task in result["tasks"]:
        state = ledger["tasks"][task["id"]]
        # Original notes are requirements, not the runtime blocker cell.
        task["status"], task["owner"], task["issue"] = state["status"], state["owner"], state["issue"]
        task["execution"] = deepcopy(state)
    for case in result["acceptance"]:
        case["execution"] = deepcopy(ledger["acceptance"][case["id"]])
    result["execution_source"] = "PROGRESS.json; generated, do not edit this view"
    return result


def release_gate(baseline, ledger):
    required = [task["id"] for task in baseline["tasks"] if task["phase"] in {"P0", "P1"}]
    cases = [case["id"] for case in baseline["acceptance"] if case["phase"] in {"P0", "P1"}]
    pending_tasks = [key for key in required if ledger["tasks"][key]["status"] != "已完成"]
    pending_cases = [key for key in cases if ledger["acceptance"][key]["status"] != "通过"]
    return {"schema_version": "weavesense.video-release-gate/1", "required_tasks": len(required),
            "required_cases": len(cases), "pending_tasks": pending_tasks, "pending_cases": pending_cases,
            "status": "blocked" if pending_tasks or pending_cases else "accepted",
            "note": "All 100 tasks are checked, not only QA-003 ancestry. Code/fixture success is not formal acceptance."}


def markdown(baseline, ledger):
    counts = Counter(state["status"] for state in ledger["tasks"].values())
    lines = ["# 视频知识工作流执行进度", "", "由不可变任务基线与 PROGRESS.json 生成；不要手工改此视图。", "",
             "P0 81 项；P1 19 项；P2 7 项保留未开始。完整 V1 为 100 项和 29 个用例。", "",
             "状态：" + "；".join(f"{name} {count}" for name, count in sorted(counts.items())), "",
             "| ID | 阶段 | 里程碑 | 任务 | 当前状态 | 责任 | 阻塞/待验收 |",
             "|---|---|---|---|---|---|---|"]
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")
    for task in baseline["tasks"]:
        state = ledger["tasks"][task["id"]]
        lines.append("| " + " | ".join(map(cell, [task["id"], task["phase"], task["milestone"], task["title"],
                     state["status"], state["owner"], "; ".join(state["blocking_notes"])])) + " |")
    lines += ["", "完整实施要求、验收条款、原说明及分层证据见 tasks.execution.json。", ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "render", "check", "gate"))
    args = parser.parse_args(argv)
    path = DOCS / "spec/tasks.baseline.json"
    baseline_bytes = path.read_bytes()
    baseline, ledger = read_json(path), read_json(DOCS / "PROGRESS.json")
    validate(baseline, ledger, baseline_bytes)
    views = {"tasks.execution.json": json.dumps(merge(baseline, ledger), ensure_ascii=False, indent=2) + "\n",
             "PROGRESS.md": markdown(baseline, ledger)}
    if args.command == "render":
        for name, content in views.items():
            (DOCS / name).write_text(content, encoding="utf-8")
    if args.command == "check":
        for name, content in views.items():
            if not (DOCS / name).is_file() or (DOCS / name).read_text(encoding="utf-8") != content:
                raise ValueError(f"stale generated view: {name}; run render")
    if args.command == "gate":
        result = release_gate(baseline, ledger)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] == "accepted" else 1
    print(json.dumps({"valid": True, "tasks": len(baseline["tasks"]), "v1_tasks": 100, "v1_cases": 29}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
