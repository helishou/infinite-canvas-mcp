import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, DB_FILE } from "../config.js";
import { listDatabaseSnapshots, pruneDatabaseSnapshots, snapshotRetention } from "../database-snapshots.js";

// Manual only. Default is read-only:
//   corepack pnpm --filter @helishou/infinite-canvas-backend run prune-db-snapshots -- [keep=2] [--apply]
// 运行时路径已自带保留策略（见 database-snapshots.ts），这个 CLI 用于回收历史遗留的堆积快照。
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--apply") || positional.length > 1) throw new Error("Usage: prune-db-snapshots [keep=2] [--apply]");
const keep = positional.length ? Number(positional[0]) : snapshotRetention();
if (!Number.isInteger(keep) || keep < 0) throw new Error("保留份数必须是非负整数");
const apply = args.includes("--apply");

/** 代码创建快照的用途族名（前缀匹配，`rebaseline-<projectId>` 这类也归入同一族）。 */
const FAMILIES = ["pre-schema", "pre-h3", "before-batch-prune", "rebaseline", "before-inline-media-redaction", "director-source"];

function sizeOf(file: string) {
    try { return fs.statSync(file).size; } catch { return 0; }
}

const managed = new Set<string>();
const families = FAMILIES.map((family) => {
    const snapshots = listDatabaseSnapshots(DB_FILE, family);
    for (const file of snapshots) managed.add(path.resolve(file));
    const stale = snapshots.slice(keep);
    // 先量体积再删除，否则文件已经不在，删掉多少就统计不出来。
    const removedBytes = stale.reduce((total, file) => total + sizeOf(file), 0);
    const removed = stale.map((file) => path.basename(file));
    if (apply) pruneDatabaseSnapshots(DB_FILE, family, keep);
    return {
        family,
        snapshots: snapshots.length,
        kept: Math.min(snapshots.length, keep),
        removed,
        removedBytes,
    };
});

// 未纳入管理的同目录大文件只报告、不删除：命名来自一次性命令或更早的版本，删不删由人判断。
const unmanaged = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR)
        .map((name) => path.join(DATA_DIR, name))
        .filter((file) => (file.endsWith(".sqlite") || file.endsWith(".bak")) && !/-wal$|-shm$/.test(file) && path.resolve(file) !== path.resolve(DB_FILE) && !managed.has(path.resolve(file)))
        .map((file) => ({ file: path.basename(file), sizeBytes: sizeOf(file) }))
        .filter((entry) => entry.sizeBytes > 0)
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
    : [];

console.log(JSON.stringify({
    ok: true,
    dryRun: !apply,
    keep,
    dataDir: DATA_DIR,
    families,
    unmanaged,
    reclaimedBytes: families.reduce((total, family) => total + family.removedBytes, 0),
}, null, 2));
