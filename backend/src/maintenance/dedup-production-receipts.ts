/**
 * receipt 去重迁移 CLI：把 episode_production_operations 中
 * published.director / published.shots 与 draft 侧 JSON 序列化完全一致的大块
 * 替换为 { "$ref" } 引用，省 26.74MB（230 行）。
 *
 * 默认 dry-run：只报告候选，不写库。
 * --apply：事务内 UPDATE 所有可去重行，逐行验证展开后 deepEqual 原始。
 *
 * 用法：
 *   node --import tsx src/maintenance/dedup-production-receipts.ts
 *   node --import tsx src/maintenance/dedup-production-receipts.ts --apply
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { deepStrictEqual } from "node:assert";
import { BackendDatabase } from "../db.js";
import { dedupReceipt, resolveReceiptDedup, RECEIPT_DEDUP_MARKER } from "../drama/receipt-dedup.js";
import { decodeReceipt, encodeReceipt, receiptBytes, type StoredReceipt } from "../drama/receipt-storage.js";
import type { ProductionRecord } from "../drama/production.js";
import { DB_FILE } from "../config.js";

// 同 director-source-storage：数据目录优先级为 环境变量 > root config > 默认 ~/.infinite-canvas，
// 由 config.ts 的 DATA_DIR 统一解析。此前这里 require 了一个不存在的导出
// (BACKEND_DATABASE_PATH)，require 返回 undefined 而不抛错，导致脚本永远停在
// MISSING_DATABASE: undefined —— 该维护命令实际从未可运行。
const DEFAULT_DATABASE_PATH = process.env.INFINITE_CANVAS_DATA_DIR
    ? path.join(process.env.INFINITE_CANVAS_DATA_DIR, "runtime.sqlite")
    : DB_FILE;

function parseArgs(args: string[]): { apply: boolean; dbPath: string | undefined } {
    let apply = false;
    let dbPath: string | undefined;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
        if (arg === "--db") {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error("--db 缺少值");
            dbPath = path.resolve(value);
            continue;
        }
        if (!arg.startsWith("--")) throw new Error("不支持的位置参数: " + arg);
        throw new Error("未知参数: " + arg);
    }
    return { apply, dbPath };
}

function tableBytes(db: BackendDatabase, table: string): number {
    const row = db.db.prepare("SELECT COALESCE(SUM(pgsize),0) b FROM dbstat WHERE name = ?").get(table) as { b: number } | null;
    return row?.b ?? 0;
}

function main(): void {
    const { apply, dbPath: requestedPath } = parseArgs(process.argv.slice(2));
    const dbPath = requestedPath || DEFAULT_DATABASE_PATH;
    if (!fs.existsSync(dbPath)) {
        console.error(JSON.stringify({ ok: false, code: "MISSING_DATABASE", error: "数据库不存在，拒绝创建: " + dbPath }, null, 2));
        process.exitCode = 1; return;
    }

    const db = new BackendDatabase(dbPath);
    const schemaVersion = db.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v as number;

    // Stream rows: the table may be multiple GB; .all() would materialize every receipt at once.
    const scan = db.db.prepare("SELECT operation_id, receipt_json FROM episode_production_operations");
    let rowCount = 0, receiptBytesBefore = 0;
    const beforeScan = scan.iterate() as Iterable<{ operation_id: string; receipt_json: StoredReceipt }>;

    const beforeFile = fs.statSync(dbPath).size;
    const beforeTable = tableBytes(db, "episode_production_operations");

    // 评估每行
    type Candidate = {
        operationId: string;
        originalLen: number;
        compressedLen: number;
        savedBytes: number;
        fields: string[];
        verified: boolean;
    };
    const candidates: Candidate[] = [];
    let alreadyDeduped = 0;
    let errors = 0;

    for (const row of beforeScan) {
        rowCount++;
        receiptBytesBefore += receiptBytes(row.receipt_json);
        let original: ProductionRecord;
        try {
            original = decodeReceipt<ProductionRecord>(row.receipt_json);
        } catch {
            errors++;
            continue;
        }
        // 已去重的行（含标记）
        if (RECEIPT_DEDUP_MARKER in (original as Record<string, unknown>)) {
            alreadyDeduped++;
            continue;
        }
        const compressed = dedupReceipt(original);
        if (!(RECEIPT_DEDUP_MARKER in (compressed as Record<string, unknown>))) continue;
        const marker = (compressed as Record<string, unknown>)[RECEIPT_DEDUP_MARKER] as Record<string, string>;
        const fields = Object.keys(marker);
        // 验证：展开后 deepEqual 原始
        let verified = true;
        try {
            const expanded = resolveReceiptDedup(compressed);
            deepStrictEqual(expanded, original);
        } catch {
            verified = false;
        }
        const compressedBlob = encodeReceipt(compressed);
        candidates.push({
            operationId: row.operation_id,
            originalLen: receiptBytes(row.receipt_json),
            compressedLen: compressedBlob.byteLength,
            savedBytes: receiptBytes(row.receipt_json) - compressedBlob.byteLength,
            fields,
            verified,
        });
    }

    const before = { rowCount, totalBytes: receiptBytesBefore, tableBytes: beforeTable, file: beforeFile };
    const totalSaved = candidates.filter(c => c.verified).reduce((s, c) => s + c.savedBytes, 0);
    const unverified = candidates.filter(c => !c.verified);

    if (!apply) {
        console.log(JSON.stringify({
            ok: true, dryRun: true,
            dbPath, schemaVersion,
            before,
            candidates: candidates.length,
            alreadyDeduped,
            errors,
            totalSavedBytes: totalSaved,
            totalSavedMB: (totalSaved / 1e6).toFixed(2),
            unverifiedCount: unverified.length,
            top10: candidates.filter(c => c.verified).sort((a, b) => b.savedBytes - a.savedBytes).slice(0, 10)
                .map(c => ({ id: c.operationId, savedKB: (c.savedBytes / 1024).toFixed(1), fields: c.fields })),
            note: "dry-run 只报告候选；--apply 执行迁移",
        }, null, 2));
        db.close();
        return;
    }

    // --apply：事务内执行
    const verifiedCandidates = candidates.filter(c => c.verified);
    if (verifiedCandidates.length === 0) {
        console.log(JSON.stringify({ ok: true, dryRun: false, dbPath, updated: 0, note: "无可去重行" }, null, 2));
        db.close();
        return;
    }

    db.db.exec("BEGIN IMMEDIATE");
    try {
        let updated = 0;
        const updateStmt = db.db.prepare("UPDATE episode_production_operations SET receipt_json = ? WHERE operation_id = ?");
        for (const c of verifiedCandidates) {
            const row = db.db.prepare("SELECT receipt_json FROM episode_production_operations WHERE operation_id = ?").get(c.operationId) as { receipt_json: StoredReceipt } | undefined;
            if (!row) continue;
            const original = decodeReceipt<ProductionRecord>(row.receipt_json);
            const compressed = dedupReceipt(original);
            if (!(RECEIPT_DEDUP_MARKER in (compressed as Record<string, unknown>))) continue;
            const expanded = resolveReceiptDedup(compressed);
            deepStrictEqual(expanded, original);
            updateStmt.run(encodeReceipt(compressed), c.operationId);
            updated++;
        }
        db.db.exec("COMMIT");

        let afterRowsCount = 0, afterBytes = 0, afterDedupedCount = 0;
        const afterScan = db.db.prepare("SELECT receipt_json FROM episode_production_operations");
        for (const row of afterScan.iterate() as Iterable<{ receipt_json: StoredReceipt }>) {
            afterRowsCount++;
            afterBytes += receiptBytes(row.receipt_json);
            const value = decodeReceipt(row.receipt_json);
            if (RECEIPT_DEDUP_MARKER in (value as Record<string, unknown>)) afterDedupedCount++;
        }
        const after = {
            rowCount: afterRowsCount,
            totalBytes: afterBytes,
            tableBytes: tableBytes(db, "episode_production_operations"),
            dedupedCount: afterDedupedCount,
            file: fs.statSync(dbPath).size,
        };
        console.log(JSON.stringify({
            ok: true, dryRun: false,
            dbPath, schemaVersion,
            updated,
            measurement: {
                before, after,
                freedBytes: before.totalBytes - after.totalBytes,
                freedMB: ((before.totalBytes - after.totalBytes) / 1e6).toFixed(2),
                note: "receipt 字节已减少；文件缩小需 VACUUM",
            },
        }, null, 2));
    } catch (error) {
        db.db.exec("ROLLBACK");
        throw error;
    } finally {
        db.close();
    }
}

try {
    main();
} catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exitCode = 1;
}
