/**
 * Agent 线程保留 CLI：回收长期无人使用、且没有任何业务绑定的 LLM 对话线程。
 *
 * 背景（实测）：`agent.llm.thread:*` 每条线程是一整行 JSON，单线程可达 31 MB
 * （用户附件以 base64 data URL 形式留在历史里），而 canvas-agent 只有写入路径 +
 * `agent.llm.index`，**没有任何删除/归档实现**，所以线程只增不减。
 *
 * 保守策略（缺一条就保留）：
 *   - 运行中（turns[].status === "running"）→ 保留
 *   - 被制作草稿/已发布记录或画布项目文本引用 → 保留（线程身份还挂在业务对象上）
 *   - 每个 cwd 的最新一条 → 保留（保留最近上下文，避免"刚聊完就被清"）
 *   - 其余仅当 `updatedAt` 早于 days 天才候选
 *
 * 删除时同步从 `agent.llm.index` 摘除 id，保持索引与存储一致。
 *
 * 默认 dry-run：只报告候选与可回收字节。
 * 用法：
 *   node --import tsx src/maintenance/prune-agent-threads.ts            # 默认 30 天
 *   node --import tsx src/maintenance/prune-agent-threads.ts 7 --apply
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BackendDatabase } from "../db.js";
import { DB_FILE } from "../config.js";
import { decodeReceipt } from "../drama/receipt-storage.js";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--apply") || positional.length > 1) throw new Error("Usage: prune-agent-threads [days=30] [--apply]");
const keepDays = positional.length ? Number(positional[0]) : 30;
if (!Number.isFinite(keepDays) || keepDays <= 0) throw new Error("保留天数必须是正数");
const apply = args.includes("--apply");
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护: " + DB_FILE);

const THREAD_PREFIX = "agent.llm.thread:";
const INDEX_KEY = "agent.llm.index";
const cutoffMs = Date.now() - keepDays * 86_400_000;

/** 扫描业务侧 JSON 列，收集仍被引用的线程 id。明文与 gzip BLOB 两种形态都要认。 */
function referencedThreadIds(db: DatabaseSync): Map<string, string> {
    const referenced = new Map<string, string>();
    const targets: Array<{ table: string; column: string }> = [];
    for (const table of ["episode_productions", "canvas_productions", "drama_projects", "canvas_projects"]) {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!exists) continue;
        for (const column of db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>) {
            if (column.type === "TEXT" && (column.name.endsWith("_json") || column.name === "data_json")) targets.push({ table, column: column.name });
        }
    }
    for (const { table, column } of targets) {
        for (const row of db.prepare(`SELECT "${column}" AS value FROM "${table}"`).all() as Array<{ value: unknown }>) {
            const raw = row.value;
            if (raw == null) continue;
            let text: string;
            if (typeof raw === "string") text = raw;
            else if (raw instanceof Uint8Array) {
                try { text = JSON.stringify(decodeReceipt(raw)); } catch { text = Buffer.from(raw).toString("utf8"); }
            } else continue;
            for (const match of text.matchAll(/llm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) {
                if (!referenced.has(match[0])) referenced.set(match[0], `${table}.${column}`);
            }
        }
    }
    return referenced;
}

const db = new BackendDatabase(DB_FILE);
try {
    const referenced = referencedThreadIds(db.db);
    const rows = db.db.prepare("SELECT key, value_json, updated_at FROM runtime_settings WHERE key LIKE ?").all(THREAD_PREFIX + "%") as Array<{ key: string; value_json: string; updated_at: string }>;

    const threads = rows.map((row) => {
        const id = row.key.slice(THREAD_PREFIX.length);
        const bytes = Buffer.byteLength(row.value_json, "utf8");
        let cwd = "", updatedAtMs = Date.parse(row.updated_at) || 0, running = false, archived = false;
        try {
            const parsed = JSON.parse(row.value_json) as { cwd?: string; updatedAt?: number; turns?: Array<{ status?: string }>; archived?: boolean };
            cwd = parsed.cwd || "";
            if (typeof parsed.updatedAt === "number") updatedAtMs = parsed.updatedAt * 1000;
            running = (parsed.turns || []).some((turn) => turn?.status === "running");
            archived = parsed.archived === true;
        } catch { /* 损坏线程按保守处理：留下，人工核对 */ }
        return { id, key: row.key, bytes, cwd, updatedAtMs, running, archived, broken: !cwd && !updatedAtMs };
    });

    // 每个 cwd 最新一条永远保留。
    const newestPerCwd = new Map<string, string>();
    for (const thread of threads) {
        const current = newestPerCwd.get(thread.cwd);
        if (!current || thread.updatedAtMs > (threads.find((t) => t.id === current)?.updatedAtMs ?? 0)) newestPerCwd.set(thread.cwd, thread.id);
    }

    const candidates: typeof threads = [];
    const kept: Array<{ id: string; reason: string }> = [];
    for (const thread of threads) {
        if (thread.running) { kept.push({ id: thread.id, reason: "running" }); continue; }
        if (thread.broken) { kept.push({ id: thread.id, reason: "unparsable" }); continue; }
        const ref = referenced.get(thread.id);
        if (ref) { kept.push({ id: thread.id, reason: `referenced-by:${ref}` }); continue; }
        if (newestPerCwd.get(thread.cwd) === thread.id) { kept.push({ id: thread.id, reason: "newest-in-cwd" }); continue; }
        if (thread.updatedAtMs > cutoffMs) { kept.push({ id: thread.id, reason: `within-${keepDays}d` }); continue; }
        candidates.push(thread);
    }

    const report = {
        ok: true, dryRun: !apply, keepDays, dbPath: DB_FILE,
        total: threads.length,
        totalBytes: threads.reduce((sum, thread) => sum + thread.bytes, 0),
        candidates: candidates.map((thread) => ({ id: thread.id, mb: +(thread.bytes / 1048576).toFixed(2), cwd: thread.cwd, updatedAt: new Date(thread.updatedAtMs).toISOString(), archived: thread.archived })),
        candidateBytes: candidates.reduce((sum, thread) => sum + thread.bytes, 0),
        keptReasons: kept.reduce<Record<string, number>>((acc, item) => { const key = item.reason.split(":")[0]; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}),
        referencedThreads: referenced.size,
    };

    if (!apply) {
        console.log(JSON.stringify({ ...report, note: "只读报告；--apply 删除候选线程并同步 agent.llm.index" }, null, 2));
        db.close();
        process.exit(0);
    }

    const indexRaw = db.db.prepare("SELECT value_json FROM runtime_settings WHERE key=?").get(INDEX_KEY) as { value_json: string } | undefined;
    let index: string[] = [];
    try { const parsed = indexRaw ? JSON.parse(indexRaw.value_json) : []; if (Array.isArray(parsed)) index = parsed.filter((item): item is string => typeof item === "string"); } catch { /* 索引损坏则只删线程，不动索引 */ }
    const victimIds = new Set(candidates.map((thread) => thread.id));

    db.db.exec("BEGIN IMMEDIATE");
    try {
        const remove = db.db.prepare("DELETE FROM runtime_settings WHERE key=?");
        for (const thread of candidates) {
            const changed = remove.run(thread.key).changes;
            if (Number(changed) !== 1) throw new Error(`线程删除失败（并发变更）: ${thread.id}`);
        }
        if (index.length) db.db.prepare("UPDATE runtime_settings SET value_json=?, updated_at=? WHERE key=?").run(JSON.stringify(index.filter((id) => !victimIds.has(id))), new Date().toISOString(), INDEX_KEY);
        db.db.exec("COMMIT");
    } catch (error) { db.db.exec("ROLLBACK"); throw error; }

    const after = db.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value_json)),0) AS bytes FROM runtime_settings WHERE key LIKE ?").get(THREAD_PREFIX + "%") as { n: number; bytes: number };
    console.log(JSON.stringify({
        ...report, dryRun: false,
        deleted: candidates.length,
        indexEntries: index.length, indexRemoved: index.filter((id) => victimIds.has(id)).length,
        after: { threads: after.n, bytes: after.bytes, mb: +(after.bytes / 1048576).toFixed(1) },
        note: "逻辑字节已下降；文件空间需运行 VACUUM 才会释放",
    }, null, 2));
} finally {
    db.close();
}
