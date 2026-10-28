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
def sanitize(line):
    for value in sorted(values, key=len, reverse=True):
        line = line.replace(value, "[REDACTED]")
    return line


if len(sys.argv) > 1:
    if sys.argv[1] != "--artifacts":
        raise SystemExit("usage: sanitize.py [--artifacts DIRECTORY ...]")
    for directory in sys.argv[2:]:
        for path in Path(directory).rglob("*"):
            if path.is_file() and path.suffix in {".json", ".jsonl", ".txt", ".md", ".log", ".html"}:
                original = path.read_text()
                cleaned = sanitize(original)
                if cleaned != original:
                    path.write_text(cleaned)
else:
    for line in sys.stdin:
        sys.stdout.write(sanitize(line))
