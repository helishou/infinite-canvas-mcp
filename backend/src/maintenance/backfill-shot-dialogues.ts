/**
 * 老剧目对白回填维护脚本（可复用，按 dramaId/episodeId 定点运行）。
 *
 * 用法（在 backend/ 目录）：
 *   node --import tsx src/maintenance/backfill-shot-dialogues.ts \
 *     --drama-id drama-648d3b3f6c46 \
 *     --episode-id episode-drama-648d3b3f6c46-3-6nnz7r
 *   # 上面是 dry-run（只读，打印将要回填的映射）；确认无误后加 --apply 真正写入。
 *
 * 可选参数：
 *   --chapter-file <path>   用指定文本文件作为本章原文（默认从剧目 sourceScript 按集号拆章）
 *   --backup-dir <path>     备份目录（默认 <DATA_DIR>/backups/shot-dialogue-backfill）
 *
 * 写入链路（与 syncSharedProductionOwners 一致，改真值源而非投影）：
 *   1. 备份原 episode_productions.draft_json（可回滚）
 *   2. 改 director.source.shots[].dialogues（真值源）
 *   3. 重算 director.sourceHash = directorHash(director.source)
 *   4. artifacts 标 stale、executionAuthorized=false、workflow.currentWork.sourceHash 同步
 *   5. UPDATE episode_productions SET revision+1, draft_json=withoutDirectorProjection(draft)
 * 直接改 data.shots 投影会被读取时的 projectDirector 重投影覆盖，故绝不改投影。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "../config.js";
import { BackendDatabase } from "../db.js";
import { directorHash, withoutDirectorProjection } from "../drama/director.js";
import {
    backfillShots,
    missingDialogue,
    quotedSourceLines,
    splitChapters,
    type ShotLike,
} from "../drama/shot-dialogue-backfill.js";

type Args = {
    dramaId: string;
    episodeId: string;
    apply: boolean;
    chapterFile?: string;
    backupDir?: string;
};

function parseArgs(argv: string[]): Args {
    const result: Partial<Args> = { apply: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--apply") { result.apply = true; continue; }
        if (["--drama-id", "--episode-id", "--chapter-file", "--backup-dir"].includes(arg)) {
            const value = argv[++i];
            if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
            if (arg === "--drama-id") result.dramaId = value;
            if (arg === "--episode-id") result.episodeId = value;
            if (arg === "--chapter-file") result.chapterFile = path.resolve(value);
            if (arg === "--backup-dir") result.backupDir = path.resolve(value);
            continue;
        }
        throw new Error(`未知参数: ${arg}`);
    }
    if (!result.dramaId || !result.episodeId) throw new Error("必须提供 --drama-id 与 --episode-id");
    if (result.chapterFile && !fs.existsSync(result.chapterFile)) throw new Error(`--chapter-file 不存在: ${result.chapterFile}`);
    return result as Args;
}

function shotLines(shots: ShotLike[]): string[] {
    return shots.flatMap(s => {
        const ds = Array.isArray(s?.dialogues) ? s.dialogues as Array<Record<string, unknown>> : [];
        return ds.map(d => String(d?.text || ""));
    });
}

type Plan = {
    episode: { id: string; dramaId: string; episodeNumber: number; title: string };
    revision: number;
    chapterSource: "file" | "sourceScript";
    chapterTitle: string;
    sourceLines: string[];
    missingBefore: string[];
    shotsWithoutDialogues: number;
    assignments: ReturnType<typeof backfillShots>["assignments"];
    missingAfter: string[];
    sourceHashConsistent: boolean;
    archived: boolean;
};

/** 只读：计算回填计划，不写任何东西。 */
function plan(args: Args): Plan {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        const ep = db.prepare("SELECT id,drama_id,episode_number,title FROM drama_episodes WHERE id=?").get(args.episodeId) as
            { id: string; drama_id: string; episode_number: number; title: string } | undefined;
        if (!ep) throw new Error(`找不到分集: ${args.episodeId}`);
        if (String(ep.drama_id) !== args.dramaId) throw new Error(`dramaId 不匹配：该分集属于 ${ep.drama_id}，传入 ${args.dramaId}（拒绝误伤其它剧目）`);
        const prodRow = db.prepare("SELECT revision,draft_json,archived_at FROM episode_productions WHERE episode_id=?").get(args.episodeId) as
            { revision: number; draft_json: string; archived_at: string | null } | undefined;
        if (!prodRow) throw new Error(`找不到制作稿: ${args.episodeId}`);
        const draft = JSON.parse(prodRow.draft_json) as Record<string, any>;
        const director = draft?.director;
        if (!director || !Array.isArray(director?.source?.shots)) throw new Error("该制作稿没有 director.source.shots，跳过");

        let chapterText: string;
        let chapterTitle: string;
        let chapterSource: "file" | "sourceScript";
        if (args.chapterFile) {
            chapterText = fs.readFileSync(args.chapterFile, "utf8");
            chapterTitle = path.basename(args.chapterFile);
            chapterSource = "file";
        } else {
            const planRow = db.prepare("SELECT production_plan_json FROM drama_projects WHERE folder_id=?").get(args.dramaId) as { production_plan_json: string } | undefined;
            if (!planRow) throw new Error(`找不到剧目规划: ${args.dramaId}`);
            const sourceScript = String(JSON.parse(planRow.production_plan_json)?.sourceScript || "");
            const chapters = splitChapters(sourceScript);
            const chapter = chapters.find(c => c.no === Number(ep.episode_number))
                || chapters.find(c => c.title === ep.title);
            if (!chapter) throw new Error(`无法从 sourceScript 定位第 ${ep.episode_number} 章；请用 --chapter-file 指定本章原文`);
            chapterText = `${chapter.title}\n${chapter.body}`;
            chapterTitle = chapter.title;
            chapterSource = "sourceScript";
        }

        const shots = director.source.shots as ShotLike[];
        const registryNames = Array.isArray(director.source.character_registry)
            ? (director.source.character_registry as Array<Record<string, unknown>>).map(r => String(r?.name || ""))
            : [];
        const sourceLines = quotedSourceLines(chapterText);
        const missingBefore = missingDialogue(sourceLines, shotLines(shots));
        const shotsWithoutDialogues = shots.filter(s => !Array.isArray(s?.dialogues) || (s.dialogues as unknown[]).length === 0).length;
        const result = backfillShots({ chapterText, shots, characterRegistryNames: registryNames });
        const missingAfter = missingDialogue(sourceLines, shotLines(result.shots));
        return {
            episode: { id: ep.id, dramaId: String(ep.drama_id), episodeNumber: Number(ep.episode_number), title: ep.title },
            revision: Number(prodRow.revision),
            chapterSource,
            chapterTitle,
            sourceLines,
            missingBefore,
            shotsWithoutDialogues,
            assignments: result.assignments,
            missingAfter,
            sourceHashConsistent: directorHash(director.source) === director.sourceHash,
            archived: Boolean(prodRow.archived_at),
        };
    } finally {
        db.close();
    }
}

/** 备份原 draft_json，返回备份文件路径；同时写一个极简 rollback 清单。 */
function backupDraft(episodeId: string, revision: number, draftJson: string, backupDir: string): string {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(backupDir, `${episodeId}-rev${revision}-${stamp}.draft.json`);
    fs.writeFileSync(file, draftJson, "utf8");
    const manifest = path.join(backupDir, `${episodeId}-rev${revision}-${stamp}.rollback.json`);
    fs.writeFileSync(manifest, JSON.stringify({
        episodeId, revision, draftJsonFile: path.basename(file),
        restoreSql: `UPDATE episode_productions SET revision=${revision}, draft_json=readfile('${file.replace(/\\/g, "/")}') WHERE episode_id='${episodeId}';`,
        note: "readfile() 为 sqlite3 CLI 函数；也可用任意工具把 draftJsonFile 的内容写回 draft_json 并恢复 revision。",
    }, null, 2), "utf8");
    if (fs.statSync(file).size === 0) throw new Error("备份文件为空，拒绝写入");
    return file;
}

function apply(args: Args, p: Plan): {
    backup: string;
    revision: number;
    added: number;
    verify: { missingBefore: string[]; missingAfter: string[]; assignmentsInDb: number; sourceHashConsistent: boolean; revision: number };
} {
    if (p.archived) throw new Error("该分集已归档（archived_at），拒绝修改");
    if (!p.assignments.length) throw new Error("没有可回填的台词，拒绝写入");
    if (p.missingAfter.length) throw new Error("回填后仍有缺失台词，拒绝写入");

    const db = new BackendDatabase(DB_FILE);
    try {
        db.db.exec("PRAGMA busy_timeout=10000");
        db.db.exec("BEGIN IMMEDIATE");
        let result: { backup: string; revision: number; added: number };
        try {
            result = doWrite(db);
            db.db.exec("COMMIT");
        } catch (error) {
            db.db.exec("ROLLBACK");
            throw error;
        }
        // 写后复核必须在同一连接上读：同进程新开的只读连接可能拿到 WAL 旧快照。
        const row = db.db.prepare("SELECT revision,draft_json FROM episode_productions WHERE episode_id=?").get(args.episodeId) as { revision: number; draft_json: string };
        const stored = JSON.parse(row.draft_json) as Record<string, any>;
        const storedShots = (stored?.director?.source?.shots || []) as ShotLike[];
        return { ...result, verify: {
            missingBefore: p.missingBefore,
            missingAfter: missingDialogue(p.sourceLines, shotLines(storedShots)),
            assignmentsInDb: storedShots.reduce((n, s) => n + (Array.isArray(s?.dialogues) ? s.dialogues!.length : 0), 0),
            sourceHashConsistent: directorHash(stored.director.source) === stored.director.sourceHash,
            revision: Number(row.revision),
        } };
    } finally {
        db.close();
    }

    function doWrite(db: BackendDatabase): { backup: string; revision: number; added: number } {
            // 在事务内重新读最新行，避免覆盖并发写入。
            const row = db.db.prepare("SELECT revision,draft_json,archived_at FROM episode_productions WHERE episode_id=?").get(args.episodeId) as
                { revision: number; draft_json: string; archived_at: string | null } | undefined;
            if (!row) throw new Error("写入前制作稿消失");
            if (row.archived_at) throw new Error("制作稿在写入前被归档");
            const draft = JSON.parse(row.draft_json) as Record<string, any>;
            const director = draft?.director;
            if (!director || !Array.isArray(director?.source?.shots)) throw new Error("写入前制作稿结构变化，拒绝写入");

            // 标记 stale / 撤销执行授权（与源码变更的既有链路一致）。
            director.artifacts = (Array.isArray(director.artifacts) ? director.artifacts : [])
                .map((a: Record<string, unknown>) => ({ ...a, status: "stale" }));
            director.executionAuthorized = false;

            // 用同一算法在最新真值源上重算（幂等、防并发漂移）。
            const chapterText = args.chapterFile ? fs.readFileSync(args.chapterFile, "utf8") : rebuildChapterText(args.dramaId, p.episode.episodeNumber, p.chapterTitle);
            const registryNames = Array.isArray(director.source.character_registry)
                ? (director.source.character_registry as Array<Record<string, unknown>>).map(r => String(r?.name || ""))
                : [];
            const result = backfillShots({ chapterText, shots: director.source.shots as ShotLike[], characterRegistryNames: registryNames });
            if (!result.added) return { backup: "", revision: Number(row.revision), added: 0 };
            director.source.shots = result.shots;
            director.sourceHash = directorHash(director.source);
            if (director.workflow?.currentWork) director.workflow.currentWork = { ...director.workflow.currentWork, sourceHash: director.sourceHash };

            const backup = backupDraft(args.episodeId, Number(row.revision), row.draft_json, args.backupDir || path.join(path.dirname(DB_FILE), "backups", "shot-dialogue-backfill"));
            const revision = Number(row.revision) + 1;
            const updatedAt = new Date().toISOString();
            db.db.prepare("UPDATE episode_productions SET revision=?,draft_json=?,updated_at=? WHERE episode_id=?")
                .run(revision, JSON.stringify(withoutDirectorProjection(draft as never)), updatedAt, args.episodeId);
            return { backup, revision, added: result.added };
    }
}

/** apply 阶段重建章节正文（只读 sourceScript；与 plan 同一拆章逻辑）。 */
function rebuildChapterText(dramaId: string, episodeNumber: number, chapterTitle: string): string {
    if (chapterTitle.endsWith(".txt") || chapterTitle.endsWith(".md")) return fs.readFileSync(chapterTitle, "utf8");
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        const planRow = db.prepare("SELECT production_plan_json FROM drama_projects WHERE folder_id=?").get(dramaId) as { production_plan_json: string } | undefined;
        const sourceScript = String(JSON.parse(planRow?.production_plan_json || "{}")?.sourceScript || "");
        const chapter = splitChapters(sourceScript).find(c => c.no === episodeNumber) || splitChapters(sourceScript).find(c => c.title === chapterTitle);
        if (!chapter) throw new Error("apply 阶段无法重建章节原文");
        return `${chapter.title}\n${chapter.body}`;
    } finally { db.close(); }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(DB_FILE)) throw new Error(`数据库不存在，拒绝创建空库: ${DB_FILE}`);
    const p = plan(args);
    if (!args.apply) {
        console.log(JSON.stringify({ ok: true, dryRun: true, db: DB_FILE, plan: p }, null, 2));
        return;
    }
    const result = apply(args, p);
    console.log(JSON.stringify({ ok: true, dryRun: false, ...result }, null, 2));
}

try { main(); }
catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
}
