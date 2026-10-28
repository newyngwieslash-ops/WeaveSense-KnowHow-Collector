"""Explicitly fetch only public, hash-locked AC08 fixtures; never a service hook."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tarfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "video-knowledge"))
from mandarin_asr_smoke import SOURCE


def checked(raw, item):
    if len(raw) != item["bytes"] or hashlib.sha256(raw).hexdigest() != item["sha256"]:
        raise ValueError("public fixture does not match its frozen size/hash")
    return raw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--ack", required=True, choices=["LICENSED_PUBLIC_FIXTURE_ONLY"])
    args = parser.parse_args()
    root = Path(args.output).resolve()
    model = root / "models" / "tiny"
    model.mkdir(parents=True, exist_ok=True)
    lock = json.loads((ROOT / "services/loom-engine/workers/asr/model-lock.tiny.json").read_text())
    for item in lock["files"]:
        target = model / item["name"]
        if target.exists():
            checked(target.read_bytes(), item)
            continue
        url = f"https://huggingface.co/{lock['repository']}/resolve/{lock['revision']}/{item['name']}"
        with urlopen(url, timeout=120) as response:
            raw = response.read(item["bytes"] + 1)
        target.write_bytes(checked(raw, item))
    (model / "model-lock.json").write_text(json.dumps(lock, indent=2))
    target = root / "fleurs-mandarin.wav"
    if target.exists():
        checked(target.read_bytes(), SOURCE)
    else:
        # The frozen archive starts with this sample. Never extract paths from
        # the tar; read only the requested member, with an uncompressed scan cap.
        with urlopen(SOURCE["source_url"], timeout=120) as response, tarfile.open(fileobj=response, mode="r|gz") as archive:
            for index, member in enumerate(archive):
                if index >= 20 or archive.offset > 32 * 1024 * 1024:
                    raise ValueError("licensed fixture archive layout changed")
                if member.name == SOURCE["archive_member"] and member.isfile():
                    if member.size != SOURCE["bytes"]:
                        raise ValueError("licensed audio size changed")
                    target.write_bytes(checked(archive.extractfile(member).read(member.size + 1), SOURCE))
                    break
            else:
                raise ValueError("licensed audio missing")
    (root / "source-attribution.json").write_text(json.dumps(SOURCE, ensure_ascii=False, indent=2))
    print(json.dumps({"audio_sha256": SOURCE["sha256"], "model_revision": lock["revision"], "model_files_verified": len(lock["files"])}))


if __name__ == "__main__":
    main()
