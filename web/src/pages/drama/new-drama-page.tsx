import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { App, Button, Checkbox, Input, InputNumber, Switch } from "antd";
import {
    AlertTriangle,
    ArrowLeft,
    BookOpenText,
    ClipboardPaste,
    FileText,
    FileUp,
    Play,
    Plus,
    Save,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { dramaProductionPlanSchema, type DramaProductionPlan, type DramaTopic } from "@basketikun/canvas-agent/drama/production-contract";
import { MAX_CHAPTERS_PER_EPISODE, EPISODE_SOURCE_CHARS } from "@basketikun/canvas-agent/drama/chapter-episodes";
import { ASSET_SCHEMES } from "@basketikun/canvas-agent/drama/asset-spec";
import { chaptersFromAnalysis, estimateProductionTasks, formatSeconds, NOVEL_MAX_CHARS, NOVEL_MIN_CHARS } from "@/lib/drama/adapt";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/use-config-store";
import {
    BAND_TICK_VALUES,
    CAMERA_BANDS_DETAIL,
    CAMERA_BANDS_LABEL,
    DEFAULT_STUDIO_SETTINGS,
    DIALOGUE_DETAIL,
    DIALOGUE_LABEL,
    EPISODE_PRESETS,
    MAX_EPISODE_SECONDS,
    MAX_SEGMENT_SECONDS,
    MAX_TRANSITION_MS,
    MIN_EPISODE_SECONDS,
    MIN_SEGMENT_SECONDS,
    MIN_TRANSITION_MS,
    ModelSelect,
    PACING_DETAIL,
    PACING_LABEL,
    PERFORMANCE_BANDS_DETAIL,
    PERFORMANCE_BANDS_LABEL,
    SEGMENT_MODE_DETAIL,
    SEGMENT_MODE_LABEL,
    STUDIO_THINKING_OPTIONS,
    TRANSITION_DETAIL,
    TRANSITION_LABEL,
    VIDEO_RESOLUTION_OPTIONS,
    clampRange,
    formatEpisodeSeconds,
    levelBandIndex,
    parseEpisodeSeconds,
    resolveStudioSettings,
    type StudioProductionSettings,
} from "@/pages/drama-studio/studio-settings-store";
import { SkillPickerField } from "@/pages/drama-studio/studio-skill-picker";
import { createDramaProject, type DramaCreationSession } from "./create-drama-project";
import { clearNewDramaDraft, readNewDramaDraft, newDramaDraftHasContent, writeNewDramaDraft, type NewDramaStyleMode } from "./new-drama-draft";
import { TOPIC_DEFAULTS, TOPIC_OPTIONS, toggleThemes, toggleValue } from "./planning-topic-logic";
import type { DirectorReviewPolicy } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 新建短剧整页：形态逐段对照影策 `app/web/src/pages/projects/create.tsx`
 * （首屏 hero → 选择文件后的表单页），数值对照 `drama.css` 的
 * `.drama-compose-*` / `.drama-drop*` / `.drama-media-mode*` / `.drama-review-mode*` /
 * `.drama-section-title` / `.drama-ratio` / `.drama-cfg-*`：字号 22/16/14/11/10，
 * 圆角 16/12/8，主栏 20px 28px 28px、区块间距 28px，卡片 padding 8px 12px。
 *
 * 每一段都接本地真值，不发明字段：
 * - 文字步骤：字段与制作台「制作设置 · 文字步骤」完全同一份（studio-settings-store 的
 *   planModel / assetExtractModel / storyboardModel / videoPromptModel + textThinking + textSkills），
 *   技能选择器就是设置页的 SkillPickerField；创建成功后写进该剧目设置，设置页读到的是同一份。
 *   影策的「分集规划」是只读行（跟默认模型 + 内置分集规则），这里同样只给思考等级；
 *   另有「大纲与剧本」行用 plan.outlineModel（大纲/剧本生成的模型，本地契约只有模型字段）。
 * - 参考图：画风锚点（styleMode）→ 建画风母图节点；按资产类型的图片模型用 plan.imageModelsByKind
 *   （契约 5 类：character/scene/prop/keyframe/style，后端 productionImageModel 按类型取）；
 *   分辨率 1k/2k/4k、参考图方案、每段最多参考图来自设置页同一份设置。
 * - 分镜规则：单集时长（秒）、剧情段切分与秒数、镜头节奏、对白密度、表演强度、运镜动感、转场、
 *   转场时长都写进 storyboardRules 真实下发；生成分镜图（plan.storyboardImageMode）、
 *   并行出片（plan.parallelScenes）、段落衔接（continuationMode）也是真值。
 * - 审阅方式：产物审核三档（settings.reviewMode = 影策 REVIEW_MODES sample/every/auto，
 *   启动流水线时下发服务端闸门）、导演审核点（plan.reviewPolicy，创建时写进每集制作稿）、
 *   生成节奏三档（plan.mediaProductionMode，后端导演工作流的真实初始值）。
 * - 制作模型：视频模型（plan.h3Model + settings.videoModel）、画幅、视频分辨率、预算上限、
 *   背景音乐、同时生成数，全部是本地真实下发字段。
 *
 * 本地契约确实没有、因此不渲染的：影策的资产方案提示词模板正文（新建页没有资产卡上下文，
 * 模板在设置页编辑）、预算以外的积分单价（本地无报价接口）、影策的「先看样片」以外的
 * 媒体放行开关（mediaMode 与 mediaProductionMode 是两个开关，创建页只给后者）。
 *
 * 业务行为不变：草稿自动保存/恢复沿用 new-drama-draft（localforage，连同制作设置一起存），
 * 原文解析/分集用 lib/drama/adapt 同一套拆章，创建提交走 create-drama-project 里搬过来的原调用链。
 */

type SourceFormat = "novel" | "script" | "storyboard";
type TextStepKey = "outline" | "plan" | "extract" | "storyboard" | "prompt";

const SOURCE_FORMATS: Array<{ value: SourceFormat; titleKey: string; detailKey: string }> = [
    { value: "novel", titleKey: "newDrama.page.formatNovel", detailKey: "newDrama.page.formatNovelDetail" },
    { value: "script", titleKey: "newDrama.page.formatScript", detailKey: "newDrama.page.formatScriptDetail" },
    { value: "storyboard", titleKey: "newDrama.page.formatStoryboard", detailKey: "newDrama.page.formatStoryboardDetail" },
];

const RATIOS = [
    { value: "9:16", labelKey: "newDrama.page.ratio916", w: 9, h: 16 },
    { value: "16:9", labelKey: "newDrama.page.ratio169", w: 16, h: 9 },
    { value: "1:1", labelKey: "newDrama.page.ratio11", w: 12, h: 12 },
];
/** 影策 REVIEW_MODES：三档产物审核，真实下发后端流水线闸门。 */
const REVIEW_MODES: Array<{ value: StudioProductionSettings["reviewMode"]; titleKey: string; detailKey: string }> = [
    { value: "sample", titleKey: "newDrama.page.reviewSample", detailKey: "newDrama.page.reviewSampleDetail" },
    { value: "every", titleKey: "newDrama.page.reviewEvery", detailKey: "newDrama.page.reviewEveryDetail" },
    { value: "auto", titleKey: "newDrama.page.reviewAuto", detailKey: "newDrama.page.reviewAutoDetail" },
];
/** 导演审核点预设：本地 schema 还有 mixed，需逐审核点单独设置，创建页只给整体三档。 */
const REVIEW_POLICY_MODES: Array<{ value: DirectorReviewPolicy["mode"]; titleKey: string; detailKey: string }> = [
    { value: "none", titleKey: "newDrama.pacing.reviewNone", detailKey: "newDrama.page.reviewNoneDetail" },
    { value: "automatic", titleKey: "newDrama.pacing.reviewAuto", detailKey: "newDrama.page.reviewPacingAutoDetail" },
    { value: "manual", titleKey: "newDrama.pacing.reviewManual", detailKey: "newDrama.page.reviewPacingManualDetail" },
];
const IMAGE_MODEL_KINDS = ["character", "scene", "prop", "keyframe", "style"] as const;

/** 文字步骤行：与制作台「制作设置 · 文字步骤」一一对应（模型 + 思考等级 + 技能各一份真值）。 */
const TEXT_STEPS: Array<{ key: Exclude<TextStepKey, "outline">; labelKey: string; hintKey: string }> = [
    { key: "plan", labelKey: "newDrama.page.textStep.plan", hintKey: "newDrama.page.textStepHint.plan" },
    { key: "extract", labelKey: "newDrama.page.textStep.extract", hintKey: "newDrama.page.textStepHint.extract" },
    { key: "storyboard", labelKey: "newDrama.page.textStep.storyboard", hintKey: "newDrama.page.textStepHint.storyboard" },
    { key: "prompt", labelKey: "newDrama.page.textStep.prompt", hintKey: "newDrama.page.textStepHint.prompt" },
];
/** 文字步骤 → 制作设置里的模型字段（与设置页同一份）。 */
const STEP_MODEL_FIELD = {
    plan: "planModel",
    extract: "assetExtractModel",
    storyboard: "storyboardModel",
    prompt: "videoPromptModel",
} as const;

/** 章节列表一次最多画多少行；更长的书用全选/清空处理。 */
const CHAPTER_LIST_LIMIT = 200;

function reviewPolicyFor(mode: DirectorReviewPolicy["mode"]): DirectorReviewPolicy {
    if (mode === "automatic") return { mode: "automatic", shared: "automatic", scene: "automatic" };
    if (mode === "manual") return { mode: "manual", shared: "manual", scene: "manual" };
    return { mode: "none", shared: "none", scene: "none" };
}

export default function NewDramaPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { message } = App.useApp();
    const modelConfig = useConfigStore((state) => state.config);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [ready, setReady] = useState(false);
    const [restoredAt, setRestoredAt] = useState("");
    const [name, setName] = useState("");
    const [plan, setPlan] = useState<DramaProductionPlan>(() => dramaProductionPlanSchema.parse({}));
    // 制作设置（文字步骤 / 参考图 / 分镜规则 / 审阅与生成节奏）：与制作台「制作设置」同一份字段，
    // 创建成功后写进该剧目，设置页读到的是同一份（见 create-drama-project）。
    const [studio, setStudio] = useState<StudioProductionSettings>(() => resolveStudioSettings(undefined));
    const [styleMode, setStyleMode] = useState<NewDramaStyleMode>("none");
    const [styleImageFile, setStyleImageFile] = useState<File>();
    const [stylePrompt, setStylePrompt] = useState("");
    const [autoEpisodes, setAutoEpisodes] = useState(true);
    const [handoff, setHandoff] = useState(true);
    const [sourceFormat, setSourceFormat] = useState<SourceFormat>("novel");
    const [showHero, setShowHero] = useState(true);
    const [pasteMode, setPasteMode] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const [dragOver, setDragOver] = useState(false);
    const [previewIndex, setPreviewIndex] = useState(1);
    const [episodeSecondsDraft, setEpisodeSecondsDraft] = useState(String(DEFAULT_STUDIO_SETTINGS.episodeSeconds));
    const [episodeSecondsError, setEpisodeSecondsError] = useState("");
    const [creating, setCreating] = useState(false);
    const sessionRef = useRef<DramaCreationSession | undefined>(undefined);

    const resetToBlank = () => {
        const blank = dramaProductionPlanSchema.parse({});
        setName(t("drama.defaultProjectName"));
        setPlan({ ...blank, topic: { ...blank.topic, ...TOPIC_DEFAULTS, tones: [...TOPIC_DEFAULTS.tones] } });
        setStudio(resolveStudioSettings(undefined));
        setStyleMode("none");
        setStyleImageFile(undefined);
        setStylePrompt("");
        setAutoEpisodes(true);
        setHandoff(true);
        setShowHero(true);
        setPasteText("");
        setRestoredAt("");
        setPreviewIndex(1);
        sessionRef.current = undefined;
    };

    // 打开页面：有未填完的草稿就整份回填（上传的风格图是 File，跨会话留不住，回来重选）。
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const restored = await readNewDramaDraft().catch(() => null);
            if (cancelled) return;
            if (restored && newDramaDraftHasContent(restored)) {
                setName(restored.name);
                setPlan(restored.plan);
                setStudio(resolveStudioSettings(restored.studio));
                setEpisodeSecondsDraft(String(resolveStudioSettings(restored.studio).episodeSeconds));
                setStyleMode(restored.styleMode);
                setStylePrompt(restored.stylePrompt);
                setAutoEpisodes(restored.autoEpisodes);
                setHandoff(restored.handoff);
                setShowHero(!String(restored.plan.sourceScript || "").trim());
                setRestoredAt(restored.savedAt);
            } else {
                const blank = dramaProductionPlanSchema.parse({});
                setName(t("drama.defaultProjectName"));
                setPlan({ ...blank, topic: { ...blank.topic, ...TOPIC_DEFAULTS, tones: [...TOPIC_DEFAULTS.tones] } });
                setStudio(resolveStudioSettings(undefined));
                setStyleMode("none");
            }
            setReady(true);
        })();
        return () => { cancelled = true; };
    }, [t]);

    const source = plan.sourceScript || "";
    const split = plan.sourceSplit ?? { excluded: [], perEpisode: 1, maxChars: 0 };
    const chapterMode = plan.episodeMode !== "auto";
    // 原文只在文本变化时切一次；勾选、每集章数是廉价派生。
    const analysis = useMemo(
        () => (source.trim() ? analyzeNovelChapters(source, { maxChars: split.maxChars || NOVEL_MAX_CHARS, minChars: NOVEL_MIN_CHARS }) : null),
        [source, split.maxChars],
    );
    const excludedKey = split.excluded.join(",");
    const { rows, groups } = useMemo(
        () => chaptersFromAnalysis(analysis, { excluded: split.excluded, perEpisode: split.perEpisode }),
        [analysis, excludedKey, split.perEpisode], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const estimate = useMemo(() => estimateProductionTasks(groups), [groups]);
    const selectedRows = rows.filter((row) => row.selected);
    const selectedCount = selectedRows.length;
    const selectedWords = selectedRows.reduce((sum, row) => sum + row.body.length, 0);
    const blockedGroup = groups.find((group) => group.oversized);
    const previewRow = rows.find((row) => row.index === previewIndex) || rows[0];
    const reservedCount = rows.length - selectedCount;

    // 章数变化（换素材/重新拆章）后预览位置回到第一章，不指到已不存在的章上。
    useEffect(() => {
        if (!rows.length) return;
        if (!rows.some((row) => row.index === previewIndex)) setPreviewIndex(rows[0].index);
    }, [rows, previewIndex]);

    // 草稿自动保存：与旧弹窗「关掉不丢」同语义，整页改成停笔 700ms 就存，离开页面也不丢。
    const step = source.trim() ? 1 : 0;
    useEffect(() => {
        if (!ready) return;
        const draft = { name, plan, studio, styleMode, stylePrompt, autoEpisodes, handoff, step };
        const timer = window.setTimeout(() => {
            if (newDramaDraftHasContent(draft)) void writeNewDramaDraft(draft);
            else void clearNewDramaDraft();
        }, 700);
        return () => window.clearTimeout(timer);
    }, [ready, name, plan, studio, styleMode, stylePrompt, autoEpisodes, handoff, step]);

    const patchPlan = (patch: Partial<DramaProductionPlan> | ((current: DramaProductionPlan) => DramaProductionPlan)) =>
        setPlan((current) => (typeof patch === "function" ? patch(current) : { ...current, ...patch }));
    const patchStudio = (patch: Partial<StudioProductionSettings>) => setStudio((current) => ({ ...current, ...patch }));
    const stepModel = (key: Exclude<TextStepKey, "outline">) => studio[STEP_MODEL_FIELD[key]] || "";
    const setStepModel = (key: Exclude<TextStepKey, "outline">, value: string) =>
        setStudio((current) => ({ ...current, [STEP_MODEL_FIELD[key]]: value }) as StudioProductionSettings);
    const setStepThinking = (key: Exclude<TextStepKey, "outline">, value: StudioProductionSettings["textThinking"]["plan"]) =>
        patchStudio({ textThinking: { ...studio.textThinking, [key]: value } });
    const setStepSkill = (key: Exclude<TextStepKey, "outline">, ref: StudioProductionSettings["textSkills"]["plan"]) =>
        patchStudio({ textSkills: { ...studio.textSkills, [key]: ref } });
    // 单集时长（秒）可输入「90 / 5分钟 / 2:30」，提交前收敛到 30–1200 秒，越界就地提示。
    const commitEpisodeSeconds = (raw: string) => {
        const parsed = parseEpisodeSeconds(raw);
        if (parsed === null) {
            setEpisodeSecondsError(t("newDrama.page.episodeSecondsError"));
            return;
        }
        const clamped = Math.max(MIN_EPISODE_SECONDS, Math.min(MAX_EPISODE_SECONDS, parsed));
        setEpisodeSecondsError(clamped === parsed ? "" : t("newDrama.page.episodeSecondsRange", { min: MIN_EPISODE_SECONDS, max: MAX_EPISODE_SECONDS }));
        patchStudio({ episodeSeconds: clamped });
        setEpisodeSecondsDraft(String(clamped));
    };
    const setTopic = (patch: Partial<DramaTopic> | ((current: DramaTopic) => Partial<DramaTopic>)) =>
        patchPlan((current) => {
            const topic = current.topic;
            return { ...current, topic: { ...topic, ...(typeof patch === "function" ? patch(topic) : patch) } };
        });
    const patchSplit = (patch: Partial<{ excluded: number[]; perEpisode: number; maxChars: number }>) =>
        patchPlan((current) => ({ ...current, sourceSplit: { ...(current.sourceSplit ?? { excluded: [], perEpisode: 1, maxChars: 0 }), ...patch } }));
    const setChapterSelected = (index: number, selected: boolean) => {
        const excluded = new Set(split.excluded);
        if (selected) excluded.delete(index);
        else excluded.add(index);
        patchSplit({ excluded: [...excluded].sort((left, right) => left - right) });
    };
    const selectAllChapters = (selected: boolean) => patchSplit({ excluded: selected ? [] : rows.map((row) => row.index) });

    const acceptText = (text: string, fileName?: string) => {
        const clean = text.replace(/^\uFEFF/, "").trim();
        const splitResult = clean ? analyzeNovelChapters(clean, { maxChars: NOVEL_MAX_CHARS, minChars: NOVEL_MIN_CHARS }) : null;
        if (!clean || !splitResult?.chapters.length) {
            message.warning(t("newDrama.page.sourceEmpty"));
            return;
        }
        patchPlan({ sourceScript: clean });
        setShowHero(false);
        setRestoredAt("");
        sessionRef.current = undefined;
        const currentName = name.trim();
        const placeholder = t("drama.defaultProjectName");
        if (fileName) {
            const title = fileName.replace(/\.(txt|md|markdown)$/i, "").trim();
            if (title && (!currentName || currentName === placeholder)) setName(title.slice(0, 80));
        } else if (!currentName || currentName === placeholder) {
            const first = splitResult.chapters[0]?.title?.slice(0, 20);
            if (first) setName(first);
        }
    };
    const loadFile = async (file: File) => {
        try {
            let text = await file.text();
            // GBK 兜底：UTF-8 解码出现替换符时用 GBK 再解码（与旧入口一致）。
            if (text.includes("\uFFFD")) {
                try { text = new TextDecoder("gbk").decode(await file.arrayBuffer()); } catch { /* 保持 UTF-8 */ }
            }
            acceptText(text, file.name);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };
    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void loadFile(file);
    };

    const styleReady = styleMode === "none" || (styleMode === "upload" ? Boolean(styleImageFile) : Boolean(stylePrompt.trim()));
    const canCreate = Boolean(name.trim() && selectedCount && styleReady && !blockedGroup) && !creating;
    const blockedHint = !name.trim()
        ? t("newDrama.page.blockedName")
        : !styleReady
            ? t("newDrama.page.blockedStyle")
            : !selectedCount
                ? t("newDrama.page.blockedEmpty")
                : blockedGroup
                    ? t("newDrama.split.oversize", { label: blockedGroup.label, chars: blockedGroup.chars, limit: EPISODE_SOURCE_CHARS })
                    : "";

    const saveDraft = async () => {
        await writeNewDramaDraft({ name, plan, studio, styleMode, stylePrompt, autoEpisodes, handoff, step });
        message.success(t("newDrama.page.draftSaved"));
    };
    const discardDraft = () => {
        void clearNewDramaDraft();
        resetToBlank();
    };
    const create = async () => {
        if (!canCreate) return;
        setCreating(true);
        try {
            // 把「参考图」段按类型的图片模型与视频模型同步到制作设置：设置页看到的就是同一选择。
            const studioSettings: StudioProductionSettings = {
                ...studio,
                characterImageModel: plan.imageModelsByKind?.character || "",
                propImageModel: plan.imageModelsByKind?.prop || "",
                sceneImageModel: plan.imageModelsByKind?.scene || "",
                videoModel: plan.h3Model || "",
                videoAspectRatio: plan.videoAspectRatio === "9:16" ? "9:16" : "16:9",
                reviewPolicy: plan.reviewPolicy,
            };
            const result = await createDramaProject({
                name: name.trim(),
                plan,
                studioSettings,
                styleMode,
                styleImageFile,
                stylePrompt,
                autoEpisodes,
                handoff,
                search: searchParams.toString(),
                t,
                message,
                session: sessionRef,
            });
            sessionRef.current = undefined;
            void clearNewDramaDraft();
            navigate(result.destination);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setCreating(false);
        }
    };

    const header = (
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 pr-3">
            <button
                type="button"
                aria-label={t("newDrama.page.back")}
                title={t("newDrama.page.back")}
                onClick={() => navigate("/drama-studio")}
                className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
                <ArrowLeft className="size-4" />
            </button>
            <h1 className="shrink-0 text-[22px] font-semibold leading-none">{showHero || !source.trim() ? t("newDrama.page.title") : restoredAt ? t("newDrama.page.editDraft") : t("newDrama.page.title")}</h1>
            {!showHero && source.trim() ? (
                <>
                    <Input
                        aria-label={t("newDrama.page.name")}
                        className="ml-auto min-w-0 max-w-[320px] flex-1"
                        value={name}
                        maxLength={80}
                        placeholder={t("newDrama.page.name")}
                        onChange={(event) => setName(event.target.value)}
                    />
                    <Button size="small" type="text" onClick={() => setShowHero(true)}>{t("newDrama.page.changeMaterial")}</Button>
                </>
            ) : null}
        </header>
    );

    if (!ready) {
        return (
            <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
                {header}
                <div className="grid flex-1 place-items-center text-sm text-muted-foreground">{t("newDrama.page.loading")}</div>
            </div>
        );
    }

    if (showHero || !source.trim()) {
        return (
            <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
                {header}
                <div className="mx-auto flex w-full max-w-[980px] flex-1 flex-col px-4 pb-4">
                    <div className="mx-auto mb-3 grid w-full max-w-[860px] gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("newDrama.page.materialType")}>
                        {SOURCE_FORMATS.map((format) => (
                            <ModeCard
                                key={format.value}
                                data-format={format.value}
                                checked={sourceFormat === format.value}
                                onClick={() => setSourceFormat(format.value)}
                                title={t(format.titleKey)}
                                desc={t(format.detailKey)}
                            />
                        ))}
                    </div>
                    <div
                        data-new-drama-hero
                        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={onDrop}
                        className={cn(
                            "flex min-h-[360px] flex-1 flex-col items-center justify-center gap-4 rounded-[16px] border-[1.5px] border-dashed px-6 py-10 text-center transition",
                            dragOver ? "border-primary bg-primary/5" : "border-border bg-card/30",
                        )}
                    >
                        {pasteMode ? (
                            <div className="grid w-full max-w-[860px] gap-3">
                                <Input.TextArea
                                    autoFocus
                                    value={pasteText}
                                    onChange={(event) => setPasteText(event.target.value)}
                                    autoSize={{ minRows: 14, maxRows: 24 }}
                                    placeholder={t("newDrama.page.pastePlaceholder")}
                                />
                                <div className="flex justify-end gap-2">
                                    <Button onClick={() => setPasteMode(false)}>{t("common.cancel")}</Button>
                                    <Button type="primary" disabled={!pasteText.trim()} onClick={() => acceptText(pasteText)} data-new-drama-parse>
                                        {t("newDrama.page.parse")}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <span className="grid size-[72px] place-items-center rounded-[16px] bg-card text-primary shadow-md">
                                    <BookOpenText className="size-7" />
                                </span>
                                <h2 className="text-[22px] font-semibold leading-tight">{t("newDrama.page.heroTitle", { format: t(SOURCE_FORMATS.find((item) => item.value === sourceFormat)!.titleKey) })}</h2>
                                <p className="max-w-[560px] text-[14px] leading-[1.7] text-muted-foreground">{t("newDrama.page.heroHint")}</p>
                                <Button type="primary" size="large" icon={<FileUp className="size-4" />} onClick={() => fileInputRef.current?.click()}>
                                    {t("newDrama.page.chooseFile", { format: t(SOURCE_FORMATS.find((item) => item.value === sourceFormat)!.titleKey) })}
                                </Button>
                                <button type="button" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline" onClick={() => setPasteMode(true)}>
                                    <ClipboardPaste className="size-3.5" /> {t("newDrama.page.pasteLink")}
                                </button>
                                <div data-new-drama-steps className="mt-4 flex flex-wrap justify-center gap-2">
                                    {[
                                        sourceFormat === "storyboard" ? "newDrama.page.heroStep1Storyboard" : "newDrama.page.heroStep1",
                                        "newDrama.page.heroStep2",
                                        sourceFormat === "novel" ? "newDrama.page.heroStep3" : "newDrama.page.heroStep3Alt",
                                        "newDrama.page.heroStep4",
                                        "newDrama.page.heroStep5",
                                    ].map((key, index) => (
                                        <span key={key} className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card pl-2 pr-4 text-[11px] text-muted-foreground">
                                            <b className="grid size-5 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{index + 1}</b>
                                            {t(key)}
                                        </span>
                                    ))}
                                </div>
                                {source.trim() ? (
                                    <button type="button" className="text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={() => setShowHero(false)}>
                                        {t("newDrama.page.cancelChangeMaterial")}
                                    </button>
                                ) : null}
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".txt,.md,.markdown,text/plain,text/markdown"
                                    className="hidden"
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        if (file) void loadFile(file);
                                        event.target.value = "";
                                    }}
                                />
                            </>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
            {header}
            <div className="flex min-h-0 flex-1">
                {/* 左：章节选择（影策 .drama-compose-novel） */}
                <aside className="hidden w-[260px] shrink-0 flex-col border-r border-border bg-muted/20 md:flex xl:w-[300px]" data-new-drama-chapters-pane>
                    <div className="grid grid-cols-3 border-b border-border">
                        <Stat value={String(selectedCount)} label={t("newDrama.page.selectedChapters")} />
                        <Stat value={String(selectedWords)} label={t("newDrama.page.chars")} bordered />
                        <Stat value={String(groups.length)} label={t("newDrama.page.episodes")} bordered />
                    </div>
                    {blockedGroup ? (
                        <div className="flex gap-2 border-b border-border px-4 py-2 text-[10px] leading-[1.5] text-[var(--status-error)]" role="alert">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                            {t("newDrama.split.oversize", { label: blockedGroup.label, chars: blockedGroup.chars, limit: EPISODE_SOURCE_CHARS })}
                        </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-3 py-2 text-[10px] text-muted-foreground">
                        <span data-new-drama-chapter-count>{t("newDrama.split.count", { total: rows.length, selected: selectedCount })}</span>
                        <span className="ml-auto inline-flex items-center">
                            <Button size="small" type="text" onClick={() => selectAllChapters(true)} data-new-drama-select-all>{t("newDrama.split.all")}</Button>
                            <Button size="small" type="text" onClick={() => selectAllChapters(false)} data-new-drama-select-none>{t("newDrama.split.none")}</Button>
                        </span>
                    </div>
                    <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-2" data-new-drama-chapters>
                        {rows.slice(0, CHAPTER_LIST_LIMIT).map((row) => (
                            <div
                                key={row.index}
                                data-new-drama-chapter-row={row.index}
                                className={cn(
                                    "grid h-[34px] grid-cols-[22px_28px_minmax(0,1fr)_auto] items-center gap-2 rounded-[8px] px-1.5 text-[11px]",
                                    previewRow?.index === row.index ? "bg-card text-foreground shadow-sm" : "text-foreground/80 hover:bg-muted/60",
                                    !row.selected && "text-muted-foreground",
                                )}
                            >
                                <Checkbox checked={row.selected} aria-label={row.title} onChange={(event) => setChapterSelected(row.index, event.target.checked)} />
                                <span className="tabular-nums text-[10px] text-foreground/40">{String(row.index).padStart(2, "0")}</span>
                                <button type="button" className="min-w-0 truncate text-left" title={row.title} onClick={() => setPreviewIndex(row.index)}>{row.title}</button>
                                <span className={cn("shrink-0 tabular-nums text-[10px]", row.body.length > EPISODE_SOURCE_CHARS ? "text-amber-600 dark:text-amber-500" : "text-foreground/40")}>
                                    {t("newDrama.split.chapterChars", { count: row.body.length })}
                                </span>
                            </div>
                        ))}
                    </div>
                    {rows.length > CHAPTER_LIST_LIMIT ? (
                        <p className="border-t border-border px-3 py-2 text-[10px] leading-[1.5] text-muted-foreground">{t("newDrama.split.truncated", { count: rows.length - CHAPTER_LIST_LIMIT })}</p>
                    ) : null}
                    <p className="border-t border-border px-4 py-2 text-[10px] leading-[1.55] text-muted-foreground">
                        {reservedCount
                            ? t("newDrama.page.reservedNote", { count: reservedCount })
                            : t("newDrama.page.allSelectedNote")}
                    </p>
                </aside>

                {/* 中：表单（影策 .drama-compose-main） */}
                <main className="thin-scrollbar min-w-0 flex-1 overflow-y-auto px-7 pb-7 pt-5">
                    <div className="mx-auto grid max-w-[980px] gap-7">
                        {restoredAt ? (
                            <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-primary/25 bg-primary/[0.04] px-3 py-2 text-[11px] text-muted-foreground" data-new-drama-draft>
                                <span>{t("newDrama.draftRestored")}</span>
                                <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={discardDraft}>{t("newDrama.draftDiscard")}</button>
                            </div>
                        ) : null}

                        <Section id="material" title={t("newDrama.page.material")} aside={t("newDrama.page.materialHint")}>
                            <FieldLabel label={t("newDrama.page.materialType")} />
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("newDrama.page.materialType")}>
                                {SOURCE_FORMATS.map((format) => (
                                    <ModeCard key={format.value} data-format={format.value} checked={sourceFormat === format.value} onClick={() => setSourceFormat(format.value)} title={t(format.titleKey)} desc={t(format.detailKey)} />
                                ))}
                            </div>

                            <FieldLabel label={t("newDrama.page.episodeMode")} hint={t("newDrama.page.episodeModeHint")} />
                            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("newDrama.page.episodeMode")}>
                                <ModeCard
                                    data-episode-mode="chapter"
                                    checked={chapterMode}
                                    onClick={() => patchPlan({ episodeMode: "chapter" })}
                                    title={t("newDrama.page.modeChapter")}
                                    desc={t("newDrama.page.modeChapterDetail")}
                                    badge={t("newDrama.page.recommended")}
                                />
                                <ModeCard
                                    data-episode-mode="auto"
                                    checked={!chapterMode}
                                    onClick={() => patchPlan({ episodeMode: "auto" })}
                                    title={t("newDrama.page.modeAuto")}
                                    desc={t("newDrama.page.modeAutoDetail")}
                                />
                            </div>

                            {chapterMode ? (
                                <>
                                    <FieldLabel label={t("newDrama.split.perEpisode")} hint={t("newDrama.split.perEpisodeHint")} />
                                    <div className="flex flex-wrap items-center gap-2" data-new-drama-group-size>
                                        {[1, 2, 3, 4, 5, 8].map((count) => (
                                            <Chip key={count} numeric active={split.perEpisode === count} onClick={() => patchSplit({ perEpisode: count })}>{count}</Chip>
                                        ))}
                                        <InputNumber
                                            className="!w-[96px]"
                                            size="small"
                                            min={1}
                                            max={MAX_CHAPTERS_PER_EPISODE}
                                            placeholder={t("topic.custom")}
                                            aria-label={t("newDrama.split.perEpisode")}
                                            value={[1, 2, 3, 4, 5, 8].includes(split.perEpisode) ? null : split.perEpisode}
                                            onChange={(value) => patchSplit({ perEpisode: Math.min(MAX_CHAPTERS_PER_EPISODE, Math.max(1, Number(value) || 1)) })}
                                        />
                                    </div>
                                </>
                            ) : (
                                <p className="text-[10px] leading-[1.55] text-muted-foreground">{t("newDrama.page.autoModeNote")}</p>
                            )}
                        </Section>

                        <Section id="text" title={t("newDrama.page.textSteps")} aside={t("newDrama.page.textStepsHint")}>
                            <div className="grid gap-2" role="list" aria-label={t("newDrama.page.textSteps")}>
                                {TEXT_STEPS.map((row) => (
                                    <div
                                        key={row.key}
                                        role="listitem"
                                        data-new-drama-step={row.key}
                                        className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-[8px] border border-border bg-card px-3 py-2 lg:grid-cols-[120px_minmax(0,1fr)_96px_minmax(0,1.1fr)]"
                                    >
                                        <div className="min-w-0">
                                            <strong className="block text-[11px] font-semibold leading-[1.4]">{t(row.labelKey)}</strong>
                                            <span className="mt-0.5 block text-[10px] leading-[1.4] text-muted-foreground">{t(row.hintKey)}</span>
                                        </div>
                                        <div className="grid min-w-0 gap-0.5">
                                            <span className="text-[10px] text-muted-foreground">{t("newDrama.page.stepModel")}</span>
                                            <ModelSelect
                                                capability="text"
                                                config={modelConfig}
                                                value={stepModel(row.key)}
                                                marker={row.key}
                                                fallbackLabel={t("newDrama.page.stepFollowDefault")}
                                                onChange={(value) => setStepModel(row.key, value)}
                                            />
                                        </div>
                                        <div className="grid min-w-0 gap-0.5">
                                            <span className="text-[10px] text-muted-foreground">{t("newDrama.page.stepThinking")}</span>
                                            <select
                                                aria-label={`${t(row.labelKey)}${t("newDrama.page.stepThinking")}`}
                                                data-new-drama-thinking={row.key}
                                                value={studio.textThinking[row.key]}
                                                onChange={(event) => setStepThinking(row.key, event.target.value as StudioProductionSettings["textThinking"]["plan"])}
                                                className="h-[34px] w-full rounded-[12px] border border-border bg-card px-2 text-[11px] text-foreground outline-none focus:border-primary"
                                            >
                                                {STUDIO_THINKING_OPTIONS.map((option) => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="grid min-w-0 gap-0.5">
                                            <span className="text-[10px] text-muted-foreground">{t("newDrama.page.stepSkill")}</span>
                                            <div className="flex h-[34px] min-w-0 items-center" data-new-drama-skill={row.key}>
                                                <SkillPickerField step={row.key} value={studio.textSkills[row.key]} onChange={(ref) => setStepSkill(row.key, ref)} />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {/* 大纲与剧本：plan.outlineModel 是本地真实字段（大纲/剧本提案用它），
                                但本地契约只到模型这一层，没有思考档位与技能槽位，所以不出假控件。 */}
                            <FieldRow label={t("newDrama.page.textStep.outline")} hint={t("newDrama.page.textStepHint.outline")} marker="outlineModel">
                                <span className="min-w-0 flex-1 max-w-[520px]">
                                    <ModelSelect
                                        capability="text"
                                        config={modelConfig}
                                        marker="outline"
                                        value={plan.outlineModel || ""}
                                        fallbackLabel={t("newDrama.page.stepFollowSettings")}
                                        onChange={(value) => patchPlan({ outlineModel: value })}
                                    />
                                </span>
                            </FieldRow>
                        </Section>

                        <Section id="reference" title={t("newDrama.page.reference")} aside={t("newDrama.page.referenceHint")}>
                            <FieldLabel label={t("newDrama.page.styleAnchor")} />
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("newDrama.page.styleAnchor")}>
                                <ModeCard
                                    data-style-mode="none"
                                    checked={styleMode === "none"}
                                    onClick={() => setStyleMode("none")}
                                    title={t("newDrama.page.styleNone")}
                                    desc={t("newDrama.page.styleNoneDetail")}
                                />
                                <ModeCard
                                    data-style-mode="upload"
                                    checked={styleMode === "upload"}
                                    onClick={() => setStyleMode("upload")}
                                    title={t("newDrama.page.styleUpload")}
                                    desc={t("newDrama.page.styleUploadDetail")}
                                />
                                <ModeCard
                                    data-style-mode="prompt"
                                    checked={styleMode === "prompt"}
                                    onClick={() => setStyleMode("prompt")}
                                    title={t("newDrama.page.stylePrompt")}
                                    desc={t("newDrama.page.stylePromptDetail")}
                                />
                            </div>
                            {styleMode === "upload" ? (
                                <label className="flex cursor-pointer items-center gap-2 rounded-[8px] border border-dashed border-border px-3 py-3 text-[11px] text-muted-foreground transition hover:border-primary/40">
                                    <FileText className="size-4" />
                                    {styleImageFile ? styleImageFile.name : t("newDrama.pickStyleImage")}
                                    <input type="file" accept="image/*" className="hidden" onChange={(event) => setStyleImageFile(event.target.files?.[0])} />
                                </label>
                            ) : null}
                            {styleMode === "prompt" ? (
                                <Input.TextArea rows={3} value={stylePrompt} onChange={(event) => setStylePrompt(event.target.value)} placeholder={t("newDrama.page.stylePromptPlaceholder")} />
                            ) : null}

                            <div className="grid gap-2.5 rounded-[8px] border border-border bg-card px-3 py-2.5" data-new-drama-reference-kinds>
                                <FieldRow label={t("newDrama.page.referenceScheme")} marker={"referenceScheme"} hint={t("newDrama.page.referenceSchemeHint")}>
                                    <select
                                        aria-label={t("newDrama.page.referenceScheme")}
                                        data-new-drama-reference-layout
                                        value={studio.referenceLayout}
                                        onChange={(event) => patchStudio({ referenceLayout: event.target.value })}
                                        className="h-[34px] min-w-0 flex-1 max-w-[520px] rounded-[12px] border border-border bg-card px-3 text-[11px] text-foreground outline-none focus:border-primary"
                                    >
                                        <option value="auto">{t("newDrama.page.referenceSchemeAuto")}</option>
                                        {ASSET_SCHEMES.map((scheme) => (
                                            <option key={scheme.id} value={scheme.id}>{scheme.name}</option>
                                        ))}
                                    </select>
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.defaultImageModel")} marker={"defaultImageModel"} hint={t("newDrama.page.defaultImageModelHint")}>
                                    <span className="min-w-0 flex-1 max-w-[520px]">
                                        <ModelSelect
                                            capability="image"
                                            config={modelConfig}
                                            marker="image-default"
                                            value={plan.imageModel || ""}
                                            fallbackLabel={t("newDrama.page.stepFollowSettings")}
                                            onChange={(model) => patchPlan({ imageModel: model || "" })}
                                        />
                                    </span>
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.imageResolution")} marker={"imageResolution"} hint={t("newDrama.page.imageResolutionHint")}>
                                    {(["1k", "2k", "4k"] as const).map((resolution) => (
                                        <Chip key={resolution} numeric active={studio.imageResolution === resolution} onClick={() => patchStudio({ imageResolution: resolution })}>{resolution.toUpperCase()}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.referenceLimit")} marker={"referenceLimit"} hint={t("newDrama.page.referenceLimitHint")}>
                                    <InputNumber
                                        className="!w-[96px]"
                                        size="small"
                                        min={0}
                                        max={20}
                                        aria-label={t("newDrama.page.referenceLimit")}
                                        value={studio.referenceLimit}
                                        onChange={(value) => patchStudio({ referenceLimit: Math.max(0, Math.min(20, Number(value) || 0)) })}
                                    />
                                </FieldRow>
                                {IMAGE_MODEL_KINDS.map((kind) => (
                                    <FieldRow key={kind} label={t(`newDrama.page.imageKind.${kind}`)} marker={`kind-${kind}`}>
                                        <span className="min-w-0 flex-1 max-w-[520px]">
                                            <ModelSelect
                                                capability="image"
                                                config={modelConfig}
                                                marker={`kind-${kind}`}
                                                value={plan.imageModelsByKind?.[kind] || ""}
                                                fallbackLabel={t("newDrama.page.stepFollowSettings")}
                                                onChange={(model) => patchPlan((current) => ({ ...current, imageModelsByKind: { ...current.imageModelsByKind, [kind]: model || undefined } }))}
                                            />
                                        </span>
                                    </FieldRow>
                                ))}
                            </div>
                        </Section>

                        <Section id="storyboard" title={t("newDrama.page.storyboard")} aside={t("newDrama.page.storyboardHint")}>
                            <FieldLabel label={t("topic.minutes")} hint={t("topic.minutesHint")} />
                            <div className="flex flex-wrap items-center gap-2">
                                <Chip active={!plan.topic.episodeMinutes} onClick={() => setTopic({ episodeMinutes: 0 })}>{t("topic.modelDecides")}</Chip>
                                {TOPIC_OPTIONS.minutePresets.map((minutes) => (
                                    <Chip key={minutes} numeric active={plan.topic.episodeMinutes === minutes} onClick={() => setTopic({ episodeMinutes: minutes })}>{minutes}</Chip>
                                ))}
                                <InputNumber
                                    className="!w-[110px]"
                                    size="small"
                                    min={1}
                                    max={180}
                                    placeholder={t("topic.custom")}
                                    value={(TOPIC_OPTIONS.minutePresets as readonly number[]).includes(plan.topic.episodeMinutes) ? null : plan.topic.episodeMinutes || null}
                                    onChange={(value) => setTopic({ episodeMinutes: Math.min(180, Math.max(0, Number(value) || 0)) })}
                                />
                                <span className="text-[10px] text-muted-foreground">{t("topic.unitMinutes")}</span>
                            </div>

                            <div className="grid gap-2.5 rounded-[8px] border border-border bg-card px-3 py-2.5" data-new-drama-rules>
                                <FieldRow label={t("newDrama.page.episodeSeconds")} marker={"episodeSeconds"} hint={t("newDrama.page.episodeSecondsHint")}>
                                    <input
                                        type="text"
                                        inputMode="text"
                                        aria-label={t("newDrama.page.episodeSeconds")}
                                        data-new-drama-episode-seconds
                                        value={episodeSecondsDraft}
                                        placeholder={t("newDrama.page.episodeSecondsPlaceholder")}
                                        onChange={(event) => { setEpisodeSecondsDraft(event.target.value); setEpisodeSecondsError(""); }}
                                        onBlur={(event) => commitEpisodeSeconds(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key !== "Enter") return;
                                            commitEpisodeSeconds((event.target as HTMLInputElement).value);
                                            (event.target as HTMLInputElement).blur();
                                        }}
                                        className="h-[34px] w-[112px] rounded-[12px] border border-border bg-card px-3 text-[11px] text-foreground outline-none focus:border-primary"
                                    />
                                    <select
                                        aria-label={t("newDrama.page.episodeSecondsPreset")}
                                        data-new-drama-episode-preset
                                        value={(EPISODE_PRESETS as readonly number[]).includes(studio.episodeSeconds) ? studio.episodeSeconds : ""}
                                        onChange={(event) => {
                                            if (!event.target.value) return;
                                            patchStudio({ episodeSeconds: Number(event.target.value) });
                                            setEpisodeSecondsDraft(event.target.value);
                                            setEpisodeSecondsError("");
                                        }}
                                        className="h-[34px] rounded-[12px] border border-border bg-card px-2 text-[11px] text-foreground outline-none focus:border-primary"
                                    >
                                        <option value="">{t("newDrama.page.episodeSecondsPreset")}</option>
                                        {EPISODE_PRESETS.map((seconds) => (
                                            <option key={seconds} value={seconds}>{formatEpisodeSeconds(seconds)}（{seconds} 秒）</option>
                                        ))}
                                    </select>
                                    <span className="text-[10px] text-muted-foreground" data-new-drama-episode-readout>{formatEpisodeSeconds(studio.episodeSeconds)}</span>
                                </FieldRow>
                                {episodeSecondsError ? <p className="text-[11px] text-destructive" role="alert" data-new-drama-episode-error>{episodeSecondsError}</p> : null}
                                <FieldRow label={t("newDrama.page.segmentMode")} marker={"segmentMode"} detail={SEGMENT_MODE_DETAIL[studio.segmentMode]}>
                                    {(["auto", "fixed", "range"] as const).map((mode) => (
                                        <Chip key={mode} active={studio.segmentMode === mode} onClick={() => patchStudio({ segmentMode: mode })}>{SEGMENT_MODE_LABEL[mode]}</Chip>
                                    ))}
                                </FieldRow>
                                {studio.segmentMode !== "auto" ? (
                                    <FieldRow label={t("newDrama.page.segmentSeconds")} marker={"segmentSeconds"} hint={t("newDrama.page.segmentSecondsHint")}>
                                        {studio.segmentMode === "fixed" ? (
                                            <InputNumber
                                                className="!w-[96px]"
                                                size="small"
                                                min={MIN_SEGMENT_SECONDS}
                                                max={MAX_SEGMENT_SECONDS}
                                                aria-label={t("newDrama.page.segmentSeconds")}
                                                value={studio.segmentRange.max}
                                                onChange={(value) => {
                                                    const seconds = Math.max(MIN_SEGMENT_SECONDS, Math.min(MAX_SEGMENT_SECONDS, Number(value) || MIN_SEGMENT_SECONDS));
                                                    patchStudio({ segmentRange: { min: seconds, max: seconds } });
                                                }}
                                            />
                                        ) : (
                                            <>
                                                <InputNumber
                                                    className="!w-[96px]"
                                                    size="small"
                                                    min={MIN_SEGMENT_SECONDS}
                                                    max={studio.segmentRange.max}
                                                    aria-label={t("newDrama.page.segmentMin")}
                                                    value={studio.segmentRange.min}
                                                    onChange={(value) => patchStudio({ segmentRange: clampRange({ ...studio.segmentRange, min: Number(value) || MIN_SEGMENT_SECONDS }) })}
                                                />
                                                <span className="text-[10px] text-muted-foreground">{t("newDrama.page.segmentTo")}</span>
                                                <InputNumber
                                                    className="!w-[96px]"
                                                    size="small"
                                                    min={studio.segmentRange.min}
                                                    max={MAX_SEGMENT_SECONDS}
                                                    aria-label={t("newDrama.page.segmentMax")}
                                                    value={studio.segmentRange.max}
                                                    onChange={(value) => patchStudio({ segmentRange: clampRange({ ...studio.segmentRange, max: Number(value) || MIN_SEGMENT_SECONDS }) })}
                                                />
                                            </>
                                        )}
                                        <span className="text-[10px] text-muted-foreground">{t("newDrama.page.seconds")}</span>
                                    </FieldRow>
                                ) : null}
                                <FieldRow label={t("newDrama.page.pacing")} marker={"pacing"} detail={PACING_DETAIL[studio.pacing]}>
                                    {PACING_LABEL.map((value) => (
                                        <Chip key={value} active={studio.pacing === value} onClick={() => patchStudio({ pacing: value })}>{value}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.dialogueDensity")} marker={"dialogueDensity"} detail={DIALOGUE_DETAIL[studio.dialogueDensity]}>
                                    {(["dense", "standard", "restrained", "custom"] as const).map((value) => (
                                        <Chip key={value} active={studio.dialogueDensity === value} onClick={() => patchStudio({ dialogueDensity: value })}>{DIALOGUE_LABEL[value]}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.performance")} marker={"performance"} detail={`${PERFORMANCE_BANDS_LABEL[levelBandIndex(studio.performanceIntensity)]}：${PERFORMANCE_BANDS_DETAIL[levelBandIndex(studio.performanceIntensity)]}`}>
                                    {BAND_TICK_VALUES.map((value, index) => (
                                        <Chip key={value} active={levelBandIndex(studio.performanceIntensity) === index} onClick={() => patchStudio({ performanceIntensity: value })}>{PERFORMANCE_BANDS_LABEL[index]}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.camera")} marker={"camera"} detail={`${CAMERA_BANDS_LABEL[levelBandIndex(studio.cameraDynamics)]}：${CAMERA_BANDS_DETAIL[levelBandIndex(studio.cameraDynamics)]}`}>
                                    {BAND_TICK_VALUES.map((value, index) => (
                                        <Chip key={value} active={levelBandIndex(studio.cameraDynamics) === index} onClick={() => patchStudio({ cameraDynamics: value })}>{CAMERA_BANDS_LABEL[index]}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.transition")} marker={"transition"} detail={TRANSITION_DETAIL[studio.transitionMode]}>
                                    {(["smart", "hard", "fade", "flash"] as const).map((value) => (
                                        <Chip key={value} active={studio.transitionMode === value} onClick={() => patchStudio({ transitionMode: value })}>{TRANSITION_LABEL[value]}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.transitionMs")} marker={"transitionMs"} hint={t("newDrama.page.transitionMsHint")}>
                                    <InputNumber
                                        className="!w-[112px]"
                                        size="small"
                                        min={MIN_TRANSITION_MS}
                                        max={MAX_TRANSITION_MS}
                                        step={50}
                                        aria-label={t("newDrama.page.transitionMs")}
                                        value={studio.transitionMs}
                                        onChange={(value) => patchStudio({ transitionMs: Math.max(MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, Math.round(Number(value) || MIN_TRANSITION_MS))) })}
                                    />
                                    <span className="text-[10px] text-muted-foreground">{t("newDrama.page.ms")}</span>
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.continuation")} marker={"continuation"} detail={t("newDrama.page.continuationHint")}>
                                    {(["tail", "parallel"] as const).map((mode) => (
                                        <Chip key={mode} active={studio.continuationMode === mode} onClick={() => patchStudio({ continuationMode: mode })}>{t(`newDrama.page.continuationMode.${mode}`)}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.storyboardImages")} marker={"storyboardImages"} hint={t("newDrama.storyboardImagesHint")}>
                                    <Switch size="small" checked={plan.storyboardImageMode !== "skip"} onChange={(on) => patchPlan({ storyboardImageMode: on ? "generate" : "skip" })} />
                                </FieldRow>
                                <FieldRow label={t("newDrama.pacing.parallel")} marker={"parallelScenes"} hint={t("newDrama.pacing.parallelHint")}>
                                    <Switch size="small" checked={plan.parallelScenes !== false} onChange={(on) => patchPlan({ parallelScenes: on })} />
                                </FieldRow>
                            </div>
                        </Section>

                        <Section id="review" title={t("newDrama.pacing.review")} aside={t("newDrama.page.reviewHint")}>
                            <FieldLabel label={t("newDrama.page.reviewMode")} hint={t("newDrama.page.reviewModeHint")} />
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("newDrama.page.reviewMode")}>
                                {REVIEW_MODES.map((mode) => (
                                    <ModeCard
                                        key={mode.value}
                                        data-review-mode={mode.value}
                                        checked={studio.reviewMode === mode.value}
                                        onClick={() => patchStudio({ reviewMode: mode.value })}
                                        title={t(mode.titleKey)}
                                        desc={t(mode.detailKey)}
                                    />
                                ))}
                            </div>
                            <FieldLabel label={t("newDrama.page.reviewPoint")} hint={t("newDrama.page.reviewPointHint")} />
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("newDrama.page.reviewPoint")}>
                                {REVIEW_POLICY_MODES.map((mode) => (
                                    <ModeCard
                                        key={mode.value}
                                        data-review-policy={mode.value}
                                        checked={(plan.reviewPolicy?.mode || "none") === mode.value}
                                        onClick={() => patchPlan({ reviewPolicy: reviewPolicyFor(mode.value) })}
                                        title={t(mode.titleKey)}
                                        desc={t(mode.detailKey)}
                                    />
                                ))}
                            </div>
                            <FieldLabel label={t("newDrama.pacing.mode")} hint={t("newDrama.pacing.modeHint")} />
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("newDrama.pacing.mode")}>
                                {(["prompt_only", "per_item", "automatic"] as const).map((mode) => (
                                    <ModeCard
                                        key={mode}
                                        data-media-mode={mode}
                                        checked={(plan.mediaProductionMode || "per_item") === mode}
                                        onClick={() => patchPlan({ mediaProductionMode: mode })}
                                        title={t(`newDrama.pacing.${mode === "prompt_only" ? "promptOnly" : mode === "per_item" ? "perItem" : "automatic"}`)}
                                        desc={t(`newDrama.page.mediaMode.${mode}`)}
                                    />
                                ))}
                            </div>
                        </Section>

                        <Section id="preview" title={t("newDrama.page.preview")} aside={previewRow ? t("newDrama.page.previewAside", { words: previewRow.body.length }) : ""}>
                            {previewRow ? (
                                <>
                                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                                        <strong className="text-[14px] font-semibold">{previewRow.title}</strong>
                                        <span className="text-[10px] text-muted-foreground">{t("newDrama.split.chapterChars", { count: previewRow.body.length })}</span>
                                    </div>
                                    <div className="thin-scrollbar max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-[12px] border border-border bg-muted/30 px-6 py-4 text-[14px] leading-[1.95] text-foreground/75" data-new-drama-preview>
                                        {previewRow.body.slice(0, 6000)}
                                        {previewRow.body.length > 6000 ? "……" : ""}
                                    </div>
                                </>
                            ) : (
                                <p className="text-[11px] text-muted-foreground">{t("newDrama.page.previewEmpty")}</p>
                            )}
                        </Section>

                        <Section id="models" title={t("newDrama.page.models")} aside={t("newDrama.page.modelsHint")}>
                            <div className="grid gap-2.5 rounded-[8px] border border-border bg-card px-3 py-2.5" data-new-drama-models>
                                <FieldRow label={t("newDrama.videoModel")} marker={"videoModel"} hint={t("newDrama.videoModelHint")}>
                                    <span className="min-w-0 flex-1 max-w-[520px]">
                                        <ModelSelect
                                            capability="video"
                                            config={modelConfig}
                                            marker="video"
                                            value={plan.h3Model || ""}
                                            fallbackLabel={t("newDrama.page.stepFollowSettings")}
                                            onChange={(model) => patchPlan({ h3Model: model || "" })}
                                        />
                                    </span>
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.videoResolution")} marker={"videoResolution"} hint={t("newDrama.page.videoResolutionHint")}>
                                    {VIDEO_RESOLUTION_OPTIONS.map((option) => (
                                        <Chip key={option.value || "auto"} active={studio.videoResolution === option.value} onClick={() => patchStudio({ videoResolution: option.value })}>{option.label}</Chip>
                                    ))}
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.aspectRatio")} marker={"aspectRatio"} hint={plan.videoAspectRatio ? undefined : t("newDrama.page.aspectRatioAuto")}>
                                    <div className="flex gap-2" role="group" aria-label={t("newDrama.page.aspectRatio")}>
                                        {RATIOS.map((ratio) => (
                                            <button
                                                key={ratio.value}
                                                type="button"
                                                aria-pressed={plan.videoAspectRatio === ratio.value}
                                                onClick={() => patchPlan({ videoAspectRatio: ratio.value })}
                                                className={cn(
                                                    "flex h-16 w-[92px] flex-col items-center justify-center gap-2 rounded-[8px] border text-[10px] transition",
                                                    plan.videoAspectRatio === ratio.value ? "border-primary bg-primary/5 text-foreground" : "border-border bg-background text-muted-foreground hover:border-foreground/25",
                                                )}
                                            >
                                                <span className="rounded-[4px] border-[1.5px] border-current" style={{ width: ratio.w, height: ratio.h }} />
                                                {t(ratio.labelKey)}
                                            </button>
                                        ))}
                                    </div>
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.budget")} marker={"budget"} hint={t("newDrama.page.budgetHint")}>
                                    <InputNumber
                                        className="!w-[128px]"
                                        size="small"
                                        min={0}
                                        max={100000000}
                                        precision={0}
                                        aria-label={t("newDrama.page.budget")}
                                        value={studio.budgetMicrocredits}
                                        onChange={(value) => patchStudio({ budgetMicrocredits: Math.max(0, Math.round(Number(value) || 0)) })}
                                    />
                                    <span className="text-[10px] text-muted-foreground">{t("newDrama.page.microcredits")}</span>
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.concurrent")} marker={"concurrency"} hint={t("newDrama.page.concurrentHint")}>
                                    <InputNumber
                                        className="!w-[92px]"
                                        size="small"
                                        min={1}
                                        max={16}
                                        aria-label={t("newDrama.page.concurrent")}
                                        data-new-drama-concurrency="concurrency"
                                        value={studio.concurrency}
                                        onChange={(value) => patchStudio({ concurrency: Math.max(1, Math.min(16, Math.round(Number(value) || 4))) })}
                                    />
                                </FieldRow>
                                <FieldRow label={t("newDrama.page.backgroundMusic")} marker={"backgroundMusic"} hint={t("newDrama.page.backgroundMusicHint")}>
                                    <Switch size="small" checked={plan.backgroundMusicEnabled === true} onChange={(on) => patchPlan({ backgroundMusicEnabled: on })} />
                                </FieldRow>
                            </div>
                        </Section>

                        <Section id="extras" title={t("newDrama.page.extras")} aside={t("newDrama.page.extrasHint")}>
                            <FieldLabel label={t("newDrama.page.logline")} hint={t("newDrama.loglineHint")} />
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={plan.topic.logline} onChange={(event) => setTopic({ logline: event.target.value })} placeholder={t("newDrama.loglinePlaceholder")} />

                            <ChipPicker label={t("topic.themes")} hint={t("newDrama.selected", { count: plan.topic.themes.length, max: 2 })} options={TOPIC_OPTIONS.themes} active={plan.topic.themes} customPlaceholder={t("newDrama.addCustomTheme")} onPick={(value) => setTopic((current) => ({ themes: toggleThemes(current.themes, value) }))} />
                            <ChipPicker label={t("topic.tone")} hint={t("newDrama.multiHint")} options={TOPIC_OPTIONS.tones} active={plan.topic.tones} customPlaceholder={t("newDrama.addCustomTone")} onPick={(value) => setTopic((current) => ({ tones: toggleValue(current.tones, value) }))} />
                            <div className="grid gap-3 sm:grid-cols-2">
                                <ChipPicker label={t("topic.gender")} options={TOPIC_OPTIONS.gender} active={plan.topic.gender ? [plan.topic.gender] : []} customPlaceholder={t("newDrama.addCustomAudience")} onPick={(gender) => setTopic({ gender })} />
                                <ChipPicker label={t("topic.age")} options={TOPIC_OPTIONS.age} active={plan.topic.age ? [plan.topic.age] : []} customPlaceholder={t("newDrama.addCustomAudience")} onPick={(age) => setTopic({ age })} />
                                <ChipPicker label={t("topic.ending")} options={TOPIC_OPTIONS.ending} active={plan.topic.ending ? [plan.topic.ending] : []} customPlaceholder={t("newDrama.addCustomEnding")} onPick={(ending) => setTopic({ ending })} />
                                <ChipPicker label={t("topic.language")} options={TOPIC_OPTIONS.language} active={plan.topic.language ? [plan.topic.language] : []} customPlaceholder={t("newDrama.addCustomLang")} onPick={(language) => setTopic({ language })} />
                            </div>
                            <ChipPicker label={t("topic.artStyle")} hint={t("topic.artStyleHint")} options={TOPIC_OPTIONS.artStyle} active={plan.topic.artStyle ? [plan.topic.artStyle] : []} customPlaceholder={t("newDrama.addCustomStyle")} onPick={(artStyle) => setTopic({ artStyle })} />

                            <FieldLabel label={t("topic.episodes")} hint={t("newDrama.episodesHint")} />
                            <div className="flex flex-wrap items-center gap-2">
                                {TOPIC_OPTIONS.episodePresets.map((count) => (
                                    <Chip key={count} numeric active={plan.topic.episodes === count} onClick={() => setTopic({ episodes: count })}>{count}</Chip>
                                ))}
                                <InputNumber
                                    className="!w-[110px]"
                                    size="small"
                                    min={1}
                                    max={200}
                                    placeholder={t("topic.custom")}
                                    value={(TOPIC_OPTIONS.episodePresets as readonly number[]).includes(plan.topic.episodes) ? null : plan.topic.episodes || null}
                                    onChange={(value) => setTopic({ episodes: Math.min(200, Math.max(1, Number(value) || 0)) })}
                                />
                                <span className="text-[10px] text-muted-foreground">{t("topic.unitEpisodes")}</span>
                            </div>
                            <label className="flex items-start justify-between gap-3 border-t border-border/60 pt-3">
                                <span className="text-[11px] font-semibold text-foreground/80">
                                    {t("newDrama.autoEpisodes")}
                                    <span className="mt-0.5 block text-[10px] font-normal leading-[1.55] text-muted-foreground">
                                        {groups.length ? t("newDrama.autoEpisodesFromSource", { count: groups.length }) : t("newDrama.autoEpisodesHint", { count: plan.topic.episodes })}
                                    </span>
                                </span>
                                <Switch size="small" checked={groups.length > 0 || autoEpisodes} disabled={groups.length > 0} onChange={setAutoEpisodes} />
                            </label>
                            <label className="flex items-start justify-between gap-3 border-t border-border/60 pt-3">
                                <span className="text-[11px] font-semibold text-foreground/80">
                                    {t("newDrama.handoff")}
                                    <span className="mt-0.5 block text-[10px] font-normal leading-[1.55] text-muted-foreground">{t("newDrama.handoffHint")}</span>
                                </span>
                                <Switch size="small" checked={handoff} onChange={setHandoff} />
                            </label>
                        </Section>
                    </div>
                </main>
            </div>

            <footer className="shrink-0 border-t border-border bg-card/90 px-6 py-3 backdrop-blur">
                <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-3">
                    <span className="text-[11px] text-muted-foreground" data-new-drama-estimate>
                        {t("newDrama.page.footerEstimate", {
                            episodes: groups.length,
                            shots: estimate.shots,
                            segments: estimate.segments,
                            duration: formatSeconds(estimate.seconds),
                        })}
                    </span>
                    {!canCreate && !creating && blockedHint ? <span className="text-[11px] text-amber-600 dark:text-amber-500" data-new-drama-blocked>{blockedHint}</span> : null}
                    <div className="ml-auto flex items-center gap-2">
                        <Button icon={<Save className="size-4" />} onClick={() => void saveDraft()} disabled={creating} data-new-drama-save>{t("newDrama.page.saveDraft")}</Button>
                        <Button type="primary" icon={<Play className="size-4" />} loading={creating} disabled={!canCreate} onClick={() => void create()} data-new-drama-create>
                            {t("newDrama.page.createStart")}
                        </Button>
                    </div>
                </div>
            </footer>
        </div>
    );
}

function Section({ id, title, aside, children }: { id: string; title: string; aside: string; children: ReactNode }) {
    return (
        <section data-new-drama-section={id} className="grid gap-3">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-[16px] font-semibold leading-none">{title}</h2>
                <span className="text-[10px] text-muted-foreground">{aside}</span>
            </div>
            {children}
        </section>
    );
}

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
    return (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[11px] font-semibold text-foreground/80">{label}</span>
            {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
        </div>
    );
}

/** 一行一个字段：左标签固定 120，右侧控件区自适应（影策 .drama-step-row 的紧凑行，不写成整宽下拉）。
 *  detail 是档位说明，放在控件下方而不是标签里，避免标签被长文案撑高。 */
function FieldRow({ label, hint, detail, marker, children }: { label: string; hint?: string; detail?: string; marker?: string; children: ReactNode }) {
    return (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-3" data-new-drama-field={marker}>
            <div className="min-w-0 pt-1">
                <span className="block text-[11px] font-semibold leading-[1.4] text-foreground/80">{label}</span>
                {hint ? <span className="mt-0.5 block text-[10px] leading-[1.45] text-muted-foreground">{hint}</span> : null}
            </div>
            <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
                {detail ? <p className="mt-1 text-[10px] leading-[1.45] text-muted-foreground">{detail}</p> : null}
            </div>
        </div>
    );
}

function Stat({ value, label, bordered }: { value: string; label: string; bordered?: boolean }) {
    return (
        <div className={cn("px-4 py-4", bordered && "border-l border-border")}>
            <div className="text-[16px] font-semibold tabular-nums">{value}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{label}</div>
        </div>
    );
}

function ModeCard({ checked, onClick, title, desc, badge, ...data }: {
    checked: boolean;
    onClick: () => void;
    title: string;
    desc: string;
    badge?: string;
    [key: `data-${string}`]: string | undefined;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={onClick}
            {...data}
            className={cn(
                "grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2 rounded-[8px] border p-[8px_12px] text-left transition",
                checked ? "border-primary bg-primary/5" : "border-border bg-card hover:border-foreground/25",
            )}
        >
            <span className={cn("mt-px grid size-[18px] place-items-center rounded-full border-[1.5px]", checked ? "border-primary" : "border-muted-foreground/60")}>
                {checked ? <span className="size-2 rounded-full bg-primary" /> : null}
            </span>
            <span className="min-w-0">
                <strong className="flex flex-wrap items-center gap-2 text-[11px] font-semibold leading-[1.4]">
                    {title}
                    {badge ? <em className="not-italic rounded-[4px] bg-primary px-2 text-[11px] font-semibold leading-[17px] text-primary-foreground">{badge}</em> : null}
                </strong>
                <span className="mt-1 block text-[10px] leading-[1.55] text-muted-foreground">{desc}</span>
            </span>
        </button>
    );
}

function Chip({ active, numeric, onClick, children }: { active?: boolean; numeric?: boolean; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            aria-pressed={Boolean(active)}
            onClick={onClick}
            className={cn(
                "inline-flex h-7 items-center rounded-full border px-3 text-[11px] transition",
                numeric && "tabular-nums",
                active ? "border-primary bg-primary/5 text-foreground" : "border-border bg-card text-muted-foreground hover:border-foreground/25",
            )}
        >
            {children}
        </button>
    );
}

function ChipPicker({ label, hint, options, active, onPick, customPlaceholder }: {
    label: string;
    hint?: string;
    options: readonly string[];
    active: readonly string[];
    onPick: (value: string) => void;
    customPlaceholder: string;
}) {
    const [draft, setDraft] = useState("");
    const commit = () => {
        const value = draft.trim();
        if (!value) return;
        onPick(value);
        setDraft("");
    };
    // 已选但不在预设里的自定义值也要显示出来（否则选完看不见）。
    const extras = active.filter((value) => !options.includes(value));
    return (
        <div className="grid gap-2">
            <FieldLabel label={label} hint={hint} />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {options.map((option) => (
                    <Chip key={option} active={active.includes(option)} onClick={() => onPick(option)}>{option}</Chip>
                ))}
                {extras.map((option) => (
                    <Chip key={option} active onClick={() => onPick(option)}>{option}</Chip>
                ))}
                <Input
                    size="small"
                    className="w-[160px]"
                    allowClear
                    value={draft}
                    placeholder={customPlaceholder}
                    onChange={(event) => setDraft(event.target.value)}
                    onPressEnter={commit}
                    suffix={<button type="button" aria-label={customPlaceholder} className="text-muted-foreground hover:text-foreground" onClick={commit}><Plus className="size-3.5" /></button>}
                />
            </div>
        </div>
    );
}
