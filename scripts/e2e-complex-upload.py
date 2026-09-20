"""OpenBIM Hub 真实复杂模型 E2E 上传脚本"""
import json, sys, time, urllib.request, uuid

API = "http://localhost:3001/api/v1"
SAMPLES = "D:/project/bim/samples/complex"
PROJECT_ID = "cmtkiouku0004u544qasg0zry"


def http_json(method: str, path: str, token: str, body: dict):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode("utf-8"),
        method=method,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def upload_version(token: str, model_id: str, filepath: str):
    boundary = uuid.uuid4().hex
    fname = filepath.split("/")[-1]
    with open(filepath, "rb") as f:
        content = f.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{API}/models/{model_id}/versions",
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def main():
    login = http_json("POST", "/auth/login", "", {"email": "demo@openbim.local", "password": "Demo1234"})
    token = login["accessToken"]
    print("[OK] logged in")

    plan = [
        ("真实项目-Duplex公寓", "Duplex_A_20110907.ifc"),
        ("真实项目-Duplex机电", "Duplex_MEP_20110907.ifc"),
        ("真实项目-Duplex给排水", "Duplex_Plumbing_20121113.ifc"),
        ("认证场景-桥梁", "Infra-Bridge.ifc"),
        ("认证场景-景观", "Infra-Landscaping.ifc"),
    ]
    results = []
    for name, fname in plan:
        m = http_json("POST", f"/projects/{PROJECT_ID}/models", token, {"name": name})
        model_id = m["model"]["id"]
        t0 = time.time()
        v = upload_version(token, model_id, f"{SAMPLES}/{fname}")
        ver_id = v["version"]["id"] if "version" in v else v.get("id")
        print(f"[UPLOADED] {name} model={model_id} version={ver_id} ({time.time()-t0:.1f}s)")
        results.append({"name": name, "modelId": model_id, "versionId": ver_id, "file": fname, "t0": t0})

    with open("D:/project/bim/scripts/e2e-uploaded.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("[OK] saved e2e-uploaded.json")


if __name__ == "__main__":
    main()
