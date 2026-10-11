import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DB_FILE } from "../config.js";

// Manual only. Default is read-only: npm run prune-observability -- [days=7] [--apply]
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--apply") || positional.length > 1) throw new Error("Usage: prune-observability [days=7] [--apply]");
const keepDays = Number(positional[0] ?? 7);
if (!Number.isFinite(keepDays) || keepDays <= 0) throw new Error("保留天数必须是正数");
const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
const apply = args.includes("--apply");
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护");
const db = new DatabaseSync(DB_FILE, { readOnly: !apply });
try {
    const count = db.prepare("SELECT COUNT(*) AS n FROM mcp_observability_events WHERE created_at < ?").get(cutoff) as { n: number };
    let deleted = 0;
    if (apply) deleted = Number(db.prepare("DELETE FROM mcp_observability_events WHERE created_at < ?").run(cutoff).changes);
    console.log(JSON.stringify({ ok: true, dryRun: !apply, keepDays, cutoff, wouldDelete: count.n, deleted }));
} finally { db.close(); }
