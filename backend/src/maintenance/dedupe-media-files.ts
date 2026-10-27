/**
 * 媒体去重迁移 CLI：把历史上「同内容、多份物理文件」的重复副本收敛成一份。
 *
 * 背景（实测）：`media_files` 里 454 组 sha256 各对应多个不同文件（按磁盘实际大小核过，
 * 多余副本 1.70 GiB；最狠一组同一张 PNG 存了 67 份）。写入路径已改为内容寻址
 * （`media-store.ts` 的 `reusablePath`），这里回收已经存在的那部分。
 *
 * 安全边界（每一条不过就跳过该文件，绝不删）：
 *   1. 组内所有候选文件的 sha256 必须与组摘要一致（真按磁盘字节重算，不信任表里的值）；
 *   2. 待删文件不能再被任何 storage_key 指向；
 *   3. 文件名不能在数据库明文列、`production-compilations`、`codex-workspaces` 里被引用
 *      （rg 可用时扫描；rg 不存在视为未知 → 跳过，宁可留一份也不制造悬空引用）。
 * 收不回的只是「哪些副本更早」这类信息——同一份内容里它们本来等价。
 *
 * 默认 dry-run：只报告分组、可收敛副本与可释放字节。
 * 用法：
 *   node --import tsx src/maintenance/dedupe-media-files.ts
 *   node --import tsx src/maintenance/dedupe-media-files.ts --apply
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BackendDatabase, type MediaFile } from "../db.js";
import { DATA_DIR, DB_FILE, MEDIA_DIR } from "../config.js";

const args = process.argv.slice(2);
let apply = false;
for (const arg of args) {
    if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
    throw new Error("未知参数: " + arg);
}
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护: " + DB_FILE);

function sha256OfFile(file: string): string | null {
    try {
        const digest = crypto.createHash("sha256");
        const fd = fs.openSync(file, "r");
        try {
            const buffer = Buffer.allocUnsafe(1 << 20);
            let read = 0;
            while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, read));
        } finally { fs.closeSync(fd); }
        return digest.digest("hex");
    } catch { return null; }
}

/** 大表逐列 LIKE 太慢：只扫「可能持有媒体路径」的结构化列，以及足够小的表。 */
const REFERENCE_COLUMN_ALLOWLIST = ["data_json", "draft_json", "published_json", "cover_url", "url", "preview_json"];
const MAX_SCANNED_TABLE_BYTES = 16 * 1024 * 1024;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function tableBytes(db: BackendDatabase, table: string): number {
    try {
        const row = db.db.prepare("SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat WHERE name = ?").get(table) as { b: number } | null;
        return Number(row?.b ?? 0);
    } catch { return 0; }
}

function fileCountFor(db: BackendDatabase, filePath: string): number {
    const row = db.db.prepare("SELECT COUNT(*) AS n FROM media_files WHERE file_path = ?").get(filePath) as { n: number };
    return Number(row.n);
}

function uuidOf(name: string): string | null {
    const match = UUID_PATTERN.exec(name);
    return match ? match[0].toLowerCase() : null;
}

/**
 * 一次性收集「可能引用媒体文件名」的 UUID：
 *   来源 = 数据库允许列（与小表）里的所有 UUID + `production-compilations` / `codex-workspaces`
 *   里出现过的所有 UUID。
 * 逐文件去扫 16 GB 产物是 O(候选数 × 产物体积)，实测跑不完；反过来只扫一遍产物即可。
 * `diskScanned=false` 表示 rg 不可用或扫描失败——此时调用方必须保守跳过删除。
 */
function collectReferenceTokens(db: BackendDatabase): { tokens: Set<string>; diskScanned: boolean } {
    const tokens = new Set<string>();
    const global = new RegExp(UUID_PATTERN.source, "gi");
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name: table } of tables) {
        // 跳过 media_files 自身：它的 file_path 里就含待判定的 UUID，扫它等于把每个候选都判成「被引用」。
        // 真正「别的行还指向这份文件」的情况由删除前的 fileCountFor 检查兜底。
        if (table === "media_files") continue;
        const bytes = tableBytes(db, table);
        const columns = db.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>;
        for (const column of columns) {
            if (column.type !== "TEXT") continue;
            if (!REFERENCE_COLUMN_ALLOWLIST.includes(column.name) && bytes > MAX_SCANNED_TABLE_BYTES) continue;
            try {
                for (const row of db.db.prepare(`SELECT "${column.name}" AS value FROM "${table}" WHERE "${column.name}" IS NOT NULL`).all() as Array<{ value: unknown }>) {
                    if (typeof row.value !== "string") continue;
                    for (const match of row.value.matchAll(global)) tokens.add(match[0].toLowerCase());
                }
            } catch { /* 虚拟表或异常列，跳过 */ }
        }
    }

    const roots = [path.join(DATA_DIR, "production-compilations"), path.join(DATA_DIR, "codex-workspaces")].filter((root) => fs.existsSync(root));
    if (!roots.length) return { tokens, diskScanned: true };
    try {
        const out = execFileSync("rg", ["-o", "--no-filename", "--no-messages", "-e", UUID_PATTERN.source, ...roots], { encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 30, windowsHide: true });
        for (const line of out.split(/\r?\n/)) if (line.trim()) tokens.add(line.trim().toLowerCase());
        return { tokens, diskScanned: true };
    } catch (error) {
        // rg 退出码 1 = 没有匹配（视为扫描成功）；其它失败 = 无法判定。
        return { tokens, diskScanned: (error as { status?: number }).status === 1 };
    }
}

const db = new BackendDatabase(DB_FILE);
try {
    const rows = db.listMediaFiles().filter((media): media is MediaFile & { sha256: string } => typeof media.sha256 === "string" && media.sha256.length === 64);
    const byDigest = new Map<string, MediaFile[]>();
    for (const media of rows) {
        const group = byDigest.get(media.sha256) ?? [];
        group.push(media);
        byDigest.set(media.sha256, group);
    }

    // 引用判定只扫一遍产物/数据库（O(1) 每候选）；扫描失败时整轮不做删除。
    const { tokens, diskScanned } = collectReferenceTokens(db);

    type Plan = { digest: string; canonical: string; repoint: Array<{ storageKey: string; from: string; bytes: number }>; deleteFiles: string[]; skipped: Array<{ file: string; reason: string }>; freedBytes: number };
    const plans: Plan[] = [];
    // 全量跳过原因单独收集：被跳过的整组也必须能被看见，否则报告只会显示「0 组」，看不出为什么。
    const allSkipped: Array<{ digest: string; file: string; reason: string }> = [];
    let duplicateGroups = 0;
    for (const [digest, group] of byDigest) {
        const distinct = [...new Set(group.map((media) => media.filePath))];
        if (distinct.length < 2) continue;
        duplicateGroups++;
        // 规范文件取组内最早登记那条的路径：确定性，且最早的行通常是被引用最多的那份。
        const ordered = [...group].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.storageKey < b.storageKey ? -1 : 1));
        const canonical = ordered[0].filePath;
        const plan: Plan = { digest, canonical, repoint: [], deleteFiles: [], skipped: [], freedBytes: 0 };

        for (const file of distinct) {
            if (file === canonical) continue;
            const actual = sha256OfFile(file);
            if (actual === null) { plan.skipped.push({ file, reason: "文件不可读" }); continue; }
            if (actual !== digest) { plan.skipped.push({ file, reason: "磁盘字节与摘要不一致（数据异常，人工核对）" }); continue; }
        }
        const canonicalActual = sha256OfFile(canonical);
        if (canonicalActual !== digest) { plan.skipped.push({ file: canonical, reason: "规范文件不可读或摘要不一致" }); continue; }

        for (const media of group) {
            if (media.filePath === canonical) continue;
            plan.repoint.push({ storageKey: media.storageKey, from: media.filePath, bytes: media.bytes });
        }

        for (const file of distinct) {
            if (file === canonical) continue;
            const stem = uuidOf(path.basename(file));
            const skip = (reason: string) => { plan.skipped.push({ file, reason }); allSkipped.push({ digest, file, reason }); };
            if (!stem) { skip("文件名不含 UUID，无法判定引用"); continue; }
            if (!diskScanned) { skip("产物扫描不可用（rg 缺失/失败），保守跳过"); continue; }
            if (tokens.has(stem)) { skip("仍被数据库或产物引用"); continue; }
            plan.deleteFiles.push(file);
            plan.freedBytes += fs.existsSync(file) ? fs.statSync(file).size : 0;
        }
        if (plan.repoint.length) plans.push(plan);
    }

    const report = {
        ok: true, dryRun: !apply, dbPath: DB_FILE, mediaDir: MEDIA_DIR,
        duplicateGroups,
        plansWithChanges: plans.length,
        repointedRows: plans.reduce((sum, plan) => sum + plan.repoint.length, 0),
        filesToDelete: plans.reduce((sum, plan) => sum + plan.deleteFiles.length, 0),
        freedBytes: plans.reduce((sum, plan) => sum + plan.freedBytes, 0),
        freedMb: +(plans.reduce((sum, plan) => sum + plan.freedBytes, 0) / 1048576).toFixed(1),
        diskScanned, referenceTokens: tokens.size,
        skippedCount: allSkipped.length,
        skippedReasons: allSkipped.reduce<Record<string, number>>((acc, item) => { acc[item.reason] = (acc[item.reason] ?? 0) + 1; return acc; }, {}),
        skipped: allSkipped.slice(0, 10),
        topGroups: [...plans].sort((a, b) => b.freedBytes - a.freedBytes).slice(0, 8).map((plan) => ({
            digest: plan.digest.slice(0, 12), canonical: path.basename(plan.canonical), copies: plan.deleteFiles.length + 1, freedMb: +(plan.freedBytes / 1048576).toFixed(1),
        })),
    };

    if (!apply) {
        console.log(JSON.stringify({ ...report, note: "只读报告；--apply 重指 file_path 并删除已核验的重复副本" }, null, 2));
        db.close();
        process.exit(0);
    }

    let repointed = 0, deleted = 0, freed = 0;
    for (const plan of plans) {
        db.db.exec("BEGIN IMMEDIATE");
        try {
            const update = db.db.prepare("UPDATE media_files SET file_path = ? WHERE storage_key = ?");
            for (const item of plan.repoint) repointed += Number(update.run(plan.canonical, item.storageKey).changes);
            db.db.exec("COMMIT");
        } catch (error) { db.db.exec("ROLLBACK"); throw error; }
        for (const file of plan.deleteFiles) {
            // 重指之后再确认一次：还有 key 指向它就不删。
            if (fileCountFor(db, file) > 0) continue;
            try { freed += fs.statSync(file).size; fs.unlinkSync(file); deleted++; } catch { /* 已被外部清掉 */ }
        }
    }
    const afterRows = db.listMediaFiles();
    const afterFiles = afterRows.filter((media) => fs.existsSync(media.filePath)).length;
    console.log(JSON.stringify({
        ...report, dryRun: false, repointed, deleted, freedMb: +(freed / 1048576).toFixed(1),
        after: { rows: afterRows.length, filesOnDisk: afterFiles, missingFiles: afterRows.length - afterFiles },
    }, null, 2));
} finally {
    db.close();
}
