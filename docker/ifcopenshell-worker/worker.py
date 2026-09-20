"""Native conversion worker container (ticket 09).

HTTP job protocol consumed by apps/api/src/conversion/nativeClient.ts:
  POST /convert   {job_id, input_path, glb_path, meta_path, chunking?} -> 202 {job_id}
  GET  /jobs/{id}  {status:"running"|"done"|"failed", percent, ...}
Every conversion runs as a fresh `python -m ifw.run_job` subprocess (one file
per process: crash isolation and clean memory for the LGPL engine). Set
WORKER_TOKEN to require `Authorization: Bearer <token>`.

Env: PORT (8090), HOST (0.0.0.0), WORKER_TOKEN, IFC_WORKER_THREADS (4),
     MAX_CONCURRENT_JOBS (1).
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8090"))
HOST = os.environ.get("HOST", "0.0.0.0")
TOKEN = os.environ.get("WORKER_TOKEN", "")
MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "1"))

_lock = threading.Lock()
_jobs: Dict[str, dict] = {}
_running = {"count": 0}


class JobManager(threading.Thread):
    """Watches one conversion subprocess; updates job state from its stdout protocol."""

    def __init__(self, job_id: str, req: dict) -> None:
        super().__init__(daemon=True)
        self.job_id = job_id
        self.req = req

    def run(self) -> None:
        _wait_for_slot()
        with _lock:
            _running["count"] += 1
            _jobs[self.job_id].update(status="running", percent=0)
        try:
            proc = subprocess.Popen(
                [sys.executable, "-m", "ifw.run_job", json.dumps(self.req)],
                cwd=HERE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf8",
                errors="replace",
            )
        except Exception as err:  # could not even spawn
            with _lock:
                _running["count"] -= 1
                _jobs[self.job_id].update(status="failed", code="NATIVE_CRASH", message=str(err))
            return
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            with _lock:
                job = _jobs[self.job_id]
                if event.get("event") == "progress":
                    job["percent"] = max(job.get("percent", 0), int(event.get("percent", 0)))
                elif event.get("event") == "result":
                    if event.get("ok"):
                        job.update(status="done", percent=100, stats=event.get("stats"), schema=event.get("schema"))
                    else:
                        job.update(status="failed", code=event.get("code", "NATIVE_FAILED"), message=event.get("message"))
        proc.wait()
        with _lock:
            _running["count"] -= 1
            job = _jobs[self.job_id]
            if job.get("status") not in ("done", "failed"):
                err = ""
                if proc.stderr is not None:
                    err = (proc.stderr.read() or "")[-500:]
                job.update(
                    status="failed",
                    code="NATIVE_CRASH",
                    message=f"conversion process exited with code {proc.returncode}; {err}".strip(),
                )


def _wait_for_slot() -> None:
    while True:
        with _lock:
            if _running["count"] < MAX_CONCURRENT_JOBS:
                return
        # back-off so a queued job never spins hot
        threading.Event().wait(0.5)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A002
        sys.stderr.write("[ifc-worker] %s\n" % (fmt % args))

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        if not TOKEN:
            return True
        return self.headers.get("authorization", "") == f"Bearer {TOKEN}"

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"ok": True, "engine": "ifcopenshell"})
            return
        if self.path.startswith("/jobs/"):
            job_id = self.path[len("/jobs/") :]
            with _lock:
                job = _jobs.get(job_id)
                snapshot = dict(job) if job else None
            if snapshot is None:
                self._send(404, {"code": "NOT_FOUND"})
                return
            snapshot.pop("spec", None)
            self._send(200, snapshot)
            return
        self._send(404, {"code": "NOT_FOUND"})

    def do_POST(self) -> None:
        if not self._authorized():
            self._send(401, {"code": "UNAUTHORIZED", "message": "bad token"})
            return
        if self.path != "/convert":
            self._send(404, {"code": "NOT_FOUND"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            req = json.loads(self.rfile.read(length).decode("utf8"))
        except Exception:
            self._send(400, {"code": "BAD_REQUEST", "message": "request body must be JSON"})
            return
        job_id = str(req.get("job_id") or "")
        needed = ("input_path", "glb_path", "meta_path")
        if not job_id or not all(req.get(k) for k in needed):
            self._send(400, {"code": "BAD_REQUEST", "message": "job_id, input_path, glb_path, meta_path are required"})
            return
        if not os.path.isfile(req["input_path"]):
            self._send(400, {"code": "BAD_INPUT", "message": f"input_path does not exist: {req['input_path']}"})
            return
        with _lock:
            existing = _jobs.get(job_id)
            if existing and existing.get("status") not in ("done", "failed"):
                self._send(202, {"job_id": job_id})  # idempotent resubmit while running
                return
            _jobs[job_id] = {"status": "queued", "percent": 0, "spec": req}
        JobManager(job_id, req).start()
        self._send(202, {"job_id": job_id})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    actual_port = server.server_address[1]
    print(f"[ifc-worker] listening on {HOST}:{actual_port} (token: {'on' if TOKEN else 'off'})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
