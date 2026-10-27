/**
 * Agent 线程附件迁移 CLI：把历史里内联的 base64 图片换成媒体库引用（`imageRef`）。
 *
 * 背景（实测）：`agent.llm.thread:*` 每条线程是一整行 JSON，用户附件以
 * `data:image/png;base64,...` 形式写进 `turns[].messages[].parts`，单线程可到 31 MB。
 * 这些字节**已经被媒体库持有**（把 31 MB 线程里的 10 张图逐张解码、sha256 与
 * `media_files.sha256` 对上，10/10 命中），所以历史里再存一份是纯重复。
 *
 * 新写入路径已经改成「附件入库一次 + 只存 storageKey」（见 canvas-agent 的
 * `attachmentParts` / `expandImageRefs`）；本 CLI 回收已经写进历史的那些。
 *
 * 安全边界：解不出 base64、或 sha256 在媒体库里找不到、或对应文件已不在盘上 → 保留原样并报告，
 * 绝不做猜测性替换（宁可留一份 base64，也不能让模型以后看不到图）。
 *
 * 默认 dry-run：只报告每线程可省字节。
 * 用法：
 *   node --import tsx src/maintenance/migrate-agent-thread-attachments.ts
 *   node --import tsx src/maintenance/migrate-agent-thread-attachments.ts --apply
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { BackendDatabase } from "../db.js";
import { DB_FILE } from "../config.js";

const args = process.argv.slice(2);
let apply = false;
for (const arg of args) {
    if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
    throw new Error("未知参数: " + arg);
}
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护: " + DB_FILE);

const THREAD_PREFIX = "agent.llm.thread:";
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

type Part = Record<string, unknown>;
type Message = { parts?: Part[] };
type Thread = { turns?: Array<{ messages?: Message[] }> };

const db = new BackendDatabase(DB_FILE);
try {
    /** sha256 → 可用 storageKey（文件仍在盘上）。 */
    const byDigest = new Map<string, string>();
    for (const media of db.listMediaFiles()) {
        if (typeof media.sha256 !== "string" || media.sha256.length !== 64) continue;
        if (byDigest.has(media.sha256)) continue;
        try { if (fs.statSync(media.filePath).size === media.bytes) byDigest.set(media.sha256, media.storageKey); } catch { /* 文件丢失则不可用 */ }
    }

    const rows = db.db.prepare("SELECT key, value_json FROM runtime_settings WHERE key LIKE ?").all(THREAD_PREFIX + "%") as Array<{ key: string; value_json: string }>;
    type Plan = { key: string; id: string; before: number; after: number; replaced: number; kept: Array<{ reason: string; bytes: number }>; payload?: string };
    const plans: Plan[] = [];

    for (const row of rows) {
        const before = Buffer.byteLength(row.value_json, "utf8");
        let thread: Thread;
        try { thread = JSON.parse(row.value_json) as Thread; } catch { continue; }
        if (!Array.isArray(thread.turns)) continue;
        const kept: Array<{ reason: string; bytes: number }> = [];
        let replaced = 0;
        for (const turn of thread.turns) {
            for (const message of turn.messages ?? []) {
                for (const part of message.parts ?? []) {
                    const value = part.image;
                    if (typeof value !== "string" || !value.startsWith("data:")) continue;
                    const match = DATA_URL.exec(value);
                    if (!match) { kept.push({ reason: "不是 base64 data URL", bytes: value.length }); continue; }
                    const storageKey = byDigest.get(crypto.createHash("sha256").update(Buffer.from(match[2], "base64")).digest("hex"));
                    if (!storageKey) { kept.push({ reason: "媒体库里找不到同内容（不猜测替换）", bytes: value.length }); continue; }
                    delete part.image;
                    part.imageRef = storageKey;
                    replaced++;
                }
            }
        }
        if (!replaced) continue;
        const payload = JSON.stringify(thread);
        plans.push({ key: row.key, id: row.key.slice(THREAD_PREFIX.length), before, after: Buffer.byteLength(payload, "utf8"), replaced, kept, ...(apply ? { payload } : {}) });
    }

    const savedBytes = plans.reduce((sum, plan) => sum + Math.max(plan.before - plan.after, 0), 0);
    const report = {
        ok: true, dryRun: !apply, dbPath: DB_FILE,
        threads: rows.length,
        threadsWithInlineImages: plans.length,
        replacedParts: plans.reduce((sum, plan) => sum + plan.replaced, 0),
        keptParts: plans.reduce((sum, plan) => sum + plan.kept.length, 0),
        keptReasons: plans.flatMap((plan) => plan.kept).reduce<Record<string, number>>((acc, item) => { acc[item.reason] = (acc[item.reason] ?? 0) + 1; return acc; }, {}),
        savedBytes, savedMb: +(savedBytes / 1048576).toFixed(1),
        top: plans.sort((a, b) => (b.before - b.after) - (a.before - a.after)).slice(0, 8).map((plan) => ({
            id: plan.id, beforeMb: +(plan.before / 1048576).toFixed(2), afterMb: +(plan.after / 1048576).toFixed(2), replaced: plan.replaced,
        })),
    };

    if (!apply) {
        console.log(JSON.stringify({ ...report, note: "只读报告；--apply 写回线程（只替换能证明同内容的图片）" }, null, 2));
        db.close();
        process.exit(0);
    }

    let written = 0;
    db.db.exec("BEGIN IMMEDIATE");
    try {
        const update = db.db.prepare("UPDATE runtime_settings SET value_json=?, updated_at=? WHERE key=?");
        for (const plan of plans) {
            if (!plan.payload) continue;
            const changed = update.run(plan.payload, new Date().toISOString(), plan.key).changes;
            if (Number(changed) === 1) written++;
        }
        db.db.exec("COMMIT");
    } catch (error) { db.db.exec("ROLLBACK"); throw error; }

    // 写回后逐条回读：JSON 必须仍可解析、且不再含内联图片。
    let verified = 0;
    for (const plan of plans) {
        const row = db.db.prepare("SELECT value_json FROM runtime_settings WHERE key=?").get(plan.key) as { value_json: string } | undefined;
        if (!row) throw new Error(`线程写回后丢失：${plan.id}`);
        const parsed = JSON.parse(row.value_json) as Thread;
        const inline = (parsed.turns ?? []).flatMap(turn => (turn.messages ?? []).flatMap(message => (message.parts ?? []).filter(part => typeof part.image === "string"))).length;
        if (inline) throw new Error(`线程仍含内联图片：${plan.id}`);
        verified++;
    }
    const after = db.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value_json)),0) AS bytes FROM runtime_settings WHERE key LIKE ?").get(THREAD_PREFIX + "%") as { n: number; bytes: number };
    console.log(JSON.stringify({
        ...report, dryRun: false, written, verified,
        after: { threads: after.n, bytes: after.bytes, mb: +(after.bytes / 1048576).toFixed(1) },
        note: "逻辑字节已下降；文件空间需运行 VACUUM 才会释放",
    }, null, 2));
} finally {
    db.close();
}
