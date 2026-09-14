import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import {
    WORKFLOW_ROUTE_UNSUPPORTED,
    builtinWorkflowName,
    resolveWorkflowForModel,
    scenarioFromReferenceCount,
    type ModelInputScenario,
} from "@basketikun/canvas-agent/model-workflow";

import i18n from "@/i18n";

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
    name: string;
    capability: ModelCapability;
    script?: string;
    /** ComfyUI 渠道：该模型对外暴露时可用的工作流（可挂多个）。 */
    workflows?: string[];
    /** ComfyUI 渠道：三种输入场景分别走哪个工作流；未配置的场景回退到第一个工作流。 */
    workflowRouting?: ModelWorkflowRouting;
    /** ComfyUI 渠道：三种输入场景各自的工作流参数覆盖（该场景走哪个工作流就用它的字段）。 */
    workflowParams?: ModelWorkflowParams;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
    kind?: "api" | "comfyui";
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    comfyuiBasePath: string;
    proxyEnabled: boolean;
    proxyUrl: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "local-proxy" | "preferences" | "prompt-sources" | "webdav" | "local-storage";
export type ChannelCredentialsImportResult = { status: "created" | "updated" | "missing-base-url" | "invalid-base-url"; channelName?: string };

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const LOCAL_PROXY_PACKAGE = "@basketikun/canvas-proxy";
export const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:23210";

export const defaultConfig: AiConfig = {
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
    background: "",
    count: "1",
    canvasImageCount: "3",
    comfyuiBasePath: "",
    proxyEnabled: false,
    proxyUrl: DEFAULT_LOCAL_PROXY_URL,
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
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
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

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (capability === "video" && value === VIDEO_CONCAT_MODEL) return true;
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    if (currentModel && modelMatchesCapability(config, currentModel, capability)) return currentModel;
    if (defaultModel && modelMatchesCapability(config, defaultModel, capability)) return defaultModel;
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return [...(capability === "video" ? [VIDEO_CONCAT_MODEL] : []), ...config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)))];
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
        return `模型「${name}」不支持${MODEL_SCENARIO_LABELS[capability][scenario]}输入（已在渠道设置里把该场景标记为「不支持」），请改用其它模型或调整它的工作流路由`;
    }
    return `模型「${name}」没有可用工作流，请到渠道设置里为它配置工作流`;
}

/** 该模型是否挂了工作流（用于 UI 展示与「是否走本地工作流」判断）。 */
export function modelHasWorkflowConfig(config: AiConfig, value: string) {
    return modelWorkflowConfig(config, value).workflows.length > 0;
}

/**
 * 读取某模型在当前输入场景下的工作流参数覆盖值（渠道设置里按场景配的默认参数）。
 * 调用方把它作为字段默认值：节点/工作台上手填的值优先级更高。
 */
export function resolveModelWorkflowParams(config: AiConfig, value: string, referenceCount: number): Record<string, unknown> {
    const result = resolveWorkflowForModel(config, value, referenceCount);
    return result.ok ? result.params : {};
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    if (channel.kind === "comfyui") return Boolean(model.trim() && channel.baseUrl.trim());
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

function syncConfigToBackend(config: AiConfig) {
    if (typeof window === "undefined") return;
    void Promise.all([
        import("@/services/backend-api"),
        import("@/stores/use-backend-store"),
    ]).then(([api, backend]) => {
        if (backend.useBackendStore.getState().connected) return api.syncBackendAiConfig(config);
        return undefined;
    }).catch(() => undefined);
}

// 从 backend 拉 ai.config：source of truth。拉到就用 backend 的（同时写回 localStorage 当缓存）；
// 拉不到（后端没数据 / 离线）就保持当前 zustand 状态（localStorage 里的旧值）不动，绝不反向后端写默认配置。
async function hydrateConfigFromBackend() {
    if (typeof window === "undefined") return;
    try {
        const [{ fetchBackendAiConfig }, { useBackendStore }] = await Promise.all([
            import("@/services/backend-api"),
            import("@/stores/use-backend-store"),
        ]);
        if (!useBackendStore.getState().connected) return;
        const response = await fetchBackendAiConfig();
        if (!response || response.config === null || response.config === undefined) return;
        const next = response.config as Partial<AiConfig>;
        // 只在 backend 数据与本地不同时写，避免无谓的 persist 触发
        const current = useConfigStore.getState().config;
        if (JSON.stringify(current) === JSON.stringify(next)) return;
        useConfigStore.setState({ config: { ...defaultConfig, ...next, channels: Array.isArray(next.channels) ? next.channels : [] } });
    } catch {
        // 后端拉取失败不阻塞 UI：保留 localStorage 兜底
    }
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) => {
                const config = { ...get().config, [key]: value };
                set({ config });
                syncConfigToBackend(config);
            },
            importChannelCredentials: (input) => {
                const config = get().config;
                const result = upsertChannelCredentials(config, input);
                if (result.config !== config) {
                    set({ config: result.config });
                    syncConfigToBackend(result.config);
                }
                return { status: result.status, channelName: result.channelName };
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                if (!Array.isArray(persistedConfig.channels)) config.channels = [];
                const channels = normalizeChannels(config);
                const models = modelOptionsFromChannels(channels);
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: {
                        ...config,
                        channelMode: "local",
                        apiFormat: normalizeApiFormat(config.apiFormat),
                        channels,
                        models,
                        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
                        videoModel: normalizeModelOptionValue(config.videoModel, channels),
                        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
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
                        canvasImageCount: config.canvasImageCount || "3",
                        proxyEnabled: Boolean(config.proxyEnabled),
                        proxyUrl: normalizeLocalProxyUrl(config.proxyUrl || DEFAULT_LOCAL_PROXY_URL) || DEFAULT_LOCAL_PROXY_URL,
                    },
                };
            },
            // 注意：之前这里有 onRehydrateStorage 回调，hydrate 完会把 localStorage 反向写回 backend。
            // 这会让"清 localStorage → 首次打开"瞬间把 backend 的真实配置覆盖成 defaultConfig，是数据丢失 bug。
            // 现在的 source of truth 是 backend（见 hydrateConfigFromBackend），localStorage 仅作离线缓存。
        },
    ),
);

// 订阅 backend 事件，做 source-of-truth 同步：
// - backend-connected：连接刚建立时拉一次
// - backend-event 收到 settings.updated：本机或其它 tab 改动了 ai.config
if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => { void hydrateConfigFromBackend(); });
    window.addEventListener("backend-event", (event) => {
        const detail = (event as CustomEvent).detail as { type?: string; entityId?: string } | undefined;
        if (detail?.type === "settings.updated" && detail.entityId === "ai.config") {
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
        result.push({ name, capability, script, ...(workflows.length ? { workflows } : {}), ...(workflowRouting ? { workflowRouting } : {}), ...(workflowParams ? { workflowParams } : {}) });
    }
    return result;
}

function normalizeWorkflowList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
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
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
        kind: channel?.kind || "api",
    };
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
    } catch { return { status: "invalid-base-url", config }; }
    const key = baseUrl.replace(/\/v1$/i, "").toLowerCase();
    const apiKey = input.apiKey?.trim() || "";
    const index = config.channels.findIndex((channel) => channel.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase() === key);
    if (index >= 0) {
        const existing = config.channels[index];
        const channels = config.channels.map((channel, itemIndex) => itemIndex === index ? { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) } : channel);
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

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
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
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
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
    const channels = persistedChannels.map((channel, index) => {
        const normalized = createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        });
        // 17372 was briefly used as the Agent gateway in the first local-channel build.
        // Migrate that exact generated default; custom ComfyUI ports remain untouched.
        return normalized.kind === "comfyui" && normalized.baseUrl.replace(/\/$/, "") === "http://127.0.0.1:17372"
            ? { ...normalized, baseUrl: "http://127.0.0.1:8188" }
            : normalized;
    });
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
    return withLocalProxy(`${apiBaseUrl}${path}`);
}

export function normalizeLocalProxyUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Routes external provider traffic through the optional loopback proxy, never through itself or the local backend. */
export function withLocalProxy(url: string) {
    const { proxyEnabled, proxyUrl } = useConfigStore.getState().config;
    if (!proxyEnabled || !/^https?:\/\//i.test(url)) return url;
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base) return url;
    try {
        const target = new URL(url);
        const proxy = new URL(base);
        if (target.origin === proxy.origin || isLoopbackHost(target.hostname)) return url;
    } catch {
        return url;
    }
    return `${base}/${url}`;
}

function isLoopbackHost(hostname: string) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
