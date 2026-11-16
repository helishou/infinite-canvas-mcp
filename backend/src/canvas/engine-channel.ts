import { decodeChannelModel, modelOptionName } from "./model-workflow.js";

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
