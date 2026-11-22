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
    buildSchemePrompt,
    defaultSchemeFor,
    schemeAppliesTo,
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
import { checkPromptLength, type PromptLengthCheck } from "../canvas/model-video-capability.js";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { dramaVideoResolutionToH3, type DramaVideoAspectRatio, type DramaVideoResolutionTier } from "@basketikun/canvas-agent/drama/video-resolution";
import { learnedRulesCompact } from "./learned-rules.js";

import { PipelineStore, type JobRow, type PipelineRow } from "./pipeline-store.js";
import { findPipelineAssetEntityNode, generatedMediaStorageKey } from "./pipeline-asset-image.js";

// ── 常量 ─────────────────────────────────────────────────────────────────
const DEFAULT_BASE_URL = "http://127.0.0.1:17370";
const TICK_MS = 3000;
const LEASE_TTL_MS = 2 * 60 * 1000;
const HTTP_TIMEOUT_MS = 180_000; // LLM 生成类请求常需 30-90s；20s 会误 abort（This operation was aborted）。
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const TASK_POLL_MS = 1200;
const DEFAULT_POOL_LIMIT = 4;
const DEFAULT_GLOBAL_LIMIT = 16;
/** 资产参考图并发上限：本地 engine-image 单张约 60-90s，2 路并发兼顾速度与显存。 */
const ASSET_IMAGE_CONCURRENCY = 2;
const MAX_JOBS_PER_TICK = 32;
const MAX_ATTEMPTS = 3;
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
    "EPISODE_CANVAS_MISSING",   // 提示词/视频：分集还没有画布
    "H3_NODE_MISSING",          // 视频：还没拆镜编译
    "PROMPTS_NO_SEGMENTS",      // 提示词：制作稿还没有段
    "ASSETS_NO_SYNOPSIS",       // 资产：分集还没有剧本
] as const;
const DEPENDENCY_RETRY_MS = 30_000;
/** approve 哨兵：样片（第1集）已批准，放行 sample 模式其余集（对齐影策 production.SampleApproved）。 */
const SAMPLE_APPROVED_TARGET = "sample";
/** 持久化 reviewApproval → 审批闸门的对账间隔；后端 HTTP 尚未就绪时下一 tick 自动重试。 */
const REVIEW_RECONCILE_COOLDOWN_MS = 60_000;

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
        segmentRange?: { min: number; max: number };
        dialogueDensity?: string;
        transitionMode?: string;
        transitionMs?: number;
        pacing?: string;
    };
    /** 各池并发上限（覆盖构造期默认；池名 text/video/render）。 */
    concurrency?: { text?: number; video?: number; render?: number };
};

export type DramaPipelineStartOpts = {
    reviewMode: "auto" | "sample" | "every";
    mediaMode: "auto" | "manual";
    /** 制作设置：可选的逐剧目运行期覆盖。 */
    options?: DramaPipelineRuntimeOptions;
};

/** runPrompts 可选项：forceRewrite=true 时忽略画布已有 prompt，强制重写每一段。 */
export interface RunPromptsOptions { forceRewrite?: boolean }

export class DramaPipeline {
    private readonly store: PipelineStore;
    private readonly token: string;
    private readonly baseUrl: string;
    private readonly poolLimit: number;
    private readonly globalLimit: number;
    private readonly resolveTextModel?: () => string;
    private readonly resolveImageModel?: () => string;
    private readonly resolveVideoPromptMaxChars?: (modelValue: string) => number | undefined;

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
    /** 上次成功对账持久化 reviewApproval 的时间戳（dramaId → ts）；失败会清掉以便下一 tick 重试。 */
    private readonly reviewReconcileAt = new Map<string, number>();
    /** dramaId → 本剧目累计生成花费（微积分）/预算是否已耗尽（内存计数，重启或重新 start 归零）。 */
    private readonly budgetState = new Map<string, { spent: number; exceeded: boolean }>();

    constructor(options: DramaPipelineOptions) {
        this.store = options.store;
        this.token = options.token;
        this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
        this.poolLimit = Math.max(1, options.poolLimit ?? DEFAULT_POOL_LIMIT);
        this.globalLimit = Math.max(this.poolLimit, options.globalLimit ?? DEFAULT_GLOBAL_LIMIT);
        this.resolveTextModel = options.resolveTextModel;
        this.resolveImageModel = options.resolveImageModel;
        this.resolveVideoPromptMaxChars = options.resolveVideoPromptMaxChars;
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
        return this.runOptions.get(dramaId) || {};
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
            this.pause(dramaId, `budget_exceeded:${state.spent}/${limit}`);
        }
        return this.budgetOf(dramaId);
    }

    /**
     * textSkills 槽位 → SegmentWriterInput 的 skillName/skillPath/skillContent。
     * 优先用前端预解析的 content/instruction；只有 name 时经 /api/skill-market/detail 读 SKILL.md。
     * 技能加载失败只记日志不阻断流水线（技能是增强，不是生成前置条件）。
     */
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

    /** 某剧目某池的并发上限：制作设置覆盖 > 构造期默认。 */
    private poolLimitOf(dramaId: string, pool: PoolName): number {
        const configured = Number(this.optionsOf(dramaId).concurrency?.[pool as "text" | "video" | "render"] || 0);
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
        if (opts?.options) this.runOptions.set(dramaId, opts.options);
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

    /** 幂等编排：读全部分集，按七段机把各阶段作业 dedupe 入队。 */
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
        for (const ep of episodes) {
            const episodeId = String(ep?.id || "");
            if (!episodeId) continue;
            for (const { stage: stageName, kind } of STAGE_JOBS) {
                const dedupeKey = `${dramaId}:${episodeId}:${stageName}`;
                this.store.enqueue({
                    id: dedupeKey,
                    dramaId,
                    episodeId,
                    kind,
                    stage: stageName,
                    // 低 priority 值 = 早阶段优先（script 先于 render）。
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
        this.store.log(pipeline.drama_id, `开始 ${job.stage}/${job.kind} (${job.id}) attempt=${job.attempt}`, "info", job.episode_id, job.id);

        void this.execute(job).then(
            (result) => {
                this.store.succeed(job.id, result || {});
                this.store.log(pipeline.drama_id, `完成 ${job.stage}/${job.kind} (${job.id})`, "info", job.episode_id, job.id);
                this.retryAt.delete(job.id);
                this.wake(pipeline.drama_id);
            },
            (error) => {
                const message = errText(error);
                const code = message.split(":")[0].trim();
                if ((DEPENDENCY_NOT_READY_CODES as readonly string[]).includes(code)) {
                    // C6：上游依赖未就绪（本体参考图/素材/前置产物还没好），不是作业真失败。
                    // 退回 queued 且回退 attempt，延长退避等下一轮（对齐影策「本体未 ready 不排队」）。
                    this.store.deferDependency(job.id);
                    this.retryAt.set(job.id, Date.now() + DEPENDENCY_RETRY_MS);
                    this.store.log(pipeline.drama_id, `等待上游依赖就绪 ${job.stage}/${job.kind} (${job.id})：${message}`, "warn", job.episode_id, job.id);
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
        if (!episodeId) throw new Error("JOB_EPISODE_MISSING: 作业缺少分集 ID");

        const dramaId = String(job.drama_id || "");
        switch (job.kind as JobKind) {
            case "script": return this.runScript(episodeId, dramaId, this.store.jobPayload(job));
            case "assets": return this.runAssets(episodeId, dramaId);
            case "prompts": return this.runPrompts(episodeId, dramaId, { forceRewrite: Boolean((payload as Record<string, unknown>).forceRewrite) });
            case "video": return this.runVideo(episodeId, job);
            case "render": return this.runRender(episodeId, job);
            default: throw new Error(`UNKNOWN_JOB_KIND: ${job.kind}`);
        }
    }

    /** script 段：script-proposal → 写 synopsis/fullPlot → 文本 LLM 拆镜 → 清旧镜+整批重拆 → 编译链。
     *  payload.instruction 是按章编辑改编时前端算好的创作指令（写作技能/钩子悬念/分镜规则/思考深度），
     *  必须真透传到 script-proposal，保证手动改编与全自动同源。 */
    private async runScript(episodeId: string, dramaId: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
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
        // 影策拆镜输入是小说原文，故把原文一并交给拆镜 prompt，要求它逐字提取台词到 beat.dialogue/speaker。
        // 真值优先取「本集覆盖章节」的正文（按章编辑 source_chapters.body 后改编立即生效），
        // 失败回退整份 sourceScript（老数据/无章映射时仍可拆镜）。
        let episodeSource = "";
        try {
            const chaptersRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}/chapters`);
            const chapterTexts = (Array.isArray(chaptersRes?.chapters) ? chaptersRes.chapters : [])
                .map((chapter: Record<string, unknown>) => String(chapter?.body || "").trim())
                .filter(Boolean);
            if (chapterTexts.length) {
                episodeSource = chapterTexts.join("\n\n");
            }
        } catch { /* 无章映射时回退整份原文 */ }
        if (!episodeSource) {
            try {
                const planning = await this.request("GET", `/drama/${encodeURIComponent(dramaId)}/planning?include=sourceScript`);
                episodeSource = String(planning?.sourceScript || "").trim();
            } catch { /* 没有原文时退回分场文本，不阻断拆镜 */ }
        }

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
        const environments: ChapterDemandEnvironment[] = scenes.map(scene => ({ id: scene.environmentId, name: scene.title }));
        const environmentOfScene = new Map<string, string>(scenes.map(scene => [scene.environmentId, scene.id]));
        // 影策 CastIDsJSON 规则：结构化引用清单真值全部来自已登记注册表/资产卡。
        // 注册表为空的老剧目 → 清单为空 → 拆镜引用全空（预期回退），绝不编造 id。
        const characterRefs = rowsOf(source.character_registry)
            .map(row => ({ id: textOf(row.id), name: textOf(row.name ?? row.characterName) }))
            .filter(item => item.id && item.name);
        const propRefs = rowsOf(source.asset_cards)
            .filter(row => textOf(row.asset_kind ?? row.kind) === "prop")
            .map(row => ({ id: textOf(row.id), name: textOf(row.name ?? row.asset_name ?? row.prompt) || textOf(row.id) }))
            .filter(item => item.id);
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
        // 写作技能（分镜拆分）真实注入拆镜步骤：契约无 skill 字段，并入 chapterBody 的【制作设置·分镜要求】。
        const storyboardSkill = await this.resolveTextSkill(opts.textSkills?.storyboard, dramaId);
        if (storyboardSkill.skillContent) ruleLines.push(`${storyboardSkill.skillContent}。`);
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
        });
        const storyboardText = await this.generateText([demandPrompt.system, "", demandPrompt.user].join("\n"), {
            model: opts.storyboardModel,
            reasoningEffort: opts.textThinking?.storyboard,
        }, dramaId);
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
     */
    private async runAssets(episodeId: string, dramaId: string): Promise<Record<string, unknown>> {
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
        type Extracted = { kind: string; name: string; appearance: string; voice?: string; forcedId?: string };
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
                assets.push({
                    kind, name,
                    appearance: cardPrompt || desc || String(reg?.appearance || reg?.description || `「${name}」的参考图，按设定生成。`),
                    ...(reg?.voice_description ? { voice: String(reg.voice_description) } : {}),
                    forcedId: String(row?.id || row?.asset_id || ""),
                });
            }
        }
        if (!assets.length) {
            const assetPrompt = buildAssetExtractPrompt({
                chapterTitle: String(episode.title || ""),
                synopsis,
            });
            // 资产类长期规则进设定提取，不进分镜或提示词链路。
            const assetRules = await learnedRulesCompact(["asset"], 1000);
            const assetUser = assetRules ? `${assetPrompt.user}\n\n用户长期规则：${assetRules}。` : assetPrompt.user;
            const assetOpts0 = this.optionsOf(dramaId);
            const raw = await this.generateText([assetPrompt.system, "", assetUser].join("\n"), {
                model: assetOpts0.assetExtractModel,
                reasoningEffort: assetOpts0.textThinking?.extract,
            }, dramaId);
            try { assets = parseAssetExtract(raw); }
            catch { assets = fallbackAssetExtract({ chapterTitle: String(episode.title || ""), synopsis }); }
        }
        if (!assets.length) throw new Error("ASSETS_EMPTY: 没有可建档的设定");

        const canvasId = String((episodeRes?.canvas as Record<string, any> | null | undefined)?.id || "");
        // 资产类规则同时约束参考图提示词；这段只作用于生图，不影响提示词链路。
        const assetImageRules = await learnedRulesCompact(["asset"], 1000);
        type PendingImage = { assetId: string; kind: string; name: string; entityId: string; prompt: string };
        const pending: PendingImage[] = [];
        let created = 0;

        for (const asset of assets) {
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
                        ...(asset.voice ? { voice_description: asset.voice } : {}) };
                }
                await this.productionOps(episodeId, production.revision, [op]);
                created += 1;
            }

            // 参考图提示词由「内置方案模板」真实拼装（对齐影策 buildDramaCastImagePrompt）：
            // 角色默认定妆照、场景空镜、道具设定图；资产卡上若存了 view_layout（用户选的方案）则用它。
            // 用户手写的卡 prompt 作为补充描述并入，不会被模板吞掉。
            if (String((director.assets as Record<string, any> | undefined)?.[id]?.storageKey || "").trim()) continue;
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
            const builtPrompt = buildSchemePrompt(kindStr as "character" | "scene" | "prop", String(asset.name || ""), body, scheme).trim();
            const prompt = assetImageRules ? `${builtPrompt}\n用户长期规则：${assetImageRules}。` : builtPrompt;
            if (!prompt) { this.store.log(dramaId, `资产 ${id} 没有可用提示词，跳过参考图生成`, "warn"); continue; }
            this.store.log(dramaId, `资产 ${id} 参考图方案=${scheme}（横版16:9）`);
            pending.push({ assetId: id, kind: kindStr, name: String(asset.name || ""), entityId, prompt });
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
            this.store.log(dramaId, `资产参考图开始生成：${pending.length} 张（默认模型 ${defaultModel || "未配置"}，并发 ${ASSET_IMAGE_CONCURRENCY}）`);
            let cursor = 0;
            const worker = async () => {
                while (cursor < pending.length) {
                    const item = pending[cursor++];
                    try {
                        const key = await this.generateAssetReference(episodeId, canvasId, canvasNodes, item,
                            String(kindModel[item.kind as "character" | "scene" | "prop"] || "").trim() || defaultModel,
                            assetOpts.imageResolution, dramaId);
                        generated += 1;
                        this.store.log(dramaId, `资产 ${item.assetId} 参考图已写回：${key}`);
                    } catch (error) {
                        imageFailed += 1;
                        this.store.log(dramaId, `资产 ${item.assetId} 参考图生成失败（不阻断）：${errText(error)}`, "warn");
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(ASSET_IMAGE_CONCURRENCY, pending.length) }, worker));
        } else if (pending.length && !canvasId) {
            this.store.log(dramaId, "分集还没有画布，跳过资产参考图生成", "warn");
        }
        this.store.log(dramaId, `assets 段完成：建档 ${created} 项，参考图 ${generated} 张成功 / ${imageFailed} 张失败`);
        return { total: assets.length, created, images: generated, imageFailed };
    }

    /** 单资产真实出图 + 写回：定位实体节点 → 生图 → 轮询 → bind-image（真实 storageKey）。 */
    private async generateAssetReference(episodeId: string, canvasId: string, canvasNodes: Array<Record<string, any>>,
        item: { assetId: string; kind: string; name: string; entityId: string; prompt: string }, model: string,
        imageResolution?: "1k" | "2k" | "4k", dramaId?: string): Promise<string> {
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
        const task = await this.waitTask(taskId, false);
        if (dramaId) this.chargeGeneration(dramaId, "image", task);
        const storageKey = generatedMediaStorageKey(task);
        if (!storageKey) throw new Error(`ASSET_IMAGE_NO_MEDIA: 任务 ${taskId} 没有产出 storageKey`);
        await this.request("POST", "/drama/pipeline/assets/bind-image", {
            episodeId, assetId: item.assetId, nodeId: entity.id, storageKey, taskId,
        });
        return storageKey;
    }

    /** prompts 段：逐段文本 LLM 写提示词 → update_h3_segment 写画布 clip.prompt。 */
    private async runPrompts(episodeId: string, dramaId: string, options: RunPromptsOptions = {}): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const canvas = (episodeRes?.canvas || null) as Record<string, any> | null;
        if (!canvas?.id) throw new Error("EPISODE_CANVAS_MISSING: 分集还没有画布");
        const production = (await this.getProduction(episodeId)).production as any;
        const director = (production?.draft?.director || {}) as Record<string, any>;
        const source = production?.draft?.director?.source || {};
        const fps = this.fpsOf(source);
        const shots: Array<Record<string, any>> = Array.isArray(source.shots) ? source.shots : [];
        const segments: Array<Record<string, any>> = Array.isArray(source.segments) ? source.segments : [];
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
        const promptSkill = await this.resolveTextSkill(promptOpts.textSkills?.prompt, dramaId);
        // 提示词类、连续性类、视频生成类长期规则进提示词撰写；分镜/资产规则不进这里。
        const writerRules = await learnedRulesCompact(["prompt", "continuity", "video"], 1800);
        const writerRuleNote = writerRules ? `【用户长期规则·提示词与视频生成】${writerRules}。` : "";

        const shotById = new Map(shots.map(shot => [String(shot.id), shot]));
        const canvasNodes: Array<Record<string, any>> = Array.isArray(canvas.nodes) ? canvas.nodes : [];
        // 真源无对白（蟒妻 script_scenes 全 kind:action）→ 仅本次运行期内存派生；绝不写回 draft.director.source.utterances。
        if (!utterances.length) {
            utterances = await this.deriveUtterancesForPrompts({ segments, shotById, source, promptOpts, dramaId });
        }
        let written = 0;
        let skipped = 0;

        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            const segmentId = String(segment.id || "");
            // 画布段已有非空 prompt（之前写过）就跳过，避免每段重复跑 LLM（26 段串行要十几分钟）。
            // forceRewrite 时忽略旧 prompt，逐段重写（用于修复烂提示词）。
            const target = this.findCanvasSegment(canvasNodes, segmentId);
            if (!target) continue;
            if (!options.forceRewrite && target.prompt.trim()) { skipped += 1; continue; }
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
            const derived = deriveSegmentReferenceBindings(source, director, segmentId, shotIds, shots);
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
                firstFrame: index > 0 && !independent,
                independent,
                noReferenceBindings: noRefs,
                referenceLegend: legend.map((entry) => `参考图${entry.ordinal}：${entry.name}（${entry.kind}）`),
                referenceCount: bindings.length,
            };
            const prompt = buildSegmentWriterPrompt(input);
            const raw = await this.generateText([prompt.system, "", prompt.user].join("\n"), {
                model: promptOpts.videoPromptModel,
                reasoningEffort: promptOpts.textThinking?.prompt,
            }, dramaId);
            let cleaned = cleanWrittenPrompt(raw);
            if (!cleaned) continue;

            // C5：按选定视频模型的 promptMaxChars 真值自动精简重跑（对齐影策 condenseSegmentPrompt）
            const videoModel = String(promptOpts.videoModel || "").trim();
            const maxChars = this.resolveVideoPromptMaxChars?.(videoModel);
            const condense = await this.condensePromptToLimit(cleaned, maxChars, (text, limit) =>
                this.generateText([CONDENSE_SYSTEM_PROMPT, "", buildSegmentCondensePrompt(text, limit, noRefs)].join("\n"), {
                    model: promptOpts.videoPromptModel,
                    reasoningEffort: promptOpts.textThinking?.prompt,
                }, dramaId).then(cleanWrittenPrompt));
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

            const taskMode = canonicalH3TaskMode(noRefs ? "t2v" : "ref2va");
            // 有绑定时禁止 t2v：T2V 不提交参考素材，会让刚派生的绑定全部失效。
            if (bindings.length && taskMode === "t2v") {
                throw new Error("PROMPTS_TASKMODE_CONFLICT: 段有参考图绑定时 taskMode 不能是 t2v");
            }
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
    async rewritePrompts(episodeId: string): Promise<{ segments: number; written: number; skipped: number }> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const dramaId = String(episodeRes?.episode?.dramaId || "");
        if (!dramaId) throw new Error("EPISODE_DRAMA_MISSING: 分集缺少所属剧目 ID，无法强制重写提示词");
        const result = await this.runPrompts(episodeId, dramaId, { forceRewrite: true });
        return {
            segments: Number(result.segments || 0),
            written: Number(result.written || 0),
            skipped: Number(result.skipped || 0),
        };
    }

    /**
     * 按章编辑原文 →「确定(保存并重新改编)」的服务端入口（对齐影策 rescript）：
     * drama_routes → drama_actions CancelQueuedDramaJobs + ApplyDramaScript(stage:script) + requestDramaWork。
     * 本地做法：反查 dramaId → 重置本集全部阶段作业为 queued（清 task/attempt/error，透传 instruction）
     * → 清掉这些作业的退避计时 → 确保流水线 running → 幂等补齐作业 → wake 立即重跑。
     * script 作业会走 runScript：script-proposal → 写 synopsis/fullPlot → 清旧镜+整批重拆 → promoteToCanvas。
     * instruction/model 透传进 script job payload，runScript 真消费，不经前端假修复。
     */
    async rescript(episodeId: string, opts?: { instruction?: string; model?: string }): Promise<{ dramaId: string; episodeId: string; resetJobs: number; status: string }> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const dramaId = String(episodeRes?.episode?.dramaId || "");
        if (!dramaId) throw new Error("EPISODE_DRAMA_MISSING: 分集缺少所属剧目 ID，无法重新改编");
        const scriptPatch: Record<string, unknown> = {};
        if (String(opts?.instruction || "").trim()) scriptPatch.instruction = String(opts!.instruction).trim().slice(0, 2000);
        if (String(opts?.model || "").trim()) scriptPatch.model = String(opts!.model).trim();
        // 幂等：同一集重复改编只是再次把同一批 dedupe job 重置为 queued，不会堆重复作业。
        const resetJobs = this.store.resetJobsForEpisode(dramaId, episodeId, scriptPatch);
        // 重置后旧作业的退避计时不得继续挡住重跑。
        for (const job of this.store.listJobs(dramaId)) {
            if (job.episode_id === episodeId) this.retryAt.delete(job.id);
        }
        // 即便流水线处于 paused/completed，显式改编也要能重跑本集。
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
     */
    private async applyVideoResolution(canvasId: string, h3Nodes: Array<Record<string, any>>, tier: unknown, aspectRatio: unknown): Promise<{ segments: number; size: string; resolution: string; megapixels: number; aspectRatio: string } | null> {
        const effective = dramaVideoResolutionToH3(tier, aspectRatio);
        if (!effective) return null;
        const project = await this.getCanvasProject(canvasId);
        const operations: Array<Record<string, unknown>> = [];
        for (const node of h3Nodes) {
            const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments as Array<Record<string, any>> : [];
            for (const segment of segments) {
                const id = String(segment?.id || "");
                if (!id) continue;
                operations.push({
                    type: "update_h3_segment",
                    nodeId: String(node.id),
                    segmentId: id,
                    patch: { aspectRatio: effective.aspectRatio, megapixels: effective.megapixels },
                });
            }
        }
        if (operations.length) {
            await this.request("POST", `/canvas/projects/${encodeURIComponent(canvasId)}/ops`, {
                operationId: randomUUID(),
                expectedRevision: Number(project?.revision || 0),
                operations,
            });
        }
        return { segments: operations.length, size: effective.size, resolution: effective.resolution, megapixels: effective.megapixels, aspectRatio: effective.aspectRatio };
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
        // 剧目级 videoResolution 真下发：先写 H3 段保存值（aspectRatio/megapixels，真正决定出片尺寸），
        // 再把派生 size/resolution 随请求带给自选模型工作流（size/resolution 非 H3_PARAM_KEYS，不触发 UI 守卫）。
        const resolutionTier = String(videoOpts.videoResolution || "").trim();
        let resolutionApplied: { segments: number; size: string; resolution: string; megapixels: number; aspectRatio: string } | null = null;
        if (resolutionTier) {
            resolutionApplied = await this.applyVideoResolution(String(canvas.id), h3Nodes, resolutionTier, videoOpts.videoAspectRatio || "16:9");
            if (resolutionApplied) {
                videoParams.size = resolutionApplied.size;
                videoParams.resolution = resolutionApplied.resolution;
                this.store.log(String(job.drama_id || ""), `剧目级分辨率下发 ${resolutionTier}/${videoOpts.videoAspectRatio || "16:9"} → H3 megapixels=${resolutionApplied.megapixels} size=${resolutionApplied.size}，写入 ${resolutionApplied.segments} 段（真实出片参数）`);
            } else {
                this.store.log(String(job.drama_id || ""), `剧目级分辨率档位 ${resolutionTier} 无法解析，已回退模型默认`, "warn");
            }
        }
        const results: Array<Record<string, unknown>> = [];
        for (const node of h3Nodes) {
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
            const task = await this.waitTask(taskId, false);
            const dramaId = String(job.drama_id || "");
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
        const videos: string[] = [];
        for (const node of canvasNodes) {
            const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments : [];
            for (const segment of segments) {
                const key = String(segment?.resultStorageKey || "");
                if (key) videos.push(key);
                for (const result of (Array.isArray(segment?.results) ? segment.results : [])) {
                    const rk = String(result?.storageKey || "");
                    if (rk) videos.push(rk);
                }
            }
        }
        const unique = [...new Set(videos)].filter(Boolean);
        if (!unique.length && !String(this.store.jobPayload(job).renderRecoveryStorageKey || "")) {
            throw new Error("RENDER_NO_VIDEO: 画布还没有可用的分镜视频 storageKey");
        }

        // C3 恢复点：合成任务已成功、仅写回制作稿失败时，storageKey 记在 payload。
        // retryFailed 分级重放 render 时直接复用，不二次提交 video-concat（对齐影策
        // RetryDramaResultJobs「成功 provider task 只重应用，不二次提交」）。
        const recoveredKey = String(this.store.jobPayload(job).renderRecoveryStorageKey || "");
        let storageKey = recoveredKey;
        let taskId = String(this.store.jobPayload(job).renderRecoveryTaskId || "");
        if (!storageKey) {
            const started = await this.request("POST", "/agent/video-concat/tasks", {
                videos: unique,
                layout: "sequence",
                longEdge: "auto",
            });
            taskId = String(started?.task?.id || started?.taskId || "");
            if (!taskId) throw new Error("VIDEO_CONCAT_NO_TASK");
            this.store.markRunning(job.id, taskId);
            const task = await this.waitTask(taskId, true);
            storageKey = String(task?.result?.media?.storageKey || task?.result?.storageKey || task?.result?.media?.url || "");
            if (!storageKey) throw new Error("VIDEO_CONCAT_NO_RESULT: 合成任务没有产出 storageKey");
            // 合成成功即落恢复点；后续写回若失败，重放时跳过合成直接写回。
            this.store.setJobRecovery(job.id, { renderRecoveryStorageKey: storageKey, renderRecoveryTaskId: taskId });
        } else {
            this.store.log(String(job.drama_id || ""), `render 复用已合成成片 storageKey=${storageKey}（task=${taskId}），跳过二次合成`, "info", episodeId, job.id);
        }

        const production = (await this.getProduction(episodeId)).production as any;
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

    private async generateText(prompt: string, overrides?: { model?: string; reasoningEffort?: string }, dramaId?: string): Promise<string> {
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
        const task = await this.waitTask(taskId, false);
        if (dramaId) this.chargeGeneration(dramaId, "text", task);
        const text = (Array.isArray(task?.result?.texts) ? task.result.texts : [])
            .map((item: any) => String(item?.content || "")).join("\n").trim();
        if (!text) throw new Error("TEXT_GENERATION_EMPTY");
        return text;
    }

    /** 源剧本无对白时运行期内存派生；失败/解析失败一律 []，不写回 draft.source.utterances。 */
    private async deriveUtterancesForPrompts(args: {
        segments: Array<Record<string, any>>;
        shotById: Map<string, Record<string, any>>;
        source: Record<string, any>;
        promptOpts: DramaPipelineRuntimeOptions;
        dramaId: string;
    }): Promise<Array<Record<string, any>>> {
        const { segments, shotById, source, promptOpts, dramaId } = args;
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
            }, dramaId);
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
    private async waitTask(taskId: string, agent: boolean): Promise<Record<string, any>> {
        const path = agent ? `/agent/runtime/tasks/${encodeURIComponent(taskId)}` : `/tasks/${encodeURIComponent(taskId)}`;
        const deadline = Date.now() + TASK_TIMEOUT_MS;
        while (Date.now() < deadline) {
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

    pause(dramaId: string, reason = "manual"): void {
        this.store.setStatus(dramaId, "paused", reason);
        this.store.log(dramaId, `流水线暂停：${reason}`);
        this.wake(dramaId);
    }

    resume(dramaId: string): void {
        if (this.budgetHeld(dramaId)) {
            // 预算耗尽时不允许「恢复」绕过闸门；须用更高/新的 budgetMicrocredits 重新 start。
            this.store.log(dramaId, `预算已耗尽（${this.budgetOf(dramaId).spentMicrocredits} 微积分），拒绝恢复；请调整 budgetMicrocredits 后重新 start`, "warn");
            return;
        }
        this.assertModelsReady(dramaId); // C4：恢复=重新开工，同样拒绝缺模型能力
        this.store.setStatus(dramaId, "running", null);
        this.store.log(dramaId, "流水线恢复");
        this.wake(dramaId);
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
    retryFailed(dramaId: string): { requeued: number; byKind: Record<string, number>; replayedRender: number } {
        const failed = this.store.listJobs(dramaId, ["failed"]);
        const byKind: Record<string, number> = {};
        let replayedRender = 0;
        for (const job of failed) {
            byKind[job.kind] = (byKind[job.kind] || 0) + 1;
            if (job.kind === "render" && String(this.store.jobPayload(job).renderRecoveryStorageKey || "")) {
                replayedRender += 1;
            }
            this.store.requeue(job.id);
            this.retryAt.delete(job.id);
        }
        const parts = Object.entries(byKind).map(([kind, n]) => `${kind}:${n}`).join(" ");
        this.store.log(dramaId, `失败作业分级重试：${failed.length} 条（${parts}）；其中 render 复用已合成成片 ${replayedRender} 条`);
        this.wake(dramaId);
        return { requeued: failed.length, byKind, replayedRender };
    }

    status(dramaId: string): Record<string, unknown> {
        const pipeline = this.store.get(dramaId) || null;
        const jobs = this.store.listJobs(dramaId);
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
            jobs: jobs.map(job => ({
                id: job.id, stage: job.stage, kind: job.kind, status: job.status,
                attempt: job.attempt, episodeId: job.episode_id, error: job.error,
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

    /** 统一 HTTP 自调用：Bearer token + JSON + 超时 + 错误归一化。 */
    private async request(method: string, path: string, body?: unknown): Promise<any> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
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
