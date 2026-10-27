import json
import hashlib
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server

MP3 = b"ID3\x04\x00" + b"0" * 64
KEY = "tenants/tn_a/workspaces/ws_a/telegram/chan/7"


class Resp:
    def __init__(self, data):
        self.data = data

    def read(self, n):
        return self.data[:n]

    def close(self):
        pass

    def release_conn(self):
        pass


class Store:
    def __init__(self, objects):
        self.objects = objects

    def get_object(self, bucket, key):
        if key not in self.objects:
            raise KeyError(key)
        return Resp(self.objects[key])

    def put_object(self, bucket, key, data, length, **kwargs):
        self.objects[key] = data.read()


def fake_runner(data, language):
    return "储能 电站 并网", 42, language or "zh", [{"start": 0.0, "end": 42.0, "text": "储能 电站 并网"}]


class AsrTest(unittest.TestCase):
    def test_model_lock_required_and_all_files_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            files = []
            for name in ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt"):
                raw = name.encode()
                (directory / name).write_bytes(raw)
                files.append({"name": name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
            lock = directory / "model-lock.json"
            lock.write_text(json.dumps({"repository": "Systran/faster-whisper-tiny", "revision": "a" * 40, "files": files}))
            with patch.dict(os.environ, {"ASR_MODEL_DIR": tmp, "ASR_MODEL_MANIFEST": str(lock)}):
                self.assertEqual(server.verified_model_directory()[0], directory)
                (directory / "model.bin").write_bytes(b"modified")
                with self.assertRaises(server.AsrError) as err:
                    server.verified_model_directory()
                self.assertEqual(err.exception.code, "model_lock_invalid")
                lock.write_text(json.dumps({"repository": "Systran/faster-whisper-tiny", "revision": "main", "files": files}))
                with self.assertRaises(server.AsrError):
                    server.verified_model_directory()

    def test_long_output_manifest_keeps_tail_and_all_segments(self):
        segments = [{"text": "中" * 200 + str(i), "start": i, "end": i + 1} for i in range(2101)]
        text = " ".join(s["text"] for s in segments)
        store = Store({KEY: MP3})
        body = {"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a", "output_format": "manifest"}
        result = server.asr(body, store, lambda *_: (text, 2101, "zh", segments))
        rebuilt = []
        for part in result["parts"]:
            rebuilt.extend(server.asr_part({"object_key": part["object_key"], "tenant_id": "tn_a", "workspace_id": "ws_a"}, store)["segments"])
        self.assertEqual(rebuilt, segments)
        self.assertGreater(len(text), 400000)
        self.assertEqual(result["segment_count"], 2101)
        body.pop("output_format")
        with self.assertRaises(server.AsrError) as err:
            server.asr(body, store, lambda *_: (text, 2101, "zh", segments))
        self.assertEqual(err.exception.code, "output_requires_manifest")

    def test_transcribes_scoped_audio(self):
        out = server.asr({"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a", "language": "zh"}, Store({KEY: MP3}), fake_runner)
        self.assertEqual(out["text"], "储能 电站 并网")
        self.assertEqual(out["seconds"], 42)
        self.assertEqual(out["language"], "zh")
        self.assertEqual(len(out["sha256"]), 64)

    def test_rejects_foreign_scope_and_traversal(self):
        for body in ({"object_key": KEY, "tenant_id": "tn_b", "workspace_id": "ws_a"},
                     {"object_key": "tenants/tn_a/workspaces/ws_a/../../x", "tenant_id": "tn_a", "workspace_id": "ws_a"}):
            with self.assertRaises(server.AsrError) as cm:
                server.asr(body, Store({KEY: MP3}), fake_runner)
            self.assertEqual(cm.exception.status, 403)

    def test_rejects_non_media_and_bad_requests(self):
        with self.assertRaises(server.AsrError) as cm:
            server.asr({"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a"}, Store({KEY: b"\x89PNG...."}), fake_runner)
        self.assertEqual(cm.exception.code, "unsupported")
        for body in (None, {"object_key": KEY}, {"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a", "extra": "x"},
                     {"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a", "language": "zh;rm"}):
            with self.assertRaises(server.AsrError):
                server.asr(body, Store({KEY: MP3}), fake_runner)
        with self.assertRaises(server.AsrError) as cm:
            server.asr({"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a"}, Store({}), fake_runner)
        self.assertEqual(cm.exception.status, 404)

    def test_media_magic(self):
        self.assertTrue(server.is_media(b"OggS...."))
        self.assertTrue(server.is_media(b"RIFF\x00\x00\x00\x00WAVEfmt "))
        self.assertTrue(server.is_media(b"\x00\x00\x00\x20ftypisom"))
        self.assertTrue(server.is_media(b"\xff\xfb\x90\x00"))
        self.assertFalse(server.is_media(b"%PDF-1.7"))

    def test_http_auth(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(lambda: Store({KEY: MP3}), fake_runner, token="t0k"))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_address[1]}/v1/asr"
        body = json.dumps({"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a"}).encode()
        try:
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(urllib.request.Request(url, body, {"Authorization": "Bearer nope", "Content-Type": "application/json"}))
            self.assertEqual(cm.exception.code, 401)
            r = urllib.request.urlopen(urllib.request.Request(url, body, {"Authorization": "Bearer t0k", "Content-Type": "application/json"}))
            self.assertEqual(json.loads(r.read())["seconds"], 42)
            manifest_body = json.dumps({"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a", "output_format": "manifest"}).encode()
            with urllib.request.urlopen(urllib.request.Request(url, manifest_body, {"Authorization": "Bearer t0k"})) as response:
                part = json.load(response)["parts"][0]
            request = json.dumps({"object_key": part["object_key"], "tenant_id": "tn_a", "workspace_id": "ws_a"}).encode()
            with urllib.request.urlopen(urllib.request.Request(url + "/parts", request, {"Authorization": "Bearer t0k"})) as response:
                raw = response.read()
            self.assertEqual(len(raw), part["bytes"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), part["sha256"])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_real_whisper_when_installed(self):
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            self.skipTest("faster-whisper not installed (image-level test)")
        if not os.environ.get("ASR_MODEL_DIR"):
            self.skipTest("explicit offline model lock not configured")
        import math
        import struct
        rate = 16000
        frames = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(rate))
        wav = b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(frames)) + frames
        out = server.asr({"object_key": KEY, "tenant_id": "tn_a", "workspace_id": "ws_a"}, Store({KEY: wav}))
        self.assertEqual(out["seconds"], 1)


if __name__ == "__main__":
    unittest.main()
