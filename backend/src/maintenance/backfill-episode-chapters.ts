/**
 * 老剧目章节数据回填维护脚本（可复用；默认 dry-run 只读，--apply 才写）。
 *
 * 用途：老剧目没走新分集规划，source_chapters 为空、53 集的 chapter_ids_json 全空，
 * 导致 resolveEpisodeChapterNumbers 永远返回 []，造型章节选图回退角色主图。
 * 本脚本补两处真值：source_chapters（真切章）+ drama_episodes.chapter_ids_json（章 ID）。
 *
 * 用法（在 backend/ 目录）：
 *   node --import tsx src/maintenance/backfill-episode-chapters.ts                    # 全量 dry-run
 *   node --import tsx src/maintenance/backfill-episode-chapters.ts --drama-id drama-648d3b3f6c46
 *   node --import tsx src/maintenance/backfill-episode-chapters.ts --apply            # 真正写入（先备份）
 *   node --import tsx src/maintenance/backfill-episode-chapters.ts --apply --force    # 覆盖已有 chapter_ids_json
 *
 * 真值链（不另造切章）：
 *   plan.sourceScript + plan.sourceSplit  → db.syncSourceChapters(...)  → source_chapters(稳定 id)
 *   → 本集映射到的章 id 写进 drama_episodes.chapter_ids_json
 *   → db.resolveEpisodeChapterNumbers(episodeId) 才能返回章序号。
 *
 * dry-run 不写库：用与 syncSourceChapters 内部完全相同的 analyzeNovelChapters(sourceScript,
 * { maxChars, minChars: 200 }) + excluded 过滤来算章序号，保证与 apply 的章序号一致；
 * 章 id 是 apply 时由 syncSourceChapters 生成的 UUID，dry-run 只需章序号即可核对映射。
 *
 * 映射原则（保守，宁缺勿乱）：
 *   1. 集标题里的「第 N 章/回/卷/部/篇/段」视为显式章号，一对一映射；
 *      「第 N 集」是集号，绝不当作章号。
 *   2. 无显式章号的集：仅当章数=集数且集号连续(perEpisode=1)才按序映射；
 *      或章数=集数×perEpisode 时按 perEpisode 均分；其余一律 skip 并记录原因。
 *   3. 同剧有的集有显式章号、有的没有 → 没章号的集 skip（无法确定对应关系）。
 *   4. 已有 chapter_ids_json 的集默认不覆盖（除非 --force）。
 *   5. 没有 sourceScript 的剧目整剧 skip（无从切章）。
 *
 * schema 前置修复：老库的 source_chapters 可能没有 body 列（DRAMA_EPISODE_PLANNING_DDL
 * 用 CREATE TABLE IF NOT EXISTS，不会给已存在的旧表补列），而 syncSourceChapters 会写 body。
 * --apply 时先幂等 ALTER 补列（与 ensureEpisodePlanningColumns 同款做法）；dry-run 不动库。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { DB_FILE } from "../config.js";
import { BackendDatabase } from "../db.js";

type Args = {
    dramaId?: string;
    apply: boolean;
    force: boolean;
    backupDir?: string;
};

type Split = { excluded: number[]; perEpisode: number; maxChars: number };

type ChapterLite = { chapterIndex: number; title: string };

type EpisodeRow = {
    id: string;
    episodeNumber: number;
    title: string;
    existingIds: string[];
};

type Confidence = "high" | "medium";

type Assignment = {
    episodeId: string;
    episodeNumber: number;
    episodeTitle: string;
    chapterIndices: number[];
    confidence: Confidence;
    rationale: string;
    skipReason?: string;
    /** 实际会写（非 skip 且未填充或 --force）。 */
    willWrite: boolean;
};

type DramaPlan = {
    dramaId: string;
    sourceChars: number;
    split: Split;
    episodeMode: string;
    chapterCount: number;
    episodeCount: number;
    chapters: ChapterLite[];
    assignments: Assignment[];
    /** 整剧跳过原因（如无 sourceScript）；有值时 assignments 为空。 */
    dramaSkip?: string;
};

type ApplyResult = {
    backupFile: string;
    dramasSynced: string[];
    chaptersCreated: number;
    episodesWritten: number;
    episodesSkippedExisting: number;
    verify: Array<{ episodeId: string; expected: number[]; actual: number[]; ok: boolean }>;
};

function parseArgs(argv: string[]): Args {
    const result: Partial<Args> = { apply: false, force: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--apply") { result.apply = true; continue; }
        if (arg === "--force") { result.force = true; continue; }
        if (arg === "--drama-id" || arg === "--backup-dir") {
            const value = argv[++i];
            if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
            if (arg === "--drama-id") result.dramaId = value;
            else result.backupDir = path.resolve(value);
            continue;
        }
        throw new Error(`未知参数: ${arg}`);
    }
    return result as Args;
}

const CN_DIGITS: Record<string, number> = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};

/** 阿拉伯数字 / 中文数字 → 整数；无法解析返回 null。 */
function toInt(raw: string): number | null {
    if (/^\d+$/.test(raw)) return Number(raw);
    let section = 0;
    let digit = 0;
    for (const ch of raw) {
        if (ch in CN_DIGITS) { digit = CN_DIGITS[ch]; continue; }
        if (ch === "十") { section += (digit || 1) * 10; digit = 0; continue; }
        if (ch === "百") { section += (digit || 1) * 100; digit = 0; continue; }
        if (ch === "千") { section += (digit || 1) * 1000; digit = 0; continue; }
        return null;
    }
    return section + digit;
}

/**
 * 从集标题开头解析显式章号。「章/回/卷/部/篇/段」算章号；「集」是集号，绝不匹配。
 * 例：「第 1 章 雪夜沉尸」→1、「第一章 二害与初遇」→1、「第 11 段」→11、
 *     「第 4 集」→null、「雨夜恶祟」→null。
 */
function parseChapterOrdinal(title: string): { index: number; unit: string } | null {
    const match = String(title || "").trim()
        .replace(/^[【\[(（]/, "")
        .match(/^第\s*([0-9零〇一二三四五六七八九十百千两]+)\s*([章节回卷部篇段])/);
    if (!match) return null;
    const index = toInt(match[1]);
    return index === null ? null : { index, unit: match[2] };
}

function effectiveMaxChars(split: Split): number {
    // 与 db.syncSourceChapters 一致：Number(maxChars) || 3000。
    return Number(split.maxChars) || 3000;
}

function parsePlan(rawPlan: string | null | undefined): {
    sourceScript: string; split: Split; episodeMode: string;
} | null {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(String(rawPlan || "{}")) as Record<string, unknown>; }
    catch { return null; }
    const sourceScript = String(parsed.sourceScript || "");
    const rawSplit = (parsed.sourceSplit && typeof parsed.sourceSplit === "object")
        ? parsed.sourceSplit as Record<string, unknown> : {};
    const split: Split = {
        excluded: Array.isArray(rawSplit.excluded) ? rawSplit.excluded.map(Number).filter(Number.isFinite) : [],
        perEpisode: Math.max(1, Math.floor(Number(rawSplit.perEpisode) || 1)),
        maxChars: Math.max(0, Math.floor(Number(rawSplit.maxChars) || 0)),
    };
    const episodeMode = parsed.episodeMode === "auto" ? "auto" : "chapter";
    return { sourceScript, split, episodeMode };
}

function parseChapterIds(raw: string | null | undefined): string[] {
    try {
        const value = JSON.parse(String(raw || "[]"));
        return Array.isArray(value) ? value.map(String) : [];
    } catch { return []; }
}

/** 只读规划：不打开可写连接，不触发任何真实写入。 */
function planAll(args: Args): DramaPlan[] {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        const rows = args.dramaId
            ? db.prepare("SELECT folder_id, production_plan_json FROM drama_projects WHERE folder_id=?").all(args.dramaId)
            : db.prepare("SELECT folder_id, production_plan_json FROM drama_projects ORDER BY folder_id").all();
        if (args.dramaId && !rows.length) throw new Error(`找不到剧目: ${args.dramaId}`);
        const plans: DramaPlan[] = [];
        for (const row of rows as Array<{ folder_id: string; production_plan_json: string | null }>) {
            const dramaId = String(row.folder_id);
            const plan = parsePlan(row.production_plan_json);
            const episodes = (db.prepare(
                "SELECT id, episode_number, title, chapter_ids_json FROM drama_episodes WHERE drama_id=? ORDER BY episode_number ASC"
            ).all(dramaId) as Array<{ id: string; episode_number: number; title: string; chapter_ids_json: string | null }>)
                .map<EpisodeRow>((ep) => ({
                    id: String(ep.id),
                    episodeNumber: Number(ep.episode_number),
                    title: String(ep.title || ""),
                    existingIds: parseChapterIds(ep.chapter_ids_json),
                }));

            if (!plan || !plan.sourceScript.trim()) {
                plans.push({
                    dramaId, sourceChars: 0,
                    split: { excluded: [], perEpisode: 1, maxChars: 0 },
                    episodeMode: "chapter", chapterCount: 0, episodeCount: episodes.length,
                    chapters: [], assignments: [],
                    dramaSkip: "production_plan_json.sourceScript 为空，无法切章（整剧跳过）",
                });
                continue;
            }

            // 与 syncSourceChapters 内部完全一样的切章口径（只读）。
            const splitResult = analyzeNovelChapters(plan.sourceScript, {
                maxChars: effectiveMaxChars(plan.split), minChars: 200,
            });
            const excluded = new Set(plan.split.excluded.map(Number));
            const chapters: ChapterLite[] = splitResult.chapters
                .filter((chapter) => !excluded.has(chapter.index))
                .map((chapter) => ({ chapterIndex: chapter.index, title: chapter.title }));

            const assignments = buildAssignments(chapters, episodes, plan.split, args.force);
            plans.push({
                dramaId, sourceChars: plan.sourceScript.length, split: plan.split,
                episodeMode: plan.episodeMode, chapterCount: chapters.length,
                episodeCount: episodes.length, chapters, assignments,
            });
        }
        return plans;
    } finally { db.close(); }
}

/** 保守建立章→集映射；逐集给出置信度 / 依据 / skip 原因。 */
function buildAssignments(
    chapters: readonly ChapterLite[], episodes: readonly EpisodeRow[], split: Split, force: boolean,
): Assignment[] {
    const byIndex = new Map(chapters.map((chapter) => [chapter.chapterIndex, chapter] as const));
    const parsed = episodes.map((episode) => {
        const parsedOrdinal = parseChapterOrdinal(episode.title);
        return { episode, ordinal: parsedOrdinal?.index ?? null, unit: parsedOrdinal?.unit ?? "章" };
    });

    // 显式章号的重复声明：一个章号被多集声明 → 这些集全部 skip（无法判归属）。
    const claims = new Map<number, number>();
    for (const { ordinal } of parsed) {
        if (ordinal !== null && byIndex.has(ordinal)) claims.set(ordinal, (claims.get(ordinal) || 0) + 1);
    }

    const contiguous = episodes.length > 0 && episodes.every((episode, index) => episode.episodeNumber === index + 1);
    const explicitCount = parsed.filter(({ ordinal }) => ordinal !== null && byIndex.has(ordinal)).length;
    const allExplicit = explicitCount === episodes.length && episodes.length > 0;

    return parsed.map(({ episode, ordinal, unit }, position) => {
        const filled = episode.existingIds.length > 0;
        const base = {
            episodeId: episode.id, episodeNumber: episode.episodeNumber, episodeTitle: episode.title,
            chapterIndices: [] as number[], confidence: "high" as Confidence,
            rationale: "", skipReason: undefined as string | undefined, willWrite: false,
        };
        if (filled && !force) {
            return { ...base, skipReason: "已有 chapter_ids_json（未加 --force，不覆盖）" };
        }

        if (ordinal !== null) {
            if (!byIndex.has(ordinal)) {
                return { ...base, skipReason: `标题序号「第 ${ordinal} ${unit}」不在切章结果（共 ${chapters.length} 章）内` };
            }
            if ((claims.get(ordinal) || 0) > 1) {
                return { ...base, skipReason: `章号 ${ordinal} 被多集同时声明，无法确定归属` };
            }
            return {
                ...base, chapterIndices: [ordinal], confidence: "high",
                rationale: `标题显式章号「第 ${ordinal} ${unit}」一对一`, willWrite: true,
            };
        }

        // 没有显式章号：只有两种可保守分配的情形，否则 skip。
        if (allExplicit) {
            return { ...base, skipReason: "同剧其它集有显式章号，本集无章号，无法确定对应关系" };
        }
        if (split.perEpisode === 1 && chapters.length === episodes.length && contiguous) {
            const chapter = chapters[position];
            return {
                ...base, chapterIndices: [chapter.chapterIndex], confidence: "medium",
                rationale: `章数=集数(${chapters.length})且集号连续，按集序映射到第 ${chapter.chapterIndex} 章（标题无显式章号）`,
                willWrite: true,
            };
        }
        if (split.perEpisode > 1 && chapters.length === episodes.length * split.perEpisode && contiguous) {
            const group = chapters.slice(position * split.perEpisode, (position + 1) * split.perEpisode);
            return {
                ...base, chapterIndices: group.map((chapter) => chapter.chapterIndex), confidence: "medium",
                rationale: `章数=${chapters.length}，集数=${episodes.length}，perEpisode=${split.perEpisode} 均分`,
                willWrite: true,
            };
        }
        return {
            ...base,
            skipReason: `标题无章号且无法可靠分配：章数=${chapters.length}、集数=${episodes.length}、perEpisode=${split.perEpisode}、集号${contiguous ? "连续" : "不连续"}`,
        };
    });
}

/** apply 前备份：原 chapter_ids_json + source_chapters + planning_state，写到 JSON + 回滚 SQL。 */
function writeBackup(db: BackendDatabase, plans: DramaPlan[], backupDir: string): string {
    const dramaIds = plans.filter((plan) => !plan.dramaSkip).map((plan) => plan.dramaId);
    const episodeBackup: Array<Record<string, unknown>> = [];
    const chapterBackup: Array<Record<string, unknown>> = [];
    const stateBackup: Array<Record<string, unknown>> = [];
    for (const dramaId of dramaIds) {
        episodeBackup.push(...(db.db.prepare(
            "SELECT id, drama_id, episode_number, title, chapter_ids_json FROM drama_episodes WHERE drama_id=?"
        ).all(dramaId) as Array<Record<string, unknown>>));
        chapterBackup.push(...(db.db.prepare("SELECT * FROM source_chapters WHERE drama_id=?").all(dramaId) as Array<Record<string, unknown>>));
        stateBackup.push(...(db.db.prepare("SELECT * FROM drama_episode_planning_state WHERE drama_id=?").all(dramaId) as Array<Record<string, unknown>>));
    }
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(backupDir, `episode-chapter-backfill-${stamp}.json`);
    const payload = {
        createdAt: new Date().toISOString(), db: DB_FILE, dramaIds,
        note: "回滚：按 episodeBackup 逐集 UPDATE chapter_ids_json；按 chapterBackup/stateBackup 恢复相应表（先 DELETE 对应 drama_id 再 INSERT）。",
        episodeBackup, chapterBackup, stateBackup,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    if (!fs.statSync(file).size) throw new Error("备份文件为空，拒绝写入");
    return file;
}

/** 幂等补 source_chapters.body 列（老库缺列时 syncSourceChapters 会报错）。 */
function ensureBodyColumn(db: BackendDatabase): void {
    const columns = db.db.prepare("PRAGMA table_info(source_chapters)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "body")) {
        db.db.exec("ALTER TABLE source_chapters ADD COLUMN body TEXT NOT NULL DEFAULT ''");
        console.error("[schema] 已补 source_chapters.body 列（幂等 ALTER）");
    }
}

/** 真正写入：先备份 → 每剧 syncSourceChapters（真值）→ 事务内写 chapter_ids_json → 同连接复核。 */
function applyAll(plans: DramaPlan[], args: Args): ApplyResult {
    const db = new BackendDatabase(DB_FILE);
    try {
        db.db.exec("PRAGMA busy_timeout=10000");
        ensureBodyColumn(db);
        const backupDir = args.backupDir || path.join(path.dirname(DB_FILE), "backups", "episode-chapter-backfill");
        const backupFile = writeBackup(db, plans, backupDir);

        const result: ApplyResult = {
            backupFile, dramasSynced: [], chaptersCreated: 0, episodesWritten: 0,
            episodesSkippedExisting: 0, verify: [],
        };

        for (const plan of plans) {
            if (plan.dramaSkip) continue;
            const before = db.listSourceChapters(plan.dramaId).length;
            // syncSourceChapters 内部自带 BEGIN IMMEDIATE/COMMIT，不能放进外层事务。
            const synced = db.syncSourceChapters(
                plan.dramaId,
                readSourceScript(plan.dramaId),
                { excluded: plan.split.excluded, maxChars: effectiveMaxChars(plan.split) },
                plan.episodeMode,
            );
            result.dramasSynced.push(plan.dramaId);
            result.chaptersCreated += Math.max(0, synced.chapters.length - before);
            const idByIndex = new Map(synced.chapters.map((chapter) => [chapter.chapterIndex, chapter.id] as const));

            db.db.exec("BEGIN IMMEDIATE");
            try {
                for (const item of plan.assignments) {
                    if (!item.willWrite || !item.chapterIndices.length) continue;
                    // 事务内重读最新行，防并发写入覆盖。
                    const row = db.db.prepare("SELECT chapter_ids_json FROM drama_episodes WHERE id=?").get(item.episodeId) as
                        { chapter_ids_json: string | null } | undefined;
                    if (!row) throw new Error(`写入前分集消失: ${item.episodeId}`);
                    if (parseChapterIds(row.chapter_ids_json).length && !args.force) {
                        result.episodesSkippedExisting += 1;
                        continue;
                    }
                    const ids = item.chapterIndices.map((index) => idByIndex.get(index));
                    if (ids.some((id) => !id)) throw new Error(`章 id 缺失: ${item.episodeId} -> ${item.chapterIndices.join(",")}`);
                    const orderedIds = [...item.chapterIndices].sort((a, b) => a - b).map((index) => idByIndex.get(index)!);
                    db.db.prepare("UPDATE drama_episodes SET chapter_ids_json=?, updated_at=? WHERE id=?")
                        .run(JSON.stringify(orderedIds), new Date().toISOString(), item.episodeId);
                    result.episodesWritten += 1;
                }
                db.db.exec("COMMIT");
            } catch (error) { db.db.exec("ROLLBACK"); throw error; }
        }

        // 复核必须在同一连接上读：新开只读连接可能拿到 WAL 旧快照。
        for (const plan of plans) {
            if (plan.dramaSkip) continue;
            for (const item of plan.assignments) {
                if (!item.willWrite) continue;
                const actual = db.resolveEpisodeChapterNumbers(item.episodeId);
                const expected = [...item.chapterIndices].sort((a, b) => a - b);
                result.verify.push({
                    episodeId: item.episodeId, expected, actual,
                    ok: JSON.stringify(actual) === JSON.stringify(expected),
                });
            }
        }
        return result;
    } finally { db.close(); }
}

/** apply 阶段重读 sourceScript（与 dry-run 同一份规划原文）。 */
function readSourceScript(dramaId: string): string {
    const row = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        const found = row.prepare("SELECT production_plan_json FROM drama_projects WHERE folder_id=?").get(dramaId) as
            { production_plan_json: string | null } | undefined;
        return String(parsePlan(found?.production_plan_json)?.sourceScript || "");
    } finally { row.close(); }
}

function renderDryRun(plans: DramaPlan[], args: Args): string {
    const lines: string[] = [];
    lines.push("=== 老剧目章节回填 dry-run（只读，未写库） ===");
    lines.push(`DB: ${DB_FILE}`);
    lines.push(`范围: ${args.dramaId || "全部剧目"}  |  --force: ${args.force}  |  --apply: false`);
    lines.push(`提示: 若老库 source_chapters 缺 body 列，--apply 会先幂等 ALTER 补列（dry-run 不动库）。`);
    lines.push("");
    let totalEpisodes = 0;
    let totalWrite = 0;
    let totalSkip = 0;
    let dramaSkipCount = 0;
    for (const plan of plans) {
        lines.push(`── ${plan.dramaId} ──────────────────────────────`);
        if (plan.dramaSkip) {
            dramaSkipCount += 1;
            totalSkip += plan.episodeCount;
            lines.push(`  [整剧 SKIP] ${plan.dramaSkip}（集数=${plan.episodeCount}）`);
            lines.push("");
            continue;
        }
        lines.push(`  sourceScript=${plan.sourceChars}字  split=${JSON.stringify(plan.split)}  episodeMode=${plan.episodeMode}`);
        lines.push(`  章数=${plan.chapterCount}  集数=${plan.episodeCount}`);
        lines.push(`  章序: ${plan.chapters.map((c) => `${c.chapterIndex}:${c.title}`).join(" | ")}`);
        for (const item of plan.assignments) {
            totalEpisodes += 1;
            const head = `  集${item.episodeNumber}「${item.episodeTitle}」`;
            if (item.skipReason) {
                totalSkip += 1;
                lines.push(`${head}  [SKIP] ${item.skipReason}`);
            } else {
                totalWrite += 1;
                const range = item.chapterIndices.length === 1
                    ? `第 ${item.chapterIndices[0]} 章`
                    : `第 ${item.chapterIndices[0]}-${item.chapterIndices[item.chapterIndices.length - 1]} 章`;
                lines.push(`${head}  → ${range}  [${item.confidence}] ${item.rationale}`);
            }
        }
        lines.push("");
    }
    lines.push(`=== 汇总: 剧目=${plans.length}（整剧skip=${dramaSkipCount}）  集=${totalEpisodes}  待写=${totalWrite}  skip=${totalSkip} ===`);
    lines.push("核对无误后加 --apply 写入（apply 会先备份原值到 backups/episode-chapter-backfill/）。");
    return lines.join("\n");
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(DB_FILE)) throw new Error(`数据库不存在，拒绝创建空库: ${DB_FILE}`);
    const plans = planAll(args);
    if (!args.apply) {
        console.log(renderDryRun(plans, args));
        return;
    }
    const result = applyAll(plans, args);
    const failed = result.verify.filter((item) => !item.ok);
    console.log(JSON.stringify({
        ok: failed.length === 0, dryRun: false, ...result,
        verifyFailed: failed,
    }, null, 2));
    if (failed.length) process.exitCode = 1;
}

try { main(); }
catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
}
