/**
 * re-baseline：对历史已坏（blocked）的画布项目，用当前真实状态重建历史锚点。
 *
 * capacity-optimization-plan.md v3 §6：
 * - 不是对任意 blocked 原因的通用删除开关：只有可处理诊断码（回放不匹配 / 链缺口 / 缺 checkpoint / 旧操作回放失败）才准入
 * - 完整内容指纹（data_json + checkpoint + batches + receipts + schema）：同 revision 下的内容变化也拒绝
 * - 备份先校验（integrity + foreign_key + 逻辑 digest），BEGIN IMMEDIATE 内重新指纹复核
 * - 保留命令身份：不删 canvas_command_receipts/mcp_command_receipts，不补造 operation hash
 * - 损失明确：旧 revision 快照恢复范围不可用（RECEIPT_UNAVAILABLE），命令身份仍可查询
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "../config.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { previewCanvasHistoryPrune, reconstructCanvasHistory } from "../canvas/history-maintenance.js";
import { stripCanvasLocalViewState } from "../canvas/operation-authority.js";

export const REBALANCE_POLICY_VERSION = 1;

/** 稳定诊断码：只有这些才允许 re-baseline，其他 blocked 原因一律拒绝。 */
export const REBALANCE_ELIGIBLE_CODES = new Set([
    "HISTORY_REPLAY_MISMATCH",
    "HISTORY_CHAIN_GAP",
    "MISSING_CHECKPOINT",
    "OPERATION_REPLAY_FAILED",
]);

export type RebalanceDiagnostics = {
    reasonCode: string;
    blockedReason: string;
    eligible: boolean;
};

export function diagnoseBlockedProject(db: DatabaseSync, projectId: string): RebalanceDiagnostics {
    const preview = previewCanvasHistoryPrune(db, "1970-01-01T00:00:00.000Z")
        .find(p => p.projectId === projectId);
    if (!preview) return { reasonCode: "UNKNOWN", blockedReason: "project not found", eligible: false };
    const blockedReason = preview.blockedReason ?? "";
    let reasonCode: string;
    if (!blockedReason) return { reasonCode: "HEALTHY", blockedReason: "", eligible: false };
    if (blockedReason === "Missing history checkpoint") reasonCode = "MISSING_CHECKPOINT";
    else if (blockedReason === "History replay does not match the current project") reasonCode = "HISTORY_REPLAY_MISMATCH";
    else if (blockedReason === "Invalid batch boundary, date or missing receipt"
        || blockedReason.startsWith("Operation replay")) reasonCode = "HISTORY_CHAIN_GAP";
    else if (blockedReason.startsWith("Cannot replay")) reasonCode = "OPERATION_REPLAY_FAILED";
    else reasonCode = "UNKNOWN";
    return { reasonCode, blockedReason, eligible: REBALANCE_ELIGIBLE_CODES.has(reasonCode) };
}

// ─── 完整内容指纹 ───

export type RebalanceFingerprint = {
    dataJson: string;
    checkpoint: { present: boolean; revision: number | null; dataJson: string | null };
    batches: { count: number; digest: string };
    receipts: { count: number; digest: string };
    schemaVersion: number;
    fingerprint: string;
};

export function computeRebalanceFingerprint(db: DatabaseSync, projectId: string): RebalanceFingerprint {
    const project = db.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(projectId) as { data_json: string } | undefined;
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const dataJson = project.data_json;

    const checkpoint = db.prepare("SELECT revision, data_json FROM canvas_collaboration_checkpoints WHERE project_id = ?").get(projectId) as { revision: number; data_json: string } | undefined;

    const batchRows = db.prepare(
        "SELECT operation_id, base_revision, revision, source_json, operations_json, results_json, created_at FROM canvas_operation_batches WHERE project_id = ? ORDER BY revision, operation_id"
    ).all(projectId) as Array<Record<string, unknown>>;

    const receiptRows = db.prepare(
        "SELECT operation_id, project_id, request_hash, committed_revision FROM canvas_command_receipts WHERE project_id = ? ORDER BY operation_id"
    ).all(projectId) as Array<Record<string, unknown>>;

    const hash = crypto.createHash("sha256");
    hash.update("dataJson\0");
    hash.update(dataJson, "utf8");
    hash.update("\0checkpoint\0");
    if (checkpoint) {
        hash.update(`present=1\0revision=${checkpoint.revision}\0`);
        hash.update(checkpoint.data_json, "utf8");
    } else {
        hash.update("present=0\0");
    }
    hash.update("\0batches\0count=");
    hash.update(String(batchRows.length));
    for (const row of batchRows) {
        hash.update("\0");
        hash.update(String(row.operation_id));
        hash.update("\0");
        hash.update(String(row.base_revision));
        hash.update("\0");
        hash.update(String(row.revision));
        hash.update("\0");
        hash.update(String(row.source_json));
        hash.update("\0");
        hash.update(String(row.operations_json));
        hash.update("\0");
        hash.update(String(row.results_json));
        hash.update("\0");
        hash.update(String(row.created_at));
    }
    hash.update("\0receipts\0count=");
    hash.update(String(receiptRows.length));
    for (const row of receiptRows) {
        hash.update("\0");
        hash.update(String(row.operation_id));
        hash.update("\0");
        hash.update(String(row.project_id));
        hash.update("\0");
        hash.update(String(row.request_hash));
        hash.update("\0");
        hash.update(String(row.committed_revision));
    }
    const schemaVersion = Number(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v ?? 0);
    hash.update("\0schema\0");
    hash.update(String(schemaVersion));

    return {
        dataJson,
        checkpoint: { present: !!checkpoint, revision: checkpoint?.revision ?? null, dataJson: checkpoint?.data_json ?? null },
        batches: { count: batchRows.length, digest: "" },
        receipts: { count: receiptRows.length, digest: "" },
        schemaVersion,
        fingerprint: hash.digest("hex"),
    };
}

// ─── 准入校验 ───

export type RebalancePlan = {
    formatVersion: number;
    policyVersion: number;
    projectId: string;
    currentRevision: number;
    blockedReason: string;
    reasonCode: string;
    fingerprint: RebalanceFingerprint;
    lossNotes: string[];
    createdAt: string;
};

export function buildRebalancePlan(db: DatabaseSync, projectId: string): RebalancePlan {
    const version = Number(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v ?? 0);
    if (version !== DATABASE_SCHEMA_VERSION) throw new Error(`re-baseline requires schema ${DATABASE_SCHEMA_VERSION}; got ${version}`);

    const project = db.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(projectId) as { data_json: string } | undefined;
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // 当前画布契约：可解析、ID 正确、revision 合法
    let current: Record<string, unknown>;
    try {
        current = JSON.parse(project.data_json) as Record<string, unknown>;
    } catch {
        throw new Error("当前 data_json 无法解析，拒绝 re-baseline");
    }
    if (current.id !== projectId) throw new Error("data_json 内的 project ID 与数据库 ID 不一致");
    const currentRevision = Number(current.revision ?? 0);
    if (!Number.isInteger(currentRevision) || currentRevision < 0) throw new Error("revision 不是合法非负整数");

    // 节点身份：无重复 ID
    const nodeIds = new Set<string>();
    for (const node of (current.nodes ?? []) as Array<Record<string, unknown>>) {
        const nid = node.id as string | undefined;
        if (typeof nid === "string" && nid) {
            if (nodeIds.has(nid)) throw new Error(`节点 ID 重复：${nid}`);
            nodeIds.add(nid);
        }
    }
    // 连接引用：from/to 必须存在
    for (const conn of (current.connections ?? []) as Array<Record<string, unknown>>) {
        const from = conn.from as string | undefined;
        const to = conn.to as string | undefined;
        if (typeof from === "string" && from && !nodeIds.has(from)) throw new Error(`连接引用不存在的节点：${from}`);
        if (typeof to === "string" && to && !nodeIds.has(to)) throw new Error(`连接引用不存在的节点：${to}`);
    }

    // 诊断：只有可处理 blocked 原因才准入
    const diagnostics = diagnoseBlockedProject(db, projectId);
    if (!diagnostics.blockedReason) throw new Error("项目历史健康（未 blocked），不需要 re-baseline；请用正常 prune");
    if (!diagnostics.eligible) throw new Error(`blocked 原因 ${diagnostics.reasonCode} 不可 re-baseline：${diagnostics.blockedReason}`);

    // batches：无未来 revision、每个 batch 有命令身份凭据
    const batchRows = db.prepare(
        "SELECT b.operation_id, b.revision, b.created_at, r.request_hash FROM canvas_operation_batches b LEFT JOIN canvas_command_receipts r ON r.operation_id = b.operation_id AND r.project_id = b.project_id WHERE b.project_id = ? ORDER BY b.revision"
    ).all(projectId) as Array<{ operation_id: string; revision: number; created_at: string; request_hash: string | null }>;
    for (const row of batchRows) {
        if (row.revision > currentRevision) throw new Error(`batch ${row.operation_id} 有未来 revision ${row.revision} > 当前 ${currentRevision}`);
        if (!row.request_hash) throw new Error(`batch ${row.operation_id} 缺命令身份凭据（request_hash）`);
        if (!Number.isFinite(Date.parse(row.created_at))) throw new Error(`batch ${row.operation_id} 日期无效`);
    }

    const fingerprint = computeRebalanceFingerprint(db, projectId);

    // 损失范围
    const lossNotes: string[] = [];
    if (batchRows.length) {
        lossNotes.push(`删除 ${batchRows.length} 个历史 batch（revision ${Math.min(...batchRows.map(r => r.revision))}–${Math.max(...batchRows.map(r => r.revision))}）`);
        lossNotes.push("旧 revision 快照恢复范围不可用（reconstructCanvasHistory 对旧 revision 返回 RECEIPT_UNAVAILABLE）");
    } else {
        lossNotes.push("无历史 batch 可删");
    }
    lossNotes.push("命令身份凭据保留：canvas_command_receipts 不删除，原 operationId 仍可查询 committed 身份");
    lossNotes.push("不修改 canvas_projects、不删除 mcp_command_receipts、不补造 operation hash");

    return {
        formatVersion: 1,
        policyVersion: REBALANCE_POLICY_VERSION,
        projectId,
        currentRevision,
        blockedReason: diagnostics.blockedReason,
        reasonCode: diagnostics.reasonCode,
        fingerprint,
        lossNotes,
        createdAt: new Date().toISOString(),
    };
}

// ─── 应用 ───

export type RebalanceApplyResult = {
    projectId: string;
    batchesDeleted: number;
    checkpointRevision: number;
    backupFile: string;
    lossNotes: string[];
};

export function applyRebalancePlan(db: DatabaseSync, dbFile: string, plan: RebalancePlan): RebalanceApplyResult {
    if (plan.formatVersion !== 1) throw new Error("计划格式版本不匹配");
    if (plan.policyVersion !== REBALANCE_POLICY_VERSION) throw new Error("计划策略版本不匹配");
    if (plan.projectId !== db.prepare("SELECT id FROM canvas_projects WHERE id = ?").get(plan.projectId)?.id) throw new Error("项目不存在");

    // 备份（integrity + foreign_key）
    const backupFile = `${dbFile}.rebaseline-${plan.projectId}-${crypto.randomUUID()}.sqlite`;
    db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
    fs.chmodSync(backupFile, 0o600);
    const copy = new DatabaseSync(backupFile, { readOnly: true });
    try {
        if (copy.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
            || copy.prepare("PRAGMA foreign_key_check").all().length)
            throw new Error("re-baseline 备份校验失败");
        const backupFingerprint = computeRebalanceFingerprint(copy, plan.projectId);
        if (backupFingerprint.fingerprint !== plan.fingerprint.fingerprint) throw new Error("备份与计划指纹不一致");
    } finally { copy.close(); }

    db.exec("BEGIN IMMEDIATE");
    try {
        // 事务内复核：指纹必须与计划一致（同 revision 内容变化也拒绝）
        const liveFingerprint = computeRebalanceFingerprint(db, plan.projectId);
        if (liveFingerprint.fingerprint !== plan.fingerprint.fingerprint) {
            throw new Error("项目状态在备份后发生变化（指纹不一致），拒绝 re-baseline");
        }
        const dataJson = liveFingerprint.dataJson;
        const current = JSON.parse(dataJson) as Record<string, unknown>;
        const currentRevision = Number(current.revision ?? 0);
        if (currentRevision !== plan.currentRevision) throw new Error("revision 在备份后变化");

        // 建/更新 checkpoint（当前真实状态，非回放产物）
        db.prepare(
            "INSERT INTO canvas_collaboration_checkpoints (project_id, revision, data_json) VALUES (?, ?, ?) " +
            "ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, data_json = excluded.data_json"
        ).run(plan.projectId, currentRevision, dataJson);

        // 只删该项目 batches
        const batchesDeleted = Number(db.prepare("DELETE FROM canvas_operation_batches WHERE project_id = ?").run(plan.projectId).changes);

        // 删除后重建当前 revision 必须等于当前规范状态
        const rebuilt = reconstructCanvasHistory(db, plan.projectId, currentRevision);
        const expected = stripCanvasLocalViewState(JSON.parse(dataJson) as Record<string, unknown>);
        if (JSON.stringify(rebuilt) !== JSON.stringify(expected)) throw new Error("re-baseline 后当前 revision 重建不等于当前状态");

        if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("re-baseline 引入外键违例");
        db.exec("COMMIT");

        return {
            projectId: plan.projectId,
            batchesDeleted,
            checkpointRevision: currentRevision,
            backupFile,
            lossNotes: plan.lossNotes,
        };
    } catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}

// ─── CLI ───

if (process.argv[1] && process.argv[1].endsWith("rebalance-canvas-history.ts")) {
    const args = process.argv.slice(2);
    function fail(msg: string): never { console.error(`Usage: rebalance-canvas-history <projectId> --write-plan=<file> | --apply-plan=<file> --accept-history-loss`); console.error(msg); process.exit(1); }
    if (args.includes("--help")) { console.log("rebalance-canvas-history <projectId> --write-plan=<file> | --apply-plan=<file> --accept-history-loss"); process.exit(0); }
    if (!fs.existsSync(DB_FILE)) fail("数据库不存在，拒绝创建空库进行维护");
    const db = new DatabaseSync(DB_FILE);
    try {
        const projectId = args.find(a => !a.startsWith("--"));
        const writePlan = args.find(a => a.startsWith("--write-plan="));
        const applyPlan = args.find(a => a.startsWith("--apply-plan="));
        if (!projectId && !applyPlan) fail("缺少 projectId 或 --apply-plan");
        if (writePlan && applyPlan) fail("--write-plan 与 --apply-plan 互斥");

        if (writePlan) {
            if (!projectId) fail("--write-plan 需要 projectId");
            const planFile = writePlan.slice("--write-plan=".length);
            const plan = buildRebalancePlan(db, projectId);
            fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf8");
            console.log(JSON.stringify({ ok: true, action: "plan", projectId, planFile, lossNotes: plan.lossNotes }));
        } else if (applyPlan) {
            if (!args.includes("--accept-history-loss")) fail("apply 需要 --accept-history-loss 确认历史损失");
            const planFile = applyPlan.slice("--apply-plan=".length);
            const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as RebalancePlan;
            const result = applyRebalancePlan(db, DB_FILE, plan);
            console.log(JSON.stringify({ ok: true, action: "apply", ...result }));
        } else {
            fail("缺少 --write-plan 或 --apply-plan");
        }
    } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exit(1);
    } finally {
        try { db.close(); } catch { /* already closed */ }
    }
}
