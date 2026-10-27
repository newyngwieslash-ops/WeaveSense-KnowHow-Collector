"""Require named dependency-backed Go tests to run and pass (not merely avoid SKIP)."""

import json
import sys

REQUIRED = {
    ("database", "TestPostgresAssetIDMigration"),
    ("canvas", "TestRepairAssetBytesPostgres"),
    ("repository", "TestCanvasRevision/postgres"),
    ("platform", "TestRuntimeCoordinatorRedisLeasePreservesLongestTTL"),
    ("app", "TestClearAdminRuntimeCacheUsesRedisWhitelist"),
    # Platform-side PostgreSQL RLS (non-superuser role, FLOW_TEST_PG_RLS_DSN).
    ("database", "TestFlowRLSPostgres"),
    ("flow", "TestRuntimeRLSBlocksUnfilteredHandlerQueries"),
    ("flow", "TestBackgroundWorkIsTenantScoped"),
}


def missing_tests(events):
    ran, passed, failed = set(), set(), set()
    for event in events:
        key = (event.get("Package", "").rsplit("/", 1)[-1], event.get("Test"))
        action = event.get("Action")
        if action == "run":
            ran.add(key)
        elif action == "pass":
            passed.add(key)
        elif action in {"skip", "fail"}:
            failed.add(key)
    return REQUIRED - ((ran & passed) - failed)


def test_summary(events):
    """Report top-level counts and every skip without counting subtests twice."""
    terminal = {}
    skipped = set()
    for event in events:
        package, name, action = event.get("Package", ""), event.get("Test"), event.get("Action")
        if name and action == "skip":
            skipped.add((package, name))
        if name and "/" not in name and action in {"pass", "fail", "skip"}:
            terminal[(package, name)] = action
    return {
        "top_level": {action: sum(value == action for value in terminal.values()) for action in ("pass", "fail", "skip")},
        "skipped_tests": [{"package": package, "test": name} for package, name in sorted(skipped)],
        "business_acceptance": "not_inferred_from_engineering_tests",
    }


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as stream:
        events = [json.loads(line) for line in stream if line.strip()]
    print("GO_TEST_SUMMARY=" + json.dumps(test_summary(events), sort_keys=True))
    missing = missing_tests(events)
    if missing:
        sys.exit("Dependency tests missing, skipped or failed: " + repr(sorted(missing)))
    print("All dependency-backed tests ran and passed.")
