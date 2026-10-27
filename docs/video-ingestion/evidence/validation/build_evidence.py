#!/usr/bin/env python3
"""Build a deterministic, sanitized QA log archive without modifying source."""

import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile
from datetime import datetime, timezone


BASELINE = "514c70f666cb04e3e72cbfb967fac74d9f350747"
EXPECTED_SOURCE = "569d0fe8ebede44def1305b7cc0c9c124fdfa350cf01f0737b7395c5e20b59e1"
FIXTURE_SHA = "ecb81c128001b0cd724fa8c296bfd8e59252563d1e71e7234e5080ef2dbea7e1"
CANARIES = {"synthetic"}
RULES = [
    ("pem_private_key", re.compile(r"-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----", re.S), False),
    ("jwt", re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), False),
    ("bearer_or_basic", re.compile(r"(?i)(\b(?:Bearer|Basic)\s+)(?!\[REDACTED:)[A-Za-z0-9+/_.~=-]+"), True),
    ("cookie_header", re.compile(r"(?im)^(\s*(?:set-cookie|cookie)\s*:\s*)(?!\[REDACTED:)[^\r\n]+"), True),
    ("credential_assignment", re.compile(
        r"(?i)((?:[\"']?\b(?:(?-i:[A-Z][A-Z0-9_]*_(?:TOKEN|PASSWORD|PASSWD|SECRET|KEY|CREDENTIAL|AUTH))|"
        r"password(?:[_-]?hash)?|passwd|pwd|secret|client[_-]?secret|jwt[_-]?secret|signing[_-]?key|encryption[_-]?key|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|"
        r"auth[_-]?token|authorization|token|cookie|set-cookie|x-api-key|x-goog-api-key|key)\b[\"']?)\s*[:=]\s*)"
        r"(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;\"'&<>{}\[\]]+)"), True),
    ("url_userinfo", re.compile(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@"), True),
    ("signed_url_query", re.compile(r"(?i)([?&](?:x-amz-signature|x-amz-credential|x-amz-security-token|sig|signature|access_token|api_key|token)=)[^&\s\"'<>]+"), True),
    ("provider_key", re.compile(r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b"), False),
    ("sql_password", re.compile(r"(?i)(\bPASSWORD\s+)'(?:''|[^'])*'"), True),
    ("local_workspace_path", re.compile(r"/workspace/scratch/[^/\s\"'<>]+"), False),
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def sanitize(data):
    text = data.decode("utf-8", errors="replace")
    counts = {name: 0 for name, _, _ in RULES}
    retained = 0
    for name, pattern, prefix in RULES:
        def replace(match):
            nonlocal retained
            value = match.group(2) if name == "credential_assignment" else match.group(0)
            if name == "credential_assignment" and value.strip("\"'") in CANARIES:
                retained += 1
                return match.group(0)
            if "[REDACTED:" in value:
                return match.group(0)
            counts[name] += 1
            if name == "local_workspace_path":
                return "[WORKSPACE]"
            marker = "[REDACTED:" + name + "]"
            return (match.group(1) if prefix else "") + marker + ("@" if name == "url_userinfo" else "")
        text = pattern.sub(replace, text)
    return text.encode("utf-8"), counts, retained


def source_specs():
    specs = []
    for kind in ("loom", "backend"):
        base = f"final-{kind}-0030"
        for name in ("run.log", "logs/postgres-runtime.txt", "logs/postgres-cluster.log", f"logs/source-{kind}-before.sha256", f"logs/source-{kind}-after.sha256"):
            specs.append((f"{base}/{name}", "final_frozen_candidate"))
    specs += [("final-loom-0030/logs/final-loom-postgres-loom.log", "final_frozen_candidate"),
              ("final-backend-0030/logs/final-go-postgres-all.log", "final_frozen_candidate"),
              ("final-loom-0030/logs/python-final.log", "final_frozen_candidate"),
              ("final-loom-0030/logs/asr-final.log", "final_frozen_candidate"),
              ("final-loom-0030/logs/runtime-versions.txt", "final_frozen_candidate"),
              ("final-loom-0030/logs/host-api-final.log", "final_frozen_supporting_api_only"),
              ("final-loom-0030/host-api/host-api-qa.json", "final_frozen_supporting_api_only"),
              ("final-loom-0030/logs/host-binary.sha256", "final_frozen_supporting_api_only"),
              ("final-loom-0030/logs/typescript-flow-final.log", "final_frozen_candidate")]
    for name in ("run.log", "logs/final-loom-postgres-all.log", "logs/final-go-postgres-all.log", "logs/source-all-before.sha256", "logs/source-all-after.sha256", "logs/source-all-drift.diff", "logs/redis-real-denied-prior.log"):
        specs.append((f"final-freeze-20261026/{name}", "intermediate_source_drift_not_final_acceptance"))
    for name in ("knowhow-release-real-domain.log", "knowhow-typed-ttl-host-restore.log", "knowhow-source-expiry-host.log", "knowhow-native-undo-restore-recheck.log", "knowhow-host-impact-api.log", "knowhow-visual-media-changed-repair.log", "shared-contract-final/go.log", "shared-contract-final/typescript.log", "shared-contract-final/python.log", "shared-contract-final/fixture.sha256"):
        specs.append((f"logs/{name}", "focused_earlier_supporting_evidence"))
    return specs


def go_counts(text):
    return {
        "counting_rule": "Only column-zero --- PASS/SKIP/FAIL lines; indented child output and subtests excluded.",
        "passed": len(re.findall(r"^--- PASS: ", text, re.M)),
        "skipped": len(re.findall(r"^--- SKIP: ", text, re.M)),
        "failed": len(re.findall(r"^--- FAIL: ", text, re.M)),
        "packages_passed": len(re.findall(r"^ok\s+\S+", text, re.M)),
        "packages_failed": len(re.findall(r"^FAIL\s+\S+", text, re.M)),
        "skipped_test_names": re.findall(r"^--- SKIP: ([^\r\n]+)", text, re.M),
    }


def node_counts(text):
    result = {}
    for key in ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"):
        values = re.findall(r"^[\u2139#]\s+" + key + r"\s+(\d+(?:\.\d+)?)\s*$", text, re.M)
        result[key] = (float(values[-1]) if "." in values[-1] else int(values[-1])) if values else None
    return result


def stable_read(path):
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError(f"Input changed while being read: {path.name}")
    return data


def python_counts(text):
    match = re.search(r"Ran (\d+) tests in ([\d.]+)s", text)
    skips = re.findall(r"^([^\r\n]+) \.\.\. skipped ([^\r\n]+)$", text, re.M)
    passed = len(re.findall(r"^test_[^\r\n]+ \.\.\. ok$", text, re.M))
    return {"tests": int(match[1]) if match else None,
            "duration_seconds": float(match[2]) if match else None,
            "passed": passed, "skipped": len(skips),
            "successful_terminal_summary": bool(re.search(r"^OK(?: \(skipped=\d+\))?\s*$", text, re.M)),
            "skip_details": [{"test": name, "reason": reason.strip("'")} for name, reason in skips]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qa-root", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path(__file__).parent)
    parser.add_argument("--generated-at", default=datetime.now(timezone.utc).isoformat())
    parser.add_argument("--terminal-confirmed-by", help="Set only after the supervising agent confirms both final processes terminated successfully.")
    parser.add_argument("--prior-local-model-log", type=pathlib.Path, help="Optional separately owned prior model smoke; never substituted for final ASR tests.")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    records, originals, sanitized_files, missing = [], {}, {}, []
    specs = [(relative, classification, args.qa_root / relative) for relative, classification in source_specs()]
    if args.prior_local_model_log:
        specs.append(("prior-owner/knowhow-real-model-gap.log", "prior_media_provider_owner_actual_local_cpu_smoke", args.prior_local_model_log))
    for relative, classification, path in specs:
        if not path.is_file():
            missing.append(relative)
            continue
        original = stable_read(path)
        cleaned, counts, retained = sanitize(original)
        originals[relative] = original
        sanitized_files[relative] = cleaned
        records.append({"source_relative_to_qa_root": relative if not relative.startswith("prior-owner/") else None,
                        "source_argument": "--prior-local-model-log" if relative.startswith("prior-owner/") else "--qa-root", "archive_member": relative,
                        "classification": classification, "original_sha256": sha(original),
                        "sanitized_sha256": sha(cleaned), "original_bytes": len(original),
                        "sanitized_bytes": len(cleaned), "redaction_counts": counts,
                        "explicit_synthetic_canaries_retained": retained,
                        "original_copied_unchanged": original == cleaned})
    get = lambda name: originals.get(name, b"").decode("utf-8", errors="replace")
    manifests = {}
    failures = []
    for kind in ("loom", "backend"):
        base = f"final-{kind}-0030/logs/source-{kind}"
        before = originals.get(base + "-before.sha256")
        after = originals.get(base + "-after.sha256")
        manifests[kind] = {"before_sha256": sha(before) if before else None,
                           "after_sha256": sha(after) if after else None,
                           "before_file_count": len(before.splitlines()) if before else None,
                           "after_file_count": len(after.splitlines()) if after else None,
                           "unchanged": bool(before and after and before == after),
                           "matches_expected_frozen_source": bool(before and sha(before) == EXPECTED_SOURCE)}
        if not (manifests[kind]["unchanged"] and manifests[kind]["matches_expected_frozen_source"]):
            failures.append(f"{kind}: final unchanged expected source manifest not established")
        run = get(f"final-{kind}-0030/run.log")
        if "Actual isolated PostgreSQL verification: Loom exit=0; Go exit=0" not in run or "Source manifest unchanged across this run." not in run:
            failures.append(f"{kind}: successful terminal marker not established")
    loom = node_counts(get("final-loom-0030/logs/final-loom-postgres-loom.log"))
    go = go_counts(get("final-backend-0030/logs/final-go-postgres-all.log"))
    python_result = python_counts(get("final-loom-0030/logs/python-final.log"))
    asr_result = python_counts(get("final-loom-0030/logs/asr-final.log"))
    host_api_text = get("final-loom-0030/host-api/host-api-qa.json")
    host_api = json.loads(host_api_text) if host_api_text else {}
    ts_passed = "strict_flow_typescript_exit=0" in get("final-loom-0030/logs/typescript-flow-final.log")
    if loom["pass"] is None or loom["fail"] != 0 or loom["cancelled"] != 0 or loom["pass"] <= 0:
        failures.append("loom: complete successful test summary not established")
    if go["failed"] or go["packages_failed"] or not go["packages_passed"]:
        failures.append("go: successful package summaries not established")
    if not python_result["successful_terminal_summary"] or not asr_result["successful_terminal_summary"] or not ts_passed:
        failures.append("python/asr/typescript: successful result not established")
    if missing:
        failures.append("required evidence inputs are missing")
    if args.terminal_confirmed_by and failures:
        raise SystemExit("Refusing final PASS: " + "; ".join(failures))
    # No credentials/raw logs enter the tar; zeroed metadata makes it deterministic.
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for name, data in sorted(sanitized_files.items()):
            entry = tarfile.TarInfo(name)
            entry.size, entry.mtime, entry.mode = len(data), 0, 0o644
            archive.addfile(entry, io.BytesIO(data))
    archive_data = gzip.compress(tar_buffer.getvalue(), mtime=0)
    archive_name = "sanitized-logs.tar.gz"
    (args.output / archive_name).write_bytes(archive_data)
    repo = pathlib.Path(__file__).resolve().parents[4]
    branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=repo, text=True).strip()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    report = {
        "schema_version": 1, "generated_at_utc": args.generated_at,
        "status": "passed_with_explicit_skips_and_scope_limits" if args.terminal_confirmed_by else "pending_supervisor_terminal_confirmation",
        "terminal_confirmation": args.terminal_confirmed_by,
        "terminal_observations": {"loom": {"observed_by_supervisor_at_utc": "2026-10-26T18:38:09Z" if args.terminal_confirmed_by else None, "postgres_cluster_stopped_at_utc": "2026-10-26T18:37:49Z" if args.terminal_confirmed_by else None}, "go": {"observed_by_supervisor_at_utc": "2026-10-26T18:34:46Z"}},
        "final_gate_blockers": failures + ([] if args.terminal_confirmed_by else ["supervisor terminal confirmation not supplied"]),
        "repository": {"branch": branch, "baseline_commit": BASELINE, "head_at_packaging": head, "uncommitted_worktree": True, "source_manifest_scope": "backend/, services/, deploy/ selected implementation/config extensions; excludes web/, docs/, artifacts and generated dependencies"},
        "frozen_source": {"expected_manifest_sha256": EXPECTED_SOURCE, "expected_files": 1868, "runs": manifests},
        "runtime": {"postgresql": "17.11, official isolated local cluster; no production database", "go": "1.25.14", "node": "24.22.1", "python": "3.12.14", "bun": "1.4.4", "linux": "6.18.55 x86_64", "synthetic_users_and_data_only": True},
        "reproduction": {"entrypoint": "services/loom-engine/validation/video-knowledge/postgres-qa.sh", "modes": ["loom", "backend"], "environment": {"PG_BIN": "<trusted PostgreSQL 17.11 bin directory>", "PG_LIB_PATH": "<its sibling usr/lib/x86_64-linux-gnu>", "GO_BIN_DIR": "<Go 1.25.14 go/bin>", "VIDEO_QA_OUTPUT": "<fresh output directory per mode>"}, "internal_flags": {"FLOW_VIDEO_CROSSLAYER_TEST": "1", "FLOW_VIDEO_RESTORE_TEST": "1", "FLOW_VIDEO_RELEASE_BUILD_TEST": "1"}, "go_command": "go test -p 2 -count=1 -v ./...", "loom_command": "node --experimental-strip-types --test --test-concurrency=1 flow/*.test.ts"},
        "final_suites": {"loom": {"started_at_utc": "2026-10-26T18:29:25Z", **loom}, "go": {"started_at_utc": "2026-10-26T18:30:22Z", **go}, "python": python_result, "asr_system_python": {**asr_result, "command": "python3 -m unittest -v test_server", "cwd": "services/loom-engine/workers/asr", "scope": "Separate from prior owner actual model smoke; current system interpreter lacks faster-whisper."}, "typescript_strict_flow": {"exit_code": 0 if ts_passed else None, "scope": "Flow only; not full frontend/browser acceptance"}},
        "supporting_reproduction": {"python": {"cwd": "services/video-knowledge", "command": "python3 -m unittest -v test_video test_gateway test_shared_contract_qa"}, "typescript": {"cwd": "services/loom-engine", "command": "./node_modules/.bin/tsc -p tsconfig.flow.json --noEmit"}, "final_host_api": {"build_cwd": "backend", "build_command": "go build -o <temporary-host-binary> ./cmd/server", "cwd": "services/loom-engine", "command": "VIDEO_QA_HOST_BINARY=<temporary-host-binary> VIDEO_QA_OUTPUT=<output>/host-api node validation/video-knowledge/host-api-qa.mjs"}},
        "final_host_api": {"binary_sha256": get("final-loom-0030/logs/host-binary.sha256").split()[0] if get("final-loom-0030/logs/host-binary.sha256").split() else None, "report": host_api, "scope": "Actual fresh compiled Go host, cookie session, Vite proxy and Loom; API-only, no browser execution."},
        "focused_supporting_results": {name: go_counts(get("logs/" + name)) for name in ("knowhow-release-real-domain.log", "knowhow-typed-ttl-host-restore.log", "knowhow-source-expiry-host.log", "knowhow-native-undo-restore-recheck.log")},
        "prior_local_model_smoke": {"included": bool(args.prior_local_model_log), "run_owner": "prior media/provider lane owner, not the final aggregate run", "source_reference": "docs/video-ingestion/evidence/media-provider.json", "mode": "actual pinned official tiny CPU model plus installed Tesseract, generated synthetic voice/frame data", "limits": "Not platform/industry quality gold; disclosed dog-to-log ASR recognition error; nonfatal UCX VFS Unix-socket policy warning preserved; no denied IPC retry."},
        "expected_go_skip_context": {"redis": {"count": 2, "reason": "Redis absent from final PATH; earlier real Redis 8.0.2 attempt was denied Unix IPC by executor policy; not retried"}, "paid_ddcat": {"count": 1, "reason": "No real-provider authorization/budget"}, "browser_runner": {"count": 1, "reason": "Browser launch separately denied executor IPC; no browser acceptance claimed"}, "compiled_children": {"count": 2, "reason": "Direct child entrypoints skip outside harness; parent build tests actually execute children"}, "platform_fallback": {"count": 1, "reason": "Linux-incompatible fallback; equivalent main classification test executes"}},
        "shared_fixture": {"repo_path": "services/loom-engine/validation/video-knowledge/shared-contract-v1.json", "expected_sha256": FIXTURE_SHA, "recorded_sha256_matches": get("logs/shared-contract-final/fixture.sha256").split()[0:1] == [FIXTURE_SHA]},
        "intermediate_run": {"directory": "final-freeze-20261026", "status": "intermediate_not_final_acceptance", "reason": "Source drift during the earlier aggregate run: video.ts, video.test.ts and new 0030_video_external_observation.sql; use final reruns for frozen-source verdict.", "loom": node_counts(get("final-freeze-20261026/logs/final-loom-postgres-all.log")), "go": go_counts(get("final-freeze-20261026/logs/final-go-postgres-all.log"))},
        "scope_limits": ["Not 100/100 formal acceptance; seven P2 tasks remain unstarted.", "No live platform acquisition, real model-quality, human industry approval, seven-day pilot or deployment acceptance.", "Host-impact evidence is actual host cookie/session/Vite proxy/API-only; no executed browser UI claimed.", "Earlier focused proofs are supporting evidence, not substituted for final aggregate freeze evidence."],
        "sanitization": {"version": 1, "rule_order": [name for name, _, _ in RULES], "count_semantics": "Applied nonoverlapping replacements in ordered passes, not count of unique secrets. Earlier replacements may consume later matches.", "synthetic_canary_allowlist": sorted(CANARIES), "policy": "All credential-shaped data redacted except explicit literal canaries. Original hashes identify raw local evidence; redacted files are not claimed to be original copies.", "limitations": "Pattern-based redaction, not a proof that every possible unknown secret format is recognized. Synthetic-data provenance and human review remain required."},
        "archive": {"path": archive_name, "sha256": sha(archive_data), "bytes": len(archive_data), "members": len(sanitized_files), "compression": "gzip mtime=0; tar file metadata normalized"},
        "missing_inputs": missing, "files": records,
    }
    (args.output / "validation-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    with tarfile.open(fileobj=io.BytesIO(archive_data), mode="r:gz") as archive:
        for record in records:
            if sha(archive.extractfile(record["archive_member"]).read()) != record["sanitized_sha256"]:
                raise RuntimeError("Archive member verification failed")
    print(json.dumps({"status": report["status"], "archive_sha256": sha(archive_data), "files": len(records), "missing": missing, "redactions": {name: sum(record["redaction_counts"][name] for record in records) for name, _, _ in RULES}, "blockers": report["final_gate_blockers"]}, indent=2))


if __name__ == "__main__":
    main()
