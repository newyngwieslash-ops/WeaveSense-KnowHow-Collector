"""Actual durable Python adapter + host HTTP; compute outputs are synthetic only."""
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "video-knowledge"))
from core import Failure
from runtime import Tasks
from synthesis import Gateway

body = json.loads(os.environ["VIDEO_QA_USAGE_BODY"])
root = Path(os.environ["VIDEO_QA_USAGE_STATE"])
root.mkdir(exist_ok=True)
tasks = Tasks(root / "worker.sqlite")
gateway = Gateway(os.environ["VIDEO_QA_HOST_URL"], os.environ["VIDEO_QA_SIGNING_KEY"])
phase = os.environ["VIDEO_QA_USAGE_PHASE"]
counts_file = root / "counts.json"

def compute(kind):
    counts = json.loads(counts_file.read_text()) if counts_file.exists() else {}
    counts[kind] = counts.get(kind, 0) + 1
    counts_file.write_text(json.dumps(counts))
    return {"segments": []} if kind == "asr" else {"text": "synthetic OCR fixture"}

if phase == "initial":
    tasks.submit(body, time.time() + 120)
    original = gateway.http.json
    def lose_settlement_response(method, path, payload=None, headers=None):
        response = original(method, path, payload, headers)
        if path.endswith("usage-settle"):
            raise Failure("PROVIDER_UNAVAILABLE", 503, True)
        return response
    gateway.http.json = lose_settlement_response

row = tasks.claim()
assert row, "durable worker receipt not claimable"
checkpoint = json.loads(row["checkpoint"])
save = lambda value: tasks.save(row, value)
active = lambda: body.update(tasks.active(row))
try:
    gateway.local(body, "asr_seconds", "synthetic-audio-chunk-sha", 2, lambda: compute("asr"), checkpoint, save, active)
except Failure as error:
    assert phase == "initial" and error.code == "HOST_OUTCOME_PENDING", error.code
    assert tasks.finish(row, "pending")
    print(json.dumps({"phase": "pending_after_lost_settlement", "durable": True}))
    sys.exit(0)

assert phase == "resume", "expected initial settlement response loss"
gateway.local(body, "ocr_pages", "synthetic-frame-sha", 1, lambda: compute("ocr"), checkpoint, save, active)
try:
    gateway.local(body, "asr_seconds", "over-profile-cap", 1001, lambda: compute("denied"), checkpoint, save, active)
    raise AssertionError("cumulative profile cap not enforced")
except Failure as error:
    assert error.status == 402, error.code
counts = json.loads(counts_file.read_text())
assert counts == {"asr": 1, "ocr": 1}, counts
assert len(checkpoint["usage_receipts"]) == 2
assert tasks.finish(row, "completed", result={"fixture": True})
print(json.dumps({"phase": "recovered_without_recompute", "compute_counts": counts,
                  "usage_receipts": checkpoint["usage_receipts"], "cap_denial": 402,
                  "process_restart": True, "synthetic_compute": True}))
