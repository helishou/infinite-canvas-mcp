# -*- coding: utf-8 -*-
"""监控 ep1 34段强制重跑：按 inputOutdated=False 判定已完成，跟踪任务状态。"""
import sqlite3, json, time, datetime

DB = "C:/Users/wxy/.infinite-canvas/runtime.sqlite"
NODE = "production-h3-scene-c534744bbf79e68d542acf4d"
LOG = "C:/Users/wxy/AppData/Local/hermes/cache/scratch/ep1_rerun_progress.log"
SINCE = "2026-11-24T11:20:00"  # 本次重跑提交起点(UTC)

def log(msg):
    line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def report():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    row = c.execute("SELECT node_json FROM canvas_nodes WHERE node_id=?", (NODE,)).fetchone()
    segs = json.loads(row[0]).get("metadata", {}).get("segments", [])
    # 源稿34段
    rd = c.execute("SELECT draft_json FROM episode_productions WHERE episode_id=?",
                   ("episode-Oeaga9RxjYMnH3f_2S5_l-1-ol0vz6",)).fetchone()
    src_ids = {s['id'] for s in json.loads(rd[0])['director']['source']['segments']}
    main = [s for s in segs if str((s.get('productionClipProjection') or {}).get('targetId', '')) in src_ids]
    fresh = sum(1 for s in main if s.get('inputOutdated') is False and str(s.get('resultStorageKey','')).startswith('video:'))
    tasks = c.execute("SELECT status FROM tasks WHERE kind='canvas-h3-run' AND created_at>?", (SINCE,)).fetchall()
    c.close()
    from collections import Counter
    st = Counter(t[0] for t in tasks)
    return fresh, len(main), dict(st)

def main():
    log("=== ep1 34段强制重跑监控启动 ===")
    last = -1; stall = 0
    for i in range(120):  # 最多60分钟
        fresh, total, st = report()
        log(f"新产物 {fresh}/{total} | 任务 {st}")
        if fresh >= total:
            log("=== 34段全部重跑完成 ==="); break
        if fresh == last: stall += 1
        else: stall = 0; last = fresh
        if stall >= 10:  # 5分钟无增长
            log("=== 连续5分钟无增长，停止监控 ==="); break
        time.sleep(30)

if __name__ == "__main__":
    main()
