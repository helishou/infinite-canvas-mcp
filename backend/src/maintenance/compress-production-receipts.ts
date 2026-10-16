/**
 * 回执压缩迁移 CLI：把 `episode_production_operations.receipt_json` 的历史明文行
 * （TEXT）改存为 gzip BLOB，与 `encodeReceipt` 的新写入形态一致。
 *
 * 为什么是压缩而不是删行：回执是幂等重放缓存，体积来自「每行一份完整快照」。
 * 实测 2323 行 ≈ 4.4 GB，其中三个分集的 2095 行占 4.39 GB，体积分散在
 * draft/published 的 source/workflow/artifacts 六块（各 6%–19%），没有可去重的
 * 单一大块；而陈旧行往往持有别处不存在的 published 快照，按年龄删会丢数据。
 * 压缩是无损的，因此不需要判断「哪份快照还能删」——决策成本为零。
 *
 * 历史行保持 TEXT，新行是 BLOB，两种形态由 `decodeReceipt` 分派，无需 schema 迁移。
 *
 * 默认 dry-run：只报告可压缩行与预估收益。
 * --apply：逐行 UPDATE，写前先解压回读并与原值 deepStrictEqual 校验。
 * 完成后需自行 VACUUM 才会释放文件空间（脚本会提示）。
 *
 * 用法：
 *   node --import tsx src/maintenance/compress-production-receipts.ts
 *   node --import tsx src/maintenance/compress-production-receipts.ts --apply
 */
import fs from "node:fs";
import { deepStrictEqual } from "node:assert";
import { gzipSync } from "node:zlib";
import { BackendDatabase } from "../db.js";
import { DB_FILE } from "../config.js";
import { decodeReceipt, receiptBytes, type StoredReceipt } from "../drama/receipt-storage.js";

const args = process.argv.slice(2);
let apply = false;
for (const arg of args) {
    if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
    throw new Error("未知参数: " + arg);
}
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护: " + DB_FILE);

const db = new BackendDatabase(DB_FILE);
try {
    // 逐行 iterate：表可达数 GB，.all() 会把整表读进内存。
    const scan = db.db.prepare("SELECT operation_id, LENGTH(receipt_json) AS storedBytes, receipt_json FROM episode_production_operations ORDER BY rowid");

    type Candidate = { operationId: string; before: number; after: number };
    // Keep only ids and estimates. Retaining `stored` (4+ GB) or parsed values here would
    // defeat streaming and OOM the process before apply starts.
    const candidates: Candidate[] = [];
    let alreadyCompressed = 0, unchanged = 0, skipped = 0;
    let beforeBytes = 0, projectedBytes = 0;

    for (const row of scan.iterate() as Iterable<{ operation_id: string; storedBytes: number; receipt_json: StoredReceipt }>) {
        const stored = row.receipt_json;
        const size = receiptBytes(stored);
        beforeBytes += size;
        if (stored instanceof Uint8Array) { alreadyCompressed++; projectedBytes += size; continue; }
        try { decodeReceipt(stored); } catch { skipped++; projectedBytes += size; continue; }
        const compressed = gzipSync(Buffer.from(stored, "utf8"));
        if (compressed.byteLength >= size) { unchanged++; projectedBytes += size; continue; }
        candidates.push({ operationId: row.operation_id, before: size, after: compressed.byteLength });
        projectedBytes += compressed.byteLength;
    }

    const saved = candidates.reduce((sum, c) => sum + (c.before - c.after), 0);
    const report = {
        ok: true, dryRun: !apply, dbPath: DB_FILE,
        totalRows: alreadyCompressed + unchanged + skipped + candidates.length,
        before: { bytes: beforeBytes, mb: +(beforeBytes / 1e6).toFixed(1) },
        projected: { bytes: projectedBytes, mb: +(projectedBytes / 1e6).toFixed(1) },
        saved: { bytes: saved, mb: +(saved / 1e6).toFixed(1) },
        rows: { toCompress: candidates.length, alreadyCompressed, unchanged, skipped },
        ratio: beforeBytes ? +(projectedBytes / beforeBytes * 100).toFixed(1) : 0,
    };

    if (!apply) {
        console.log(JSON.stringify({ ...report, note: "只读报告；--apply 执行压缩，完成后需 VACUUM 才会释放文件空间" }, null, 2));
        db.close();
        process.exit(0);
    }

    // Re-read each row inside a short transaction batch. Never cache payloads in memory;
    // compare-and-swap protects concurrent writes and each decoded row is verified losslessly.
    const BATCH = 100;
    let compressedCount = 0, changedSincePlan = 0;
    const select = db.db.prepare("SELECT receipt_json FROM episode_production_operations WHERE operation_id = ?");
    const update = db.db.prepare("UPDATE episode_production_operations SET receipt_json = ? WHERE operation_id = ? AND receipt_json = ?");
    for (let index = 0; index < candidates.length; index += BATCH) {
        db.db.exec("BEGIN IMMEDIATE");
        try {
            for (const candidate of candidates.slice(index, index + BATCH)) {
                const row = select.get(candidate.operationId) as { receipt_json: StoredReceipt } | undefined;
                if (!row || typeof row.receipt_json !== "string") { changedSincePlan++; continue; }
                const original = decodeReceipt(row.receipt_json);
                const compressedBlob = gzipSync(Buffer.from(row.receipt_json, "utf8"));
                if (compressedBlob.byteLength >= receiptBytes(row.receipt_json)) { changedSincePlan++; continue; }
                deepStrictEqual(decodeReceipt(compressedBlob), original);
                const changed = update.run(compressedBlob, candidate.operationId, row.receipt_json).changes;
                if (Number(changed) === 1) compressedCount++; else changedSincePlan++;
            }
            db.db.exec("COMMIT");
        } catch (error) { db.db.exec("ROLLBACK"); throw error; }
    }

    // Read back and verify every BLOB row; count actual bytes with the TEXT/BLOB-aware codec.
    let afterRows = 0, afterBytes = 0, blobRows = 0;
    const verifyScan = db.db.prepare("SELECT receipt_json FROM episode_production_operations");
    for (const row of verifyScan.iterate() as Iterable<{ receipt_json: StoredReceipt }>) {
        afterRows++;
        afterBytes += receiptBytes(row.receipt_json);
        if (row.receipt_json instanceof Uint8Array) { decodeReceipt(row.receipt_json); blobRows++; }
    }
    const fileSize = fs.statSync(DB_FILE).size;
    console.log(JSON.stringify({
        ...report, dryRun: false, compressed: compressedCount, changedSincePlan,
        after: { rows: afterRows, blobRows, totalBytes: afterBytes, mb: +(afterBytes / 1e6).toFixed(1), fileBytes: fileSize, fileGb: +(fileSize / 1e9).toFixed(2) },
        note: "逻辑字节已下降；文件空间需运行 VACUUM 才会释放",
    }, null, 2));
    if (compressedCount + changedSincePlan !== candidates.length) process.exitCode = 1;
} finally {
    db.close();
}
