/**
 * 从分镜反推原文（老剧目维护脚本；默认 dry-run 只读，--apply 才写）。
 *
 * 用途：部分老剧目 production_plan_json.sourceScript 为空，导致
 *   backfill-episode-chapters.ts 无法切章 → source_chapters / chapter_ids_json 为空
 *   → resolveEpisodeChapterNumbers() 返回 [] → 造型章节选图回退角色主图。
 * 本脚本按各集 director.source.shots[] 的真实画面描述反推一段通顺叙述，
 * 拼成「每集一章」的原文，供下游切章使用。
 *
 * 用法（在 backend/ 目录）：
 *   node --import tsx src/maintenance/backfill-source-script.ts                       # 7 部剧全量 dry-run
 *   node --import tsx src/maintenance/backfill-source-script.ts --drama-id <id>        # 单剧 dry-run
 *   node --import tsx src/maintenance/backfill-source-script.ts --apply                # 真正写入（先整份 plan 备份）
 *   node --import tsx src/maintenance/backfill-source-script.ts --apply --force        # 覆盖非空 sourceScript / 已有 chapter_ids_json
 *
 * 真值来源（严格不编造情节）：
 *   - shot.visual                 画面白话描述（主体内容）
 *   - shot.utterance_refs → director.source.utterances[].text  真实对白（可按时长切片）
 *   - subject_registry / character_registry  对白说话人姓名
 *   - shot.title / camera / audio 等纯拍摄字段一律不进正文
 *   某集确无 shots 时，仅用集标题生成一段「占位」正文，如实标记为 placeholder，
 *   目的只是让「切章数 = 集数」一一对应，不伪造任何情节。
 *
 * 章节标题格式：`第 <集号> 章 <集标题>`。
 *   - splitChapters()（backfill-shot-dialogues 用）按标题里的数字取章号 → 章号=集号；
 *   - analyzeNovelChapters()（syncSourceChapters 用）按出现顺序给 chapter_index=1..N。
 *   本脚本生成时严格「按集号升序、每集一章」，因此两种口径在本脚本产物上一致。
 *
 * --apply 流程：
 *   1. 备份整份 production_plan_json 到 backups/source-script-backfill/（可回滚）。
 *   2. UPDATE drama_projects.production_plan_json：写 sourceScript，并把 sourceSplit.maxChars
 *      抬到「最长单章 + 余量」，以免 analyzeNovelChapters 把超长章二次切开（原值一并进备份）。
 *      其余字段原样保留。
 *   3. 直接复用 backfill-episode-chapters.ts 的真值链：db.syncSourceChapters(...) 写
 *      source_chapters，再在本脚本内把「第 i 集 → 第 i 章」的 chapter id 写进
 *      drama_episodes.chapter_ids_json（事务 + 写后复核）。
 *      不直接 fork backfill-episode-chapters.ts：它仅在「集号连续」时才按位置映射，
 *      而本批剧目存在跳号集（Jvd ep1/ep5、ZtSuz ep10/ep85），那条规则会整剧 skip。
 *      本脚本自己保证「生成顺序 = 集号升序、一集一章」，故按下标映射必然一一对应。
 *   4. 如需复核，可再跑：node --import tsx src/maintenance/backfill-episode-chapters.ts --apply --drama-id <id>
 *      （注意：跳号剧目在该脚本里会 skip，属预期，不影响本脚本已写入的 chapter_ids_json。）
 *
 * 幂等：sourceScript 非空则整剧跳过（--force 例外）；episode 已有 chapter_ids_json
 *       则默认不覆盖（--force 例外）。
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

type Utterance = {
    id: string;
    text: string;
    speakerName?: string;
    voiceover: boolean;
};

type EpisodePlan = {
    id: string;
    episodeNumber: number;
    rawTitle: string;
    chapterTitle: string;
    body: string;
    kind: "reconstructed" | "placeholder";
    shotCount: number;
    dialogueCount: number;
    existingChapterIds: string[];
};

type DramaPlan = {
    dramaId: string;
    split: Split;
    /** 为避免超长章被 analyzeNovelChapters 二次切分而计算的 maxChars（apply 会写进 sourceSplit）。 */
    generationMaxChars: number;
    episodes: EpisodePlan[];
    sourceScript: string;
    /** 用 analyzeNovelChapters 只读复核的切章数；应等于 episodes.length。 */
    splitChapterCount: number;
    splitIssues: string[];
    maxBodyChars: number;
    skipReason?: string;
};

type ApplyResult = {
    backupFile: string;
    dramasWritten: string[];
    dramasSkipped: Array<{ dramaId: string; reason: string }>;
    sourceChars: number;
    chaptersCreated: number;
    episodesWritten: number;
    episodesSkippedExisting: number;
    verify: Array<{ episodeId: string; episodeNumber: number; expected: number[]; actual: number[]; ok: boolean }>;
};

/** 上一批因 sourceScript 为空被 skip 的 7 部剧（父代理已查实）。 */
const TARGET_IDS = [
    "0Gp2DEKTs--lpS5-2OFy7",
    "0nPaoK8gy54znDQpDnpBw",
    "AmaXV222WI_jOJrZti8hj",
    "EDi-LE1ibDtsMjj69UMxJ",
    "Jvd7x1ZbCVDxjIJhSSCZ1",
    "ZtSuzRl8Co3AF3YFZZ-hn",
    "ykAthSZDA7dX22HXd5KcE",
] as const;

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

function parsePlan(raw: string | null | undefined): {
    sourceScript: string;
    split: Split;
    plan: Record<string, unknown>;
} {
    let plan: Record<string, unknown>;
    try { plan = JSON.parse(String(raw || "{}")) as Record<string, unknown>; }
    catch { plan = {}; }
    const rawSplit = (plan.sourceSplit && typeof plan.sourceSplit === "object")
        ? plan.sourceSplit as Record<string, unknown> : {};
    const split: Split = {
        excluded: Array.isArray(rawSplit.excluded) ? rawSplit.excluded.map(Number).filter(Number.isFinite) : [],
        perEpisode: Math.max(1, Math.floor(Number(rawSplit.perEpisode) || 1)),
        maxChars: Math.max(0, Math.floor(Number(rawSplit.maxChars) || 0)),
    };
    return { sourceScript: String(plan.sourceScript || ""), split, plan };
}

function parseChapterIds(raw: string | null | undefined): string[] {
    try {
        const value = JSON.parse(String(raw || "[]"));
        return Array.isArray(value) ? value.map(String) : [];
    } catch { return []; }
}

function effectiveMaxChars(split: Split): number {
    // 与 db.syncSourceChapters 一致：Number(maxChars) || 3000。
    return Number(split.maxChars) || 3000;
}

/** 集标题去掉「第N集：」「第一章」这类前缀，避免章节标题里出现「第1章 第一集：…」。 */
function cleanEpisodeTitle(raw: string): string {
    const original = String(raw || "").trim();
    let title = original
        .replace(/^[【\[(（]?\s*第\s*[0-9零〇一二三四五六七八九十百]+\s*(?:集|章|回)\s*[】\])）]?\s*[：:·\-—.]?\s*/u, "")
        .replace(/^[（(]\s*[)）]\s*/u, "")
        .trim();
    if (!title) title = original.slice(0, 32) || "无题";
    return title;
}

/** 章节标题整行（analyzeNovelChapters 的 MAX_HEADING_CHARS=60，留余量）。 */
function chapterHeading(episodeNumber: number, rawTitle: string): string {
    const prefix = `第 ${episodeNumber} 章 `;
    let title = cleanEpisodeTitle(rawTitle);
    const room = 58 - prefix.length;
    if (title.length > room) title = `${title.slice(0, Math.max(1, room - 1))}…`;
    return `${prefix}${title}`;
}

const SHOT_LABEL = /^(?:镜头|镜号|SHOT)\s*\d+\s*[·:：.、\-—]?\s*/iu;
const FRAMING_TOKEN = /[（(]\s*(?:ECU|EWS|WS|CU|FS|MS|OTS|POV|全景|中景|近景|特写|空镜)\s*[）)]/giu;
/** 分镜里偶发的「制作约束合同」段落（VOICE OWNERSHIP / Do not add… 等），不是情节叙述，剔除。 */
const META_PARAGRAPH = /(VOICE OWNERSHIP|voiceover narrator|narration is (?:a|the)|spoken exclusively|Create the shot directly|reference images|<Picture\b|identity reference|Do not |Do NOT |Never |never inherit|exclusion rules|No invented|No fantasy|No dramatic|No additional|Lip synchronization|lip synchronization|should feel like|emotional information emerges|must remain|MUST remain)/iu;

/** 去掉纯拍摄标签与制作约束段；visual 本身已是白话叙述，仅做保守清洗，不改写情节。 */
function cleanVisual(raw: unknown): string {
    let text = String(raw ?? "").replace(/\r\n?/gu, "\n").trim();
    // 多段 contract 型 visual：逐段剔除约束条款，只留可叙述的场景段。
    if (text.includes("\n")) {
        const kept = text.split(/\n{2,}/u)
            .map((part) => part.replace(/\s+/gu, " ").trim())
            .filter(Boolean)
            .filter((part) => !META_PARAGRAPH.test(part));
        text = kept.join(" ");
    } else {
        text = text.replace(/\s+/gu, " ").trim();
    }
    text = text.replace(SHOT_LABEL, "").replace(/^定场\s*[·:：\-—]\s*/u, "");
    text = text.replace(FRAMING_TOKEN, "").replace(/\s{2,}/gu, " ").trim();
    if (text && !/[。！？!?；;"”」』.]/u.test(text.slice(-1))) text += "。";
    return text;
}

/** 说话人姓名：subject_registry[].entityRef.id → character_registry[].name。 */
function buildUtteranceMap(source: Record<string, any>): Map<string, Utterance> {
    const map = new Map<string, Utterance>();
    const characterName = new Map<string, string>();
    for (const ch of (Array.isArray(source.character_registry) ? source.character_registry : []) as Array<Record<string, any>>) {
        if (ch?.id && ch?.name) characterName.set(String(ch.id), String(ch.name));
    }
    const subjectName = new Map<string, string>();
    for (const sub of (Array.isArray(source.subject_registry) ? source.subject_registry : []) as Array<Record<string, any>>) {
        const entityId = sub?.entityRef?.id;
        if (sub?.id && entityId && characterName.has(String(entityId))) {
            subjectName.set(String(sub.id), characterName.get(String(entityId))!);
        }
    }
    for (const utt of (Array.isArray(source.utterances) ? source.utterances : []) as Array<Record<string, any>>) {
        const text = String(utt?.text ?? "").trim();
        if (!utt?.id || !text) continue;
        map.set(String(utt.id), {
            id: String(utt.id),
            text,
            speakerName: subjectName.get(String(utt.speakerSubjectId)),
            voiceover: Boolean(utt.voiceover),
        });
    }
    return map;
}

/** 取一条 shot 的真实对白：优先 dialogues[].text，其次 utterance_refs 切片。 */
function shotDialogues(shot: Record<string, any>, utterances: Map<string, Utterance>): string[] {
    const out: string[] = [];
    const push = (text: string, speaker?: string) => {
        const clean = text.trim();
        if (!clean) return;
        const line = speaker ? `${speaker}道：“${clean}”` : `“${clean}”`;
        if (!out.includes(line)) out.push(line);
    };
    if (Array.isArray(shot.dialogues)) {
        for (const d of shot.dialogues as Array<Record<string, any>>) push(String(d?.text ?? ""));
    }
    if (Array.isArray(shot.utterance_refs)) {
        for (const ref of shot.utterance_refs as Array<Record<string, any>>) {
            const utt = utterances.get(String(ref?.utteranceId));
            if (!utt) continue;
            const start = Number(ref?.textStart);
            const end = Number(ref?.textEnd);
            const slice = Number.isFinite(start) && Number.isFinite(end) && end > start
                ? utt.text.slice(start, end) : utt.text;
            push(slice, utt.speakerName);
        }
    }
    return out;
}

/** 每 6 个镜头一句落一段，避免整章变成一句超长文本；不改变任何情节。 */
function joinParagraphs(sentences: string[]): string {
    const paragraphs: string[] = [];
    for (let i = 0; i < sentences.length; i += 6) {
        paragraphs.push(sentences.slice(i, i + 6).join(""));
    }
    return paragraphs.join("\n\n");
}

function buildEpisode(
    episode: { id: string; episode_number: number; title: string; chapter_ids_json: string | null },
    draftJson: string | null,
): EpisodePlan {
    let source: Record<string, any> = {};
    let shots: Array<Record<string, any>> = [];
    try {
        const draft = JSON.parse(String(draftJson || "{}")) as Record<string, any>;
        const src = draft?.director?.source;
        if (src && typeof src === "object") source = src as Record<string, any>;
        if (Array.isArray(source.shots)) shots = source.shots as Array<Record<string, any>>;
    } catch { /* 解析失败按无 shots 处理，并在正文里如实占位 */ }

    const ordered = shots
        .map((shot, index) => ({ shot, index }))
        .sort((a, b) => {
            const ao = Number(a.shot?.story_order);
            const bo = Number(b.shot?.story_order);
            return (Number.isFinite(ao) ? ao : a.index) - (Number.isFinite(bo) ? bo : b.index) || a.index - b.index;
        })
        .map(({ shot }) => shot);

    const utterances = buildUtteranceMap(source);
    const sentences: string[] = [];
    let dialogueCount = 0;
    for (const shot of ordered) {
        const visual = cleanVisual(shot?.visual);
        if (!visual || visual === sentences[sentences.length - 1]) continue; // 跳过空段与重复画面
        const lines = shotDialogues(shot, utterances);
        dialogueCount += lines.length;
        sentences.push(`${visual}${lines.join("")}`);
    }

    const kind: EpisodePlan["kind"] = sentences.length ? "reconstructed" : "placeholder";
    const body = sentences.length
        ? joinParagraphs(sentences)
        : `${cleanEpisodeTitle(episode.title)}：本集暂无分镜数据，此处仅保留章节占位以保证章节与本集一一对应，未补写任何情节。`;

    return {
        id: String(episode.id),
        episodeNumber: Number(episode.episode_number),
        rawTitle: String(episode.title || ""),
        chapterTitle: chapterHeading(Number(episode.episode_number), String(episode.title || "")),
        body,
        kind,
        shotCount: ordered.length,
        dialogueCount,
        existingChapterIds: parseChapterIds(episode.chapter_ids_json),
    };
}

function buildSourceScript(episodes: EpisodePlan[]): string {
    return `${episodes.map((ep) => `${ep.chapterTitle}\n\n${ep.body}`).join("\n\n")}\n`;
}

function planDrama(dramaId: string, args: Args): DramaPlan {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        const row = db.prepare("SELECT production_plan_json FROM drama_projects WHERE folder_id=?").get(dramaId) as
            { production_plan_json: string | null } | undefined;
        if (!row) throw new Error(`找不到剧目: ${dramaId}`);
        const { sourceScript, split } = parsePlan(row.production_plan_json);

        const episodeRows = db.prepare(
            "SELECT id, episode_number, title, chapter_ids_json FROM drama_episodes WHERE drama_id=? ORDER BY episode_number ASC"
        ).all(dramaId) as Array<{ id: string; episode_number: number; title: string; chapter_ids_json: string | null }>;

        if (sourceScript.trim() && !args.force) {
            return {
                dramaId, split, generationMaxChars: effectiveMaxChars(split),
                episodes: [], sourceScript: "", splitChapterCount: 0,
                splitIssues: [], maxBodyChars: 0,
                skipReason: `sourceScript 已非空（${sourceScript.length} 字），幂等跳过（--force 可覆盖）`,
            };
        }
        if (!episodeRows.length) {
            return {
                dramaId, split, generationMaxChars: effectiveMaxChars(split),
                episodes: [], sourceScript: "", splitChapterCount: 0,
                splitIssues: [], maxBodyChars: 0, skipReason: "该剧没有任何分集，跳过",
            };
        }

        const episodes = episodeRows.map((ep) => {
            const prod = db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get(ep.id) as
                { draft_json: string | null } | undefined;
            return buildEpisode(ep, prod?.draft_json ?? null);
        });
        const script = buildSourceScript(episodes);
        const maxBodyChars = Math.max(0, ...episodes.map((ep) => ep.body.length));
        // analyzeNovelChapters 的 maxChapterChars = max(maxChars, 12000)：单章正文超过它会被
        // 二次切成「（续 N）」，破坏「一集一章」。抬高预算并写回 sourceSplit，保证后续
        // backfill-episode-chapters.ts 用同一口径切章，chapter index 仍然 1..N 顺序对应。
        const generationMaxChars = Math.max(effectiveMaxChars(split), maxBodyChars + 2000, 12_001);

        // 只读复核切章：与 syncSourceChapters 完全相同的口径。
        const splitResult = analyzeNovelChapters(script, {
            maxChars: generationMaxChars, minChars: 200,
        });
        const issues = splitResult.issues.map((issue) => `${issue.kind}: ${issue.message}`);
        if (splitResult.chapters.length !== episodes.length) {
            issues.push(`切章数(${splitResult.chapters.length}) ≠ 集数(${episodes.length})，映射会错位`);
        }

        return {
            dramaId, split, generationMaxChars, episodes, sourceScript: script,
            splitChapterCount: splitResult.chapters.length,
            splitIssues: issues,
            maxBodyChars,
        };
    } finally { db.close(); }
}

function planAll(args: Args): DramaPlan[] {
    const ids = args.dramaId ? [args.dramaId] : [...TARGET_IDS];
    return ids.map((id) => planDrama(id, args));
}

function renderDryRun(plans: DramaPlan[], args: Args): string {
    const lines: string[] = [];
    lines.push("=== 从分镜反推原文 dry-run（只读，未写库） ===");
    lines.push(`DB: ${DB_FILE}`);
    lines.push(`范围: ${args.dramaId || `预设 7 部`}  |  --force: ${args.force}  |  --apply: false`);
    lines.push("");
    let totalEpisodes = 0;
    let totalReconstructed = 0;
    let totalPlaceholder = 0;
    for (const plan of plans) {
        lines.push(`── ${plan.dramaId} ──────────────────────────────`);
        if (plan.skipReason) {
            lines.push(`  [SKIP] ${plan.skipReason}`);
            lines.push("");
            continue;
        }
        lines.push(`  集数=${plan.episodes.length}  切章数=${plan.splitChapterCount}  最长单章正文=${plan.maxBodyChars}字  单章预算maxChars=${plan.generationMaxChars}(apply会写回sourceSplit)  原split=${JSON.stringify(plan.split)}`);
        for (const issue of plan.splitIssues) lines.push(`  [切章提示] ${issue}`);
        for (const ep of plan.episodes) {
            totalEpisodes += 1;
            if (ep.kind === "reconstructed") totalReconstructed += 1;
            else totalPlaceholder += 1;
            lines.push(
                `  集${ep.episodeNumber} → ${ep.chapterTitle}  ` +
                `[${ep.kind}] shots=${ep.shotCount} 对白=${ep.dialogueCount} 正文=${ep.body.length}字 已有chapterIds=${ep.existingChapterIds.length}`
            );
        }
        const preview = plan.sourceScript.slice(0, 300).replace(/\n/gu, "⏎");
        lines.push(`  原文预览(前300字): ${preview}`);
        lines.push("");
    }
    lines.push(`=== 汇总: 剧目=${plans.length}  集=${totalEpisodes}  反推=${totalReconstructed}  占位=${totalPlaceholder} ===`);
    lines.push("核对文本为通顺情节叙述、切章数=集数后，再加 --apply 写入（apply 先整份备份 production_plan_json）。");
    return lines.join("\n");
}

function writeBackup(rows: Array<{ dramaId: string; productionPlanJson: string | null }>, backupDir: string): string {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(backupDir, `source-script-backfill-${stamp}.json`);
    const payload = {
        createdAt: new Date().toISOString(), db: DB_FILE,
        note: "回滚：按 rows 里的原 production_plan_json 原样 UPDATE drama_projects；chapter_ids_json 原值在 episodeBackup 中。",
        rows,
        episodeBackup: rows.flatMap((row) => {
            const db = new DatabaseSync(DB_FILE, { readOnly: true });
            try {
                return db.prepare("SELECT id, drama_id, episode_number, chapter_ids_json FROM drama_episodes WHERE drama_id=?")
                    .all(row.dramaId) as Array<Record<string, unknown>>;
            } finally { db.close(); }
        }),
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

function applyAll(plans: DramaPlan[], args: Args): ApplyResult {
    const active = plans.filter((plan) => !plan.skipReason);
    if (!active.length) throw new Error("没有可写入的剧目（sourceScript 均非空，如确需覆盖请加 --force）");
    const db = new BackendDatabase(DB_FILE);
    try {
        db.db.exec("PRAGMA busy_timeout=10000");
        ensureBodyColumn(db);

        const backupRows = active.map((plan) => {
            const row = db.db.prepare("SELECT production_plan_json FROM drama_projects WHERE folder_id=?").get(plan.dramaId) as
                { production_plan_json: string | null } | undefined;
            return { dramaId: plan.dramaId, productionPlanJson: row?.production_plan_json ?? null };
        });
        const backupDir = args.backupDir || path.join(path.dirname(DB_FILE), "backups", "source-script-backfill");
        const backupFile = writeBackup(backupRows, backupDir);

        const result: ApplyResult = {
            backupFile, dramasWritten: [], dramasSkipped: [], sourceChars: 0,
            chaptersCreated: 0, episodesWritten: 0, episodesSkippedExisting: 0, verify: [],
        };

        for (const plan of plans) {
            if (plan.skipReason) {
                result.dramasSkipped.push({ dramaId: plan.dramaId, reason: plan.skipReason });
                continue;
            }
            if (plan.splitChapterCount !== plan.episodes.length) {
                throw new Error(
                    `${plan.dramaId} 切章数(${plan.splitChapterCount}) ≠ 集数(${plan.episodes.length})，拒绝写入以防章节映射错位`
                );
            }
            const { plan: originalPlan } = parsePlan(
                backupRows.find((row) => row.dramaId === plan.dramaId)?.productionPlanJson
            );
            const rawSplit = (originalPlan.sourceSplit && typeof originalPlan.sourceSplit === "object")
                ? originalPlan.sourceSplit as Record<string, unknown> : {};
            const updatedPlan = {
                ...originalPlan,
                sourceScript: plan.sourceScript,
                // 抬高单章预算并落盘，保证后续任何工具按同一口径切章都不会把超长章二次切开。
                sourceSplit: { ...rawSplit, maxChars: plan.generationMaxChars },
            };

            // 1) 写 sourceScript（整份 plan 写回，仅替换 sourceScript / sourceSplit.maxChars）。
            db.db.prepare("UPDATE drama_projects SET production_plan_json=?, updated_at=? WHERE folder_id=?")
                .run(JSON.stringify(updatedPlan), new Date().toISOString(), plan.dramaId);

            // 2) 复用真值链：syncSourceChapters 自带事务，不能放进外层事务。
            const before = db.listSourceChapters(plan.dramaId).length;
            const synced = db.syncSourceChapters(
                plan.dramaId,
                plan.sourceScript,
                { excluded: plan.split.excluded, maxChars: plan.generationMaxChars },
                "chapter",
            );
            result.dramasWritten.push(plan.dramaId);
            result.sourceChars += plan.sourceScript.length;
            result.chaptersCreated += Math.max(0, synced.chapters.length - before);
            const idByIndex = new Map(synced.chapters.map((chapter) => [chapter.chapterIndex, chapter.id] as const));

            // 3) 第 i 集 → 第 i 章（按集号升序，生成/切章同序）。
            db.db.exec("BEGIN IMMEDIATE");
            try {
                plan.episodes.forEach((ep, position) => {
                    const chapterIndex = position + 1;
                    const row = db.db.prepare("SELECT chapter_ids_json FROM drama_episodes WHERE id=?").get(ep.id) as
                        { chapter_ids_json: string | null } | undefined;
                    if (!row) throw new Error(`写入前分集消失: ${ep.id}`);
                    if (parseChapterIds(row.chapter_ids_json).length && !args.force) {
                        result.episodesSkippedExisting += 1;
                        return;
                    }
                    const chapterId = idByIndex.get(chapterIndex);
                    if (!chapterId) throw new Error(`章 id 缺失: ${ep.id} -> 第 ${chapterIndex} 章`);
                    db.db.prepare("UPDATE drama_episodes SET chapter_ids_json=?, updated_at=? WHERE id=?")
                        .run(JSON.stringify([chapterId]), new Date().toISOString(), ep.id);
                    result.episodesWritten += 1;
                });
                db.db.exec("COMMIT");
            } catch (error) { db.db.exec("ROLLBACK"); throw error; }

            // 4) 同连接复核（新连接可能拿到 WAL 旧快照）。
            plan.episodes.forEach((ep, position) => {
                const expected = [position + 1];
                const actual = db.resolveEpisodeChapterNumbers(ep.id);
                result.verify.push({
                    episodeId: ep.id, episodeNumber: ep.episodeNumber, expected, actual,
                    ok: JSON.stringify(actual) === JSON.stringify(expected),
                });
            });
        }
        return result;
    } finally { db.close(); }
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
    console.log(JSON.stringify({ ok: failed.length === 0, dryRun: false, ...result, verifyFailed: failed }, null, 2));
    if (failed.length) process.exitCode = 1;
}

try { main(); }
catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
}
