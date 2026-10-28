"""Bounded FFmpeg processing, resumable audio chunks, and sampled visual provenance."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
from decimal import Decimal

from core import Failure, canonical, sha, segment_parts, disk_guard, SCRATCH_BUDGET

PROCESSOR = "weavesense-video-v1"
CONTROL_FAILURES = {"MODEL_PENDING", "HOST_OUTCOME_PENDING", "USAGE_OUTCOME_UNKNOWN", "EXECUTION_AUTHORIZATION_LOST", "EXECUTION_FENCED", "STORAGE_PRESSURE", "TEMPORARY_RESOURCE_LIMIT", "PROCESSOR_OUTPUT_LIMIT"}


def processing_mode(body):
    mode = body.get("asset", {}).get("processing_mode") or body["profile"].get("processing_mode", "subtitles_first")
    mode = {"subtitle_first": "subtitles_first", "multimodal": "full_video"}.get(mode, mode)
    if mode not in ("subtitles_first", "audio", "full_video", "visual_required"):
        raise Failure("INVALID_PROCESSING_MODE", 400)
    return mode


def media_limits(profile):
    maximum = int(profile.get("max_video_bytes", profile.get("max_bytes", 200 * 1024 * 1024)))
    seconds = int(profile.get("max_duration_ms", profile.get("max_seconds", 10800) * 1000)) / 1000
    if maximum <= 0 or seconds <= 0:
        raise Failure("INVALID_PROFILE", 400)
    return min(maximum, int(os.environ.get("VIDEO_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))), min(seconds, 43200)


def command(args, timeout=120):
    if args[0] == "ffmpeg":
        args = [args[0], "-filter_threads", "1", "-filter_complex_threads", "1", *args[1:]]
    try:
        # Scene diagnostics are input-sized. Spool bounded output rather than
        # capture_output accumulating a long recording's stderr in RAM.
        temp_root = (SCRATCH_BUDGET.get() or {}).get("root") or os.environ.get("VIDEO_TEMP_ROOT") or None
        with tempfile.TemporaryFile(dir=temp_root) as out, tempfile.TemporaryFile(dir=temp_root) as err:
            process = subprocess.Popen(args, stdout=out, stderr=err)
            started = time.monotonic()
            try:
                while process.poll() is None:
                    if time.monotonic() - started > timeout:
                        raise Failure("PROCESSOR_TIMEOUT", 504, True)
                    disk_guard(temp_root or tempfile.gettempdir())
                    if out.tell() + err.tell() > 8 * 1024 * 1024:
                        raise Failure("PROCESSOR_OUTPUT_LIMIT", 413)
                    time.sleep(.02)
            except BaseException:
                process.kill()
                process.wait()
                raise
            if out.tell() + err.tell() > 8 * 1024 * 1024:
                raise Failure("PROCESSOR_OUTPUT_LIMIT", 413)
            out.seek(0)
            err.seek(0)
            result = subprocess.CompletedProcess(args, process.returncode, out.read(), err.read())
    except FileNotFoundError:
        raise Failure("PROCESSOR_NOT_CONFIGURED", 503) from None
    if result.returncode:
        # Do not include ffmpeg stderr: it can contain private filenames or source metadata.
        error = Failure("UNSUPPORTED_MEDIA", 415)
        error.diagnostic_stderr = result.stderr[-4096:]
        raise error
    return result


def probe(path, max_seconds=10800):
    with open(path, "rb") as stream:
        magic = stream.read(16)
    media = magic.startswith((b"ID3", b"OggS", b"fLaC", b"\x1a\x45\xdf\xa3")) or magic[4:8] == b"ftyp" or (magic[:4] == b"RIFF" and magic[8:12] in (b"WAVE", b"AVI ")) or (len(magic) > 1 and magic[0] == 255 and magic[1] & 224 == 224)
    if not media:
        raise Failure("UNSUPPORTED_MEDIA", 415)
    result = command(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type,width,height,duration,avg_frame_rate", "-of", "json", str(path)], 30)
    try:
        info = json.loads(result.stdout)
        seconds = float(info["format"]["duration"])
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError()
        if seconds > max_seconds:
            raise Failure("LIMIT_EXCEEDED", 413)
        if any(s.get("width", 0) * s.get("height", 0) > 3840 * 2160 for s in info["streams"]):
            raise Failure("LIMIT_EXCEEDED", 413)
        visual = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
        numerator, denominator = visual.get("avg_frame_rate", "10/1").split("/")
        fps = float(numerator) / max(1, float(denominator))
        return {"duration_ms": int(math.ceil(seconds * 1000)), "audio": any(s["codec_type"] == "audio" for s in info["streams"]),
                "video": bool(visual), "video_duration_ms": int(float(visual.get("duration", seconds)) * 1000), "frame_period_ms": max(1, math.ceil(1000 / max(1, fps)))}
    except (ValueError, KeyError, TypeError):
        raise Failure("UNSUPPORTED_MEDIA", 415) from None


def chunk_plan(duration_ms, chunk_ms=60000, overlap_ms=1500):
    if not 1000 <= chunk_ms <= 300000 or not 0 <= overlap_ms < chunk_ms / 2:
        raise Failure("INVALID_PROFILE", 400)
    return [{"index": i, "start_ms": max(0, start - overlap_ms), "end_ms": min(duration_ms, start + chunk_ms + overlap_ms),
             "core_start_ms": start, "core_end_ms": min(duration_ms, start + chunk_ms)}
            for i, start in enumerate(range(0, duration_ms, chunk_ms))]


def normalize_subtitles(payload, language=None, duration_ms=None):
    """Canonical source segments, with no fabricated speakers or timestamps."""
    if isinstance(payload, dict) and isinstance(payload.get("tracks"), list):
        # Keep the original multi-track object; select a valid manual track before
        # automatic captions without hiding a provider authentication failure.
        errors = []
        for kind in ("manual", "automatic"):
            for track in payload["tracks"]:
                if isinstance(track, dict) and track.get("kind") == kind and "tracks" not in track:
                    try:
                        return normalize_subtitles(track, language, duration_ms)
                    except Failure as exc:
                        errors.append(exc)
        raise errors[0] if errors else Failure("NO_SUBTITLES")
    if not isinstance(payload, dict) or payload.get("kind") not in ("manual", "automatic") or not isinstance(payload.get("segments"), list):
        raise Failure("INVALID_SUBTITLES")
    if language and payload.get("language") != language:
        raise Failure("SUBTITLE_LANGUAGE_MISMATCH")
    out, previous = [], -1
    for item in payload["segments"]:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
            raise Failure("INVALID_SUBTITLES")
        start, end = item.get("start_ms"), item.get("end_ms")
        if type(start) is not int or type(end) is not int or start < 0 or end <= start or start < previous or (duration_ms is not None and end > duration_ms):
            raise Failure("INVALID_SUBTITLE_TIME")
        previous = start
        out.append({"text": item["text"].strip(), "start_ms": start, "end_ms": end, "kind": "subtitle", "alignment_method": "source_segment",
                    "language": payload.get("language"), "subtitle_kind": payload["kind"]})
    if not out:
        raise Failure("NO_SUBTITLES")
    return out


def merge_chunks(chunks):
    """Keep each segment in its midpoint's non-overlapping core, then exact seam dedupe.

    Overlap improves recognition but is not a claim of word-accurate timing. Gaps
    without ASR segments are unknown (not automatically labelled silence).
    """
    out = []
    for chunk in chunks:
        for seg in chunk["segments"]:
            start, end = seg["start_ms"], seg["end_ms"]
            midpoint = (start + end) / 2
            if not chunk["core_start_ms"] <= midpoint < chunk["core_end_ms"]:
                continue
            if out and seg["text"] == out[-1]["text"] and start <= out[-1]["end_ms"]:
                continue
            out.append(seg)
    return out


def speech_intervals(segments):
    merged = []
    for start, end in sorted((s["start_ms"], s["end_ms"]) for s in segments if s.get("start_ms") is not None):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def complement(intervals, duration):
    gaps, cursor = [], 0
    for start, end in intervals:
        if start > cursor:
            gaps.append([cursor, start])
        cursor = max(cursor, end)
    if cursor < duration:
        gaps.append([cursor, duration])
    return gaps


def extract_frames(path, directory, info, interval_ms=10000, maximum=120, scene_threshold=0.35, active=lambda: None):
    if not info["video"]:
        raise Failure("VISUAL_UNAVAILABLE")
    if not 1000 <= interval_ms <= 60000 or not 1 <= maximum <= 1000 or not 0 < scene_threshold < 1:
        raise Failure("INVALID_PROFILE", 400)
    duration = info.get("video_duration_ms", info["duration_ms"])
    directory.mkdir(parents=True, exist_ok=True)
    active()
    # Scene timestamps from decoded frames; a time grid guarantees short/tail coverage.
    result = command(["ffmpeg", "-nostdin", "-v", "info", "-protocol_whitelist", "file,pipe", "-i", str(path), "-vf", f"select='gt(scene,{scene_threshold})',showinfo", "-an", "-f", "null", "-"], 120)
    scene = [int(float(t) * 1000) for t in re.findall(rb"pts_time:([0-9.]+)", result.stderr)]
    candidates = sorted(set([0, max(0, duration - min(info.get("frame_period_ms", 100), duration))] + list(range(0, duration, interval_ms)) + [t for t in scene if 0 <= t < duration]))
    truncated = len(candidates) > maximum
    if truncated:
        # Spread the budget over the full span rather than silently taking only the start.
        indices = sorted(set(round(i * (len(candidates) - 1) / max(1, maximum - 1)) for i in range(maximum)))
        chosen = [candidates[i] for i in indices]
    else:
        chosen = candidates
    frames = []
    for index, timestamp in enumerate(chosen):
        active()
        disk_guard(directory, 10 * 1024 * 1024)
        target = directory / f"frame-{index:05d}.jpg"
        result = command(["ffmpeg", "-nostdin", "-v", "info", "-ss", str(timestamp / 1000), "-copyts", "-protocol_whitelist", "file,pipe", "-i", str(path), "-frames:v", "1", "-vf", "showinfo,scale=960:-2:out_range=full,format=yuvj420p", "-threads", "1", "-y", str(target)], 45)
        if not target.is_file() or target.stat().st_size == 0:
            raise Failure("FRAME_EXTRACTION_FAILED", 422, True)
        actual = re.search(rb"pts_time:([0-9.]+)", result.stderr)
        if not actual:
            raise Failure("FRAME_TIMESTAMP_UNKNOWN")
        frames.append({"frame_id": f"frame-{index:05d}", "timestamp_ms": round(float(actual[1]) * 1000), "requested_timestamp_ms": timestamp, "path": target, "sample_reason": "scene" if timestamp in scene else "grid"})
    return frames, {"strategy": "scene_plus_time_grid", "interval_ms": interval_ms, "scene_threshold": scene_threshold,
                    "budget_limited": truncated, "sampled_timestamps_ms": [f["timestamp_ms"] for f in frames], "full_frame_analysis": False, "duration_ms": duration}


def frame_grids(frames, directory, cols=3, rows=3):
    # Adapted BiliNote grouping idea; keep every tail and never read a shared directory.
    from PIL import Image, ImageDraw
    directory.mkdir(parents=True, exist_ok=True)
    grids = []
    for index in range(0, len(frames), cols * rows):
        group = frames[index:index + cols * rows]
        grid = Image.new("RGB", (cols * 320, math.ceil(len(group) / cols) * 200), "white")
        for offset, frame in enumerate(group):
            with Image.open(frame["path"]) as image:
                tile = image.convert("RGB")
                tile.thumbnail((320, 180))
                x, y = offset % cols * 320, offset // cols * 200
                grid.paste(tile, (x, y))
                ImageDraw.Draw(grid).text((x + 4, y + 182), f"{frame['frame_id']} {frame['timestamp_ms']} ms", fill="black")
        target = directory / f"grid-{index // (cols * rows):05d}.jpg"
        disk_guard(directory, 4 * 1024 * 1024)
        grid.save(target, quality=85)
        grids.append({"path": target, "frame_ids": [f["frame_id"] for f in group]})
    return grids


def numeric_disagreements(audio, visual_text, frame):
    """Only explicit label=value+unit disagreement candidates, never truth claims."""
    def fields(text):
        found = {}
        normalized = unicodedata.normalize("NFKC", text).casefold()
        for clause in re.split(r"[\n;；,，]", normalized):
            match = re.fullmatch(r"\s*([^:=\n]{1,40}?)\s*[:=]\s*([+-]?\d+(?:\.\d+)?)\s*([^\W\d_]+(?:/[^\W\d_]+)?|[%°][^\W\d_]*)\s*", clause)
            if match:
                key = (" ".join(match[1].split()), match[3])
                found.setdefault(key, set()).add(Decimal(match[2]))
        return {key: next(iter(values)) for key, values in found.items() if len(values) == 1}
    candidates, skipped = [], 0
    if len(visual_text.encode()) > 8192:
        return [], {"strategy": "explicit_label_unit_numeric", "oversized_text_skipped": 1, "truncated": False}
    visual = fields(visual_text)
    for segment in audio:
        if len(segment["text"].encode()) > 8192:
            skipped += 1
            continue
        spoken = fields(segment["text"])
        for label, unit in sorted(spoken.keys() & visual.keys()):
            if spoken[(label, unit)] == visual[(label, unit)]:
                continue
            candidates.append({"relation": "numeric_disagreement_candidate", "review_status": "unreviewed", "truth_status": "not_asserted", "label": label, "unit": unit,
                "audio_value": format(spoken[(label, unit)], "f"), "visual_value": format(visual[(label, unit)], "f"),
                "audio": {k: segment[k] for k in ("text", "start_ms", "end_ms")} | {"text_sha256": sha(segment["text"].encode())},
                "visual": {"text": visual_text, "start_ms": frame["timestamp_ms"], "end_ms": frame["timestamp_ms"], "frame_ref": frame["object_key"], "text_sha256": sha(visual_text.encode())}})
    return candidates[:8], {"strategy": "explicit_label_unit_numeric", "oversized_text_skipped": skipped, "truncated": len(candidates) > 8}


class Processor:
    def __init__(self, objects, asr=None, ocr=None, gateway=None, meter=None):
        self.objects, self.asr, self.ocr, self.gateway, self.meter = objects, asr, ocr, gateway, meter

    def identity(self, body, kind):
        # Remote worker/model identities and FFmpeg's dynamically linked build
        # are not pinned by this process. Do not guess a reusable media identity.
        capabilities = body["profile"].get("required_capabilities", body["profile"].get("required", ["transcript"])) + body["profile"].get("optional_capabilities", body["profile"].get("optional", []))
        if kind != "platform_subtitles" or set(capabilities) - {"transcript"}:
            return None
        files = {name: sha((Path(__file__).parent / name).read_bytes()) for name in ("media.py", "core.py", "runtime.py")}
        return sha(canonical({"source_files": files, "python": sys.version, "profile": body["profile"], "mode": processing_mode(body)}))

    def visual_parts(self, scope, job, records):
        refs, batch = [], []
        def flush():
            if not batch:
                return
            ref = self.objects.put(scope, job, canonical({"records": batch}), f"visual-{len(refs):05d}.json")
            refs.append({**ref, "record_count": len(batch), "start_ms": min(x["start_ms"] for x in batch), "end_ms": max(x["end_ms"] for x in batch)})
            batch.clear()
        for record in records:
            record["record_id"] = sha(canonical(record))
            if len(canonical({"records": [record]})) > 256 * 1024:
                raise Failure("VISUAL_RECORD_TOO_LARGE", 413)
            if len(batch) == 100 or len(canonical({"records": batch + [record]})) > 256 * 1024:
                flush()
            batch.append(record)
        flush()
        return {"schema_version": 1, "parts": refs, "record_count": len(records)}

    def process(self, body, directory, checkpoint, save, active):
        scope, job = body, body["video_job_id"]
        manifest, profile = body["input_manifest"], body["profile"]
        if manifest.get("schema_version") != 1 or manifest.get("artifact_stage") != "input_ready" or manifest.get("video_job_id") != job or not manifest.get("objects"):
            raise Failure("INVALID_INPUT_MANIFEST")
        if manifest.get("input_kind") not in ("media", "platform_subtitles"):
            raise Failure("INVALID_INPUT_MANIFEST")
        required = profile.get("required_capabilities", profile.get("required", ["transcript"]))
        optional = profile.get("optional_capabilities", profile.get("optional", []))
        if not isinstance(required, list) or not isinstance(optional, list) or set(required + optional) - {"transcript", "vision", "ocr", "vlm", "summary"}:
            raise Failure("INVALID_PROFILE", 400)
        if not required:
            raise Failure("INVALID_PROFILE", 400)
        mode = processing_mode(body)
        if mode == "audio" and set(required) & {"vision", "ocr", "vlm"}:
            raise Failure("PROCESSING_MODE_CONFLICT", 400)
        if mode == "visual_required" and "vision" not in required:
            raise Failure("VISION_PROFILE_REQUIRED", 400)
        if mode != "subtitles_first" and manifest["input_kind"] != "media":
            raise Failure("PROCESSING_MODE_REQUIRES_MEDIA", 422)
        objects, parts, frames, completed, missing_optional, text_segments = [], [], [], [], [], []
        visual_records = []
        coverage = {"required": required, "completed": completed, "missing": [], "optional_missing": missing_optional, "processing_mode": mode}
        usage = checkpoint.setdefault("usage", {"asr_seconds": 0, "ocr_requests": 0, "frame_count": 0, "model_tasks": []})
        active()
        if manifest["input_kind"] == "platform_subtitles":
            if manifest.get("media_sha256") is not None or manifest.get("availability") != "not_acquired":
                raise Failure("INVALID_INPUT_MANIFEST")
            raw = self.objects.read(manifest["objects"][0], scope, job, 8 * 1024 * 1024)
            if sha(raw) != manifest["input_hash"]:
                raise Failure("INPUT_HASH_MISMATCH")
            segments = normalize_subtitles(json.loads(raw), profile.get("language"), profile.get("duration_ms"))
            text_segments.extend(segments)
            refs, parts = segment_parts(self.objects, scope, job, segments)
            objects.extend(refs)
            completed.append("transcript")
            coverage.update({"duration_ms": profile.get("duration_ms"), "intervals": {"speech": speech_intervals(segments), "processed": [], "unknown": [], "silence": []}, "scope": "provided_subtitles"})
        else:
            ref = manifest["objects"][0]
            if ref["sha256"] != manifest.get("media_sha256") or ref["sha256"] != manifest.get("input_hash") or manifest.get("availability") != "available":
                raise Failure("INPUT_HASH_MISMATCH")
            path = directory / "input.media"
            maximum, max_seconds = media_limits(profile)
            self.objects.materialize(ref, scope, job, path, maximum)
            info = probe(path, max_seconds)
            duration = info["duration_ms"]
            usage.update(media_duration_ms=duration, input_bytes=ref["bytes"])
            coverage["duration_ms"] = duration
            all_segments = []
            try:
                if "transcript" in required + optional:
                    if not info["audio"]:
                        completed.append("transcript")
                        coverage.update({"transcript_status": "no_audio", "intervals": {"processed": [[0, duration]], "speech": [], "silence": [[0, duration]], "unknown": []}})
                    elif not self.asr:
                        if "transcript" in required:
                            raise Failure("ASR_NOT_CONFIGURED", 503)
                        missing_optional.append("transcript")
                    else:
                        chunks = checkpoint.setdefault("chunks", {})
                        chunk_ms = int(profile.get("chunk_ms", 60000))
                        plan = chunk_plan(duration, chunk_ms, min(1500, chunk_ms // 4))
                        results = []
                        for item in plan:
                            active()
                            key = str(item["index"])
                            saved = chunks.get(key)
                            if saved:
                                # A checkpoint is reusable only while its immutable object verifies.
                                try:
                                    payload = json.loads(self.objects.read(saved["object"], scope, job))
                                    results.append({**item, "segments": payload["segments"]})
                                    usage["asr_chunk_cache_hits"] = usage.get("asr_chunk_cache_hits", 0) + 1
                                    continue
                                except (Failure, KeyError, ValueError):
                                    chunks.pop(key, None)
                            audio = directory / f"audio-{item['index']:05d}.wav"
                            disk_guard(directory, (item["end_ms"] - item["start_ms"]) * 32 + 4096)
                            command(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(item["start_ms"] / 1000), "-protocol_whitelist", "file,pipe", "-i", str(path), "-t", str((item["end_ms"] - item["start_ms"]) / 1000), "-vn", "-ac", "1", "-ar", "16000", "-threads", "1", "-y", str(audio)])
                            audio_ref = self.objects.put_file(scope, job, audio, "audio.wav", "audio/wav", 32 * 1024 * 1024)
                            started = time.monotonic()
                            invoke = lambda: self.asr(audio_ref, scope, profile.get("language"))
                            result = self.meter.local(body, "asr_seconds", f"asr:{item['index']}:{audio_ref['sha256']}", math.ceil((item["end_ms"] - item["start_ms"]) / 1000), invoke, checkpoint, save, active) if self.meter else invoke()
                            checkpoint.setdefault("processors", {})["asr"] = {"engine": result.get("engine"), "model_lock": result.get("model_lock")}
                            for part in result.get("parts", []):
                                self.objects.record({k: part[k] for k in ("object_key", "sha256", "bytes")} | {"content_type": "application/json"})
                            usage["asr_seconds"] += time.monotonic() - started
                            usage["audio_ms"] = usage.get("audio_ms", 0) + item["end_ms"] - item["start_ms"]
                            save(checkpoint)  # usage survives a cancellation or malformed model response.
                            active()
                            if not isinstance(result.get("segments"), list):
                                raise Failure("ASR_CONTRACT_CHANGED", 502)
                            segments = []
                            for segment in result["segments"]:
                                start, end = segment.get("start"), segment.get("end")
                                if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not math.isfinite(start + end) or start < 0 or end < start or end * 1000 > item["end_ms"] - item["start_ms"] + 1000 or not isinstance(segment.get("text"), str):
                                    raise Failure("ASR_INVALID_TIMELINE", 502)
                                segments.append({"text": segment["text"], "start_ms": item["start_ms"] + round(start * 1000), "end_ms": min(duration, item["start_ms"] + round(end * 1000)), "kind": "asr", "alignment_method": "asr_segment", "language": result.get("language"), "engine": result.get("engine")})
                            chunk_ref = self.objects.put(scope, job, canonical({"segments": segments}), "chunk.json")
                            chunks[key] = {"object": chunk_ref, "input_sha256": audio_ref["sha256"], "status": "completed", **item}
                            save(checkpoint)
                            results.append({**item, "segments": segments})
                            audio.unlink(missing_ok=True)
                        all_segments = merge_chunks(results)
                        text_segments.extend(all_segments)
                        refs, parts = segment_parts(self.objects, scope, job, all_segments)
                        objects.extend(refs)
                        completed.append("transcript")
                        speech = speech_intervals(all_segments)
                        coverage.update({"transcript_status": "ok" if all_segments else "no_speech_detected", "chunk_manifest": list(chunks.values()),
                                         "intervals": {"processed": [[0, duration]], "speech": speech, "silence": [], "unknown": complement(speech, duration)}})
            except Failure as exc:
                if "transcript" in required or exc.code in CONTROL_FAILURES:
                    raise
                missing_optional.append("transcript")
                coverage["transcript_error"] = exc.code
            visual_requested = set(required + optional) & {"vision", "ocr", "vlm"}
            if mode == "audio":
                missing_optional.extend(sorted(visual_requested))
                visual_requested = set()
            if visual_requested:
                try:
                    sampled, visual_coverage = extract_frames(path, directory / "frames", info, int(profile.get("frame_interval_ms", 10000)), int(profile.get("max_frames", 120)), active=active)
                    for frame in sampled:
                        active()
                        ref = self.objects.put_file(scope, job, frame["path"], frame["frame_id"] + ".jpg", "image/jpeg", 10 * 1024 * 1024)
                        objects.append(ref)
                        frames.append({k: v for k, v in {**frame, **ref, "media_sha256": manifest["media_sha256"]}.items() if k != "path"})
                        visual_records.append({"type": "frame", "frame_id": frame["frame_id"], "frame_ref": ref["object_key"], "frame_sha256": ref["sha256"], "start_ms": frame["timestamp_ms"], "end_ms": frame["timestamp_ms"], "media_sha256": manifest["media_sha256"]})
                    for grid in frame_grids(sampled, directory / "grids"):
                        ref = self.objects.put_file(scope, job, grid["path"], grid["path"].name, "image/jpeg", 10 * 1024 * 1024)
                        objects.append(ref)
                    usage["frame_count"] = len(frames)
                    coverage["visual"] = visual_coverage
                    completed.append("vision")
                    try:
                        if "ocr" in visual_requested:
                            if not self.ocr:
                                raise Failure("OCR_NOT_CONFIGURED", 503)
                            ocr_segments = []
                            for frame in frames:
                                active()
                                ocr_cache = checkpoint.setdefault("ocr", {})
                                if frame["sha256"] in ocr_cache:
                                    text = ocr_cache[frame["sha256"]]
                                    usage["ocr_cache_hits"] = usage.get("ocr_cache_hits", 0) + 1
                                else:
                                    invoke = lambda: self.ocr(frame, scope)
                                    result = self.meter.local(body, "ocr_pages", "ocr:" + frame["sha256"], 1, invoke, checkpoint, save, active) if self.meter else invoke()
                                    text = result["text"]
                                    checkpoint.setdefault("processors", {})["ocr"] = {"engine": result.get("engine")}
                                    usage["ocr_requests"] += 1
                                    ocr_cache[frame["sha256"]] = text
                                    save(checkpoint)
                                if text:
                                    ocr_segments.append({"text": text, "start_ms": frame["timestamp_ms"], "end_ms": frame["timestamp_ms"], "kind": "ocr", "frame_ref": frame["object_key"], "alignment_method": "sampled_frame", "review_status": "unreviewed"})
                                    visual_records.append({"type": "ocr", "text": text, "observed_text": text, "frame_id": frame["frame_id"], "frame_ref": frame["object_key"], "frame_sha256": frame["sha256"], "start_ms": frame["timestamp_ms"], "end_ms": frame["timestamp_ms"], "media_sha256": manifest["media_sha256"], "review_status": "unreviewed"})
                            refs, ocr_parts = segment_parts(self.objects, scope, job, ocr_segments)
                            text_segments.extend(ocr_segments)
                            objects.extend(refs)
                            parts.extend(ocr_parts)
                            completed.append("ocr")
                    except Failure as exc:
                        if "ocr" in required or exc.code in CONTROL_FAILURES:
                            raise
                        missing_optional.append("ocr")
                        coverage["ocr_error"] = exc.code
                    if "vlm" in visual_requested:
                        if not self.gateway:
                            raise Failure("VLM_NOT_CONFIGURED", 503)
                        observations = self.gateway.observe(body, frames, checkpoint, save, active)
                        valid = {f["frame_id"] for f in frames}
                        for observation in observations:
                            frame_ids = observation.get("frame_ids")
                            if observation.get("kind") not in ("observation", "inference") or not isinstance(frame_ids, list) or not frame_ids or any(not isinstance(ident, str) for ident in frame_ids) or len(set(frame_ids)) != len(frame_ids) or set(frame_ids) - valid or not isinstance(observation.get("text"), str):
                                raise Failure("INVALID_VISUAL_OBSERVATION", 502)
                            observation["review_status"] = "unreviewed"
                            by_id = {f["frame_id"]: f for f in frames}
                            observed_frames = [by_id[ident] for ident in frame_ids]
                            visual_records.append({"type": "model_" + observation["kind"], "derived": True, "text": observation["text"], "frame_ids": observation["frame_ids"], "frame_refs": [f["object_key"] for f in observed_frames], "start_ms": min(f["timestamp_ms"] for f in observed_frames), "end_ms": max(f["timestamp_ms"] for f in observed_frames), "media_sha256": manifest["media_sha256"], "review_status": "unreviewed", "provenance": {"model_tasks": usage.get("model_tasks", [])}})
                        completed.append("vlm")
                except Failure as exc:
                    if exc.code in CONTROL_FAILURES or (visual_requested & set(required)) - set(completed):
                        raise
                    missing_optional.extend(sorted(visual_requested - set(completed)))
                    coverage["visual_error"] = exc.code
        if "summary" in required + optional:
            if not self.gateway:
                if "summary" in required:
                    raise Failure("MODEL_GATEWAY_NOT_CONFIGURED", 503)
            else:
                try:
                    summary = self.gateway.summarize(body, text_segments, frames, checkpoint, save, active)
                    objects.append(self.objects.put(scope, job, canonical(summary), "summary.json"))
                    completed.append("summary")
                except Failure as exc:
                    if "summary" in required or exc.code in CONTROL_FAILURES:
                        raise
                    coverage["summary_error"] = exc.code
        # ASR and OCR are interleaved in the immutable canonical timeline. Appending
        # early OCR frames after the final spoken segment would violate host spans.
        text_segments.sort(key=lambda s: (s.get("start_ms") is None, s.get("start_ms") or 0, s.get("end_ms") or 0))
        for frame in frames:
            audio = [s for s in text_segments if s.get("kind") in ("asr", "subtitle") and s.get("start_ms") is not None and s["start_ms"] <= frame["timestamp_ms"] <= s["end_ms"]]
            candidates, scan = numeric_disagreements(audio[:32], checkpoint.get("ocr", {}).get(frame["sha256"], ""), frame)
            visual_records.append({"type": "alignment", "frame_id": frame["frame_id"], "frame_ref": frame["object_key"], "start_ms": frame["timestamp_ms"], "end_ms": frame["timestamp_ms"], "relation": "temporal_overlap" if audio else "unaligned", "audio_segments": [{"start_ms": s["start_ms"], "end_ms": s["end_ms"], "text_sha256": sha(s["text"].encode())} for s in audio[:32]], "truncated": len(audio) > 32, "semantic_relation": "not_assessed", "conflict_candidates": candidates, "conflict_scan": scan})
        visual = self.visual_parts(scope, job, visual_records)
        objects.extend(visual["parts"])
        refs, parts = segment_parts(self.objects, scope, job, text_segments)
        by_key = {ref["object_key"]: ref for ref in objects + refs}
        objects = list(by_key.values())
        absent = set(required) - set(completed)
        if absent:
            raise Failure("REQUIRED_MODALITY_MISSING")
        missing_optional.extend(sorted(set(optional) - set(completed) - set(missing_optional)))
        active()
        parent_hash = sha(canonical({**manifest, "stage_attempt": 0, "fencing_token": 0}))
        if body.get("input_manifest_sha256", parent_hash) != parent_hash:
            raise Failure("INPUT_HASH_MISMATCH")
        return {"schema_version": 1, "artifact_stage": "processing_complete", "video_job_id": job, "stage_attempt": body["stage_attempt"], "fencing_token": body["fencing_token"],
                "input_kind": manifest["input_kind"], "input_hash": manifest["input_hash"], "media_sha256": manifest["media_sha256"], "availability": manifest["availability"],
                "parent_manifest_sha256": parent_hash, "objects": objects, "transcript": {"parts": parts}, "frames": frames, "visual": visual,
                "coverage": coverage, "processors": {"version": PROCESSOR, "processing_identity": self.identity(body, manifest["input_kind"]), "profile_version": body.get("asset", {}).get("profile_version", profile.get("version")), "config_sha256": sha(canonical(profile)), **checkpoint.get("processors", {})}, "usage": usage}
