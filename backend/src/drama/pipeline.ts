/**
 * 全自动流水线编排器（对齐影策 django drama_orchestrator.go 的七段机 + release worker）。
 *
 * 设计约束（全部读现有源码确认过真实调用形状，不猜）：
 * - 持久化完全走 PipelineStore（独立 SQLite 连接 runtime.sqlite 的 drama_pipelines /
 *   drama_pipeline_jobs / drama_pipeline_events 三表，DDL 在 database-schema.ts）。
 * - 所有业务能力通过 HTTP 自调用后端现成路由（Bearer token），不新增 provider：
 *     GET  /drama/projects/:dramaId/episodes            (server.ts:1104)
 *     GET  /drama/:dramaId/stage                        (drama-planning-routes.ts:248)
 *     POST /drama/episodes/:eid/script-proposal         (drama-planning-routes.ts:79)
 *     PATCH /drama/episodes/:eid  {synopsis}            (server.ts:1277)
 *     GET/POST /drama/episodes/:eid/production[/ops]    (drama-production-routes.ts:240/359)
 *     POST .../production/{publish,compile,apply-compilation,prepare-targets,sync-clips}
 *     GET  .../production/compilations/:op              (drama-production-routes.ts:129)
 *     GET  .../production/readiness                     (drama-production-routes.ts:280)
 *     POST /canvas/generation  (canvasGenerationCommandSchema, generation-contract.ts:67)
 *     GET  /tasks/:id          (server.ts:2074, CANVAS_TASK_ROUTE)
 *     GET/POST /canvas/projects/:id[/ops]               (server.ts:618/895)
 *     POST /agent/video-concat/tasks                    (agent-runtime-routes.ts:16)
 *     GET  /agent/runtime/tasks/:id                     (agent-runtime-routes.ts:29)
 * - prompt 构造 / 解析复用 canvas-agent 的纯函数（chapter-demand / chapter-storyboard /
 *   asset-extract / segment-writer），它们已被 package.json exports 到 dist，后端可直接 import。
 * - 画布段 id ≠ 制作段 id：靠 H3 节点 metadata.segments[].productionClipProjection.targetId
 *   反查 nodeId + canvas segment id（见 cross-app-ui-parity.md「P1 段提示词」）。
 *
 * 这里不写任何 route、不改 index.ts、不改 store。
 */
import { randomUUID } from "node:crypto";
import {
    buildChapterDemandPrompt,
    fallbackChapterDemand,
    parseChapterDemand,
    type ChapterDemandEnvironment,
} from "@basketikun/canvas-agent/drama/chapter-demand";
import {
    planChapterStoryboard,
    toSceneStoryboardOps,
    type ChapterScenePlan,
} from "@basketikun/canvas-agent/drama/chapter-storyboard";
import {
    buildAssetExtractPrompt,
    fallbackAssetExtract,
    parseAssetExtract,
} from "@basketikun/canvas-agent/drama/asset-extract";
import {
    ASSET_SCHEMES,
    defaultSchemeFor,
    renderAssetPromptWithTemplate,
    schemeAppliesTo,
    type AssetPromptTemplates,
    type AssetSchemeId,
} from "@basketikun/canvas-agent/drama/asset-spec";
import {
    buildSegmentWriterPrompt,
    buildSegmentCondensePrompt,
    cleanWrittenPrompt,
    type SegmentWriterInput,
    type SegmentWriterShot,
} from "@basketikun/canvas-agent/drama/segment-writer";
import { canonicalH3TaskMode } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { deriveSegmentReferenceBindings, alignPromptPictures } from "./segment-reference-bindings.js";
import { characterRefsOf, propRefsOf } from "./shot-refs.js";
import { checkPromptLength, type PromptLengthCheck } from "../canvas/model-video-capability.js";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { dramaVideoResolutionToH3, dramaVideoPixels, type DramaVideoAspectRatio, type DramaVideoResolutionTier } from "@basketikun/canvas-agent/drama/video-resolution";
import { canonicalH3AspectRatio } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { learnedRulesCompact } from "./learned-rules.js";

import { PipelineStore, type JobRow, type PipelineRow } from "./pipeline-store.js";
import { collectFinalVideos, renderReadiness } from "./final-composer.js";
import { findPipelineAssetEntityNode, generatedMediaStorageKey } from "./pipeline-asset-image.js";

// ── 常量 ─────────────────────────────────────────────────────────────────
const DEFAULT_BASE_URL = "http://127.0.0.1:17370";
const TICK_MS = 3000;
const LEASE_TTL_MS = 2 * 60 * 1000;
const HTTP_TIMEOUT_MS = 180_000; // LLM 生成类请求常需 30-90s；20s 会误 abort（This operation was aborted）。
// 单段 H3 生成常需 20-40 分钟（十步采样），15 分钟会把正常在跑的段误判 TASK_TIMEOUT，
// 外层随后重提撞占用、重复出片。对齐引擎 canvas/engine-client.ts 的 DEFAULT_TIMEOUT_MS（60 分钟）。
export const TASK_TIMEOUT_MS = 60 * 60 * 1000;
/** 进程重启后 running 作业的执行上下文丢失；超过此时长未更新的作业需重新入队。
 *  必须大于 TASK_TIMEOUT_MS，否则 20-40 分钟的正常 H3 段会在等待期被当成僵尸回收。 */
const STALE_JOB_TTL_MS = 90 * 60 * 1000;
const TASK_POLL_MS = 1200;
const DEFAULT_POOL_LIMIT = 4;
const DEFAULT_GLOBAL_LIMIT = 16;
const MAX_JOBS_PER_TICK = 32;
const MAX_ATTEMPTS = 3;
/** 绝对重试红线：无论外部如何 requeue，attempt 超过此值一律强制终态，防止死循环。 */
const MAX_ATTEMPTS_HARD = 6;
/** C5：段提示词精简 system prompt（对齐影策 SegmentCondenseSystemPrompt）。 */
const CONDENSE_SYSTEM_PROMPT = "你是 AI 短剧的视频提示词编辑。你只做精简：在不改变镜头结构、台词与表演的前提下删去重复和冗余描述，让提示词符合视频模型的字数上限。只输出精简后的提示词正文，不要任何解释、标题前缀或代码块。";
/** 源剧本无对白时的运行期补写 system（实测有效版本，逐字使用）。 */
const DIALOGUE_SYSTEM_PROMPT =
    "你是短剧对白编剧。根据镜头素材稿，为每个有角色互动的镜头补写对白。" +
    "要求：1.仅使用素材稿中出现的角色；2.对白简短生活化有潜台词；" +
    "3.每镜头0-2句每句不超20字，无互动写（无台词）；4.严格输出JSON。";
/** C5：段提示词自动精简最多尝试次数（对齐影策 dramaPromptCondenseAttempts）。 */
const PROMPT_CONDENSE_ATTEMPTS = 3;
/**
 * C6 依赖未就绪类错误码：这些不是作业本身失败，而是上游（本体参考图/素材/前置产物）还没就绪。
 * 对齐影策「本体未 ready 不排队」：这类失败不消耗 attempt，只延长退避等下一轮，避免 busy-loop。
 */
const DEPENDENCY_NOT_READY_CODES = [
    "RENDER_NO_VIDEO",          // 成片作业：画布还没有分镜视频
    "RENDER_SEGMENTS_NOT_READY",// 成片作业：还有段没出片或产物已过期，不合成半成品
    "EPISODE_CANVAS_MISSING",   // 提示词/视频：分集还没有画布
    "H3_NODE_MISSING",          // 视频：还没拆镜编译
    "PROMPTS_NO_SEGMENTS",      // 提示词：制作稿还没有段
    "ASSETS_NO_SYNOPSIS",       // 资产：分集还没有剧本
] as const;
const DEPENDENCY_RETRY_MS = 30_000;
/**
 * 资源占用类错误：视频/图片作业撞到「同一 clip 正被别的任务占用」。
 * 这类不是作业本身失败——重排无意义（占用任务还在跑/卡住），只会秒失败再重排形成死循环
 * （实测 EP1 video attempt 1→4，每次启动即 HTTP 400「H3 Clip 正被任务…占用」）。
 * 命中即熔断：顶到硬上限终态，等占用任务结束或人工介入，不再 requeue/retryFailed 捞起。
 */
const RESOURCE_BUSY_PATTERN = /H3 Clip 正被任务|H3_CLIP_OCCUPIED|正被任务 .* 占用|Clip.*占用.*请先完成|resource.*busy/i;
/** approve 哨兵：样片（第1集）已批准，放行 sample 模式其余集（对齐影策 production.SampleApproved）。 */
const SAMPLE_APPROVED_TARGET = "sample";
/** 持久化 reviewApproval → 审批闸门的对账间隔；后端 HTTP 尚未就绪时下一 tick 自动重试。 */
const REVIEW_RECONCILE_COOLDOWN_MS = 60_000;
/** 旧执行令牌被显式重置时留下的可恢复错误码（暂停本身不再用它中断作业）。 */
const PAUSED_BY_USER = "paused_by_user";

/**
 * 影策 PromptRules 档位 → 提示词硬文本（与 web/use-studio-data.ts:975-987 手动路径同源）。
 * performance(1-10)/cameraDynamics(1-10) 各映射成 5 档文字，注入 SegmentWriterInput.style/cameraMotion。
 * 越界值收敛到 1-10；缺省按 5（自然档）。导出便于单测锁定档位边界。
 */
export function performanceStyleText(value: number | undefined): string {
    const perf = Math.max(1, Math.min(10, Number(value ?? 5)));
    return perf <= 2 ? "表演克制内敛，情绪只在眼神与细微表情变化"
        : perf <= 4 ? "表演自然收敛，情绪变化有分寸不夸张"
        : perf <= 6 ? "表演自然到位，情绪变化落在线条与呼吸上，像在演戏"
        : perf <= 8 ? "表演投入饱满，情绪外放但有层次，面部表情与肢体同步"
        : "表演强烈张力，情绪大幅起伏，表情与身体语言充分夸张";
}

/** 运镜动感(1-10) → 5 档运镜风格文字（与手动路径 use-studio-data.ts:983-987 同源）。 */
export function cameraMotionStyleText(value: number | undefined): string {
    const cam = Math.max(1, Math.min(10, Number(value ?? 5)));
    return cam <= 2 ? "运镜以稳定静态机位为主，几乎不运动"
        : cam <= 4 ? "运镜克制，仅缓慢推拉，稳而有分寸"
        : cam <= 6 ? "运镜有明确动机，稳中带动感，跟随人物动作"
        : cam <= 8 ? "运镜灵活，推拉摇移配合节奏，增强画面动势"
        : "运镜强烈动感，跟拍环绕甩镜并用，节奏凌厉";
}

/** 从 SKILL.md 抽出可作为 instruction 的方法要点（对齐前端 studio-skill-picker.tsx:35 skillInstruction，1900 字上限）。 */
function skillInstructionFromMarkdown(content: string, title: string): string {
    const text = String(content || "").replace(/\r\n/g, "\n");
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
    const desc = fmMatch ? (fmMatch[1].match(/^description:\s*(.+)$/m)?.[1] || "").trim() : "";
    let body = fmMatch ? text.slice(fmMatch[0].length) : text;
    body = body.replace(/^#+\s*/gm, "").replace(/```[\s\S]*?```/g, "").replace(/\n{2,}/g, "\n").trim();
    return [`写作方法参考「${title}」`, desc ? `方法意图：${desc}` : "", body].filter(Boolean).join("\n").slice(0, 1900);
}

/** 影策七段机；queued/done 是边界，真正入队的作业阶段是 script/assets/prompts/video/render。 */
export const PIPELINE_STAGES = ["queued", "script", "assets", "prompts", "review", "video", "render", "done"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

type StageJob = { stage: string; kind: JobKind };
type JobKind = "script" | "assets" | "prompts" | "video" | "render";
type PoolName = "text" | "image" | "video" | "render";

/** 入队顺序即阶段顺序（review 是闸门、不建作业）。 */
const STAGE_JOBS: StageJob[] = [
    { stage: "script", kind: "script" },
    { stage: "assets", kind: "assets" },
    { stage: "prompts", kind: "prompts" },
    { stage: "video", kind: "video" },
    { stage: "render", kind: "render" },
];

/** 每个作业阶段的前置阶段（严格保序；auto 只跳过审批闸门，不跳过真实前置作业）。 */
const STAGE_REQUIRES: Record<string, string[]> = {
    script: [],
    assets: ["script"],
    prompts: ["assets"],
    video: ["prompts"],
    render: ["video"],
};

const POOL_OF_KIND: Record<JobKind, PoolName> = {
    script: "text",
    assets: "text",
    prompts: "text",
    video: "video",
    render: "render",
};

const errText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 作业真实耗时（毫秒）。DB 只存 started_at/finished_at（ISO 串），不落 duration，故在此计算：
 * 任一端缺失、时间不可解析或 finished < started 一律 null（前端显示 —），不猜、不用整集聚合值。
 */
function jobDurationMs(startedAt: unknown, finishedAt: unknown): number | null {
    if (typeof startedAt !== "string" || typeof finishedAt !== "string" || !startedAt || !finishedAt) return null;
    const started = Date.parse(startedAt);
    const finished = Date.parse(finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
    return finished - started;
}

/**
 * attempts_json → 逐次尝试数组 [{ at, attempt?, error?, result? }]（按写入顺序，最旧在前）。
 * 旧作业/脏数据解析失败给 []，前端据此显示「历史数据未采集」，不猜也不伪造。
 */
function jobAttempts(attemptsJson: unknown): Array<Record<string, unknown>> {
    if (typeof attemptsJson !== "string" || !attemptsJson) return [];
    try { return rowsOf(JSON.parse(attemptsJson)); } catch { return []; }
}

/**
 * 画布实体节点上已存在的参考图（角色主图 / 场景图 / 道具图 / 通用 image）。
 * runAssets 的幂等判据之一：制作稿 draft.assets 会被 compile/apply 重建清空，
 * 但实体节点上的图不会，所以这里读真实产物，避免把现成图当「没生成」反复重出。
 */
function assetEntityReferenceKey(node: Record<string, unknown> | null | undefined): string {
    if (!node || typeof node !== "object") return "";
    const meta = (node.metadata && typeof node.metadata === "object" ? node.metadata : {}) as Record<string, unknown>;
    const keyOf = (value: unknown): string => {
        if (!value || typeof value !== "object") return "";
        const row = value as Record<string, unknown>;
        return String(row.storageKey || row.content || "").trim();
    };
    if (String(node.type || "") === "character") {
        const images = Array.isArray(meta.characterImages) ? meta.characterImages : [];
        const primary = Number(meta.characterPrimaryIndex || 0);
        return keyOf(images[primary]) || keyOf(images[0]) || keyOf(meta);
    }
    if (String(node.type || "") === "scene") return keyOf(meta.sceneImage) || keyOf(meta);
    if (String(node.type || "") === "prop") return keyOf(meta.propImage) || keyOf(meta);
    return keyOf(meta);
}

/**
 * runAssets 的幂等判据（可单测纯函数）：制作稿 draft 已有 storageKey，或画布实体节点上已有参考图，
 * 都算「已就绪」→ 跳过重出并计入 skipped（抵扣为正常成功）；只有两处都空才真正需要生成。
 */
export function assetHasReference(input: { draftStorageKey?: string; node?: Record<string, unknown> | null }): boolean {
    if (String(input.draftStorageKey || "").trim()) return true;
    return Boolean(assetEntityReferenceKey(input.node));
}

export type PromptShotRef = {
    /** 扁平化全局序号，LLM JSON 里的 index 用这个（不是 shotId、不是画布 clip.id）。 */
    index: number;
    /** 制作稿 shots[].id，派生 utterance.start.shotId 用这个。 */
    shotId: string;
    visual: string;
    title: string;
    camera: string;
    characters: string[];
};

const rowsOf = (value: unknown): Array<Record<string, any>> =>
    Array.isArray(value) ? value.filter(item => item && typeof item === "object") as Array<Record<string, any>> : [];
const textOf = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const listOf = (value: unknown): string[] => Array.isArray(value)
    ? value.map(textOf).filter(Boolean)
    : textOf(value).split(/[,，、;；|]/).map(item => item.trim()).filter(Boolean);

/** 去掉「巨蟒（妻）」这类括号后缀，避免别名污染说话人名。 */
const cleanName = (value: unknown): string => textOf(value).replace(/[（(][^）)]*[）)]/g, "").replace(/^[、,，\s]+|[、,，\s]+$/g, "");

/**
 * 归一比较键（抄影策 internal/production/timing.go NormalizeName）：
 * 小写 + 去首尾空白 + 去所有空格/标点/符号，使「妻，」「 妻 」「Narrator」归到同一稳定 key。
 */
export function normalizeName(value: unknown): string {
    return String(value ?? "").toLowerCase().trim().replace(/[\s\p{P}\p{S}]/gu, "");
}

const NARRATOR_KEYS = new Set(["旁白", "narrator", "画外音"]);

/** 旁白判定（抄影策 timing.go IsNarrator）：归一后命中 旁白/narrator/画外音。 */
export function isNarrator(speaker: unknown): boolean {
    return NARRATOR_KEYS.has(normalizeName(speaker));
}

/**
 * 角色别名索引（抄影策 timing.go CastIndex）：归一 key → 标准名，一个标准名可注册多个别名。
 *
 * 注册来源：names 里的标准名（原写法 + cleanName 去括号写法）优先占位；
 * 再叠加 character_registry[].aliases/alias、asset_cards、subject_registry 里的别名，
 * 全部指向同一标准名（若该标准名命中 names 则以 names 里的写法为准，保证 speaker 仍是已知角色）。
 * source 无 aliases 数据时，仅凭 names 也能把去括号写法与去空格标点写法归一到同一角色。
 */
export function buildCastIndex(source: Record<string, any> | undefined, names: string[]): Map<string, string> {
    const index = new Map<string, string>();
    const register = (key: unknown, canonical: string) => {
        const normalized = normalizeName(key);
        if (normalized && canonical && !index.has(normalized)) index.set(normalized, canonical);
    };
    // 标准名优先：names 先注册，别名不得覆盖。
    for (const name of names) {
        const canonical = cleanName(name) || textOf(name);
        if (!canonical) continue;
        register(name, canonical);        // 原写法（归一后）
        register(canonical, canonical);   // cleanName 去括号写法（归一后）
    }
    const canonicalInNames = (value: unknown): string => {
        const cleaned = cleanName(value);
        return names.find(name => cleanName(name) === cleaned) || cleaned;
    };
    for (const row of rowsOf(source?.character_registry)) {
        const canonical = canonicalInNames(row.name ?? row.characterName);
        if (!canonical) continue;
        register(canonical, canonical);
        for (const alias of listOf(row.aliases ?? row.alias)) register(alias, canonical);
    }
    for (const row of rowsOf(source?.asset_cards)) {
        const kind = textOf(row.asset_kind ?? row.kind);
        if (kind && kind !== "character") continue;
        const canonical = canonicalInNames(row.asset_name ?? row.name ?? row.character_name);
        if (!canonical) continue;
        register(canonical, canonical);
        for (const alias of listOf(row.aliases ?? row.alias)) register(alias, canonical);
    }
    for (const row of rowsOf(source?.subject_registry)) {
        const kind = textOf(row.kind);
        if (kind && kind !== "character") continue;
        const canonical = canonicalInNames(row.name);
        if (!canonical) continue;
        register(canonical, canonical);
        for (const alias of listOf(row.aliases ?? row.alias)) register(alias, canonical);
    }
    return index;
}

/**
 * 已知角色名真值优先级：character_registry → asset_cards(仅 character 类) → subject_registry(仅 character)，
 * 蟒妻这类注册表全空时，从 script_scenes 表头「场N｜场景｜时段｜崇良、妻｜动作」第4列兜底；
 * 最后用 shot.visual/title 只做「已知名字是否出现在该镜头」的匹配，不发明新名字。
 */
export function knownCharacterNames(source: Record<string, any>, shots: Array<Record<string, any>>): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (value: unknown) => {
        const name = cleanName(value);
        if (name && Array.from(name).length <= 12 && !seen.has(name)) { seen.add(name); names.push(name); }
    };
    for (const row of rowsOf(source?.character_registry)) {
        add(row.name); add(row.characterName);
        for (const alias of listOf(row.aliases ?? row.alias)) add(alias);
    }
    for (const row of rowsOf(source?.asset_cards)) {
        const kind = textOf(row.asset_kind ?? row.kind);
        if (kind && kind !== "character") continue;
        add(row.asset_name ?? row.name ?? row.character_name);
    }
    for (const row of rowsOf(source?.subject_registry)) {
        const kind = textOf(row.kind);
        if (kind && kind !== "character") continue;
        add(row.name);
    }
    for (const scene of rowsOf(source?.script_scenes)) {
        for (const line of textOf(scene.text).split(/\r?\n/)) {
            const cols = line.split("｜");
            if (cols.length < 4 || !/^场\s*\d+/.test(cols[0].trim())) continue;
            for (const part of cols[3].split(/[、,，/]/)) add(part);
        }
    }
    const allText = shots.map(shot => `${textOf(shot?.title)} ${textOf(shot?.visual)}`).join(" ");
    return names.filter(name => allText.includes(name));
}

/** 按 segments.shot_ids 顺序扁平化 shots，index 全局递增；缺失的 shotId 直接跳过（对白注入仍按 shotId）。 */
export function flattenPromptShots(
    segments: Array<Record<string, any>>,
    shotById: Map<string, Record<string, any>>,
    names: string[],
): PromptShotRef[] {
    const out: PromptShotRef[] = [];
    let index = 0;
    for (const segment of segments) {
        for (const rawId of Array.isArray(segment?.shot_ids) ? segment.shot_ids : []) {
            const shotId = String(rawId || "");
            const shot = shotById.get(shotId);
            if (!shot) continue;
            const visual = textOf(shot.visual);
            if (!visual) continue;
            const title = textOf(shot.title);
            const camera = textOf(shot?.camera?.description);
            out.push({
                index: index++, shotId, visual, title, camera,
                characters: names.filter(name => visual.includes(name) || title.includes(name)),
            });
        }
    }
    return out;
}

/** 补写 user prompt：素材稿只喂 shots[].visual/title/camera + 已知角色名，输出严格 JSON。 */
export function buildDialogueUserPrompt(shots: PromptShotRef[], names: string[]): string {
    return [
        "镜头素材稿（index 是唯一编号；无角色互动或纯环境镜头不要输出该 index）：",
        ...shots.map(shot => `#${shot.index}｜${shot.title || "镜头"}｜出场：${shot.characters.join("、") || "无已知角色"}｜画面：${shot.visual}${shot.camera ? `｜运镜：${shot.camera}` : ""}`),
        `可用角色（speaker 只能用这里的名字）：${names.join("、")}`,
        "严格输出 JSON，不要任何解释或代码块：{\"shots\":[{\"index\":0,\"speaker\":\"崇良\",\"text\":\"...\"}]}",
        "每个 index 最多一条；text 为空或无台词的镜头不要出现在 shots 数组里。",
    ].join("\n");
}

/**
 * 解析补写回包 → 内存 utterances（形如 { start: { shotId }, speaker, text }，与现有 find 兼容）。
 * 容错：```json 围栏 / 前后闲聊 / 字段缺失 / index 越界 / speaker 未登记 / 单句超20字 / 多于2句，均逐条过滤。
 * 结构性失败（无 JSON、无 shots、解析异常）抛错，由调用方 warn 降级。
 */
export function parseDerivedUtterances(
    raw: string,
    shots: PromptShotRef[],
    names: string[],
    castSource?: Record<string, any>,
): Array<Record<string, any>> {
    const source = String(raw || "");
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : source;
    const begin = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (begin < 0 || end <= begin) throw new Error("DIALOGUE_JSON_MISSING");
    const parsed = JSON.parse(body.slice(begin, end + 1)) as Record<string, any>;
    const rows: Array<Record<string, any>> = Array.isArray(parsed?.shots) ? parsed.shots : [];
    if (!rows.length) throw new Error("DIALOGUE_JSON_EMPTY");
    const byIndex = new Map(shots.map(shot => [shot.index, shot]));
    const castIndex = buildCastIndex(castSource, names);
    const canonical = (value: string): string => {
        // 旁白 speaker 保留，不当作未登记角色丢弃（影策 IsNarrator）。
        if (isNarrator(value)) return "旁白";
        // 影策 CastIndex：归一 key 精确查表，命中即返回标准名。
        const byKey = castIndex.get(normalizeName(value));
        if (byKey) return byKey;
        // 降级：原精确 + 包含匹配，保留对旧行为的兼容。
        const exact = names.find(name => name === value);
        if (exact) return exact;
        return names.find(name => name.length >= 1 && (value.includes(name) || name.includes(value))) || "";
    };
    const out: Array<Record<string, any>> = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const ref = byIndex.get(Number(row?.index));
        if (!ref || seen.has(ref.shotId)) continue;
        const speaker = canonical(textOf(row?.speaker));
        if (!speaker) continue;
        const sentences = textOf(row?.text)
            .split(/[。！？!?；;]/).map(item => item.trim()).filter(Boolean).slice(0, 2)
            .filter(item => Array.from(item).length <= 20);
        if (!sentences.length) continue;
        seen.add(ref.shotId);
        out.push({ start: { shotId: ref.shotId }, speaker, text: sentences.join("。") + "。" });
    }
    return out;
}

/** 段无真参考图绑定时清除模型编造的「参考图N / 参考图1-5 / 参考图编号」。 */
export function sanitizeNoReferencePrompt(text: string): string {
    return String(text || "")
        .replace(/（[^）]{0,16}参考图[^）]{0,16}）/g, "")
        .replace(/@?参考图\s*\d+(?:\s*[-~—至到、,，]\s*\d+)*/g, "已设定的角色形象")
        .replace(/参考图编号/g, "已设定的角色形象")
        .replace(/以参考图为准/g, "以已设定的角色形象为准")
        .replace(/参考图/g, "已设定的角色形象");
}

// ── 闸门（纯函数，对齐影策 sample/media/approve 三闸门） ───────────────────

/**
 * sample 模式跨集闸门（对齐影策 drama_orchestrator.go:631 `sampleBlocked`）：
 * reviewMode=sample 且样片（第1集）尚未批准时，阻断所有非第1集；第1集自身放行。
 * auto / every 不走这条跨集闸门。
 */
export function sampleBlocked(reviewMode: string, episodeNumber: number, sampleApproved: boolean): boolean {
    return reviewMode === "sample" && !sampleApproved && episodeNumber !== 1;
}

/** media 模式非 auto 且未放行目标（assets/all/某集）时挡住对应作业。 */
export function mediaHeld(mediaMode: string, released: Set<string>, target: string): boolean {
    if (mediaMode === "auto") return false;
    return !released.has("all") && !released.has(target);
}

/**
 * 某集的 video 作业是否需要人工 approve 才放行。对齐影策两条闸门：
 * - sample（跨集闸门）：第1集=样片必须 approve；非第1集在样片批准前一律阻断，批准后放行；
 * - every（逐集闸门）：每集都要 approve；
 * - auto：全放行。
 * sampleMode 是逐剧目运行期开关（等价于启用样片模式），与 reviewMode=sample 取并集。
 * "all" 是全集放行哨兵。
 */
export function needsReview(
    reviewMode: string,
    episodeNumber: number,
    approved: Set<string>,
    episodeId: string,
    sampleMode = false,
    sampleApproved = false,
): boolean {
    if (approved.has("all")) return false;
    if (sampleMode || reviewMode === "sample") {
        if (episodeNumber === 1) return !approved.has(episodeId);
        return sampleBlocked("sample", episodeNumber, sampleApproved);
    }
    if (reviewMode === "auto") return false;
    if (reviewMode === "every") return !approved.has(episodeId);
    return false;
}

// ── 预算上限（budgetMicrocredits）────────────────────────────────────────

/**
 * 生成步骤缺省单价（微积分）。本仓没有模型计价/用量回传接口：影策的
 * unitPriceMicrocredits 只存在于外部渠道配置，画布 generation task 也不回传 usage。
 * 因此在关键生成步骤后按此表做保守估算累计；task 真带 usage 时以真值为准（见下）。
 */
export const DEFAULT_STEP_COST_MICROCREDITS: Record<"text" | "image" | "video", number> = {
    text: 150,
    image: 1000,
    video: 5000,
};

/** 从生成任务回包提取真实花费（微积分）；没有可信字段时回退估算值。 */
export function taskCostMicrocredits(task: Record<string, any> | undefined, fallbackMicrocredits: number): number {
    const candidates: unknown[] = [
        task?.usage?.costMicrocredits, task?.usage?.microcredits,
        task?.usageResponse?.costMicrocredits, task?.usageResponse?.microcredits,
        task?.result?.usage?.costMicrocredits, task?.result?.usage?.microcredits,
        task?.result?.usageResponse?.costMicrocredits,
    ];
    for (const value of candidates) {
        if (value === undefined || value === null || value === "") continue;
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return fallbackMicrocredits;
}

/** 累计花费是否达到预算上限（0/未设/非法值=不限）。 */
export function budgetReached(spentMicrocredits: number, limitMicrocredits: number | undefined): boolean {
    const limit = Number(limitMicrocredits ?? 0);
    const spent = Number(spentMicrocredits ?? 0);
    return Number.isFinite(limit) && limit > 0 && Number.isFinite(spent) && spent >= limit;
}

// ── 编排器 ───────────────────────────────────────────────────────────────

/** 一次暂停的可观测结果（GET /pipeline/status 的 pause.lastResult 原样返回）。 */
export type DramaPipelinePauseReport = {
    reason: string;
    at: string;
    /** 被退回 queued 的在跑流水线作业数。 */
    pausedJobs: number;
    /** 本次成功请求取消的画布任务数（含队列里的）。 */
    canceledTasks: number;
    /** 其中原本处于 queued 的画布任务数。 */
    canceledQueuedTasks: number;
    /** 已在取消前到达终态、无需再取消的任务数。 */
    alreadyTerminal: number;
    /** 取消失败数；失败明细见 failures。 */
    failedTasks: number;
    failures: Array<{ taskId: string; error: string }>;
    /** 取消预算耗尽提前结束时为 true（剩余任务仍在跑，只能等它跑完）。 */
    truncated: boolean;
};

export type DramaPipelineOptions = {
    store: PipelineStore;
    token: string;
    baseUrl?: string;
    /** 文本模型解析（从后端 ai.config 读），generateText 每次调用时取最新值。 */
    resolveTextModel?: () => string;
    /** 资产参考图默认模型解析（ai.config.imageModel）；制作设置 imageModelsByKind 可逐类型覆盖。 */
    resolveImageModel?: () => string;
    /** C5：按视频模型读取提示词字数上限真值（ai.config 登记的 promptMaxChars）；无登记返回 undefined=不限制。 */
    resolveVideoPromptMaxChars?: (modelValue: string) => number | undefined;
    /** 全局并发上限（默认 16）。 */
    poolLimit?: number;
    /** 全局并发上限（默认 16）。 */
    globalLimit?: number;
    /** 运行期设置持久化（runtime_settings）：重载后能恢复上次下发的制作设置。 */
    settings?: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
};

/** 写作技能引用（对齐前端 SkillRef；content/instruction 允许前端预解析后直传，免后端再查技能库）。 */
export type DramaPipelineTextSkill = {
    name: string;
    title?: string;
    path?: string;
    content?: string;
    instruction?: string;
};

/** 制作设置按剧目下发的运行期选项（与影策制作台设置页一一对应；不落 pipeline SQLite，重启后需重新下发）。 */
export type DramaPipelineRuntimeOptions = {
    /** 文字步骤模型（拆镜/提取/提示词），覆盖后端全局文本模型。 */
    storyboardModel?: string;
    assetExtractModel?: string;
    videoPromptModel?: string;
    /** 每步思考等级，写进 /canvas/generation 的 params.reasoningEffort。 */
    textThinking?: { plan?: string; storyboard?: string; extract?: string; prompt?: string };
    /** 影策 PromptRules：表演强度 1-10（前端设置项原名 performanceIntensity 兼容别名）。runPrompts 映射成 5 档文字注入 style。 */
    performance?: number;
    performanceIntensity?: number;
    /** 影策 PromptRules：运镜动感 1-10。runPrompts 映射成 5 档文字注入 cameraMotion。 */
    cameraDynamics?: number;
    /** 开篇钩子/结尾悬念：透传给 script-proposal 作为创作方向（手动改编同源）。 */
    hook?: string;
    cliffhanger?: string;
    /** 写作技能引用：拆镜(storyboard)/提示词(prompt) 步骤真实注入方法要点。 */
    textSkills?: { extract?: DramaPipelineTextSkill | null; storyboard?: DramaPipelineTextSkill | null; prompt?: DramaPipelineTextSkill | null };
    /** 分集规划/剧本提案模型（影策 planModel）：透传给 script-proposal 的 model。 */
    planModel?: string;
    /** 参考图分辨率档位（影策 imageResolution）：1k/2k/4k，dispatcher 换算成像素 size。 */
    imageResolution?: "1k" | "2k" | "4k";
    /** 剧目级段视频分辨率档位（影策 videoResolution）：480p/720p/1080p，短边像素；空串=跟随模型默认。真实写进 H3 段 aspectRatio+megapixels。 */
    videoResolution?: DramaVideoResolutionTier | "";
    /** 剧目级画幅（影策 final-view aspectRatioValue）：16:9 横屏 / 9:16 竖屏，与 videoResolution 联动。 */
    videoAspectRatio?: DramaVideoAspectRatio;
    /** 样片模式（影策 sampleMode）：第 1 集视频阶段需人工 approve 才继续。 */
    sampleMode?: boolean;
    /** 预算上限（影策 budgetMicrocredits，微积分）：0/不设=不限；累计生成花费达限自动暂停流水线。 */
    budgetMicrocredits?: number;
    /** 段视频自选模型（写进 H3 节点 params.selectedVideoModel）。 */
    videoModel?: string;
    /** 参考图模型按资产类型写入各集 production.settings.imageModelsByKind。 */
    imageModelsByKind?: { character?: string; scene?: string; prop?: string };
    /** 每段最多参考图上限（H3 契约硬上限内收窄，0=不限制）。 */
    referenceLimit?: number;
    /** 并行出片：各段独立、不带尾帧首帧。 */
    independent?: boolean;
    /** 分镜规则（软约束并入拆镜/提示词 prompt）。 */
    storyboardRules?: {
        episodeSeconds?: number;
        segmentMode?: "auto" | "fixed" | "range";
        segmentRange?: { min: number; max: number };
        dialogueDensity?: string;
        transitionMode?: string;
        transitionMs?: number;
        pacing?: string;
    };
    /** 影策单值并发：text/image/video/render 四池各自按它独立计数（1-16）。 */
    concurrency?: number;
    /** 参考图提示词模板（角色/场景/道具/默认）；空表示沿用内置方案模板。 */
    assetPromptTemplates?: AssetPromptTemplates;
};

export type DramaPipelineStartOpts = {
    reviewMode: "auto" | "sample" | "every";
    mediaMode: "auto" | "manual";
    /** 制作设置：可选的逐剧目运行期覆盖。 */
    options?: DramaPipelineRuntimeOptions;
};

/** runPrompts 可选项：forceRewrite=true 时忽略画布已有 prompt，强制重写每一段。
 *  onlyIndexes 限定只写指定段（0 起，对齐影策 RequestDramaSegmentPrompts 的选段能力）——
 *  整集重写是同步长任务，44 段会因 HTTP 空闲连接超时只写前几段；选段可分批断点续跑。 */
export interface RunPromptsOptions { forceRewrite?: boolean; onlyIndexes?: number[] }

/**
 * 判断一段 prompt 是否已是 H3 六段式。旧制作台遗留模板以「第N段视频《…》」开头、
 * 含「【视觉与首帧】」和 9:16；H3 六段式含 subject_definitions / detailed_description 等标记。
 * 非 forceRewrite 时只有 H3 格式才跳过，避免旧格式段被永久跳过、混在交付里。
 */
function isH3Prompt(text: string): boolean {
    const p = String(text || "");
    return /subject_definitions\s*:/.test(p) && /summary\s*:/.test(p) && /detailed_description\s*:/.test(p);
}

export class DramaPipeline {
    private readonly store: PipelineStore;
    private readonly token: string;
    private readonly baseUrl: string;
    private readonly poolLimit: number;
    private readonly globalLimit: number;
    private readonly resolveTextModel?: () => string;
    private readonly resolveImageModel?: () => string;
    private readonly resolveVideoPromptMaxChars?: (modelValue: string) => number | undefined;
    /** 运行期设置持久化（runtime_settings）；没有则只在内存里保留。 */
    private readonly settingsStore?: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };

    private timer: ReturnType<typeof setInterval> | null = null;
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly leases = new Map<string, number>();
    /** 每 tick 的即时唤醒去重。 */
    private ticking = false;

    private readonly poolRunning: Record<PoolName, number> = { text: 0, image: 0, video: 0, render: 0 };
    private active = 0;

    /** `${dramaId}::${episodeId}` / `all` 的人工放行集合。 */
    private readonly approvals = new Map<string, Set<string>>();
    /** dramaId → 已放行的 media target 集合（assets / all / episodeId）。 */
    private readonly releasedMedia = new Map<string, Set<string>>();
    /** dramaId → 制作设置下发的运行期选项（模型/思考等级/视频模型/并发等）。 */
    private readonly runOptions = new Map<string, DramaPipelineRuntimeOptions>();
    /** 失败退避：jobId → 最早可再次领取的时间戳。 */
    private readonly retryAt = new Map<string, number>();
    /** 显式重写提示词的剧目豁免集合：重写期间允许绕过暂停闸门，但不改变流水线 status，
     *  避免制造「pause_reason=manual 但 status=running」的分裂状态（界面显示暂停却仍在派发出片）。 */
    private readonly promptRewriteBypass = new Set<string>();
    /** 上次成功对账持久化 reviewApproval 的时间戳（dramaId → ts）；失败会清掉以便下一 tick 重试。 */
    private readonly reviewReconcileAt = new Map<string, number>();
    /** dramaId → 本剧目累计生成花费（微积分）/预算是否已耗尽（内存计数，重启或重新 start 归零）。 */
    private readonly budgetState = new Map<string, { spent: number; exceeded: boolean }>();
    /** dramaId → 暂停原因：调度与在跑作业的即时哨兵（DB status 仍是权威，这里让暂停在下一个循环点生效）。 */
    private readonly paused = new Map<string, string>();
    /** dramaId → 最近一次暂停结果摘要（供 status 可观测；重启后由 pipeline.pause_reason 顶替）。 */
    private readonly pauseReports = new Map<string, DramaPipelinePauseReport>();
    /** jobId → 当前这次执行的令牌：暂停后退回队列又被 resume 重新领取时，旧执行的迟到结果不得结算新作业。 */
    private readonly runTokens = new Map<string, string>();

    constructor(options: DramaPipelineOptions) {
        this.store = options.store;
        this.token = options.token;
        this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
        this.poolLimit = Math.max(1, options.poolLimit ?? DEFAULT_POOL_LIMIT);
        this.globalLimit = Math.max(this.poolLimit, options.globalLimit ?? DEFAULT_GLOBAL_LIMIT);
        this.resolveTextModel = options.resolveTextModel;
        this.resolveImageModel = options.resolveImageModel;
        this.resolveVideoPromptMaxChars = options.resolveVideoPromptMaxChars;
        this.settingsStore = options.settings;
        // 进程启动时把 DB 里已持久化的闸门放行记录恢复到内存镜像（单一进程，重启即重建）。
        this.hydrateGatesFromStore();
    }

    /** 从持久化表恢复 approve/release 内存镜像；持久化表始终是闸门真值。 */
    private hydrateGatesFromStore(): void {
        for (const pipeline of this.store.all()) {
            const approved = this.store.approvalTargets(pipeline.drama_id, "approve");
            if (approved.length) this.approvals.set(pipeline.drama_id, new Set(approved));
            const released = this.store.approvalTargets(pipeline.drama_id, "release");
            if (released.length) this.releasedMedia.set(pipeline.drama_id, new Set(released));
        }
    }

    // ── 生命周期 ────────────────────────────────────────────────────────

    /**
     * 确保剧目 topic（theme/logline）已填——create_manual_director_asset 建档要求，
     * topic 空会让 assets 段全部卡 queued。基于剧目真实 outline/name 补一个兜底主题，
     * 不造假数据：theme 取剧名，logline 取大纲首句。
     */
    private async ensureTopic(dramaId: string): Promise<void> {
        try {
            const info = await this.request("GET", `/drama/${encodeURIComponent(dramaId)}/planning`);
            const topic = (info?.topic || {}) as Record<string, any>;
            const name = String(info?.name || dramaId || "短剧");
            const outline = String(info?.outline || "").trim();
            const firstLine = outline.split(/[\n。！？；]/).map(s => s.trim()).find(Boolean) || name;
            const patch: Record<string, unknown> = {};
            if (!String(topic.theme || "").trim()) patch.theme = name;
            if (!Array.isArray(topic.themes) || !topic.themes.length) patch.themes = [name];
            if (!String(topic.logline || "").trim()) patch.logline = firstLine.slice(0, 200);
            if (Object.keys(patch).length) {
                await this.request("PATCH", `/drama/${encodeURIComponent(dramaId)}/planning`, { topic: patch });
                this.store.log(dramaId, "自动补齐剧目 topic（theme/logline），资产建档前置条件已就绪");
            }
        } catch (error) {
            this.store.log(dramaId, `补齐 topic 失败（不阻断）：${errText(error)}`, "warn");
        }
    }

    /** 读取某剧目制作设置；不存在时返回空对象（各消费点自行回退默认）。 */
    optionsOf(dramaId: string): DramaPipelineRuntimeOptions {
        const memory = this.runOptions.get(dramaId);
        if (memory) return memory;
        // 重启后从 runtime_settings 恢复上次下发的制作设置（没有就返回空对象，各消费点自带默认）。
        try {
            const raw = this.settingsStore?.get(`drama.pipeline.options.${dramaId}`);
            if (raw && typeof raw === "object") {
                const restored = raw as DramaPipelineRuntimeOptions;
                this.runOptions.set(dramaId, restored);
                return restored;
            }
        } catch { /* 读取失败按无设置处理，不阻断调度 */ }
        return {};
    }

    /** 本剧目预算上限（0/不设/非法=不限）。 */
    private budgetLimitOf(dramaId: string): number {
        const raw = Number(this.optionsOf(dramaId).budgetMicrocredits ?? 0);
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
    }

    /** 预算是否已耗尽：与 needsReview 闸门同一层，供调度器与 resume 读取。 */
    private budgetHeld(dramaId: string): boolean {
        return this.budgetState.get(dramaId)?.exceeded === true;
    }

    /** 本剧目预算快照（供 status 可观测；不落库，随进程重启/重新 start 归零）。 */
    budgetOf(dramaId: string): { limitMicrocredits: number; spentMicrocredits: number; exceeded: boolean } {
        return {
            limitMicrocredits: this.budgetLimitOf(dramaId),
            spentMicrocredits: this.budgetState.get(dramaId)?.spent || 0,
            exceeded: this.budgetHeld(dramaId),
        };
    }

    /**
     * 关键生成步骤完成后计费：优先用任务回包的真实 usage，否则按步骤估算累加。
     * 达限即暂停整条流水线（复用 sampleMode 的暂停语义）+ 记日志；后续 job 由 jobAllowed 拦住。
     */
    chargeGeneration(dramaId: string, kind: "text" | "image" | "video", task?: Record<string, any>): { spentMicrocredits: number; limitMicrocredits: number; exceeded: boolean } {
        if (!dramaId) return this.budgetOf(dramaId);
        const limit = this.budgetLimitOf(dramaId);
        const state = this.budgetState.get(dramaId) || { spent: 0, exceeded: false };
        const cost = taskCostMicrocredits(task, DEFAULT_STEP_COST_MICROCREDITS[kind]);
        state.spent = Math.round((state.spent + cost) * 1000) / 1000; // 抑制浮点漂移
        this.budgetState.set(dramaId, state);
        if (!state.exceeded && budgetReached(state.spent, limit)) {
            state.exceeded = true;
            this.store.log(dramaId, `预算耗尽：${kind} 步骤 +${cost} 微积分后累计 ${state.spent}/${limit}，流水线自动暂停（budgetMicrocredits）`, "warn");
            // 预算暂停同样要停掉在跑的产出（不再只是停派发）；失败只记日志，不阻断本次计费返回。
            void this.pause(dramaId, `budget_exceeded:${state.spent}/${limit}`)
                .catch((error) => this.store.log(dramaId, `预算暂停控制失败：${errText(error)}`, "error"));
        }
        return this.budgetOf(dramaId);
    }

    /**
     * textSkills 槽位 → SegmentWriterInput 的 skillName/skillPath/skillContent。
     * 优先用前端预解析的 content/instruction；只有 name 时经 /api/skill-market/detail 读 SKILL.md。
     * 技能加载失败只记日志不阻断流水线（技能是增强，不是生成前置条件）。
     */
    /**
     * 槽位技能解析：槽位为空时回退技能市场真实 slug（plan→drama-01-outline、
     * extract→drama-02-character、storyboard→drama-05-board、prompt→drama-06-h3-prompt）。
     * 旧的 acheng/* 名字带斜杠，服务端 NAME_PATTERN 只收小写字母/数字/短横线，
     * 每次都 400 加载失败；catalog 中也没有对应 slug，必须改用真实存在的技能。
     * structured 用 silent 会话时 Hermes 不会自动加载技能，必须在这里把技能正文拼进提示词。
     */
    private async resolveSlotSkill(ref: DramaPipelineTextSkill | null | undefined, slot: "plan" | "extract" | "storyboard" | "prompt", dramaId: string): Promise<{ skillName?: string; skillPath?: string; skillContent?: string }> {
        const fallback: Record<typeof slot, string> = { plan: "drama-01-outline", extract: "drama-02-character", storyboard: "drama-05-board", prompt: "drama-06-h3-prompt" };
        const picked = ref?.name ? ref : { name: fallback[slot] };
        return this.resolveTextSkill(picked, dramaId);
    }

    private async resolveTextSkill(ref: DramaPipelineTextSkill | null | undefined, dramaId: string): Promise<{ skillName?: string; skillPath?: string; skillContent?: string }> {
        if (!ref) return {};
        const skillName = String(ref.title || ref.name || "").trim() || undefined;
        const skillPath = String(ref.path || "").trim() || undefined;
        let raw = String(ref.content || ref.instruction || "").trim();
        if (!raw && ref.name) {
            try {
                const detail = await this.request("GET", `/api/skill-market/detail?name=${encodeURIComponent(ref.name)}`);
                raw = String(detail?.data?.content || "").trim();
            } catch (error) {
                this.store.log(dramaId, `写作技能「${ref.name}」加载失败，本次按内置格式撰写（不阻断）：${errText(error)}`, "warn");
            }
        }
        return {
            ...(skillName ? { skillName } : {}),
            ...(skillPath ? { skillPath } : {}),
            ...(raw ? { skillContent: skillInstructionFromMarkdown(raw, skillName || ref.name) } : {}),
        };
    }

    /**
     * 某剧目某池的并发上限：影策 DramaSettings.Concurrency 是单值，四池各自独立计数。
     * 兼容已持久化的旧三值设置（按池取旧值），新设置直接按单值取；越界回退构造期默认。
     */
    private poolLimitOf(dramaId: string, pool: PoolName): number {
        const raw = this.optionsOf(dramaId).concurrency as unknown;
        const configured = raw && typeof raw === "object"
            ? Number((raw as Record<string, unknown>)[pool] || 0)
            : Number(raw || 0);
        if (configured >= 1 && configured <= 16) return configured;
        return this.poolLimit;
    }

    /**
     * C4 开工模型门禁（对齐影策 createTaskWith 的 choice.Empty() →「没有可用的X模型」）：
     * 开工/恢复前先检文本与图片模型真值，缺哪个就拒绝开工并点名，而不是入队后跑到一半才失败。
     * 真值源：resolveTextModel（ai.config 文本模型）/ resolveImageModel（ai.config.imageModel）
     * 以及逐剧目下发的 imageModelsByKind。video 模型走 H3 节点自选、由出片作业自己校验，不在此强卡。
     */
    private assertModelsReady(dramaId: string): void {
        const missing: string[] = [];
        const text = String(this.resolveTextModel?.() || "").trim();
        if (!text) missing.push("文本（script/prompts 拆镜与提示词作业需要）");
        const opts = this.optionsOf(dramaId);
        const imageByKind = opts.imageModelsByKind || {};
        const imageOverrides = [imageByKind.character, imageByKind.scene, imageByKind.prop]
            .map(v => String(v || "").trim()).filter(Boolean);
        const imageDefault = String(this.resolveImageModel?.() || "").trim();
        if (!imageDefault && imageOverrides.length === 0) missing.push("图片（assets 参考图作业需要）");
        if (missing.length) {
            throw new Error(`PIPELINE_MODEL_MISSING: 缺少可用模型，已拒绝开工：${missing.join("；")}。请在设置里配置后重试`);
        }
    }

    async start(dramaId: string, opts: DramaPipelineStartOpts): Promise<Record<string, unknown>> {
        await this.ensureTopic(dramaId);
        // 新一轮 start 是显式开工：清掉暂停哨兵与上次暂停摘要，否则内存里的 paused 会让调度一直停摆。
        this.paused.delete(dramaId);
        this.pauseReports.delete(dramaId);
        if (opts?.options) {
            this.runOptions.set(dramaId, opts.options);
            // 落 runtime_settings：开发重载/重启后 optionsOf 能把制作设置恢复回来。
            try { this.settingsStore?.set(`drama.pipeline.options.${dramaId}`, opts.options); } catch { /* 持久化失败不影响本次运行 */ }
        }
        // 预算是本次运行期的累计计数：重新 start 即新一轮，归零后按下发的 budgetMicrocredits 重新计。
        this.budgetState.set(dramaId, { spent: 0, exceeded: false });
        if (this.budgetLimitOf(dramaId) > 0) this.store.log(dramaId, `预算上限已下发：${this.budgetLimitOf(dramaId)} 微积分（0/不设=不限）`);
        this.assertModelsReady(dramaId); // C4：缺模型能力拒绝开工（入队前；此时 runOptions 已下发）
        const row = this.store.upsert({
            dramaId,
            status: "running",
            reviewMode: opts?.reviewMode || "auto",
            mediaMode: opts?.mediaMode || "auto",
        });
        this.store.log(dramaId, `流水线启动 review=${opts?.reviewMode || "auto"} media=${opts?.mediaMode || "auto"}${opts?.options ? ` · 制作设置已下发(${Object.keys(opts.options).length}项)` : ""}`);
        // 参考图模型按资产类型批量写入各集制作稿（真实落点：canvas-inputs.ts 按 imageModelsByKind 取模型）。
        // 不阻塞 start 返回：后台逐集 CAS 写入，失败只记日志。
        if (opts?.options?.imageModelsByKind && Object.keys(opts.options.imageModelsByKind).length) {
            void this.applyImageModels(dramaId, opts.options.imageModelsByKind);
        }
        try {
            await this.plan(dramaId);
        } catch (error) {
            this.store.log(dramaId, `首次编排失败：${errText(error)}`, "warn");
        }
        this.wake(dramaId);
        return { dramaId, status: row.status, reviewMode: row.review_mode, mediaMode: row.media_mode, queued: this.store.listJobs(dramaId, ["queued"]).length };
    }

    startLoop(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
        this.wake();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
        this.leases.clear();
    }

    /** 立即唤醒（清掉该剧目的 lease，让下一个 tick 真的跑）；不传 dramaId 则唤醒全部。 */
    wake(dramaId?: string): void {
        if (dramaId) this.leases.delete(dramaId);
        else this.leases.clear();
        if (this.wakeTimer) clearTimeout(this.wakeTimer);
        this.wakeTimer = setTimeout(() => { void this.tick(); }, 0);
    }

    // ── 调度循环 ────────────────────────────────────────────────────────

    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = Date.now();
            for (const pipeline of this.store.running()) {
                // 持久化 reviewApproval → 审批闸门的对账（限速；HTTP 未就绪时下一 tick 重试）。
                void this.reconcileReviewApprovals(pipeline.drama_id);
                const last = this.leases.get(pipeline.drama_id) || 0;
                if (now - last < LEASE_TTL_MS) continue;
                this.leases.set(pipeline.drama_id, now);
                try {
                    const recovered = this.store.recoverStaleRunning(pipeline.drama_id, STALE_JOB_TTL_MS);
                    if (recovered) this.store.log(pipeline.drama_id, `回收 ${recovered} 个超时作业重新排队`, "warn");
                    await this.plan(pipeline.drama_id, pipeline);
                    this.dispatch(pipeline);
                    this.store.touch(pipeline.drama_id);
                } catch (error) {
                    this.store.log(pipeline.drama_id, `tick 失败：${errText(error)}`, "error");
                }
            }
        } finally {
            this.ticking = false;
        }
    }

    /**
     * 幂等编排（影策 planEpisode 的 stage 分支）：只为已经到达的阶段入队作业。
     * 影策 render 作业在 stage=render 时才 enqueue，video 作业在 stage=video 时才提交；
     * 不能一开始就把全部阶段塞进队列，否则成片作业会一直挂着「等待上游」。
     */
    async plan(dramaId: string, pipeline?: PipelineRow): Promise<void> {
        const row = pipeline || this.store.get(dramaId);
        if (!row || row.status !== "running") return;

        // 阶段信号：HTTP 派生 stage API 仅用于日志/可观测，入队真值以 PipelineStore job 成功记录为准
        // （store.enqueue 用 dedupe_key 去重，天然幂等，重跑不会堆重复作业）。
        try {
            const stage = await this.request("GET", `/drama/${encodeURIComponent(dramaId)}/stage`);
            const states = stage?.states;
            if (states) this.store.log(dramaId, `阶段信号：${JSON.stringify(states).slice(0, 400)}`);
        } catch {
            // stage API 失败不阻断编排。
        }

        const listing = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
        const episodes: Array<Record<string, any>> = Array.isArray(listing?.episodes) ? listing.episodes : [];
        const jobs = this.store.listJobs(dramaId);
        const queuedKeys = new Set(jobs.map((job) => job.dedupe_key));
        const succeededByEpisode = new Map<string, Set<string>>();
        for (const job of jobs) {
            if (job.status !== "succeeded") continue;
            const key = String(job.episode_id || "");
            const set = succeededByEpisode.get(key) || new Set<string>();
            set.add(job.stage);
            succeededByEpisode.set(key, set);
        }
        for (const ep of episodes) {
            const episodeId = String(ep?.id || "");
            if (!episodeId) continue;
            const succeeded = succeededByEpisode.get(episodeId) || new Set<string>();
            for (const { stage: stageName, kind } of STAGE_JOBS) {
                const dedupeKey = `${dramaId}:${episodeId}:${stageName}`;
                if (queuedKeys.has(dedupeKey)) continue;
                // 只有上游阶段已成功才入队本阶段（影策 stage 推进），没到就不制造排队作业。
                if (!(STAGE_REQUIRES[stageName] || []).every((required) => succeeded.has(required))) continue;
                this.store.enqueue({
                    id: dedupeKey,
                    dramaId,
                    episodeId,
                    kind,
                    stage: stageName,
                    // priority 越大越先领取（listJobs/claim 均按 priority DESC）：script 最优先、render 最后。
                    priority: STAGE_JOBS.length - 1 - STAGE_JOBS.findIndex(item => item.stage === stageName),
                    dedupeKey,
                    label: `第${Number(ep.episodeNumber || 0) || "?"}集 · ${stageName}`,
                    payload: { episodeId, episodeNumber: Number(ep.episodeNumber || 0) },
                });
            }
        }
    }

    /** 按 4 池并发上限领取并执行 job；严格保序 + 闸门 + 退避。 */
    private dispatch(pipeline: PipelineRow): void {
        const dramaId = pipeline.drama_id;
        // 暂停即停止派发：pause() 先落内存哨兵，再落 DB；两者任一为 paused 都不再领取新作业。
        if (this.isPaused(dramaId) || this.store.get(dramaId)?.status !== "running") return;
        // 闸门真值从持久化表读回（而非仅内存），确保重启后 / 多实例写回都能被调度器看到。
        const approvals = new Set(this.store.approvalTargets(dramaId, "approve"));
        const released = new Set(this.store.approvalTargets(dramaId, "release"));

        for (let loops = 0; loops < MAX_JOBS_PER_TICK; loops += 1) {
            if (this.active >= this.globalLimit) break;
            const queued = this.store.listJobs(dramaId, ["queued"]);
            const next = queued.find(item => this.jobAllowed(pipeline, item, approvals, released)
                && Boolean(POOL_OF_KIND[item.kind as JobKind])
                && this.poolRunning[POOL_OF_KIND[item.kind as JobKind]] < this.poolLimitOf(dramaId, POOL_OF_KIND[item.kind as JobKind]));
            if (!next) break;

            const pool = POOL_OF_KIND[next.kind as JobKind] || "text";

            const job = this.store.claimById(next.id);
            if (!job) break;
            this.launchJob(pipeline, job);
        }
    }

    private jobAllowed(pipeline: PipelineRow, job: JobRow, approvals: Set<string>, released: Set<string>): boolean {
        // 预算闸门：达限后不再放行任何新作业（与 sampleMode 审批闸门同层）。
        if (this.budgetHeld(pipeline.drama_id)) return false;
        const retryAt = this.retryAt.get(job.id) || 0;
        if (Date.now() < retryAt) return false;

        const payload = this.store.jobPayload(job);
        const episodeId = String(payload.episodeId || job.episode_id || "");
        const episodeNumber = Number(payload.episodeNumber || 0);

        // 前置阶段必须全部 succeeded（auto 只跳过审批闸门，不跳过真实作业）。
        for (const required of STAGE_REQUIRES[job.stage] || []) {
            const upstream = this.store.listJobs(pipeline.drama_id, ["succeeded"])
                .find(item => item.episode_id === episodeId && item.stage === required);
            if (!upstream) return false;
        }

        // 审批闸门：video 需要 approve；assets 受 media 闸门；render 受 media 闸门。
        const sampleMode = Boolean(this.optionsOf(pipeline.drama_id).sampleMode);
        const sampleApproved = this.isSampleApproved(pipeline.drama_id, approvals);
        if (job.stage === "video" && needsReview(pipeline.review_mode, episodeNumber, approvals, episodeId, sampleMode, sampleApproved)) return false;
        if (job.stage === "assets" && mediaHeld(pipeline.media_mode, released, "assets")) return false;
        if (job.stage === "render" && mediaHeld(pipeline.media_mode, released, "all")) return false;
        return true;
    }

    /** 执行一条 job（异步），统一计数 / succeed / log / fail + 退避重试。 */
    private launchJob(pipeline: PipelineRow, job: JobRow): void {
        const pool = POOL_OF_KIND[job.kind as JobKind] || "text";
        this.poolRunning[pool] += 1;
        this.active += 1;
        // 绝对硬上限兜底：无论 retryFailed/rescript/外部 requeue 怎么把作业重新激活，
        // 只要 attempt 已到红线就不再执行，直接置终态 failed，杜绝「越界重试死循环」
        // （曾出现 video attempt 跑到 11、assets 跑到 13，卡住流水线 15 小时）。
        if (job.attempt > MAX_ATTEMPTS_HARD) {
            this.store.fail(job.id, `ATTEMPT_LIMIT_EXCEEDED: ${job.stage}/${job.kind} attempt=${job.attempt} 超过硬上限 ${MAX_ATTEMPTS_HARD}`);
            this.store.log(pipeline.drama_id, `作业超过硬上限，强制终态 ${job.stage}/${job.kind} (${job.id}) attempt=${job.attempt}`, "error", job.episode_id, job.id);
            this.poolRunning[pool] = Math.max(0, this.poolRunning[pool] - 1);
            this.active = Math.max(0, this.active - 1);
            this.wake(pipeline.drama_id);
            return;
        }
        this.store.log(pipeline.drama_id, `开始 ${job.stage}/${job.kind} (${job.id}) attempt=${job.attempt}`, "info", job.episode_id, job.id);
        // 本次执行令牌：暂停退回队列后 resume 可能重新领取同一 job，旧执行的迟到结果必须被识别为过期。
        const runToken = randomUUID();
        this.runTokens.set(job.id, runToken);
        const lookupJob = (this.store as Partial<PipelineStore>).job;
        const currentStatus = () => (typeof lookupJob === "function" ? lookupJob.call(this.store, job.id)?.status : "running");

        void this.execute(job).then(
            (result) => {
                if (this.runTokens.get(job.id) !== runToken) {
                    this.store.log(pipeline.drama_id, `忽略已被新执行替代的旧结果 ${job.stage}/${job.kind} (${job.id})`, "warn", job.episode_id, job.id);
                    return;
                }
                // 影策：暂停不打断已派发作业，正常写回终态；只有作业已被重置/取消时才丢弃迟到结果。
                if (currentStatus() !== "running") {
                    this.store.log(pipeline.drama_id, `忽略已重置作业的迟到结果 ${job.stage}/${job.kind} (${job.id})`, "warn", job.episode_id, job.id);
                    this.wake(pipeline.drama_id);
                    return;
                }
                this.store.succeed(job.id, result || {});
                this.store.log(pipeline.drama_id, `完成 ${job.stage}/${job.kind} (${job.id})`, "info", job.episode_id, job.id);
                this.retryAt.delete(job.id);
                this.wake(pipeline.drama_id);
            },
            (error) => {
                if (this.runTokens.get(job.id) !== runToken) {
                    this.store.log(pipeline.drama_id, `忽略已被新执行替代的旧失败 ${job.stage}/${job.kind} (${job.id})：${errText(error)}`, "warn", job.episode_id, job.id);
                    return;
                }
                const message = errText(error);
                const code = message.split(":")[0].trim();
                // 只有显式重置留下的旧执行令牌会带 PAUSED_BY_USER；暂停本身不再中断已派发作业。
                if (message === PAUSED_BY_USER) {
                    this.store.markPaused(job.id, PAUSED_BY_USER);
                    this.retryAt.delete(job.id);
                    this.store.log(pipeline.drama_id, `旧执行被重置：${job.stage}/${job.kind} (${job.id}) 退回排队`, "warn", job.episode_id, job.id);
                    this.wake(pipeline.drama_id);
                    return;
                }
                if ((DEPENDENCY_NOT_READY_CODES as readonly string[]).includes(code)) {
                    // C6：上游依赖未就绪（本体参考图/素材/前置产物还没好），不是作业真失败。
                    // 退回 queued 且回退 attempt，延长退避等下一轮（对齐影策「本体未 ready 不排队」）。
                    this.store.deferDependency(job.id);
                    this.retryAt.set(job.id, Date.now() + DEPENDENCY_RETRY_MS);
                    this.store.log(pipeline.drama_id, `等待上游依赖就绪 ${job.stage}/${job.kind} (${job.id})：${message}`, "warn", job.episode_id, job.id);
                } else if (RESOURCE_BUSY_PATTERN.test(message)) {
                    // 资源占用（同一 clip 被别的任务占着）：重排无意义——占用任务还在跑/卡住，
                    // 秒失败后 2 分钟重排只会无限循环（实测 EP1 video attempt 1→4 空转）。
                    // 直接熔断终态，顶到硬上限让 retryFailed 也跳过，等占用任务结束或人工介入。
                    this.store.failCircuit(job.id, `RESOURCE_BUSY_CIRCUIT: ${message}`, MAX_ATTEMPTS_HARD);
                    this.retryAt.delete(job.id);
                    this.store.log(pipeline.drama_id, `资源占用熔断 ${job.stage}/${job.kind} (${job.id})：${message}；已停整集，等占用任务结束或人工介入`, "error", job.episode_id, job.id);
                } else {
                    this.store.fail(job.id, message);
                    this.store.log(pipeline.drama_id, `失败 ${job.stage}/${job.kind} (${job.id})：${message}`, "error", job.episode_id, job.id);
                    if (job.attempt < MAX_ATTEMPTS) {
                        this.store.requeue(job.id);
                        this.retryAt.set(job.id, Date.now() + this.backoffMs(job.attempt));
                    }
                }
                this.wake(pipeline.drama_id);
            },
        ).finally(() => {
            if (this.runTokens.get(job.id) === runToken) this.runTokens.delete(job.id);
            this.poolRunning[pool] = Math.max(0, this.poolRunning[pool] - 1);
            this.active = Math.max(0, this.active - 1);
        });
    }

    private backoffMs(attempt: number): number {
        if (attempt <= 1) return 5_000;
        if (attempt === 2) return 30_000;
        return 2 * 60 * 1000;
    }

    // ── job 分派 ────────────────────────────────────────────────────────

    private async execute(job: JobRow): Promise<Record<string, unknown>> {
        const payload = this.store.jobPayload(job);
        const episodeId = String(payload.episodeId || job.episode_id || "");
        // 暂停哨兵：被 pause 退回队列后又被领到的作业不得继续提交新的生成任务。
        await this.assertNotPaused(String(job.drama_id || ""));
        if (!episodeId) throw new Error("JOB_EPISODE_MISSING: 作业缺少分集 ID");

        const dramaId = String(job.drama_id || "");
        switch (job.kind as JobKind) {
            // 阶段作业把 job.id 透传下去：真正派生出 provider task 的辅助方法会把它写回
            // job.task_id（runtimeTaskId），队列详情才能只关联「这个作业自己的结果/重试历史」。
            case "script": return this.runScript(episodeId, dramaId, this.store.jobPayload(job), job.id);
            case "assets": return this.runAssets(episodeId, dramaId, job.id);
            case "prompts": return this.runPrompts(episodeId, dramaId, { forceRewrite: Boolean((payload as Record<string, unknown>).forceRewrite) }, job.id);
            case "video": return this.runVideo(episodeId, job);
            case "render": return this.runRender(episodeId, job);
            default: throw new Error(`UNKNOWN_JOB_KIND: ${job.kind}`);
        }
    }

    /** script 段：script-proposal → 写 synopsis/fullPlot → 文本 LLM 拆镜 → 清旧镜+整批重拆 → 编译链。
     *  payload.instruction 是按章编辑改编时前端算好的创作指令（写作技能/钩子悬念/分镜规则/思考深度），
     *  必须真透传到 script-proposal，保证手动改编与全自动同源。
     *  jobId：本作业 id，透传给拆镜文本任务写回 task_id（见 generateText）；script-proposal 是同步
     *  LLM 调用、路由不回传 taskId，因此 script 作业的 runtimeTaskId 指向拆镜文本任务，不是分场调用。 */
    private async runScript(episodeId: string, dramaId: string, payload?: Record<string, unknown>, jobId?: string): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const episode = episodeRes?.episode as Record<string, any> | undefined;
        if (!episode) throw new Error("EPISODE_NOT_FOUND");

        // 1) 单集分场剧本（后端路由已自动把生成出的 hook/cliffhanger 写回导演源稿）。
        //    梗概(自然语言) 与 分场脚本 分离：synopsis 存梗概(对齐影策)，fullPlot 存分场正文(供集间承接/原文对照兜底)。
        //    影策设置透传：planModel→model；textThinking.plan→reasoningEffort（真进 generateText params，
        //    对齐 storyboard/extract/prompt）；hook/cliffhanger→结构化字段 + instruction 创作方向（与手动改编同源）。
        const scriptOpts = this.optionsOf(dramaId);
        const planEffort = String(scriptOpts.textThinking?.plan || "").trim();
        const hook = String(scriptOpts.hook || "").trim();
        const cliffhanger = String(scriptOpts.cliffhanger || "").trim();
        const beats: string[] = [];
        if (hook) beats.push(`开篇钩子：${hook}`);
        if (cliffhanger) beats.push(`结尾悬念：${cliffhanger}`);
        // 按章编辑改编透传的 instruction 优先并进软指令：与前端 onRescript 计算的技能/钩子/规则同源。
        const payloadInstruction = String(payload?.instruction || "").trim();
        // 剧本类长期规则进分场规划；分镜/提示词类规则不进这里。
        const scriptRules = await learnedRulesCompact(["script"], 1200);
        const mergedInstruction = [scriptRules, payloadInstruction, ...beats].filter(Boolean).join("；").slice(0, 2000) || undefined;
        const proposalUrl = `/drama/episodes/${encodeURIComponent(episodeId)}/script-proposal`;
        const effectivePlanModel = String(payload?.model || "").trim() || String(scriptOpts.planModel || "").trim();
        const baseBody = { ...(effectivePlanModel ? { model: effectivePlanModel } : {}) };
        const enrichedBody = {
            ...baseBody,
            ...(hook ? { hook } : {}),
            ...(cliffhanger ? { cliffhanger } : {}),
            ...(planEffort && planEffort !== "auto" ? { reasoningEffort: planEffort } : {}),
            ...(mergedInstruction ? { instruction: mergedInstruction } : {}),
        };
        let proposal: any;
        try {
            proposal = await this.request("POST", proposalUrl, enrichedBody);
        } catch (error) {
            // 兼容尚未升级的 script-proposal 路由（strict schema 只收 model/instruction）：
            // 400 时回退到纯 instruction（钩子/悬念与思考深度全部并入软指令），不让整条流水线断在这里。
            const message = error instanceof Error ? error.message : String(error);
            if (!/\bHTTP 400\b/.test(message)) throw error;
            const fallback = [mergedInstruction, planEffort && planEffort !== "auto" ? `请以 ${planEffort} 的思考深度完成分场规划` : ""]
                .filter(Boolean).join("；").slice(0, 2000);
            proposal = await this.request("POST", proposalUrl, { ...baseBody, ...(fallback ? { instruction: fallback } : {}) });
        }
        const text = String(proposal?.text || "").trim();
        if (!text) throw new Error("SCRIPT_PROPOSAL_EMPTY: 改编没有返回分场文本");
        const synopsis = String(proposal?.synopsis || "").trim();

        // 对白逐字核查：分场大纲按口径「不写对白」，拆镜 LLM 拿不到台词。
        // 影策拆镜输入只来自本集章节（loadChapters(e.ChapterIDsJSON)），所以这里也只读本集覆盖章节的正文：
        // 绝不能回退整份 sourceScript——那会让每一集都拿全书拆镜，产出跨集重复的镜头。
        // 无章映射/正文为空时不注入原文，拆镜仍可用本集分场文本 text 进行，不因缺原文而复制别集内容。
        let episodeSource = "";
        try {
            const chaptersRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}/chapters`);
            const chapterTexts = (Array.isArray(chaptersRes?.chapters) ? chaptersRes.chapters : [])
                .map((chapter: Record<string, unknown>) => String(chapter?.body || "").trim())
                .filter(Boolean);
            if (chapterTexts.length) episodeSource = chapterTexts.join("\n\n");
        } catch { /* 取不到章节就不注入原文，不回退全书 */ }

        // 2) 写回：synopsis=自然语言梗概（缺省回退分场文本）；fullPlot=分场正文。
        await this.request("PATCH", `/drama/episodes/${encodeURIComponent(episodeId)}`, {
            synopsis: synopsis || text,
            fullPlot: text,
        });

        // 3) 结构化拆镜草案（prompt 参考 buildChapterDemandPrompt + parseChapterDemand）。
        let production = (await this.getProduction(episodeId)).production as any;
        let source = production?.draft?.director?.source || {};
        let scenes = productionSceneEntries(source) as Array<{ id: string; environmentId: string; title: string; shotIds: string[] }>;
        if (!scenes.length) {
            // 空稿先初始化出场次（initialize_director_from_demand 只吃空壳稿；已有场景必须跳过）。
            production = (await this.productionOps(episodeId, production.revision, [{ type: "initialize_director_from_demand" }])).production;
            source = production?.draft?.director?.source || {};
            scenes = productionSceneEntries(source) as typeof scenes;
        }
        if (!scenes.length) throw new Error("DIRECTOR_NO_SCENE: 初始化后仍没有场次，无法拆镜");
        // 按章编辑改编（rescript）重跑 script 时必须重拆镜——这是「改了原文/剧本但分镜不变」的根因。
        // 影策 rescript 在事务内先 DELETE 本集 DramaShot+DramaSegment 再走 script 重拆；本地等价物在
        // 下面的写稿处：清空旧 shots/segments 与写入新分镜放进同一个 productionOps 批次整批原子提交，
        // 任一步校验失败整次回滚，不会出现「旧镜已清、新镜未写」的半写形变。
        const hadShots = (Array.isArray(source.shots) ? source.shots : []).length > 0;
        // 拆镜 prompt 的环境清单必须是具体场景实体，不能是「第三章标题」这种剧本场次占位：
        // 后者会让所有镜头 scene_id 都指向章节，绑定阶段只能瞎猜一张图。剧本场次仍用于镜头归属。
        const scriptEnvironments: ChapterDemandEnvironment[] = scenes.map(scene => ({ id: scene.environmentId, name: scene.title }));
        const sceneEntityIds = new Set(
            (Array.isArray(source.asset_plan) ? source.asset_plan : [])
                .filter((row: any) => String(row?.kind || row?.asset_kind || "").toLowerCase() === "scene")
                .map((row: any) => String(row?.entity_id || ""))
                .filter(Boolean),
        );
        const concreteScenes = (Array.isArray(source.scene_registry) ? source.scene_registry : [])
            .filter((scene: any) => sceneEntityIds.has(String(scene?.id || "")))
            .map((scene: any) => ({ id: String(scene.id), name: String(scene.name || scene.id) }));
        const environments: ChapterDemandEnvironment[] = concreteScenes.length ? concreteScenes : scriptEnvironments;
        const environmentOfScene = new Map<string, string>(scenes.map(scene => [scene.environmentId, scene.id]));
        // 影策 CastIDsJSON 规则：结构化引用清单真值全部来自已登记注册表/资产卡。
        // 注册表为空的老剧目 → 清单为空 → 拆镜引用全空（预期回退），绝不编造 id。
        // 道具名真值在 asset_plan.asset_name（asset_cards 常只有 prompt 长描述）；
        // 取名逻辑见 shot-refs.ts，实测直接拿 prompt 当名字会让 prop_ids 全空、参考图绑不上。
        const characterRefs = characterRefsOf(source);
        const propRefs = propRefsOf(source);
        const allowedCharacterIds = new Set(characterRefs.map(item => item.id));
        const allowedPropIds = new Set(propRefs.map(item => item.id));
        const allowedSceneIds = new Set(environments.map(item => item.id));

        const opts = this.optionsOf(dramaId);
        const rules = opts.storyboardRules || {};
        // 分镜规则软约束：把单集时长/段时长/对白密度/转场/节奏并入拆镜 prompt 的 chapterBody
        // （canvas-agent 的 ChapterDemandPromptInput 无这些字段，用文本注入避免改契约/dist）。
        const ruleLines: string[] = [];
        if (rules.episodeSeconds) ruleLines.push(`本集时长约 ${rules.episodeSeconds} 秒。`);
        if (rules.segmentRange) ruleLines.push(`每个剧情段控制在 ${rules.segmentRange.min}-${rules.segmentRange.max} 秒。`);
        if (rules.dialogueDensity && rules.dialogueDensity !== "standard") {
            ruleLines.push(`对白密度：${{ dense: "密集，多场对话", restrained: "克制，少对白多动作", custom: "按剧情需要" }[rules.dialogueDensity] || rules.dialogueDensity}。`);
        }
        if (rules.transitionMode && rules.transitionMode !== "smart") {
            // 对齐影策 transition 规范值：hard=cut硬切 / fade=fadeblack黑场过渡 / flash=fadewhite闪白；
            // smart=auto 智能档不注入硬文本，交给拆镜按场景自行判断（影策 auto 语义）。
            ruleLines.push(`场景衔接：${{ hard: "硬切(cut)", fade: "黑场淡入淡出(fadeblack)", flash: "闪白(fadewhite)" }[rules.transitionMode] || rules.transitionMode}${rules.transitionMs ? `（约 ${rules.transitionMs}ms）` : ""}。`);
        } else if (rules.transitionMode === "smart") {
            ruleLines.push("场景衔接：智能(auto)，按场景切换自行选择硬切或过渡。");
        }
        if (rules.pacing && rules.pacing !== "标准") ruleLines.push(`整体节奏：${rules.pacing}。`);
        // 写作技能（分镜拆分）：用 resolveSlotSkill 而非 resolveTextSkill——
        // 槽位空时回退技能市场真实 slug drama-05-board。制作台 structured 用 silent 会话会跳过
        // Hermes 的 skills.auto_load，若这里也不拼 skill 正文，拆镜就没有方法约束、回包易非 JSON 走兜底。
        const storyboardSkill = await this.resolveSlotSkill(opts.textSkills?.storyboard, "storyboard", dramaId);
        if (storyboardSkill.skillContent) ruleLines.push(`【本轮基于 ${storyboardSkill.skillName || "默认"} 技能，按其方法与标准拆解】${storyboardSkill.skillContent}。`);
        // 分镜类与连续性类长期规则进拆镜；提示词类规则不进这里。
        const storyboardRules = await learnedRulesCompact(["storyboard", "continuity"], 1600);
        if (storyboardRules) ruleLines.push(`用户长期规则：${storyboardRules}。`);
        const sourceBlock = episodeSource
            ? `\n\n【小说原文·台词必须逐字从这里提取到 beat 的 dialogue/speaker，不得改写或遗漏引号内的对白】\n${episodeSource}`
            : "";
        const chapterBody = `${text}${sourceBlock}` + (ruleLines.length ? `\n\n【制作设置·分镜要求】${ruleLines.join("")}` : "");
        const demandPrompt = buildChapterDemandPrompt({
            chapterTitle: String(episode.title || ""),
            chapterBody,
            environments,
            characterRefs,
            propRefs,
            // 影策拆分镜头 prompt 的票面信息：风格/画面规则决定整集调性，钩子/悬念决定首尾镜头。
            // 这些值早就在导演源稿里，之前没传给拆镜，模型只能各镜各写一套。
            ...(String(source.style_prompt || source.stylePrompt || "").trim()
                ? { stylePrompt: String(source.style_prompt || source.stylePrompt).trim() } : {}),
            ...(String(source.visual_rules || source.visualRules || "").trim()
                ? { visualRules: String(source.visual_rules || source.visualRules).trim() } : {}),
            ...(String(source.hook || "").trim() ? { hook: String(source.hook).trim() } : {}),
            ...(String(source.cliffhanger || "").trim() ? { cliffhanger: String(source.cliffhanger).trim() } : {}),
            ...(scenes.length
                ? { sceneHints: scenes.map(scene => scene.title).filter(Boolean).join(" / ") } : {}),
        });
        const storyboardText = await this.generateText([demandPrompt.system, "", demandPrompt.user].join("\n"), {
            model: opts.storyboardModel,
            reasoningEffort: opts.textThinking?.storyboard,
        }, dramaId, jobId);
        let draft: { demand: string; scenes: ChapterScenePlan[] };
        try {
            draft = parseChapterDemand(storyboardText, { environments, allowedCharacterIds, allowedPropIds, allowedSceneIds });
        } catch {
            draft = fallbackChapterDemand({
                chapterTitle: String(episode.title || ""),
                chapterBody: text,
                environmentId: environments[0]?.id || "",
                sceneName: environments[0]?.name,
            });
        }

        // 影策节奏：把制作台的中文 pacing 档位映射到英文枚举，传给 planChapterStoryboard 做硬约束。
        // 未配置时用 relaxed（舒缓）：解决旧逻辑"所有镜头写死3秒→急得跟投胎"的问题。
        const pacingMap: Record<string, string> = {
            "极快": "rapid", "快": "fast", "标准": "standard", "舒缓": "relaxed", "慢": "slow",
            rapid: "rapid", fast: "fast", standard: "standard", relaxed: "relaxed", slow: "slow",
        };
        const pacing = pacingMap[String(rules.pacing || "").trim()] || "relaxed";
        const plan = planChapterStoryboard({
            chapterId: episodeId,
            scenes: draft.scenes,
            fps: this.fpsOf(source),
            // 对齐影策：剧情段目标 8–15 秒（影策真实段多为 10–11 秒），不再用旧的 5 秒。
            clipSeconds: 10,
            pacing,
            // 制作台设置的真实切段规则：不下发时 planChapterStoryboard 走旧的按场景装箱，
            // 镜头 6–7 秒就会一镜一段。这里把 auto / range / fixed 与时长上下限一并透传。
            segmentMode: rules.segmentMode || "auto",
            segmentMinSeconds: rules.segmentRange?.min,
            segmentMaxSeconds: rules.segmentRange?.max,
        });
        const ops = toSceneStoryboardOps(plan, environmentOfScene) as Array<Record<string, unknown>>;
        if (hadShots) {
            // 影策 rescript = 事务内 DELETE 本集 DramaShot+DramaSegment 再按新稿重拆。本地等价：
            // 先用整份 director 清空 shots/segments（set_director_production），紧接着用
            // replace_director_scene_storyboard 把新草案写回；两者在同一 productionOps 批次里
            // 整批原子提交——任一步校验失败整次回滚，不会留下「旧镜已清、新镜未写」的半写形变。
            // 也顺带绕开「已有场次须保留原 Clip ID 集合」(SCENE_STORYBOARD_SEGMENTS)：清空后场次
            // 已无镜头，新 Clip 数可与旧的不同，无需硬凑数量。
            const cleared = structuredClone(production.draft.director) as Record<string, any>;
            cleared.source.shots = [];
            cleared.source.segments = [];
            // 对白事件引用 Shot ID：重拆镜时 Shot ID 全变，旧 utterances 必然指向已不存在的 Shot，
            // 校验器会以「对白事件必须由 Shot 引用 / 对白起止 Shot 不存在」拒绝整批 ops。
            // 必须在同一批次里一起清空，让新稿的对白按新 Shot 重新生成。
            cleared.source.utterances = [];
            ops.unshift({ type: "set_director_production", director: cleared });
        }
        production = (await this.productionOps(episodeId, production.revision, ops)).production;

        // 4) 发布 → 编译 → 应用 → 再发布 → 准备节点 → 同步 Clip（缺一步画布都不出 H3 节点）。
        await this.promoteToCanvas(episodeId);
        return { shots: plan.shots.length, segments: plan.segments.length, diagnostics: plan.diagnostics.slice(0, 20) };
    }

    /**
     * assets 段：文本 LLM 提取设定 → create_manual_director_asset 建档 → 逐资产真实出图并写回。
     *
     * 建档只让 director.assets[id] 停在 planned；这里为没有 storageKey 的资产走
     * POST /canvas/generation(mode:image) 生成真实参考图，再 POST bind-image 写回制作稿与实体节点。
     * 幂等（已有 storageKey 跳过），并发受限，单资产失败只记日志不阻断整集。
     *
     * jobId：本作业 id。assets 一次会派生多个子任务（设定提取文本 + 每张参考图生图）；
     * task_id 只有一列且 markRunning 是覆盖写，故 runtimeTaskId 语义是「最新一张子任务」，
     * 不是全部子任务列表（追不到全部），队列详情不得据此声称覆盖本作业所有生成。
     */
    private async runAssets(episodeId: string, dramaId: string, jobId?: string): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const episode = episodeRes?.episode as Record<string, any> | undefined;
        if (!episode) throw new Error("EPISODE_NOT_FOUND");
        const synopsis = String(episode.synopsis || "").trim();
        if (!synopsis) throw new Error("ASSETS_NO_SYNOPSIS: 分集还没有剧本，资产提取跳过");

        // 已建好资产计划的分集（script 阶段建档 / 老剧目），直接以 asset_plan 为准生成参考图，
        // 保证「所有已规划资产都出图」且 id 稳定；只有完全没有资产计划时才走 LLM 提取兜底。
        // 老问题：每次重跑都重新 LLM 提取，列表不稳定 → 部分角色永远漏图、且算出的 id 与老卡漂移。
        const initialProduction = (await this.getProduction(episodeId)).production as any;
        const initialSource = initialProduction?.draft?.director?.source || {};
        const initialPlan = [
            ...(Array.isArray(initialSource.asset_plan) ? initialSource.asset_plan : []),
            ...(Array.isArray(initialSource.asset_cards) ? initialSource.asset_cards : []),
        ] as Array<Record<string, any>>;
        type Extracted = { kind: string; name: string; appearance: string; voice?: string; aliases?: string[]; forcedId?: string };
        let assets: Extracted[] = [];
        if (initialPlan.length) {
            const registry = [
                ...(Array.isArray(initialSource.character_registry) ? initialSource.character_registry : []),
                ...(Array.isArray(initialSource.scene_registry) ? initialSource.scene_registry : []),
            ] as Array<Record<string, any>>;
            const seen = new Set<string>();
            for (const row of initialPlan) {
                const kind = String(row?.kind || row?.asset_kind || "").trim();
                const name = String(row?.asset_name || row?.name || "").trim();
                if (!kind || !name || seen.has(`${kind}:${name}`)) continue;
                seen.add(`${kind}:${name}`);
                const cardPrompt = String(row?.prompt || "").trim();
                const desc = String(row?.description || row?.purpose || "").trim();
                const reg = registry.find((r) => String(r?.id || "") === String(row?.entity_id || "") || String(r?.name || "") === name);
                let aliases: string[] = [];
                const aliasSource = reg?.aliases ?? reg?.alias ?? row?.aliases ?? row?.alias;
                if (Array.isArray(aliasSource)) aliases = aliasSource.map(a => String(a || "").trim()).filter(Boolean);
                else if (typeof aliasSource === "string") aliases = aliasSource.split(/[,，、]/).map(a => a.trim()).filter(Boolean);
                if (!aliases.length && reg?.identity) {
                    try {
                        const ident = typeof reg.identity === "string" ? JSON.parse(reg.identity) : reg.identity;
                        const list = ident?.aliasNames ?? ident?.aliases;
                        if (Array.isArray(list)) aliases = list.map(a => String(a || "").trim()).filter(Boolean);
                    } catch { /* identity 非 JSON 时忽略 */ }
                }
                assets.push({
                    kind, name,
                    appearance: cardPrompt || desc || String(reg?.appearance || reg?.description || `「${name}」的参考图，按设定生成。`),
                    ...(reg?.voice_description ? { voice: String(reg.voice_description) } : {}),
                    ...(kind === "character" && aliases.length ? { aliases } : {}),
                    forcedId: String(row?.id || row?.asset_id || ""),
                });
            }
        }
        if (!assets.length) {
            // 跨集角色身份登记：别名由各集各自提取，只看本集注册表认不出
            // 「女子」=「蟒妻」这类伪装态/身份称呼。按全剧已建档角色的 name+aliases
            // 建索引，提取时复用已有 name/id 并合并新别名，避免同一人被建成多张卡。
            type KnownCharacter = { name: string; aliases: string[]; id: string };
            const knownCharacters: KnownCharacter[] = [];
            const knownNames = new Set<string>();
            const addKnown = (name: unknown, aliases: unknown, id: unknown) => {
                const n = textOf(name);
                if (!n || knownNames.has(n)) return;
                knownNames.add(n);
                const list = Array.isArray(aliases) ? aliases.map(a => textOf(a)).filter(Boolean)
                    : typeof aliases === "string" ? aliases.split(/[,，、]/).map(a => a.trim()).filter(Boolean) : [];
                knownCharacters.push({ name: n, aliases: list, id: textOf(id) });
            };
            const collectKnown = (source: Record<string, any> | undefined) => {
                // asset_plan 先登记：它的 id 是 asset-character-xxx，适合做 forcedId 复用。
                for (const row of rowsOf(source?.asset_plan)) {
                    if (textOf(row.kind ?? row.asset_kind) !== "character") continue;
                    addKnown(row.asset_name ?? row.name, row.aliases ?? row.alias, row.id ?? row.asset_id);
                }
                for (const row of rowsOf(source?.character_registry)) {
                    let al: unknown = row.aliases ?? row.alias;
                    if (!al && row.identity) {
                        try {
                            const parsed = typeof row.identity === "string" ? JSON.parse(row.identity) : row.identity;
                            al = parsed?.aliasNames ?? parsed?.aliases;
                        } catch { /* identity 非 JSON 时忽略 */ }
                    }
                    addKnown(row.name ?? row.characterName, al, row.id);
                }
            };
            collectKnown(initialSource);
            try {
                const listing = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
                const others = (Array.isArray(listing?.episodes) ? listing.episodes : [])
                    .filter((ep: Record<string, any>) => textOf(ep?.id) !== episodeId)
                    .slice(0, 60);
                const sources = await Promise.all(others.map(async (ep: Record<string, any>) => {
                    try { return (await this.getProduction(textOf(ep.id))).production?.draft?.director?.source as Record<string, any> | undefined; }
                    catch { return undefined; }
                }));
                for (const src of sources) if (src) collectKnown(src);
            } catch { /* 其它集读不到时退化为仅本集身份，不阻断提取 */ }

            const assetPrompt = buildAssetExtractPrompt({
                chapterTitle: String(episode.title || ""),
                synopsis,
                existingNames: knownCharacters.flatMap(k => [k.name, ...k.aliases]),
            });
            // 资产类长期规则进设定提取，不进分镜或提示词链路。
            const assetRules = await learnedRulesCompact(["asset"], 1000);
            const identityHint = knownCharacters.length
                ? `\n\n全剧已建档角色（本集若出现其伪装名、身份称呼，必须用已有 name 输出并把新称呼写进 aliases，不得另建角色）：${knownCharacters.map(k => `${k.name}（别名：${k.aliases.join("、") || "无"}）`).join("；")}。`
                : "";
            const assetUser = `${assetPrompt.user}${identityHint}${assetRules ? `\n\n用户长期规则：${assetRules}。` : ""}`;
            const assetOpts0 = this.optionsOf(dramaId);
            const raw = await this.generateText([assetPrompt.system, "", assetUser].join("\n"), {
                model: assetOpts0.assetExtractModel,
                reasoningEffort: assetOpts0.textThinking?.extract,
            }, dramaId, jobId);
            try { assets = parseAssetExtract(raw); }
            catch { assets = fallbackAssetExtract({ chapterTitle: String(episode.title || ""), synopsis }); }
            // 模型回包不可控：即使没听提示，也按已建档别名把角色归一到已有身份与 ID。
            const normCharName = (value: unknown) => textOf(value).toLocaleLowerCase("zh-CN")
                .replace(/^角色[：:]\s*/, "").replace(/[\s·•・._-]+/g, "").trim();
            for (const asset of assets) {
                if (asset.kind !== "character") continue;
                const keys = [asset.name, ...(asset.aliases || [])].map(normCharName).filter(Boolean);
                const known = knownCharacters.find(k => [k.name, ...k.aliases].some(v => keys.includes(normCharName(v))));
                if (!known) continue;
                asset.name = known.name;
                asset.aliases = Array.from(new Set([...known.aliases, ...(asset.aliases || [])]));
                if (known.id) asset.forcedId = known.id;
            }
        }
        if (!assets.length) throw new Error("ASSETS_EMPTY: 没有可建档的设定");

        const canvasId = String((episodeRes?.canvas as Record<string, any> | null | undefined)?.id || "");
        // 资产类规则同时约束参考图提示词；这段只作用于生图，不影响提示词链路。
        const assetImageRules = await learnedRulesCompact(["asset"], 1000);
        type PendingImage = { assetId: string; kind: string; name: string; entityId: string; prompt: string };
        const pending: PendingImage[] = [];
        // 幂等判据的第二真值源：画布实体节点上的参考图（characterImages / sceneImage / propImage）。
        // 只认制作稿 director.assets[id].storageKey 会在 compile/apply 重建 assets 清空后把 8 张现成图当成「没生成」，
        // 每轮重出一次，既烧算力又容易被 provider 偶发失败拖到重试上限。
        const skipNodes = canvasId
            ? ((await this.getCanvasProject(canvasId))?.nodes as Array<Record<string, any>> | undefined) || []
            : [];
        let skipped = 0;
        let created = 0;

        const voiceByName = new Map<string, string>();
        for (const asset of assets) {
            if (asset.kind === "character" && asset.voice) voiceByName.set(asset.name, asset.voice);
            // 每条重取 revision（乐观锁）；同名同类型跳过（只填空不覆盖）。
            const production = (await this.getProduction(episodeId)).production as any;
            const source = production?.draft?.director?.source || {};
            const director = production?.draft?.director || {};
            const planRows = [...(Array.isArray(source.asset_plan) ? source.asset_plan : []), ...(Array.isArray(source.asset_cards) ? source.asset_cards : [])];
            // 老剧目的 asset_plan.id 早期是随机 hash，不是 asset-{kind}-{hash(name)} 规则；
            // 若只按新规则算 id，会给同一设定建新卡、图写到新 id，前端按老 asset_plan.id 查不到 → 显示「未生成」。
            // 修复：按「同名同类型」复用已有条目 id（精确同名优先，其次互相包含兼容「会试墨卷」vs「柳文卿会试墨卷」）。
            const kindOfRow = (row: any) => String(row?.kind || row?.asset_kind || "").trim();
            const nameOfRow = (row: any) => String(row?.asset_name || row?.name || "").trim();
            const exactRow = planRows.find((row: any) => kindOfRow(row) === asset.kind && nameOfRow(row) === asset.name) as Record<string, any> | undefined;
            const partialRow = exactRow ? undefined : planRows.find((row: any) => {
                const rn = nameOfRow(row);
                return kindOfRow(row) === asset.kind && rn && (rn.includes(asset.name) || asset.name.includes(rn));
            }) as Record<string, any> | undefined;
            const reuseRow = exactRow || partialRow;
            // forcedId：资产来自现有 asset_plan 时直接用它的 id（最稳，零漂移）；LLM 兜底提取时按名字复用/新算。
            const id = String(asset.forcedId || "")
                || (reuseRow
                    ? String(reuseRow.id || reuseRow.asset_id || `asset-${asset.kind}-${this.shortHash(`${asset.kind}:${asset.name}`)}`)
                    : `asset-${asset.kind}-${this.shortHash(`${asset.kind}:${asset.name}`)}`);
            const existingRow = (planRows.find((row: any) => String(row?.id || row?.asset_id || "") === id) || reuseRow) as Record<string, any> | undefined;
            const entityId = asset.kind === "prop" ? "" : `entity-${asset.kind}-${this.shortHash(asset.name)}`;

            if (!existingRow) {
                const op: Record<string, unknown> = {
                    type: "create_manual_director_asset",
                    assetPlan: {
                        id,
                        kind: asset.kind,
                        asset_name: asset.name,
                        ...(entityId ? { entity_id: entityId } : {}),
                        version: "v1",
                        description: asset.appearance,
                        purpose: asset.appearance,
                        depends_on: [],
                        status: "planned",
                        ...(asset.kind === "character" && asset.aliases?.length ? { aliases: asset.aliases } : {}),
                    },
                    assetCard: {
                        id,
                        asset_id: id,
                        asset_kind: asset.kind,
                        target_skill: "im2-clean-image",
                        source_repository: "im2-image-skills",
                        asset_version: "v1",
                        prompt: asset.appearance,
                        references: [],
                        reference_policy: "none",
                    },
                };
                if (asset.kind !== "prop" && entityId) {
                    op.registryKind = asset.kind;
                    op.registryEntity = { id: entityId, name: asset.name, description: asset.appearance, appearance: asset.appearance,
                        ...(asset.voice ? { voice_description: asset.voice } : {}),
                        ...(asset.aliases?.length ? { identity: { aliasNames: asset.aliases, aliases: asset.aliases } } : {}) };
                }
                await this.productionOps(episodeId, production.revision, [op]);
                created += 1;
            }

            // 参考图提示词由「内置方案模板」真实拼装（对齐影策 buildDramaCastImagePrompt）：
            // 角色默认定妆照、场景空镜、道具设定图；资产卡上若存了 view_layout（用户选的方案）则用它。
            // 用户手写的卡 prompt 作为补充描述并入，不会被模板吞掉。
            // 幂等：制作稿已写回 storageKey，或画布实体节点上已有参考图（compile/apply 会把 draft.assets 清空，
            // 只看 draft 会把现成图当成没生成）。两种真值任一存在就跳过重出，计入 skipped 而不是失败。
            const skipEntity = findPipelineAssetEntityNode(skipNodes, { kind: asset.kind, name: asset.name, entityId });
            const skipEntityNode = skipEntity ? skipNodes.find(node => String(node.id || "") === skipEntity.id) : null;
            if (assetHasReference({ draftStorageKey: String((director.assets as Record<string, any> | undefined)?.[id]?.storageKey || ""), node: skipEntityNode })) {
                skipped += 1;
                continue;
            }
            const rawPrompt = String(existingRow?.prompt || "").trim();
            // view_layout 写回在 asset_cards，asset_plan 里可能残留旧值；优先从 asset_cards 读，避免读到旧快照。
            const cardRow = (Array.isArray(source.asset_cards) ? source.asset_cards : []).find((r: any) => String(r?.id || r?.asset_id || "") === id) as Record<string, any> | undefined;
            const schemeRaw = String(cardRow?.view_layout || (existingRow as Record<string, any> | undefined)?.view_layout || "").trim();
            const kindStr = String(asset.kind || "character");
            const scheme: AssetSchemeId = (schemeRaw as AssetSchemeId)
                && schemeAppliesTo(schemeRaw as AssetSchemeId, kindStr as "character" | "scene" | "prop")
                ? schemeRaw as AssetSchemeId
                : defaultSchemeFor(kindStr as "character" | "scene" | "prop");
            const body = (rawPrompt && rawPrompt !== asset.appearance) ? `${asset.appearance}。补充要求：${rawPrompt}` : asset.appearance;
            // 剧目模板优先（影策「角色/场景/默认提示词」）；模板为空时 renderAssetPromptWithTemplate 内部回退 buildSchemePrompt。
            const assetTemplates = this.optionsOf(dramaId).assetPromptTemplates;
            const rendered = renderAssetPromptWithTemplate(kindStr as "character" | "scene" | "prop", String(asset.name || ""), body, scheme, assetTemplates, {
                项目画风: String(source.style_prompt || source.stylePrompt || "").trim(),
                资产名称: String(asset.name || ""),
                资产设定: body,
                画面规则: assetImageRules,
                方案名称: ASSET_SCHEMES.find((s) => s.id === scheme)?.name || scheme,
                方案要求: ASSET_SCHEMES.find((s) => s.id === scheme)?.frameHint || "",
            });
            if (rendered.unknownVars.length) this.store.log(dramaId, `资产 ${id} 提示词模板含未知变量 ${rendered.unknownVars.map((v) => `{{${v}}}`).join("、")}，已原样保留`, "warn");
            // 规则已由模板的 {{画面规则}} 承载，不再在末尾追加「用户长期规则：」段。
            const prompt = rendered.prompt.trim();
            if (!prompt) { this.store.log(dramaId, `资产 ${id} 没有可用提示词，跳过参考图生成`, "warn"); continue; }
            this.store.log(dramaId, `资产 ${id} 参考图方案=${scheme}（横版16:9）· 提示词来源=${rendered.usedTemplate ? "剧目模板" : "内置方案模板"}`);
            pending.push({ assetId: id, kind: kindStr, name: String(asset.name || ""), entityId, prompt });
        }

        // 声线描述是共享资产字段：资产库卡片和视频提示词都读共享节点的 characterVoiceDescription。
        // 提取阶段只把它写进分集 character_registry，这里补写到共享画布，避免"生成了却看不到、也进不了提示词"。
        if (voiceByName.size) {
            try {
                const dramaRes = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}`);
                const sharedId = String(dramaRes?.drama?.sharedAssetCanvasId || "");
                if (sharedId) {
                    const sharedProject = await this.getCanvasProject(sharedId);
                    const nodes = (Array.isArray(sharedProject?.nodes) ? sharedProject.nodes : []) as Array<Record<string, any>>;
                    const operations: Array<Record<string, unknown>> = [];
                    for (const node of nodes) {
                        if (String(node?.type || "") !== "character") continue;
                        const name = String(node?.metadata?.characterName || node?.title || "");
                        const voice = voiceByName.get(name);
                        if (!voice || String(node?.metadata?.characterVoiceDescription || "") === voice) continue;
                        operations.push({ type: "update_node", id: String(node.id), metadata: { characterVoiceDescription: voice } });
                    }
                    if (operations.length) {
                        await this.request("POST", `/canvas/projects/${encodeURIComponent(sharedId)}/ops`, {
                            operationId: randomUUID(),
                            expectedRevision: Number(sharedProject?.revision || 0),
                            operations,
                        });
                        this.store.log(dramaId, `角色声线描述已同步到共享画布 ${operations.length} 项`);
                    }
                }
            } catch (error) {
                this.store.log(dramaId, `角色声线同步共享画布失败（不阻断）：${errText(error)}`, "warn");
            }
        }

        const assetOpts = this.optionsOf(dramaId);
        let generated = 0;
        let imageFailed = 0;
        if (pending.length && canvasId) {
            // 建档会经 production edit 同步创建/更新 production-entity-* 节点，必须重新读画布节点。
            const project = await this.getCanvasProject(canvasId);
            const canvasNodes: Array<Record<string, any>> = Array.isArray(project?.nodes) ? project.nodes as Array<Record<string, any>> : [];
            const kindModel = assetOpts.imageModelsByKind || {};
            const defaultModel = String(this.resolveImageModel?.() || "").trim();
            const imageConcurrency = this.poolLimitOf(dramaId, "image");
            this.store.log(dramaId, `资产参考图开始生成：${pending.length} 张（默认模型 ${defaultModel || "未配置"}，并发 ${imageConcurrency}）`);
            let cursor = 0;
            const worker = async () => {
                while (cursor < pending.length) {
                    // 影策：暂停只挡新作业派发，已派发的出图作业把本批剩余图片跑完。
                    const item = pending[cursor++];
                    try {
                        const key = await this.generateAssetReference(episodeId, canvasId, canvasNodes, item,
                            String(kindModel[item.kind as "character" | "scene" | "prop"] || "").trim() || defaultModel,
                            assetOpts.imageResolution, dramaId, jobId);
                        generated += 1;
                        this.store.log(dramaId, `资产 ${item.assetId} 参考图已写回：${key}`);
                    } catch (error) {
                        if (errText(error) === PAUSED_BY_USER) return;
                        imageFailed += 1;
                        this.store.log(dramaId, `资产 ${item.assetId} 参考图生成失败（不阻断）：${errText(error)}`, "warn");
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(imageConcurrency, pending.length) }, worker));
        } else if (pending.length && !canvasId) {
            this.store.log(dramaId, "分集还没有画布，跳过资产参考图生成", "warn");
        }
        this.store.log(dramaId, `assets 段完成：建档 ${created} 项，跳过 ${skipped} 项（已有参考图），参考图 ${generated} 张成功 / ${imageFailed} 张失败`);
        // 幂等成功：本轮没有需要新生成的资产（全部已有参考图）时，这是正常完成而不是失败——
        // 重试不会让已有图变好，只会重复计费；返回 skipped 让调用方/界面看到「无事可做」。
        return { total: assets.length, skipped, created, images: generated, imageFailed };
    }

    /** 单资产真实出图 + 写回：定位实体节点 → 生图 → 轮询 → bind-image（真实 storageKey）。
     *  jobId：拿到 taskId 后写回该作业的 task_id（最新一张覆盖前一张，见 runAssets 注释）。 */
    private async generateAssetReference(episodeId: string, canvasId: string, canvasNodes: Array<Record<string, any>>,
        item: { assetId: string; kind: string; name: string; entityId: string; prompt: string }, model: string,
        imageResolution?: "1k" | "2k" | "4k", dramaId?: string, jobId?: string): Promise<string> {
        if (!model) throw new Error("ASSET_IMAGE_MODEL_MISSING: 请在设置里选择图片模型（ai.config.imageModel）");
        const entity = findPipelineAssetEntityNode(canvasNodes, { kind: item.kind, name: item.name, entityId: item.entityId });
        if (!entity) throw new Error(`ASSET_IMAGE_ENTITY_MISSING: 找不到 ${item.kind}「${item.name}」的 production-entity 节点`);
        // 影策资产参考图统一横版 16:9（panels.tsx ASSET_IMAGE_RATIO），角色内置参考图方案也均为 16:9。
        // 显式传 size 覆盖实体节点上残留的 9:16 默认，避免场景/道具出成竖版。
        const ASSET_SIZE_PX: Record<"1k" | "2k" | "4k", string> = { "1k": "1536x864", "2k": "2048x1152", "4k": "3840x2160" };
        const size = ASSET_SIZE_PX[imageResolution || "1k"];
        const started = await this.request("POST", "/canvas/generation", {
            mode: "image",
            projectId: canvasId,
            nodeId: entity.id,
            model,
            prompt: item.prompt,
            count: 1,
            size,
            ...(imageResolution ? { imageResolution } : {}),
        });
        const taskId = String(started?.taskId || "");
        if (!taskId) throw new Error("ASSET_IMAGE_NO_TASK: 生图任务没有返回 taskId");
        // 写回作业 task_id：markRunning 只在 status='running' 时更新，暂停/重排后的旧任务号不会被复活。
        if (jobId) this.store.markRunning(jobId, taskId);
        await this.assertNotPaused(dramaId || "", taskId);
        const task = await this.waitTask(taskId, false, dramaId);
        if (dramaId) this.chargeGeneration(dramaId, "image", task);
        const storageKey = generatedMediaStorageKey(task);
        if (!storageKey) throw new Error(`ASSET_IMAGE_NO_MEDIA: 任务 ${taskId} 没有产出 storageKey`);
        await this.request("POST", "/drama/pipeline/assets/bind-image", {
            episodeId, assetId: item.assetId, nodeId: entity.id, storageKey, taskId,
        });
        return storageKey;
    }

    /** prompts 段：逐段文本 LLM 写提示词 → update_h3_segment 写画布 clip.prompt。
     *  jobId：本作业 id，透传给逐段的生成/精简文本任务写回 task_id。多段会覆盖写，
     *  runtimeTaskId 指向「最近一段的子任务」，不是全部段（见 generateText 注释）。 */
    private async runPrompts(episodeId: string, dramaId: string, options: RunPromptsOptions = {}, jobId?: string): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const canvas = (episodeRes?.canvas || null) as Record<string, any> | null;
        if (!canvas?.id) throw new Error("EPISODE_CANVAS_MISSING: 分集还没有画布");
        const production = (await this.getProduction(episodeId)).production as any;
        const director = (production?.draft?.director || {}) as Record<string, any>;
        const source = production?.draft?.director?.source || {};
        const fps = this.fpsOf(source);
        const shots: Array<Record<string, any>> = Array.isArray(source.shots) ? source.shots : [];
        const segments: Array<Record<string, any>> = Array.isArray(source.segments) ? source.segments : [];
        // 段参考绑定优先取共享画布资产节点真图（权威源），避免分集缓存漂移导致绑错图/空图。
        const sharedStorage = await this.sharedAssetStorageMap(dramaId, source);
        let utterances: Array<Record<string, any>> = Array.isArray(source.utterances) ? source.utterances : [];
        if (!segments.length) throw new Error("PROMPTS_NO_SEGMENTS: 制作稿还没有可写提示词的段");

        const promptOpts = this.optionsOf(dramaId);
        const promptRules = promptOpts.storyboardRules || {};
        // 分镜规则 → 段提示词的 style 软约束（与前端手动撰写同源，全自动流水线现在也读设置）。
        const ruleStyle: string[] = [];
        if (promptRules.dialogueDensity && promptRules.dialogueDensity !== "standard") {
            ruleStyle.push(`对白${{ dense: "密集", restrained: "克制", custom: "按需" }[promptRules.dialogueDensity] || promptRules.dialogueDensity}`);
        }
        if (promptRules.transitionMode && promptRules.transitionMode !== "smart") {
            ruleStyle.push(`转场${{ hard: "硬切(cut)", fade: "黑场淡入淡出(fadeblack)", flash: "闪白(fadewhite)" }[promptRules.transitionMode] || promptRules.transitionMode}${promptRules.transitionMs ? `约${promptRules.transitionMs}ms` : ""}`);
        } else if (promptRules.transitionMode === "smart") {
            ruleStyle.push("转场智能(auto)，按场景切换自行选择");
        }
        if (promptRules.pacing && promptRules.pacing !== "标准") ruleStyle.push(`节奏${promptRules.pacing}`);

        // 影策 PromptRules：表演强度/运镜动感 1-10 档 → 5 档硬文本（与手动路径同源）。
        // performanceIntensity 是前端设置项原名，作为兼容别名；两者都不配时按 5（自然档）注入。
        const perfValue = promptOpts.performance ?? promptOpts.performanceIntensity;
        const perfStyle = performanceStyleText(perfValue);
        const cameraMotion = cameraMotionStyleText(promptOpts.cameraDynamics);
        // 表演档位与分镜规则软约束合并成 style，二者不互相覆盖。
        const styleParts = [perfStyle, ...ruleStyle];
        // 写作技能（提示词撰写）真值：优先前端预解析 content，否则按 name 读 SKILL.md；循环外解析一次。
        // 用 resolveSlotSkill：槽位空时回退 drama-06-h3-prompt，保证提示词撰写有方法约束。
        const promptSkill = await this.resolveSlotSkill(promptOpts.textSkills?.prompt, "prompt", dramaId);
        // 提示词类、连续性类、视频生成类长期规则进提示词撰写；分镜/资产规则不进这里。
        const writerRules = await learnedRulesCompact(["prompt", "continuity", "video"], 1800);
        const writerRuleNote = writerRules ? `【用户长期规则·提示词与视频生成】${writerRules}。` : "";

        const shotById = new Map(shots.map(shot => [String(shot.id), shot]));
        const canvasNodes: Array<Record<string, any>> = Array.isArray(canvas.nodes) ? canvas.nodes : [];
        // 台词真值优先取拆镜逐字对白 shot.dialogues（原文字面，不改写）。
        // 新制作台拆镜只写 shot.dialogues、不写 source.utterances，重拆时还会清空 utterances；
        // 若这里直接走 LLM 按画面重编，会用编造台词覆盖原文逐字对白 → 用户投诉「台词乱念」。
        // 只有 shots 完全没有 dialogues（老剧目/真源无对白）时才让 LLM 派生，且仅内存、不写回制作稿。
        if (!utterances.length) {
            const fromDialogues: Array<Record<string, any>> = [];
            for (const shot of shots) {
                const rows = Array.isArray(shot.dialogues) ? shot.dialogues : [];
                for (const row of rows) {
                    const text = String((row as Record<string, any>)?.text || "").trim();
                    const speaker = String((row as Record<string, any>)?.speaker || "").trim();
                    if (!text || !speaker) continue;
                    fromDialogues.push({
                        id: `UTT:${String(shot.id)}:${fromDialogues.length + 1}`,
                        start: { shotId: String(shot.id) }, speakerName: speaker, speaker, text,
                    });
                }
            }
            if (fromDialogues.length) {
                utterances = fromDialogues;
                this.store.log(dramaId, `台词取自拆镜逐字对白 ${fromDialogues.length} 句（shot.dialogues→utterances，仅内存）`);
            } else {
                utterances = await this.deriveUtterancesForPrompts({ segments, shotById, source, promptOpts, dramaId, jobId });
            }
        }
        let written = 0;
        let skipped = 0;
        const only = options.onlyIndexes?.length ? new Set(options.onlyIndexes) : null;

        for (let index = 0; index < segments.length; index += 1) {
            if (only && !only.has(index)) continue;
            const segment = segments[index];
            const segmentId = String(segment.id || "");
            const target = this.findCanvasSegment(canvasNodes, segmentId);
            if (!target) continue;
            // 画布段已有 H3 六段式 prompt 就跳过，避免每段重复跑 LLM（26 段串行要十几分钟）。
            // 旧制作台遗留模板（第N段视频/【视觉与首帧】/9:16）虽非空，但不是 H3 格式，必须重写，
            // 否则会永久跳过、混进交付。forceRewrite 则忽略一切旧 prompt 全量重写。
            if (!options.forceRewrite && isH3Prompt(String(target.prompt || ""))) { skipped += 1; continue; }
            const shotIds: string[] = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [];
            let cursor = 0;
            const writerShots: SegmentWriterShot[] = [];
            const writerShotIds: string[] = [];
            for (const shotId of shotIds) {
                const shot = shotById.get(shotId);
                if (!shot) continue;
                const durationFrames = Math.max(1, Number(shot.duration_frames || 0));
                const startSec = cursor / fps;
                cursor += durationFrames;
                // 一个镜头可能对应 2–3 句台词：全部收集，按 start.localFrame 排序（缺省时保持数组顺序）。
                // 旧代码用 utterances.find 只取第一句，后续台词全丢 → 用户投诉「台词乱念」。
                const shotUtterances = utterances
                    .map((item, order) => ({ item, order, frame: Number(item?.start?.localFrame) }))
                    .filter(entry => String(entry.item?.start?.shotId || entry.item?.shot_id || "") === shotId)
                    .sort((a, b) => {
                        const af = Number.isFinite(a.frame) ? a.frame : Number.POSITIVE_INFINITY;
                        const bf = Number.isFinite(b.frame) ? b.frame : Number.POSITIVE_INFINITY;
                        if (af < bf) return -1;
                        if (af > bf) return 1;
                        return a.order - b.order;
                    })
                    .map(entry => ({
                        text: String(entry.item?.text || entry.item?.dialogue || ""),
                        speaker: String(entry.item?.speaker || entry.item?.speakerName || ""),
                    }));
                const firstUtterance = shotUtterances[0];
                writerShots.push({
                    startSec,
                    endSec: cursor / fps,
                    visual: String(shot.visual || ""),
                    ...(shot.camera?.description ? { camera: String(shot.camera.description) } : {}),
                    // 分镜可拍性字段：不传下去的话，写作模型只能看到「画面」一句，
                    // 起幅构图/镜内运动/原文依据全丢——这正是分镜字段白生成的原因。
                    ...(String(shot.action || "").trim() ? { action: String(shot.action).trim() } : {}),
                    ...(String(shot.imagePrompt || "").trim() ? { imagePrompt: String(shot.imagePrompt).trim() } : {}),
                    ...(String(shot.videoPrompt || "").trim() ? { videoPrompt: String(shot.videoPrompt).trim() } : {}),
                    ...(String(shot.sourceQuote || "").trim() ? { sourceQuote: String(shot.sourceQuote).trim() } : {}),
                    ...(shotUtterances.length ? {
                        dialogues: shotUtterances,
                        // 单条字段保留兼容；buildSegmentDraft 优先读 dialogues，不会重复输出。
                        ...(firstUtterance ? { dialogue: firstUtterance.text, speaker: firstUtterance.speaker } : {}),
                    } : {}),
                });
                writerShotIds.push(shotId);
            }
            if (!writerShots.length) continue;

            // 段参考图绑定由拆镜结构化引用自动派生：场景→角色→道具，按 H3 9 张上限截断。
            // noRefs 真值改为派生结果本身，不再依赖画布上可能过期的旧勾选态。
            const derived = deriveSegmentReferenceBindings(source, director, segmentId, shotIds, shots, sharedStorage);
            let { bindings, referenceOrder, legend, referencesByShot } = derived;
            // // 老手工绑定段保护 v2
            // 回归保护：老手工绑定段（如蟒妻ep2）的 source.shots 没有结构化引用字段，派生必为空；
            // 此时不能把画布上已有的真绑定清空降级成 t2v，否则 forceRewrite 会毁掉已完成剧目。
            // 判定"老数据"：本段任一 shot 都没有 characters/structured 引用字段 且 shotInputs 无道具 → 无可派生信号，
            // 沿用画布段已有 referenceBindings（只保留有 storageKey 的）。
            const segShots = shots.filter(shot => (segment.shot_ids || []).map(String).includes(String(shot.id)));
            const hasStructuredRefs = segShots.some(shot =>
                (Array.isArray(shot.characters) && shot.characters.length > 0)
                || (Array.isArray(director.shotInputs?.[String(shot.id)]?.assetIds) && director.shotInputs[String(shot.id)].assetIds.length > 0));
            if (!bindings.length && !hasStructuredRefs && Array.isArray(target.referenceBindings) && target.referenceBindings.length) {
                const kept = target.referenceBindings.filter((b: any) => b && String(b.storageKey || "").trim());
                if (kept.length) {
                    bindings = kept as typeof bindings;
                    referenceOrder = kept.map((b: any) => String(b.id || "")).filter(Boolean);
                    // 用旧绑定重建 legend，让 writer 知道有 N 张图、按编号输出 <Picture N>，
                    // 否则 prompt 无 Picture 而 bindings 有 N 张 → prerun 判"绑定但提示词无 Picture"。
                    legend = kept.map((b: any, i: number) => {
                        const m = String(b.label || "").match(/Picture\s*(\d+)/i);
                        return { ordinal: m ? Number(m[1]) : i + 1, assetId: String(b.assetId || ""), name: String(b.name || b.assetId || `参考图${i + 1}`), kind: String(b.role || "image"), role: (b.role || "other") as typeof legend[number]["role"] };
                    });
                    referencesByShot = {};
                    this.store.log(dramaId, `${segment.title || index}: 源稿无结构化引用，保留画布已有 ${kept.length} 张参考图绑定（老手工绑定段保护）`, "info");
                }
            }
            const noRefs = bindings.length === 0;
            for (const warning of derived.warnings) {
                this.store.log(dramaId, `${segment.title || index}: ${warning}`, "warn");
            }
            writerShots.forEach((writerShot, shotIndex) => {
                const references = referencesByShot[writerShotIds[shotIndex]] || [];
                if (references.length) writerShot.references = references;
            });

            const independent = Boolean(promptOpts.independent);
            const input: SegmentWriterInput = {
                index,
                count: segments.length,
                title: String(segment.title || `第${index + 1}段`),
                totalSec: cursor / fps,
                shots: writerShots,
                ...(index > 0 && !independent ? { previousEnding: String(segments[index - 1]?.ending || "") } : {}),
                style: styleParts.join("，"),
                cameraMotion,
                ...(promptSkill.skillContent || writerRuleNote ? { skillContent: [writerRuleNote, promptSkill.skillContent || ""].filter(Boolean).join("\n") } : {}),
                ...(promptSkill.skillName ? { skillName: promptSkill.skillName } : {}),
                ...(promptSkill.skillPath ? { skillPath: promptSkill.skillPath } : {}),
                // 交付统一走 H3 六段式（subject_definitions/summary/...）：不传 outputFormat 会退回旧
                // 「第N段视频《…》/【视觉与首帧】/9:16」模板，混入非 H3 提示词。
                outputFormat: "h3-six-section",
                firstFrame: index > 0 && !independent,
                independent,
                noReferenceBindings: noRefs,
                // 六段式模板用 <Picture N> token 定义主体；旧式「参考图N」写法会让 H3 prompt 缺 Picture。
                referenceLegend: legend.map((entry) => `<Picture ${entry.ordinal}>：${entry.name}（${entry.kind}）`),
                referenceCount: bindings.length,
            };
            const prompt = buildSegmentWriterPrompt(input);
            const raw = await this.generateText([prompt.system, "", prompt.user].join("\n"), {
                model: promptOpts.videoPromptModel,
                reasoningEffort: promptOpts.textThinking?.prompt,
            }, dramaId, jobId);
            let cleaned = cleanWrittenPrompt(raw);
            if (!cleaned) continue;

            // C5：按选定视频模型的 promptMaxChars 真值自动精简重跑（对齐影策 condenseSegmentPrompt）
            const videoModel = String(promptOpts.videoModel || "").trim();
            const maxChars = this.resolveVideoPromptMaxChars?.(videoModel);
            const condense = await this.condensePromptToLimit(cleaned, maxChars, (text, limit) =>
                this.generateText([CONDENSE_SYSTEM_PROMPT, "", buildSegmentCondensePrompt(text, limit, noRefs)].join("\n"), {
                    model: promptOpts.videoPromptModel,
                    reasoningEffort: promptOpts.textThinking?.prompt,
                }, dramaId, jobId).then(cleanWrittenPrompt));
            cleaned = condense.text;
            if (noRefs) {
                const before = cleaned;
                cleaned = sanitizeNoReferencePrompt(cleaned);
                if (cleaned !== before) {
                    this.store.log(dramaId, `${segment.title || index}: 本段无真参考图绑定，已清除提示词中的参考图编号（避免视频模型找不到图）`, "warn");
                }
            } else {
                // 有绑定：把写作模板的中文「参考图N」对齐成 H3 提交协议 <Picture N>。
                const aligned = alignPromptPictures(cleaned, bindings.length);
                cleaned = aligned.text;
                for (const warning of aligned.warnings) {
                    this.store.log(dramaId, `${segment.title || index}: ${warning}`, "warn");
                }
            }
            if (!condense.check.ok) {
                this.store.log(dramaId, `${segment.title || index}: 提示词 ${condense.check.chars} 字，自动精简 ${condense.count} 次后仍超过模型上限 ${condense.check.maxChars} 字，请手动精简`, "warn");
            } else if (condense.count > 0) {
                this.store.log(dramaId, `${segment.title || index}: 提示词超长，自动精简 ${condense.count} 次后 ${condense.check.chars}/${condense.check.maxChars} 字`, "info");
            }

            // taskMode 固定 ref2va：这是剧目的出片模式，与单段是否恰好派生到参考图无关。
            // 旧逻辑 noRefs 时降级 t2v，会让「场景图还没绑上」的段悄悄走纯文生视频，
            // 参考图彻底不进片。参考图缺失应当暴露出来补绑，而不是用 t2v 掩盖。
            const taskMode = canonicalH3TaskMode("ref2va");
            const patch: Record<string, unknown> = {
                prompt: cleaned,
                referenceBindings: bindings,
                referenceOrder,
                taskMode,
            };
            // expectedRevision 即时重读：并行/外部编辑后仍用当前 revision 做 CAS。
            const project = await this.getCanvasProject(canvas.id);
            await this.request("POST", `/canvas/projects/${encodeURIComponent(canvas.id)}/ops`, {
                operationId: randomUUID(),
                expectedRevision: Number(project?.revision || 0),
                operations: [{
                    type: "update_h3_segment",
                    nodeId: target.nodeId,
                    segmentId: target.segmentId,
                    patch,
                    // 清掉旧勾选态，避免 legacy refItems 与新派生的 referenceBindings 双源打架。
                    patchDelete: ["refItems"],
                }],
            });
            written += 1;
        }
        if (!written && !skipped) throw new Error("PROMPTS_NOTHING_WRITTEN: 没有段提示词写回画布");
        return { segments: segments.length, written, skipped };
    }

    /**
     * 强制重写单集所有段提示词：忽略画布已有的旧 prompt，逐段用真 LLM 重写并经 update_h3_segment 写回。
     * dramaId 从 episode 反查（与 runVideo 一样从 GET /drama/episodes/:id 取 episode 信息），
     * 再以 forceRewrite=true 走与全自动 prompts 段完全相同的 runPrompts 链路。
     */
    async rewritePrompts(episodeId: string, onlyIndexes?: number[]): Promise<{ segments: number; written: number; skipped: number }> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const dramaId = String(episodeRes?.episode?.dramaId || "");
        if (!dramaId) throw new Error("EPISODE_DRAMA_MISSING: 分集缺少所属剧目 ID，无法强制重写提示词");
        // 显式重写提示词不被「手动暂停」挡住，但绝不改流水线 status / pause_reason：
        // 之前 upsert(status:running) 不清 pause_reason，制造「界面暂停、调度器仍出片」的分裂状态。
        // 用内存豁免集合让重写提交的文本任务过关；dispatch 仍按 store.status=paused 拒绝派发新作业。
        this.promptRewriteBypass.add(dramaId);
        try {
            // 手动「重写提示词」路由没有作业行，故不传 jobId；job.task_id 保持 null，不伪造作业归属。
            const result = await this.runPrompts(episodeId, dramaId, { forceRewrite: true, ...(onlyIndexes?.length ? { onlyIndexes } : {}) });
            return {
                segments: Number(result.segments || 0),
                written: Number(result.written || 0),
                skipped: Number(result.skipped || 0),
            };
        } finally {
            this.promptRewriteBypass.delete(dramaId);
        }
    }

    /**
     * 按章编辑原文 →「确定(保存并重新改编)」的服务端入口（对齐影策 rescript）：
     * drama_routes → drama_actions CancelQueuedDramaJobs + ApplyDramaScript(stage:script) + requestDramaWork。
     * 本地做法：反查 dramaId → 重置本集全部阶段作业为 queued（清 task/attempt/error，透传 instruction）
     * → 清掉这些作业的退避计时 → 确保流水线 running → 幂等补齐作业 → wake 立即重跑。
     * script 作业会走 runScript：script-proposal → 写 synopsis/fullPlot → 清旧镜+整批重拆 → promoteToCanvas。
     * instruction/model 透传进 script job payload，runScript 真消费，不经前端假修复。
     */
    async rescript(episodeId: string, opts?: { instruction?: string; model?: string; options?: DramaPipelineRuntimeOptions }): Promise<{ dramaId: string; episodeId: string; resetJobs: number; status: string }> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const dramaId = String(episodeRes?.episode?.dramaId || "");
        if (!dramaId) throw new Error("EPISODE_DRAMA_MISSING: 分集缺少所属剧目 ID，无法重新改编");
        // 重新改编可携带本次制作设置：只覆盖下发过的键，其它沿用当前运行期设置。
        if (opts?.options) {
            const merged = { ...this.optionsOf(dramaId), ...opts.options };
            this.runOptions.set(dramaId, merged);
            try { this.settingsStore?.set(`drama.pipeline.options.${dramaId}`, merged); } catch { /* 持久化失败不影响本次运行 */ }
        }
        const scriptPatch: Record<string, unknown> = {};
        if (String(opts?.instruction || "").trim()) scriptPatch.instruction = String(opts!.instruction).trim().slice(0, 2000);
        if (String(opts?.model || "").trim()) scriptPatch.model = String(opts!.model).trim();
        // 幂等：同一集重复改编只是再次把同一批 dedupe job 重置为 queued，不会堆重复作业。
        const resetJobs = this.store.resetJobsForEpisode(dramaId, episodeId, scriptPatch);
        // 重置后旧作业的退避计时不得继续挡住重跑。
        for (const job of this.store.listJobs(dramaId)) {
            if (job.episode_id === episodeId) this.retryAt.delete(job.id);
        }
        // 即便流水线处于 paused/completed，显式改编也要能重跑本集：清暂停哨兵并重新置 running。
        this.paused.delete(dramaId);
        this.store.upsert({ dramaId, status: "running" });
        await this.plan(dramaId); // dedupe_key 已存在的跳过，只补缺失阶段作业
        this.store.log(dramaId, `按章改编重拆镜：已重置本集 ${resetJobs} 个阶段作业并重新入队（script→assets→prompts→video→render）`, "info", episodeId);
        this.wake(dramaId);
        return { dramaId, episodeId, resetJobs, status: "running" };
    }

    /**
     * 剧目级分辨率真下发：把档位+画幅换算成 H3 段真实字段（aspectRatio/megapixels），
     * 用 update_h3_segment 写进每个 H3 节点的段保存值——这是唯一能真正影响出片的路径。
     * 只经请求 params 传 H3_PARAM_KEYS 会被 h3-runner 的 H3_UI_PARAMETER_MISMATCH 守卫挡下
     * （防止 MCP/外部调用静默改面板与出片）；写保存值后前端面板显示与实际出片一致，不是假开关。
     *
     * 画幅是剧目级单一来源（对齐影策 production.Settings.AspectRatio）：即使没有分辨率档位，
     * 也必须把剧目画幅写进每一段。段级 aspectRatio 只是派生值，不允许各存一份漂移。
     * tier 为空时只改 aspectRatio，megapixels 保留段原值（不写键即不改），避免顺手改动像素量。
     */
    private async applyVideoResolution(canvasId: string, h3Nodes: Array<Record<string, any>>, tier: unknown, aspectRatio: unknown): Promise<{ segments: number; size: string; resolution: string; megapixels: number; aspectRatio: string } | null> {
        const tierText = String(tier ?? "").trim();
        const aspectText = String(aspectRatio ?? "").trim();
        if (!tierText && !aspectText) return null;
        const effective = tierText ? dramaVideoResolutionToH3(tierText, aspectText) : null;
        if (tierText && !effective) return null;
        // 没有档位时只有画幅：aspectRatio 用规范化的横竖版，尺寸由各段 megapixels 决定。
        const targetAspect = effective?.aspectRatio || canonicalH3AspectRatio(aspectText);
        if (!targetAspect) return null;
        const project = await this.getCanvasProject(canvasId);
        const operations: Array<Record<string, unknown>> = [];
        for (const node of h3Nodes) {
            const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments as Array<Record<string, any>> : [];
            for (const segment of segments) {
                const id = String(segment?.id || "");
                if (!id) continue;
                const patch: Record<string, unknown> = { aspectRatio: targetAspect };
                if (effective) patch.megapixels = effective.megapixels;
                // 画幅/像素量属于人工指定值：显式登记后不会被插件全局默认值覆盖。
                const manual = new Set<string>(Array.isArray(segment.h3ParameterOverrides) ? segment.h3ParameterOverrides.map(String) : []);
                manual.add("aspectRatio");
                if (effective) manual.add("megapixels");
                patch.h3ParameterOverrides = [...manual];
                operations.push({ type: "update_h3_segment", nodeId: String(node.id), segmentId: id, patch });
            }
        }
        if (operations.length) {
            await this.request("POST", `/canvas/projects/${encodeURIComponent(canvasId)}/ops`, {
                operationId: randomUUID(),
                expectedRevision: Number(project?.revision || 0),
                operations,
            });
        }
        return {
            segments: operations.length,
            size: effective?.size || "",
            resolution: effective?.resolution || "",
            megapixels: effective?.megapixels || 0,
            aspectRatio: targetAspect,
        };
    }

    /** video 段：H3 runFromCurrent → 轮询 task 至终态。 */
    private async runVideo(episodeId: string, job: JobRow): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const canvas = (episodeRes?.canvas || null) as Record<string, any> | null;
        if (!canvas?.id) throw new Error("EPISODE_CANVAS_MISSING");
        const canvasNodes: Array<Record<string, any>> = Array.isArray(canvas.nodes) ? canvas.nodes : [];
        // 拆镜编译后 segments 会分散到多个 H3 节点（按场景）。必须对每个有 segment 的节点
        // 各自跑 h3-run，只处理第一个会漏掉其余节点的 Clip（之前 video 段的核心 bug）。
        const h3Nodes = canvasNodes.filter(node =>
            String(node?.type || "").includes("h3") && Array.isArray(node?.metadata?.segments) && (node.metadata.segments as any[]).length > 0);
        if (!h3Nodes.length) throw new Error("H3_NODE_MISSING: 画布没有 H3 节点，先跑 script 段完成拆镜编译");

        const videoOpts = this.optionsOf(String(job.drama_id || ""));
        const selectedVideoModel = String(videoOpts.videoModel || "").trim();
        const videoParams: Record<string, unknown> = {};
        if (selectedVideoModel) {
            videoParams.selectedVideoModelEnabled = true;
            videoParams.selectedVideoModel = selectedVideoModel;
        }
        if (videoOpts.referenceLimit && videoOpts.referenceLimit > 0) {
            videoParams.referenceLimit = videoOpts.referenceLimit;
        }
        // 剧目级画幅是单一来源（对齐影策 production.Settings.AspectRatio）：无论有没有分辨率档位，
        // 都先把剧目画幅写进每个 H3 段的保存值，段级 aspectRatio 只能是它的派生值。
        // 档位存在时再联动 megapixels，得到真实出片尺寸。
        // 取值优先级：本次运行透传 > 制作稿 settings.videoAspectRatio（持久真值）。
        const resolutionTier = String(videoOpts.videoResolution || "").trim();
        const dramaAspect = String(videoOpts.videoAspectRatio || "").trim()
            || String(((await this.getProduction(episodeId)).production as any)?.draft?.settings?.videoAspectRatio || "").trim();
        let resolutionApplied: { segments: number; size: string; resolution: string; megapixels: number; aspectRatio: string } | null = null;
        if (resolutionTier || dramaAspect) {
            resolutionApplied = await this.applyVideoResolution(String(canvas.id), h3Nodes, resolutionTier, dramaAspect);
            if (resolutionApplied) {
                if (resolutionApplied.size) videoParams.size = resolutionApplied.size;
                if (resolutionApplied.resolution) videoParams.resolution = resolutionApplied.resolution;
                // 引擎「H3 展开流」暴露的是 width/height 直连像素字段，不认 aspectRatio/megapixels
                // （dry_run 实测 params_ignored=['aspectRatio','megapixels']）。画幅只有换算成宽高才真正生效。
                const dims = dramaVideoPixels(resolutionApplied.aspectRatio, resolutionApplied.megapixels);
                if (dims) {
                    videoParams.width = dims.width;
                    videoParams.height = dims.height;
                }
                this.store.log(String(job.drama_id || ""),
                    `剧目级画幅下发 ${resolutionApplied.aspectRatio}${resolutionTier ? `/${resolutionTier} megapixels=${resolutionApplied.megapixels}` : "（未设档位，像素量沿用各段）"}${dims ? ` → width=${dims.width} height=${dims.height}` : ""}，写入 ${resolutionApplied.segments} 段（真实出片参数）`);
            } else {
                this.store.log(String(job.drama_id || ""), `剧目级画幅/档位 ${dramaAspect || "-"}/${resolutionTier || "-"} 无法解析，已回退模型默认`, "warn");
            }
        } else {
            this.store.log(String(job.drama_id || ""), "剧目未设置交付画幅（settings.videoAspectRatio），各段沿用各自保存值，可能出现比例不一致", "warn");
        }
        const results: Array<Record<string, unknown>> = [];
        const dramaId = String(job.drama_id || "");
        for (const node of h3Nodes) {
            // 暂停即停：不再为下一个 H3 节点提交新任务；已提交的那条会被 pause() 的取消扫描处理。
            await this.assertNotPaused(dramaId);
            const started = await this.request("POST", "/canvas/generation", {
                mode: "video",
                operation: "h3-run",
                projectId: canvas.id,
                nodeId: node.id,
                runFromCurrent: true,
                skipCompleted: true,
                ...(Object.keys(videoParams).length ? { params: videoParams } : {}),
            });
            const taskId = String(started?.taskId || "");
            if (!taskId) throw new Error(`H3_RUN_NO_TASK: 节点 ${node.id}`);
            this.store.markRunning(job.id, taskId);
            await this.assertNotPaused(dramaId, taskId);
            const task = await this.waitTask(taskId, false, dramaId);
            if (dramaId) this.chargeGeneration(dramaId, "video", task);
            results.push({ nodeId: node.id, taskId, status: task?.status, result: task?.result || null });
        }
        return { nodes: h3Nodes.length, results };
    }

    /** render 段：收集各段视频 storageKey → video-concat → finalResource 写回制作稿。 */
    private async runRender(episodeId: string, job: JobRow): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const canvas = (episodeRes?.canvas || null) as Record<string, any> | null;
        const canvasNodes: Array<Record<string, any>> = Array.isArray(canvas?.nodes) ? canvas!.nodes : [];
        // 剪辑与合成类规则没有可自动执行的 ffmpeg 参数：记入本段流水线事件，供合成与验收时核对。
        const renderRules = await learnedRulesCompact(["render"], 1200);
        if (renderRules) this.store.log(String(job.drama_id || ""), `剪辑与合成长期规则：${renderRules}`, "info");
        // 每段只取当前有效产物（复用 final-composer 的同一口径）；results[] 是审计历史，
        // 把全部历史 storageKey 送进 concat 会让重试过的段在成片里重复出现。
        const unique = collectFinalVideos(canvas);
        const recoveredKey = String(this.store.jobPayload(job).renderRecoveryStorageKey || "");
        if (!unique.length && !recoveredKey) {
            throw new Error("RENDER_NO_VIDEO: 画布还没有可用的分镜视频 storageKey");
        }

        // 影策：整集所有段视频生成完才进 render，不能拿一段视频合成半成品。
        // 与前端 composeReady 同口径：每段要有当前/历史产物且未被标成 inputOutdated；
        // 锁定的段显式跳过。已合成过的恢复点允许直接重放写回，不再要求产物仍在画布上。
        const productionForRender = (await this.getProduction(episodeId)).production as any;
        const groups = Array.isArray(productionForRender?.published?.clipGroups) ? productionForRender.published.clipGroups
            : Array.isArray(productionForRender?.draft?.clipGroups) ? productionForRender.draft.clipGroups : [];
        const sources = Array.isArray(productionForRender?.published?.director?.source?.segments) ? productionForRender.published.director.source.segments
            : Array.isArray(productionForRender?.draft?.director?.source?.segments) ? productionForRender.draft.director.source.segments : [];
        const readiness = renderReadiness(canvas, groups as Array<Record<string, unknown>>, sources as Array<Record<string, unknown>>);
        if ((readiness.missing || readiness.stale) && !recoveredKey) {
            throw Object.assign(new Error(`RENDER_SEGMENTS_NOT_READY: 本集 ${readiness.total} 段中 ${readiness.missing} 段未出片、${readiness.stale} 段已过期，暂不合成`), { code: "RENDER_SEGMENTS_NOT_READY" });
        }
        let storageKey = recoveredKey;
        let taskId = String(this.store.jobPayload(job).renderRecoveryTaskId || "");
        const dramaId = String(job.drama_id || "");
        if (!storageKey) {
            await this.assertNotPaused(dramaId);
            const started = await this.request("POST", "/agent/video-concat/tasks", {
                videos: unique,
                layout: "sequence",
                longEdge: "auto",
            });
            taskId = String(started?.task?.id || started?.taskId || "");
            if (!taskId) throw new Error("VIDEO_CONCAT_NO_TASK");
            this.store.markRunning(job.id, taskId);
            await this.assertNotPaused(dramaId, taskId, true);
            const task = await this.waitTask(taskId, true, dramaId);
            storageKey = String(task?.result?.media?.storageKey || task?.result?.storageKey || task?.result?.media?.url || "");
            if (!storageKey) throw new Error("VIDEO_CONCAT_NO_RESULT: 合成任务没有产出 storageKey");
            // 合成成功即落恢复点；后续写回若失败，重放时跳过合成直接写回。
            this.store.setJobRecovery(job.id, { renderRecoveryStorageKey: storageKey, renderRecoveryTaskId: taskId });
        } else {
            this.store.log(String(job.drama_id || ""), `render 复用已合成成片 storageKey=${storageKey}（task=${taskId}），跳过二次合成`, "info", episodeId, job.id);
        }

        const production = productionForRender;
        await this.productionOps(episodeId, production.revision, [{
            type: "set_director_workflow",
            patch: { finalResource: { storageKey, at: new Date().toISOString(), stale: false } },
        }]);
        // 收尾对账：compile/apply 会从空的 pictureBindings 重建 assets 把参考图清掉；
        // 全部阶段跑完后从画布实体节点把图重新贴回 draft.assets（此时不再有 compile）。
        let restoredAssets = 0;
        try {
            const restored = await this.request("POST", "/drama/pipeline/assets/restore", { episodeId });
            restoredAssets = Number(restored?.restored || 0);
        } catch (error) {
            this.store.log(job.drama_id, `资产参考图收尾对账失败（不阻断）：${errText(error)}`, "warn");
        }
        return { taskId, storageKey, videos: unique.length, restoredAssets };
    }

    // ── 编译链 / 通用能力 ───────────────────────────────────────────────

    /** 发布 → 编译 → 应用 → 再发布 → 准备节点 → 同步 Clip。 */
    private async promoteToCanvas(episodeId: string): Promise<void> {
        const base = `/drama/episodes/${encodeURIComponent(episodeId)}/production`;
        let production = (await this.getProduction(episodeId)).production as any;
        await this.request("POST", `${base}/publish`, {
            operationId: randomUUID(), expectedRevision: Number(production.revision || 0), stage: "director",
        });

        production = (await this.getProduction(episodeId)).production as any;
        const operationId = `pipeline-compile-${randomUUID()}`;
        const compile = await this.request("POST", `${base}/compile`, {
            expectedRevision: Number(production.revision || 0), operationId,
        });
        const compilation = await this.waitCompilation(episodeId, String(compile?.compilation?.operationId || operationId));
        const preparedId = String(compilation?.nextAction?.input?.preparedId || compilation?.preparedId || "");
        if (!preparedId) throw new Error(`COMPILE_NO_PREPARED_ID: ${compilation?.blockingDiagnostic?.message || ""}`);
        await this.request("POST", `${base}/apply-compilation`, { preparedId });

        production = (await this.getProduction(episodeId)).production as any;
        await this.request("POST", `${base}/publish`, {
            operationId: randomUUID(), expectedRevision: Number(production.revision || 0), stage: "director",
        });

        const readiness = await this.request("GET", `${base}/readiness`);
        const targets: string[] = (Array.isArray(readiness?.readiness?.targets) ? readiness.readiness.targets : [])
            .filter((target: any) => target?.kind === "segment")
            .map((target: any) => String(target.id));
        production = (await this.getProduction(episodeId)).production as any;
        if (targets.length) {
            await this.request("POST", `${base}/prepare-targets`, {
                expectedRevision: Number(production.revision || 0), targets, operationId: `pipeline-prepare-${randomUUID()}`,
            });
        }
        await this.request("POST", `${base}/sync-clips`, {});
    }

    private async waitCompilation(episodeId: string, operationId: string): Promise<Record<string, any>> {
        const base = `/drama/episodes/${encodeURIComponent(episodeId)}/production/compilations/${encodeURIComponent(operationId)}`;
        const deadline = Date.now() + TASK_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const res = await this.request("GET", `${base}?view=status`);
            const compilation = res?.compilation as Record<string, any> | undefined;
            const status = String(compilation?.status || "");
            if (status === "succeeded") return compilation || {};
            if (status === "failed" || status === "blocked" || status === "interrupted") {
                throw new Error(`COMPILE_${status.toUpperCase()}: ${compilation?.blockingDiagnostic?.message || status}`);
            }
            await this.sleep(TASK_POLL_MS);
        }
        throw new Error("COMPILE_TIMEOUT");
    }

    /**
     * 文本生成子任务。jobId 是所属流水线作业：拿到 taskId 后立刻写回 job.task_id，
     * 让队列详情能按本作业关联日志/结果（不再拿整集统计冒充）。
     * 注意：一个阶段作业可能派生多个文本任务（逐段 writer/精简），task_id 只有一列且
     * markRunning 是覆盖写 → runtimeTaskId 语义是「最近一次子任务」，追不到全部子任务。
     * markRunning 自身带 status='running' 条件，暂停/重排后的迟到写不会复活作业。
     */
    private async generateText(prompt: string, overrides?: { model?: string; reasoningEffort?: string }, dramaId?: string, jobId?: string): Promise<string> {
        const fallback = this.resolveTextModel?.() || "";
        const chosen = String(overrides?.model || "").trim();
        const model = chosen || fallback;
        if (!model) throw new Error("PIPELINE_TEXT_MODEL_MISSING: 请在设置里选择文本模型");
        const effort = String(overrides?.reasoningEffort || "").trim();
        const started = await this.request("POST", "/canvas/generation", {
            mode: "text",
            model,
            prompt,
            count: 1,
            ...(effort && effort !== "auto" ? { params: { reasoningEffort: effort } } : {}),
        });
        const taskId = String(started?.taskId || "");
        if (!taskId) throw new Error("TEXT_GENERATION_NO_TASK");
        if (jobId) this.store.markRunning(jobId, taskId);
        await this.assertNotPaused(dramaId || "", taskId);
        const task = await this.waitTask(taskId, false, dramaId);
        if (dramaId) this.chargeGeneration(dramaId, "text", task);
        const text = (Array.isArray(task?.result?.texts) ? task.result.texts : [])
            .map((item: any) => String(item?.content || "")).join("\n").trim();
        if (!text) throw new Error("TEXT_GENERATION_EMPTY");
        return text;
    }

    /** 源剧本无对白时运行期内存派生；失败/解析失败一律 []，不写回 draft.source.utterances。
     *  jobId：仅用于把派生文本任务的 task_id 写回作业（不是本集/本作业全部任务）。 */
    private async deriveUtterancesForPrompts(args: {
        segments: Array<Record<string, any>>;
        shotById: Map<string, Record<string, any>>;
        source: Record<string, any>;
        promptOpts: DramaPipelineRuntimeOptions;
        dramaId: string;
        jobId?: string;
    }): Promise<Array<Record<string, any>>> {
        const { segments, shotById, source, promptOpts, dramaId, jobId } = args;
        const names = knownCharacterNames(source, Array.from(shotById.values()));
        const shotRefs = flattenPromptShots(segments, shotById, names);
        if (!names.length || !shotRefs.length) {
            this.store.log(dramaId, "源剧本无对白且无可用的已知角色/镜头素材，跳过运行期补对白", "warn");
            return [];
        }
        try {
            // model = promptOpts.videoPromptModel（空则 generateText 内部回退 resolveTextModel）
            // reasoningEffort = promptOpts.textThinking?.prompt（与 writer/condense 同源）
            const raw = await this.generateText([DIALOGUE_SYSTEM_PROMPT, "", buildDialogueUserPrompt(shotRefs, names)].join("\n"), {
                model: promptOpts.videoPromptModel,
                reasoningEffort: promptOpts.textThinking?.prompt,
            }, dramaId, jobId);
            const derived = parseDerivedUtterances(raw, shotRefs, names, source);
            this.store.log(dramaId, `运行期补对白：${derived.length}/${shotRefs.length} 个镜头（仅内存，不写回制作稿）`);
            return derived;
        } catch (error) {
            this.store.log(dramaId, `运行期补对白失败，保持无对白继续写提示词：${errText(error)}`, "warn");
            return [];
        }
    }

    /** 段是否真有可用参考图：画布 H3 段绑定是视频生成真值；t2v 不消费参考图。 */
    private hasRealReferenceBindings(target: { referenceBindings?: unknown; refItems?: unknown; taskMode?: string }): boolean {
        if (String(target?.taskMode || "").toLowerCase() === "t2v") return false;
        const bindings = Array.isArray(target.referenceBindings) ? target.referenceBindings : [];
        const items = Array.isArray(target.refItems) ? target.refItems : [];
        const active = items.length ? items : bindings;   // refItems 是 UI 勾选后的生效集合
        return active.some((item: any) => item && item.enabled !== false && String(item.storageKey || "").trim() !== "");
    }

    /**
     * C5 精简循环（对齐影策 condenseSegmentPrompt）：超 maxChars 时反复让文本模型精简，
     * 不截断（截断会丢末尾镜头与台词）；精简结果没变短/为空即停，最多 PROMPT_CONDENSE_ATTEMPTS 次。
     * writer(text, limit) 负责调文本模型并返回精简后的正文（已 cleanWrittenPrompt）。
     */
    async condensePromptToLimit(
        text: string,
        maxChars: number | undefined,
        writer: (text: string, limit: number) => Promise<string>,
    ): Promise<{ text: string; count: number; check: PromptLengthCheck }> {
        let current = text;
        let count = 0;
        let check = checkPromptLength(current, maxChars);
        while (!check.ok && count < PROMPT_CONDENSE_ATTEMPTS) {
            let next: string;
            try {
                next = await writer(current, check.maxChars);
            } catch {
                break; // 精简任务提交/执行失败：保留上一版，不无限重试
            }
            if (!next || Array.from(next).length >= Array.from(current).length) break;
            current = next;
            count += 1;
            check = checkPromptLength(current, maxChars);
        }
        return { text: current, count, check };
    }

    /** 轮询画布/agent 任务；agent=true 走 /agent/runtime/tasks/:id，否则走 /tasks/:id。 */
    private async waitTask(taskId: string, agent: boolean, dramaId?: string): Promise<Record<string, any>> {
        const path = agent ? `/agent/runtime/tasks/${encodeURIComponent(taskId)}` : `/tasks/${encodeURIComponent(taskId)}`;
        const deadline = Date.now() + TASK_TIMEOUT_MS;
        while (Date.now() < deadline) {
            // 暂停不再中断已派发作业的等待（影策：暂停后任务照常完成并回写）。
            const res = await this.request("GET", path);
            const task = (res?.task || {}) as Record<string, any>;
            const status = String(task?.status || "");
            if (["succeeded", "success", "completed", "done"].includes(status)) return task;
            if (["failed", "error", "canceled", "cancelled", "interrupted"].includes(status)) {
                throw new Error(`TASK_${status.toUpperCase()}: ${task?.error || status}`);
            }
            await this.sleep(TASK_POLL_MS);
        }
        throw new Error("TASK_TIMEOUT");
    }

    // ── 闸门操作 / 状态 ─────────────────────────────────────────────────

    /**
     * 把持久化的 episode reviewApproval（director.workflow.reviewApproval.approvedAt）
     * 对账成审批闸门放行。只增不减；已放行的集跳过 HTTP，避免每 tick 全量拉取。
     * 这样即使 approve 记录丢失（老数据 / 直接改制作稿），已批准的集也不会被重复要求审批。
     */
    private async reconcileReviewApprovals(dramaId: string): Promise<void> {
        const now = Date.now();
        const last = this.reviewReconcileAt.get(dramaId) || 0;
        if (now - last < REVIEW_RECONCILE_COOLDOWN_MS) return;

        try {
            const listing = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
            const episodes: Array<Record<string, any>> = Array.isArray(listing?.episodes) ? listing.episodes : [];
            let synced = 0;
            for (const ep of episodes) {
                const episodeId = String(ep?.id || "");
                if (!episodeId || this.store.hasApproval(dramaId, "approve", episodeId)) continue;
                try {
                    const prod = await this.getProduction(episodeId);
                    const approval = prod?.production?.draft?.director?.workflow?.reviewApproval as
                        | { approvedAt?: string; approved?: boolean } | undefined;
                    if (approval && (approval.approvedAt || approval.approved === true)) {
                        this.approve(dramaId, episodeId, { skipReadinessCheck: true }); // 真值是制作稿 approvedAt，不被本地作业进度反卡
                        synced += 1;
                    }
                } catch { /* 单集读取失败不阻断其余集 */ }
            }
            // 只有 listing 成功才记时间戳；失败（含后端 HTTP 尚未就绪）不记，下一 tick 自动重试。
            this.reviewReconcileAt.set(dramaId, now);
            if (synced) this.store.log(dramaId, `持久化 reviewApproval 对账：恢复 ${synced} 条审批放行`);
        } catch {
            this.reviewReconcileAt.delete(dramaId);
        }
    }

    /**
     * 审批放行，带前置校验（对齐影策 drama_actions.go:210 ApproveDramaEpisode）：
     * - 样片（第1集）视频作业未 succeeded（=成片未合成写回）→ 拒绝「样片完成后才能确认样片」；
     * - every 模式的其它集，提示词作业未 succeeded（=段提示词未全部就绪）→ 拒绝
     *   「所有剧情段视频提示词就绪后才能确认」。
     * 作业成功记录就是影策 finalResource / dramaPromptReady 在本地的真值源，不另造数据。
     * skipReadinessCheck 仅供持久化 reviewApproval 的对账恢复：真值是制作稿里已批准的
     * approvedAt，而不是本地作业进度，老数据/直接改稿也可能没有对应作业记录。
     */
    approve(dramaId: string, episodeId: string, opts?: { skipReadinessCheck?: boolean }): void {
        if (!opts?.skipReadinessCheck) this.assertApproveReady(dramaId, episodeId);
        // 先落持久化表（重启不丢），再更新内存镜像与唤醒调度。
        this.store.addApproval(dramaId, "approve", episodeId);
        if (!this.approvals.has(dramaId)) this.approvals.set(dramaId, new Set());
        this.approvals.get(dramaId)!.add(episodeId);
        // 样片（第1集）批准 = 全局放行信号，其余集才能进入视频阶段（对齐影策 SampleApproved）。
        if (this.isSampleEpisode(dramaId, episodeId)) {
            this.store.addApproval(dramaId, "approve", SAMPLE_APPROVED_TARGET);
            this.approvals.get(dramaId)!.add(SAMPLE_APPROVED_TARGET);
        }
        this.store.log(dramaId, `审批放行 episode=${episodeId}（已持久化）`);
        this.wake(dramaId);
    }

    /** 样片（第1集）是否已批准：哨兵优先，并兼容只写了 episodeId 的老数据。 */
    private isSampleApproved(dramaId: string, approvals: Set<string>): boolean {
        if (approvals.has(SAMPLE_APPROVED_TARGET)) return true;
        for (const job of this.store.listJobs(dramaId)) {
            if (Number(this.store.jobPayload(job).episodeNumber || 0) === 1
                && job.episode_id && approvals.has(job.episode_id)) return true;
        }
        return false;
    }

    /** 某集是否为第1集（样片）：真值取 job payload 的 episodeNumber。 */
    private isSampleEpisode(dramaId: string, episodeId: string): boolean {
        return this.store.listJobs(dramaId).some(job =>
            job.episode_id === episodeId && Number(this.store.jobPayload(job).episodeNumber || 0) === 1);
    }

    /** approve 前置校验：对应阶段的作业必须已 succeeded。 */
    private assertApproveReady(dramaId: string, episodeId: string): void {
        const reviewMode = this.store.get(dramaId)?.review_mode || "auto";
        const succeeded = this.store.listJobs(dramaId, ["succeeded"]);
        if (this.isSampleEpisode(dramaId, episodeId)) {
            if (!succeeded.some(job => job.episode_id === episodeId && job.stage === "render")) {
                throw new Error("样片完成后才能确认样片");
            }
            return;
        }
        if (reviewMode === "every" && !succeeded.some(job => job.episode_id === episodeId && job.stage === "prompts")) {
            throw new Error("所有剧情段视频提示词就绪后才能确认");
        }
    }

    releaseMedia(dramaId: string, target: string): void {
        // 先落持久化表（重启不丢），再更新内存镜像与唤醒调度。
        this.store.addApproval(dramaId, "release", target);
        if (!this.releasedMedia.has(dramaId)) this.releasedMedia.set(dramaId, new Set());
        this.releasedMedia.get(dramaId)!.add(target);
        this.store.log(dramaId, `媒体放行 target=${target}（已持久化）`);
        this.wake(dramaId);
    }

    /**
     * 用户暂停（对齐影策 SetDramaRunning(false)）：只停止派发新作业。
     * 已派发的流水线作业保持 running、生成任务不取消，照常跑完并回写终态；
     * resume 只把状态改回 running，各集按当前 stage 接着走，不重排全部作业。
     */
    async pause(dramaId: string, reason = "manual"): Promise<DramaPipelinePauseReport> {
        // 影策语义：暂停只是停止派发新作业（dispatch 被 status/paused 哨兵挡住），
        // 已派发的作业与生成任务照常跑完并回写——不取消、不退回 queued。
        // 否则段会停在「生成中」，且点继续时所有集的作业会一起重排开跑。
        this.paused.set(dramaId, reason);
        const existing = this.store.get(dramaId);
        if (existing) this.store.setStatus(dramaId, "paused", reason);
        else this.store.upsert({ dramaId, status: "paused", pauseReason: reason });
        const running = this.store.listJobs(dramaId, ["running"]).length;
        this.store.log(dramaId, `流水线暂停：${reason}；停止派发新作业，${running} 个已派发作业继续执行并回写`);
        const report: DramaPipelinePauseReport = { reason, at: new Date().toISOString(), pausedJobs: 0, canceledTasks: 0, canceledQueuedTasks: 0, alreadyTerminal: 0, failedTasks: 0, failures: [], truncated: false };
        this.pauseReports.set(dramaId, report);
        this.wake(dramaId);
        return report;
    }

    resume(dramaId: string): void {
        if (this.budgetHeld(dramaId)) {
            // 预算耗尽时不允许「恢复」绕过闸门；须用更高/新的 budgetMicrocredits 重新 start。
            this.store.log(dramaId, `预算已耗尽（${this.budgetOf(dramaId).spentMicrocredits} 微积分），拒绝恢复；请调整 budgetMicrocredits 后重新 start`, "warn");
            return;
        }
        this.assertModelsReady(dramaId); // C4：恢复=重新开工，同样拒绝缺模型能力
        // 暂停期间 tick 不跑，孤儿 running job（执行 Promise 已随重载/暂停消失）不会被回收。
        // 恢复前先按 TTL 回收这些卡死作业，否则它们永远占着 running，让整条链无法继续。
        const recovered = this.store.recoverStaleRunning(dramaId, STALE_JOB_TTL_MS);
        if (recovered) this.store.log(dramaId, `恢复时回收 ${recovered} 个卡死的 running 作业并重新排队`, "warn");
        // 先清内存哨兵再置 running：否则 dispatch 仍会把本剧判成暂停。
        this.paused.delete(dramaId);
        this.store.setStatus(dramaId, "running", null);
        this.store.log(dramaId, "流水线恢复");
        this.wake(dramaId);
    }

    /** 是否处于暂停态：内存哨兵优先（暂停立刻生效），DB status 兜底（重启/多入口一致）。 */
    private isPaused(dramaId: string): boolean {
        if (!dramaId) return false;
        // 显式重写提示词期间豁免：让重写提交的文本任务不受暂停闸门拦截。
        // dispatch 仍按 store.status !== running 拒绝派发新作业，所以不会触发出片。
        if (this.promptRewriteBypass.has(dramaId)) return false;
        if (this.paused.has(dramaId)) return true;
        // 单测会注入只实现部分方法的假 store：缺少 get 时按未暂停处理。
        const lookup = (this.store as Partial<PipelineStore>).get;
        return typeof lookup === "function" ? lookup.call(this.store, dramaId)?.status === "paused" : false;
    }

    /**
     * 影策语义下暂停只挡 dispatch 的派发，不中断已派发作业；这里保留入口是为了不改动
     * 各执行阶段的控制流，但不再抛错、也不取消任务——已提交的生成照常跑完并回写。
     */
    private async assertNotPaused(_dramaId: string, _taskId?: string, _agent = false): Promise<void> {
        return;
    }


    /**
     * 失败重试分级（对齐影策 RetryFailedDrama 的 prompt/video/cast 分流 +
     * RetryDramaResultJobs「成功 task 仅重放不二次提交」）。本地按 job.kind 分级：
     * - 文本类（script/prompts）：无外部 provider task，直接清退避重新入队重跑；
     * - video：h3-run 已 skipCompleted，重跑天然只补未完成的段，无需二次生成的恢复点；
     * - render：若 payload 有 renderRecoveryStorageKey（成片已合成、仅写回失败），重放时
     *   runRender 会直接复用该 storageKey 写回，跳过 video-concat，不重复烧算力。
     * 返回结构化统计；requeued 字段兼容原前端（只显示总数）。
     */
    retryFailed(dramaId: string): { requeued: number; skippedByLimit: number; byKind: Record<string, number>; replayedRender: number } {
        const failed = this.store.listJobs(dramaId, ["failed"]);
        const byKind: Record<string, number> = {};
        let replayedRender = 0;
        let skippedByLimit = 0;
        for (const job of failed) {
            byKind[job.kind] = (byKind[job.kind] || 0) + 1;
            if (job.kind === "render" && String(this.store.jobPayload(job).renderRecoveryStorageKey || "")) {
                replayedRender += 1;
            }
            // 熔断：历史 attempt 已远超硬上限的作业说明反复失败无望，不再 requeue，
            // 保持 failed 终态等人工介入，杜绝「超限fail→retryFailed再捞起」的死循环。
            if (job.attempt >= MAX_ATTEMPTS_HARD) {
                this.store.log(dramaId, `作业已达重试上限，保留失败终态需人工介入 ${job.stage}/${job.kind} (${job.id}) attempt=${job.attempt}`, "error", job.episode_id, job.id);
                skippedByLimit += 1;
                continue;
            }
            this.store.requeueForRetry(job.id);
            this.retryAt.delete(job.id);
        }
        const parts = Object.entries(byKind).map(([kind, n]) => `${kind}:${n}`).join(" ");
        this.store.log(dramaId, `失败作业分级重试：${failed.length - skippedByLimit} 条（${parts}）；熔断保留 ${skippedByLimit} 条；其中 render 复用已合成成片 ${replayedRender} 条`);
        this.wake(dramaId);
        return { requeued: failed.length - skippedByLimit, skippedByLimit, byKind, replayedRender };
    }

    /**
     * 人工从待处理卡片确认的单作业重试：显式重置 attempt 并重新入队，不受自动熔断上限限制。
     * 仅用户主动点击才调用；自动 retryFailed 仍跳过超限作业，避免「超限→自动再捞起」死循环。
     */
    retryJobManually(dramaId: string, jobId: string): { ok: boolean; jobId: string; stage: string; kind: string } {
        const job = this.store.job(jobId);
        if (!job || job.drama_id !== dramaId) throw new Error("作业不存在或不属于该剧本");
        if (job.status !== "failed") throw new Error("只有失败的作业可以手动重试");
        this.store.requeueForRetry(job.id);
        this.retryAt.delete(job.id);
        this.store.log(dramaId, `人工重试 ${job.stage}/${job.kind} (${job.id})：重置 attempt 并重新入队，不受自动熔断上限约束`, "warn", job.episode_id, job.id);
        this.wake(dramaId);
        return { ok: true, jobId: job.id, stage: job.stage, kind: job.kind };
    }

    /**
     * 队列展示用：说明一条 queued 作业当前被什么挡住。与 jobAllowed 共用同一套闸门真值，
     * 只是把「不可派发」转成用户可读原因，避免下游作业一开始就入队却显示为可执行的排队中。
     */
    private waitReasonOf(job: JobRow, succeededByEpisode: Map<string, Set<string>>): string | undefined {
        const pipeline = this.store.get(job.drama_id);
        if (!pipeline) return undefined;
        const payload = this.store.jobPayload(job);
        const episodeId = String(payload.episodeId || job.episode_id || "");
        for (const required of STAGE_REQUIRES[job.stage] || []) {
            if (!succeededByEpisode.get(episodeId)?.has(required)) return `等待上游：${required}`;
        }
        if (Date.now() < (this.retryAt.get(job.id) || 0)) return "等待重试";
        const approvals = new Set(this.store.approvalTargets(job.drama_id, "approve"));
        const released = new Set(this.store.approvalTargets(job.drama_id, "release"));
        const sampleMode = Boolean(this.optionsOf(job.drama_id).sampleMode);
        const sampleApproved = this.isSampleApproved(job.drama_id, approvals);
        if (job.stage === "video" && needsReview(pipeline.review_mode, Number(payload.episodeNumber || 0), approvals, episodeId, sampleMode, sampleApproved)) return "等待审阅";
        if (job.stage === "assets" && mediaHeld(pipeline.media_mode, released, "assets")) return "等待媒体放行";
        if (job.stage === "render" && mediaHeld(pipeline.media_mode, released, "all")) return "等待媒体放行";
        return undefined;
    }

    status(dramaId: string): Record<string, unknown> {
        const pipeline = this.store.get(dramaId) || null;
        const jobs = this.store.listJobs(dramaId);
        const succeededByEpisode = new Map<string, Set<string>>();
        for (const job of jobs) {
            if (job.status !== "succeeded") continue;
            const episodeId = String(this.store.jobPayload(job).episodeId || job.episode_id || "");
            const set = succeededByEpisode.get(episodeId) || new Set<string>();
            set.add(job.stage);
            succeededByEpisode.set(episodeId, set);
        }
        const byStage: Record<string, Record<string, number>> = {};
        for (const job of jobs) {
            byStage[job.stage] ||= {};
            byStage[job.stage][job.status] = (byStage[job.stage][job.status] || 0) + 1;
        }
        const byStatus: Record<string, number> = {};
        for (const job of jobs) byStatus[job.status] = (byStatus[job.status] || 0) + 1;
        return {
            pipeline,
            totals: byStatus,
            stages: byStage,
            // 闸门真值从持久化表读回（重启后不丢）；内存镜像仅作调度热缓存，不作为唯一来源。
            approvals: this.store.approvalTargets(dramaId, "approve"),
            releasedMedia: this.store.approvalTargets(dramaId, "release"),
            sampleMode: Boolean(this.optionsOf(dramaId).sampleMode),
            budget: this.budgetOf(dramaId),
            // 暂停真相：paused/reason 来自持久化（重启后仍在），lastResult 是最近一次暂停的取消摘要。
            pause: {
                paused: pipeline?.status === "paused",
                reason: pipeline?.pause_reason || null,
                lastResult: this.pauseReports.get(dramaId) || null,
            },
            // 每个 job 透出真实时间（snake_case DB 行 → camelCase 投影，不动 schema）：
            // durationMs 由 finishedAt-startedAt 计算，缺 finished_at 时为 null。状态本地化仍在前端。
            // runtimeTaskId = job.task_id：作业自己派生的 provider task 号；旧作业/纯本地计算保持 null
            // （不伪造）。脚本/资产/提示词作业在拿到 taskId 后由 markRunning 写回（多子任务时为最新一条）。
            jobs: jobs.map(job => ({
                id: job.id, stage: job.stage, kind: job.kind, status: job.status,
                attempt: job.attempt, episodeId: job.episode_id, error: job.error,
                // 与 retryFailed 的熔断判定同源：前端据此区分「可重试失败」和「需人工介入的终态」。
                retryExhausted: job.attempt >= MAX_ATTEMPTS_HARD,
                createdAt: job.created_at ?? null,
                startedAt: job.started_at ?? null,
                finishedAt: job.finished_at ?? null,
                durationMs: jobDurationMs(job.started_at, job.finished_at),
                runtimeTaskId: job.task_id ?? null,
                // 逐次尝试记录（成功/失败/熔断都追加）：排查「重试到上限，之前几次为什么失败」用。
                attempts: jobAttempts(job.attempts_json),
                waitReason: job.status === "queued" ? this.waitReasonOf(job, succeededByEpisode) ?? null : null,
            })),
            logs: this.store.logs(dramaId, 20),
        };
    }

    // ── 私有工具 ────────────────────────────────────────────────────────

    /** 制作设置「参考图模型」按资产类型批量写入各集制作稿的 settings.imageModelsByKind。 */
    private async applyImageModels(dramaId: string, imageModelsByKind: { character?: string; scene?: string; prop?: string }): Promise<void> {
        try {
            const listing = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
            const episodes: Array<Record<string, any>> = Array.isArray(listing?.episodes) ? listing.episodes : [];
            let applied = 0;
            for (const ep of episodes) {
                const episodeId = String(ep?.id || "");
                if (!episodeId) continue;
                try {
                    const fresh = await this.getProduction(episodeId);
                    await this.productionOps(episodeId, Number(fresh.production.revision || 0), [
                        { type: "set_settings", patch: { imageModelsByKind } },
                    ]);
                    applied += 1;
                } catch { /* 单集写失败不阻断其余集 */ }
            }
            this.store.log(dramaId, `参考图模型按资产类型已应用到 ${applied}/${episodes.length} 集`);
        } catch (error) { this.store.log(dramaId, `应用参考图模型失败（不阻断）：${errText(error)}`, "warn"); }
    }

    private async getProduction(episodeId: string): Promise<{ production: Record<string, any> }> {
        return this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}/production`);
    }

    private async productionOps(episodeId: string, expectedRevision: number, ops: Record<string, unknown>[]): Promise<{ production: Record<string, any> }> {
        return this.request("POST", `/drama/episodes/${encodeURIComponent(episodeId)}/production/ops`, {
            operationId: randomUUID(),
            expectedRevision: Number(expectedRevision || 0),
            ops,
        });
    }

    private async getCanvasProject(canvasId: string): Promise<Record<string, any>> {
        const res = await this.request("GET", `/canvas/projects/${encodeURIComponent(canvasId)}`);
        return res?.project || {};
    }

    /**
     * 共享资产节点真图的 assetId → storageKey 映射，作为段参考绑定的权威源。
     * 分集 draft.director.assets 只是冗余缓存，重拆/生图失败后会与节点真值漂移（实测蟒妻/崇良
     * 缓存图与共享节点图 storageKey 不同），所以绑定派生优先读这里。对齐影策提交时从资产实体
     * 动态取当前图的做法。共享节点身份是 productionEntity.entityId，经 source.asset_plan 的
     * entity_id 桥接到 assetId；真图在节点 metadata.storageKey。
     */
    private async sharedAssetStorageMap(dramaId: string, source: Record<string, any>): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        try {
            const dramaRes = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}`);
            const sharedId = String(dramaRes?.drama?.sharedAssetCanvasId || "");
            if (!sharedId) return map;
            const sharedProject = await this.getCanvasProject(sharedId);
            const nodes = (Array.isArray(sharedProject?.nodes) ? sharedProject.nodes : []) as Array<Record<string, any>>;
            // 共享节点的真图在 metadata.storageKey（不是 characterImages），身份是 productionEntity.entityId。
            const byEntity = new Map<string, string>();
            for (const node of nodes) {
                const md = (node?.metadata || {}) as Record<string, any>;
                const entityId = String(md.productionEntity?.entityId || "");
                const key = String(md.storageKey || "");
                if (entityId && key) byEntity.set(entityId, key);
            }
            // asset_plan 是桥梁：assetId（director.assets/director.assets 键）→ entity_id（共享节点身份）。
            const planRows = (Array.isArray(source?.asset_plan) ? source.asset_plan : []) as Array<Record<string, any>>;
            for (const row of planRows) {
                const assetId = String(row.id || row.asset_id || "");
                const entityId = String(row.entity_id || row.entityId || "");
                const key = byEntity.get(entityId);
                if (assetId && key) map.set(assetId, key);
            }
        } catch (error) {
            this.store.log(dramaId, `读取共享资产节点真图失败，段绑定回退到分集缓存：${error instanceof Error ? error.message : String(error)}`, "warn");
        }
        return map;
    }

    private fpsOf(source: Record<string, any>): number {
        const num = Number(source?.fps_num || 24);
        const den = Number(source?.fps_den || 1);
        return den > 0 && num > 0 ? num / den : 24;
    }

    private findCanvasSegment(nodes: Array<Record<string, any>>, productionSegmentId: string): { nodeId: string; segmentId: string; prompt: string; referenceBindings: unknown[]; refItems: unknown[]; taskMode: string } | null {
        for (const node of nodes) {
            const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments : [];
            for (const cs of segments) {
                const targetId = String(cs?.productionClipProjection?.targetId || "");
                if (targetId && targetId === productionSegmentId) {
                    return {
                        nodeId: String(node.id),
                        segmentId: String(cs.id),
                        prompt: String(cs?.prompt || ""),
                        referenceBindings: Array.isArray(cs?.referenceBindings) ? cs.referenceBindings : [],
                        refItems: Array.isArray(cs?.refItems) ? cs.refItems : [],
                        taskMode: String(cs?.taskMode || cs?.mode || ""),
                    };
                }
            }
        }
        return null;
    }

    private shortHash(text: string): string {
        let h = 0x811c9dc5;
        for (let index = 0; index < text.length; index += 1) h = Math.imul(h ^ text.charCodeAt(index), 0x01000193) >>> 0;
        return h.toString(36);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** 统一 HTTP 自调用：Bearer token + JSON + 超时 + 错误归一化。timeoutMs 供暂停取消等短操作收紧超时。 */
    private async request(method: string, path: string, body?: unknown, timeoutMs = HTTP_TIMEOUT_MS): Promise<any> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.token}`,
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: controller.signal,
            });
            const raw = await res.text();
            let data: any;
            try { data = raw ? JSON.parse(raw) : {}; }
            catch { data = { raw: raw.slice(0, 500) }; }
            if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${data?.error || data?.message || raw.slice(0, 200)}`);
            if (data && data.ok === false) throw new Error(`${method} ${path}: ${data.error || data.message || "请求失败"}`);
            return data;
        } finally {
            clearTimeout(timer);
        }
    }
}

export default DramaPipeline;
