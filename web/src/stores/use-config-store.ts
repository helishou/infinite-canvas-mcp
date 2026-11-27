import { useMemo } from "react";
import { create } from "zustand";
import { nanoid } from "nanoid";
import { WORKFLOW_ROUTE_UNSUPPORTED, builtinWorkflowName, resolveWorkflowForModel, scenarioFromReferenceCount, type ModelInputScenario } from "@basketikun/canvas-agent/model-workflow";

import i18n from "@/i18n";
import { fetchStructuredSetting, saveStructuredSetting } from "@/services/settings-api";

import { resolveWorkflowBindingForModel } from "@basketikun/canvas-agent/model-workflow";

export { WORKFLOW_ROUTE_UNSUPPORTED, builtinWorkflowName, scenarioFromReferenceCount } from "@basketikun/canvas-agent/model-workflow";
export type { ModelInputScenario } from "@basketikun/canvas-agent/model-workflow";

export type ApiCallFormat = "openai" | "openai-chat" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";
export const VIDEO_CONCAT_MODEL = "__local_video_concat__";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ModelWorkflowRouting = Partial<Record<ModelInputScenario, string>>;
/** 按输入场景存的工作流参数覆盖值（key = WorkflowField.id）。不同场景走不同工作流，参数也随之不同。 */
export type ModelWorkflowParams = Partial<Record<ModelInputScenario, Record<string, unknown>>>;
export const MODEL_INPUT_SCENARIOS: ModelInputScenario[] = ["text", "single", "multi"];
/** 场景中文标签（按能力区分「文生图 / 文生视频 / 文生文本 / 文生音频」）。 */
export const MODEL_SCENARIO_LABELS: Record<ModelCapability, Record<ModelInputScenario, string>> = {
    image: { text: "文生图", single: "单图", multi: "多图" },
    video: { text: "文生视频", single: "单图", multi: "多图" },
    text: { text: "文生文本", single: "单图", multi: "多图" },
    audio: { text: "文生音频", single: "单图", multi: "多图" },
};

export type ChannelModel = {
    /**
     * 暂时隐藏：模型还在渠道里（可随时恢复），但选择器里不列。
     * 用于「已迁移到引擎、本地副本待删除」这类过渡期。
     */
    hidden?: boolean;
    name: string;
    capability: ModelCapability;
    script?: string;
    /** 文本模型是否支持图片输入；缺省表示自动探测，true/false 为显式声明。 */
    supportsImages?: boolean;
    /**
     * 单段最多提交的参考音频数（影策 video.references.maxAudios → profile.MaxAudios）。
     * 从引擎 /v1/models 的 media_inputs.audios 真实能力导入；本地 H3 原生工作流
     * 没暴露该槽位时由登记脚本写入真实槽位数 3。缺省时执行链按 3 回落。
     */
    maxAudios?: number;
    /**
     * 视频能力（影策 DramaModelOption 的同名字段）。全部可选：缺省 = 未知/不限制，
     * 设置页不得据此告警。只由模型登记脚本从真实工作流派生、或引擎真实上报时写入，
     * 没有能力来源时不臆造默认值。
     */
    /** 能准确给出的作品画幅（如 "16:9"）；登记自工作流的画面比例选项。 */
    videoRatios?: string[];
    /** 作品可指定的分辨率档位（如 "720p"）；空数组表示显式声明「不提供可选档位」。 */
    videoResolutions?: string[];
    /** 是否同步生成对白与音效；false 仅在工作流确实无音频输出时登记。 */
    generateAudio?: boolean;
    /** 支持图生视频、可用于尾帧续接；false 表示只能并行出片。 */
    tailFrameChain?: boolean;
    /** 单段视频最长秒数；只在工作流有真实上限时登记，缺省不限制。 */
    maxVideoSeconds?: number;
    /**
     * 模型级提示词字数硬上限（影策 VideoReferenceConfig.PromptMaxChars，按码点计）。
     * 本地引擎实测不上报该值：只由设置页显式登记；缺省 = 未知/不限制，不臆造默认值。
     * 段提示词界面读 modelVideoCapabilitiesOf(...).promptMaxChars；undefined 时保持原软上限。
     */
    promptMaxChars?: number;
    /** ComfyUI 渠道：该模型对外暴露时可用的工作流（可挂多个）。 */
    workflows?: string[];
    /** ComfyUI 渠道：三种输入场景分别走哪个工作流；未配置的场景回退到第一个工作流。 */
    workflowRouting?: ModelWorkflowRouting;
    /** ComfyUI 渠道：三种输入场景各自的工作流参数覆盖（该场景走哪个工作流就用它的字段）。 */
    workflowParams?: ModelWorkflowParams;
    /**
     * 场景 → 内部实现的显式绑定。RunningHub 工作流档案用 profileId，本地工作流用文件名；
     * 旧的 workflows / workflowRouting 仍按本地文件解析，两者可共存。
     */
    workflowBindings?: ModelWorkflowBindings;
};

/** 场景绑定的内部实现：comfyui 指本地工作流文件，runninghub 指云端工作流档案。 */
export type ModelWorkflowBinding = { provider: "comfyui"; workflow: string } | { provider: "runninghub"; profileId: string };
export type ModelWorkflowBindings = Partial<Record<ModelInputScenario, ModelWorkflowBinding>>;

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
    kind?: "api" | "local" | "comfyui" | "codex-cli" | "hermes";
    /**
     * 渠道级额外参数（仅 OpenAI 协议有意义）：原样并入 /v1/images/generations 请求体。
     * 普通 OpenAI 服务忽略未知键；本地 media-engine 用它传 params / overrides 这类自定义参数。
     */
    extraBody?: Record<string, unknown>;
    /** 渠道自定义请求头（如 OpenCode Go 的 x-opencode-session）；内置鉴权头优先。 */
    headers?: Record<string, string>;
    /**
     * 渠道最大并发数（影策 ModelChannel.ConcurrencyLimit）。1-999；留空跟随全局
     * channelConcurrency。渠道按模型 capability 分文字/图片/视频/音频，故每类可分别设。
     */
    concurrencyLimit?: number;
};

export type AiConfig = {
    localComfyuiEnabled: boolean;
    channelMode: "remote" | "local";
    /** 全局渠道并发上限（影策 ChannelConcurrency）：渠道未单独设 concurrencyLimit 时采用。0/留空不限。 */
    channelConcurrency?: number;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    /** 画布右键翻译使用的文本模型；留空时按默认文本模型翻译。 */
    translationModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    /**
     * 视频工作台内部实现字段的本次取值，key = `模型::实现`（部分调用方用扁平 key）。
     * 后端 video-dispatcher 按 `model::workflow` 取值合并进工作流图。
     */
    selectedVideoModelFieldValues?: Record<string, Record<string, unknown>>;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    imageAlign16: boolean;
    background: string;
    count: string;
    canvasImageCount: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "preferences" | "prompt-sources" | "webdav" | "local-storage" | "connection";
export type ChannelCredentialsImportResult = { status: "created" | "updated" | "missing-base-url" | "invalid-base-url"; channelName?: string };

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

export const defaultConfig: AiConfig = {
    localComfyuiEnabled: true,
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    translationModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "auto",
    size: "1:1",
    imageAlign16: true,
    background: "",
    count: "1",
    canvasImageCount: "3",
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    hydrated: boolean;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    replaceConfig: (config: AiConfig) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    replaceWebdavConfig: (webdav: WebdavSyncConfig) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

/**
 * 严格 matcher（改动前的原始语义）：带 :: 时只按 channelId 锁定渠道，绝不跨渠道；
 * 无 :: 时才跨渠道按精确名找。readiness 这类「不能把已下线渠道当成可用」的判断必须用它。
 */
function findChannelModelExact(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

/** 跨渠道按精确模型名找：无 :: 时的原有语义，陈旧 channelId 时作为回退复用同一语义。 */
function findModelByNameAcrossChannels(config: AiConfig, name: string): { channel: ModelChannel; model: ChannelModel } | null {
    const channel = config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    // ① 精确匹配优先：命中即返回，原有精确匹配的优先级完全不变。
    const exact = findChannelModelExact(config, value);
    if (exact) return exact;
    // ② 精确匹配失败且值带 :: 时才回退：渠道 id 已失效（真实库里大量 local-comfyui:: /
    //    xq3...:: 陈旧段）或模型挪到了别的渠道，按精确模型名跨渠道再找一次。
    //    无 :: 的情况在 ① 里已经按名找过，不重复。仍要求精确名命中，工作流名不会误匹配。
    const decoded = decodeChannelModel(value);
    return decoded ? findModelByNameAcrossChannels(config, decoded.model) : null;
}

/** H3 原生 V15 节点的 3 个参考音频槽位；模型未声明 maxAudios 时的回落值。 */
export const DEFAULT_VIDEO_MAX_AUDIOS = 3;

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

function normalizeMaxAudios(value: unknown): number | undefined {
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    if (String(value).trim() === "") return undefined;
    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** 当前视频模型的参考音频上限（影策 profile.MaxAudios）；显式配置优先，否则按 H3 原生默认。 */
export function modelMaxAudiosOf(config: AiConfig, value: string): number {
    return normalizeMaxAudios(findChannelModel(config, value)?.model.maxAudios) ?? DEFAULT_VIDEO_MAX_AUDIOS;
}

/** 段级实际上限：只有 ref2va 模式才允许参考音频（影策其它模式 MaxAudios=0）。 */
export function segmentAudioLimitOf(config: AiConfig, value: string, taskMode: unknown): number {
    return String(taskMode || "").toLowerCase() === "ref2va" ? modelMaxAudiosOf(config, value) : 0;
}

/**
 * 影策 DramaModelOption 的同名视频能力字段。全部可选，缺省表示「未知/不限制」。
 * 设置页拿它接真告警：字段不存在就不要 warn，绝不把 undefined 当成 false/[] 处理。
 */
export type ModelVideoCapabilities = Pick<ChannelModel, "videoRatios" | "videoResolutions" | "generateAudio" | "tailFrameChain" | "maxVideoSeconds" | "promptMaxChars">;

/** 把 H3 下拉的 "16:9 (Widescreen)" 归一到影策契约的裸 "16:9"；非比例选项不登记。 */
function canonicalRatios(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || !item.trim()) return undefined;
        const match = /^(\d+)\s*:\s*(\d+)/.exec(item.trim());
        if (!match) continue;
        const a = Number(match[1]);
        const b = Number(match[2]);
        if (!a || !b) continue;
        const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
        const canonical = `${a / gcd(a, b)}:${b / gcd(a, b)}`;
        if (!out.includes(canonical)) out.push(canonical);
    }
    return out;
}

/** 只做类型校验与画幅归一，不补任何默认值；非法/缺失字段不进入结果。 */
export function normalizeModelVideoCapabilities(value: unknown): ModelVideoCapabilities {
    const model = value && typeof value === "object" && !Array.isArray(value) ? value as ChannelModel : undefined;
    if (!model) return {};
    const out: ModelVideoCapabilities = {};
    const ratios = canonicalRatios(model.videoRatios);
    if (ratios?.length) out.videoRatios = ratios;
    const resolutions = Array.isArray(model.videoResolutions) && model.videoResolutions.every((item) => typeof item === "string" && item.trim())
        ? model.videoResolutions.slice()
        : undefined;
    if (resolutions) out.videoResolutions = resolutions;
    // 用户口径：视频模型默认都能出声；只有显式登记 generateAudio:false 才当无声模型。
    out.generateAudio = typeof model.generateAudio === "boolean" ? model.generateAudio : true;
    if (typeof model.tailFrameChain === "boolean") out.tailFrameChain = model.tailFrameChain;
    if (typeof model.maxVideoSeconds === "number" && Number.isFinite(model.maxVideoSeconds) && model.maxVideoSeconds > 0) {
        out.maxVideoSeconds = model.maxVideoSeconds;
    }
    if (typeof model.promptMaxChars === "number" && Number.isSafeInteger(model.promptMaxChars) && model.promptMaxChars > 0) {
        out.promptMaxChars = model.promptMaxChars;
    }
    return out;
}

/**
 * 当前模型的真实视频能力（来自模型登记/引擎上报，不存在返回空对象）。
 * 调用方按「缺字段 = 不告警」处理；normalizeConfig 也用同一个校验器保字段。
 */
export function modelVideoCapabilitiesOf(config: AiConfig, value: string): ModelVideoCapabilities {
    return normalizeModelVideoCapabilities(findChannelModel(config, value)?.model);
}

/**
 * 制作设置页显式登记模型的提示词字数上限：只改命中的渠道模型，正数整数才写入，
 * 清空则删除字段回到「缺省不限制」。本地引擎实测不上报该值，这里不填任何隐式默认值。
 */
export function setModelPromptMaxChars(config: AiConfig, value: string, maxChars: number | undefined): AiConfig {
    const match = findChannelModel(config, value);
    if (!match) return config;
    const { promptMaxChars: _previous, ...rest } = match.model;
    const valid = typeof maxChars === "number" && Number.isSafeInteger(maxChars) && maxChars > 0;
    const nextModel: ChannelModel = valid ? { ...rest, promptMaxChars: maxChars } : rest;
    const channels = config.channels.map((channel) => channel.id === match.channel.id
        ? { ...channel, models: channel.models.map((model) => model === match.model ? nextModel : model) }
        : channel);
    return { ...config, channels };
}

/**
 * 设置页显式登记视频模型的单次时长上限（影策 maxVideoSeconds）：只改命中的渠道模型，
 * 正整数才写入，留空/非法删除字段回到「未知/不限制」。不写 0，也不补默认 15。
 */
export function setModelMaxVideoSeconds(config: AiConfig, value: string, seconds: number | undefined): AiConfig {
    const match = findChannelModel(config, value);
    if (!match) return config;
    const { maxVideoSeconds: _previous, ...rest } = match.model;
    const valid = typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0;
    const nextModel: ChannelModel = valid ? { ...rest, maxVideoSeconds: seconds } : rest;
    const channels = config.channels.map((channel) => channel.id === match.channel.id
        ? { ...channel, models: channel.models.map((model) => model === match.model ? nextModel : model) }
        : channel);
    return { ...config, channels };
}

export const isAudioReferenceMode = (taskMode: unknown): boolean => String(taskMode || "").toLowerCase() === "ref2va";

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (capability === "video" && value === VIDEO_CONCAT_MODEL) return true;
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return [
        ...(capability === "video" ? [VIDEO_CONCAT_MODEL] : []),
        ...config.channels.flatMap((channel) =>
            channel.models
                .filter((model) => model.capability === capability && !model.hidden)
                .map((model) => encodeChannelModel(channel.id, model.name)),
        ),
    ];
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

/** 读取某模型挂载的工作流与场景路由。 */
export function modelWorkflowConfig(config: AiConfig, value: string): { workflows: string[]; routing: ModelWorkflowRouting } {
    const model = findChannelModel(config, value)?.model;
    return { workflows: model?.workflows || [], routing: model?.workflowRouting || {} };
}

/**
 * 解析某次生成实际要跑的工作流：
 * 1. 命中该模型在当前输入场景（文生 / 单图 / 多图）下的路由配置 → 用它；
 * 2. 该场景被显式标记为「不支持」→ 返回空字符串（调用方给出明确报错，不回退）；
 * 3. 只配了工作流列表没配路由 → 用列表第一个（「一个工作流做三份工作」即此情形）；
 * 4. 都没配 → 回退到模型名对应的内置工作流；ComfyUI 渠道下模型名本身也视作工作流名。
 */
export function resolveModelWorkflow(config: AiConfig, value: string, referenceCount: number) {
    const result = resolveWorkflowForModel(config, value, referenceCount);
    return result.ok ? result.workflow : "";
}

/** 该模型在当前输入场景下是否被显式标记为「不支持」。 */
export function modelScenarioUnsupported(config: AiConfig, value: string, referenceCount: number) {
    const result = resolveWorkflowForModel(config, value, referenceCount);
    return !result.ok && result.reason === "unsupported";
}

/** 解析不到工作流时的报错文案：区分「没配工作流」与「该输入场景被标记为不支持」。 */
export function modelWorkflowMissingMessage(config: AiConfig, value: string, referenceCount: number) {
    const name = modelOptionName(value).trim();
    const scenario = scenarioFromReferenceCount(referenceCount);
    if (modelScenarioUnsupported(config, value, referenceCount)) {
        const capability = findChannelModel(config, value)?.model.capability || "image";
        return `模型「${name}」不支持${MODEL_SCENARIO_LABELS[capability][scenario]}输入，请改用其它模型或调整模型配置`;
    }
    return `模型「${name}」没有可用的本地实现，请到模型设置里完成配置`;
}

/** 该模型是否挂了工作流（用于 UI 展示与「是否走本地工作流」判断）。 */
export function modelHasWorkflowConfig(config: AiConfig, value: string) {
    return modelWorkflowConfig(config, value).workflows.length > 0;
}

/**
 * 读取某模型在当前输入场景下的内部实现参数覆盖值（模型设置里按场景配置）。
 * 调用方把它作为字段默认值：节点/工作台上手填的值优先级更高。
 */
export function resolveModelWorkflowParams(config: AiConfig, value: string, referenceCount: number): Record<string, unknown> {
    // 必须走绑定版解析：RunningHub 档案的参数按场景存在 workflowBindings 对应的
    // workflowParams 里，用旧的只认本地工作流名的解析会读不到这些值。
    const result = resolveWorkflowBindingForModel(config, value, referenceCount);
    return result.ok ? result.params : {};
}

function isAiConfigReady(config: AiConfig, model: string) {
    if (model === VIDEO_CONCAT_MODEL) return true;
    // 用严格 matcher：回退只用于读能力，不能让已下线渠道的同名模型被当成「可用」，
    // 否则已删除 provider 的旧段会被误判为可重试。
    const match = findChannelModelExact(config, model);
    if (!match) return false;
    const channel = match.channel;
    // codex-cli 与 hermes（本地 ACP 导演 agent）的鉴权都在 agent 进程侧，不需要渠道 apiKey。
    if (channel.kind === "codex-cli" || channel.kind === "hermes") return Boolean(model.trim());
    if (channel.kind === "comfyui") return Boolean(model.trim() && channel.baseUrl.trim());
    // 本地服务（如 media-engine）默认不带鉴权，有 baseUrl 就算可用；远端才强制要 apiKey。
    if (channel.kind === "local") return Boolean(model.trim() && channel.baseUrl.trim());
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

let configSyncQueue = Promise.resolve();
let webdavSyncQueue = Promise.resolve();

/**
 * 配置编辑按字符触发 updateConfig（提示词输入框尤甚）。合并成「至多一个在途请求 +
 * 一个待发快照」，避免逐键 PUT 把串行队列排到秒级；离散设置最多延后一个防抖窗口。
 */
const CONFIG_SYNC_DEBOUNCE_MS = 300;
let configSyncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingConfigSync: AiConfig | null = null;
let latestConfigSync: AiConfig | null = null;
let configSyncInFlight = 0;

/** True while local edits are not yet acknowledged by Backend; Backend events must not clobber them. */
function hasPendingConfigSync() {
    return configSyncInFlight > 0 || latestConfigSync !== null || pendingConfigSync !== null || configSyncTimer !== null;
}

/** Send the pending snapshot now; `force` is used by import and page unload where waiting would lose the edit. */
function flushConfigSync(force = false) {
    if (configSyncTimer !== null) {
        clearTimeout(configSyncTimer);
        configSyncTimer = null;
    }
    if (pendingConfigSync) {
        latestConfigSync = pendingConfigSync;
        pendingConfigSync = null;
    }
    if (!latestConfigSync) return;
    // 在途写入未完成时不再叠加请求：完成后补发最新快照，避免队列堆积。
    if (!force && configSyncInFlight > 0) {
        scheduleConfigSync();
        return;
    }
    configSyncQueue = configSyncQueue
        .then(async () => {
            const config = latestConfigSync;
            if (!config) return;
            latestConfigSync = null;
            configSyncInFlight += 1;
            try {
                const [api, backend] = await Promise.all([import("@/services/backend-api"), import("@/stores/use-backend-store")]);
                if (backend.useBackendStore.getState().connected) await api.syncBackendAiConfig(config);
            } finally {
                configSyncInFlight -= 1;
                if (pendingConfigSync) scheduleConfigSync();
            }
        })
        .catch(() => undefined);
}

function scheduleConfigSync() {
    if (configSyncTimer !== null) return;
    configSyncTimer = setTimeout(() => {
        configSyncTimer = null;
        flushConfigSync();
    }, CONFIG_SYNC_DEBOUNCE_MS);
}

function syncConfigToBackend(config: AiConfig) {
    if (typeof window === "undefined") return;
    pendingConfigSync = config;
    scheduleConfigSync();
}

function syncWebdavToBackend(webdav: WebdavSyncConfig) {
    if (typeof window === "undefined") return;
    webdavSyncQueue = webdavSyncQueue.then(() => saveStructuredSetting("webdav", webdav)).catch(() => undefined);
}

/**
 * 立即写入 ai.config 并在后端确认后才发布到 Store；失败直接抛给调用方。
 * 与 debounce 同步链共用同一队列/端点，但不会像后台同步那样静默吞错。
 */
function commitAiConfig(input: AiConfig, expected: AiConfig, changedError: string): Promise<void> {
    flushConfigSync(true);
    const config = normalizeConfig(input);
    const before = expected;
    const operation = configSyncQueue.then(async () => {
        if (JSON.stringify(useConfigStore.getState().config) !== JSON.stringify(before)) throw new Error(changedError);
        const { syncBackendAiConfig } = await import("@/services/backend-api");
        await syncBackendAiConfig(config);
        if (useConfigStore.getState().config === before) useConfigStore.setState({ config });
    });
    configSyncQueue = operation.catch(() => undefined);
    return operation;
}

/** Import waits behind pending edits and only publishes acknowledged values. */
export function importConfigConfirmed(input: AiConfig, expected = useConfigStore.getState().config): Promise<void> {
    return commitAiConfig(input, expected, "CONFIG_CHANGED_DURING_IMPORT");
}

/** 设置页保存单模型能力：复用 import 的写入队列，失败抛错供界面明示（不静默）。 */
export function saveAiConfigConfirmed(input: AiConfig, expected = useConfigStore.getState().config): Promise<void> {
    return commitAiConfig(input, expected, "CONFIG_CHANGED_DURING_SAVE");
}

export function importWebdavConfirmed(input: WebdavSyncConfig, expected = useConfigStore.getState().webdav): Promise<void> {
    const webdav = { ...defaultWebdavSyncConfig, ...input };
    const before = expected;
    const operation = webdavSyncQueue.then(async () => {
        if (JSON.stringify(useConfigStore.getState().webdav) !== JSON.stringify(before)) throw new Error("CONFIG_CHANGED_DURING_IMPORT");
        await saveStructuredSetting("webdav", webdav);
        if (useConfigStore.getState().webdav === before) useConfigStore.setState({ webdav });
    });
    webdavSyncQueue = operation.catch(() => undefined);
    return operation;
}

function normalizeConfig(input: Partial<AiConfig>): AiConfig {
    // Discard retired proxy settings when loading Backend data or importing old exports.
    const { proxyEnabled: _proxyEnabled, proxyUrl: _proxyUrl, ...current } = input as Partial<AiConfig> & { proxyEnabled?: unknown; proxyUrl?: unknown };
    const config = { ...defaultConfig, ...current };
    if (!Array.isArray(input.channels)) config.channels = [];
    const channels = normalizeChannels(config);
    return {
        ...config,
        localComfyuiEnabled: config.localComfyuiEnabled !== false,
        channelMode: "local",
        apiFormat: normalizeApiFormat(config.apiFormat),
        channels,
        models: modelOptionsFromChannels(channels),
        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
        videoModel: normalizeModelOptionValue(config.videoModel, channels),
        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
        translationModel: normalizeModelOptionValue(config.translationModel || config.textModel || config.model, channels),
        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
        audioVoice: config.audioVoice || defaultConfig.audioVoice,
        audioFormat: config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: config.audioInstructions || "",
        reasoningEffort: config.reasoningEffort || "auto",
        videoSeconds: config.videoSeconds || "6",
        vquality: config.vquality || "720",
        videoGenerateAudio: config.videoGenerateAudio || "true",
        videoWatermark: config.videoWatermark || "false",
        imageAlign16: config.imageAlign16 !== false,
        canvasImageCount: config.canvasImageCount || "3",
    };
}

function readLegacyConfigState(): { config?: Partial<AiConfig>; webdav?: Partial<WebdavSyncConfig> } | null {
    try {
        const stored = JSON.parse(localStorage.getItem(CONFIG_STORE_KEY) || "null") as { state?: { config?: Partial<AiConfig>; webdav?: Partial<WebdavSyncConfig> } } | null;
        return stored?.state || null;
    } catch {
        return null;
    }
}

// Backend SQLite 是配置唯一权威；localStorage 只在首次迁移旧渠道与 WebDAV 配置时读取一次。
export async function hydrateConfigFromBackend(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    try {
        const [{ fetchBackendAiConfig, syncBackendAiConfig }, { useBackendStore }] = await Promise.all([import("@/services/backend-api"), import("@/stores/use-backend-store")]);
        if (!useBackendStore.getState().connected) return false;
        const [response, storedWebdav] = await Promise.all([fetchBackendAiConfig(), fetchStructuredSetting<WebdavSyncConfig>("webdav")]);
        const legacy = readLegacyConfigState();
        // 后端返回空对象/缺 channels 时不当作有效配置：否则 normalizeConfig 会把 channels 归一成 []，
        // 后续任意设置保存都会 PUT 这份空 channels，把用户渠道反复抹掉（常驻 bug）。
        const backendConfig = response?.config as Partial<AiConfig> | null | undefined;
        const backendHasChannels = Array.isArray(backendConfig?.channels) && backendConfig.channels.length > 0;
        let config = backendHasChannels ? normalizeConfig(backendConfig!) : null;
        if (!config && legacy?.config && Array.isArray(legacy.config.channels) && legacy.config.channels.length > 0) {
            config = normalizeConfig(legacy.config);
            await syncBackendAiConfig(config);
        }
        let webdav = storedWebdav;
        if (!webdav && legacy?.webdav) {
            webdav = { ...defaultWebdavSyncConfig, ...legacy.webdav };
            await saveStructuredSetting("webdav", webdav);
        }
        useConfigStore.setState({
            config: config || normalizeConfig({}),
            webdav: { ...defaultWebdavSyncConfig, ...(webdav || {}) },
            hydrated: true,
        });
        localStorage.removeItem(CONFIG_STORE_KEY);
        return true;
    } catch {
        return false;
    }
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
    config: defaultConfig,
    webdav: defaultWebdavSyncConfig,
    hydrated: false,
    isConfigOpen: false,
    configTab: "channels",
    shouldPromptContinue: false,
    updateConfig: (key, value) => {
        const config = normalizeConfig({ ...get().config, [key]: value });
        set({ config });
        syncConfigToBackend(config);
    },
    replaceConfig: (next) => {
        const config = normalizeConfig(next);
        set({ config });
        syncConfigToBackend(config);
    },
    importChannelCredentials: (input) => {
        const config = get().config;
        const result = upsertChannelCredentials(config, input);
        if (result.config !== config) {
            const next = normalizeConfig(result.config);
            set({ config: next });
            syncConfigToBackend(next);
        }
        return { status: result.status, channelName: result.channelName };
    },
    updateWebdavConfig: (key, value) => {
        const webdav = { ...get().webdav, [key]: value };
        set({ webdav });
        syncWebdavToBackend(webdav);
    },
    replaceWebdavConfig: (next) => {
        const webdav = { ...defaultWebdavSyncConfig, ...next };
        set({ webdav });
        syncWebdavToBackend(webdav);
    },
    isAiConfigReady: (config, model) => isAiConfigReady(config, model),
    openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
    setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
    clearPromptContinue: () => set({ shouldPromptContinue: false }),
}));

// 订阅 backend 事件，做 source-of-truth 同步：
// - backend-event 收到 settings.updated：本机或其它 tab 改动了 ai.config
if (typeof window !== "undefined") {
    // 防抖窗口内关闭标签页时补发最后一次编辑，避免静默丢配置。
    window.addEventListener("pagehide", () => flushConfigSync(true));
    window.addEventListener("backend-event", (event) => {
        const detail = (event as CustomEvent).detail as { type?: string; entityId?: string } | undefined;
        if (detail?.type !== "settings.updated") return;
        // 本地写入未确认时以本地为准：用旧回执覆盖输入框会让正在打字的内容跳回上一版。
        if (detail.entityId === "ai.config" && hasPendingConfigSync()) return;
        if (detail.entityId === "ai.config" || detail.entityId === "webdav.config") {
            void hydrateConfigFromBackend();
        }
    });
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        const workflows = typeof item === "string" ? [] : normalizeWorkflowList(item.workflows);
        const workflowRouting = typeof item === "string" ? undefined : normalizeWorkflowRouting(item.workflowRouting, workflows);
        const workflowParams = typeof item === "string" ? undefined : normalizeModelWorkflowParams(item.workflowParams, workflows, workflowRouting);
        const workflowBindings = typeof item === "string" ? undefined : normalizeWorkflowBindings(item.workflowBindings);
        const supportsImages = typeof item === "string" ? undefined : item.supportsImages;
        const maxAudios = typeof item === "string" ? undefined : normalizeMaxAudios(item.maxAudios);
        const videoCapabilities = typeof item === "string" ? {} : normalizeModelVideoCapabilities(item);
        result.push({ name, capability, script, ...(supportsImages === undefined ? {} : { supportsImages }), ...(maxAudios === undefined ? {} : { maxAudios }), ...videoCapabilities, ...(workflows.length ? { workflows } : {}), ...(workflowRouting ? { workflowRouting } : {}), ...(workflowParams ? { workflowParams } : {}), ...(workflowBindings ? { workflowBindings } : {}) });
    }
    return result;
}

function normalizeWorkflowList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
}

/**
 * 显式绑定只保留结构完整的项：provider 必须是已知的两个之一，且带上对应标识。
 * 半成品绑定会让场景既没有本地工作流、也没有可执行的云端档案。
 */
function normalizeWorkflowBindings(value: unknown): ModelWorkflowBindings | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const bindings: ModelWorkflowBindings = {};
    for (const scenario of MODEL_INPUT_SCENARIOS) {
        const raw = source[scenario];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const provider = String((raw as Record<string, unknown>).provider || "");
        if (provider === "runninghub") {
            const profileId = String((raw as Record<string, unknown>).profileId || "").trim();
            if (profileId) bindings[scenario] = { provider: "runninghub", profileId };
            continue;
        }
        if (provider === "comfyui") {
            const workflow = String((raw as Record<string, unknown>).workflow || "").trim();
            if (workflow) bindings[scenario] = { provider: "comfyui", workflow };
        }
    }
    return Object.keys(bindings).length ? bindings : undefined;
}

/** 路由里的工作流必须在挂载列表内；工作流被移除时回落到列表第一个。 */
function normalizeWorkflowRouting(value: unknown, workflows: string[]): ModelWorkflowRouting | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const routing: ModelWorkflowRouting = {};
    for (const scenario of MODEL_INPUT_SCENARIOS) {
        const routed = String(source[scenario] || "").trim();
        if (!routed) continue;
        // 「不支持」是显式声明的场景状态，不属于工作流列表，不能按「已被移除」回落。
        routing[scenario] = routed === WORKFLOW_ROUTE_UNSUPPORTED ? routed : workflows.length && !workflows.includes(routed) ? workflows[0] : routed;
    }
    return Object.keys(routing).length ? routing : undefined;
}

/**
 * 场景路由的生效值：配置过的按配置（含「不支持」哨兵），没配置的落到第一个工作流
 * （「一个工作流做三份工作」即此情形）。展示口径与保存口径都以它为准。
 */
export function effectiveWorkflowRouting(workflows: string[], routing: ModelWorkflowRouting | undefined): ModelWorkflowRouting {
    const fallback = workflows[0] || "";
    const next: ModelWorkflowRouting = {};
    for (const scenario of MODEL_INPUT_SCENARIOS) {
        const routed = routing?.[scenario];
        next[scenario] = routed === WORKFLOW_ROUTE_UNSUPPORTED ? routed : routed && workflows.includes(routed) ? routed : fallback;
    }
    return next;
}

/**
 * 场景参数只在「该场景确实路由到某个已挂工作流」时才保留：
 * 场景被标记为「不支持」、或它指向的工作流被移除后，对应参数一并丢弃，避免存下用不到的脏数据。
 */
export function normalizeModelWorkflowParams(value: unknown, workflows: string[], routing: ModelWorkflowRouting | undefined): ModelWorkflowParams | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const effective = effectiveWorkflowRouting(workflows, routing);
    const params: ModelWorkflowParams = {};
    for (const scenario of MODEL_INPUT_SCENARIOS) {
        const routed = effective[scenario];
        if (!routed || routed === WORKFLOW_ROUTE_UNSUPPORTED || !workflows.includes(routed)) continue;
        const raw = source[scenario];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const entries = Object.entries(raw as Record<string, unknown>).filter(([, item]) => item !== undefined && item !== null && item !== "");
        if (entries.length) params[scenario] = Object.fromEntries(entries);
    }
    return Object.keys(params).length ? params : undefined;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    const headers = normalizeChannelHeaders(channel?.headers);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || (channel?.kind === "codex-cli" ? "" : defaultBaseUrlForApiFormat(apiFormat)),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
        kind: channel?.kind || "api",
        ...(headers ? { headers } : {}),
        ...(Number.isFinite(channel?.concurrencyLimit) && Number(channel?.concurrencyLimit) > 0 ? { concurrencyLimit: Math.floor(Number(channel?.concurrencyLimit)) } : {}),
    };
}

function normalizeChannelHeaders(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key.trim(), typeof item === "string" ? item.trim() : ""] as const)
        .filter(([key, item]) => key && item && !/[\r\n]/.test(key + item));
    return entries.length ? Object.fromEntries(entries) : undefined;
}

export function upsertChannelCredentials(config: AiConfig, input: { baseUrl?: string | null; apiKey?: string | null }): ChannelCredentialsImportResult & { config: AiConfig } {
    const rawBaseUrl = input.baseUrl?.trim() || "";
    if (!rawBaseUrl) return { status: "missing-base-url", config };
    let baseUrl: string;
    try {
        const url = new URL(rawBaseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") return { status: "invalid-base-url", config };
        url.hash = "";
        baseUrl = url.toString().replace(/\/+$/, "");
    } catch {
        return { status: "invalid-base-url", config };
    }
    const key = baseUrl.replace(/\/v1$/i, "").toLowerCase();
    const apiKey = input.apiKey?.trim() || "";
    const index = config.channels.findIndex((channel) => channel.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase() === key);
    if (index >= 0) {
        const existing = config.channels[index];
        const channels = config.channels.map((channel, itemIndex) => (itemIndex === index ? { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) } : channel));
        return { status: "updated", channelName: existing.name, config: { ...config, channels } };
    }
    const channel = createModelChannel({ name: new URL(baseUrl).hostname.replace(/^(?:www|api)\./i, "") || i18n.t("config.channels.newName"), baseUrl, apiKey, apiFormat: "openai", models: [] });
    return { status: "created", channelName: channel.name, config: { ...config, channels: [...config.channels, channel] } };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

/**
 * 模型实际使用的实现来源：任一输入场景绑定到 RunningHub 档案就算云端。
 * ComfyUI 渠道本身可以挂云端实现，只显示渠道名会让人以为跑的是本地工作流。
 */
export function modelImplementationSource(config: AiConfig, value: string): "runninghub" | "comfyui" | null {
    const decoded = decodeChannelModel(value);
    if (!decoded) return null;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    const model = channel?.models?.find((item) => item.name === decoded.model);
    if (!model) return null;
    const bindings = Object.values(model.workflowBindings || {});
    return bindings.some((binding) => binding?.provider === "runninghub") ? "runninghub" : "comfyui";
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    if (!channel) return decoded.model;
    // 云端实现优先说明真实执行来源，否则沿用渠道名。
    const source = modelImplementationSource(config, value);
    if (source === "runninghub") return `${decoded.model}（RunningHub）`;
    return `${decoded.model}（${channel.name}）`;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return (
        matched ||
        config.channels[0] ||
        createModelChannel({
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            apiFormat: config.apiFormat,
            models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })),
        })
    );
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) => createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }));
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    if (apiFormat === "gemini") return "gemini";
    if (apiFormat === "openai-chat") return "openai-chat";
    return "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}
