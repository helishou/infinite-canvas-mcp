import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Music2, Sparkles, Wand2, SlidersHorizontal, Rows3, Gauge, Save, Plus, Trash2, Mic2, Film, Eye, Play, Image as ImageIcon, BookOpen, RotateCcw } from "lucide-react";

import {
    modelOptionLabel,
    modelVideoCapabilitiesOf,
    selectableModelsByCapability,
    encodeChannelModel,
    setModelPromptMaxChars,
    useConfigStore,
    type ReasoningEffort,
} from "@/stores/use-config-store";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { applyDramaEpisodeGrouping, autoPlanDramaEpisodeGrouping, fetchBackendCanvasFolders, patchDramaPlanningMode, patchDramaTopicArtStyle, previewDramaEpisodeGrouping, fetchBackendDramaEpisodes, fetchEpisodeProduction, editEpisodeProduction, type DramaEpisodeGroupingPreview } from "@/services/backend-api";
import { DRAMA_STYLE_FORMS, DRAMA_STYLE_THEMES, composeDramaStyleId, findComposedDramaStyle, findComposedDramaStyleByPrompt, type DramaStyleFormId, type DramaStyleThemeId } from "@/lib/drama/style-composition";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { TOPIC_OPTIONS } from "@basketikun/canvas-agent/drama/topic-options";
import { ASSET_KIND_SKILL, ASSET_SCHEMES, defaultSchemeFor, schemeAppliesTo, type AssetSchemeId } from "@basketikun/canvas-agent/drama/asset-spec";
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
 * - 「重做参考图」本地无等价后端能力，只提供前往画布手动重做的引导，不造假按钮。
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
    segmentRange: { min: number; max: number };                    // 剧情段时长软约束（秒），下发 storyboardRules.segmentRange
    dialogueDensity: "dense" | "standard" | "restrained" | "custom"; // 对白密度
    transitionMode: "smart" | "hard" | "fade" | "flash";           // 转场（转场时长见 transitionMs）
    // 文字步骤：新增「分集规划」模型 + 每步思考等级
    planModel: string;
    textThinking: { plan: ReasoningEffort; extract: ReasoningEffort; storyboard: ReasoningEffort; prompt: ReasoningEffort };
    // 写作技能（来自本地技能库，真值引用 {name,title,path}；分集规划无对应技能槽，影策只有 bible/script/prompt）
    textSkills: { extract: SkillRef | null; storyboard: SkillRef | null; prompt: SkillRef | null };
    // 参考图设定版式（用真实 imageKind 值，"auto" = 跟随资产类型）
    referenceLayout: "auto" | string;
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
    pacing: "快",
    transitionMs: 150,
    performanceIntensity: 5,
    cameraDynamics: 5,
    videoModel: "",
    videoResolution: "",
    videoAspectRatio: "16:9",
    hook: "",
    cliffhanger: "",
    voiceProfiles: [],
    sampleMode: false,
    reviewMode: "auto",
    reviewPolicy: { ...DEFAULT_REVIEW_POLICY },
    mediaMode: "auto",
    referenceLimit: 0,
    // 差异#6
    episodeSeconds: 90,
    segmentRange: { min: 8, max: 15 },
    dialogueDensity: "standard",
    transitionMode: "smart",
    planModel: "",
    textThinking: { plan: "auto", extract: "auto", storyboard: "auto", prompt: "auto" },
    textSkills: { extract: null, storyboard: null, prompt: null },
    referenceLayout: "auto",
};

const storageKey = (dramaId: string) => `drama-studio:settings:${dramaId}`;

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
            segmentRange: { ...DEFAULT_STUDIO_SETTINGS.segmentRange, ...(parsed.segmentRange || {}) },
            textThinking: { ...DEFAULT_STUDIO_SETTINGS.textThinking, ...(parsed.textThinking || {}) },
            textSkills: { ...DEFAULT_STUDIO_SETTINGS.textSkills, ...(parsed.textSkills || {}) },
            voiceProfiles: Array.isArray(parsed.voiceProfiles) ? parsed.voiceProfiles : [],
            // 老剧目没有该字段时按默认（不审阅），非法组合按 schema 收敛，不让坏值进 UI。
            reviewPolicy: normalizeReviewPolicy(parsed.reviewPolicy),
        };
    } catch {
        return { ...DEFAULT_STUDIO_SETTINGS };
    }
}

function Section({ icon, title, desc, children, marker }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode; marker?: string }) {
    return (
        <section className="rounded-lg border border-border bg-card/40 p-4" data-studio-settings-section={marker}>
            <div className="mb-3 flex items-center gap-2">
                <span className="text-foreground/70">{icon}</span>
                <h3 className="text-sm font-semibold">{title}</h3>
            </div>
            {desc ? <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{desc}</p> : null}
            <div className="space-y-3">{children}</div>
        </section>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="flex items-center gap-3 text-xs">
            <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
            <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
            {hint ? <span className="shrink-0 text-[10px] text-muted-foreground/70">{hint}</span> : null}
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
        <div className="flex flex-1 flex-wrap gap-1" data-studio-choice={marker}>
            {options.map((o) => (
                <button key={o.value} type="button" onClick={() => onChange(o.value)}
                    className={cn("rounded-md border px-2.5 py-1 text-[11px] transition",
                        value === o.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function ModelSelect({ value, capability, onChange, config }: {
    value: string;
    capability: "text" | "image" | "video";
    onChange: (value: string) => void;
    config: ReturnType<typeof useConfigStore.getState>["config"];
}) {
    const options = useMemo(() => selectableModelsByCapability(config, capability), [config, capability]);
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
        >
            <option value="">跟随默认</option>
            {options.map((option) => (
                <option key={option} value={option}>{modelOptionLabel(config, option)}</option>
            ))}
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
    // 单段秒数：只有真登记 maxVideoSeconds 才收紧输入框，缺省沿用原有的 60 秒产品上限，不造假能力。
    const segmentSecondsCap = maxVideoSeconds ?? 60;

    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" data-studio-settings>
            <div className="mx-auto max-w-3xl space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-base font-semibold">制作设置</h2>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">对应影策「制作设置 / 新建页」的全部配置项 · 按剧目独立保存</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onReset}
                            disabled={!dramaId || saving}
                            title="还原到最后保存的设置"
                            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                            <RotateCcw className="size-3.5" /> 还原
                        </button>
                        <button
                            type="button"
                            onClick={onSave}
                            disabled={!dramaId || saving}
                            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-background! transition hover:opacity-90 disabled:opacity-50"
                        >
                            <Save className="size-3.5" /> {saving ? "保存中…" : "保存设置"}
                        </button>
                    </div>
                </div>

                <Section marker="storyboard-rules" icon={<Rows3 className="size-4" />} title="分镜规则" desc="影策「分镜规则」：单集时长、剧情段、对白密度、转场。保存后启动流水线真实下发后端 storyboardRules（拆镜/提示词 job 读它写成软约束），并注入手动改编指令；转场时长见下方「镜头节奏与表演」。">
                    <Field label="单集时长" hint="≈ 1.5 分钟">
                        <input type="number" min={30} max={600} step={5} value={settings.episodeSeconds}
                            onChange={(e) => patch("episodeSeconds", Math.max(30, Math.min(600, Number(e.target.value) || 90)))}
                            data-studio-episode-seconds
                            className="h-8 w-24 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                        <span className="text-[10px] text-muted-foreground">秒 · 当前约 {(settings.episodeSeconds / 60).toFixed(1)} 分钟</span>
                    </Field>
                    <p className="pl-28 text-[10px] leading-relaxed text-amber-600/90" data-studio-soft-hint="episode-seconds">
                        软约束，影响拆镜提示词：写入 storyboardRules.episodeSeconds 作为拆镜/提示词的时长目标，不强制成片剪辑时长。
                    </p>
                    <Field label="剧情段时长" hint="秒 / 段 · 软约束">
                        <input type="number" min={2} max={segmentSecondsCap} value={settings.segmentRange.min}
                            onChange={(e) => patch("segmentRange", { ...settings.segmentRange, min: Math.max(2, Math.min(segmentSecondsCap, Number(e.target.value) || 2)) })}
                            data-studio-segment-seconds="min"
                            className="h-8 w-16 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                        <span className="text-muted-foreground">—</span>
                        <input type="number" min={2} max={segmentSecondsCap} value={settings.segmentRange.max}
                            onChange={(e) => patch("segmentRange", { ...settings.segmentRange, max: Math.max(2, Math.min(segmentSecondsCap, Number(e.target.value) || 2)) })}
                            data-studio-segment-seconds="max"
                            className="h-8 w-16 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                        <span className="text-[10px] text-muted-foreground">下发为拆镜/提示词的时长要求</span>
                    </Field>
                    {maxVideoSeconds !== undefined ? (
                        <p className="text-[10px] text-muted-foreground" data-studio-video-warning="max-seconds-hint">
                            单段不超过 {maxVideoSeconds} 秒（{modelLabel}上限）。
                        </p>
                    ) : null}
                    {maxVideoSeconds !== undefined && (settings.segmentRange.min > maxVideoSeconds || settings.segmentRange.max > maxVideoSeconds) ? (
                        <p className="text-xs text-destructive" role="alert" data-studio-video-warning="max-seconds">
                            {modelLabel}单次最长 {maxVideoSeconds} 秒，剧情段上限按 {maxVideoSeconds} 秒执行。
                        </p>
                    ) : null}
                    <Field label="对白密度">
                        <ChoiceButtons marker="dialogue-density" value={settings.dialogueDensity}
                            options={[
                                { value: "dense", label: "密集" }, { value: "standard", label: "标准" },
                                { value: "restrained", label: "克制" }, { value: "custom", label: "自定义" },
                            ]}
                            onChange={(v) => patch("dialogueDensity", v)} />
                    </Field>
                    <Field label="转场">
                        <ChoiceButtons marker="transition-mode" value={settings.transitionMode}
                            options={[
                                { value: "smart", label: "智能" }, { value: "hard", label: "硬切" },
                                { value: "fade", label: "黑场过渡" }, { value: "flash", label: "闪白" },
                            ]}
                            onChange={(v) => patch("transitionMode", v)} />
                    </Field>
                </Section>

                <Section marker="text-steps" icon={<Wand2 className="size-4" />} title="文字步骤" desc="每步可选文本模型 + 思考等级 + 写作技能；留空跟随默认。技能来自本地「技能」库，选中后其方法要点会注入改编请求（后端 instruction 上限 2000 字）。">
                    {([
                        { key: "plan", label: "分集规划", modelKey: "planModel" as const, thinkKey: "plan" as const, skillKey: null },
                        { key: "extract", label: "提取设定", modelKey: "assetExtractModel" as const, thinkKey: "extract" as const, skillKey: "extract" as const },
                        { key: "storyboard", label: "分镜拆分", modelKey: "storyboardModel" as const, thinkKey: "storyboard" as const, skillKey: "storyboard" as const },
                        { key: "prompt", label: "视频提示词", modelKey: "videoPromptModel" as const, thinkKey: "prompt" as const, skillKey: "prompt" as const },
                    ]).map((row) => (
                        <div key={row.key} className="rounded-md border border-border/60 p-2.5">
                            <Field label={row.label}>
                                <ModelSelect capability="text" config={config} value={settings[row.modelKey]}
                                    onChange={(v) => patch(row.modelKey, v)} />
                                <select value={settings.textThinking[row.thinkKey]}
                                    onChange={(e) => patch("textThinking", { ...settings.textThinking, [row.thinkKey]: e.target.value as ReasoningEffort })}
                                    className="h-8 w-20 shrink-0 rounded-md border border-border bg-background px-1.5 text-xs outline-none focus:border-primary"
                                    aria-label={`${row.label}思考等级`} data-studio-thinking={row.thinkKey}>
                                    {THINKING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </select>
                            </Field>
                            {row.skillKey ? (
                                <div className="mt-2 flex items-start gap-3 pl-1">
                                    <span className="w-14 shrink-0 pt-0.5 text-[11px] text-muted-foreground">写作技能</span>
                                    <SkillPickerField step={row.skillKey}
                                        value={settings.textSkills[row.skillKey]}
                                        onChange={(ref) => patch("textSkills", { ...settings.textSkills, [row.skillKey]: ref })} />
                                </div>
                            ) : null}
                        </div>
                    ))}
                </Section>

                <Section marker="reference" icon={<Sparkles className="size-4" />} title="参考图" desc="角色、道具、场景可分别选图片模型；分辨率档位按 1:1 换算成像素（1k=1024² / 2k=2048² / 4k=2880²），流水线生成参考图时真实下发。设定详情仍可上传或绑定素材库图片。">
                    <Field label="角色"><ModelSelect capability="image" config={config} value={settings.characterImageModel} onChange={(v) => patch("characterImageModel", v)} /></Field>
                    <Field label="道具"><ModelSelect capability="image" config={config} value={settings.propImageModel} onChange={(v) => patch("propImageModel", v)} /></Field>
                    <Field label="场景"><ModelSelect capability="image" config={config} value={settings.sceneImageModel} onChange={(v) => patch("sceneImageModel", v)} /></Field>
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
                    <Field label="默认参考图方案" hint="AssetSchemePicker">
                        <select value={settings.referenceLayout} disabled={layoutApplying}
                            onChange={(e) => { patch("referenceLayout", e.target.value); setLayoutNote(""); }}
                            data-studio-reference-layout
                            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50">
                            <option value="auto">按资产类型自动匹配（auto）</option>
                            {ASSET_SCHEME_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.name} · {option.description}</option>
                            ))}
                        </select>
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

                <Section marker="redo-guide" icon={<ImageIcon className="size-4" />} title="重做参考图（手动）" desc="本地没有「按当前方案一键重做参考图」的后端能力；这里只把对应分类的设定定位到资产库，由你在画布里手动重新生成并采用。">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        上方已保存当前方案（画风 / 模型 / 默认参考图方案）。点下方按钮会跳到项目资产库并预选对应设定；到设定详情点「生成参考图」，在画布生成后采用写回。不会自动重做，也不会覆盖未确认的旧图。
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
                    <p className="mt-1.5 text-[10px] text-muted-foreground">这里只做定位跳转；真正的重做与采用在画布完成，旧版本保留在设定详情的版本记录中。</p>
                </Section>

                <Section marker="continuity" icon={<Rows3 className="size-4" />} title="段落衔接" desc="尾帧续接：第2段起用上段尾帧做首帧、依次衔接；并行出片：各段只按参考图独立成片、不带尾帧首帧。保存后撰写段提示词真实生效。">
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

                <Section icon={<Gauge className="size-4" />} title="同时生成数" desc="文字/段视频/成片合成三池并发真实下发后端流水线（成片合成对应后端 render 池）；排队顺序先按集号，同集内按成片→剧本→段提示词→段视频。参考图池由后端固定上限管理，无剧目级覆盖字段，不设假滑杆。">
                    {([["text", "文字"], ["video", "段视频"], ["assemble", "成片合成"]] as const).map(([key, label]) => (
                        <Field key={key} label={label}>
                            <input type="range" min={1} max={8} value={settings.concurrency[key]}
                                onChange={(e) => patch("concurrency", { ...settings.concurrency, [key]: Number(e.target.value) })}
                                className="flex-1" />
                            <span className="w-6 text-center tabular-nums">{settings.concurrency[key]}</span>
                        </Field>
                    ))}
                </Section>

                <Section icon={<SlidersHorizontal className="size-4" />} title="镜头节奏与表演" desc="五档节奏真实下发后端 storyboardRules.pacing；表演强度/运镜动感 1–10 档在手动「撰写段提示词」时映射成表演与运镜风格文字（全自动流水线沿用分镜规则软约束，不单独下发这两档）。">
                    <Field label="镜头节奏">
                        <div className="flex flex-1 gap-1">
                            {(["极快", "快", "标准", "舒缓", "慢"] as const).map((p) => (
                                <button key={p} type="button" onClick={() => patch("pacing", p)}
                                    className={cn("flex-1 rounded-md border py-1 text-[11px] transition", settings.pacing === p ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>{p}</button>
                            ))}
                        </div>
                    </Field>
                    <Field label="转场时长">
                        <input type="range" min={0} max={1000} step={50} value={settings.transitionMs}
                            onChange={(e) => patch("transitionMs", Number(e.target.value))} className="flex-1" data-studio-transition-ms />
                        <span className="w-14 text-right tabular-nums">{settings.transitionMs}ms</span>
                    </Field>
                    <p className="pl-28 text-[10px] leading-relaxed text-amber-600/90" data-studio-soft-hint="transition-ms">
                        软约束，影响拆镜提示词：写入 storyboardRules.transitionMs 作为转场描述要求，不改变成片的实际剪辑时长。
                    </p>
                    <Field label="表演强度"><input type="range" min={1} max={10} value={settings.performanceIntensity}
                        onChange={(e) => patch("performanceIntensity", Number(e.target.value))} className="flex-1" /><span className="w-6 text-center tabular-nums">{settings.performanceIntensity}</span></Field>
                    <Field label="运镜动感"><input type="range" min={1} max={10} value={settings.cameraDynamics}
                        onChange={(e) => patch("cameraDynamics", Number(e.target.value))} className="flex-1" /><span className="w-6 text-center tabular-nums">{settings.cameraDynamics}</span></Field>
                </Section>

                <Section icon={<FilmIcon />} title="视频" desc="剧情段视频模型（段级 selectedVideoModel）与剧目级分辨率。档位按短边像素，与画幅联动，启动视频段时真实写进每段 H3 出片参数（aspectRatio + megapixels）；「模型默认」不覆盖，由所选模型自定。">
                    <Field label="视频模型"><ModelSelect capability="video" config={config} value={settings.videoModel} onChange={(v) => patch("videoModel", v)} /></Field>
                    <Field label="提示词字数上限" hint="码点">
                        <input type="number" min={1} step={1} value={promptMaxCharsDraft}
                            onChange={(e) => setPromptMaxCharsDraft(e.target.value)}
                            onBlur={(e) => commitPromptMaxChars(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitPromptMaxChars((e.target as HTMLInputElement).value); }}
                            disabled={!settings.videoModel}
                            placeholder="8000（影策参考默认）"
                            aria-label="提示词字数上限"
                            data-studio-prompt-max-chars
                            className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary disabled:opacity-50" />
                        {registeredPromptMaxChars === undefined ? null : (
                            <span className="text-[10px] text-emerald-600">已登记 {registeredPromptMaxChars} 字</span>
                        )}
                    </Field>
                    <p className="pl-1 text-[10px] leading-relaxed text-muted-foreground" data-studio-prompt-max-chars-hint>
                        本地引擎实测未上报字数上限：留空 = 不启用硬上限（段提示词沿用软提醒）。填写后按码点硬校验、超限拒绝；8000 是影策视频模型参考默认值，不是本地模型实测值，请按模型实际能力登记。
                    </p>
                    {promptMaxCharsError ? <p className="text-xs text-destructive" role="alert" data-studio-prompt-max-chars-error>{promptMaxCharsError}</p> : null}
                    <Field label="分辨率" hint={modelDeclaredResolution ? `模型声明默认：${modelDeclaredResolution}` : "短边像素档位"}>
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

                <Section icon={<Sparkles className="size-4" />} title="钩子与悬念" desc="影策每集的 hook（开篇钩子）与 cliffhanger（结尾悬念）结构化字段。保存后「重新改编本集」会作为创作方向注入改编指令，真实影响剧本。">
                    <Field label="开篇钩子"><input value={settings.hook} onChange={(e) => patch("hook", e.target.value)} placeholder="前3秒如何抓住观众"
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" /></Field>
                    <Field label="结尾悬念"><input value={settings.cliffhanger} onChange={(e) => patch("cliffhanger", e.target.value)} placeholder="本集结尾留什么悬念"
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" /></Field>
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

                <Section icon={<FilmIcon />} title="样片模式" desc="影策以第1集为样片。开启后流水线把第1集视频设为审阅闸门：第1集成片需人工确认，才继续其余集；与下方审阅方式叠加。">
                    <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={settings.sampleMode} onChange={(e) => patch("sampleMode", e.target.checked)} className="size-3.5" />
                        启用样片模式（第1集作为样片）
                    </label>
                </Section>

                <Section icon={<Eye className="size-4" />} title="审阅方式" desc="影策 reviewMode：只在关键点打断你。保存后启动流水线时真实下发到服务端闸门（sample=第1集成片后确认 / every=每集视频前审阅 / auto=不打断）。">
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

                <Section icon={<ImageIcon className="size-4" />} title="每段最多参考图" desc="影策 referenceLimit：自动取参考图时的上限，人物优先；0 为按视频模型上限。保存后启动流水线真实下发后端（H3 契约硬上限内收窄）。">
                    <Field label="上限张数" hint="0 = 按模型上限">
                        <input type="number" min={0} max={20} step={1} value={settings.referenceLimit}
                            onChange={(e) => patch("referenceLimit", Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                            className="h-8 w-24 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                    </Field>
                    <p className="text-[10px] text-muted-foreground">超出的设定按文字描述生成，不附图；个别段可在剧情段弹窗手动指定。</p>
                </Section>

                <Section marker="visual-style" icon={<Sparkles className="size-4" />} title="视觉风格（表现形式 × 题材）" desc="照搬影策风格库：4 种表现形式 × 13 种题材派生统一画风。选满两轴即生成画风 prompt 并写回剧目 topic.artStyle（后端统一画风后缀会注入所有出图提示词）；也可在下方自由填写字符串，两种方式共用同一字段。">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="表现形式">
                            <select value={styleForm} disabled={!dramaId || styleSaving}
                                onChange={(e) => chooseStyleAxes(e.target.value as DramaStyleFormId | "", styleTheme)}
                                aria-label="表现形式" data-studio-style-form
                                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50">
                                <option value="">未选择（自由画风）</option>
                                {DRAMA_STYLE_FORMS.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}
                            </select>
                        </Field>
                        <Field label="题材">
                            <select value={styleTheme} disabled={!dramaId || styleSaving}
                                onChange={(e) => chooseStyleAxes(styleForm, e.target.value as DramaStyleThemeId | "")}
                                aria-label="题材" data-studio-style-theme
                                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50">
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
                            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary disabled:opacity-50" />
                        <button type="button" onClick={commitFreeArtStyle} disabled={!dramaId || styleSaving}
                            className="h-8 shrink-0 rounded-md border border-border px-3 text-xs text-foreground transition hover:bg-muted disabled:opacity-50">
                            {styleSaving ? "保存中…" : "保存画风"}
                        </button>
                    </div>
                    {styleError ? <p className="text-xs text-destructive" role="alert" data-studio-style-error>{styleError}</p> : null}
                </Section>

                <Section marker="work" icon={<BookOpen className="size-4" />} title="作品" desc="影策记为“开工时确定”，只读展示当前剧目的真实信息。">
                    <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                        <dt className="text-muted-foreground">剧目</dt><dd className="truncate">{studioInfo?.dramaName || "—"}</dd>
                        <dt className="text-muted-foreground">分集</dt><dd>{studioInfo ? `${studioInfo.episodeCount} 集` : "—"}</dd>
                        <dt className="text-muted-foreground">原文章节</dt><dd>{studioInfo ? `${studioInfo.chapterCount} 章` : "—"}</dd>
                        <dt className="text-muted-foreground">画幅</dt><dd title="本地资产参考图与成片统一横版（实测成片 864×480、资产 1936×1088，均为 16:9）">16:9（横版，资产与成片统一）</dd>
                        <dt className="text-muted-foreground">视觉风格</dt><dd className="truncate">{artStyle || <span className="text-muted-foreground">剧目规划未设置</span>}</dd>
                        <dt className="text-muted-foreground">对白语言</dt><dd>{dialogueLanguage || <span className="text-muted-foreground">剧目规划未设置</span>}
                            <span className="ml-1 text-[10px] text-muted-foreground/70">（可选：{TOPIC_OPTIONS.language.join(" / ")}）</span></dd>
                    </dl>
                </Section>

                <Section icon={<FilmIcon />} title="分集方式" desc="按章分集为本地确定性拆章；模型自动分集由文本模型按剧情拆/并章，分批推进（每批 ≤12 章 / 30000 字），完成锁定后不可再改。">
                    {planLocked ? (
                        <p className="mb-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700" data-episode-plan-locked>
                            分集已完成（游标到第 {studioInfo?.lastChapterIndex ?? 0} 章），分集方式与分集结果均已锁定，不能再修改。
                        </p>
                    ) : null}
                    <div className="flex flex-wrap gap-4">
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                            <input type="radio" name="studio-episode-mode" className="size-3.5" checked={episodeMode === "chapter"} onChange={() => void changeEpisodeMode("chapter")} disabled={!dramaId || groupingBusy || planLocked} />
                            按章分集
                        </label>
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                            <input type="radio" name="studio-episode-mode" className="size-3.5" checked={episodeMode === "auto"} onChange={() => void changeEpisodeMode("auto")} disabled={!dramaId || groupingBusy || planLocked} />
                            模型自动分集
                        </label>
                    </div>
                    {episodeMode === "chapter" ? (
                        <p className="mt-2 text-xs leading-relaxed">
                            {studioInfo
                                ? <>按章分集 · {studioInfo.perEpisode > 1 ? `每 ${studioInfo.perEpisode} 章一集` : "每章一集"} · 共 {studioInfo.chapterCount} 章 {studioInfo.episodeCount} 集{studioInfo.excludedCount ? ` · ${studioInfo.excludedCount} 章预留` : ""}</>
                                : "已分集"}
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

                <div className="pb-4 text-center">
                    <button type="button" onClick={onSave} disabled={!dramaId || saving}
                        className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-5 text-xs font-medium text-background! hover:opacity-90 disabled:opacity-50">
                        <Save className="size-3.5" /> {saving ? "保存中…" : "保存全部设置"}
                    </button>
                    <p className="mt-2 text-[10px] text-muted-foreground">保存后按剧目隔离；模型/画幅等本地已有项由真实数据提供。</p>
                </div>
            </div>
        </div>
    );
}

function FilmIcon() {
    return <Film className="size-4" />;
}
