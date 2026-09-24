import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE } from "../config.js";

// 一次性维护脚本，**需要人工执行**，不在启动流程里自动跑：
//   npm run prune-canvas-batches -- 30
// canvas_operation_batches 只用于并发校验与审计回放，没有 TTL，实测 5.3 万行 / 44 MB 且持续增长。
// 先 VACUUM INTO 备份再删；canvas_command_receipts 是幂等回执表，脚本不主动删它
// （但它对 batches 有 ON DELETE CASCADE，删除老批次会连带带走对应回执，
//   极老的重复请求因此存在被重放的可能 —— 这是本脚本唯一的已知代价，执行前请自行确认窗口）。
const keepDays = Number(process.argv[2] || 30);
if (!Number.isFinite(keepDays) || keepDays <= 0) throw new Error(`保留天数必须是正数，收到：${process.argv[2]}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(path.dirname(DB_FILE), `runtime.sqlite.before-batch-prune-${stamp}.sqlite`);
const backupDb = new DatabaseSync(DB_FILE);
try {
    fs.rmSync(backupFile, { force: true });
    backupDb.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
} finally {
    backupDb.close();
}

const db = new DatabaseSync(DB_FILE);
try {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    const before = (db.prepare("SELECT count(*) AS n FROM canvas_operation_batches").get() as { n: number }).n;
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM canvas_operation_batches WHERE created_at < ?").run(cutoff);
    db.exec("COMMIT");
    const after = (db.prepare("SELECT count(*) AS n FROM canvas_operation_batches").get() as { n: number }).n;
    const receipts = (db.prepare("SELECT count(*) AS n FROM canvas_command_receipts").get() as { n: number }).n;
    console.log(JSON.stringify({ ok: true, backupFile, keepDays, cutoff, removed: before - after, remaining: after, receipts }));
} finally {
    db.close();
}
