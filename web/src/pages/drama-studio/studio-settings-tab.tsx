import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Music2, Sparkles, Wand2, Rows3, Gauge, Save, Plus, Trash2, Mic2, Film, Eye, Play, Image as ImageIcon, BookOpen, RotateCcw, Check } from "lucide-react";

import {
    modelOptionLabel,
    modelVideoCapabilitiesOf,
    saveAiConfigConfirmed,
    selectableModelsByCapability,
    encodeChannelModel,
    setModelMaxVideoSeconds,
    setModelPromptMaxChars,
    useConfigStore,
    type ReasoningEffort,
} from "@/stores/use-config-store";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { applyDramaEpisodeGrouping, autoPlanDramaEpisodeGrouping, fetchBackendCanvasFolders, patchDramaPlanningMode, patchDramaTopicArtStyle, previewDramaEpisodeGrouping, fetchBackendDramaEpisodes, fetchEpisodeProduction, editEpisodeProduction, regenerateDramaAssetReference, type DramaEpisodeGroupingPreview } from "@/services/backend-api";
import { DRAMA_STYLE_FORMS, DRAMA_STYLE_THEMES, composeDramaStyleId, findComposedDramaStyle, findComposedDramaStyleByPrompt, type DramaStyleFormId, type DramaStyleThemeId } from "@/lib/drama/style-composition";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { TOPIC_OPTIONS } from "@basketikun/canvas-agent/drama/topic-options";
import { ASSET_KIND_SKILL, ASSET_PROMPT_VARIABLES, ASSET_SCHEMES, defaultSchemeFor, renderAssetPromptWithTemplate, schemeAppliesTo, type AssetSchemeId } from "@basketikun/canvas-agent/drama/asset-spec";
import type { DirectorReviewPolicy } from "@basketikun/canvas-agent/drama/production-contract";
import { PRODUCTION_STAGE_KEYS } from "@/pages/drama/production-progress";
import { DRAMA_VIDEO_ASPECT_RATIOS, DRAMA_VIDEO_RESOLUTION_TIERS, dramaVideoResolutionShortSide, dramaVideoResolutionToH3, type DramaVideoAspectRatio } from "@basketikun/canvas-agent/drama/video-resolution";
import { SkillPickerField, type SkillRef } from "./studio-skill-picker";
import { cn } from "@/lib/utils";

/**
 * 影策短剧制作台「制作设置」逐项复刻。真值链（逐项只读核实，不是照抄影策）：
 *
 * - 持久化：本组件的值按剧目存 localStorage（loadStudioSettings / onSave）。
 * - 真实下发：index.tsx 的 pipelineOpts 在「启动全自动流水线」时把模型/思考等级/
 *   分镜规则/并发/参考图上限/并行出片/样片模式/审阅与生成节奏，按后端
 *   startSchema（drama-pipeline-routes.ts）+ DramaPipelineRuntimeOptions（pipeline.ts）
 *   真实下发给运行期选项；production-runner 的拆镜/提示词 job 读取 storyboardRules。
 *   手动「重新改编本集 / 撰写段提示词」也分别注入 hook/cliffhanger/技能/表演强度/运镜动感。
 * - 真实直写：参考图模型在保存时按 imageModelsByKind 写进当前集制作稿 settings；
 *   剧目级 videoResolution + 画幅在 video 段启动前由后端写进每个 H3 Clip 的
 *   aspectRatio/megapixels 保存值（h3-runner 的 UI 守卫要求保存值与出片一致）。
 *   参考图默认方案（referenceLayout）可选真实 AssetSchemeId，点「应用到本剧全部设定」
 *   会把 view_layout 按资产类型真写进每集资产卡（与项目资产的 AssetSchemePicker 同一字段），
 *   不是只读装饰；审阅策略 reviewPolicy 选择后真写进制作稿 settings.reviewPolicy。
 * - 只读展示：视觉风格/对白语言来自剧目规划真实值；productionStage 从当前集制作稿
 *   draft.settings.productionStage 真值只读展示（与 agent 总流程/制作进度条同源），不提供假开关；
 *   视频模型声明的默认档位仅作提示，可选档位走真实下发链路，不是假开关。
 * - 软约束提示：episodeSeconds / transitionMs 写入 storyboardRules，只影响拆镜提示词的
 *   时长与转场要求，不强制成片剪辑，UI 明确标注。
 * - 「重做参考图」现在有一键入口：按资产卡 + 当前方案真出图并写回（后端 regenerate-reference）；
 *   手动跳转仅作为不想覆盖旧图时的引导，不造假按钮。
 */

/** 思考等级用本地文本设置里真实存在的档位（text-settings-panel.tsx）。 */
const THINKING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" },
];

/** 剧目级默认参考图方案：选项直接来自共享 ASSET_SCHEMES（影策 AssetSchemePicker 的本地真值）。 */
const ASSET_SCHEME_OPTIONS = ASSET_SCHEMES.map((s) => ({ value: s.id as AssetSchemeId, name: s.name, description: s.description }));

/** 审阅策略：与 production-contract.directorReviewPolicySchema 同档，按 mode 收敛 shared/scene。 */
const REVIEW_POLICY_MODES = ["none", "automatic", "mixed", "manual"] as const;
const DEFAULT_REVIEW_POLICY: DirectorReviewPolicy = { mode: "none", shared: "none", scene: "none" };
const REVIEW_POLICY_MODE_LABELS: Record<string, string> = {
    none: "不审阅", automatic: "自动审阅", mixed: "混合", manual: "人工审阅",
};
const REVIEW_POINT_LABELS: Record<string, string> = { none: "不审阅", automatic: "自动", manual: "人工" };

function normalizeReviewPolicy(value: unknown): DirectorReviewPolicy {
    const p = (value && typeof value === "object" ? value : {}) as Partial<DirectorReviewPolicy>;
    if (!REVIEW_POLICY_MODES.includes(p.mode as (typeof REVIEW_POLICY_MODES)[number])) return { ...DEFAULT_REVIEW_POLICY };
    if (p.mode === "none") return { mode: "none", shared: "none", scene: "none" };
    if (p.mode === "mixed") {
        return {
            mode: "mixed",
            shared: p.shared === "manual" ? "manual" : "automatic",
            scene: p.scene === "manual" ? "manual" : "automatic",
        };
    }
    // automatic / manual：schema 要求 shared/scene 与 mode 同档，不保存非法组合。
    return { mode: p.mode, shared: p.mode, scene: p.mode } as DirectorReviewPolicy;
}

/** 切换审阅预设时保持 mixed 两个审核点的既有选择，其余档位按 schema 收敛。 */
function reviewPolicyForMode(mode: (typeof REVIEW_POLICY_MODES)[number], current: DirectorReviewPolicy): DirectorReviewPolicy {
    if (mode === "none") return { mode: "none", shared: "none", scene: "none" };
    if (mode === "mixed") return {
        mode: "mixed",
        shared: current.shared === "manual" ? "manual" : "automatic",
        scene: current.scene === "manual" ? "manual" : "automatic",
    };
    return { mode, shared: mode, scene: mode } as DirectorReviewPolicy;
}

const PRODUCTION_STAGE_LABELS: Record<string, string> = {
    script: "剧本", assets: "资产", spatial: "空间", shots: "分镜", keyframes: "关键帧", clips: "成片",
};

/** 剧目级视频分辨率档位（短边像素）+「模型默认」；档位真值来自共享 drama/video-resolution 模块。 */
const VIDEO_RESOLUTION_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "", label: "模型默认" },
    ...DRAMA_VIDEO_RESOLUTION_TIERS.map((tier) => ({ value: tier, label: tier })),
];
/** 剧目级画幅：横屏 / 竖屏（影策 final-view aspectRatioValue 支持 9:16 竖屏）。 */
const VIDEO_ASPECT_OPTIONS: Array<{ value: DramaVideoAspectRatio; label: string }> = [
    { value: "16:9", label: "横屏 16:9" },
    { value: "9:16", label: "竖屏 9:16" },
];

/** 分辨率档位按短边像素比较，登记写法 "720"/"720P"/"720p" 与 UI 档位 "720p" 视为同一档。 */
function resolutionTierMatches(registered: string, tier: string) {
    const shortSide = dramaVideoResolutionShortSide(registered);
    return shortSide !== null && shortSide === dramaVideoResolutionShortSide(tier);
}

export type StudioProductionSettings = {
    // 文字步骤模型（#29）
    assetExtractModel: string;
    storyboardModel: string;
    videoPromptModel: string;
    // 参考图模型与分辨率（#30）
    characterImageModel: string;
    propImageModel: string;
    sceneImageModel: string;
    imageResolution: "1k" | "2k" | "4k";
    // 段落衔接（#31 #46）
    continuationMode: "tail" | "parallel";
    // 同时生成数（#32）：text/video/assemble 三池真实下发 pipelineOpts.concurrency（assemble→render）。
    // image 池后端无剧目级并发覆盖字段，不设假开关。
    concurrency: { text: number; video: number; assemble: number };
    // 预算上限（影策 budgetMicrocredits）：微积分；0/不设=不限。达标暂停流水线（budget_exceeded）。
    budgetMicrocredits: number;
    // 镜头节奏（#33）
    pacing: "极快" | "快" | "标准" | "舒缓" | "慢";
    transitionMs: number;
    // 表演与运镜（#34）
    performanceIntensity: number; // 1-10
    cameraDynamics: number; // 1-10
    // 剧情段视频模型（段级 selectedVideoModel）+ 剧目级分辨率/画幅（真实下发到 H3 出片参数）
    videoModel: string;
    videoResolution: string; // ""=模型默认；480p/720p/1080p=短边像素档
    videoAspectRatio: DramaVideoAspectRatio; // 横屏 16:9 / 竖屏 9:16
    // 钩子与悬念（#36）
    hook: string;
    cliffhanger: string;
    // 音色库（#43）
    voiceProfiles: Array<{ id: string; name: string; description: string; sampleRef: string }>;
    // 样片模式（#10）
    sampleMode: boolean;
    // 审阅方式（影策 reviewMode：sample|every|auto）：启动流水线时真实下发服务端闸门
    reviewMode: "sample" | "every" | "auto";
    // 导演审阅策略（production-contract directorReviewPolicySchema）：与 reviewMode 两套独立闸门，
    // 选择后真写进制作稿 settings.reviewPolicy；控制共享资产/场次审核点是否需人工审阅。
    reviewPolicy: DirectorReviewPolicy;
    // 每集确认前的生成节奏（影策 mediaMode：manual|auto）：启动流水线时真实下发 media 放行门
    mediaMode: "manual" | "auto";
    // 每段最多参考图（影策 referenceLimit：0=按模型上限）：启动流水线时真实下发
    referenceLimit: number;

    // ===== 差异#6 补齐项（按剧目 localStorage 持久化 + 启动流水线真实下发 / 手动改编注入） =====
    // 分镜规则
    episodeSeconds: number;                                        // 单集时长（秒），影策约 90s
    segmentMode: "auto" | "fixed" | "range";                        // 剧情段切分方式（智能/固定/范围），下发 storyboardRules.segmentMode
    segmentRange: { min: number; max: number };                    // 剧情段时长软约束（秒），下发 storyboardRules.segmentRange
    dialogueDensity: "dense" | "standard" | "restrained" | "custom"; // 对白密度
    transitionMode: "smart" | "hard" | "fade" | "flash";           // 转场（转场时长见 transitionMs）
    // 文字步骤：新增「分集规划」模型 + 每步思考等级
    planModel: string;
    textThinking: { plan: ReasoningEffort; extract: ReasoningEffort; storyboard: ReasoningEffort; prompt: ReasoningEffort };
    // 写作技能（来自本地技能库，真值引用 {name,title,path}；plan 用 acheng/story 作默认，其余按槽位映射）
        textSkills: { plan: SkillRef | null; extract: SkillRef | null; storyboard: SkillRef | null; prompt: SkillRef | null };
    // 参考图设定版式（用真实 imageKind 值，"auto" = 跟随资产类型）
    referenceLayout: "auto" | string;
    // 参考图提示词模板（影策「角色提示词/场景提示词/默认」）：空字符串=沿用内置方案模板
    assetPromptTemplates: { character: string; scene: string; default: string };
};

export const DEFAULT_STUDIO_SETTINGS: StudioProductionSettings = {
    assetExtractModel: "",
    storyboardModel: "",
    videoPromptModel: "",
    characterImageModel: "",
    propImageModel: "",
    sceneImageModel: "",
    imageResolution: "1k",
    continuationMode: "tail",
    concurrency: { text: 2, video: 1, assemble: 1 },
    // 默认值逐项对齐影策 DEFAULT_STORYBOARD（storyboard-rules 默认档）：极快 / 密集 / 150ms / 表演 7 / 运镜 3。
    // 剧情段切分默认保留本地后端的 auto（pipeline.ts 未收到 segmentMode 时也按 auto 切段），不写影策的 fixed。
    pacing: "极快",
    transitionMs: 150,
    performanceIntensity: 7,
    cameraDynamics: 3,
    videoModel: "",
    videoResolution: "",
    videoAspectRatio: "16:9",
    hook: "",
    cliffhanger: "",
    voiceProfiles: [],
    sampleMode: false,
    reviewMode: "auto",
    reviewPolicy: { ...DEFAULT_REVIEW_POLICY },
    budgetMicrocredits: 0,
    mediaMode: "auto",
    referenceLimit: 0,
    // 差异#6
    episodeSeconds: 90,
    segmentMode: "auto",
    segmentRange: { min: 8, max: 15 },
    dialogueDensity: "dense",
    transitionMode: "smart",
    planModel: "",
    textThinking: { plan: "auto", extract: "auto", storyboard: "auto", prompt: "auto" },
    textSkills: { plan: null, extract: null, storyboard: null, prompt: null },
    referenceLayout: "auto",
    assetPromptTemplates: { character: "", scene: "", default: "" },
};

/** 单集时长：影策 MIN/MAX_EPISODE_SECONDS 与 EPISODE_PRESETS（lib/drama/storyboard.ts:6-7,38）。 */
const MIN_EPISODE_SECONDS = 30;
const MAX_EPISODE_SECONDS = 1200;
const EPISODE_PRESETS = [60, 90, 120, 180, 300, 600] as const;
/** 剧情段秒数与转场时长范围：影策 MIN/MAX_SEGMENT_SECONDS、MIN_TRANSITION_MS 与 1500 上限。 */
const MIN_SEGMENT_SECONDS = 4;
const MAX_SEGMENT_SECONDS = 60;
const MIN_TRANSITION_MS = 150;
const MAX_TRANSITION_MS = 1500;

/** 影策 formatEpisodeSeconds：90 → 「1 分 30 秒」，60 → 「1 分钟」。 */
function formatEpisodeSeconds(seconds: number) {
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** 影策 parseEpisodeSeconds：解析「90 / 5分钟 / 5min / 2:30 / 1分30秒」，无法识别返回 null。 */
function parseEpisodeSeconds(raw: string): number | null {
    const text = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (!text) return null;
    const clock = text.match(/^(\d+):(\d{1,2})$/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    const mixed = text.match(/^(\d+(?:\.\d+)?)(?:分钟?|min|m)(?:(\d+)(?:秒|s)?)?$/);
    if (mixed) return Math.round(Number(mixed[1]) * 60 + Number(mixed[2] || 0));
    const seconds = text.match(/^(\d+(?:\.\d+)?)(?:秒|s|sec)?$/);
    if (seconds) return Math.round(Number(seconds[1]));
    return null;
}

/** 影策 storyboard-rules.tsx 档位说明：滑杆刻度下写出当前档位在提示词里的含义（纯展示，不改数据模型）。 */
const PACING_DETAIL: Record<string, string> = {
    "极快": "1.5–3 秒短镜连切，冲突与反转处密集切换，几乎不用长镜头",
    "快": "2–4 秒短镜为主，冲突处密集切换",
    "标准": "2–5 秒为主，关键台词可到 6 秒",
    "舒缓": "3–6 秒为主，情绪戏可到 8 秒",
    "慢": "4–8 秒长镜，可用空镜营造情绪",
};
/** 影策 SEGMENT_MODES 档位说明：剧情段切分方式。 */
const SEGMENT_MODE_DETAIL: Record<string, string> = {
    "auto": "按场景切换与冲突转折切段，单段不超过视频模型单次上限",
    "fixed": "每段固定秒数，跨场景也按时长切",
    "range": "每段在设定范围内，达到下限后在场景切换处断开",
};
/** 影策 storyboard-rules.tsx:120-125 DIALOGUE 档位说明（只写适用场景，数值由后端规则决定）。 */
const DIALOGUE_DETAIL: Record<string, string> = {
    "dense": "适合爽剧、对手戏",
    "standard": "适合多数剧情",
    "restrained": "留给动作与氛围",
    "custom": "按剧情需要自行安排，全剧统一口径",
};
/** 影策 storyboard-rules.tsx:147-152 TRANSITIONS 档位说明。 */
const TRANSITION_DETAIL: Record<string, string> = {
    "smart": "默认硬切，场景跳转用黑场，回忆用闪白",
    "hard": "全部直接切换",
    "fade": "每次切镜都经过黑场",
    "flash": "每次切镜都短暂闪白",
};
/** 摘要估算：影策 PACING 平均镜头秒数（lib/drama/storyboard.ts:23，本地 canvas-agent/drama/pacing.ts 同表移植）。 */
const PACING_AVERAGE_SECONDS: Record<string, number> = { "极快": 2, "快": 2.5, "标准": 3.5, "舒缓": 4.5, "慢": 5.5 };
/** 影策 DIALOGUE_PRESETS 与本地 canvas-agent/drama/pacing.ts dialogueRules 同表：语速、单句秒数、单句字数、气口。 */
const DIALOGUE_RULES: Record<string, { speechRate: number; lineSeconds: number; lineMaxRunes: number; linePauseMs: number }> = {
    dense: { speechRate: 4.5, lineSeconds: 3, lineMaxRunes: 12, linePauseMs: 300 },
    standard: { speechRate: 4.5, lineSeconds: 4.5, lineMaxRunes: 16, linePauseMs: 500 },
    restrained: { speechRate: 4.5, lineSeconds: 7, lineMaxRunes: 20, linePauseMs: 500 },
};

const PERFORMANCE_BANDS_DETAIL = [
    "几乎不动声色，情绪只在眼神、呼吸和极细微的表情里，台词轻声平稳但有潜台词",
    "表情变化小而准确，靠眼神、停顿传达情绪，关键句压低声音或放慢加力，适合悬疑、文艺",
    "表情随台词实时变化，台词有轻重缓急和停顿，说话时其他人有可见反应",
    "冲突处瞪眼、咬牙、冷笑、红眼眶，台词音量随情绪起伏、关键句爆发，适合爽剧",
    "情绪大开大合、动作放大到一眼可读，爆发处怒吼、哽咽、破音，关键台词后给反应特写",
] as const;
const PERFORMANCE_BANDS_LABEL = ["内敛", "克制", "自然", "饱满", "夸张"] as const;
const CAMERA_BANDS_DETAIL = [
    "固定机位为主，只做极缓慢的推近，靠构图和表演推动情绪",
    "固定机位与缓慢推拉为主，对话正反打，情绪高点才推近特写",
    "推拉摇移服务于情绪，对话正反打与过肩，情绪升级时推近特写，不整段静止",
    "冲突与反转处快速推近、跟拍、低机位仰拍，多数镜头有机位运动或人物调度",
    "频繁快速推拉、甩镜、手持跟拍与环绕，每个镜头都有明确运动，节奏紧凑",
] as const;
const CAMERA_BANDS_LABEL = ["静态", "稳定", "标准", "动感", "强烈"] as const;
/** 1–10 档 → 五段索引（1-2/3-4/5-6/7-8/9-10），与影策 performanceBands/cameraBands 同口径。 */
const levelBandIndex = (value: number) => Math.min(4, Math.max(0, Math.floor((value - 1) / 2)));

const storageKey = (dramaId: string) => `drama-studio:settings:${dramaId}`;

/** 剧情段秒数区间收敛到影策 4–60 秒，并保证 min ≤ max（等价 normalizeStoryboard 的 seconds()/大小互换）。 */
function clampRange(range: { min: number; max: number }) {
    const clamp = (value: unknown) => Math.max(MIN_SEGMENT_SECONDS, Math.min(MAX_SEGMENT_SECONDS, Math.round(Number(value) || MIN_SEGMENT_SECONDS)));
    const low = clamp(range.min);
    const high = clamp(range.max);
    return { min: Math.min(low, high), max: Math.max(low, high) };
}

export function loadStudioSettings(dramaId: string | null): StudioProductionSettings {
    if (!dramaId) return { ...DEFAULT_STUDIO_SETTINGS };
    try {
        const raw = localStorage.getItem(storageKey(dramaId));
        if (!raw) return { ...DEFAULT_STUDIO_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<StudioProductionSettings>;
        return {
            ...DEFAULT_STUDIO_SETTINGS,
            ...parsed,
            concurrency: { ...DEFAULT_STUDIO_SETTINGS.concurrency, ...(parsed.concurrency || {}) },
            // 老剧目 localStorage 没有 segmentMode 时按默认 auto；非法值收敛，不让坏值进 UI/下发。
            segmentMode: (["auto", "fixed", "range"] as const).includes(parsed.segmentMode as "auto") ? parsed.segmentMode as "auto" | "fixed" | "range" : DEFAULT_STUDIO_SETTINGS.segmentMode,
            // 影策 clamp（storyboard.ts:62-85）：剧情段 4–60 秒、单集 30–1200 秒、转场 150–1500 毫秒，越界值收敛后才进 UI/下发。
            segmentRange: clampRange({ ...DEFAULT_STUDIO_SETTINGS.segmentRange, ...(parsed.segmentRange || {}) }),
            episodeSeconds: Math.max(MIN_EPISODE_SECONDS, Math.min(MAX_EPISODE_SECONDS, Math.round(Number(parsed.episodeSeconds) || DEFAULT_STUDIO_SETTINGS.episodeSeconds))),
            transitionMs: Math.max(MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, Math.round(Number(parsed.transitionMs) || MIN_TRANSITION_MS))),
            textThinking: { ...DEFAULT_STUDIO_SETTINGS.textThinking, ...(parsed.textThinking || {}) },
            textSkills: { ...DEFAULT_STUDIO_SETTINGS.textSkills, ...(parsed.textSkills || {}) },
            voiceProfiles: Array.isArray(parsed.voiceProfiles) ? parsed.voiceProfiles : [],
            // 老剧目没有模板字段时按空（沿用内置方案模板），非字符串值收敛成空串，不让坏值进 UI。
            assetPromptTemplates: {
                character: String(parsed.assetPromptTemplates?.character ?? ""),
                scene: String(parsed.assetPromptTemplates?.scene ?? ""),
                default: String(parsed.assetPromptTemplates?.default ?? ""),
            },
            // 老剧目没有该字段时按默认（不审阅），非法组合按 schema 收敛，不让坏值进 UI。
            reviewPolicy: normalizeReviewPolicy(parsed.reviewPolicy),
        };
    } catch {
        return { ...DEFAULT_STUDIO_SETTINGS };
    }
}

function Section({ icon, title, desc, aside, children, marker }: { icon: React.ReactNode; title: string; desc?: string; aside?: string; children: React.ReactNode; marker?: string }) {
    return (
        <section className="rounded-[8px] border border-foreground/10 bg-card px-4 pt-3 pb-4" data-studio-settings-section={marker}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="flex shrink-0 items-center gap-2">
                    <span className="text-foreground">{icon}</span>
                    <h3 className="text-[11px] font-semibold" style={{ fontWeight: 600 }}>{title}</h3>
                </span>
                {aside ? <span className="text-[11px] leading-relaxed text-foreground/40" data-studio-section-aside>{aside}</span> : null}
            </div>
            {desc ? <p className="mb-2 text-[11px] leading-relaxed text-foreground/40">{desc}</p> : null}
            <div className="space-y-2">{children}</div>
        </section>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="flex items-center gap-2 text-[13px]">
            <span className="w-28 shrink-0 text-[11px] font-semibold text-foreground/55">{label}</span>
            <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
            {hint ? <span className="shrink-0 text-[11px] text-foreground/40">{hint}</span> : null}
        </label>
    );
}

/** 一组并列选项按钮（分段控件），用于智能/固定、对白密度、转场等分段选项。 */
function ChoiceButtons<T extends string>({ value, options, onChange, marker }: {
    value: T;
    options: ReadonlyArray<{ value: T; label: string }>;
    onChange: (v: T) => void;
    marker?: string;
}) {
    return (
        <div className="inline-flex w-fit flex-wrap gap-0.5 rounded-[8px] border border-foreground/10 bg-foreground/5 p-1" data-studio-choice={marker}>
            {options.map((o) => (
                <button key={o.value} type="button" onClick={() => onChange(o.value)} style={{ fontSize: 11 }}
                    className={cn("flex h-[26px] items-center rounded-[8px] px-3 text-[11px] transition",
                        value === o.value ? "bg-card text-foreground" : "text-foreground/55 hover:text-foreground")}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/**
 * 滑杆数值气泡（原生 range 与 TickSlider 共用）：绝对定位于手柄正上方，
 * left 按 (value-min)/(max-min) 的百分比推算；thumbPx 用于补偿原生 range 拇指内缩，
 * 使气泡中心与拇指中心对齐（0% 时拇指中心距轨道左端 thumbPx/2）。
 * 显示/隐藏由父级 state 只切 opacity，淡出完全交给 CSS transition，不排队 JS 定时器。
 * pointer-events-none：不挡住轨道/其它控件点击；aria-hidden：数值已有可见文本或 aria-valuetext，
 * 不让读屏把同一数值播报两遍。
 */
function SliderValueBubble({ pct, text, visible, thumbPx = 0 }: {
    pct: number; text: string; visible: boolean; thumbPx?: number;
}) {
    const p = Math.max(0, Math.min(100, pct));
    const thumbShift = thumbPx ? (0.5 - p / 100) * thumbPx : 0;
    return (
        <span
            aria-hidden="true"
            data-studio-slider-bubble
            className={cn(
                "pointer-events-none absolute -top-5 z-10 -translate-x-1/2 whitespace-nowrap rounded-[4px] bg-foreground px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-background shadow-sm transition-opacity ease-out motion-reduce:transition-none",
                visible ? "opacity-100 duration-100" : "opacity-0 duration-[400ms]",
            )}
            style={{ left: `clamp(16px, calc(${p}% + ${thumbShift}px), calc(100% - 16px))` }}
        >
            {text}
        </span>
    );
}

/**
 * 影策离散刻度滑块：一条轨道 + 5 个节点 + 中文刻度标签 + 当前档大圆环手柄。
 * 与影策 ChoiceSlider / LevelSlider 同观感：手柄/节点/标签共用「值→位置」线性映射，不会错位。
 * - value: 当前实际值；tickValues: 每个刻度对应的值（影策表演/运镜是 1/3/5/7/10，节奏是 0..4）；
 * - min/max: 值域；onValue: 选值回调（点轨道按最近整数、点刻度按该档值）；readout: 右侧读数；
 * - bubble: 手柄上方气泡文案（缺省用 readout，再缺省用原始值）。
 */
function TickSlider({ value, labels, tickValues, min, max, onValue, readout, bubble, marker }: {
    value: number; labels: readonly string[]; tickValues: readonly number[]; min: number; max: number;
    onValue: (v: number) => void; readout?: string; bubble?: string; marker?: string;
}) {
    const [bubbleVisible, setBubbleVisible] = useState(false);
    const frac = (v: number) => (max > min ? (v - min) / (max - min) : 0);
    const clampPct = (f: number) => Math.max(0, Math.min(100, f * 100));
    const activeIndex = tickValues.reduce((best, tv, i) => Math.abs(tv - value) < Math.abs(tickValues[best] - value) ? i : best, 0);
    return (
        <div className="flex min-w-0 flex-1 items-center gap-3 max-w-[480px]" data-studio-tick-slider={marker}>
            <div className="min-w-0 flex-1"
                onPointerDown={() => setBubbleVisible(true)}
                onPointerUp={() => setBubbleVisible(false)}
                onPointerCancel={() => setBubbleVisible(false)}
                onPointerLeave={() => setBubbleVisible(false)}
                onFocus={() => setBubbleVisible(true)}
                onBlur={() => setBubbleVisible(false)}>
                {/* 整条轨道按 step 切成等宽可点区段：点哪儿取该档值，不依赖 clientX（避免坐标系错位）。 */}
                <div className="relative h-5" data-studio-tick-track={marker}>
                    <SliderValueBubble pct={clampPct(frac(value))} text={bubble ?? readout ?? String(value)} visible={bubbleVisible} />
                    <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/5" />
                    <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/80" style={{ width: `${clampPct(frac(value))}%` }} />
                    {/* 可点区段：每个整数值一段，整轨覆盖。节奏 0..4 共5段，表演/运镜 1..10 共10段。 */}
                    <div className="absolute inset-0 flex" data-studio-tick-hit={marker}>
                        {Array.from({ length: max - min + 1 }, (_, i) => (
                            <button key={i} type="button" aria-label={`设为 ${min + i}`} title={`${min + i}`}
                                onClick={() => onValue(min + i)} className="h-full flex-1 cursor-pointer" />
                        ))}
                    </div>
                    {tickValues.map((tv, i) => (
                        <span key={i} className="pointer-events-none absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-card"
                            style={{ left: `${clampPct(frac(tv))}%` }} />
                    ))}
                    <div className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-card"
                        style={{ left: `${clampPct(frac(value))}%` }} data-studio-tick-handle={marker} />
                </div>
                {/* 刻度标签按真实 fraction 定位，与节点/手柄同坐标；首尾标签做边界内收，避免溢出 */}
                <div className="relative mt-0.5 h-4">
                    {labels.map((label, i) => (
                        <button key={label} type="button" onClick={() => onValue(tickValues[i])}
                            className={cn("absolute whitespace-nowrap text-[11px] transition",
                                i === activeIndex ? "text-foreground" : "text-foreground/55 hover:text-foreground",
                                i === 0 ? "left-0" : i === labels.length - 1 ? "right-0" : "-translate-x-1/2")}
                            style={i > 0 && i < labels.length - 1 ? { left: `${clampPct(frac(tickValues[i]))}%`, fontSize: 11 } : { fontSize: 11 }}
                            data-studio-tick-active={i === activeIndex ? "1" : undefined}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>
            {readout ? <span className="w-10 shrink-0 text-right text-[11px] font-semibold tabular-nums text-foreground">{readout}</span> : null}
        </div>
    );
}

function ModelSelect({ value, capability, onChange, config }: {
    value: string;
    capability: "text" | "image" | "video";
    onChange: (value: string) => void;
    config: ReturnType<typeof useConfigStore.getState>["config"];
}) {
    const { engineOptions, fallbackOptions } = useMemo(() => {
        const options = selectableModelsByCapability(config, capability);
        if (capability !== "text") return { engineOptions: options, fallbackOptions: [] as string[] };
        // 文字步骤以本地 Hermes 引擎为主：把该渠道的 text 模型置顶，其余保留为回退入口。
        const engineIds = new Set(config.channels.filter((channel) => channel.kind === "hermes").map((channel) => channel.id));
        const engine = options.filter((option) => engineIds.has(String(option).split("::")[0]));
        const fallback = options.filter((option) => !engineIds.has(String(option).split("::")[0]));
        return { engineOptions: engine, fallbackOptions: fallback };
    }, [config, capability]);
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-[34px] min-w-0 flex-1 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] text-foreground outline-none focus:border-primary"
            data-studio-model-select={capability}
        >
            <option value="">跟随默认</option>
            {engineOptions.length ? (
                <optgroup label="本地引擎 · Hermes">
                    {engineOptions.map((option) => (
                        <option key={option} value={option}>{modelOptionLabel(config, option)}</option>
                    ))}
                </optgroup>
            ) : null}
            {fallbackOptions.length ? (
                <optgroup label="其他模型（回退）">
                    {fallbackOptions.map((option) => (
                        <option key={option} value={option}>{modelOptionLabel(config, option)}</option>
                    ))}
                </optgroup>
            ) : null}
            {capability !== "text" ? engineOptions.map((option) => (
                <option key={option} value={option}>{modelOptionLabel(config, option)}</option>
            )) : null}
        </select>
    );
}

export function StudioSettingsTab({ dramaId, settings, onChange, onSave, onReset, saving, studioInfo, onRedoRefs, onEpisodesChanged, onPlanningChanged }: {
    dramaId: string | null;
    settings: StudioProductionSettings;
    onChange: (next: StudioProductionSettings) => void;
    onSave: () => void;
    onReset: () => void;
    saving: boolean;
    /** 作品/分集方式的只读真实数据（来自 folder.productionPlan 与剧集统计），不造假可编辑框。 */
    studioInfo?: {
        dramaName: string;
        episodeCount: number;
        chapterCount: number;
        perEpisode: number;
        excludedCount: number;
        /** 真实的分集方式（来自 folder.productionPlan.episodeMode，缺省按 chapter）。 */
        episodeMode?: "auto" | "chapter";
        /** 强一致分集游标：planDone 后禁止改分集方式/结果。 */
        planDone?: boolean;
        planCursor?: number;
        lastChapterIndex?: number;
    };
    /** 影策「按当前方案重做参考图」：跳到资产库并预选分类（真实出图入口）。 */
    onRedoRefs?: (kind: "角色" | "道具" | "场景") => void;
    /** 模型分集建集后刷新剧目/分集真值（页面已有的 refreshAll）。 */
    onEpisodesChanged?: () => void | Promise<void>;
    /** 分集完成后刷新游标/完成锁状态，避免前端仍显示可编辑。 */
    onPlanningChanged?: () => void | Promise<void>;
}) {
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const navigate = useNavigate();
    const folders = useCanvasStore((state) => state.folders);
    const patch = <K extends keyof StudioProductionSettings>(key: K, value: StudioProductionSettings[K]) =>
        onChange({ ...settings, [key]: value });

    // 转场时长原生 range 的数值气泡：pointerdown/focus/input 显示并随值实时更新；pointerup/blur 后只切 opacity，
    // 由 CSS transition（400ms）淡出，不排定时器，连续拖动不会堆积。
    const [transitionBubbleVisible, setTransitionBubbleVisible] = useState(false);

    // 单集时长文本输入（影策 EpisodeDurationInput）：草稿与真值分离，失焦/回车才解析成秒并夹到 30–1200；
    // 支持「90 / 5分钟 / 2:30」三种写法，非法写法就地报错并还原为当前真值。
    const [episodeSecondsDraft, setEpisodeSecondsDraft] = useState(formatEpisodeSeconds(settings.episodeSeconds));
    const [episodeSecondsError, setEpisodeSecondsError] = useState("");
    useEffect(() => {
        setEpisodeSecondsDraft(formatEpisodeSeconds(settings.episodeSeconds));
    }, [settings.episodeSeconds]);
    const commitEpisodeSeconds = (raw: string) => {
        const parsed = parseEpisodeSeconds(raw);
        if (parsed === null) {
            setEpisodeSecondsError("可输入 90、5分钟、2:30");
            setEpisodeSecondsDraft(formatEpisodeSeconds(settings.episodeSeconds));
            return;
        }
        const seconds = Math.max(MIN_EPISODE_SECONDS, Math.min(MAX_EPISODE_SECONDS, Math.round(parsed)));
        setEpisodeSecondsError(seconds !== Math.round(parsed)
            ? `单集时长需在 ${formatEpisodeSeconds(MIN_EPISODE_SECONDS)}–${formatEpisodeSeconds(MAX_EPISODE_SECONDS)} 之间，已调整`
            : "");
        setEpisodeSecondsDraft(formatEpisodeSeconds(seconds));
        if (seconds !== settings.episodeSeconds) patch("episodeSeconds", seconds);
    };

    // ===== 审阅策略 reviewPolicy：与 reviewMode 不同的第二套闸门，选择后真写进制作稿 settings.reviewPolicy =====
    const [reviewPolicySaving, setReviewPolicySaving] = useState(false);
    const [reviewPolicyNote, setReviewPolicyNote] = useState("");
    const persistReviewPolicy = async (policy: DirectorReviewPolicy) => {
        patch("reviewPolicy", policy);
        if (!dramaId) return;
        setReviewPolicySaving(true);
        setReviewPolicyNote("");
        try {
            const { episodes } = await fetchBackendDramaEpisodes(dramaId);
            const usable = (episodes || []).filter((ep) => Boolean(ep?.id));
            if (!usable.length) throw new Error("剧目还没有分集，策略待制作稿就绪后可再保存");
            let applied = 0;
            for (const ep of usable) {
                const { production } = await fetchEpisodeProduction(ep.id);
                if (!production) continue;
                await editEpisodeProduction(ep.id, production.revision, [
                    { type: "set_settings", patch: { reviewPolicy: policy } } as never,
                ]);
                applied += 1;
            }
            if (!applied) throw new Error("分集制作稿尚未就绪");
            setReviewPolicyNote(`已写入 ${applied} 集制作稿 settings.reviewPolicy，导演审阅闸门真实生效`);
        } catch (error) {
            setReviewPolicyNote(`写入制作稿失败：${error instanceof Error ? error.message : String(error)}（本地设置已更新，可在制作稿就绪后重新保存）`);
        } finally {
            setReviewPolicySaving(false);
        }
    };

    // ===== 参考图默认方案：选中真实 AssetSchemeId，可批量写进每集资产卡 view_layout =====
    const [layoutApplying, setLayoutApplying] = useState(false);
    const [layoutNote, setLayoutNote] = useState("");
    /** 参考图提示词模板当前编辑档：角色 / 场景 / 默认（影策三档）。 */
    const [templateKind, setTemplateKind] = useState<"character" | "scene" | "default">("character");
    const templateInputRef = useRef<HTMLTextAreaElement | null>(null);
    const assetTemplates = settings.assetPromptTemplates || { character: "", scene: "", default: "" };
    const templateValue = String(assetTemplates[templateKind] ?? "");
    // 预览与后端同一渲染函数（canvas-agent 导出），保证「看到什么就发什么」。
    const templatePreview = useMemo(() => {
        const kind = templateKind === "character" ? "character" : templateKind === "scene" ? "scene" : "prop";
        const scheme = (kind === "character" ? "portrait" : kind === "scene" ? "scene" : "prop") as AssetSchemeId;
        const templates = templateKind === "default" ? { default: templateValue } : ({ [templateKind]: templateValue } as Record<string, string>);
        return renderAssetPromptWithTemplate(kind, "示例角色", "示例外观：青衫少年，佩剑", scheme,
            templates, { 资产名称: "示例角色", 资产设定: "示例外观：青衫少年，佩剑", 画面规则: "", 项目画风: "" }).prompt;
    }, [templateKind, templateValue]);
    const applyReferenceLayout = async () => {
        const scheme = settings.referenceLayout;
        if (!dramaId || !ASSET_SCHEME_OPTIONS.some((o) => o.value === scheme)) return;
        setLayoutApplying(true);
        setLayoutNote("");
        try {
            const { episodes } = await fetchBackendDramaEpisodes(dramaId);
            let cards = 0;
            let episodesChanged = 0;
            for (const ep of episodes || []) {
                const { production } = await fetchEpisodeProduction(ep.id);
                if (!production) continue;
                const draft = (production.draft || {}) as Record<string, any>;
                const rows = Array.isArray(draft?.director?.source?.asset_cards) ? draft.director.source.asset_cards as Array<Record<string, unknown>> : [];
                const ops: Array<Record<string, unknown>> = [];
                for (const card of rows) {
                    const id = String(card?.id || card?.asset_id || "");
                    const rawKind = String(card?.asset_kind || card?.kind || "").toLowerCase();
                    if (!id || !["character", "scene", "prop"].includes(rawKind)) continue;
                    const kind = rawKind as "character" | "scene" | "prop";
                    const effective = scheme === "auto" ? defaultSchemeFor(kind) : scheme as AssetSchemeId;
                    if (!schemeAppliesTo(effective, kind)) continue;
                    ops.push({ type: "patch_director_source", entity: "asset_card", id, patch: { view_layout: effective } });
                }
                if (!ops.length) continue;
                await editEpisodeProduction(ep.id, production.revision, ops as never);
                cards += ops.length;
                episodesChanged += 1;
            }
            const label = scheme === "auto" ? "按资产类型自动匹配" : ASSET_SCHEME_OPTIONS.find((o) => o.value === scheme)?.name || scheme;
            setLayoutNote(`已把「${label}」写入 ${episodesChanged} 集共 ${cards} 张资产卡的 view_layout（流水线按方案拼提示词）`);
        } catch (error) {
            setLayoutNote(`应用失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setLayoutApplying(false);
        }
    };

    // ===== productionStage：只读展示制作稿真值（与 agent 总流程同一字段），不做假开关 =====
    const [stageTruth, setStageTruth] = useState<{ current: string; done: string[]; episodeNo: number } | null>(null);
    const [stageNote, setStageNote] = useState("");
    useEffect(() => {
        let alive = true;
        setStageTruth(null);
        setStageNote("");
        if (!dramaId) return () => { alive = false; };
        void (async () => {
            try {
                const { episodes } = await fetchBackendDramaEpisodes(dramaId);
                const first = (episodes || [])[0];
                if (!first?.id) { if (alive) setStageNote("还没有分集制作稿，暂无阶段游标"); return; }
                const { production } = await fetchEpisodeProduction(first.id);
                const raw = (production?.draft as Record<string, any> | undefined)?.settings?.productionStage;
                const value = raw && typeof raw === "object"
                    ? {
                        current: String(raw.current || ""),
                        done: Array.isArray(raw.done) ? raw.done.map(String) : [],
                        episodeNo: first.episodeNumber,
                    }
                    : null;
                if (alive) {
                    setStageTruth(value);
                    if (!value) setStageNote("该集制作稿尚未初始化生产阶段游标（老项目不拦截）");
                }
            } catch {
                if (alive) setStageNote("制作稿读取失败，阶段信息暂不可用");
            }
        })();
        return () => { alive = false; };
    }, [dramaId]);

    // 分集方式的真值在 folder.productionPlan.episodeMode；缺省（老剧目）按 chapter 解释。
    const episodeFolder = useMemo(() => folders.find((f) => f.id === dramaId) || null, [folders, dramaId]);
    const folderPlan = (episodeFolder?.productionPlan || {}) as Record<string, unknown>;
    const initialMode = studioInfo?.episodeMode ?? (folderPlan.episodeMode === "auto" ? "auto" : "chapter");
    // 强一致分集：plan_done=true 后整份分集方案锁写。
    const planLocked = Boolean(studioInfo?.planDone);
    const [episodeMode, setEpisodeMode] = useState<"chapter" | "auto">(initialMode);
    const [groupingPreview, setGroupingPreview] = useState<DramaEpisodeGroupingPreview | null>(null);
    const [groupingBusy, setGroupingBusy] = useState(false);
    const [groupingError, setGroupingError] = useState("");
    const [groupingDone, setGroupingDone] = useState("");
    useEffect(() => {
        setEpisodeMode(studioInfo?.episodeMode ?? (folderPlan.episodeMode === "auto" ? "auto" : "chapter"));
        setGroupingPreview(null);
        setGroupingError("");
        setGroupingDone("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dramaId, episodeFolder?.updatedAt, studioInfo?.episodeMode]);

    const changeEpisodeMode = async (mode: "chapter" | "auto") => {
        if (!dramaId || planLocked || mode === episodeMode) return;
        const previous = episodeMode;
        setEpisodeMode(mode);
        setGroupingPreview(null);
        setGroupingError("");
        setGroupingDone("");
        try {
            await patchDramaPlanningMode(dramaId, mode, episodeFolder?.updatedAt || undefined);
            await onEpisodesChanged?.();
        } catch (error) {
            setEpisodeMode(previous);
            setGroupingError(`保存分集方式失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const runGroupingPreview = async () => {
        if (!dramaId || planLocked) return;
        setGroupingBusy(true);
        setGroupingError("");
        setGroupingDone("");
        setGroupingPreview(null);
        try {
            setGroupingPreview(await previewDramaEpisodeGrouping(dramaId));
        } catch (error) {
            setGroupingError(`预览失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGroupingBusy(false);
        }
    };

    const confirmGrouping = async () => {
        if (!dramaId || !groupingPreview?.groups.length) return;
        setGroupingBusy(true);
        setGroupingError("");
        try {
            // 只提交确认的候选字段；episodeNumber 由后端按快照与现有集号分配。
            const groups = groupingPreview.groups.map(({ title, chapters, synopsis, hook, cliffhanger }) => ({ title, chapters, synopsis, hook, cliffhanger }));
            const applied = await applyDramaEpisodeGrouping(dramaId, { groups, expectedUpdatedAt: episodeFolder?.updatedAt || undefined });
            setGroupingDone(applied.planDone
                ? `全部章节已规划完成（已到第 ${applied.lastChapterIndex ?? 0} 章），分集结果已锁定`
                : `本批已建 ${groups.length} 集，游标推进到第 ${applied.planCursor ?? 0} 章，可继续预览下一批`);
            setGroupingPreview(null);
            await onPlanningChanged?.();
            await onEpisodesChanged?.();
        } catch (error) {
            setGroupingError(`建集失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGroupingBusy(false);
        }
    };

    const runAutoGrouping = async () => {
        if (!dramaId || planLocked) return;
        setGroupingBusy(true);
        setGroupingError("");
        setGroupingDone("");
        setGroupingPreview(null);
        try {
            const outcome = await autoPlanDramaEpisodeGrouping(dramaId);
            if (!outcome.ok) {
                setGroupingError(`自动规划中断：${outcome.error || "未知错误"}（游标 ${outcome.planCursor ?? 0}/${outcome.lastChapterIndex ?? 0}，再次点击可从当前游标续跑）`);
            } else {
                setGroupingDone(outcome.message || `全部 ${outcome.episodes?.length ?? 0} 集已自动规划完成`);
            }
            await onPlanningChanged?.();
            await onEpisodesChanged?.();
        } catch (error) {
            setGroupingError(`自动规划失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGroupingBusy(false);
        }
    };

    // 视觉风格 / 对白语言：剧目规划（folder.productionPlan.topic）里的真实值。
    const artStyle = useMemo(() => {
        const folder = folders.find((f) => f.id === dramaId);
        const topic = (folder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined;
        return String(topic?.artStyle || "");
    }, [folders, dramaId]);
    const dialogueLanguage = useMemo(() => {
        const folder = folders.find((f) => f.id === dramaId);
        const topic = (folder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined;
        return String(topic?.language || "");
    }, [folders, dramaId]);

    // ===== 一键按当前方案重做参考图（影策 regenerateDramaCasts 缺口）=====
    // 真出图 → bind-image 写回 → 标脏引用段；资产 ID 由用户从资产库设定详情复制。
    const [regenAssetId, setRegenAssetId] = useState("");
    const [regenBusy, setRegenBusy] = useState(false);
    const [regenResult, setRegenResult] = useState("");
    const [regenError, setRegenError] = useState("");
    const runOneClickRegen = async () => {
        const assetId = regenAssetId.trim();
        if (!dramaId || !assetId) {
            setRegenError("请先填写资产 ID（形如 asset-character-xxxxxx）");
            return;
        }
        setRegenBusy(true);
        setRegenResult("");
        setRegenError("");
        try {
            const result = await regenerateDramaAssetReference(dramaId, assetId, {
                artStyle: artStyle.trim() || undefined,
            });
            if (!result.ok || !result.storageKey) {
                setRegenError(result.error || "重做失败，未写回资产参考图");
                return;
            }
            setRegenResult(`已写回 ${result.storageKey} · 分集 ${result.episodeId} · 节点 ${result.nodeId} · 标脏段 ${result.affectedSegments ?? 0}`);
        } catch (error) {
            setRegenError(error instanceof Error ? error.message : String(error));
        } finally {
            setRegenBusy(false);
        }
    };

    // ===== 视觉风格两轴（表现形式 × 题材）=====
    // 真值仍是单轴 topic.artStyle；两轴组合派生 prompt 后复用剧目规划 PATCH 写回同一字段。
    const [artStyleDraft, setArtStyleDraft] = useState(artStyle);
    const [styleForm, setStyleForm] = useState<DramaStyleFormId | "">("");
    const [styleTheme, setStyleTheme] = useState<DramaStyleThemeId | "">("");
    const [styleSaving, setStyleSaving] = useState(false);
    const [styleError, setStyleError] = useState("");
    // 后端真值变化（切剧目 / 别处保存 / 下方刷新 folder）时回填两轴选中态；自由输入串回填为「未选择」。
    useEffect(() => {
        setArtStyleDraft(artStyle);
        const composed = findComposedDramaStyleByPrompt(artStyle);
        setStyleForm(composed?.composition.formId ?? "");
        setStyleTheme(composed?.composition.themeId ?? "");
    }, [dramaId, artStyle]);

    /** 写回画风并即时刷新 folder 真值（出图注入 / 资产页 / 作品只读行都读 productionPlan.topic.artStyle）。 */
    const persistArtStyle = async (value: string, form: DramaStyleFormId | "", theme: DramaStyleThemeId | "") => {
        if (!dramaId) return;
        setStyleSaving(true);
        setStyleError("");
        setArtStyleDraft(value);
        setStyleForm(form);
        setStyleTheme(theme);
        try {
            await patchDramaTopicArtStyle(dramaId, value);
            try {
                const fresh = await fetchBackendCanvasFolders();
                const nextFolders = fresh.folders as CanvasFolder[] | undefined;
                if (nextFolders) useCanvasStore.getState().replaceFolders(nextFolders);
            } catch { /* 刷新失败不阻断保存结果，下次进入页面读真值 */ }
        } catch (error) {
            setStyleError(`画风保存失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setStyleSaving(false);
        }
    };
    const chooseStyleAxes = (form: DramaStyleFormId | "", theme: DramaStyleThemeId | "") => {
        setStyleForm(form);
        setStyleTheme(theme);
        if (form && theme) {
            const style = findComposedDramaStyle(composeDramaStyleId(form, theme));
            if (style) void persistArtStyle(style.prompt, form, theme);
        }
    };
    const commitFreeArtStyle = () => {
        const value = artStyleDraft.trim();
        if (value === artStyle) return;
        const composed = findComposedDramaStyleByPrompt(value);
        void persistArtStyle(value, composed?.composition.formId ?? "", composed?.composition.themeId ?? "");
    };
    const chosenFormName = DRAMA_STYLE_FORMS.find((f) => f.id === styleForm)?.name || "";
    const chosenThemeName = DRAMA_STYLE_THEMES.find((t) => t.id === styleTheme)?.name || "";

    // 模型声明的默认档位仅作提示（只读真值）；实际可选档位走 pipelineOpts 真实下发链路。
    const modelDeclaredResolution = useMemo(() => {
        const chosen = settings.videoModel.trim();
        if (!chosen) return "";
        for (const channel of config.channels) {
            for (const model of channel.models) {
                if (encodeChannelModel(channel.id, model.name) !== chosen) continue;
                const params = model.workflowParams || {};
                const value = params.multi?.resolution ?? params.single?.resolution ?? params.text?.resolution;
                return typeof value === "string" ? value : "";
            }
        }
        return "";
    }, [config.channels, settings.videoModel]);

    // 与后端共享同一换算：档位 + 画幅 → 真实 H3 出片尺寸（展示值 == 出片值，不是估算假值）。
    const resolutionEffective = useMemo(
        () => dramaVideoResolutionToH3(settings.videoResolution, settings.videoAspectRatio),
        [settings.videoResolution, settings.videoAspectRatio],
    );

    // 当前视频模型的真能力来自模型登记 / 引擎上报的显式字段；缺字段返回 {}，下面一律「缺省不告警/不限制」。
    const modelVideoCapabilities = useMemo(
        () => modelVideoCapabilitiesOf(config, settings.videoModel),
        [config, settings.videoModel],
    );
    // 提示词字数上限是模型级真值：本地引擎实测未上报，只能在此按模型显式登记。
    // 8000 仅为影策视频模型的参考默认值（placeholder），不是本地模型实测上限；留空 = 不启用硬上限。
    const registeredPromptMaxChars = modelVideoCapabilities.promptMaxChars;
    const [promptMaxCharsDraft, setPromptMaxCharsDraft] = useState(registeredPromptMaxChars === undefined ? "" : String(registeredPromptMaxChars));
    const [promptMaxCharsError, setPromptMaxCharsError] = useState("");
    useEffect(() => {
        setPromptMaxCharsDraft(registeredPromptMaxChars === undefined ? "" : String(registeredPromptMaxChars));
        setPromptMaxCharsError("");
    }, [settings.videoModel, registeredPromptMaxChars]);

    const commitPromptMaxChars = (raw: string) => {
        const text = raw.trim();
        if (!text) {
            setPromptMaxCharsDraft("");
            setPromptMaxCharsError("");
            replaceConfig(setModelPromptMaxChars(useConfigStore.getState().config, settings.videoModel, undefined));
            return;
        }
        const value = Number(text);
        if (!Number.isSafeInteger(value) || value <= 0) {
            setPromptMaxCharsDraft(registeredPromptMaxChars === undefined ? "" : String(registeredPromptMaxChars));
            setPromptMaxCharsError("请输入正整数；留空表示不启用硬上限");
            return;
        }
        setPromptMaxCharsError("");
        setPromptMaxCharsDraft(String(value));
        replaceConfig(setModelPromptMaxChars(useConfigStore.getState().config, settings.videoModel, value));
    };

    const videoRatios = modelVideoCapabilities.videoRatios;
    const videoResolutions = modelVideoCapabilities.videoResolutions;
    const maxVideoSeconds = modelVideoCapabilities.maxVideoSeconds;
    // 单次时长上限（影策 maxVideoSeconds）也是模型级真值：本地 7 个渠道 29 个模型实测全部未上报，
    // 只能在这里按模型显式登记。留空 = 未知/不限制（不写 0、不写默认 15）。
    // 未显式选模型时按默认视频模型登记：段卡读到的正是 config.videoModel（studio-detail-panel 同口径）。
    const maxVideoSecondsModel = settings.videoModel.trim() || config.videoModel;
    const registeredMaxVideoSeconds = useMemo(
        () => modelVideoCapabilitiesOf(config, maxVideoSecondsModel).maxVideoSeconds,
        [config, maxVideoSecondsModel],
    );
    const [maxVideoSecondsDraft, setMaxVideoSecondsDraft] = useState(registeredMaxVideoSeconds === undefined ? "" : String(registeredMaxVideoSeconds));
    const [maxVideoSecondsError, setMaxVideoSecondsError] = useState("");
    const [maxVideoSecondsSaving, setMaxVideoSecondsSaving] = useState(false);
    useEffect(() => {
        setMaxVideoSecondsDraft(registeredMaxVideoSeconds === undefined ? "" : String(registeredMaxVideoSeconds));
        setMaxVideoSecondsError("");
    }, [maxVideoSecondsModel, registeredMaxVideoSeconds]);

    const commitMaxVideoSeconds = async (raw: string) => {
        const model = maxVideoSecondsModel;
        if (!model || maxVideoSecondsSaving) return;
        const text = raw.trim();
        let seconds: number | undefined;
        if (text) {
            const value = Number(text);
            if (!Number.isSafeInteger(value) || value < 1 || value > 600) {
                // 超界只提示、不写回；输入保留，允许就地改正后重新提交。
                setMaxVideoSecondsError("请输入 1–600 的整数；留空表示未知（不限制）");
                return;
            }
            seconds = value;
            setMaxVideoSecondsDraft(String(value));
        } else {
            setMaxVideoSecondsDraft("");
        }
        setMaxVideoSecondsError("");
        setMaxVideoSecondsSaving(true);
        const before = useConfigStore.getState().config;
        try {
            // 复用 ai.config 保存链：后端确认后才发布到 Store；失败在这里明示，不静默。
            await saveAiConfigConfirmed(setModelMaxVideoSeconds(before, model, seconds), before);
        } catch (error) {
            setMaxVideoSecondsError(`保存失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setMaxVideoSecondsSaving(false);
        }
    };

    const modelLabel = settings.videoModel.trim() ? modelOptionLabel(config, settings.videoModel) : "视频模型";
    // "模型默认" 档始终可选；登记了 videoResolutions（含 []）才按真值置灰不支持档位。
    const resolutionSupported = (tier: string) =>
        !videoResolutions || !tier || videoResolutions.some((registered) => resolutionTierMatches(registered, tier));

    const ratioProblem = !videoRatios || videoRatios.includes(settings.videoAspectRatio)
        ? ""
        : `不支持 ${settings.videoAspectRatio} 画幅（可选 ${videoRatios.join("、")}）`;
    const resolutionProblem = !videoResolutions || !settings.videoResolution
        ? ""
        : resolutionSupported(settings.videoResolution)
            ? ""
            : videoResolutions.length
                ? `不支持 ${settings.videoResolution} 分辨率（可选 ${videoResolutions.join("、")}）`
                : "不提供可选分辨率";
    const continuityProblem = settings.continuationMode === "tail" && modelVideoCapabilities.tailFrameChain === false
        ? "当前视频模型不支持图生视频，无法尾帧续接，请改用并行出片或换模型。"
        : "";
    // 影策 panels.tsx:1051 的行为预告：草稿与「已保存」的段落衔接不同才提示；每次渲染重新读已保存值，保存后自然消失。
    let savedContinuationMode: "tail" | "parallel" = "tail";
    if (dramaId && typeof localStorage !== "undefined") {
        try {
            const raw = localStorage.getItem(storageKey(dramaId));
            const parsed = raw ? JSON.parse(raw) as Partial<StudioProductionSettings> : null;
            if (parsed?.continuationMode === "parallel") savedContinuationMode = "parallel";
        } catch {
            savedContinuationMode = "tail";
        }
    }
    const continuityPreview = settings.continuationMode !== savedContinuationMode
        ? "已写好的段视频提示词按原方式撰写，切换后可在剧情段里重新撰写；已提交的视频会做完。"
        : "";
    // 分镜摘要（影策 storyboard-rules 底部一行）：镜头数/台词数按影策 ShotTarget/LineTarget 公式估算，
    // 段数与每段镜头数按目标段长估算；目标段长在智能档取视频模型单次上限（未登记上限时不显示段数）。
    const summaryAvgShot = PACING_AVERAGE_SECONDS[settings.pacing] || 2;
    const summaryShots = Math.max(4, Math.min(240, Math.round(settings.episodeSeconds / summaryAvgShot)));
    const summaryDialogueRule = DIALOGUE_RULES[settings.dialogueDensity];
    const summaryLines = Math.max(1, Math.round(settings.episodeSeconds / (summaryDialogueRule?.lineSeconds || 4.5)));
    /** 对白密度说明：影策 storyboard-rules 的一行数值口径 + 适用场景；自定义档本地无四参数，只写适用场景。 */
    const dialogueHintText = summaryDialogueRule
        ? `约每 ${summaryDialogueRule.lineSeconds} 秒一句，单句不超过 ${summaryDialogueRule.lineMaxRunes} 字，语速每秒 ${summaryDialogueRule.speechRate} 字，气口 ${summaryDialogueRule.linePauseMs / 1000} 秒，`
        : "";
    const summaryTarget = settings.segmentMode === "fixed"
        ? settings.segmentRange.max
        : settings.segmentMode === "range"
            ? Math.floor((settings.segmentRange.min + settings.segmentRange.max) / 2)
            : (maxVideoSeconds ?? 0);
    const summarySegmentLabel = settings.segmentMode === "fixed"
        ? `每段 ${settings.segmentRange.max} 秒`
        : settings.segmentMode === "range"
            ? `每段 ${settings.segmentRange.min}–${settings.segmentRange.max} 秒`
            : summaryTarget ? `智能切段 · 单段不超过 ${summaryTarget} 秒` : "智能切段";
    const summarySegments = summaryTarget ? Math.max(1, Math.ceil(settings.episodeSeconds / summaryTarget)) : 0;
    const summaryShotsPerSegment = summaryTarget ? Math.max(1, Math.round(summaryTarget / summaryAvgShot)) : 0;

    // 影策 dirty：草稿与已保存设置的差异。已保存值就是 saveStudioSettings 的落点
    // （localStorage drama-studio:settings:<dramaId>），用同一个 loadStudioSettings 读回，
    // 不编造新数据源。按渲染直接读取（不缓存）：保存/还原触发父组件重渲染后即时归零。
    let dirty = false;
    if (dramaId && typeof localStorage !== "undefined") {
        try {
            dirty = JSON.stringify(loadStudioSettings(dramaId)) !== JSON.stringify(settings);
        } catch {
            dirty = false;
        }
    }

    return (
        <div className="min-h-0 flex-1 overflow-y-auto" data-studio-settings>
            <div className="w-full space-y-4">
                <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-foreground/10 bg-background px-5 py-2.5">
                    <div className="flex items-baseline gap-3">
                        <h2 className="text-base font-semibold" style={{ fontWeight: 600 }}>制作设置</h2>
                        <span className="text-[11px] text-foreground/40">{dirty ? "有未保存的修改" : "修改只影响之后新开始的任务"}</span>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onReset}
                            disabled={!dramaId || saving || !dirty}
                            title="还原到最后保存的设置"
                            className="flex h-[34px] items-center gap-1.5 rounded-[8px] border border-foreground/15 bg-card px-3 text-[13px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                            style={{ fontSize: 13 }}
                        >
                            <RotateCcw className="size-3.5" /> 还原
                        </button>
                        <button
                            type="button"
                            onClick={onSave}
                            disabled={!dramaId || saving || !dirty}
                            className="flex h-[34px] items-center gap-1.5 rounded-[8px] bg-foreground px-3 text-[13px] font-medium text-background! transition hover:opacity-90 disabled:opacity-50"
                            style={{ fontSize: 13 }}
                        >
                            <Save className="size-3.5" /> {saving ? "保存中…" : "保存设置"}
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3 px-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
                <div className="min-w-0 space-y-3">
                    <Section icon={<FilmIcon />} title="分集方式" aside={planLocked ? "分集已完成，不能再调整；之后可在制作台逐集追加新的一集" : "只影响还没分集的章节，保存后下一轮调度生效"}>
                                        {planLocked ? (
                                            <p className="text-xs text-muted-foreground" data-episode-plan-locked>
                                                {episodeMode === "auto" ? "模型自动分集" : "按章分集"} · 共 {studioInfo?.chapterCount ?? 0} 章 {studioInfo?.episodeCount ?? 0} 集 · 分集方案与集号均已锁定
                                            </p>
                                        ) : null}
                                        <div className="grid gap-1.5">
                                            <label className="flex cursor-pointer items-start gap-2 text-xs">
                                                <input type="radio" name="studio-episode-mode" className="mt-0.5 size-3.5" checked={episodeMode === "chapter"} onChange={() => void changeEpisodeMode("chapter")} disabled={!dramaId || groupingBusy || planLocked} />
                                                <span className="min-w-0">
                                                    <span className="block font-medium">按章分集</span>
                                                    <span className="block text-[10px] text-muted-foreground">按章节顺序固定分集，{studioInfo && studioInfo.perEpisode > 1 ? `每 ${studioInfo.perEpisode} 章一集` : "每章一集"}</span>
                                                </span>
                                            </label>
                                            <label className="flex cursor-pointer items-start gap-2 text-xs">
                                                <input type="radio" name="studio-episode-mode" className="mt-0.5 size-3.5" checked={episodeMode === "auto"} onChange={() => void changeEpisodeMode("auto")} disabled={!dramaId || groupingBusy || planLocked} />
                                                <span className="min-w-0">
                                                    <span className="block font-medium">模型自动分集</span>
                                                    <span className="block text-[10px] text-muted-foreground">按剧情把章节规划成集，可合并或拆分章节</span>
                                                </span>
                                            </label>
                                        </div>
                                        {episodeMode === "chapter" ? (
                                            <p className="mt-2 text-xs leading-relaxed" data-studio-episode-summary>
                                                {!studioInfo ? "已分集" : planLocked
                                                    ? <>按章分集 · 共 {studioInfo.chapterCount} 章 {studioInfo.episodeCount} 集</>
                                                    : <>按章分集 · {studioInfo.perEpisode > 1 ? `每 ${studioInfo.perEpisode} 章一集` : "每章一集"} · 共 {studioInfo.chapterCount} 章 {studioInfo.episodeCount} 集{studioInfo.excludedCount ? ` · ${studioInfo.excludedCount} 章预留` : ""}</>}
                                            </p>
                                        ) : (
                                            <div className="mt-2 space-y-2">
                                                <p className="text-[10px] leading-relaxed text-muted-foreground">
                                                    文本模型按剧情把候选章拆/并成集：每集给出标题、章序号、梗概、钩子与卡点。点「自动规划全部分集」由服务端按游标分批规划连跑（每批 ≤12 章 / 30000 字）直到完成；也可逐批「预览」后确认建集。中断后再次触发会从当前游标续跑，全部章节完成后整份分集锁写。模型不可用时会直接报错，不会编造分组。
                                                </p>
                                                <button type="button" onClick={() => void runGroupingPreview()}
                                                    disabled={!dramaId || groupingBusy || planLocked || !studioInfo?.chapterCount}
                                                    className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs hover:bg-muted/40 disabled:opacity-50">
                                                    {groupingBusy ? "处理中…" : "预览模型分集"}
                                                </button>
                                                <button type="button" onClick={() => void runAutoGrouping()}
                                                    disabled={!dramaId || groupingBusy || planLocked || !studioInfo?.chapterCount}
                                                    className="ml-2 inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-background! hover:opacity-90 disabled:opacity-50">
                                                    {groupingBusy ? "处理中…" : "自动规划全部分集"}
                                                </button>
                                                {groupingError ? <p className="text-xs text-destructive">{groupingError}</p> : null}
                                                {groupingDone ? <p className="text-xs text-emerald-600">{groupingDone}</p> : null}
                                                {groupingPreview ? (
                                                    <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border p-2">
                                                        <p className="text-[11px] text-muted-foreground">
                                                            候选 {groupingPreview.groups.length} 集 · 模型 {groupingPreview.model}
                                                            {groupingPreview.batch ? ` · 第 ${groupingPreview.batch.cursor}–${groupingPreview.batch.nextCursor - 1} 章（共 ${groupingPreview.batch.lastChapterIndex} 章，游标 ${groupingPreview.batch.cursor}/${groupingPreview.batch.lastChapterIndex}）` : ""}
                                                            {groupingPreview.done ? " · 全部分集已完成" : ` · 确认后游标推进至第 ${groupingPreview.batch?.nextCursor ?? 0} 章`}
                                                        </p>
                                                        {groupingPreview.groups.map((group, index) => {
                                                            const nums = [...group.chapters].sort((left, right) => left - right);
                                                            const range = nums.length === 1 ? `第 ${nums[0]} 章` : nums.every((n, i) => i === 0 || n === nums[i - 1] + 1) ? `第 ${nums[0]}–${nums[nums.length - 1]} 章` : `第 ${nums.join("、")} 章`;
                                                            return (
                                                                <div key={`${group.chapters.join(",")}-${index}`} className="rounded border border-border p-2 text-xs">
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <span className="font-medium">第 {index + 1} 集 · {group.title}</span>
                                                                        <span className="text-[10px] text-muted-foreground">{range}</span>
                                                                    </div>
                                                                    <p className="mt-1 leading-relaxed">{group.synopsis}</p>
                                                                    {(group.hook || group.cliffhanger) ? (
                                                                        <p className="mt-1 text-[10px] text-muted-foreground">钩子：{group.hook || "—"} · 卡点：{group.cliffhanger || "—"}</p>
                                                                    ) : null}
                                                                </div>
                                                            );
                                                        })}
                                                        <div className="flex gap-2 pt-1">
                                                            <button type="button" onClick={() => void confirmGrouping()} disabled={groupingBusy}
                                                                className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-background! hover:opacity-90 disabled:opacity-50">
                                                                确认以上 {groupingPreview.groups.length} 集并建集
                                                            </button>
                                                            <button type="button" onClick={() => setGroupingPreview(null)} disabled={groupingBusy}
                                                                className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs hover:bg-muted/40 disabled:opacity-50">
                                                                放弃预览
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </div>
                                        )}
                                    </Section>

                    <Section marker="storyboard-rules" icon={<Rows3 className="size-4" />} title="分镜规则" aside="对之后改编的集生效；已改编的集可在剧本页“重新改编”">
                                        {/* 影策顺序：单集时长 → 剧情段 → 镜头节奏 → 对白密度 → 表演强度 → 运镜动感 → 转场 → 转场时长 → 摘要。 */}
                                        <Field label="单集时长">
                                            <input type="text" inputMode="text" value={episodeSecondsDraft} placeholder="如 90、5分钟、2:30"
                                                aria-label="单集时长" data-studio-episode-seconds
                                                onChange={(e) => { setEpisodeSecondsDraft(e.target.value); setEpisodeSecondsError(""); }}
                                                onBlur={(e) => commitEpisodeSeconds(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key !== "Enter") return;
                                                    commitEpisodeSeconds((e.target as HTMLInputElement).value);
                                                    (e.target as HTMLInputElement).blur();
                                                }}
                                                className="h-[34px] w-32 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] outline-none focus:border-primary" />
                                            <select aria-label="单集时长常用档位" data-studio-episode-presets
                                                value={(EPISODE_PRESETS as readonly number[]).includes(settings.episodeSeconds) ? settings.episodeSeconds : ""}
                                                onChange={(e) => { if (!e.target.value) return; setEpisodeSecondsError(""); patch("episodeSeconds", Number(e.target.value)); }}
                                                className="h-[34px] rounded-[12px] border border-foreground/10 bg-card px-2 text-[13px] text-foreground outline-none focus:border-primary">
                                                <option value="">常用档位</option>
                                                {EPISODE_PRESETS.map((seconds) => (
                                                    <option key={seconds} value={seconds}>{formatEpisodeSeconds(seconds)}（{seconds} 秒）</option>
                                                ))}
                                            </select>
                                        </Field>
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-foreground/40" data-studio-episode-hint>
                                            约 {Math.round((settings.episodeSeconds / 60) * 10) / 10} 分钟 · 可输入 {formatEpisodeSeconds(MIN_EPISODE_SECONDS)}–{formatEpisodeSeconds(MAX_EPISODE_SECONDS)}，如“90 / 5分钟 / 2:30”
                                        </p>
                                        {episodeSecondsError ? <p className="pl-[120px] text-[11px] text-destructive" role="alert" data-studio-episode-seconds-error>{episodeSecondsError}</p> : null}
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-amber-600/90" data-studio-soft-hint="episode-seconds">
                                            软约束，影响拆镜提示词：写入 storyboardRules.episodeSeconds 作为拆镜/提示词的时长目标，不强制成片剪辑时长。
                                        </p>
                                        <Field label="剧情段">
                                            <ChoiceButtons marker="segment-mode" value={settings.segmentMode}
                                                options={[
                                                    { value: "auto", label: "智能" }, { value: "fixed", label: "固定" }, { value: "range", label: "范围" },
                                                ]}
                                                onChange={(v) => patch("segmentMode", v)} />
                                        </Field>
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-foreground/40" data-studio-segment-mode-detail>
                                            {settings.segmentMode === "auto"
                                                ? maxVideoSeconds !== undefined
                                                    ? `按场景与冲突切段，单段不超过 ${maxVideoSeconds} 秒（${modelLabel}上限）`
                                                    : "按场景与冲突切段，单段不超过视频模型单次上限"
                                                : SEGMENT_MODE_DETAIL[settings.segmentMode]}
                                        </p>
                                        {settings.segmentMode !== "auto" ? (
                                            <Field label="剧情段时长">
                                                {settings.segmentMode === "fixed" ? (
                                                    <>
                                                        <input type="number" min={MIN_SEGMENT_SECONDS} max={MAX_SEGMENT_SECONDS} value={settings.segmentRange.max}
                                                            aria-label="每段时长" data-studio-segment-seconds="fixed"
                                                            onChange={(e) => { const v = Math.max(MIN_SEGMENT_SECONDS, Math.min(MAX_SEGMENT_SECONDS, Number(e.target.value) || MIN_SEGMENT_SECONDS)); patch("segmentRange", { min: v, max: v }); }}
                                                            className="h-7 w-24 rounded-[12px] border border-foreground/10 bg-card px-2 text-[13px] outline-none focus:border-primary" />
                                                        <span className="text-[11px] text-foreground/40">秒</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <input type="number" min={MIN_SEGMENT_SECONDS} max={settings.segmentRange.max} value={settings.segmentRange.min}
                                                            aria-label="每段最短" data-studio-segment-seconds="min"
                                                            onChange={(e) => patch("segmentRange", clampRange({ ...settings.segmentRange, min: Number(e.target.value) || MIN_SEGMENT_SECONDS }))}
                                                            className="h-7 w-24 rounded-[12px] border border-foreground/10 bg-card px-2 text-[13px] outline-none focus:border-primary" />
                                                        <span className="text-[11px] text-foreground/40">秒</span>
                                                        <span className="text-[11px] text-foreground/40">至</span>
                                                        <input type="number" min={settings.segmentRange.min} max={MAX_SEGMENT_SECONDS} value={settings.segmentRange.max}
                                                            aria-label="每段最长" data-studio-segment-seconds="max"
                                                            onChange={(e) => patch("segmentRange", clampRange({ ...settings.segmentRange, max: Number(e.target.value) || MIN_SEGMENT_SECONDS }))}
                                                            className="h-7 w-24 rounded-[12px] border border-foreground/10 bg-card px-2 text-[13px] outline-none focus:border-primary" />
                                                        <span className="text-[11px] text-foreground/40">秒</span>
                                                    </>
                                                )}
                                            </Field>
                                        ) : null}
                                        <Field label="镜头节奏">
                                            <TickSlider marker="pacing" value={(["极快", "快", "标准", "舒缓", "慢"] as const).indexOf(settings.pacing as "标准")}
                                                labels={["极快", "快", "标准", "舒缓", "慢"]} tickValues={[0, 1, 2, 3, 4]} min={0} max={4}
                                                bubble={settings.pacing}
                                                onValue={(i) => patch("pacing", (["极快", "快", "标准", "舒缓", "慢"] as const)[i])} />
                                        </Field>
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-foreground/40" data-studio-pacing-detail>
                                            {settings.pacing}：{PACING_DETAIL[settings.pacing] || ""}
                                        </p>
                                        <Field label="对白密度">
                                            <ChoiceButtons marker="dialogue-density" value={settings.dialogueDensity}
                                                options={[
                                                    { value: "dense", label: "密集" }, { value: "standard", label: "标准" },
                                                    { value: "restrained", label: "克制" }, { value: "custom", label: "自定义" },
                                                ]}
                                                onChange={(v) => patch("dialogueDensity", v)} />
                                        </Field>
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-foreground/40" data-studio-dialogue-detail>
                                            {{ dense: "密集", standard: "标准", restrained: "克制", custom: "自定义" }[settings.dialogueDensity] || settings.dialogueDensity}：{dialogueHintText}{DIALOGUE_DETAIL[settings.dialogueDensity] || ""}
                                        </p>
                                        <Field label="表演强度">
                                            <TickSlider marker="performance" value={settings.performanceIntensity}
                                                labels={PERFORMANCE_BANDS_LABEL} tickValues={[1, 3, 5, 7, 10]} min={1} max={10}
                                                readout={`${settings.performanceIntensity}/10`}
                                                bubble={`${settings.performanceIntensity} · ${PERFORMANCE_BANDS_LABEL[levelBandIndex(settings.performanceIntensity)]}`}
                                                onValue={(v) => patch("performanceIntensity", v)} />
                                        </Field>
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-foreground/40" data-studio-performance-detail>
                                            {PERFORMANCE_BANDS_LABEL[levelBandIndex(settings.performanceIntensity)]}：{PERFORMANCE_BANDS_DETAIL[levelBandIndex(settings.performanceIntensity)]}
                                        </p>
                                        <Field label="运镜动感">
                                            <TickSlider marker="camera" value={settings.cameraDynamics}
                                                labels={CAMERA_BANDS_LABEL} tickValues={[1, 3, 5, 7, 10]} min={1} max={10}
                                                readout={`${settings.cameraDynamics}/10`}
                                                bubble={`${settings.cameraDynamics} · ${CAMERA_BANDS_LABEL[levelBandIndex(settings.cameraDynamics)]}`}
                                                onValue={(v) => patch("cameraDynamics", v)} />
                                        </Field>
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-foreground/40" data-studio-camera-detail>
                                            {CAMERA_BANDS_LABEL[levelBandIndex(settings.cameraDynamics)]}：{CAMERA_BANDS_DETAIL[levelBandIndex(settings.cameraDynamics)]}
                                        </p>
                                        <Field label="转场">
                                            <ChoiceButtons marker="transition-mode" value={settings.transitionMode}
                                                options={[
                                                    { value: "smart", label: "智能" }, { value: "hard", label: "硬切" },
                                                    { value: "fade", label: "黑场过渡" }, { value: "flash", label: "闪白" },
                                                ]}
                                                onChange={(v) => patch("transitionMode", v)} />
                                        </Field>
                                        <p className="pl-[120px] text-[11px] leading-relaxed text-foreground/40" data-studio-transition-detail>
                                            {{ smart: "智能", hard: "硬切", fade: "黑场过渡", flash: "闪白" }[settings.transitionMode] || settings.transitionMode}：{TRANSITION_DETAIL[settings.transitionMode] || ""}
                                        </p>
                                        {/* 影策：硬切不需要时长，只在其它转场下给 150–1500 毫秒（step 50）。 */}
                                        {settings.transitionMode !== "hard" ? (
                                            <>
                                                <Field label="转场时长">
                                                    <div className="relative flex min-w-0 flex-1 items-center"
                                                        onPointerDown={() => setTransitionBubbleVisible(true)}
                                                        onPointerUp={() => setTransitionBubbleVisible(false)}
                                                        onPointerCancel={() => setTransitionBubbleVisible(false)}
                                                        onPointerLeave={() => setTransitionBubbleVisible(false)}
                                                        onFocus={() => setTransitionBubbleVisible(true)}
                                                        onBlur={() => setTransitionBubbleVisible(false)}>
                                                        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/5" />
                                                        <div className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/80"
                                                            style={{ width: `${((settings.transitionMs - MIN_TRANSITION_MS) / (MAX_TRANSITION_MS - MIN_TRANSITION_MS)) * 100}%` }} />
                                                        <input type="range" min={MIN_TRANSITION_MS} max={MAX_TRANSITION_MS} step={50} value={settings.transitionMs}
                                                            aria-valuetext={`${settings.transitionMs} 毫秒`}
                                                            onChange={(e) => {
                                                                patch("transitionMs", Math.max(MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, Number(e.target.value))));
                                                                setTransitionBubbleVisible(true);
                                                            }} className="relative z-[1] min-w-0 flex-1 appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-foreground [&::-webkit-slider-thumb]:bg-card" data-studio-transition-ms />
                                                        <SliderValueBubble pct={((settings.transitionMs - MIN_TRANSITION_MS) / (MAX_TRANSITION_MS - MIN_TRANSITION_MS)) * 100}
                                                            text={`${settings.transitionMs} 毫秒`} visible={transitionBubbleVisible} thumbPx={16} />
                                                    </div>
                                                    <span className="w-16 shrink-0 text-right text-[11px] font-semibold tabular-nums text-foreground">{settings.transitionMs} 毫秒</span>
                                                </Field>
                                                <p className="pl-[120px] text-[11px] leading-relaxed text-amber-600/90" data-studio-soft-hint="transition-ms">
                                                    软约束，影响拆镜提示词：写入 storyboardRules.transitionMs 作为转场描述要求，不改变成片的实际剪辑时长。
                                                </p>
                                            </>
                                        ) : null}
                                        <div className="flex items-start gap-2 border-t border-foreground/10 px-0 pt-2 text-[11px] leading-relaxed text-foreground/55" data-studio-storyboard-summary>
                                            <Film className="mt-0.5 size-3.5 shrink-0" />
                                            <span>
                                                每集约 <b className="tabular-nums text-foreground">{summaryShots}</b> 个镜头、至少 <b className="tabular-nums text-foreground">{summaryLines}</b> 句台词
                                                {summaryTarget ? <> · {summarySegmentLabel}，约 <b className="tabular-nums text-foreground">{summarySegments}</b> 段 · 每段约 <b className="tabular-nums text-foreground">{summaryShotsPerSegment}</b> 镜</> : null}
                                            </span>
                                        </div>
                                        {maxVideoSeconds !== undefined && (settings.segmentRange.min > maxVideoSeconds || settings.segmentRange.max > maxVideoSeconds) ? (
                                            <p className="text-xs text-destructive" role="alert" data-studio-video-warning="max-seconds">
                                                {modelLabel}单次最长 {maxVideoSeconds} 秒，剧情段上限按 {maxVideoSeconds} 秒执行。
                                            </p>
                                        ) : null}
                                    </Section>

                    <Section marker="text-steps" icon={<Wand2 className="size-4" />} title="文字步骤" desc="每步可选文本模型 + 思考等级 + 技能。文字模型优先列出本地 Hermes 引擎，其余模型保留作回退。技能留空则默认用 Acheng 导演对应模块（分集规划→story、资产提取→assets、分镜拆分→shots、视频提示词→model，后两步叠加 continuity 连续性约束）；选中技能后其方法要点会注入改编请求。">
                                        {([
                                            { key: "plan", label: "分集规划", hint: "小说自动分集时把章节组织为连续剧集", modelKey: "planModel" as const, thinkKey: "plan" as const, skillKey: "plan" as const },
                                            { key: "extract", label: "资产提取", hint: "从原文提取角色、道具、场景与全剧画面规则", modelKey: "assetExtractModel" as const, thinkKey: "extract" as const, skillKey: "extract" as const },
                                            { key: "storyboard", label: "分镜拆分", hint: "每集改编为镜头表，输出最长、最慢的一步", modelKey: "storyboardModel" as const, thinkKey: "storyboard" as const, skillKey: "storyboard" as const },
                                            { key: "prompt", label: "视频提示词", hint: "按镜头表把每个剧情段写成完整视频提示词", modelKey: "videoPromptModel" as const, thinkKey: "prompt" as const, skillKey: "prompt" as const },
                                        ]).map((row) => (
                                            <div key={row.key} className="rounded-[8px] border border-foreground/10 p-2.5">
                                                <p className="mb-1 text-[11px] leading-relaxed text-foreground/40" data-studio-step-hint={row.key}>{row.hint}</p>
                                                <Field label={row.label}>
                                                    <span className="shrink-0 text-[11px] text-foreground/40">文本模型</span>
                                                    <ModelSelect capability="text" config={config} value={settings[row.modelKey]}
                                                        onChange={(v) => patch(row.modelKey, v)} />
                                                    <span className="shrink-0 text-[11px] text-foreground/40">思考等级</span>
                                                    <select value={settings.textThinking[row.thinkKey]}
                                                        onChange={(e) => patch("textThinking", { ...settings.textThinking, [row.thinkKey]: e.target.value as ReasoningEffort })}
                                                        className="h-[34px] w-20 shrink-0 rounded-[12px] border border-foreground/10 bg-card px-2 text-[13px] outline-none focus:border-primary"
                                                        aria-label={`${row.label}思考等级`} data-studio-thinking={row.thinkKey}>
                                                        {THINKING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                                    </select>
                                                </Field>
                                                { row.skillKey ? (
                                                    <div className="mt-2 flex items-start gap-3 pl-1">
                                                        <span className="w-14 shrink-0 pt-0.5 text-[11px] font-semibold text-foreground/55" title={`留空默认：acheng/${ { plan: "story", extract: "assets", storyboard: "shots", prompt: "model" }[row.skillKey] }`}>技能</span>
                                                        <SkillPickerField step={row.skillKey}
                                                            value={settings.textSkills[row.skillKey]}
                                                            onChange={(ref) => patch("textSkills", { ...settings.textSkills, [row.skillKey]: ref })} />
                                                    </div>
                                                ) : null}
                                            </div>
                                        ))}
                                    </Section>

                    <Section marker="reference" icon={<Sparkles className="size-4" />} title="参考图" desc="角色、道具、场景可分别选图片模型；分辨率档位按 1:1 换算成像素（1k=1024² / 2k=2048² / 4k=2880²），流水线生成参考图时真实下发。设定详情仍可上传或绑定素材库图片。">
                                        <Field label="角色" hint="画幅按参考图方案"><ModelSelect capability="image" config={config} value={settings.characterImageModel} onChange={(v) => patch("characterImageModel", v)} /></Field>
                                        <Field label="道具" hint="16:9 单件展示"><ModelSelect capability="image" config={config} value={settings.propImageModel} onChange={(v) => patch("propImageModel", v)} /></Field>
                                        <Field label="场景" hint="16:9 空间全景"><ModelSelect capability="image" config={config} value={settings.sceneImageModel} onChange={(v) => patch("sceneImageModel", v)} /></Field>
                                        <Field label="分辨率">
                                            <div className="flex gap-1.5">
                                                {(["1k", "2k", "4k"] as const).map((r) => (
                                                    <button key={r} type="button" onClick={() => patch("imageResolution", r)}
                                                        className={cn("rounded-md border px-3 py-1 text-xs transition", settings.imageResolution === r ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>
                                                        {r.toUpperCase()}
                                                    </button>
                                                ))}
                                            </div>
                                        </Field>
                                        {/* 影策「资产方案」：方案卡片（名称 + 画幅徽标 + 说明 + 选中勾），点卡片即写回；不再用下拉。 */}
                                        <Field label="参考图方案">
                                            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="参考图方案" data-studio-reference-layout>
                                                {([
                                                    { value: "auto" as const, name: "自定义 / 自动", aspect: "自选", description: "按资产类型自动匹配：角色=定妆照、场景=场景空镜、道具=道具设定图；也可在单条资产里自选方案覆盖。" },
                                                    ...ASSET_SCHEME_OPTIONS.map((o) => ({ value: o.value, name: o.name, aspect: "16:9", description: o.description })),
                                                ]).map((opt) => {
                                                    const active = settings.referenceLayout === opt.value;
                                                    return (
                                                        <button key={opt.value} type="button" role="radio" aria-checked={active}
                                                            disabled={layoutApplying}
                                                            onClick={() => { patch("referenceLayout", opt.value); setLayoutNote(""); }}
                                                            data-studio-reference-layout-option={opt.value}
                                                            className={cn("flex items-start gap-2.5 rounded-[8px] border p-3 text-left transition disabled:opacity-50",
                                                                active ? "border-foreground/40 bg-muted/60" : "border-border hover:border-foreground/25 hover:bg-muted/40")}>
                                                            <span className="grid size-9 shrink-0 place-items-center rounded-[6px] border border-border bg-background text-muted-foreground">
                                                                <ImageIcon className="size-4" />
                                                            </span>
                                                            <span className="min-w-0 flex-1">
                                                                <span className="flex items-center gap-1.5">
                                                                    <span className="truncate text-[11px] font-semibold text-foreground">{opt.name}</span>
                                                                    <span className="shrink-0 rounded-[4px] border border-border px-1 text-[9px] text-muted-foreground">{opt.aspect}</span>
                                                                </span>
                                                                <span className="mt-1 block text-[11px] leading-[1.5] text-muted-foreground">{opt.description}</span>
                                                            </span>
                                                            {active ? <Check className="mt-0.5 size-3.5 shrink-0 text-foreground" /> : null}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </Field>
                                        <div className="flex flex-wrap items-center gap-2 pl-1">
                                            <button type="button" onClick={() => void applyReferenceLayout()}
                                                disabled={!dramaId || layoutApplying}
                                                data-studio-reference-layout-apply
                                                className="h-7 rounded-md border border-primary/40 bg-primary/10 px-2.5 text-[11px] text-primary transition hover:bg-primary/20 disabled:opacity-50">
                                                {layoutApplying ? "写入中…" : "应用到本剧全部设定"}
                                            </button>
                                            <span className="text-[10px] text-muted-foreground">真写回：选中写入本剧设置随「保存设置」落盘；应用后按资产类型写进每集资产卡 view_layout，与「项目资产 → 参考图方案」同一字段，可单条覆盖。</span>
                                        </div>
                                        {layoutNote ? <p className="pl-1 text-[10px] text-emerald-600" data-studio-reference-layout-note>{layoutNote}</p> : null}
                                        <div className="rounded-md border border-border bg-background/40 p-2.5" data-studio-ref-preview>
                                            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">实际发送预览（只读 · 来自本地技能模板）</div>
                                            <ul className="space-y-0.5 text-[11px] leading-relaxed">
                                                <li>角色 · {ASSET_KIND_SKILL.character.imageKind}｜{ASSET_KIND_SKILL.character.section}</li>
                                                <li>场景 · {ASSET_KIND_SKILL.scene.imageKind}｜{ASSET_KIND_SKILL.scene.section}</li>
                                                <li>道具 · {ASSET_KIND_SKILL.prop.imageKind}｜{ASSET_KIND_SKILL.prop.section}</li>
                                            </ul>
                                            <p className="mt-1.5 text-[10px] text-muted-foreground">真实提示词由资产设定卡按技能模板拼装；到「项目资产 · 设定详情」可查看并精修发送内容。</p>
                                        </div>
                                    </Section>

                    <Section marker="redo-guide" icon={<ImageIcon className="size-4" />} title="重做参考图" desc="一键按资产卡设定 + 当前方案真出图并写回；不想覆盖旧图时，仍可用下方按钮到资产库手动重做。">
                                        {/* 影策「资产方案 → 提示词」：角色/场景/默认三档模板，留空沿用内置方案模板。 */}
                                        <div className="rounded-[8px] border border-border bg-background/40 p-3" data-studio-prompt-templates>
                                            <div className="mb-2 flex flex-wrap items-center gap-1.5">
                                                {([["character", "角色提示词"], ["scene", "场景提示词"], ["default", "默认"]] as const).map(([key, label]) => (
                                                    <button key={key} type="button" onClick={() => setTemplateKind(key)}
                                                        aria-pressed={templateKind === key}
                                                        data-studio-prompt-template-tab={key}
                                                        className={cn("h-7 rounded-md px-2.5 text-[11px] transition", templateKind === key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}>
                                                        {label}{String(assetTemplates[key] || "").trim() ? " ·" : ""}
                                                    </button>
                                                ))}
                                                <span className="flex-1" />
                                                <button type="button" disabled={!templateValue.trim()}
                                                    onClick={() => patch("assetPromptTemplates", { ...assetTemplates, [templateKind]: "" })}
                                                    className="h-7 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-40"
                                                    data-studio-prompt-template-reset>恢复默认</button>
                                            </div>
                                            <textarea ref={templateInputRef} rows={10} value={templateValue} spellCheck={false}
                                                data-studio-prompt-template-input={templateKind}
                                                aria-label={`${templateKind === "character" ? "角色" : templateKind === "scene" ? "场景" : "默认"}参考图提示词模板`}
                                                placeholder={"留空则用内置方案模板。可用变量：{{资产名称}} {{资产设定}} {{方案要求}} {{画面规则}} {{项目画风}} {{方案名称}}"}
                                                onChange={(e) => patch("assetPromptTemplates", { ...assetTemplates, [templateKind]: e.target.value })}
                                                className="w-full resize-y rounded-[12px] border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground/30"
                                                style={{ fontSize: 13, lineHeight: 1.6 }} />
                                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                                <span className="text-[10px] text-muted-foreground">插入变量</span>
                                                {ASSET_PROMPT_VARIABLES.map((name) => (
                                                    <button key={name} type="button"
                                                        onClick={() => {
                                                            const token = `{{${name}}}`;
                                                            const el = templateInputRef.current;
                                                            const start = el?.selectionStart ?? templateValue.length;
                                                            const end = el?.selectionEnd ?? templateValue.length;
                                                            const next = `${templateValue.slice(0, start)}${token}${templateValue.slice(end)}`;
                                                            patch("assetPromptTemplates", { ...assetTemplates, [templateKind]: next });
                                                            requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
                                                        }}
                                                        data-studio-prompt-template-insert={name}
                                                        className="h-6 rounded border border-border px-1.5 text-[10px] text-muted-foreground transition hover:bg-muted hover:text-foreground">{`{{${name}}}`}</button>
                                                ))}
                                            </div>
                                            <p className="mt-2 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-muted-foreground" data-studio-prompt-template-preview>
                                                {templateValue.trim()
                                                    ? `实际发送预览：${templatePreview.slice(0, 160)}${templatePreview.length > 160 ? "…" : ""}`
                                                    : "当前使用内置方案模板；填模板后立即在「生成参考图 / 一键按当前方案重做」时生效，已生成的图片不会自动重做。"}
                                            </p>
                                        </div>
                                        <div className="rounded-md border border-border bg-background/40 p-2.5" data-studio-regen-one-click>
                                            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">一键按当前方案重做（真出图 · 真写回）</div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <input type="text" value={regenAssetId}
                                                    onChange={(e) => setRegenAssetId(e.target.value)}
                                                    placeholder="资产 ID，如 asset-character-xxxxxx"
                                                    className="h-8 min-w-56 flex-1 rounded-md border border-border bg-background px-2 text-xs"
                                                    aria-label="要重做的资产 ID" />
                                                <button type="button" disabled={!dramaId || !regenAssetId.trim() || regenBusy}
                                                    onClick={runOneClickRegen}
                                                    className="h-8 rounded-md border border-primary px-3 text-xs text-foreground transition hover:bg-primary/10 disabled:opacity-50">
                                                    {regenBusy ? "正在出图…" : "一键按当前方案重做"}
                                                </button>
                                            </div>
                                            <p className="mt-1.5 text-[10px] text-muted-foreground">资产 ID 可在「项目资产 · 设定详情」复制；默认用 2.1 图片模型、横版 16:9，成功后自动标脏引用该设定的剧情段。</p>
                                            {regenResult ? <p className="mt-1.5 text-[11px] text-emerald-600" data-studio-regen-result>{regenResult}</p> : null}
                                            {regenError ? <p className="mt-1.5 text-[11px] text-destructive" role="alert" data-studio-regen-error>{regenError}</p> : null}
                                        </div>
                                        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                                            手动入口：点下方按钮会跳到项目资产库并预选对应设定；到设定详情点「生成参考图」，在画布生成后采用写回。手动路径不会自动重做，也不会覆盖未确认的旧图。
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-2" data-studio-redo-refs>
                                            {(["角色", "道具", "场景"] as const).map((kind) => (
                                                <button key={kind} type="button" disabled={!dramaId || !onRedoRefs}
                                                    onClick={() => onRedoRefs?.(kind)}
                                                    className="h-8 rounded-md border border-border px-3 text-xs text-foreground transition hover:bg-muted disabled:opacity-50">
                                                    前往画布手动重做{kind}参考图
                                                </button>
                                            ))}
                                        </div>
                                        <p className="mt-1.5 text-[10px] text-muted-foreground">手动路径只做定位跳转；真正的重做与采用在画布完成，旧版本保留在设定详情的版本记录中。</p>
                                    </Section>

                    <Section icon={<FilmIcon />} title="视频" desc="剧情段视频模型（段级 selectedVideoModel）与剧目级分辨率。档位按短边像素，与画幅联动，启动视频段时真实写进每段 H3 出片参数（aspectRatio + megapixels）；「模型默认」不覆盖，由所选模型自定。">
                                        <Field label="剧情段视频" hint="每段一个带对白与音效的视频">
                                            <ModelSelect capability="video" config={config} value={settings.videoModel} onChange={(v) => patch("videoModel", v)} />
                                        </Field>
                                        <Field label="提示词字数上限" hint="码点">
                                            <input type="number" min={1} step={1} value={promptMaxCharsDraft}
                                                onChange={(e) => setPromptMaxCharsDraft(e.target.value)}
                                                onBlur={(e) => commitPromptMaxChars(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === "Enter") commitPromptMaxChars((e.target as HTMLInputElement).value); }}
                                                disabled={!settings.videoModel}
                                                placeholder="8000（影策参考默认）"
                                                aria-label="提示词字数上限"
                                                data-studio-prompt-max-chars
                                                className="h-[34px] w-44 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] outline-none focus:border-primary disabled:opacity-50" />
                                            {registeredPromptMaxChars === undefined ? null : (
                                                <span className="text-[10px] text-emerald-600">已登记 {registeredPromptMaxChars} 字</span>
                                            )}
                                        </Field>
                                        <p className="pl-1 text-[10px] leading-relaxed text-muted-foreground" data-studio-prompt-max-chars-hint>
                                            本地引擎实测未上报字数上限：留空 = 不启用硬上限（段提示词沿用软提醒）。填写后按码点硬校验、超限拒绝；8000 是影策视频模型参考默认值，不是本地模型实测值，请按模型实际能力登记。
                                        </p>
                                        {promptMaxCharsError ? <p className="text-xs text-destructive" role="alert" data-studio-prompt-max-chars-error>{promptMaxCharsError}</p> : null}
                                        <Field label="单次时长上限（秒）" hint="1–600">
                                            <input type="number" min={1} max={600} step={1} value={maxVideoSecondsDraft}
                                                onChange={(e) => setMaxVideoSecondsDraft(e.target.value)}
                                                onBlur={(e) => void commitMaxVideoSeconds(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === "Enter") void commitMaxVideoSeconds((e.target as HTMLInputElement).value); }}
                                                disabled={!maxVideoSecondsModel || maxVideoSecondsSaving}
                                                placeholder="留空 = 未知（不限制）"
                                                aria-label="单次时长上限（秒）"
                                                data-studio-model-max-video-seconds
                                                className="h-[34px] w-44 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] outline-none focus:border-primary disabled:opacity-50" />
                                            {settings.videoModel.trim() || !maxVideoSecondsModel ? null : (
                                                <span className="text-[10px] text-muted-foreground" data-studio-model-max-video-seconds-target>
                                                    未选模型，登记到默认视频模型「{modelOptionLabel(config, maxVideoSecondsModel)}」
                                                </span>
                                            )}
                                            {maxVideoSecondsSaving ? (
                                                <span className="text-[10px] text-muted-foreground" data-studio-model-max-video-seconds-saving>保存中…</span>
                                            ) : registeredMaxVideoSeconds === undefined ? null : (
                                                <span className="text-[10px] text-emerald-600" data-studio-model-max-video-seconds-registered>已登记 {registeredMaxVideoSeconds} 秒</span>
                                            )}
                                        </Field>
                                        <p className="pl-1 text-[10px] leading-relaxed text-muted-foreground" data-studio-model-max-video-seconds-hint>
                                            本地引擎实测未上报单次时长上限：留空 = 未知/不限制（不写 0、不写默认 15）。填写后只写入当前视频模型的 maxVideoSeconds（1–600 的正整数），影策段卡的「N 镜 · 上限 Xs」直接读这个值。
                                        </p>
                                        {maxVideoSecondsError ? <p className="text-xs text-destructive" role="alert" data-studio-model-max-video-seconds-error>{maxVideoSecondsError}</p> : null}
                                        <Field label="视频分辨率" hint={modelDeclaredResolution ? `模型声明默认：${modelDeclaredResolution}` : "对之后提交的剧情段视频生效"}>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                {VIDEO_RESOLUTION_OPTIONS.map((option) => {
                                                    const unsupported = !resolutionSupported(option.value);
                                                    return (
                                                        <button key={option.value || "default"} type="button"
                                                            onClick={() => patch("videoResolution", option.value)}
                                                            disabled={unsupported}
                                                            data-studio-video-resolution={option.value}
                                                            title={unsupported ? "当前模型不支持这个档位" : undefined}
                                                            className={cn("rounded-md border px-3 py-1 text-xs transition",
                                                                unsupported ? "cursor-not-allowed border-border text-muted-foreground/40"
                                                                    : settings.videoResolution === option.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>
                                                            {option.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </Field>
                                        <Field label="画幅" hint="横屏/竖屏与分辨率联动，9:16 竖屏真实出片为「短边×长边」">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                {VIDEO_ASPECT_OPTIONS.map((option) => (
                                                    <button key={option.value} type="button"
                                                        onClick={() => patch("videoAspectRatio", option.value)}
                                                        data-studio-video-aspect={option.value}
                                                        className={cn("rounded-md border px-3 py-1 text-xs transition",
                                                            settings.videoAspectRatio === option.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>
                                                        {option.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </Field>
                                        <Field label="实际出片尺寸" hint="与后端共用换算（estimateH3Dimensions），显示值即真实出片参数">
                                            <span className="text-xs text-muted-foreground" data-studio-video-size>
                                                {resolutionEffective
                                                    ? `${resolutionEffective.size} · megapixels=${resolutionEffective.megapixels} · ${resolutionEffective.aspectRatio}`
                                                    : "跟随视频模型默认（本地 H3 原生由 Clip 保存值决定）"}
                                            </span>
                                        </Field>
                                        {ratioProblem ? (
                                            <p className="text-xs text-destructive" role="alert" data-studio-video-warning="ratio">
                                                当前视频模型{ratioProblem}，剧情段视频无法提交，请换模型。
                                            </p>
                                        ) : null}
                                        {resolutionProblem ? (
                                            <p className="text-xs text-amber-600" role="alert" data-studio-video-warning="resolution">
                                                当前视频模型{resolutionProblem}，实际按模型默认{modelDeclaredResolution ? ` ${modelDeclaredResolution}` : ""}出片。
                                            </p>
                                        ) : null}
                                        {modelVideoCapabilities.generateAudio === false ? (
                                            <p className="text-xs text-amber-600" role="alert" data-studio-video-warning="audio">
                                                当前视频模型不同步生成声音，剧情段视频没有对白与音效。
                                            </p>
                                        ) : null}
                                    </Section>


                    <Section marker="visual-style" icon={<Sparkles className="size-4" />} title="视觉风格（表现形式 × 题材）" desc="照搬影策风格库：4 种表现形式 × 13 种题材派生统一画风。选满两轴即生成画风 prompt 并写回剧目 topic.artStyle（后端统一画风后缀会注入所有出图提示词）；也可在下方自由填写字符串，两种方式共用同一字段。">
                                        <div className="grid gap-3 sm:grid-cols-2">
                                            <Field label="表现形式">
                                                <select value={styleForm} disabled={!dramaId || styleSaving}
                                                    onChange={(e) => chooseStyleAxes(e.target.value as DramaStyleFormId | "", styleTheme)}
                                                    aria-label="表现形式" data-studio-style-form
                                                    className="h-[34px] min-w-0 flex-1 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-50">
                                                    <option value="">未选择（自由画风）</option>
                                                    {DRAMA_STYLE_FORMS.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}
                                                </select>
                                            </Field>
                                            <Field label="题材">
                                                <select value={styleTheme} disabled={!dramaId || styleSaving}
                                                    onChange={(e) => chooseStyleAxes(styleForm, e.target.value as DramaStyleThemeId | "")}
                                                    aria-label="题材" data-studio-style-theme
                                                    className="h-[34px] min-w-0 flex-1 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-50">
                                                    <option value="">未选择（自由画风）</option>
                                                    {DRAMA_STYLE_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                                                </select>
                                            </Field>
                                        </div>
                                        <p className={`text-[11px] ${styleForm && styleTheme ? "text-emerald-600" : "text-muted-foreground"}`} data-studio-style-composition>
                                            {styleForm && styleTheme
                                                ? `当前组合：${chosenFormName} · ${chosenThemeName} · 已生成画风 prompt 写回 topic.artStyle`
                                                : "选满两轴后自动生成画风 prompt；留空表示沿用下方自由输入的画风字符串。"}
                                        </p>
                                        <div className="flex items-start gap-2">
                                            <span className="w-28 shrink-0 pt-1.5 text-xs text-muted-foreground">画风字符串</span>
                                            <textarea value={artStyleDraft} disabled={!dramaId || styleSaving}
                                                onChange={(e) => setArtStyleDraft(e.target.value)}
                                                onBlur={commitFreeArtStyle}
                                                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitFreeArtStyle(); } }}
                                                rows={3}
                                                placeholder="可自由填写画风；两轴选择会自动生成并覆盖此处"
                                                aria-label="画风字符串" data-studio-art-style
                                                className="min-w-0 flex-1 rounded-[12px] border border-foreground/10 bg-card px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none focus:border-primary disabled:opacity-50" />
                                            <button type="button" onClick={commitFreeArtStyle} disabled={!dramaId || styleSaving}
                                                className="h-8 shrink-0 rounded-md border border-border px-3 text-xs text-foreground transition hover:bg-muted disabled:opacity-50">
                                                {styleSaving ? "保存中…" : "保存画风"}
                                            </button>
                                        </div>
                                        {styleError ? <p className="text-xs text-destructive" role="alert" data-studio-style-error>{styleError}</p> : null}
                                    </Section>

                    <Section icon={<Sparkles className="size-4" />} title="钩子与悬念" desc="影策每集的 hook（开篇钩子）与 cliffhanger（结尾悬念）结构化字段。保存后「重新改编本集」会作为创作方向注入改编指令，真实影响剧本。">
                                        <Field label="开篇钩子"><input value={settings.hook} onChange={(e) => patch("hook", e.target.value)} placeholder="前3秒如何抓住观众"
                                            className="h-[34px] min-w-0 flex-1 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] outline-none focus:border-primary" /></Field>
                                        <Field label="结尾悬念"><input value={settings.cliffhanger} onChange={(e) => patch("cliffhanger", e.target.value)} placeholder="本集结尾留什么悬念"
                                            className="h-[34px] min-w-0 flex-1 rounded-[12px] border border-foreground/10 bg-card px-3 text-[13px] outline-none focus:border-primary" /></Field>
                                    </Section>

                    <Section marker="voice-library" icon={<Music2 className="size-4" />} title="音色库" desc="影策 voice-profiles：登记音色档案与声音样本 storageKey。这里登记后，在「项目资产 → 角色 → 声音样本」的下拉里即可选中该档案；选中立即真写进对应角色的 character.voice（含 storageKey），随角色开口段发送，不是只存本地的下拉装饰。">
                                        <p className="pl-1 text-[10px] leading-relaxed text-muted-foreground">样本 storageKey 需是素材库里真实存在的音频；「音色描述」会作为该角色声线写回 voice_description。未填样本 storageKey 的档案不会进入绑定下拉。</p>
                                        <div className="space-y-2">
                                            {settings.voiceProfiles.map((vp, index) => (
                                                <div key={vp.id} className="flex items-center gap-2 rounded-md border border-border bg-background/40 p-2">
                                                    <Mic2 className="size-3.5 shrink-0 text-muted-foreground" />
                                                    <input value={vp.name} onChange={(e) => { const next = [...settings.voiceProfiles]; next[index] = { ...vp, name: e.target.value }; patch("voiceProfiles", next); }}
                                                        placeholder="音色名称" className="h-7 w-32 rounded border border-border bg-background px-2 text-xs outline-none" />
                                                    <input value={vp.description} onChange={(e) => { const next = [...settings.voiceProfiles]; next[index] = { ...vp, description: e.target.value }; patch("voiceProfiles", next); }}
                                                        placeholder="音色描述" className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs outline-none" />
                                                    <input value={vp.sampleRef} onChange={(e) => { const next = [...settings.voiceProfiles]; next[index] = { ...vp, sampleRef: e.target.value }; patch("voiceProfiles", next); }}
                                                        placeholder="样本 storageKey" className="h-7 w-40 rounded border border-border bg-background px-2 text-[11px] outline-none" />
                                                    <button type="button" onClick={() => patch("voiceProfiles", settings.voiceProfiles.filter((_, i) => i !== index))}
                                                        className="text-muted-foreground hover:text-rose-500"><Trash2 className="size-3.5" /></button>
                                                </div>
                                            ))}
                                            <button type="button" onClick={() => patch("voiceProfiles", [...settings.voiceProfiles, { id: `vp-${Date.now()}`, name: "", description: "", sampleRef: "" }])}
                                                className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                                                <Plus className="size-3.5" /> 添加音色
                                            </button>
                                        </div>
                                    </Section>

                    <Section marker="review-policy" icon={<Eye className="size-4" />} title="审阅策略（导演审阅闸门 · reviewPolicy）" desc="production-contract 的 directorReviewPolicySchema：控制导演产物里「共享资产」与「场次」两个审核点是自动通过还是需人工审阅。选择后真写进当前集制作稿 settings.reviewPolicy（set_settings op），不是只读 schema 展示。">
                                        <div className="grid gap-1.5" data-studio-review-policy>
                                            {REVIEW_POLICY_MODES.map((mode) => (
                                                <label key={mode} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition",
                                                    settings.reviewPolicy.mode === mode ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
                                                    <input type="radio" name="studio-review-policy-mode" className="mt-0.5 size-3.5"
                                                        disabled={reviewPolicySaving}
                                                        checked={settings.reviewPolicy.mode === mode}
                                                        onChange={() => void persistReviewPolicy(reviewPolicyForMode(mode, settings.reviewPolicy))} />
                                                    <span className="min-w-0">
                                                        <span className="block font-medium">{REVIEW_POLICY_MODE_LABELS[mode]}</span>
                                                        <span className="block text-[10px] text-muted-foreground">
                                                            {mode === "none" ? "两个审核点都不打断" : mode === "automatic" ? "共享资产与场次均自动审阅" : mode === "manual" ? "共享资产与场次均需人工审阅" : "两个审核点分别指定（下方可调）"}
                                                        </span>
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                        {settings.reviewPolicy.mode === "mixed" ? (
                                            <div className="grid grid-cols-2 gap-2" data-studio-review-policy-points>
                                                {(["shared", "scene"] as const).map((point) => (
                                                    <label key={point} className="flex items-center gap-2 text-xs">
                                                        <span className="w-16 shrink-0 text-muted-foreground">{point === "shared" ? "共享资产" : "场次"}</span>
                                                        <select value={settings.reviewPolicy[point]} disabled={reviewPolicySaving}
                                                            onChange={(e) => void persistReviewPolicy({ ...settings.reviewPolicy, [point]: e.target.value as "automatic" | "manual" })}
                                                            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none">
                                                            {(["automatic", "manual"] as const).map((v) => <option key={v} value={v}>{REVIEW_POINT_LABELS[v]}</option>)}
                                                        </select>
                                                    </label>
                                                ))}
                                            </div>
                                        ) : null}
                                        <p className="text-[10px] leading-relaxed text-amber-600/90" data-studio-review-policy-relation>
                                            与「审阅方式 reviewMode」是两套独立闸门、叠加生效：reviewMode 管流水线集级的人工确认（样片/每集/全自动），reviewPolicy 管导演产物的共享资产与场次审核点。即使 reviewMode=auto，reviewPolicy=manual 的审核点仍需人工审阅；两者都通过才继续生成。
                                        </p>
                                        {reviewPolicyNote ? <p className="text-[10px] text-emerald-600" data-studio-review-policy-note>{reviewPolicyNote}</p> : null}
                                    </Section>

                    <Section marker="production-stage" icon={<Gauge className="size-4" />} title="制作阶段（只读）" desc="六段制作阶段游标是制作稿的真值，设置页只读展示、不造假开关：数据源为当前集 draft.settings.productionStage，与 agent 总流程和制作进度条同一字段。">
                                        <div className="flex flex-wrap gap-1.5" data-studio-production-stage>
                                            {PRODUCTION_STAGE_KEYS.map((key) => {
                                                const done = Boolean(stageTruth?.done.includes(key));
                                                const current = stageTruth?.current === key;
                                                return (
                                                    <span key={key} className={cn("rounded-md border px-2 py-1 text-[11px]",
                                                        current ? "border-primary bg-primary/10 text-primary"
                                                            : done ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                                                                : "border-border text-muted-foreground")}>
                                                        {PRODUCTION_STAGE_LABELS[key] || key}{current ? " · 当前" : done ? " · 完成" : ""}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                        <p className="text-[10px] text-muted-foreground" data-studio-production-stage-truth>
                                            {stageTruth ? `第 ${stageTruth.episodeNo} 集当前阶段：${PRODUCTION_STAGE_LABELS[stageTruth.current] || stageTruth.current || "未设置"}；已完成：${stageTruth.done.map((k) => PRODUCTION_STAGE_LABELS[k] || k).join("、") || "无"}` : (stageNote || "读取中…")}
                                        </p>
                                        <p className="text-[10px] leading-relaxed text-muted-foreground">阶段游标由制作流程按序推进并写回制作稿；设置页不提供手动改写入口，避免绕过开工报告的真值。</p>
                                    </Section>
                </div>
                <aside className="space-y-3 lg:sticky lg:top-4">
                    <Section marker="work" icon={<BookOpen className="size-4" />} title="作品" desc="影策记为“开工时确定”，只读展示当前剧目的真实信息。">
                                        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                                            <dt className="text-muted-foreground">剧目</dt><dd className="truncate">{studioInfo?.dramaName || "—"}</dd>
                                            <dt className="text-muted-foreground">分集</dt><dd>{studioInfo ? `${studioInfo.episodeCount} 集` : "—"}</dd>
                                            <dt className="text-muted-foreground">原文章节</dt><dd>{studioInfo ? `${studioInfo.chapterCount} 章` : "—"}</dd>
                                            <dt className="text-muted-foreground">画幅</dt><dd title="画幅真值取自「视频 · 画幅」：资产参考图与成片都按同一画幅出片">{settings.videoAspectRatio === "9:16" ? "9:16（竖版）" : "16:9（横版）"}</dd>
                                            <dt className="text-muted-foreground">视觉风格</dt><dd className="truncate">{artStyle || <span className="text-muted-foreground">剧目规划未设置</span>}</dd>
                                            <dt className="text-muted-foreground">对白语言</dt><dd>{dialogueLanguage || <span className="text-muted-foreground">剧目规划未设置</span>}
                                                <span className="ml-1 text-[10px] text-muted-foreground/70">（可选：{TOPIC_OPTIONS.language.join(" / ")}）</span></dd>
                                        </dl>
                                    </Section>

                    <Section icon={<Eye className="size-4" />} title="审阅方式" aside="只在关键点打断你" desc="影策 reviewMode：只在关键点打断你。保存后启动流水线时真实下发到服务端闸门（sample=第1集成片后确认 / every=每集视频前审阅 / auto=不打断）。">
                                        <div className="grid gap-1.5">
                                            {([
                                                { value: "sample", title: "先看样片", detail: "第 1 集成片确认后继续其余集" },
                                                { value: "every", title: "每集确认", detail: "每集生成视频前停下来审阅段视频提示词" },
                                                { value: "auto", title: "全自动", detail: "不打断，直接跑到成片" },
                                            ] as const).map((opt) => (
                                                <label key={opt.value} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition", settings.reviewMode === opt.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
                                                    <input type="radio" name="studio-review-mode" className="mt-0.5 size-3.5" checked={settings.reviewMode === opt.value} onChange={() => patch("reviewMode", opt.value)} />
                                                    <span className="min-w-0">
                                                        <span className="block font-medium">{opt.title}</span>
                                                        <span className="block text-[10px] text-muted-foreground">{opt.detail}</span>
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </Section>

                    <Section icon={<Play className="size-4" />} title="生成节奏" desc="影策 mediaMode：手动先出剧本与提示词、确认后再生成视频；自动一路跑到成片。保存后启动流水线真实生效（manual 模式下素材就绪后需在「待处理」页放行媒体）。">
                                        <div className="grid grid-cols-2 gap-2">
                                            {([
                                                { value: "manual", title: "手动生成", detail: "先出剧本与提示词，确认后再生成参考图与视频" },
                                                { value: "auto", title: "全自动出片", detail: "剧本写好后直接生成参考图和带原声的段视频" },
                                            ] as const).map((opt) => (
                                                <label key={opt.value} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition", settings.mediaMode === opt.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
                                                    <input type="radio" name="studio-media-mode" className="mt-0.5 size-3.5" checked={settings.mediaMode === opt.value} onChange={() => patch("mediaMode", opt.value)} />
                                                    <span className="min-w-0">
                                                        <span className="block font-medium">{opt.title}</span>
                                                        <span className="block text-[10px] leading-relaxed text-muted-foreground">{opt.detail}</span>
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </Section>

                    <Section marker="continuity" icon={<Rows3 className="size-4" />} title="段落衔接" aside="决定同一集的剧情段能否同时生成" desc="尾帧续接：第2段起用上段尾帧做首帧、依次衔接；并行出片：各段只按参考图独立成片、不带尾帧首帧。保存后撰写段提示词真实生效。">
                                        <div className="flex gap-2">
                                            <button type="button" onClick={() => patch("continuationMode", "tail")}
                                                className={cn("flex-1 rounded-md border p-3 text-left transition", settings.continuationMode === "tail" ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>
                                                <div className="text-xs font-medium">尾帧续接</div>
                                                <div className="mt-1 text-[10px] text-muted-foreground">默认 · 顺序逐段 · 上段尾帧做首帧</div>
                                            </button>
                                            <button type="button" onClick={() => patch("continuationMode", "parallel")}
                                                className={cn("flex-1 rounded-md border p-3 text-left transition", settings.continuationMode === "parallel" ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>
                                                <div className="text-xs font-medium">并行出片</div>
                                                <div className="mt-1 text-[10px] text-muted-foreground">不带首帧 · 各段按参考图独立成片</div>
                                            </button>
                                        </div>
                                        {continuityProblem ? <p className="text-xs text-destructive" role="alert" data-studio-video-warning="tail-chain">{continuityProblem}</p> : null}
                                        {continuityPreview ? <p className="text-[11px] text-amber-600" data-studio-continuity-preview>{continuityPreview}</p> : null}
                                    </Section>

                    <Section icon={<Gauge className="size-4" />} title="同时生成数" aside="文字、参考图、段视频分别计算，受账号并发上限约束" desc="文字/段视频/成片合成三池并发真实下发后端流水线（成片合成对应后端 render 池）；排队顺序先按集号，同集内按成片→剧本→段提示词→段视频。参考图池由后端固定上限管理，无剧目级覆盖字段，不设假滑杆。">
                                        {([["text", "文字"], ["video", "段视频"], ["assemble", "成片合成"]] as const).map(([key, label]) => (
                                            <Field key={key} label={label}>
                                                <input type="range" min={1} max={8} value={settings.concurrency[key]}
                                                    onChange={(e) => patch("concurrency", { ...settings.concurrency, [key]: Number(e.target.value) })}
                                                    className="flex-1" />
                                                <span className="w-6 text-center tabular-nums">{settings.concurrency[key]}</span>
                                            </Field>
                                        ))}
                                    </Section>

                    <Section icon={<ImageIcon className="size-4" />} title="每段最多参考图" aside="自动取参考图时的上限，人物优先；0 为按视频模型上限" desc="影策 referenceLimit：自动取参考图时的上限，人物优先；0 为按视频模型上限。保存后启动流水线真实下发后端（H3 契约硬上限内收窄）。">
                                        <Field label="每段最多参考图" hint="0 = 按模型上限">
                                            <input type="number" min={0} max={20} step={1} value={settings.referenceLimit}
                                                aria-label="每段最多参考图"
                                                onChange={(e) => patch("referenceLimit", Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                                                className="h-7 w-24 rounded-[12px] border border-foreground/10 bg-card px-2 text-[13px] outline-none focus:border-primary" />
                                            <span className="text-[10px] text-muted-foreground">张 · 人物优先</span>
                                        </Field>
                                        <p className="text-[10px] text-muted-foreground">超出的设定按文字描述生成，不附图；个别段可在剧情段弹窗手动指定。</p>
                                    </Section>

                    <Section icon={<Gauge className="size-4" />} title="预算上限" aside="0 表示不限，含精修画布花费；达到后暂停，画布上也不能再生成" desc="影策同名预算护栏（budgetMicrocredits）：微积分计，0/不限。流水线按文字/图/段视频累计花费，达到上限自动暂停（pause_reason=budget_exceeded），resume 也会拒绝，防止超支。真实 usage 回包优先、否则用保守估算单价。">
                                        <Field label="预算（微积分）">
                                            <input type="number" min={0} step={1000} value={settings.budgetMicrocredits}
                                                onChange={(e) => patch("budgetMicrocredits", Math.max(0, Number(e.target.value) || 0))}
                                                className="flex-1" data-studio-budget-input />
                                            <span className="text-[10px] text-muted-foreground">0=不限</span>
                                        </Field>
                                    </Section>

                    <Section icon={<FilmIcon />} title="样片模式" desc="影策以第1集为样片。开启后流水线把第1集视频设为审阅闸门：第1集成片需人工确认，才继续其余集；与下方审阅方式叠加。">
                                        <label className="flex items-center gap-2 text-xs">
                                            <input type="checkbox" checked={settings.sampleMode} onChange={(e) => patch("sampleMode", e.target.checked)} className="size-3.5" />
                                            启用样片模式（第1集作为样片）
                                        </label>
                                    </Section>
                </aside>
            </div>
            </div>
        </div>
    );
}

function FilmIcon() {
    return <Film className="size-4" />;
}
