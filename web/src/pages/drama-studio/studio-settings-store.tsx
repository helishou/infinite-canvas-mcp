import { useMemo } from "react";
import type { DirectorReviewPolicy } from "@basketikun/canvas-agent/drama/production-contract";
import { DRAMA_VIDEO_RESOLUTION_TIERS, dramaVideoResolutionShortSide, type DramaVideoAspectRatio } from "@basketikun/canvas-agent/drama/video-resolution";
import { modelOptionLabel, selectableModelsByCapability, useConfigStore, VIDEO_CONCAT_MODEL, type ReasoningEffort } from "@/stores/use-config-store";
import { cn } from "@/lib/utils";

import type { SkillRef } from "./studio-skill-picker";
import { resolveConcurrency } from "./studio-settings-concurrency";

/**
 * 剧目级「制作设置」的真值模块：设置页（studio-settings-tab）与新建页（new-drama-page）共用
 * 同一份字段、默认值、读写入口与档位文案，保证在新建页选的东西，创建后到设置页看到的是同一套配置。
 *
 * 持久化位置：localStorage `drama-studio:settings:<剧目ID>`。
 * 真实消费方：制作台启动流水线时把这里的模型 / 思考等级 / 技能 / 分镜规则 / 审阅与生成节奏
 * 下发给后端（drama-pipeline-routes.ts 的 startSchema + pipeline.ts 的 DramaPipelineRuntimeOptions）。
 */

/** 思考等级用本地文本设置里真实存在的档位（text-settings-panel.tsx）。 */
export const STUDIO_THINKING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" },
];

/** 审阅策略：与 production-contract.directorReviewPolicySchema 同档，按 mode 收敛 shared/scene。 */
export const REVIEW_POLICY_MODES = ["none", "automatic", "mixed", "manual"] as const;
export const DEFAULT_REVIEW_POLICY: DirectorReviewPolicy = { mode: "none", shared: "none", scene: "none" };

export function normalizeReviewPolicy(value: unknown): DirectorReviewPolicy {
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
export function reviewPolicyForMode(mode: (typeof REVIEW_POLICY_MODES)[number], current: DirectorReviewPolicy): DirectorReviewPolicy {
    if (mode === "none") return { mode: "none", shared: "none", scene: "none" };
    if (mode === "mixed") return {
        mode: "mixed",
        shared: current.shared === "manual" ? "manual" : "automatic",
        scene: current.scene === "manual" ? "manual" : "automatic",
    };
    return { mode, shared: mode, scene: mode } as DirectorReviewPolicy;
}

/** 剧目级视频分辨率档位（短边像素）+「模型默认」；档位真值来自共享 drama/video-resolution 模块。 */
export const VIDEO_RESOLUTION_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "", label: "模型默认" },
    ...DRAMA_VIDEO_RESOLUTION_TIERS.map((tier) => ({ value: tier, label: tier })),
];
/** 剧目级画幅：横屏 / 竖屏（影策 final-view aspectRatioValue 支持 9:16 竖屏）。 */
export const VIDEO_ASPECT_OPTIONS: Array<{ value: DramaVideoAspectRatio; label: string }> = [
    { value: "16:9", label: "横屏 16:9" },
    { value: "9:16", label: "竖屏 9:16" },
];

/** 分辨率档位按短边像素比较，登记写法 "720"/"720P"/"720p" 与 UI 档位 "720p" 视为同一档。 */
export function resolutionTierMatches(registered: string, tier: string) {
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
    // 同时生成数（影策 DramaSettings.Concurrency）：一个值，文字/参考图/视频/成片四池各自独立计数。
    // 旧版本是 {text,video,assemble} 三值对象，resolveStudioSettings 会收敛成单值。
    concurrency: number;
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
    concurrency: 4, // 影策 DEFAULT_CONCURRENCY=4（drama_types.go:227）
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
export const MIN_EPISODE_SECONDS = 30;
export const MAX_EPISODE_SECONDS = 1200;
export const EPISODE_PRESETS = [60, 90, 120, 180, 300, 600] as const;
/** 剧情段秒数与转场时长范围：影策 MIN/MAX_SEGMENT_SECONDS、MIN_TRANSITION_MS 与 1500 上限。 */
export const MIN_SEGMENT_SECONDS = 4;
export const MAX_SEGMENT_SECONDS = 60;
export const MIN_TRANSITION_MS = 150;
export const MAX_TRANSITION_MS = 1500;

/** 影策 formatEpisodeSeconds：90 → 「1 分 30 秒」，60 → 「1 分钟」。 */
export function formatEpisodeSeconds(seconds: number) {
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** 影策 parseEpisodeSeconds：解析「90 / 5分钟 / 5min / 2:30 / 1分30秒」，无法识别返回 null。 */
export function parseEpisodeSeconds(raw: string): number | null {
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
export const PACING_DETAIL: Record<string, string> = {
    "极快": "1.5–3 秒短镜连切，冲突与反转处密集切换，几乎不用长镜头",
    "快": "2–4 秒短镜为主，冲突处密集切换",
    "标准": "2–5 秒为主，关键台词可到 6 秒",
    "舒缓": "3–6 秒为主，情绪戏可到 8 秒",
    "慢": "4–8 秒长镜，可用空镜营造情绪",
};
/** 影策 SEGMENT_MODES 档位说明：剧情段切分方式。 */
export const SEGMENT_MODE_DETAIL: Record<string, string> = {
    "auto": "按场景切换与冲突转折切段，单段不超过视频模型单次上限",
    "fixed": "每段固定秒数，跨场景也按时长切",
    "range": "每段在设定范围内，达到下限后在场景切换处断开",
};
/** 影策 storyboard-rules.tsx:120-125 DIALOGUE 档位说明（只写适用场景，数值由后端规则决定）。 */
export const DIALOGUE_DETAIL: Record<string, string> = {
    "dense": "适合爽剧、对手戏",
    "standard": "适合多数剧情",
    "restrained": "留给动作与氛围",
    "custom": "按剧情需要自行安排，全剧统一口径",
};
/** 影策 storyboard-rules.tsx:147-152 TRANSITIONS 档位说明。 */
export const TRANSITION_DETAIL: Record<string, string> = {
    "smart": "默认硬切，场景跳转用黑场，回忆用闪白",
    "hard": "全部直接切换",
    "fade": "每次切镜都经过黑场",
    "flash": "每次切镜都短暂闪白",
};
/** 摘要估算：影策 PACING 平均镜头秒数（lib/drama/storyboard.ts:23，本地 canvas-agent/drama/pacing.ts 同表移植）。 */
export const PACING_AVERAGE_SECONDS: Record<string, number> = { "极快": 2, "快": 2.5, "标准": 3.5, "舒缓": 4.5, "慢": 5.5 };
/** 影策 DIALOGUE_PRESETS 与本地 canvas-agent/drama/pacing.ts dialogueRules 同表：语速、单句秒数、单句字数、气口。 */
export const DIALOGUE_RULES: Record<string, { speechRate: number; lineSeconds: number; lineMaxRunes: number; linePauseMs: number }> = {
    dense: { speechRate: 4.5, lineSeconds: 3, lineMaxRunes: 12, linePauseMs: 300 },
    standard: { speechRate: 4.5, lineSeconds: 4.5, lineMaxRunes: 16, linePauseMs: 500 },
    restrained: { speechRate: 4.5, lineSeconds: 7, lineMaxRunes: 20, linePauseMs: 500 },
};

export const PERFORMANCE_BANDS_DETAIL = [
    "几乎不动声色，情绪只在眼神、呼吸和极细微的表情里，台词轻声平稳但有潜台词",
    "表情变化小而准确，靠眼神、停顿传达情绪，关键句压低声音或放慢加力，适合悬疑、文艺",
    "表情随台词实时变化，台词有轻重缓急和停顿，说话时其他人有可见反应",
    "冲突处瞪眼、咬牙、冷笑、红眼眶，台词音量随情绪起伏、关键句爆发，适合爽剧",
    "情绪大开大合、动作放大到一眼可读，爆发处怒吼、哽咽、破音，关键台词后给反应特写",
] as const;
export const PERFORMANCE_BANDS_LABEL = ["内敛", "克制", "自然", "饱满", "夸张"] as const;
export const CAMERA_BANDS_DETAIL = [
    "固定机位为主，只做极缓慢的推近，靠构图和表演推动情绪",
    "固定机位与缓慢推拉为主，对话正反打，情绪高点才推近特写",
    "推拉摇移服务于情绪，对话正反打与过肩，情绪升级时推近特写，不整段静止",
    "冲突与反转处快速推近、跟拍、低机位仰拍，多数镜头有机位运动或人物调度",
    "频繁快速推拉、甩镜、手持跟拍与环绕，每个镜头都有明确运动，节奏紧凑",
] as const;
export const CAMERA_BANDS_LABEL = ["静态", "稳定", "标准", "动感", "强烈"] as const;
/** 1–10 档 → 五段索引（1-2/3-4/5-6/7-8/9-10），与影策 performanceBands/cameraBands 同口径。 */
export const levelBandIndex = (value: number) => Math.min(4, Math.max(0, Math.floor((value - 1) / 2)));

/** 档位标签：设置页与新建页共用同一份（值与文案来自影策 storyboard-rules 的档位）。 */
export const PACING_LABEL = ["极快", "快", "标准", "舒缓", "慢"] as const;
export const SEGMENT_MODE_LABEL: Record<"auto" | "fixed" | "range", string> = { auto: "智能", fixed: "固定", range: "范围" };
export const DIALOGUE_LABEL: Record<"dense" | "standard" | "restrained" | "custom", string> = { dense: "密集", standard: "标准", restrained: "克制", custom: "自定义" };
export const TRANSITION_LABEL: Record<"smart" | "hard" | "fade" | "flash", string> = { smart: "智能", hard: "硬切", fade: "黑场过渡", flash: "闪白" };
/** 表演强度 / 运镜动感按 1–10 归一后的五段档位值（影策 tickValues）。 */
export const BAND_TICK_VALUES = [1, 3, 5, 7, 10] as const;

export const studioSettingsStorageKey = (dramaId: string) => `drama-studio:settings:${dramaId}`;

/** 剧情段秒数区间收敛到影策 4–60 秒，并保证 min ≤ max（等价 normalizeStoryboard 的 seconds()/大小互换）。 */
export function clampRange(range: { min: number; max: number }) {
    const clamp = (value: unknown) => Math.max(MIN_SEGMENT_SECONDS, Math.min(MAX_SEGMENT_SECONDS, Math.round(Number(value) || MIN_SEGMENT_SECONDS)));
    const low = clamp(range.min);
    const high = clamp(range.max);
    return { min: Math.min(low, high), max: Math.max(low, high) };
}

/**
 * 把可能不全 / 含坏值的设置收敛成一份完整设置：loadStudioSettings 与新建页创建时共用同一套规则，
 * 保证创建出来的剧目在设置页读到的值与新建页所选一致。
 */
export function resolveStudioSettings(partial: Partial<StudioProductionSettings> | undefined): StudioProductionSettings {
    const base = DEFAULT_STUDIO_SETTINGS;
    const source = partial || {};
    return {
        ...base,
        ...source,
        concurrency: resolveConcurrency(source.concurrency, base.concurrency),
        // 老剧目 localStorage 没有 segmentMode 时按默认 auto；非法值收敛，不让坏值进 UI/下发。
        segmentMode: (["auto", "fixed", "range"] as const).includes(source.segmentMode as "auto") ? source.segmentMode as "auto" | "fixed" | "range" : base.segmentMode,
        // 影策 clamp（storyboard.ts:62-85）：剧情段 4–60 秒、单集 30–1200 秒、转场 150–1500 毫秒，越界值收敛后才进 UI/下发。
        segmentRange: clampRange({ ...base.segmentRange, ...(source.segmentRange || {}) }),
        episodeSeconds: Math.max(MIN_EPISODE_SECONDS, Math.min(MAX_EPISODE_SECONDS, Math.round(Number(source.episodeSeconds) || base.episodeSeconds))),
        transitionMs: Math.max(MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, Math.round(Number(source.transitionMs) || MIN_TRANSITION_MS))),
        textThinking: { ...base.textThinking, ...(source.textThinking || {}) },
        textSkills: { ...base.textSkills, ...(source.textSkills || {}) },
        voiceProfiles: Array.isArray(source.voiceProfiles) ? source.voiceProfiles : [],
        // 老剧目没有模板字段时按空（沿用内置方案模板），非字符串值收敛成空串，不让坏值进 UI。
        assetPromptTemplates: {
            character: String(source.assetPromptTemplates?.character ?? ""),
            scene: String(source.assetPromptTemplates?.scene ?? ""),
            default: String(source.assetPromptTemplates?.default ?? ""),
        },
        // 老剧目没有该字段时按默认（不审阅），非法组合按 schema 收敛，不让坏值进 UI。
        reviewPolicy: normalizeReviewPolicy(source.reviewPolicy),
    };
}

export function loadStudioSettings(dramaId: string | null): StudioProductionSettings {
    if (!dramaId) return { ...DEFAULT_STUDIO_SETTINGS };
    try {
        const raw = localStorage.getItem(studioSettingsStorageKey(dramaId));
        if (!raw) return { ...DEFAULT_STUDIO_SETTINGS };
        return resolveStudioSettings(JSON.parse(raw) as Partial<StudioProductionSettings>);
    } catch {
        return { ...DEFAULT_STUDIO_SETTINGS };
    }
}

/** 写入某剧目的制作设置（设置页「保存设置」与新建页「创建」共用同一落点）。 */
export function saveStudioSettings(dramaId: string, settings: StudioProductionSettings) {
    localStorage.setItem(studioSettingsStorageKey(dramaId), JSON.stringify(settings));
}

/** 一组并列选项按钮（分段控件），用于智能/固定、对白密度、转场等分段选项。 */
export function ChoiceButtons<T extends string>({ value, options, onChange, marker }: {
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

/** 文本/图片/视频模型下拉：选项来自本地模型配置（selectableModelsByCapability），文字模型优先列本地 Hermes 引擎。 */
export function ModelSelect({ value, capability, onChange, config, fallbackLabel = "跟随默认", marker }: {
    value: string;
    capability: "text" | "image" | "video";
    onChange: (value: string) => void;
    config: ReturnType<typeof useConfigStore.getState>["config"];
    fallbackLabel?: string;
    marker?: string;
}) {
    const { engineOptions, fallbackOptions } = useMemo(() => {
        // 视频拼接是画布上的拼接任务模型，不是出片模型，不出现在剧目的视频模型选择里。
        const options = selectableModelsByCapability(config, capability).filter((option) => option !== VIDEO_CONCAT_MODEL);
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
            data-studio-model-select={marker || capability}
        >
            <option value="">{fallbackLabel}</option>
            {capability === "text" && engineOptions.length ? (
                <optgroup label="本地引擎 · Hermes">
                    {engineOptions.map((option) => (
                        <option key={option} value={option}>{modelOptionLabel(config, option)}</option>
                    ))}
                </optgroup>
            ) : null}
            {capability === "text" && fallbackOptions.length ? (
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
