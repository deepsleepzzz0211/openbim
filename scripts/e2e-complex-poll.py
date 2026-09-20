"""轮询转换状态直到全部终态，输出转换耗时与统计"""
import json, time, urllib.request

API = "http://localhost:3001/api/v1"


def get_json(path: str, token: str):
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    token = get_json_token()
    with open("D:/project/bim/scripts/e2e-uploaded.json", encoding="utf-8") as f:
        tasks = json.load(f)

    pending = {t["versionId"]: t for t in tasks}
    t_start = time.time()
    seen_status = {}
    while pending and time.time() - t_start < 600:
        for vid, t in list(pending.items()):
            v = get_json(f"/versions/{vid}", token)
            st = v["version"]["status"]
            prog = v["version"].get("progress", 0)
            key = (st, prog)
            if seen_status.get(vid) != key:
                seen_status[vid] = key
                print(f"  [{time.time()-t_start:6.1f}s] {t['name']}: {st} {prog}%")
            if st in ("READY", "FAILED"):
                dt = time.time() - t["t0"]
                stats = v["version"].get("statsJson") or ""
                err = v["version"].get("errorCode") or ""
                print(f"[{st}] {t['name']} ({t['file']}) 转换耗时 {dt:.1f}s stats={stats} err={err}")
                del pending[vid]
        if pending:
            time.sleep(2)
    if pending:
        print("[TIMEOUT] 未完成的版本:", list(pending.keys()))


def get_json_token():
    req = urllib.request.Request(
        API + "/auth/login",
        data=json.dumps({"email": "demo@openbim.local", "password": "Demo1234"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["accessToken"]


if __name__ == "__main__":
    main()
