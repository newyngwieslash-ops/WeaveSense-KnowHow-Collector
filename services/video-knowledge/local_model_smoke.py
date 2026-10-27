"""Opt-in real CPU ASR + OCR on generated media. Never contacts a model API.

Supply a predownloaded, hash-verified CTranslate2 model directory. This is a
runtime smoke, not an industry accuracy benchmark or a platform download test.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import tempfile
import time
import wave

from core import Objects, canonical, sha
from media import Processor, command
from server import asr_adapter


class Response(io.BytesIO):
    def release_conn(self):
        pass


class FixtureStore:
    def __init__(self):
        self.data = {}
    def put_object(self, bucket, key, stream, length, **kwargs):
        self.data[key] = stream.read()
        assert len(self.data[key]) == length
    def get_object(self, bucket, key):
        return Response(self.data[key])


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    model = Path(args.model_dir).resolve()
    expected = "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1"
    if sha((model / "model.bin").read_bytes()) != expected:
        raise ValueError("expected pinned Systran faster-whisper-tiny model.bin")
    os.environ.update(ASR_MODEL="tiny", ASR_MODEL_DIR=str(model), ASR_MODEL_MANIFEST=str(model / "download-manifest.json"), HF_HUB_OFFLINE="1", OCR_LANGS="eng")
    root = Path(__file__).resolve().parents[1] / "loom-engine" / "workers"
    asr = module(root / "asr" / "server.py", "host_asr")
    ocr = module(root / "ocr" / "server.py", "host_ocr")
    store, scope, job = FixtureStore(), {"tenant_id": "tn_synthetic", "workspace_id": "ws_synthetic"}, "vjob_synthetic"
    objects = Objects(store)
    report = {"fixture_kind": "generated_synthetic_not_platform_or_industry_gold", "python": platform.python_version(),
              "model_repository": "Systran/faster-whisper-tiny", "model_revision": "d90ca5fe260221311c53c58e660288d3deb8d356", "model_sha256": expected,
              "model": "tiny", "engine": "faster-whisper 1.1.1", "device": "cpu", "compute_type": "int8"}
    with tempfile.TemporaryDirectory(prefix="video-model-smoke-") as tmp:
        folder = Path(tmp)
        audio = io.BytesIO()
        with wave.open(audio, "wb") as stream:
            stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(16000); stream.writeframes(b"\x00\x00" * 32000)
        started = time.monotonic()
        text, seconds, language, segments = asr.run_whisper(audio.getvalue(), "en")
        report["silence"] = {"input_sha256": sha(audio.getvalue()), "seconds": seconds, "text": text, "segment_count": len(segments), "elapsed_seconds": time.monotonic() - started,
                             "passed": text == "" and segments == [] and seconds == 2}
        phrase = "This is a generated voice sample. The quick brown fox jumps over the lazy dog."
        voice = folder / "voice.txt"
        voice.write_text(phrase)
        media = folder / "sample.mp4"
        command(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=640x360:r=10", "-f", "lavfi", "-i", f"flite=textfile={voice}:voice=slt", "-vf", "drawtext=text='WEAVE TEST 42':fontcolor=black:fontsize=50:x=50:y=150", "-shortest", "-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", "-y", str(media)])
        ref = objects.put_file(scope, job, media, "source.mp4", "video/mp4", 20 * 1024 * 1024)
        source = {"schema_version": 1, "artifact_stage": "input_ready", "video_job_id": job, "stage_attempt": 1, "fencing_token": 1, "input_kind": "media", "input_hash": ref["sha256"], "media_sha256": ref["sha256"], "availability": "available", "objects": [ref]}
        class LocalASRTransport:
            def json(self, method, path, payload):
                # Exercise production manifest normalization/hash checks with the
                # actual local model; transport only is in-process for this smoke.
                return asr.asr_part(payload, store) if path == "/v1/asr/parts" else asr.asr(payload, store)
        speech = asr_adapter(LocalASRTransport())
        def optical(ref, scope):
            return ocr.ocr({"object_key": ref["object_key"], "tenant_id": scope["tenant_id"], "workspace_id": scope["workspace_id"]}, store)
        body = {**scope, "video_job_id": job, "stage": "process", "stage_attempt": 2, "fencing_token": 2, "input_manifest": source, "asset": {"profile_version": 1},
                "profile": {"required_capabilities": ["transcript", "vision", "ocr"], "language": "en", "frame_interval_ms": 2000, "max_frames": 8}}
        started = time.monotonic()
        try:
            result = Processor(objects, speech, optical).process(body, folder, {}, lambda _: None, lambda: None)
        except Exception as error:
            # Only this opt-in generated fixture prints diagnostics; service responses never do.
            if hasattr(error, "diagnostic_stderr"):
                print(error.diagnostic_stderr.decode("utf-8", "replace"))
            raise
        all_segments = []
        for part in result["transcript"]["parts"]:
            all_segments.extend(json.loads(objects.read(part, scope, job))["segments"])
        spoken = " ".join(s["text"] for s in all_segments if s["kind"] == "asr")
        optical_text = " ".join(s["text"] for s in all_segments if s["kind"] == "ocr")
        report["multimodal"] = {"input_sha256": ref["sha256"], "source_phrase": phrase, "recognized_asr": spoken, "recognized_ocr": optical_text,
                                "frame_count": len(result["frames"]), "coverage": result["coverage"], "usage": result["usage"], "asr_manifest_parts_verified": True, "elapsed_seconds": time.monotonic() - started,
                                "passed": bool(spoken) and "WEAVE TEST 42" in optical_text and all(x in result["coverage"]["completed"] for x in ("transcript", "vision", "ocr"))}
    report["passed"] = report["silence"]["passed"] and report["multimodal"]["passed"]
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
