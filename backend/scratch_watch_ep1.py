# -*- coding: utf-8 -*-
"""ep1 批量补段进度监控：只读 runtime.sqlite，每 30s 记录 34 段产物数与任务状态到日志。"""
import sqlite3, json, time, datetime

DB = "C:/Users/wxy/.infinite-canvas/runtime.sqlite"
NODE = "production-h3-scene-c534744bbf79e68d542acf4d"
LOG = "C:/Users/wxy/AppData/Local/hermes/cache/scratch/ep1_batch_progress.log"
SINCE = "2026-11-24T09:12:00"  # 本次批量提交起点

def report():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    # 段产物
    row = c.execute("SELECT node_json FROM canvas_nodes WHERE node_id=?", (NODE,)).fetchone()
    segs = json.loads(row[0]).get("metadata", {}).get("segments", [])
    total = len(segs)
    withv = sum(1 for s in segs if str(s.get("resultStorageKey", "")).startswith("video:"))
    # 本次任务状态
    rows = c.execute(
        "SELECT status FROM tasks WHERE kind='canvas-h3-run' AND created_at>?", (SINCE,)
    ).fetchall()
    c.close()
    from collections import Counter
    st = Counter(r[0] for r in rows)
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] 段产物 {withv}/{total} | 本批任务 {len(rows)}: {dict(st)}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    return withv, total, st

def main():
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"\n=== 批量补段监控启动 {datetime.datetime.now().isoformat()} ===\n")
    last = -1
    idle_rounds = 0
    for i in range(240):  # 最多 120 分钟
        w, t, st = report()
        if w == last:
            idle_rounds += 1
        else:
            idle_rounds = 0
            last = w
        # 全部 34 段有产物，或任务全部终态且长时间无增长
        running = st.get("running", 0) + st.get("pending", 0)
        if w >= t:
            print("=== 全部段已有产物，完成 ===", flush=True)
            break
        if running == 0 and idle_rounds >= 3:
            print("=== 任务均终态且产物数稳定，停止监控 ===", flush=True)
            break
        time.sleep(30)

if __name__ == "__main__":
    main()
