# -*- coding: utf-8 -*-
"""循环调 rewrite-prompts 直到 ep1 全部段变成 H3 六段式。
每次调用约 2 分钟后后端断开，但会推进若干段；脚本检测进度增长后继续。"""
import urllib.request, urllib.error, json, time, sqlite3, datetime

TOKEN = "082600abae3fc431431ef10609ac5771be9e"
URL = "http://127.0.0.1:17372/drama/pipeline/prompts/rewrite"
DB = "C:/Users/wxy/.infinite-canvas/runtime.sqlite"
NODE = "production-h3-scene-c534744bbf79e68d542acf4d"
EP = "episode-Oeaga9RxjYMnH3f_2S5_l-1-ol0vz6"
LOG = "C:/Users/wxy/AppData/Local/hermes/cache/scratch/ep1_rewrite_loop.log"

def log(msg):
    line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def progress():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    row = c.execute("SELECT node_json FROM canvas_nodes WHERE node_id=?", (NODE,)).fetchone()
    c.close()
    if not row: return 0, 0, []
    segs = json.loads(row[0]).get("metadata", {}).get("segments", [])
    six = [i + 1 for i, s in enumerate(segs) if 'subject_definitions' in str(s.get('prompt', ''))]
    return len(six), len(segs), six

def call_rewrite():
    h = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    body = json.dumps({"episodeId": EP}).encode()
    req = urllib.request.Request(URL, data=body, headers=h, method="POST")
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=150) as r:
            log(f"rewrite HTTP {r.status} 耗时{round(time.time()-t)}s: {r.read().decode()[:200]}")
    except urllib.error.HTTPError as e:
        log(f"rewrite HTTP {e.code} 耗时{round(time.time()-t)}s (后端可能仍在处理)")
    except Exception as e:
        log(f"rewrite 断开 耗时{round(time.time()-t)}s: {str(e)[:80]} (等后端落盘)")

def main():
    log("=== 循环 rewrite ep1 提示词（H3 六段式）启动 ===")
    last, total, _ = progress()
    log(f"起始: {last}/{total} 六段式")
    stall = 0
    for i in range(30):
        call_rewrite()
        time.sleep(12)  # 等后端写回
        cur, total, six = progress()
        log(f"第{i+1}轮后: {cur}/{total} 六段式 (本轮+{cur-last})")
        if cur >= total:
            log("=== 全部段已六段式，完成 ===")
            break
        if cur <= last:
            stall += 1
            log(f"进度未增长 ({stall}/3)")
            if stall >= 3:
                log("=== 连续3轮无增长，停止 ===")
                break
        else:
            stall = 0
        last = cur
    log("=== 循环结束 ===")

if __name__ == "__main__":
    main()
