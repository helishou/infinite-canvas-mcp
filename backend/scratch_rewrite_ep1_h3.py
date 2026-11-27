# -*- coding: utf-8 -*-
"""后台调 rewrite-prompts，长超时，记录结果。"""
import urllib.request, json, datetime

TOKEN = "082600abae3fc431431ef10609ac5771be9e"
URL = "http://127.0.0.1:17370/drama/pipeline/prompts/rewrite"
LOG = "C:/Users/wxy/AppData/Local/hermes/cache/scratch/ep1_rewrite_h3.log"

def log(msg):
    line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def main():
    log("=== rewrite ep1 prompts 开始 (H3 六段式) ===")
    h = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    body = json.dumps({"episodeId": "episode-Oeaga9RxjYMnH3f_2S5_l-1-ol0vz6"}).encode()
    req = urllib.request.Request(URL, data=body, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            log(f"HTTP {r.status}: {r.read().decode()[:500]}")
    except urllib.error.HTTPError as e:
        log(f"HTTP {e.code}: {e.read().decode(errors='replace')[:500]}")
    except Exception as e:
        log(f"ERR: {e}")
    log("=== rewrite 结束 ===")

if __name__ == "__main__":
    main()
