"""重新转换全部真实模型版本并轮询结果（验证 elements 修复）"""
import json, time, urllib.request

API = "http://localhost:3001/api/v1"


def get_json(path, token):
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def post_json(path, token):
    req = urllib.request.Request(API + path, data=b"{}", method="POST",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def login():
    req = urllib.request.Request(API + "/auth/login",
                                 data=json.dumps({"email": "demo@openbim.local", "password": "Demo1234"}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["accessToken"]


def main():
    token = login()
    with open("D:/project/bim/scripts/e2e-uploaded.json", encoding="utf-8") as f:
        tasks = json.load(f)

    # 触发重转换
    for t in tasks:
        r = post_json(f"/versions/{t['versionId']}/reconvert", token)
        print(f"[RECONVERT] {t['name']}: {json.dumps(r, ensure_ascii=False)[:120]}")

    # 轮询
    pending = {t["versionId"]: t for t in tasks}
    t_start = time.time()
    while pending and time.time() - t_start < 600:
        for vid, t in list(pending.items()):
            v = get_json(f"/versions/{vid}", token)
            st = v["version"]["status"]
            if st in ("READY", "FAILED"):
                dt = time.time() - t_start
                stats = v["version"].get("statsJson") or ""
                err = v["version"].get("errorCode") or ""
                print(f"[{st}] {t['name']} 耗时{dt:.1f}s stats={stats} err={err}")
                del pending[vid]
        if pending:
            time.sleep(3)
    if pending:
        print("[TIMEOUT]", list(pending))


if __name__ == "__main__":
    main()
