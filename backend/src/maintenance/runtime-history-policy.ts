/**
 * 统一保留策略：同时决定任务、生成日志及其关联记录能否清理。
 *
 * 设计原则（capacity-optimization-plan.md v3 §3）：
 * - 只读，不修改数据库
 * - 按完整任务族处理：任何成员有业务引用/运行/恢复依赖 → 整族保留
 * - 来源清单 schema 绑定：每次 schema 变更必须同步更新
 * - 保守多留：无法证明无引用时保留，不借容量清理修复数据异常
 *
 * 本模块不执行删除，只返回候选集合和保留原因。
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

// ─── 类型 ───

export type HistoryPolicyConfig = {
    /** 任务各状态保留天数；未提供 = 该状态不获准清理 */
    taskSucceededDays?: number;
    taskFailedDays?: number;
    taskCancelledDays?: number;
    /** 日志各状态保留天数 */
    logSuccessDays?: number;
    logFailedDays?: number;
    logCancelledDays?: number;
    /** 数量整理：每项目最多保留条数（null = 不启用） */
    logCountLimit?: number;
    /** 固定 now（ISO），所有 cutoff 由此计算；缺省 = 当前时间 */
    now?: string;
};

export type RetentionReason =
    | "non-terminal-status"
    | "has-production-binding"
    | "referenced-by-canvas-node"
    | "referenced-by-production-record"
    | "referenced-by-command-receipt"
    | "referenced-by-preparation"
    | "referenced-by-history-batch"
    | "has-active-family-member"
    | "unknown-status"
    | "invalid-time"
    | "unparseable-json"
    | "integrity-anomaly"
    | "protected-by-family"
    | "count-policy-protected";

export type TaskInfo = {
    id: string;
    kind: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    parentTaskId: string | null;
    boundLogId: string | null;
};

export type LogInfo = {
    id: string;
    projectId: string;
    nodeId: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
    runtimeTaskId: string | null;
};

export type RetentionReport = {
    schemaVersion: number;
    policyVersion: number;
    now: string;
    taskCandidates: Array<{
        id: string;
        status: string;
        createdAt: string;
        updatedAt: string;
        ageDays: number;
        protected: boolean;
        reasons: RetentionReason[];
        familyIds: string[];
        logIds: string[];
    }>;
    logCandidates: Array<{
        id: string;
        projectId: string;
        status: string;
        createdAt: string;
        ageDays: number;
        protected: boolean;
        reasons: RetentionReason[];
        countRank: number | null;
    }>;
    anomalies: Array<{ type: string; detail: string; taskId?: string; logId?: string }>;
    summary: {
        totalTasks: number;
        totalLogs: number;
        protectedTasks: number;
        protectedLogs: number;
        candidateTasks: number;
        candidateLogs: number;
        reasonCounts: Record<string, number>;
    };
};

// ─── 常量 ───

const POLICY_VERSION = 1;
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_LOG_STATUSES = new Set(["success", "failed", "cancelled"]);

/**
 * 来源清单：schema 绑定的持久业务记录来源。
 * 每次 schema 变更或新增持久 task/log 引用时，必须同步更新此清单和对应测试。
 */
const SOURCE_MANIFEST = {
    minSchema: 31,
    // 节点 metadata 中已知的 task ID 字段
    canvasNodeTaskFields: [
        "runtimeTaskId", "generationTaskId", "sourceRuntimeTaskId",
        "baseGenerationTaskId", "sourceTaskId", "concatTaskId", "correctedClip4TaskId",
    ] as const,
    // 正式制作表（动态映射：episode/canvas 两组同构表）
    productionTables: [
        "episode_productions", "canvas_productions",
        "episode_production_operations", "canvas_production_operations",
        "episode_production_versions", "canvas_production_versions",
        "episode_production_runs", "canvas_production_runs",
        "episode_production_batches", "canvas_production_batches",
    ] as const,
    // 命令/操作回执表
    receiptTables: [
        "mcp_command_receipts",
        "canvas_command_receipts",
        "canvas_operation_batches",
        "canvas_collaboration_checkpoints",
        "production_preparations",
    ] as const,
} as const;

// ─── 工具函数 ───

function parseIso(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : value;
}

function ageDays(now: string, target: string): number {
    return (new Date(now).getTime() - new Date(target).getTime()) / 86_400_000;
}

/** 递归提取 JSON 值中所有字符串（不输出正文，只收集 ID 候选）。 */
function extractStringValues(value: unknown, out: Set<string>, depth = 0): void {
    if (depth > 12) return;
    if (typeof value === "string") { out.add(value); return; }
    if (Array.isArray(value)) { for (const v of value) extractStringValues(v, out, depth + 1); return; }
    if (value && typeof value === "object") {
        for (const v of Object.values(value as Record<string, unknown>)) extractStringValues(v, out, depth + 1);
    }
}

/** 检查表是否存在。 */
function tableExists(db: DatabaseSync, name: string): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** 获取表的 JSON 列名。 */
function jsonColumns(db: DatabaseSync, table: string): string[] {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>;
    return cols.filter(c => c.type === "TEXT" && (c.name.endsWith("_json") || c.name === "data_json")).map(c => c.name);
}

// ─── 核心函数 ───

export function evaluateRetention(db: DatabaseSync, config: HistoryPolicyConfig): RetentionReport {
    const now = config.now ?? new Date().toISOString();
    const schemaVersion = Number(
        db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v ?? 0
    );
    if (schemaVersion < SOURCE_MANIFEST.minSchema) {
        throw new Error(`Schema v${schemaVersion} 低于策略最低要求 v${SOURCE_MANIFEST.minSchema}`);
    }

    // 1. 收集所有 task/log ID
    const taskIds = new Set<string>();
    for (const row of db.prepare("SELECT id FROM tasks").all() as Array<{ id: string }>) taskIds.add(row.id);
    const logIds = new Set<string>();
    for (const row of db.prepare("SELECT id FROM generation_logs").all() as Array<{ id: string }>) logIds.add(row.id);

    // 2. 读取任务基础信息
    type RawTask = { id: string; kind: string; status: string; created_at: string; updated_at: string; params_json: string };
    const rawTasks: RawTask[] = db.prepare(
        "SELECT id, kind, status, created_at, updated_at, params_json FROM tasks"
    ).all() as RawTask[];

    const tasks = new Map<string, TaskInfo>();
    const anomalies: RetentionReport["anomalies"] = [];
    for (const row of rawTasks) {
        let parentTaskId: string | null = null;
        let boundLogId: string | null = null;
        let params: Record<string, unknown> = {};
        try {
            params = JSON.parse(row.params_json) as Record<string, unknown>;
        } catch {
            anomalies.push({ type: "unparseable-json", detail: `tasks.params_json 无法解析`, taskId: row.id });
        }
        const p = params.parentTaskId;
        if (typeof p === "string" && p) {
            parentTaskId = p;
            if (!taskIds.has(p)) anomalies.push({ type: "integrity-anomaly", detail: `父任务 ${p} 不存在`, taskId: row.id });
        }
        const cb = params.canvasBinding as Record<string, unknown> | undefined;
        if (cb && typeof cb.generationLogId === "string" && cb.generationLogId) {
            boundLogId = cb.generationLogId;
            if (!logIds.has(boundLogId)) anomalies.push({ type: "integrity-anomaly", detail: `绑定日志 ${boundLogId} 不存在`, taskId: row.id });
        }
        tasks.set(row.id, {
            id: row.id, kind: row.kind, status: row.status,
            createdAt: row.created_at, updatedAt: row.updated_at,
            parentTaskId, boundLogId,
        });
    }

    // 3. 读取日志基础信息
    type RawLog = { id: string; project_id: string; node_id: string | null; status: string; created_at: string; updated_at: string; finished_at: string | null; runtime_task_id: string | null };
    const rawLogs: RawLog[] = db.prepare(
        "SELECT id, project_id, node_id, status, created_at, updated_at, finished_at, runtime_task_id FROM generation_logs"
    ).all() as RawLog[];

    const logs = new Map<string, LogInfo>();
    for (const row of rawLogs) {
        if (row.runtime_task_id && !taskIds.has(row.runtime_task_id)) {
            anomalies.push({ type: "integrity-anomaly", detail: `runtime_task_id ${row.runtime_task_id} 不存在`, logId: row.id });
        }
        logs.set(row.id, {
            id: row.id, projectId: row.project_id, nodeId: row.node_id,
            status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
            finishedAt: row.finished_at, runtimeTaskId: row.runtime_task_id,
        });
    }

    // 4. 收集保护根
    const protectedTasks = new Set<string>();
    const protectedLogs = new Set<string>();
    const reasonMap = new Map<string, Set<RetentionReason>>();
    const addReason = (key: string, reason: RetentionReason) => {
        if (!reasonMap.has(key)) reasonMap.set(key, new Set());
        reasonMap.get(key)!.add(reason);
    };

    // 4a. production_task_bindings（所有状态）
    if (tableExists(db, "production_task_bindings")) {
        for (const row of db.prepare("SELECT task_id FROM production_task_bindings").all() as Array<{ task_id: string }>) {
            protectedTasks.add(row.task_id);
            addReason(row.task_id, "has-production-binding");
        }
    }

    // 4b. canvas_projects.data_json → 节点 metadata 中的 task ID
    const existingNodeIds = new Set<string>();
    for (const row of db.prepare("SELECT data_json FROM canvas_projects").all() as Array<{ data_json: string }>) {
        let data: { nodes?: Array<{ id?: string; metadata?: Record<string, unknown> }> };
        try { data = JSON.parse(row.data_json); } catch { continue; }
        for (const node of data.nodes ?? []) {
            if (node.id) existingNodeIds.add(node.id);
            const meta = node.metadata ?? {};
            for (const field of SOURCE_MANIFEST.canvasNodeTaskFields) {
                const val = meta[field];
                if (typeof val === "string" && val && taskIds.has(val)) {
                    protectedTasks.add(val);
                    addReason(val, "referenced-by-canvas-node");
                }
            }
        }
    }

    // 4c. generation_logs.node_id → 现存节点（日志通过 node_id 关联到画布节点）
    for (const log of logs.values()) {
        if (log.nodeId && existingNodeIds.has(log.nodeId)) {
            protectedLogs.add(log.id);
            addReason(log.id, "referenced-by-canvas-node");
        }
    }

    // 4d. 正式制作表（episode/canvas/scene 三组）
    for (const table of SOURCE_MANIFEST.productionTables) {
        if (!tableExists(db, table)) continue;
        const cols = jsonColumns(db, table);
        if (!cols.length) continue;
        const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
            for (const col of cols) {
                const val = row[col];
                if (typeof val !== "string" || !val) continue;
                let parsed: unknown;
                try { parsed = JSON.parse(val); } catch { continue; }
                const strings = new Set<string>();
                extractStringValues(parsed, strings);
                for (const s of strings) {
                    if (taskIds.has(s)) { protectedTasks.add(s); addReason(s, "referenced-by-production-record"); }
                    if (logIds.has(s)) { protectedLogs.add(s); addReason(s, "referenced-by-production-record"); }
                }
            }
        }
    }

    // 4e. 命令/操作回执表
    for (const table of SOURCE_MANIFEST.receiptTables) {
        if (!tableExists(db, table)) continue;
        const cols = jsonColumns(db, table);
        if (!cols.length) continue;
        const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
            for (const col of cols) {
                const val = row[col];
                if (typeof val !== "string" || !val) continue;
                let parsed: unknown;
                try { parsed = JSON.parse(val); } catch { continue; }
                const strings = new Set<string>();
                extractStringValues(parsed, strings);
                for (const s of strings) {
                    if (taskIds.has(s)) {
                        protectedTasks.add(s);
                        addReason(s, table === "production_preparations" ? "referenced-by-preparation"
                            : table === "canvas_operation_batches" ? "referenced-by-history-batch"
                            : "referenced-by-command-receipt");
                    }
                    if (logIds.has(s)) {
                        protectedLogs.add(s);
                        addReason(s, table === "production_preparations" ? "referenced-by-preparation"
                            : table === "canvas_operation_batches" ? "referenced-by-history-batch"
                            : "referenced-by-command-receipt");
                    }
                }
            }
        }
    }

    // 4f. task_events 中的关联（事件随任务级联，不独立保护，但事件中的关联形成图边）
    const eventTaskLinks = new Map<string, Set<string>>(); // task → 关联 task/log IDs
    if (tableExists(db, "task_events")) {
        const events = db.prepare("SELECT task_id, payload_json FROM task_events").all() as Array<{ task_id: string; payload_json: string }>;
        for (const ev of events) {
            if (!taskIds.has(ev.task_id)) continue;
            let payload: Record<string, unknown>;
            try { payload = JSON.parse(ev.payload_json); } catch { continue; }
            const strings = new Set<string>();
            extractStringValues(payload, strings);
            const linked = new Set<string>();
            for (const s of strings) {
                if (taskIds.has(s)) linked.add(`task:${s}`);
                if (logIds.has(s)) linked.add(`log:${s}`);
            }
            if (linked.size) {
                if (!eventTaskLinks.has(ev.task_id)) eventTaskLinks.set(ev.task_id, new Set());
                for (const l of linked) eventTaskLinks.get(ev.task_id)!.add(l);
            }
        }
    }

    // 5. 构建关联图并传播保护
    // 图节点：`task:<id>` 或 `log:<id>`
    // 边：父子任务、log↔task、事件关联
    type NodeKey = string; // "task:xxx" | "log:xxx"
    const graph = new Map<NodeKey, Set<NodeKey>>();
    const addEdge = (a: NodeKey, b: NodeKey) => {
        if (!graph.has(a)) graph.set(a, new Set());
        if (!graph.has(b)) graph.set(b, new Set());
        graph.get(a)!.add(b);
        graph.get(b)!.add(a);
    };

    for (const t of tasks.values()) {
        if (t.parentTaskId && taskIds.has(t.parentTaskId)) addEdge(`task:${t.id}`, `task:${t.parentTaskId}`);
        if (t.boundLogId && logIds.has(t.boundLogId)) addEdge(`task:${t.id}`, `log:${t.boundLogId}`);
    }
    for (const l of logs.values()) {
        if (l.runtimeTaskId && taskIds.has(l.runtimeTaskId)) addEdge(`log:${l.id}`, `task:${l.runtimeTaskId}`);
    }
    for (const [taskId, linked] of eventTaskLinks) {
        for (const l of linked) addEdge(`task:${taskId}`, l);
    }

    // 初始保护集
    const initialProtected = new Set<NodeKey>();
    for (const id of protectedTasks) initialProtected.add(`task:${id}`);
    for (const id of protectedLogs) initialProtected.add(`log:${id}`);
    // 非终态任务/日志也是保护根
    for (const t of tasks.values()) {
        if (!TERMINAL_TASK_STATUSES.has(t.status)) initialProtected.add(`task:${t.id}`);
    }
    for (const l of logs.values()) {
        if (!TERMINAL_LOG_STATUSES.has(l.status)) initialProtected.add(`log:${l.id}`);
    }

    // BFS 传播
    const protectedNodes = new Set<NodeKey>(initialProtected);
    const queue = [...initialProtected];
    while (queue.length) {
        const node = queue.pop()!;
        for (const neighbor of graph.get(node) ?? []) {
            if (!protectedNodes.has(neighbor)) {
                protectedNodes.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    // 6. 应用 TTL + 生成报告
    const nowMs = new Date(now).getTime();
    const cutoffs = {
        taskSucceeded: config.taskSucceededDays != null ? nowMs - config.taskSucceededDays * 86_400_000 : null,
        taskFailed: config.taskFailedDays != null ? nowMs - config.taskFailedDays * 86_400_000 : null,
        taskCancelled: config.taskCancelledDays != null ? nowMs - config.taskCancelledDays * 86_400_000 : null,
        logSuccess: config.logSuccessDays != null ? nowMs - config.logSuccessDays * 86_400_000 : null,
        logFailed: config.logFailedDays != null ? nowMs - config.logFailedDays * 86_400_000 : null,
        logCancelled: config.logCancelledDays != null ? nowMs - config.logCancelledDays * 86_400_000 : null,
    };

    const taskCandidates: RetentionReport["taskCandidates"] = [];
    const logCandidates: RetentionReport["logCandidates"] = [];
    const reasonCounts: Record<string, number> = {};
    let protectedTaskCount = 0, protectedLogCount = 0;

    // 任务
    for (const t of tasks.values()) {
        const nodeKey = `task:${t.id}`;
        const isProtected = protectedNodes.has(nodeKey);
        const reasons = new Set<RetentionReason>(reasonMap.get(t.id) ?? []);
        if (!TERMINAL_TASK_STATUSES.has(t.status)) reasons.add("non-terminal-status");
        if (isProtected && !TERMINAL_TASK_STATUSES.has(t.status)) reasons.add("non-terminal-status");
        // 家族保护
        if (isProtected && !reasons.size) reasons.add("protected-by-family");
        // 状态未知
        if (!t.status) reasons.add("unknown-status");

        const updateMs = new Date(t.updatedAt).getTime();
        const createMs = new Date(t.createdAt).getTime();
        // 保留年龄从终态最近更新时间计算
        const referenceTime = isNaN(updateMs) ? createMs : Math.max(updateMs, createMs);
        const age = (nowMs - referenceTime) / 86_400_000;

        const statusCutoff = t.status === "succeeded" ? cutoffs.taskSucceeded
            : t.status === "failed" ? cutoffs.taskFailed
            : t.status === "cancelled" ? cutoffs.taskCancelled
            : null;

        const ttlProtected = statusCutoff == null || referenceTime >= statusCutoff;
        const finalProtected = isProtected || ttlProtected || reasons.size > 0;

        if (finalProtected) protectedTaskCount++;
        for (const r of reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;

        // 关联家族
        const family = new Set<string>([t.id]);
        const logFamily = new Set<string>();
        for (const neighbor of graph.get(nodeKey) ?? []) {
            if (neighbor.startsWith("task:")) family.add(neighbor.slice(5));
            if (neighbor.startsWith("log:")) logFamily.add(neighbor.slice(4));
        }

        taskCandidates.push({
            id: t.id, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt,
            ageDays: Math.round(age * 100) / 100,
            protected: finalProtected,
            reasons: [...reasons],
            familyIds: [...family].sort(),
            logIds: [...logFamily].sort(),
        });
    }

    // 日志
    // 先按项目分组排序（数量政策）
    const logsByProject = new Map<string, LogInfo[]>();
    for (const l of logs.values()) {
        if (!logsByProject.has(l.projectId)) logsByProject.set(l.projectId, []);
        logsByProject.get(l.projectId)!.push(l);
    }
    for (const list of logsByProject.values()) {
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    }
    const logRank = new Map<string, number>();
    for (const list of logsByProject.values()) {
        list.forEach((l, i) => logRank.set(l.id, i + 1));
    }

    for (const l of logs.values()) {
        const nodeKey = `log:${l.id}`;
        const isProtected = protectedNodes.has(nodeKey);
        const reasons = new Set<RetentionReason>(reasonMap.get(l.id) ?? []);
        if (!TERMINAL_LOG_STATUSES.has(l.status)) reasons.add("non-terminal-status");
        if (isProtected && !TERMINAL_LOG_STATUSES.has(l.status)) reasons.add("non-terminal-status");
        if (isProtected && !reasons.size) reasons.add("protected-by-family");
        if (!l.status) reasons.add("unknown-status");

        // 时间：取 max(updated_at, finished_at, created_at)
        const times = [l.createdAt, l.updatedAt, l.finishedAt].filter(Boolean).map(t => new Date(t!).getTime());
        const referenceTime = times.length ? Math.max(...times) : new Date(l.createdAt).getTime();
        const age = (nowMs - referenceTime) / 86_400_000;

        const statusCutoff = l.status === "success" ? cutoffs.logSuccess
            : l.status === "failed" ? cutoffs.logFailed
            : l.status === "cancelled" ? cutoffs.logCancelled
            : null;

        const ttlProtected = statusCutoff == null || referenceTime >= statusCutoff;

        // 数量政策
        let countProtected = false;
        const rank = logRank.get(l.id) ?? null;
        if (config.logCountLimit != null && rank != null && rank > config.logCountLimit) {
            // 超过数量限制的日志，如果终态且不受保护，才进入候选
            if (TERMINAL_LOG_STATUSES.has(l.status) && !isProtected && !ttlProtected) {
                // 候选（不保护）
            } else {
                countProtected = true;
                reasons.add("count-policy-protected");
            }
        }

        const finalProtected = isProtected || ttlProtected || countProtected || reasons.size > 0;
        if (finalProtected) protectedLogCount++;
        for (const r of reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;

        logCandidates.push({
            id: l.id, projectId: l.projectId, status: l.status,
            createdAt: l.createdAt, ageDays: Math.round(age * 100) / 100,
            protected: finalProtected,
            reasons: [...reasons],
            countRank: rank,
        });
    }

    return {
        schemaVersion,
        policyVersion: POLICY_VERSION,
        now,
        taskCandidates,
        logCandidates,
        anomalies,
        summary: {
            totalTasks: tasks.size,
            totalLogs: logs.size,
            protectedTasks: protectedTaskCount,
            protectedLogs: protectedLogCount,
            candidateTasks: tasks.size - protectedTaskCount,
            candidateLogs: logs.size - protectedLogCount,
            reasonCounts,
        },
    };
}
