"""Fail closed if the real-PostgreSQL Flow suite silently skips its opt-in tests."""
import re
import sys


def verify(text):
    required = (
        "RLS: tenant context hides and blocks other tenants' rows (non-superuser role)",
        "A18: backup/restore dump",
        "RLS: HTTP API end-to-end on real Postgres as non-superuser",
        "legacy import (real PostgreSQL, FORCE RLS app role)",
        "QA PostgreSQL: real independent connections serialize claims, preserve restart fence and enforce video FORCE RLS",
        "QA K017 PostgreSQL: coordinator required embedding gates FTS, vectors and ready event on verified host receipt",
        "QA R25/K025 PostgreSQL: pre-erasure backup cannot resurrect data before latest external journal replay",
        "AC28 PostgreSQL: failed additive migration is atomic and retry preserves references",
        "AC07 PostgreSQL: cancel waits for real ready commit then refuses to cancel or delete accepted objects",
    )
    if not re.search(r"^# fail 0$", text, re.M) or not re.search(r"^# skipped 0$", text, re.M):
        raise ValueError("Flow TAP must report zero failures and zero skips")
    if not re.search(r"^# tests [1-9][0-9]*$", text, re.M):
        raise ValueError("Flow TAP has no completed test summary")
    for name in required:
        if not any(line.startswith("ok ") and name in line and "# SKIP" not in line.upper() for line in text.splitlines()):
            raise ValueError("Required PostgreSQL test did not pass: " + name)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as stream:
        verify(stream.read())
    print("All Flow tests and required PostgreSQL cases passed without skips.")
