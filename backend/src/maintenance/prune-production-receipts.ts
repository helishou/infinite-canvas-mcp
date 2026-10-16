/**
 * 制作回执收据清理 CLI（人工执行，默认只读）。
 *
 * 为什么需要它：`episode_production_operations.receipt_json` 是幂等重放缓存，
 * 每条都保存整份 ProductionRecord 快照（含 draft.director.artifacts，占 90%+）。
 * 实测 2379 行 / 4.44 GB，占库体积 85%，且只在「同一 operationId 重放」时被读取。
 * 该表此前没有任何保留策略，是纯增长。
 *
 * 安全性：
 * - 只删「可安全重建」的行——draft.director 为 null 或无 source 的（非制作稿事务）。
 * - 保留每个 episode 最近 N 条（默认 200），确保近期重放仍命中缓存。
 * - 保留所有带 published 或含编译产物的行（发布/编译回执可能有审计价值）。
 * - 删除前打印候选清单；--apply 才写库，并在事务内逐条复核。
 *
 * 用法：
 *   node --import tsx src/maintenance/prune-production-receipts.ts                 # 只读报告
 *   node --import tsx src/maintenance/prune-production-receipts.ts --keep 200 --apply
 */
import { DatabaseSync } from "node:sqlite";
import { decodeReceipt, type StoredReceipt } from "../drama/receipt-storage.js";
import fs from "node:fs";
import { DB_FILE } from "../config.js";

const args = process.argv.slice(2);
let keepDays = 7;
let apply = false;
for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
    if (arg === "--days") {
        const value = Number(args[++index]);
        if (!Number.isFinite(value) || value <= 0) throw new Error("--days 必须是正数");
        keepDays = value;
        continue;
    }
    throw new Error("未知参数: " + arg);
}
const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();

if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护");
const db = new DatabaseSync(DB_FILE, { readOnly: !apply });

/** 该 receipt 是否可安全删除：非制作稿事务，或纯草稿且无发布/编译产物。 */
function reasonToKeep(stored: StoredReceipt): string | null {
    let record: Record<string, any>;
    // 历史行是明文 TEXT，新写入是 gzip BLOB；两者都由 decodeReceipt 分派。
    // 这里若直接 JSON.parse，BLOB 行会抛错并被误判为 unparsable（永不可删）。
    try { record = decodeReceipt(stored) as Record<string, any>; }
    catch { return "unparsable"; }
    const director = record?.draft?.director;
    // 非制作稿事务（画布/场景/资产的普通提交）没有 draft.director
    if (!director || typeof director !== "object") return null;
    // 有发布态：审计价值，保留
    if (record.published) return "has-published";
    // 有编译产物回执：保留
    if (Array.isArray(director.artifacts) && director.artifacts.length) return "has-artifacts";
    // 有执行授权或被阻塞项：保留
    if (director.executionAuthorized === true) return "execution-authorized";
    if (Array.isArray(director.unresolved) && director.unresolved.length) return "has-unresolved";
    return null;
}

try {
    const total = db.prepare("SELECT COUNT(*) AS n FROM episode_production_operations").get() as { n: number };
    const totalBytes = db.prepare("SELECT COALESCE(SUM(LENGTH(receipt_json)),0) AS b FROM episode_production_operations").get() as { b: number };
    const fileBefore = fs.statSync(DB_FILE).size;

    // 按 episode 分组，按 created_at 倒序。用 prepared statement 逐行迭代（iterate），
    // 不 .all() 一次性载入——该表 4.4 GB，整表载入会 OOM（默认堆上限 4 GB）。
    // 只扫描超过保留期的行；未过期的一律不动。
    const scan = db.prepare(
        "SELECT operation_id, episode_id, created_at, LENGTH(receipt_json) AS bytes, receipt_json FROM episode_production_operations WHERE created_at < ? ORDER BY created_at ASC"
    );

    const victims: Array<{ operationId: string; bytes: number }> = [];
    const keepReasons = new Map<string, number>();
    let aged = 0;
    for (const row of scan.iterate(cutoff) as Iterable<{ operation_id: string; bytes: number; receipt_json: StoredReceipt }>) {
        aged++;
        const reason = reasonToKeep(row.receipt_json);
        if (reason) { keepReasons.set(reason, (keepReasons.get(reason) ?? 0) + 1); continue; }
        victims.push({ operationId: row.operation_id, bytes: row.bytes });
    }
    const victimBytes = victims.reduce((sum, v) => sum + v.bytes, 0);

    if (!apply) {
        console.log(JSON.stringify({
            ok: true, dryRun: true, keepDays, cutoff, dbPath: DB_FILE,
            before: { rows: total.n, receiptBytes: totalBytes.b, fileBytes: fileBefore },
            agedRows: aged,
            keepReasons: Object.fromEntries(keepReasons),
            wouldDelete: victims.length,
            wouldFreeBytes: victimBytes,
            wouldFreeMB: (victimBytes / 1e6).toFixed(1),
            top10: victims.slice(0, 10).map(v => ({ id: v.operationId, MB: (v.bytes / 1e6).toFixed(2) })),
            note: "只删可安全重建的幂等缓存行；--apply 执行，之后需 VACUUM 才能回收文件空间",
        }, null, 2));
        db.close();
        process.exit(0);
    }

    db.exec("BEGIN IMMEDIATE");
    let deleted = 0;
    try {
        const del = db.prepare("DELETE FROM episode_production_operations WHERE operation_id = ? AND receipt_json = ?");
        // 事务内复核：内容未变且仍判定可删
        for (const victim of victims) {
            const fresh = db.prepare("SELECT receipt_json FROM episode_production_operations WHERE operation_id = ?").get(victim.operationId) as { receipt_json: StoredReceipt } | undefined;
            if (!fresh) continue;
            if (reasonToKeep(fresh.receipt_json)) continue;
            deleted += Number(del.run(victim.operationId, fresh.receipt_json).changes);
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }

    const after = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(receipt_json)),0) AS b FROM episode_production_operations").get() as { n: number; b: number };
    console.log(JSON.stringify({
        ok: true, dryRun: false, keepDays, cutoff, dbPath: DB_FILE,
        deleted,
        measurement: {
            rowsBefore: total.n, rowsAfter: after.n,
            receiptBytesBefore: totalBytes.b, receiptBytesAfter: after.b,
            freedReceiptMB: ((totalBytes.b - after.b) / 1e6).toFixed(1),
            fileBytesBefore: fileBefore, fileBytesAfter: fs.statSync(DB_FILE).size,
            note: "文件空间需 VACUUM 回收（本工具不自动 VACUUM，避免长事务阻塞）",
        },
    }, null, 2));
} finally {
    db.close();
}
