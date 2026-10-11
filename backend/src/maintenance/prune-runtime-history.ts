/**
 * 原子清理 CLI：按统一保留策略删除任务、日志、事件。
 *
 * 只读评估（evaluateRetention）确定候选；
 * --apply 在单个事务内：复核 → recordTaskTombstone → DELETE 任务族
 * （task_events 级联）→ DELETE generation_logs → COMMIT → 分项测量。
 *
 * 默认 dry-run：只报告候选，不写库。
 *
 * 用法：
 *   node --import tsx src/maintenance/prune-runtime-history.ts
 *   node --import tsx src/maintenance/prune-runtime-history.ts --succeeded-days=30 --failed-days=90 --apply
 *
 * 严格参数：--name=value；拒绝缺值、重复、未知、非整数。
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { BackendDatabase } from "../db.js";
import { evaluateRetention, type HistoryPolicyConfig } from "./runtime-history-policy.js";

const require = createRequire(import.meta.url);
const { BACKEND_DATABASE_PATH } = require("../config.js") as { BACKEND_DATABASE_PATH: string };

function parseArgs(args: string[]): { apply: boolean; config: HistoryPolicyConfig } {
    const flags = new Map<string, string>();
    let apply = false;
    const known = new Set(["apply", "succeeded-days", "failed-days", "cancelled-days", "success-days", "failed-log-days", "cancelled-log-days", "log-count-limit"]);
    for (const arg of args) {
        if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
        if (!arg.startsWith("--")) throw new Error("不支持的位置参数: " + arg);
        const eq = arg.indexOf("=");
        if (eq < 0) throw new Error("参数缺值，应为 --name=value: " + arg);
        const name = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        if (!known.has(name)) throw new Error("未知参数: --" + name);
        if (flags.has(name)) throw new Error("重复参数: --" + name);
        if (!/^\d+$/.test(value)) throw new Error("参数值必须是正整数: --" + name);
        flags.set(name, value);
    }
    const config: HistoryPolicyConfig = {};
    if (flags.has("succeeded-days")) config.taskSucceededDays = Number(flags.get("succeeded-days"));
    if (flags.has("failed-days")) config.taskFailedDays = Number(flags.get("failed-days"));
    if (flags.has("cancelled-days")) config.taskCancelledDays = Number(flags.get("cancelled-days"));
    if (flags.has("success-days")) config.logSuccessDays = Number(flags.get("success-days"));
    if (flags.has("failed-log-days")) config.logFailedDays = Number(flags.get("failed-log-days"));
    if (flags.has("cancelled-log-days")) config.logCancelledDays = Number(flags.get("cancelled-log-days"));
    if (flags.has("log-count-limit")) config.logCountLimit = Number(flags.get("log-count-limit"));
    return { apply, config };
}

function tableBytes(db: BackendDatabase, table: string): number {
    const row = db.db.prepare("SELECT COALESCE(SUM(pgsize),0) b FROM dbstat WHERE name = ?").get(table) as { b: number } | null;
    return row?.b ?? 0;
}

function fileSize(file: string): number {
    return fs.statSync(file).size;
}

function main(): void {
    const { apply, config } = parseArgs(process.argv.slice(2));
    const dbPath = process.env.INFINITE_CANVAS_DATA_DIR
        ? path.join(process.env.INFINITE_CANVAS_DATA_DIR, "runtime.sqlite")
        : BACKEND_DATABASE_PATH;
    if (!fs.existsSync(dbPath)) {
        console.error(JSON.stringify({ ok: false, code: "MISSING_DATABASE", error: "数据库不存在，拒绝创建: " + dbPath }, null, 2));
        process.exitCode = 1; return;
    }

    const db = new BackendDatabase(dbPath);
    const schemaVersion = db.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v as number;

    // 评估（只读）
    const report = evaluateRetention(db.db, config);
    const candidateTasks = report.taskCandidates.filter((t) => !t.protected);
    const candidateLogs = report.logCandidates.filter((l) => !l.protected);

    // 分项测量（当前）
    const before = {
        tasks: tableBytes(db, "tasks"),
        taskEvents: tableBytes(db, "task_events"),
        generationLogs: tableBytes(db, "generation_logs"),
        file: fileSize(dbPath),
    };

    if (!apply) {
        console.log(JSON.stringify({
            ok: true, dryRun: true,
            dbPath, schemaVersion,
            config,
            summary: report.summary,
            candidates: {
                tasks: candidateTasks.map((t) => ({ id: t.id, status: t.status, ageDays: t.ageDays, familyIds: t.familyIds, logIds: t.logIds, reasons: t.reasons })),
                logs: candidateLogs.map((l) => ({ id: l.id, projectId: l.projectId, status: l.status, ageDays: l.ageDays, reasons: l.reasons })),
            },
            anomalies: report.anomalies,
            current: before,
            note: "dry-run 只报告候选；--apply 执行删除",
        }, null, 2));
        db.close();
        return;
    }

    // --apply：事务内执行
    const taskIds = candidateTasks.map((t) => t.id);
    const logIds = candidateLogs.map((l) => l.id);
    db.db.exec("BEGIN IMMEDIATE");
    try {
        let deletedTasks = 0;
        if (taskIds.length > 0) {
            const ph = taskIds.map(() => "?").join(",");
            // 写 tombstone（在 DELETE 前，保留凭据）
            for (const id of taskIds) {
                const task = db.db.prepare("SELECT id, kind, status, created_at, updated_at FROM tasks WHERE id = ?").get(id) as { id: string; kind: string; status: string; created_at: string; updated_at: string } | null;
                if (task) db.recordTaskTombstone(task.id, task.kind, task.status, task.created_at, task.updated_at, 1);
            }
            const res = db.db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...taskIds);
            deletedTasks = Number(res.changes);
            // task_events FK ON DELETE CASCADE（BackendDatabase 构造时 PRAGMA foreign_keys=ON）
            // 显式删以确保不依赖 cascade
            db.db.prepare(`DELETE FROM task_events WHERE task_id IN (${ph})`).run(...taskIds);
        }
        let deletedLogs = 0;
        if (logIds.length > 0) {
            const ph = logIds.map(() => "?").join(",");
            const res = db.db.prepare(`DELETE FROM generation_logs WHERE id IN (${ph})`).run(...logIds);
            deletedLogs = Number(res.changes);
        }
        db.db.exec("COMMIT");

        const after = {
            tasks: tableBytes(db, "tasks"),
            taskEvents: tableBytes(db, "task_events"),
            generationLogs: tableBytes(db, "generation_logs"),
            file: fileSize(dbPath),
        };
        console.log(JSON.stringify({
            ok: true, dryRun: false,
            dbPath, schemaVersion,
            deleted: { tasks: deletedTasks, generationLogs: deletedLogs, taskEvents: "cascaded + explicit" },
            measurement: {
                before, after,
                freedBytes: before.file - after.file,
                note: "DELETE 释放空闲页但不缩小文件；压缩需 VACUUM（备份或维护窗口执行）",
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
