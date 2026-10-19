/**
 * 媒体引用审计 CLI（只读）：找出库里所有指向「已不在磁盘上」的媒体绝对路径。
 *
 * 起因（实测）：`tasks.input_json` 里有 6 个 2026-09 的 H3 任务仍指向早已消失的
 * `previousVideo` mp4 —— 这些文件从未登记进 `media_files`（所以任何保留/去重策略都
 * 保护不到它们），清理后就留下悬空引用。调用方现在会在读不到文件时报「媒体文件丢失」，
 * 但**悬空引用本身需要一个可随时复核的口径**，这就是本 CLI。
 *
 * 扫描范围：所有表的 text 列（`like '%runtime-media%'`）+ 所有 blob 列（尝试 gunzip
 * 后搜索，回执就是 gzip BLOB），逐条 stat。永不删除、永不改写任何行。
 *
 * 用法：
 *   node --import tsx src/maintenance/audit-media-references.ts
 *   node --import tsx src/maintenance/audit-media-references.ts --json
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BackendDatabase } from "../db.js";
import { DB_FILE, MEDIA_DIR } from "../config.js";

if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护: " + DB_FILE);

const MEDIA_SUFFIX = /\.(mp4|mov|webm|mkv|png|jpg|jpeg|webp|gif|mp3|wav|m4a|flac|safetensors|json|txt)$/i;
const MEDIA_PATH = /([A-Za-z]:[\\/][^\s"',;)\]}]*runtime-media[\\/][^\s"',;)\]}]*)/g;

/** 从一段文本里抽出运行时媒体绝对路径并返回每个路径所在的字段。 */
function pathsIn(text: string) {
    const found = new Set<string>();
    for (const match of text.replace(/\\\\/g, "\\").matchAll(MEDIA_PATH)) {
        const candidate = match[1].replace(/[\\/]+$/, "").trim();
        if (candidate && MEDIA_SUFFIX.test(candidate)) found.add(candidate);
    }
    return found;
}

const db = new BackendDatabase(DB_FILE);
try {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    const missing = new Map<string, Set<string>>();   // 路径 → 引用字段集合
    const scanned = { textCells: 0, blobCells: 0, blobSkipped: 0, referencedPaths: 0 };

    for (const { name: table } of tables) {
        const columns = db.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>;
        for (const column of columns) {
            const holder = `${table}.${column.name}`;
            const rows = db.db.prepare(
                `SELECT rowid, "${column.name}" AS value, typeof("${column.name}") AS kind FROM "${table}" WHERE typeof("${column.name}") IN ('text','blob')`,
            ).all() as Array<{ rowid: number; value: string | Buffer | null; kind: string }>;
            for (const row of rows) {
                if (row.value == null) continue;
                let text: string | undefined;
                if (row.kind === "text") { scanned.textCells++; text = String(row.value); }
                else {
                    scanned.blobCells++;
                    // node:sqlite 的 BLOB 是 Uint8Array（不是 Buffer）：先按字节取，别退化成 "1,2,3…" 的字符串。
                    const buffer = row.value instanceof Uint8Array ? Buffer.from(row.value) : Buffer.from(String(row.value));
                    try { text = zlib.gunzipSync(buffer).toString("utf8"); } catch { scanned.blobSkipped++; continue; }
                }
                if (!text.includes("runtime-media")) continue;
                for (const file of pathsIn(text)) {
                    scanned.referencedPaths++;
                    if (fs.existsSync(path.resolve(file))) continue;
                    if (!missing.has(file)) missing.set(file, new Set());
                    missing.get(file)!.add(holder);
                }
            }
        }
    }

    const indexed = new Set<string>();
    for (const row of db.db.prepare("SELECT file_path FROM media_files").all() as Array<{ file_path: string }>) indexed.add(path.resolve(row.file_path));

    const report = {
        ok: true,
        dbPath: DB_FILE,
        mediaDir: MEDIA_DIR,
        scanned,
        danglingPaths: missing.size,
        danglingRefs: [...missing.values()].reduce((sum, holders) => sum + holders.size, 0),
        neverIndexed: [...missing.keys()].filter(file => !indexed.has(path.resolve(file))).length,
        detail: [...missing.entries()].map(([file, holders]) => ({ file: path.basename(file), fields: [...holders].slice(0, 4) })),
        note: "只读报告：这些路径指向的媒体已不在磁盘上；调用方会以「媒体文件丢失」报错，路径本身不会被本工具删除或改写。",
    };
    console.log(JSON.stringify(report, null, 2));
} finally {
    db.close();
}
