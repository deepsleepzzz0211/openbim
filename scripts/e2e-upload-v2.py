"""上传 v2 版本：机电(同文件)+景观(道路文件)，用于联邦/碰撞/diff 验证"""
import json, importlib.util, time, urllib.request

API = "http://localhost:3001/api/v1"
spec = importlib.util.spec_from_file_location("up", "D:/project/bim/scripts/e2e-complex-upload.py")
up = importlib.util.module_from_spec(spec)
spec.loader.exec_module(up)

req = urllib.request.Request(API + "/auth/login",
                             data=json.dumps({"email": "demo@openbim.local", "password": "Demo1234"}).encode(),
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=30) as r:
    token = json.loads(r.read())["accessToken"]

jobs = [
    ("cmtx5njgj000fu5tcwhal08oh", "真实项目-Duplex机电", "Duplex_MEP_20110907.ifc"),
    ("cmtx5njnh000xu5tcjqe4cd3m", "认证场景-景观", "Infra-Road.ifc"),
]
results = []
for model_id, name, fname in jobs:
    t0 = time.time()
    v = up.upload_version(token, model_id, f"{up.SAMPLES}/{fname}")
    vid = v["version"]["id"] if "version" in v else v.get("id")
    print(f"[UPLOADED] {name} v2={vid} ({time.time()-t0:.1f}s)")
    results.append({"name": name + "-v2", "modelId": model_id, "versionId": vid, "file": fname})

with open("D:/project/bim/scripts/e2e-uploaded-v2.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

# 轮询到终态
pending = {r["versionId"]: r for r in results}
t0 = time.time()
while pending and time.time() - t0 < 300:
    for vid, r in list(pending.items()):
        v = up.http_json("GET", f"/versions/{vid}", token, {}) if False else json.loads(urllib.request.urlopen(
            urllib.request.Request(f"{API}/versions/{vid}", headers={"Authorization": f"Bearer {token}"}), timeout=30).read())
        st = v["version"]["status"]
        if st in ("READY", "FAILED"):
            print(f"[{st}] {r['name']} stats={v['version'].get('statsJson')} progress={v['version'].get('progress')}")
            del pending[vid]
    if pending:
        time.sleep(3)
