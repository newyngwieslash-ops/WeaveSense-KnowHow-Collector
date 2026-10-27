"""Independent cross-language QA fixture; never a deployable platform service.

Real components: signed HTTP handler, SQLite tasks, execution leases, FFmpeg,
Processor, hashes/manifests. Fixture-only components: platform download and ASR.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import signal
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

from core import Failure, Objects
from media import Processor, command
from runtime import Executor, Tasks
from server import handler


class FileResponse:
    def __init__(self, path):
        self.stream = path.open("rb")
    def read(self, size=-1):
        return self.stream.read(size)
    def close(self):
        self.stream.close()
    def release_conn(self):
        pass


class FixtureObjectStore:
    def __init__(self, root):
        self.root = root
    def put_object(self, bucket, key, data, length, **kwargs):
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as out:
            shutil.copyfileobj(data, out, length=64 * 1024)
        if path.stat().st_size != length:
            raise Failure("INCOMPLETE_ARTIFACT")
    def get_object(self, bucket, key):
        return FileResponse(self.root / key)
    def remove_object(self, bucket, key):
        (self.root / key).unlink(missing_ok=True)


class FixtureDownload:
    def __init__(self, media):
        self.media = media
        self.refreshes = 0
    def submit_download(self, asset):
        return {"download_id": "fixture-download-" + asset["native_id"]}
    def resolve(self, platform, asset):
        self.refreshes += 1
        if self.refreshes == 2 and os.environ.get("VIDEO_QA_CHANGE_ON_SECOND_REFRESH") == "1":
            changed = self.media.parent / "changed-source.mp4"
            command(["ffmpeg", "-nostdin", "-v", "error", "-i", str(self.media), "-vf", "negate", "-c:v", "mpeg4", "-c:a", "copy", "-threads", "1", "-y", str(changed)])
            self.media = changed
        return {"platform": platform, "content_id": asset["native_id"], "web_url": asset["canonical_url"], "title": asset.get("title"), "duration_ms": 2400}
    def download(self, identifier):
        return {"id": identifier, "state": "done", "on_disk": True}
    def copy_media(self, download, target, maximum):
        size, digest = 0, hashlib.sha256()
        with self.media.open("rb") as source, target.open("wb") as out:
            while chunk := source.read(64 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise Failure("LIMIT_EXCEEDED", 413)
                out.write(chunk)
                digest.update(chunk)
        return {"bytes": size, "sha256": digest.hexdigest(), "content_type": "video/mp4"}
    def cancel(self, identifier):
        return {"status": "unsupported"}


def fixture_asr(ref, scope, language):
    # Deliberately labelled: this does not transcribe the generated sine wave.
    return {"segments": [{"text": "跨语言契约夹具😀", "start": 0.1, "end": 1.2}],
            "language": "zh", "engine": "deterministic-fixture-not-model"}


def fixture_ocr(ref, scope):
    return {"text": "视觉夹具" * 600, "engine": "deterministic-fixture-not-ocr"}


class FixtureVision:
    def observe(self, body, frames, checkpoint, save, active):
        # Exercises the artifact protocol, NOT host billing or model intelligence.
        checkpoint["usage"]["model_tasks"] = [{"task_id": "fixture-not-a-real-model-task", "usage_ref": "fixture-only", "model_config_hash": "f" * 64}]
        return [{"kind": kind, "frame_ids": [frames[0]["frame_id"]], "text": "Fixture " + kind} for kind in ("observation", "inference")]


def main():
    def stop_signal(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    key, token = os.environ["VIDEO_QA_SIGNING_KEY"], os.environ["VIDEO_QA_SERVICE_TOKEN"]
    with tempfile.TemporaryDirectory(prefix="weavesense-python-qa-") as root:
        root = Path(root)
        media = root / "generated.mp4"
        command(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "2.4", "-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", "-y", str(media)])
        objects = Objects(FixtureObjectStore(root / "objects"))
        tasks = Tasks(root / "executions.sqlite")
        provider = FixtureDownload(media)
        executor = Executor(tasks, objects, Processor(objects, asr=fixture_asr, ocr=fixture_ocr, gateway=FixtureVision()), provider, temp_root=root)
        stopped = threading.Event()
        def work():
            while not stopped.is_set():
                if not executor.run_once():
                    stopped.wait(0.05)
        worker = threading.Thread(target=work, daemon=True)
        worker.start()
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler(tasks, executor, objects, provider, token, key))
        print(f"http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        finally:
            stopped.set()
            worker.join(timeout=5)
            server.server_close()


if __name__ == "__main__":
    main()
