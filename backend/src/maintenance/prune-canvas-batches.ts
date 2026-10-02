import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DB_FILE } from "../config.js";
import { applyCanvasHistoryPrune, previewCanvasHistoryPrune } from "../canvas/history-maintenance.js";

// Manual only. Default is read-only: npm run prune-canvas-batches -- 30 [--apply]
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--apply") || positional.length > 1) throw new Error("Usage: prune-canvas-batches [days=30] [--apply]");
const keepDays = Number(positional[0] ?? 30);
if (!Number.isFinite(keepDays) || keepDays <= 0) throw new Error("保留天数必须是正数");
const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
const apply = args.includes("--apply");
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护");
const db = new DatabaseSync(DB_FILE, { readOnly: !apply });
try {
    db.exec("PRAGMA foreign_keys = ON");
    const result = apply ? applyCanvasHistoryPrune(db, DB_FILE, cutoff) : { plans: previewCanvasHistoryPrune(db, cutoff) };
    console.log(JSON.stringify({ ok: !result.plans.some((plan) => plan.blockedReason), dryRun: !apply, keepDays, cutoff, ...result }));
    if (result.plans.some((plan) => plan.blockedReason)) process.exitCode = 1;
} finally { db.close(); }
