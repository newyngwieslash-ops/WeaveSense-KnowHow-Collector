"""Redact known ephemeral credentials and validate retained JSON before upload."""
import json
from pathlib import Path
import sys

if __package__:
    from .configure import GENERATED_SECRET_NAMES
else:
    from configure import GENERATED_SECRET_NAMES

ROOT = Path(__file__).resolve().parents[2]
TEXT_SUFFIXES = {".json", ".jsonl", ".txt", ".md", ".log", ".html"}


def secret_values(root):
    env = root / ".env.flow"
    values = dict(line.split("=", 1) for line in env.read_text().splitlines()
                  if line and not line.startswith("#") and "=" in line)
    # Names and generation share one contract. TOKEN counts and disabled KEY
    # switches are configuration facts, not credentials to replace in evidence.
    secrets = [values[name] for name in GENERATED_SECRET_NAMES]
    state = root / ".local/video-fullstack/state.json"
    if state.exists():
        data = json.loads(state.read_text())
        secrets.extend(data[name] for name in ("username", "password"))
        if "foreign" in data:
            secrets.extend(data["foreign"][name] for name in ("username", "password"))
    if any(not isinstance(value, str) or not value for value in secrets):
        raise ValueError("missing ephemeral credential")
    return sorted(set(secrets), key=len, reverse=True)


def sanitize(text, values):
    for value in values:
        text = text.replace(value, "[REDACTED]")
    return text


def invalid_constant(_):
    raise ValueError("non-finite JSON number")


def validate_json(path, text):
    if path.suffix == ".json":
        json.loads(text, parse_constant=invalid_constant)
    elif path.suffix == ".jsonl":
        for line in text.splitlines():
            if line.strip():
                json.loads(line, parse_constant=invalid_constant)


def sanitize_artifacts(directories, values):
    for directory in directories:
        for path in Path(directory).rglob("*"):
            if path.is_file() and path.suffix in TEXT_SUFFIXES:
                original = path.read_text()
                cleaned = sanitize(original, values)
                validate_json(path, cleaned)
                if cleaned != original:
                    path.write_text(cleaned)


def main(args=None):
    args = sys.argv[1:] if args is None else args
    if args and (args[0] != "--artifacts" or len(args) < 2):
        raise SystemExit("usage: sanitize.py [--artifacts DIRECTORY ...]")
    try:
        values = secret_values(ROOT)
        if args:
            sanitize_artifacts(args[1:], values)
        else:
            for line in sys.stdin:
                sys.stdout.write(sanitize(line, values))
    except (OSError, ValueError, KeyError, TypeError):
        # Never include failed JSON or credential material in the error output.
        print("Artifact sanitization or JSON validation failed; upload must remain disabled", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
