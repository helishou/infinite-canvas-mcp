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
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert";
import { BackendDatabase } from "../db.js";
import { dedupReceipt, resolveReceiptDedup, RECEIPT_DEDUP_MARKER } from "../drama/receipt-dedup.js";
import type { ProductionRecord } from "../drama/production.js";

const require = createRequire(import.meta.url);
const { BACKEND_DATABASE_PATH } = require("../config.js") as { BACKEND_DATABASE_PATH: string };

function parseArgs(args: string[]): { apply: boolean } {
    let apply = false;
    for (const arg of args) {
        if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
        if (!arg.startsWith("--")) throw new Error("不支持的位置参数: " + arg);
        throw new Error("未知参数: " + arg);
    }
    return { apply };
}

function tableBytes(db: BackendDatabase, table: string): number {
    const row = db.db.prepare("SELECT COALESCE(SUM(pgsize),0) b FROM dbstat WHERE name = ?").get(table) as { b: number } | null;
    return row?.b ?? 0;
}

function main(): void {
    const { apply } = parseArgs(process.argv.slice(2));
    const dbPath = process.env.INFINITE_CANVAS_DATA_DIR
        ? path.join(process.env.INFINITE_CANVAS_DATA_DIR, "runtime.sqlite")
        : BACKEND_DATABASE_PATH;
    if (!fs.existsSync(dbPath)) {
        console.error(JSON.stringify({ ok: false, code: "MISSING_DATABASE", error: "数据库不存在，拒绝创建: " + dbPath }, null, 2));
        process.exitCode = 1; return;
    }

    const db = new BackendDatabase(dbPath);
    const schemaVersion = db.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v as number;

    // 读取所有行
    const rows = db.db.prepare("SELECT operation_id, receipt_json FROM episode_production_operations").all() as Array<{ operation_id: string; receipt_json: string }>;

    const before = {
        rowCount: rows.length,
        totalBytes: rows.reduce((s, r) => s + r.receipt_json.length, 0),
        tableBytes: tableBytes(db, "episode_production_operations"),
        file: fs.statSync(dbPath).size,
    };

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

    for (const row of rows) {
        let original: ProductionRecord;
        try {
            original = JSON.parse(row.receipt_json) as ProductionRecord;
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
        const compressedJson = JSON.stringify(compressed);
        candidates.push({
            operationId: row.operation_id,
            originalLen: row.receipt_json.length,
            compressedLen: compressedJson.length,
            savedBytes: row.receipt_json.length - compressedJson.length,
            fields,
            verified,
        });
    }

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
            const row = db.db.prepare("SELECT receipt_json FROM episode_production_operations WHERE operation_id = ?").get(c.operationId) as { receipt_json: string } | undefined;
            if (!row) continue;
            const original = JSON.parse(row.receipt_json) as ProductionRecord;
            const compressed = dedupReceipt(original);
            if (!(RECEIPT_DEDUP_MARKER in (compressed as Record<string, unknown>))) continue;
            // 事务内再验证一次
            const expanded = resolveReceiptDedup(compressed);
            deepStrictEqual(expanded, original);
            updateStmt.run(JSON.stringify(compressed), c.operationId);
            updated++;
        }
        db.db.exec("COMMIT");

        const afterRows = db.db.prepare("SELECT operation_id, receipt_json FROM episode_production_operations").all() as Array<{ operation_id: string; receipt_json: string }>;
        const after = {
            rowCount: afterRows.length,
            totalBytes: afterRows.reduce((s, r) => s + r.receipt_json.length, 0),
            tableBytes: tableBytes(db, "episode_production_operations"),
            dedupedCount: afterRows.filter(r => r.receipt_json.includes("__receiptDedupV1")).length,
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
