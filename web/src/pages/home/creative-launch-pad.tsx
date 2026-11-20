import { App, Button, Select, Tooltip } from "antd";
import { ArrowUp, ArrowUpRight, AudioLines, Bot, Clapperboard, History, Image as ImageIcon, ImagePlus, LayoutGrid, Plus, Sparkles, Type, Video, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import { mediaRatioOptions, parsePixelSize } from "@/lib/media-size";
import { readFileAsDataUrl, readImageMeta } from "@/lib/image-utils";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { defaultConfig, resolveModelForCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { CreativeVoiceButton } from "./creative-voice-button";
import type { CreativeLaunch, CreativeLaunchReference } from "./workbench-data";

/**
 * 语音输入总开关（暂时停用）。
 * 本地 Whisper 每次请求都要冷加载 torch / 模型并预热 CUDA（约 20s），推理时还会占用显存，
 * 与本机 ComfyUI 争用 GPU；常驻进程方案同样不可接受。因此首页不再渲染麦克风按钮，
 * Backend 的 /agent/audio-transcribe 端点也同步停用，空闲时不会有任何模型进程或显存占用。
 * 组件、通道决策、i18n 与 API 客户端代码全部原样保留；待接入云端 ASR 通道后把此开关与
 * backend/src/server/audio-transcribe-routes.ts 的 VOICE_ASR_ENABLED 一同改回 true 即可恢复。
 */
const VOICE_INPUT_ENABLED: boolean = false;

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
 * 影策 composer 的回车提交语义（对齐 canvas-resource-mention-textarea 的 shouldSubmitOnEnter）：
 * - 仅 Enter 提交；Shift+Enter 始终换行；Ctrl/Cmd+Enter 保持兼容（两种形态都提交）。
 * - 输入法组字中的 Enter 必须放行：中文选词时 Enter 是「确认候选」，nativeEvent.isComposing /
 *   keyCode 229 时若拦截会误发送未上屏的内容。textarea 受控组件无需 contentEditable 的 composingRef。
 */
function shouldSubmitOnEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.key !== "Enter" || event.shiftKey) return false;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    return true;
}

/** 把粘贴/拖入的媒体文件转成参考素材：图片读 dataUrl 供模型参考，视频用 blob URL 只登记。 */
async function mediaFileToReference(file: File): Promise<ReferenceAsset> {
    const isVideo = file.type.startsWith("video/");
    const title = file.name.replace(/\.[^.]+$/, "") || file.name;
    if (isVideo) {
        const url = URL.createObjectURL(file);
        return {
            id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            title, kind: "video", mediaType: "video", category: "other",
            coverUrl: url, url, dataUrl: "", mimeType: file.type || "video/*",
            width: 0, height: 0, bytes: file.size, tags: [], searchText: title.toLowerCase(),
        };
    }
    const dataUrl = await readFileAsDataUrl(file);
    const meta = await readImageMeta(dataUrl);
    return {
        id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        title, kind: "image", mediaType: "image", category: "image",
        coverUrl: dataUrl, url: dataUrl, dataUrl, mimeType: file.type || "image/*",
        width: meta.width, height: meta.height, bytes: file.size, tags: [], searchText: title.toLowerCase(),
    };
}

/**
 * 首页中央创作台：想法 + 参考素材一步进入一张新画布。
 * 图片 / 视频 / 文本 / 音频模式直接选用画布模型并提交 Backend 生成（与画布内生成同一条任务链路），
 * 提交后留在首页，进度与结果由「对话工作台」实时展示；对话阶段不创建画布，点「新建画布」才落地成果。
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
    /** 编辑并重发（影策）：nonce 变化即把 text 回填进输入框并聚焦；submit=true 时按同一模式直接再生成一次同款。 */
    injectedDraft?: { text: string; nonce: number; submit?: boolean; mode?: PadMode; params?: CreativeLaunch["params"] };
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
        if (injectedDraft?.mode && isPadMode(injectedDraft.mode)) changeMode(injectedDraft.mode);
        setDraft(injectedText);
        textareaRef.current?.focus();
        // 生成同款：回填后按该条消息的模式与参数直接再提交一次，用户无需再点发送。
        if (injectedDraft?.submit) void startGeneration({ text: injectedText, mode: injectedDraft.mode ?? mode, params: injectedDraft.params });
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
        // 带想法但当前模式不直接生成时，只把想法交给 Agent 对话：绝不自动建画布、绝不跳走。
        // 画布只由用户显式点「新建空白画布」或会话工具栏的「新建画布」创建。
        if (withIdea) {
            const text = draft.trim();
            if (text) {
                const agent = useAgentStore.getState();
                agent.setAgentState({ prompt: text, attachments: toAgentAttachments(references), activeTab: "chat" });
                agent.openPanel();
                message.info(t("creativePad.conversationOnlyHint"));
            }
            return;
        }
        try {
            const id = createProject(t("canvas.defaultTitle", { count: projects.length + 1 }));
            navigate(`/canvas/${encodeURIComponent(id)}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };

    // 与画布内生成共用 Backend 任务链路，但首页走会话级生成（createCanvas=false）：不落画布、不建节点，
    // 结果留在 task.result.media。提交后不跳转，进画布是用户点「新建画布」的显式选择。
    const startGeneration = async (override?: { text: string; mode: PadMode; params?: CreativeLaunch["params"] }) => {
        // 「生成同款」由历史消息直接触发：按该条消息的模式与参数重跑，不依赖 composer 当前选中的模式。
        const runMode = override?.mode ?? mode;
        const runCapability = runMode === "director" ? ("text" as const) : creativeCapabilityForMode(runMode);
        const runGenerates = runMode === "director" ? true : creativeModeGenerates(runMode);
        const runModelKey = creativeModelKey(runCapability);
        const runModel = override
            ? (runMode === "director" ? (directorModel || resolveModelForCapability(config, config[runModelKey], "text")) : resolveModelForCapability(config, config[runModelKey], runCapability))
            : effectiveModel;
        const text = (override?.text ?? draft).trim();
        if (!text || !runGenerates) return;
        // 参考素材在提交前快照：清空输入框后消息流仍要显示本轮引用缩略图；只留小体积 URL / storageKey。
        const referenceSnapshot: CreativeLaunchReference[] = references.slice(0, 5).map(item => ({
            id: item.id,
            title: item.title,
            url: item.storageKey || item.coverUrl.startsWith("data:") || item.coverUrl.length > 2000 ? "" : item.coverUrl,
            ...(item.storageKey ? { storageKey: item.storageKey } : {}),
            kind: item.mediaType === "image" ? "image" : item.mediaType === "video" ? "video" : item.mediaType === "audio" ? "audio" : "file",
        }));
        const runImageSize = runCapability === "image" && override?.params?.size ? override.params.size : imageSize;
        const runImageCount = runCapability === "image" && override?.params?.count ? String(override.params.count) : imageCount;
        const runVideoSize = runCapability === "video" && override?.params?.size ? normalizeVideoSizeValue(override.params.size) : videoSize;
        const runVideoSeconds = runCapability === "video" && override?.params?.seconds ? override.params.seconds : videoSeconds;
        const runVideoResolution = runCapability === "video" && override?.params?.resolution ? override.params.resolution : videoResolution;
        setSubmitting(true);
        try {
            const { projectId, nodeId, taskId } = await startCreativeGeneration({
                capability: runCapability,
                prompt: text,
                model: runModel,
                projectId: sharedProjectId,
                createCanvas: false,
                references,
                imageSize: runImageSize,
                imageQuality,
                imageCount: runImageCount,
                videoSize: runVideoSize,
                videoSeconds: runVideoSeconds,
                videoResolution: runVideoResolution,
                videoGenerateAudio: overrides.videoGenerateAudio || undefined,
                videoWatermark: overrides.videoWatermark || undefined,
                comfyParams,
                imageRunTarget,
                videoRunTarget,
            });
            // 同款重生成不改动 composer 里正在编辑的内容。
            if (!override) {
                setDraft("");
                setReferences([]);
            }
            onGenerated?.({
                taskId,
                ...(projectId ? { projectId } : {}),
                ...(nodeId ? { nodeId } : {}),
                mode: runCapability,
                prompt: text,
                model: runModel,
                createdAt: new Date().toISOString(),
                params: runCapability === "image"
                    ? { count: getGenerationCount(runImageCount), size: runImageSize }
                    : runCapability === "video"
                        ? { size: runVideoSize, seconds: runVideoSeconds, resolution: runVideoResolution }
                        : {},
                ...(referenceSnapshot.length ? { references: referenceSnapshot } : {}),
            });
            message.success(t("creativePad.generationStarted"));
            // 对齐影策：提交后不跳转、也不建画布，首页原地进入对话工作台（进度与结果实时更新）；
            // 进入画布是用户点「新建画布」的显式选择。
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
            className={variant === "thread" ? "min-w-[9rem] max-w-[13rem] flex-1" : "min-w-[10rem] max-w-[230px] flex-1"}
            {...(capability === "image" ? { imageReferenceCount } : {})}
            onMissingConfig={() => openConfigDialog(true)}
        />
    );
    const settingsControl = generates && capability === "image" ? (
        <CanvasImageSettingsPopover
            config={settingsConfig}
            targetLabel={settingsTargetLabel}
            placement="bottomRight"
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
            placement="bottomRight"
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
            placement="bottomRight"
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
            placement="bottomRight"
            buttonClassName={settingsButtonClass}
            onConfigChange={(_, value) => updateConfig("reasoningEffort", value)}
        />
    ) : null;
    const referenceChips = references.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-5 pb-3" data-testid="creative-reference-list">
            {references.map(item => (
                <span key={item.id} data-testid="creative-reference-chip" className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-1 pr-2 text-xs">
                    {item.mediaType === "video" && item.coverUrl
                        ? <video src={item.coverUrl} muted preload="metadata" playsInline className="size-5 rounded-full object-cover" />
                        : item.coverUrl
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
            onPaste={event => {
                const data = event.clipboardData;
                const files = Array.from(data?.files || []);
                if (!files.length && data) {
                    for (const item of Array.from(data.items)) {
                        const file = item.kind === "file" ? item.getAsFile() : null;
                        if (file) files.push(file);
                    }
                }
                const media = files.filter(file => /^(image|video)\//.test(file.type));
                if (!media.length) return;
                event.preventDefault();
                void Promise.all(media.map(mediaFileToReference)).then(added => {
                    setReferences(current => [...current, ...added].slice(0, 5));
                }).catch(() => message.error(t("creativePad.pasteFailed")));
            }}
            onKeyDown={event => {
                if (!shouldSubmitOnEnter(event)) return;
                event.preventDefault();
                if (draft.trim() && hydrated && !submitting) start(true);
            }}
            className={variant === "thread"
                ? "block w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground min-h-[56px]"
                : "ch-draft"}
        />
    );
    const submitButton = (
        <Tooltip title={generates ? t("creativePad.generateHint") : t("creativePad.startHint")}>
            <Button
                type="primary"
                size={variant === "thread" ? "small" : "middle"}
                className={variant === "thread" ? "" : "ch-submit ml-auto"}
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
        <Button type="text" size="small" className="ch-tool" icon={<Plus className="size-3.5" />} data-testid="creative-add-reference" onClick={() => setPickerOpen(true)}>
            {t("creativePad.referenceAdd")}
            {references.length > 0 ? ` · ${references.length}` : ""}
        </Button>
    );
    // 影策 composer 的语音输入：Backend 本地 Whisper ASR 为首选、Web Speech 回退，识别结果追加到输入框。
    // 暂时停用（见 VOICE_INPUT_ENABLED 注释）：不渲染按钮即不会有能力探测、录音或模型调用。
    const voiceButton = VOICE_INPUT_ENABLED ? (
        <CreativeVoiceButton
            disabled={submitting}
            onTranscribed={text => setDraft(current => current.trim() ? `${current.trim()} ${text}` : text)}
        />
    ) : null;
    // 影策画幅 / 张数胶囊：与设置 popover 共用同一份 overrides / config state，不产生第二套权威值。
    const ratioChips = (capability === "image" ? ["1:1", "4:3", "3:4", "16:9", "9:16"] : capability === "video" ? ["16:9", "9:16"] : [])
        .map(value => mediaRatioOptions.find(option => option.value === value))
        .filter((option): option is (typeof mediaRatioOptions)[number] => Boolean(option));
    const ratioSelected = (option: (typeof mediaRatioOptions)[number]) => {
        if (capability === "video") return normalizeVideoSizeValue(option.value) === videoSize;
        if (imageSize === option.value) return true;
        const pixels = parsePixelSize(imageSize);
        return !!pixels && option.height > 0 && Math.abs(pixels.width / pixels.height - option.width / option.height) < 0.02;
    };
    const quickParams = ratioChips.length > 0 ? (
        <div className="ch-params" data-testid="creative-quick-params">
            <span className="ch-param-label">{t("creativePad.params.ratio")}</span>
            {ratioChips.map(option => (
                <button
                    key={option.value}
                    type="button"
                    aria-pressed={ratioSelected(option)}
                    data-testid={`creative-ratio-${option.value.replace(":", "x")}`}
                    onClick={() => setOverride(capability === "video" ? "videoSize" : "imageSize", capability === "video" ? normalizeVideoSizeValue(option.value) : option.value)}
                    className="ch-pill"
                >
                    {option.value}
                </button>
            ))}
            {capability === "image" ? (
                <>
                    <span className="ch-param-divider" aria-hidden="true" />
                    <span className="ch-param-label">{t("creativePad.params.count")}</span>
                    {[1, 2, 4].map(count => (
                        <button
                            key={count}
                            type="button"
                            aria-pressed={Number(imageCount) === count}
                            data-testid={`creative-count-${count}`}
                            onClick={() => setOverride("imageCount", String(count))}
                            className="ch-pill"
                        >
                            {count}
                        </button>
                    ))}
                </>
            ) : null}
        </div>
    ) : null;

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
                    {voiceButton}
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
        <section className="ch-hero" data-testid="creative-launch-pad" aria-labelledby="creative-pad-title">
            <div className="ch-heading">
                <span className="ch-eyebrow" aria-hidden="true"><Sparkles /></span>
                <h1 id="creative-pad-title" className="ch-title">{t("creativePad.title")}</h1>
                <p className="ch-subtitle">{t("creativePad.subtitle")}</p>
                {historyCount > 0 && onOpenHistory ? (
                    <Button
                        type="text"
                        size="small"
                        className="ch-history"
                        data-testid="creative-history"
                        icon={<History className="size-3.5" />}
                        onClick={onOpenHistory}
                    >
                        {t("creativePad.history")}
                    </Button>
                ) : null}
            </div>

            <div className="ch-composer">
                <div className="ch-tabs" role="tablist" aria-label={t("creativePad.modeLabel")}>
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
                                className={cn("ch-tab", active && "font-semibold")}
                            >
                                <Icon className="size-4" aria-hidden="true" />
                                {t(`creativePad.modes.${key}`)}
                            </button>
                        );
                    })}
                </div>

                {textarea}
                {referenceChips}
                {quickParams}

                <div className="ch-actions" data-testid="creative-generation-settings">
                    {addReferenceButton}
                    {voiceButton}
                    {modelPicker}
                    {settingsControl}
                    <span className="ch-hint">{generates ? t("creativePad.generateHint") : t("creativePad.modeHint")}</span>
                    {submitButton}
                </div>
            </div>

            <div className="ch-examples">
                {[0, 1].map(index => {
                    const Icon = index === 0 ? Sparkles : WandSparkles;
                    return (
                        <button
                            key={`example-${index}`}
                            type="button"
                            data-testid={`creative-quick-example${index}`}
                            onClick={() => fillExample(t(`creativePad.examples.${mode}.${index}.text`))}
                            className="ch-example"
                        >
                            <span className="ch-example-icon" aria-hidden="true"><Icon /></span>
                            <span className="min-w-0 flex-1">
                                <span className="ch-example-title">{t(`creativePad.examples.${mode}.${index}.label`)}</span>
                                <span className="ch-example-hint">{t(`creativePad.examples.${mode}.${index}.hint`)}</span>
                            </span>
                            <ArrowUpRight className="ch-example-arrow" aria-hidden="true" />
                        </button>
                    );
                })}
                <button
                    type="button"
                    data-testid="creative-quick-reference"
                    onClick={() => setPickerOpen(true)}
                    className="ch-example"
                >
                    <span className="ch-example-icon" aria-hidden="true"><ImagePlus /></span>
                    <span className="min-w-0 flex-1">
                        <span className="ch-example-title">{t("creativePad.actions.fromReference.label")}</span>
                        <span className="ch-example-hint">{t("creativePad.actions.fromReference.hint")}</span>
                    </span>
                    <ArrowUpRight className="ch-example-arrow" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    data-testid="creative-quick-blank"
                    disabled={!hydrated}
                    onClick={() => start(false)}
                    className="ch-example disabled:opacity-50"
                >
                    <span className="ch-example-icon" aria-hidden="true"><LayoutGrid /></span>
                    <span className="min-w-0 flex-1">
                        <span className="ch-example-title">{t("creativePad.actions.blankCanvas.label")}</span>
                        <span className="ch-example-hint">{t("creativePad.actions.blankCanvas.hint")}</span>
                    </span>
                    <ArrowUpRight className="ch-example-arrow" aria-hidden="true" />
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
