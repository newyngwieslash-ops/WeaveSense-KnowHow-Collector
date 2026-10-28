"""Redact ephemeral credentials before retaining runtime logs in CI artifacts."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
values = []
env = root / ".env.flow"
if env.exists():
    for line in env.read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if any(part in key for part in ("PASSWORD", "SECRET", "TOKEN", "KEY")) and value:
                values.append(value)
state = root / ".local/video-fullstack/state.json"
if state.exists():
    data = json.loads(state.read_text())
    values.extend(data[key] for key in ("username", "password") if key in data)
for line in sys.stdin:
    for value in sorted(values, key=len, reverse=True):
        line = line.replace(value, "[REDACTED]")
    sys.stdout.write(line)
