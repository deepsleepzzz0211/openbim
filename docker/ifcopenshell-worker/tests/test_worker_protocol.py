"""HTTP protocol + subprocess-per-file integration test for worker.py.

Runs the real server (stub engine, PORT=0) and drives it exactly like the API
does: POST /convert, poll /jobs/{id}, artifacts land on the shared volume.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def http_json(method: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read().decode("utf8"))
    except urllib.error.HTTPError as err:
        payload = err.read().decode("utf8")
        try:
            return err.code, json.loads(payload)
        except json.JSONDecodeError:
            return err.code, {"raw": payload}


class WorkerProtocolTest(unittest.TestCase):
    proc: subprocess.Popen
    base: str

    @classmethod
    def setUpClass(cls) -> None:
        env = {**os.environ, "IFW_ENGINE": "stub", "PORT": "0", "HOST": "127.0.0.1", "PYTHONUNBUFFERED": "1"}
        cls.proc = subprocess.Popen(
            [sys.executable, "worker.py"], cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf8", env=env,
        )
        assert cls.proc.stdout is not None
        line = cls.proc.stdout.readline()
        m = re.search(r"listening on [\d.]+:(\d+)", line)
        if not m:
            cls.proc.kill()
            raise RuntimeError(f"worker did not start: {line!r}")
        cls.base = f"http://127.0.0.1:{m.group(1)}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.proc.kill()
        cls.proc.wait(timeout=10)

    def test_convert_writes_contract_artifacts(self) -> None:
        d = tempfile.mkdtemp()
        input_path = os.path.join(d, "model.ifc")
        with open(input_path, "w", encoding="utf8") as f:
            f.write("ISO-10303-21;")
        glb_path = os.path.join(d, "model.glb")
        meta_path = os.path.join(d, "meta.json")

        status, body = http_json("POST", f"{self.base}/convert", {
            "job_id": "t1",
            "input_path": input_path,
            "glb_path": glb_path,
            "meta_path": meta_path,
            "chunking": {"maxTrianglesPerChunk": 1000000},
        })
        self.assertEqual(status, 202)
        self.assertEqual(body["job_id"], "t1")

        deadline = time.time() + 60
        job: dict = {}
        while time.time() < deadline:
            _, job = http_json("GET", f"{self.base}/jobs/t1")
            if job.get("status") in ("done", "failed"):
                break
            time.sleep(0.2)
        self.assertEqual(job.get("status"), "done", f"job did not finish: {job}")
        self.assertEqual(job["stats"], {"elements": 2, "triangles": 24})
        self.assertEqual(job["schema"], "IFC4")
        self.assertGreater(job.get("percent", 0), 0)

        with open(meta_path, encoding="utf8") as f:
            meta = json.load(f)
        self.assertEqual(meta["engine"], "native")
        self.assertEqual(meta["artifactFormat"], "chunked")  # two storeys
        for entry in meta["chunks"]:
            self.assertTrue(os.path.isfile(os.path.join(d, "chunks", f"{entry['id']}.glb")))
        self.assertFalse(os.path.exists(glb_path))

    def test_missing_input_is_rejected_synchronously(self) -> None:
        status, body = http_json("POST", f"{self.base}/convert", {
            "job_id": "t-bad",
            "input_path": "Z:/definitely/not/here.ifc",
            "glb_path": "Z:/x/model.glb",
            "meta_path": "Z:/x/meta.json",
        })
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], "BAD_INPUT")

    def test_unknown_job_is_404(self) -> None:
        status, _ = http_json("GET", f"{self.base}/jobs/nope")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
