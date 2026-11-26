import { decodeChannelModel, modelOptionName } from "./model-workflow.js";
import { resolveCanvasExecutor } from "./executor-registry.js";

/**
 * 模型是否已在画布执行器注册表里声明为「直连 / 本地」执行器。
 * gpt-image-* 直连 OpenAI 兼容的生图 API，local-style-transfer 走本地算子，
 * 都不属于 media-engine 工作流模型。OpenAI 兼容渠道（含第三方生图 API）只是传输协议，
 * 不能据此把它们冒充成引擎模型——否则会套上引擎的「图片输入槽」预检而误拦带参考图的请求。
 * 判据复用 executor-registry 注册表这个单一真相源，不在这里复制 gpt-image 的匹配正则。
 */
function hasDedicatedNonEngineExecutor(model: string): boolean {
    if (!model) return false;
    try {
        const executor = resolveCanvasExecutor({ mode: "image", model }, true);
        return executor === "direct-image" || executor === "local-style-transfer";
    } catch {
        // 未注册的模型不在此列，继续按渠道判定。
        return false;
    }
}

/**
 * 执行引擎渠道（kind: "engine"）：把独立 media-engine 当成一个 OpenAI 兼容模型来源。
 *
 * 为什么是渠道而不是全局开关：
 * - 引擎本身就是 /v1/models + /v1/images/generations 这套协议，天然是「模型来源」；
 * - 渠道是画布既有的概念，用户在哪选模型就在哪配引擎，不用再去连接页开总闸；
 * - 每个模型各自带 capability，image / video / audio 可以混在同一个引擎渠道里。
 *
 * 这一层只负责「这个模型属于哪个引擎渠道」，HTTP 交给 CanvasEngineClient。
 */

export type EngineChannelTarget = {
    channelId: string;
    baseUrl: string;
    token?: string;
    model: string;
};

type RawChannel = {
    id?: unknown;
    kind?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    models?: unknown;
};

/** 去掉结尾的斜杠（不用正则，避免转义踩坑）。 */
function trimSlash(value: string): string {
    let out = value;
    while (out.endsWith("/")) out = out.slice(0, -1);
    return out;
}

function channelsOf(aiConfig: unknown): RawChannel[] {
    const config = aiConfig && typeof aiConfig === "object" ? (aiConfig as { channels?: unknown }) : {};
    return Array.isArray(config.channels) ? (config.channels as RawChannel[]) : [];
}

function modelNames(channel: RawChannel): string[] {
    return Array.isArray(channel.models)
        ? (channel.models as Array<Record<string, unknown>>).map((model) => String(model?.name ?? "")).filter(Boolean)
        : [];
}

/** 选中的模型是不是引擎渠道的模型；是则给出该渠道的 baseUrl / token。 */
export function findEngineChannel(aiConfig: unknown, selectedModel: string): EngineChannelTarget | null {
    const raw = String(selectedModel || "").trim();
    if (!raw) return null;
    const decoded = decodeChannelModel(raw)?.channelId;
    const model = modelOptionName(raw).trim();
    // 已声明为直连/本地执行器的模型（gpt-image-* 等）不属于引擎，无论它挂在哪个渠道下。
    // 必须在按渠道定位之前拦截：OpenAI 兼容的第三方生图渠道本身满足下面的引擎判据。
    if (hasDedicatedNonEngineExecutor(model)) return null;
    const channels = channelsOf(aiConfig);
    const channel = decoded
        ? channels.find((item) => String(item.id ?? "") === decoded)
        : channels.find((item) => modelNames(item).includes(model));
    // 引擎不是独立的渠道类型：它就是本地（或远端）OpenAI 兼容服务，
    // 判定依据是「非 comfyui/codex/hermes + apiFormat=openai」。
    const kind = String(channel?.kind ?? "").trim();
    if (!channel || kind === "comfyui" || kind === "codex-cli" || kind === "hermes") return null;
    if (String((channel as { apiFormat?: unknown }).apiFormat ?? "openai").trim() !== "openai") return null;
    const baseUrl = String(channel.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) return null;
    const token = String(channel.apiKey ?? "").trim();
    return { channelId: String(channel.id ?? ""), baseUrl, model, ...(token ? { token } : {}) };
}

/**
 * comfyui 渠道的模型也走引擎：引擎本身就是 ComfyUI 的 OpenAI 适配层，
 * 画布不需要自己再跑一遍工作流执行器。
 *
 * 引擎地址取值顺序：COMFYUI2API_URL / MEDIA_ENGINE_URL 环境变量 > 任意一个
 * OpenAI 协议的本地引擎渠道 > http://127.0.0.1:8300。
 */
export function findComfyuiEngineTarget(aiConfig: unknown, selectedModel: string): EngineChannelTarget | null {
    const raw = String(selectedModel || "").trim();
    if (!raw) return null;
    const decoded = decodeChannelModel(raw)?.channelId;
    const model = modelOptionName(raw).trim();
    const channels = channelsOf(aiConfig);
    const owner = decoded
        ? channels.find((item) => String(item.id ?? "") === decoded)
        : channels.find((item) => modelNames(item).includes(model));
    if (!owner || String(owner.kind ?? "").trim() !== "comfyui") return null;

    const env = process.env;
    const envUrl = String(env.COMFYUI2API_URL ?? env.MEDIA_ENGINE_URL ?? "").trim();
    // 优先画布里那个明确的引擎渠道（id/名称带 engine），否则退到任意 OpenAI 协议的
    // 本地渠道——不能随手挑第一个，别把画布上别的本地服务当成引擎。
    const engineCandidates = channels.filter((item) => {
        const kind = String(item.kind ?? "").trim();
        if (kind !== "local" && kind !== "api") return false;
        if (String((item as { apiFormat?: unknown }).apiFormat ?? "openai").trim() !== "openai") return false;
        return Boolean(String(item.baseUrl ?? "").trim());
    });
    const named = (item: RawChannel) => `${String(item.id ?? "")} ${String((item as { name?: unknown }).name ?? "")}`.toLowerCase().includes("engine");
    const engineChannel = engineCandidates.find(named) ?? engineCandidates.find((item) => trimSlash(String(item.baseUrl ?? "")) === "http://127.0.0.1:8300");
    const engineBaseUrl = envUrl || String(engineChannel?.baseUrl ?? "").trim() || "http://127.0.0.1:8300";
    const engineToken = String(engineChannel?.apiKey ?? "").trim();
    const token = env.COMFYUI2API_TOKEN ?? env.MEDIA_ENGINE_TOKEN ?? engineToken;
    return {
        channelId: String(owner.id ?? ""),
        baseUrl: trimSlash(engineBaseUrl),
        model,
        ...(token ? { token } : {}),
    };
}

/** 引擎渠道里的模型默认都走引擎执行，不再落到浏览器/本地执行器。 */
export function isEngineModel(aiConfig: unknown, selectedModel: string): boolean {
    return findEngineChannel(aiConfig, selectedModel) !== null;
}

/** 通用渠道查找（不限 kind）：判断「OpenAI 兼容渠道」用。 */
export function findChannelConfig(aiConfig: unknown, selectedModel: string): { channelId: string; kind: string; apiFormat: string; baseUrl: string; apiKey: string; extraBody?: Record<string, unknown> } | null {
    const raw = String(selectedModel || "").trim();
    if (!raw) return null;
    const decoded = decodeChannelModel(raw)?.channelId;
    const model = modelOptionName(raw).trim();
    const channels = channelsOf(aiConfig);
    const channel = decoded
        ? channels.find((item) => String(item.id ?? "") === decoded)
        : channels.find((item) => modelNames(item).includes(model));
    if (!channel) return null;
    return {
        channelId: String(channel.id ?? ""),
        kind: String(channel.kind ?? ""),
        apiFormat: String((channel as { apiFormat?: unknown }).apiFormat ?? "openai"),
        baseUrl: String(channel.baseUrl ?? "").trim(),
        apiKey: String(channel.apiKey ?? "").trim(),
        ...(channel as { extraBody?: unknown }).extraBody && typeof (channel as { extraBody?: unknown }).extraBody === "object"
            ? { extraBody: (channel as { extraBody: Record<string, unknown> }).extraBody }
            : {},
    };
}
