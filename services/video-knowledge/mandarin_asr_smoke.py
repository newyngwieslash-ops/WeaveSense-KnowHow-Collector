"""Opt-in AC08: licensed Mandarin audio -> subtitle-free MP4 -> real workers.

No remote inference or platform acquisition. The object store is a scoped local
filesystem fixture; ASR HTTP, model validation, SQLite executor and Processor
are production implementations. Supply the pinned audio and offline model.
"""
import argparse
import hashlib
import importlib.util
from importlib.metadata import distributions
import json
import os
from pathlib import Path
import signal
import threading
from http.server import ThreadingHTTPServer

from core import InternalClient, Objects
from media import Processor, command
from qa_fixture_service import FixtureObjectStore
from runtime import Executor, Tasks
from server import asr_adapter, handler


SOURCE = {
    "dataset": "google/fleurs", "revision": "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
    "config": "cmn_hans_cn", "split": "test", "archive_member": "test/10026684690566417990.wav",
    "bytes": 664378, "sha256": "a72c0b59fdba80850552af7991de07f9f4940846d2d70f0890eeb153c40f164b",
    "source_url": "https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/cmn_hans_cn/audio/test.tar.gz",
    "license": "CC-BY-4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "attribution": "Conneau et al. (2022), FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech, https://arxiv.org/abs/2205.12446",
    "reference_text": "“这并不是告别。这是一个篇章的结束，也是新篇章的开始。”",
    "modifications": "Audio re-encoded to AAC and combined with a generated plain-color video; no subtitles.",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--work-dir", required=True)
    args = parser.parse_args()
    root, audio = Path(args.work_dir).resolve(), Path(args.audio).resolve()
    raw = audio.read_bytes()
    if len(raw) != SOURCE["bytes"] or hashlib.sha256(raw).hexdigest() != SOURCE["sha256"]:
        raise ValueError("AC08 requires the exact licensed, hash-pinned FLEURS sample")
    root.mkdir(parents=True, exist_ok=True)
    media = root / "mandarin-no-subtitles.mp4"
    command(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=160x90:r=10",
             "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0", "-sn", "-shortest", "-c:v", "mpeg4",
             "-c:a", "aac", "-threads", "1", "-y", str(media)])
    probe = json.loads(command(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(media)]).stdout)
    assert {stream["codec_type"] for stream in probe["streams"]} == {"video", "audio"}
    root.joinpath("licensed-source.wav").write_bytes(raw)
    asr_path = Path(__file__).resolve().parents[1] / "loom-engine" / "workers" / "asr" / "server.py"
    spec = importlib.util.spec_from_file_location("mandarin_production_asr", asr_path)
    asr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(asr)
    _, model_lock = asr.verified_model_directory()
    packages = [{"name": dist.metadata["Name"], "version": dist.version,
        "record_sha256": hashlib.sha256((dist.read_text("RECORD") or "").encode()).hexdigest()}
        for dist in distributions()]
    root.joinpath("fixture.json").write_text(json.dumps({"source": SOURCE, "model_lock": model_lock,
        "installed_packages": sorted(packages, key=lambda item: item["name"].lower()),
        "media_sha256": hashlib.sha256(media.read_bytes()).hexdigest(), "media_bytes": media.stat().st_size,
        "duration_seconds": float(probe["format"]["duration"]), "streams": [stream["codec_type"] for stream in probe["streams"]],
        "model_network_access": False, "real_platform_acquisition": False, "production_object_store": False}, ensure_ascii=False, indent=2))
    store = FixtureObjectStore(root / "objects")
    objects, tasks = Objects(store), Tasks(root / "executions.sqlite")
    asr_token = "synthetic-mandarin-local-asr-token"
    asr_http = ThreadingHTTPServer(("127.0.0.1", 0), asr.make_handler(lambda: store, token=asr_token))
    asr_thread = threading.Thread(target=asr_http.serve_forever, daemon=True)
    asr_thread.start()
    receipts = []

    class ObservedASRClient(InternalClient):
        def json(self, method, path, body=None, **kwargs):
            value = super().json(method, path, body, **kwargs)
            # Observations only: never change model responses or timestamps.
            receipts.append({"path": path, "response": value})
            root.joinpath("asr-receipts.json").write_text(json.dumps(receipts, ensure_ascii=False, indent=2))
            return value

    class NoAcquisition:
        def __getattr__(self, name):
            raise RuntimeError("platform acquisition is forbidden in Mandarin ASR smoke")

    provider = NoAcquisition()
    client = ObservedASRClient(f"http://127.0.0.1:{asr_http.server_port}", asr_token, timeout=25)
    executor = Executor(tasks, objects, Processor(objects, asr=asr_adapter(client, objects)), provider, temp_root=root)
    stopped = threading.Event()

    def work():
        while not stopped.is_set():
            if not executor.run_once():
                stopped.wait(0.05)

    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(tasks, executor, objects, provider,
        os.environ["VIDEO_QA_SERVICE_TOKEN"], os.environ["VIDEO_QA_SIGNING_KEY"]))

    def stop_signal(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    print(f"http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        stopped.set()
        worker.join(timeout=30)
        server.server_close()
        asr_http.shutdown()
        asr_thread.join(timeout=5)
        asr_http.server_close()


if __name__ == "__main__":
    main()
