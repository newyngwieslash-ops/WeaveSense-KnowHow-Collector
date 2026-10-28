"""Repeatable synthetic LOCAL media calibration; never a production capacity/SLO claim."""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import platform
import resource
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen

from core import Objects, canonical, scope_key, sha
from media import Processor, command, probe
from runtime import Executor, Tasks
from server import handler

SIGNING_KEY = "synthetic-capacity-signing-key-not-a-real-secret"
SERVICE_TOKEN = "synthetic-local-capacity-only"


def percentile(values, fraction=.95):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


class FileResponse:
    def __init__(self, path):
        self.stream = path.open("rb")
    def read(self, *args):
        return self.stream.read(*args)
    def close(self):
        self.stream.close()
    def release_conn(self):
        self.close()


class LocalFileStore:
    """Test-only S3-shaped adapter with actual streamed, fsynced local writes, not MinIO."""
    def __init__(self, root):
        self.root, self.lock = Path(root), threading.Lock()
        self.put_count = self.written_bytes = 0
    def path(self, key):
        path = (self.root / key).resolve()
        path.relative_to(self.root.resolve())
        return path
    def put_object(self, bucket, key, data, length, **kwargs):
        path = self.path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            partial = Path(stream.name)
            try:
                while chunk := data.read(1024 * 1024):
                    written += len(chunk)
                    stream.write(chunk)
                if written != length:
                    raise ValueError("local object length mismatch")
                stream.flush()
                os.fsync(stream.fileno())
                os.replace(partial, path)
            finally:
                partial.unlink(missing_ok=True)
        with self.lock:
            self.put_count += 1
            self.written_bytes += written
    def get_object(self, bucket, key):
        return FileResponse(self.path(key))
    def remove_object(self, bucket, key):
        self.path(key).unlink(missing_ok=True)


class MeasuredTasks(Tasks):
    """Instrumentation delegates all admission/claim/fence/finish decisions to real Tasks."""
    def __init__(self, path):
        super().__init__(path)
        self.lock, self.spans, self.active_count, self.peak_active = threading.Lock(), {}, 0, 0
    def submit(self, body, authorization_until):
        began = time.monotonic()
        result = super().submit(body, authorization_until)
        with self.lock:
            self.spans.setdefault(result["task_id"], {"submitted": began})
        return result
    def claim(self, now=None):
        row = super().claim(now)
        if row:
            with self.lock:
                self.spans[row["id"]]["claimed"] = time.monotonic()
                self.active_count += 1
                self.peak_active = max(self.peak_active, self.active_count)
        return row
    def finish(self, row, state, **kwargs):
        result = super().finish(row, state, **kwargs)
        if result:
            with self.lock:
                self.spans[row["id"]]["finished"] = time.monotonic()
                self.active_count -= 1
        return result


def process_tree_rss():
    # Linux sampled sum-RSS includes shared-page double counting; not a precise cgroup peak.
    # PPid also works in runtimes that expose /proc/status but not task/*/children.
    processes = {}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = dict(line.split(":", 1) for line in (path / "status").read_text().splitlines() if ":" in line)
            processes[int(path.name)] = (int(fields["PPid"].strip()), int(fields.get("VmRSS", "0 kB").split()[0]) * 1024)
        except (OSError, ValueError, KeyError):
            pass  # A short-lived ffmpeg process may exit between these reads.
    pending, seen, total = [os.getpid()], set(), 0
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        total += processes.get(pid, (0, 0))[1]
        pending.extend(child for child, (parent, _) in processes.items() if parent == pid)
    return total


def machine(root):
    def cgroup(name):
        try:
            return Path("/sys/fs/cgroup", name).read_text().strip()
        except OSError:
            return None
    mem = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.split(":")[0] in ("MemTotal", "MemAvailable"):
                mem[line.split(":")[0]] = int(line.split()[1]) * 1024
    except OSError:
        pass
    disk = shutil.disk_usage(root)
    return {"os": platform.system(), "architecture": platform.machine(), "logical_cpus": os.cpu_count(),
            "affinity_cpus": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
            "cgroup_cpu_max": cgroup("cpu.max"), "cgroup_memory_max": cgroup("memory.max"),
            "host_memory_bytes_not_container_limit": mem, "disk_total_bytes": disk.total, "disk_free_bytes_before": disk.free,
            "filesystem_adapter": "local-fsync-file-store-not-minio", "python": platform.python_version(),
            "ffmpeg": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]}


def signed(body):
    now = int(time.time())
    claims = {"iss": "loom-engine", "aud": "video-knowledge", "actor": {"type": "service_principal", "id": "loom-engine"},
              "iat": now, "exp": now + 300, "scopes": ["video.execute"], "job_id": body["video_job_id"],
              **{k: body[k] for k in ("tenant_id", "workspace_id", "stage_attempt", "fencing_token")}}
    encode = lambda value: base64.urlsafe_b64encode(canonical(value)).decode().rstrip("=")
    unsigned = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode(claims)
    return unsigned + "." + base64.urlsafe_b64encode(hmac.new(SIGNING_KEY.encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def calibrate(root, jobs=6, concurrency=2, seconds=6.0, width=320, height=180):
    if not (2 <= jobs <= 20 and 1 <= concurrency <= min(jobs, 4) and .4 <= seconds <= 30 and jobs * seconds <= 120
            and 160 <= width <= 1280 and 90 <= height <= 720 and width % 2 == height % 2 == 0):
        raise ValueError("bounded calibration requires 2..20 jobs, 1..4 workers, .4..30 seconds, total <=120 seconds and even 160x90..1280x720 resolution")
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    metadata = machine(root)
    store = LocalFileStore(root / "objects")
    objects, tasks = Objects(store), MeasuredTasks(root / "execution.sqlite")
    source = root / "self-authored-testsrc.mp4"
    command(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate=10", "-t", str(seconds),
             "-c:v", "mpeg4", "-threads", "1", "-y", str(source)])
    duration_ms = probe(source)["duration_ms"]
    def spec(index):
        job = f"capacity_job_{index}"
        body = {"tenant_id": "capacity_fixture", "workspace_id": f"capacity_workspace_{index % 2}", "video_job_id": job,
                "stage": "process", "stage_attempt": 1, "fencing_token": 1, "intent_key": "capacity:" + job,
                "asset": {"processing_mode": "visual_required"},
                "profile": {"required_capabilities": ["vision", "ocr"], "frame_interval_ms": 1000, "max_frames": 60,
                            "max_duration_ms": 60000, "max_video_bytes": 32 * 1024 * 1024}}
        ref = objects.put_file(body, job, source, "source.mp4", "video/mp4", 32 * 1024 * 1024)
        body["input_manifest"] = {"schema_version": 1, "artifact_stage": "input_ready", "video_job_id": job,
                                  "input_kind": "media", "input_hash": ref["sha256"], "media_sha256": ref["sha256"],
                                  "availability": "available", "objects": [ref]}
        return body
    specs = [spec(index) for index in range(jobs)]
    # OCR itself is not benchmarked; real decoded image objects are checked before this fixture response.
    def ocr(ref, body):
        raw = objects.read(ref, body, body["video_job_id"], 8 * 1024 * 1024)
        if not raw.startswith(b"\xff\xd8"):
            raise AssertionError("real decoded JPEG required")
        return {"text": "self-authored capacity OCR fixture", "engine": "deterministic-fixture-not-a-model"}
    executor = Executor(tasks, objects, Processor(objects, ocr=ocr), temp_root=root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(tasks, executor, objects, None, SERVICE_TOKEN, SIGNING_KEY))
    serving = threading.Thread(target=server.serve_forever, daemon=True); serving.start()
    submissions, task_ids = [], []
    peak = {"process_tree_sum_rss_bytes": 0, "temporary_bytes": 0, "samples": 0}
    stop = threading.Event()
    def sample():
        while not stop.is_set():
            peak["process_tree_sum_rss_bytes"] = max(peak["process_tree_sum_rss_bytes"], process_tree_rss())
            total = 0
            for directory in root.glob("video-*"):
                try:
                    for path in directory.rglob("*"):
                        if path.is_file():
                            total += path.stat().st_size
                except OSError:
                    pass
            peak["temporary_bytes"] = max(peak["temporary_bytes"], total)
            peak["samples"] += 1
            stop.wait(.02)
    sampler = threading.Thread(target=sample, daemon=True)
    start_usage = [resource.getrusage(kind) for kind in (resource.RUSAGE_SELF, resource.RUSAGE_CHILDREN)]
    written_before, puts_before = store.written_bytes, store.put_count
    started = time.monotonic(); sampler.start()
    workers = []
    try:
        # Enqueue the finite burst before starting workers so queue wait is measurable and reproducible.
        for body in specs:
            begin = time.monotonic()
            request = Request(f"http://127.0.0.1:{server.server_address[1]}/v1/jobs", canonical(body),
                              {"Authorization": "Bearer " + SERVICE_TOKEN, "X-Flow-Execution-Context": signed(body), "Content-Type": "application/json"})
            with urlopen(request, timeout=10) as response:
                if response.status != 202:
                    raise AssertionError("worker submission was not accepted")
                task_ids.append(json.load(response)["task_id"])
            submissions.append((time.monotonic() - begin) * 1000)
        def work():
            while executor.run_once():
                pass
        workers = [threading.Thread(target=work, daemon=True) for _ in range(concurrency)]
        for worker in workers:
            worker.start()
        deadline = time.monotonic() + 180
        for worker in workers:
            worker.join(max(0, deadline - time.monotonic()))
        if any(worker.is_alive() for worker in workers):
            for task, body in zip(task_ids, specs):
                tasks.cancel(task, body)
            raise TimeoutError("bounded media calibration exceeded 180 seconds")
    finally:
        elapsed = time.monotonic() - started
        stop.set(); sampler.join(2)
        server.shutdown(); server.server_close(); serving.join(2)
    end_usage = [resource.getrusage(kind) for kind in (resource.RUSAGE_SELF, resource.RUSAGE_CHILDREN)]
    with tasks.db() as db:
        rows = [dict(db.execute("SELECT * FROM executions WHERE id=?", (task,)).fetchone()) for task in task_ids]
        if db.execute("SELECT count(*) FROM temporary_paths").fetchone()[0] != 0:
            raise AssertionError("temporary execution directories leaked")
    details = []
    for row, body in zip(rows, specs):
        if row["state"] != "completed":
            raise AssertionError("media calibration incomplete: " + str(row["error"]))
        result = json.loads(row["result"])
        if not {"vision", "ocr"} <= set(result["coverage"]["completed"]) or not result["frames"]:
            raise AssertionError("required real media artifacts absent")
        for ref in result["objects"]:
            scope_key(ref["object_key"], body, body["video_job_id"])
            if sha(objects.read(ref, body, body["video_job_id"], 32 * 1024 * 1024)) != ref["sha256"]:
                raise AssertionError("persisted object hash mismatch")
        span = tasks.spans[row["id"]]
        details.append({"video_job_id": body["video_job_id"], "state": row["state"], "frames": len(result["frames"]),
                        "object_count": len(result["objects"]), "manifest_sha256": sha(canonical(result)),
                        "queue_wait_ms": (span["claimed"] - span["submitted"]) * 1000,
                        "processing_ms": (span["finished"] - span["claimed"]) * 1000,
                        "worker_artifact_ready_ms": (span["finished"] - span["submitted"]) * 1000,
                        "worker_temporary_peak_bytes_observed": result["usage"]["temporary_peak_bytes_observed"]})
    measured_puts, measured_bytes = store.put_count - puts_before, store.written_bytes - written_before
    observed_peak_claimed = tasks.peak_active
    if observed_peak_claimed > concurrency:
        raise AssertionError("claimed task count exceeded configured worker count")
    # Safe real-watermark drill: raise the configured reserve above actual free space.
    # No disk filling, no OOM and no replacement of disk_guard or disk_usage.
    pressure_spec = spec(jobs)
    pressure_task = tasks.submit(pressure_spec, time.time() + 300)["task_id"]
    old_floor = os.environ.get("VIDEO_MIN_FREE_BYTES")
    try:
        os.environ["VIDEO_MIN_FREE_BYTES"] = str(shutil.disk_usage(root).total + 1)
        executor.run_once()
    finally:
        if old_floor is None:
            os.environ.pop("VIDEO_MIN_FREE_BYTES", None)
        else:
            os.environ["VIDEO_MIN_FREE_BYTES"] = old_floor
    with tasks.db() as db:
        pressure = dict(db.execute("SELECT * FROM executions WHERE id=?", (pressure_task,)).fetchone())
    if pressure["state"] != "failed" or json.loads(pressure["error"])["code"] != "STORAGE_PRESSURE" or pressure["result"]:
        raise AssertionError("configured storage watermark did not fail closed")
    initial_usage = json.loads(pressure["checkpoint"])["usage"]
    retry = tasks.retry(pressure_task, pressure_spec, time.time() + 300)
    if retry["task_id"] != pressure_task:
        raise AssertionError("explicit retry changed task identity")
    executor.run_once()
    with tasks.db() as db:
        recovered = dict(db.execute("SELECT state,error,checkpoint FROM executions WHERE id=?", (pressure_task,)).fetchone())
        if recovered["state"] != "completed":
            raise AssertionError("restored watermark did not allow explicit retry: " + str(recovered))
        restored_usage = json.loads(recovered["checkpoint"])["usage"]
        if restored_usage["execution_seconds_total"] < initial_usage["execution_seconds_total"] or restored_usage["execution_quanta"] != initial_usage["execution_quanta"] + 1 or restored_usage["ocr_requests"] < 1:
            raise AssertionError("retry lost prior execution usage or omitted real OCR boundary work")
    source_files = {name: sha(Path(__file__).with_name(name).read_bytes()) for name in ("capacity.py", "core.py", "media.py", "runtime.py", "server.py")}
    try:
        source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=Path(__file__).parent, text=True).strip()
        dirty = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "services/video-knowledge"], cwd=Path(__file__).parents[2]).returncode != 0
    except (OSError, subprocess.CalledProcessError):
        source_commit, dirty = None, None
    return {"schema_version": 1, "passed": True, "scope": "synthetic-local-media-worker-calibration", "production_ready": False, "slo_frozen": False,
            "measured_at": datetime.now(timezone.utc).isoformat(), "source_commit": source_commit, "tracked_worker_sources_dirty": dirty,
            "machine": metadata, "source_files_sha256": source_files,
            "workload": {"jobs": jobs, "workers": concurrency, "observed_peak_claimed": observed_peak_claimed,
                         "video_duration_ms_each": duration_ms, "total_video_minutes": jobs * duration_ms / 60000,
                         "resolution": [width, height], "fps": 10, "codec": "mpeg4", "source_media_sha256": sha(source.read_bytes()),
                         "mode": "visual_required", "model_config": "none; OCR is a deterministic external-boundary fixture", "queue_shape": "finite burst enqueued before workers start"},
            "metrics": {"wall_seconds": elapsed, "submit_p95_ms": percentile(submissions),
                        "queue_wait_p95_ms": percentile([d["queue_wait_ms"] for d in details]),
                        "processing_p95_ms": percentile([d["processing_ms"] for d in details]),
                        "worker_artifact_ready_p95_ms": percentile([d["worker_artifact_ready_ms"] for d in details]),
                        "wall_seconds_per_video_minute": elapsed / (jobs * duration_ms / 60000),
                        "cpu_seconds_self_and_ffmpeg": sum((b.ru_utime + b.ru_stime) - (a.ru_utime + a.ru_stime) for a, b in zip(start_usage, end_usage)),
                        "output_object_puts": measured_puts, "output_object_bytes_written": measured_bytes, **peak},
            "jobs": details, "storage_watermark_probe": {"method": "raise configured reserve above actual disk total; no disk fill", "error": "STORAGE_PRESSURE", "result_published": False, "explicit_retry_after_restore": "completed", "same_task_identity": True, "prior_execution_usage_preserved": True},
            "cost": {"external_model_calls": 0, "external_model_charge": 0, "compute_and_storage_cost": "not priced"},
            "limits": ["not production or provider throughput; no DTK/ASR/VLM/model quality measured", "local filesystem adapter, not MinIO or network storage", "worker artifact-ready is not Loom knowledge-ready or Canvas completion", "20ms process-tree sum-RSS sampling can miss short peaks and double-count shared pages", "small bounded sample; observed worker count is not a recommended deployment concurrency", "configured storage-watermark drill does not establish OOM safety or a production memory ceiling"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--seconds", type=float, default=6)
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=180)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="video-capacity-") as root:
        result = calibrate(root, **vars(args))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
