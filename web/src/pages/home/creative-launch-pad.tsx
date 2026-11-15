import { App, Button, Select, Tooltip } from "antd";
import { ArrowUp, AudioLines, Bot, Clapperboard, History, Image as ImageIcon, LayoutGrid, Plus, Sparkles, Type, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ModelPicker } from "@/components/model-picker";
import { ReferenceAssetPicker } from "@/components/canvas/reference-asset-picker";
import { CanvasImageSettingsPopover } from "@/components/canvas/canvas-image-settings-popover";
import { CanvasVideoSettingsPopover } from "@/components/canvas/canvas-video-settings-popover";
import { CanvasAudioSettingsPopover } from "@/components/canvas/canvas-audio-settings-popover";
import { CanvasTextSettingsPopover } from "@/components/canvas/canvas-text-settings-popover";
import {
    CREATIVE_MODES,
    creativeCapabilityForMode,
    creativeModeGenerates,
    creativeModelKey,
    creativeProjectTitle,
    referenceAttachmentSummary,
    toAgentAttachments,
    type CreativeMode,
    type ReferenceAsset,
} from "@/lib/creative-pad";
import { CreativeConfigMissingError, startCreativeGeneration } from "@/lib/creative-generation";
import { fetchSettings } from "@/services/settings-api";
import { getGenerationCount } from "@/lib/canvas/canvas-generation-helpers";
import { normalizeVideoSizeValue } from "@/lib/video-size";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { defaultConfig, resolveModelForCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { CreativeLaunch } from "./workbench-data";

const MODE_ICONS = {
    canvas: LayoutGrid,
    image: ImageIcon,
    video: Video,
    storyboard: Clapperboard,
    text: Type,
    audio: AudioLines,
    director: Bot,
} as const;

/** 导演模式是 composer 本地的伪模式：能力等同 text，但模型取设置里的「导演引擎」（后端走 hermes 导演 agent 链路）。 */
type PadMode = CreativeMode | "director";
// 首页创作台标签：图片/视频/文本 对齐影策，另保留 音频 与 导演（自研能力，老板要求常驻）；
// 自由画布 / 分镜不进标签行（自由画布走「新建空白画布」快捷入口）。
const HERO_MODES: PadMode[] = ["image", "video", "text", "audio", "director"];
// 对话工作台追问下拉：额外提供 音频 与 导演（导演 = 导演引擎单轮对话）。
const THREAD_MODES: PadMode[] = ["image", "video", "text", "audio", "director"];
const isPadMode = (value: string | null): value is PadMode => !!value && [...HERO_MODES, ...THREAD_MODES].includes(value as PadMode);

/**
 * 首页中央创作台：想法 + 参考素材一步进入一张新画布。
 * 图片 / 视频 / 文本 / 音频模式直接选用画布模型并提交 Backend 生成（与画布内生成同一条任务链路），
 * 提交后留在首页，进度与结果由「对话工作台」实时展示；自由画布 / 分镜模式把想法与图片附件写进全局 Agent 草稿。
 * variant="home" 为完整创作台；variant="thread" 为对话工作台底部的停靠压缩形态（对齐影策 thread-composer）。
 */
export function CreativeLaunchPad({ onGenerated, historyCount = 0, onOpenHistory, variant = "home", sharedProjectId, injectedDraft }: {
    onGenerated?: (launch: CreativeLaunch) => void;
    /** 已有的生成记录数；大于 0 时标题右侧显示「历史对话」入口。 */
    historyCount?: number;
    /** 点击历史入口时的滚动/展开回调，由宿主定位对话工作台。 */
    onOpenHistory?: () => void;
    variant?: "home" | "thread";
    /** 会话内多轮共享生成上下文：传入活动会话的画布 id，本轮提交追加节点到该画布。 */
    sharedProjectId?: string;
    /** 编辑并重发（影策）：nonce 变化即把 text 回填进输入框并聚焦。 */
    injectedDraft?: { text: string; nonce: number };
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projects = useCanvasStore(state => state.projects);
    const hydrated = useCanvasStore(state => state.hydrated);
    const createProject = useCanvasStore(state => state.createProject);
    const config = useConfigStore(state => state.config);
    const openConfigDialog = useConfigStore(state => state.openConfigDialog);

    const queryMode = searchParams.get("mode");
    // 影策 composer 行为：记住上次使用的模式（含对话工作台追问时），URL ?mode= 仍可显式覆盖；
    // 首页创作台只展示 图片/视频/文本（影策默认图片），记忆值不属于当前形态时回落。
    const [mode, setMode] = useState<PadMode>(() => {
        const visible = variant === "thread" ? THREAD_MODES : HERO_MODES;
        if (isPadMode(queryMode) && visible.includes(queryMode)) return queryMode;
        try {
            const stored = sessionStorage.getItem("home-creative-mode");
            if (isPadMode(stored) && visible.includes(stored)) return stored;
        } catch { /* 可选持久化 */ }
        return visible[0];
    });
    const changeMode = (next: PadMode) => {
        setMode(next);
        try {
            sessionStorage.setItem("home-creative-mode", next);
        } catch { /* 可选持久化 */ }
    };
    const [draft, setDraft] = useState("");
    const [references, setReferences] = useState<ReferenceAsset[]>([]);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [overrides, setOverrides] = useState({ imageSize: "", imageQuality: "", imageCount: "", videoSize: "", videoSeconds: "", videoResolution: "", videoGenerateAudio: "", videoWatermark: "" });
    const [comfyParams, setComfyParams] = useState<Record<string, unknown> | undefined>(undefined);
    const [imageRunTarget, setImageRunTarget] = useState<"local" | "cloud" | "hybrid" | undefined>(undefined);
    const [videoRunTarget, setVideoRunTarget] = useState<"local" | "cloud" | "hybrid" | undefined>(undefined);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const setOverride = (key: keyof typeof overrides, value: string) => setOverrides(current => ({ ...current, [key]: value }));

    // 每个模式都有对应的模型能力：画布用图片模型、分镜用视频模型、文本/音频各自独立；
    // 导演模式能力等同 text，但模型用设置里的「导演引擎」（后端 dispatcher 走 hermes 导演 agent）。
    const isDirector = mode === "director";
    const capability = isDirector ? ("text" as const) : creativeCapabilityForMode(mode);
    const generates = isDirector ? true : creativeModeGenerates(mode);
    const modelKey = creativeModelKey(capability);
    const updateConfig = useConfigStore(state => state.updateConfig);
    const imageReferenceCount = references.filter(item => item.mediaType === "image").length;
    const baseModel = resolveModelForCapability(config, config[modelKey], capability);
    const [directorModel, setDirectorModel] = useState("");
    const effectiveModel = isDirector ? (directorModel || baseModel) : baseModel;
    // 进入导演模式时读取「导演引擎」设置；读不到或未登记 text 能力则退回普通文本模型，不阻塞。
    useEffect(() => {
        if (!isDirector) return;
        let disposed = false;
        void fetchSettings()
            .then(settings => {
                const agentModel = settings.agentModel?.trim();
                if (disposed || !agentModel) return;
                if (resolveModelForCapability(useConfigStore.getState().config, agentModel, "text") === agentModel) setDirectorModel(agentModel);
            })
            .catch(() => { /* 沿用文本模型 */ });
        return () => { disposed = true; };
    }, [isDirector]);
    const imageSize = overrides.imageSize || config.size || defaultConfig.size;
    const imageQuality = overrides.imageQuality || config.quality || defaultConfig.quality;
    const imageCount = overrides.imageCount || config.canvasImageCount || config.count || defaultConfig.count;
    const videoSize = overrides.videoSize || normalizeVideoSizeValue(config.size);
    const videoSeconds = overrides.videoSeconds || config.videoSeconds || defaultConfig.videoSeconds;
    const videoResolution = overrides.videoResolution || config.vquality || defaultConfig.vquality;

    // 切换能力或模型时丢弃上一份工作流参数，避免同名字段（如 steps）跨场景沿用；
    // 设置面板挂载后会按「当前模型 + 本次参考场景」重新铺一遍。
    useEffect(() => { setComfyParams(undefined); }, [capability, effectiveModel]);
    // 编辑并重发：nonce 变化时回填草稿并聚焦输入框。
    const injectedNonce = injectedDraft?.nonce || 0;
    const injectedText = injectedDraft?.text || "";
    useEffect(() => {
        if (!injectedNonce || !injectedText) return;
        setDraft(injectedText);
        textareaRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [injectedNonce]);
    // 设置面板与画布节点共用同一套 popover：把本次生效的模型与标准项喂给它们，
    // 工作流自定义字段 / run-target / 尺寸同步都由面板内部按画布同一逻辑处理。
    const settingsConfig: AiConfig = {
        ...config,
        model: effectiveModel,
        size: capability === "video" ? videoSize : imageSize,
        quality: imageQuality,
        count: String(getGenerationCount(imageCount)),
        vquality: videoResolution,
        videoSeconds,
    };
    const settingsButtonClass = variant === "thread" ? "!h-7 !max-w-[160px] !justify-start !rounded-lg !px-2 !text-xs" : "!h-8 !max-w-[240px] !justify-start !rounded-lg !px-2.5 !text-xs";
    const settingsTargetLabel = t(`creativePad.modes.${mode}`);

    const start = (withIdea: boolean) => {
        if (!hydrated || submitting) return;
        if (withIdea && generates) {
            void startGeneration();
            return;
        }
        const text = withIdea ? draft.trim() : "";
        const title = text ? creativeProjectTitle(text) : t("canvas.defaultTitle", { count: projects.length + 1 });
        try {
            if (text) {
                const agent = useAgentStore.getState();
                agent.setAgentState({ prompt: text, attachments: toAgentAttachments(references), activeTab: "chat" });
                agent.openPanel();
            }
            const id = createProject(title);
            if (withIdea) {
                setDraft("");
                setReferences([]);
            }
            navigate(`/canvas/${encodeURIComponent(id)}`);
            if (text) message.success(t("creativePad.agentDraft"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };

    // 与画布内生成共用 Backend 任务链路：先落画布与节点，再提交生成；结果节点由 Backend 依据 clientTaskId 创建。
    // 提交后不跳转：进度与结果留在首页「对话工作台」里实时更新，进画布是用户的显式选择。
    const startGeneration = async () => {
        const text = draft.trim();
        if (!text || !generates) return;
        setSubmitting(true);
        try {
            const { projectId, nodeId, taskId } = await startCreativeGeneration({
                capability,
                prompt: text,
                model: effectiveModel,
                projectId: sharedProjectId,
                references,
                imageSize,
                imageQuality,
                imageCount,
                videoSize,
                videoSeconds,
                videoResolution,
                videoGenerateAudio: overrides.videoGenerateAudio || undefined,
                videoWatermark: overrides.videoWatermark || undefined,
                comfyParams,
                imageRunTarget,
                videoRunTarget,
            });
            setDraft("");
            setReferences([]);
            onGenerated?.({
                taskId,
                projectId,
                nodeId,
                mode: capability,
                prompt: text,
                model: effectiveModel,
                createdAt: new Date().toISOString(),
                params: capability === "image"
                    ? { count: getGenerationCount(imageCount), size: imageSize }
                    : capability === "video"
                        ? { size: videoSize, seconds: videoSeconds, resolution: videoResolution }
                        : {},
            });
            message.success(t("creativePad.generationStarted"));
            // 对齐影策：提交后不跳转，首页原地进入对话工作台（进度与结果实时更新）；
            // 进入画布是用户点「继续在画布上编辑」的显式选择。
        } catch (error) {
            if (error instanceof CreativeConfigMissingError) openConfigDialog(true);
            else message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setSubmitting(false);
        }
    };

    const fillExample = (text: string) => {
        setDraft(text);
        textareaRef.current?.focus();
    };

    const attachments = referenceAttachmentSummary(references);
    const startLabel = mode === "image" ? t("creativePad.generateImage")
        : mode === "video" ? t("creativePad.generateVideo")
            : mode === "text" ? t("creativePad.generateText")
                : mode === "audio" ? t("creativePad.generateAudio")
                    : mode === "director" ? t("creativePad.directorStart")
                        : t("creativePad.start");

    // ---- 两种形态共享的组成块 ----
    const modelPicker = (
        <ModelPicker
            config={config}
            capability={capability}
            value={effectiveModel}
            onChange={model => updateConfig(modelKey, model)}
            sortByCanvasUsage={generates}
            className={variant === "thread" ? "min-w-[9rem] max-w-[13rem] flex-1" : "min-w-[12rem] flex-1"}
            {...(capability === "image" ? { imageReferenceCount } : {})}
            onMissingConfig={() => openConfigDialog(true)}
        />
    );
    const settingsControl = generates && capability === "image" ? (
        <CanvasImageSettingsPopover
            config={settingsConfig}
            targetLabel={settingsTargetLabel}
            placement="topRight"
            buttonClassName={settingsButtonClass}
            referenceCount={imageReferenceCount}
            comfyParams={comfyParams}
            onComfyParamsChange={(value, size) => { setComfyParams(value); if (size) setOverride("imageSize", size); }}
            runTargetOverride={imageRunTarget}
            onRunTargetChange={setImageRunTarget}
            onConfigChange={(key, value) => {
                if (key === "size") setOverride("imageSize", value);
                else if (key === "quality") setOverride("imageQuality", value);
                else if (key === "count") setOverride("imageCount", value);
            }}
        />
    ) : generates && capability === "video" ? (
        <CanvasVideoSettingsPopover
            config={settingsConfig}
            targetLabel={settingsTargetLabel}
            placement="topRight"
            buttonClassName={settingsButtonClass}
            referenceCount={imageReferenceCount}
            comfyParams={comfyParams}
            onComfyParamsChange={value => setComfyParams(value)}
            runTargetOverride={videoRunTarget}
            onRunTargetChange={setVideoRunTarget}
            onConfigChange={(key, value) => {
                if (key === "size") setOverride("videoSize", value);
                else if (key === "vquality") setOverride("videoResolution", value);
                else if (key === "videoSeconds") setOverride("videoSeconds", value);
                else if (key === "videoGenerateAudio") setOverride("videoGenerateAudio", value);
                else if (key === "videoWatermark") setOverride("videoWatermark", value);
            }}
        />
    ) : generates && capability === "audio" ? (
        <CanvasAudioSettingsPopover
            config={settingsConfig}
            targetLabel={settingsTargetLabel}
            placement="topRight"
            buttonClassName={settingsButtonClass}
            referenceCount={0}
            comfyParams={comfyParams}
            onComfyParamsChange={value => setComfyParams(value)}
            onConfigChange={(key, value) => updateConfig(key, value)}
        />
    ) : generates && capability === "text" ? (
        <CanvasTextSettingsPopover
            config={settingsConfig}
            targetLabel={settingsTargetLabel}
            placement="topRight"
            buttonClassName={settingsButtonClass}
            onConfigChange={(_, value) => updateConfig("reasoningEffort", value)}
        />
    ) : null;
    const referenceChips = references.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3" data-testid="creative-reference-list">
            {references.map(item => (
                <span key={item.id} data-testid="creative-reference-chip" className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-1 pr-2 text-xs">
                    {item.coverUrl
                        ? <img src={item.coverUrl} alt="" className="size-5 rounded-full object-cover" />
                        : <ImageIcon className="size-4 text-muted-foreground" />}
                    <span className="truncate" title={item.title}>{item.title}</span>
                    <button type="button" aria-label={`${t("creativePad.referenceRemove")} ${item.title}`} onClick={() => setReferences(current => current.filter(entry => entry.id !== item.id))} className="text-muted-foreground hover:text-foreground">
                        <X className="size-3" />
                    </button>
                </span>
            ))}
            {attachments.registeredOnly > 0 && <span className="ui-caption self-center text-muted-foreground">{t("creativePad.registeredOnly", { count: attachments.registeredOnly })}</span>}
        </div>
    ) : null;
    const textarea = (
        <textarea
            ref={textareaRef}
            data-testid="creative-draft"
            aria-label={t("creativePad.ideaLabel")}
            value={draft}
            rows={variant === "thread" ? 2 : 3}
            placeholder={t(`creativePad.placeholders.${mode}`)}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    if (draft.trim() && hydrated) start(true);
                }
            }}
            className={cn("block w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground", variant === "thread" ? "min-h-[56px]" : "min-h-[92px]")}
        />
    );
    const submitButton = (
        <Tooltip title={generates ? t("creativePad.generateHint") : t("creativePad.startHint")}>
            <Button
                type="primary"
                size="small"
                className={variant === "thread" ? "" : "ml-auto"}
                data-testid="creative-start"
                icon={<ArrowUp className="size-3.5" />}
                loading={submitting}
                disabled={!hydrated || !draft.trim() || submitting}
                onClick={() => start(true)}
            >
                {hydrated ? startLabel : t("creativePad.hydrating")}
            </Button>
        </Tooltip>
    );
    const addReferenceButton = (
        <Button type="text" size="small" icon={<Plus className="size-3.5" />} data-testid="creative-add-reference" onClick={() => setPickerOpen(true)}>
            {t("creativePad.referenceAdd")}
            {references.length > 0 ? ` · ${references.length}` : ""}
        </Button>
    );

    if (variant === "thread") {
        // 对话工作台底部停靠形态：模式 + 模型 + 参数 + 提交一行收纳，随时追问。
        return (
            <section
                className="sticky bottom-3 z-20 rounded-[10px] border border-border bg-card shadow-lg shadow-black/5"
                data-testid="creative-launch-pad-thread"
                aria-label={t("creativePad.title")}
            >
                {referenceChips}
                {textarea}
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2" data-testid="creative-thread-composer-controls">
                    <Select
                        className="!w-[104px]"
                        size="small"
                        value={mode}
                        aria-label={t("creativePad.modeLabel")}
                        onChange={value => changeMode(value)}
                        options={THREAD_MODES.map(key => ({ value: key, label: t(`creativePad.modes.${key}`) }))}
                    />
                    {addReferenceButton}
                    {modelPicker}
                    {settingsControl}
                    <span className="ml-auto" />
                    {submitButton}
                </div>
                <ReferenceAssetPicker
                    open={pickerOpen}
                    value={references}
                    maxSelected={5}
                    onConfirm={setReferences}
                    onClose={() => setPickerOpen(false)}
                />
            </section>
        );
    }

    return (
        <section className="mb-6 rounded-[10px] border border-border bg-card px-5 py-6 sm:px-7" data-testid="creative-launch-pad" aria-labelledby="creative-pad-title">
            <div className="relative mb-5 text-center">
                <h1 id="creative-pad-title" className="text-xl font-semibold tracking-tight sm:text-2xl">{t("creativePad.title")}</h1>
                <p className="ui-caption mt-1.5 text-muted-foreground">{t("creativePad.subtitle")}</p>
                {historyCount > 0 && onOpenHistory ? (
                    <Button
                        type="text"
                        size="small"
                        className="absolute right-0 top-1"
                        data-testid="creative-history"
                        icon={<History className="size-3.5" />}
                        onClick={onOpenHistory}
                    >
                        {t("creativePad.history")}
                    </Button>
                ) : null}
            </div>

            <div className="mx-auto max-w-[880px] overflow-hidden rounded-xl border border-border bg-background/70">
                <div className="flex flex-wrap items-end gap-1 bg-muted/50 px-2 pt-1.5" role="tablist" aria-label={t("creativePad.modeLabel")}>
                    {HERO_MODES.map(key => {
                        const Icon = MODE_ICONS[key];
                        const active = mode === key;
                        return (
                            <button
                                key={key}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                data-testid={`creative-mode-${key}`}
                                onClick={() => changeMode(key)}
                                className={cn(
                                    "flex min-w-[110px] flex-1 items-center justify-center gap-2 rounded-t-lg px-3 py-2 text-sm transition",
                                    active
                                        ? "bg-background font-medium text-foreground"
                                        : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                                )}
                            >
                                <Icon className="size-4" aria-hidden="true" />
                                {t(`creativePad.modes.${key}`)}
                            </button>
                        );
                    })}
                </div>

                {textarea}
                {referenceChips}

                <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2" data-testid="creative-generation-settings">
                    {addReferenceButton}
                    {modelPicker}
                    {settingsControl}
                    <span className="ui-caption hidden min-w-0 flex-1 truncate text-muted-foreground lg:inline">{generates ? t("creativePad.generateHint") : t("creativePad.modeHint")}</span>
                    {submitButton}
                </div>
            </div>

            <div className="mx-auto mt-4 grid max-w-[880px] gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[0, 1].map(index => (
                    <button
                        key={`example-${index}`}
                        type="button"
                        data-testid={`creative-quick-example${index}`}
                        onClick={() => fillExample(t(`creativePad.examples.${mode}.${index}.text`))}
                        className="group flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/50 hover:bg-muted/40"
                    >
                        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                        <span className="min-w-0">
                            <span className="block truncate text-xs font-medium">{t(`creativePad.examples.${mode}.${index}.label`)}</span>
                            <span className="ui-caption mt-0.5 block truncate text-muted-foreground">{t(`creativePad.examples.${mode}.${index}.hint`)}</span>
                        </span>
                    </button>
                ))}
                <button
                    type="button"
                    data-testid="creative-quick-reference"
                    onClick={() => setPickerOpen(true)}
                    className="group flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/50 hover:bg-muted/40"
                >
                    <ImageIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">{t("creativePad.actions.fromReference.label")}</span>
                        <span className="ui-caption mt-0.5 block truncate text-muted-foreground">{t("creativePad.actions.fromReference.hint")}</span>
                    </span>
                </button>
                <button
                    type="button"
                    data-testid="creative-quick-blank"
                    disabled={!hydrated}
                    onClick={() => start(false)}
                    className="group flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/50 hover:bg-muted/40 disabled:opacity-50"
                >
                    <LayoutGrid className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">{t("creativePad.actions.blankCanvas.label")}</span>
                        <span className="ui-caption mt-0.5 block truncate text-muted-foreground">{t("creativePad.actions.blankCanvas.hint")}</span>
                    </span>
                </button>
            </div>

            <ReferenceAssetPicker
                open={pickerOpen}
                value={references}
                maxSelected={5}
                onConfirm={setReferences}
                onClose={() => setPickerOpen(false)}
            />
        </section>
    );
}
