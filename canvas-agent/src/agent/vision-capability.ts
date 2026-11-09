import { openAiBase, type LlmMessage, type LlmProvider } from "./llm-provider.js";

/**
 * 视觉能力探测：只在真正要发图时才判断，结论只用于提前给出可操作的错误。
 *
 * 三层判断：渠道里的显式声明 → 模型名启发式 → 真实小图探针。
 * 探针会发一次极小的计费请求，因此只缓存确定的结论；网络、鉴权、限流、5xx 等
 * 模糊失败一律视为“未知”放行，不能因为探测失败阻断用户正常的图片请求。
 */
export type VisionProvider = Pick<LlmProvider, "id" | "model" | "name" | "baseUrl" | "apiKey" | "apiFormat" | "supportsImages" | "kind" | "headers">;

const PROBE_TIMEOUT_MS = 20_000;
/** 32×32 纯色 JPEG（273 字节），足够让服务端校验图片输入而不产生可读内容。 */
const PROBE_IMAGE_DATA_URL = "data:image/jpeg;base64,/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwCMtAAAAAAP/Z";

/** 名称明确带视觉能力的模型直接跳过探针（探针是计费请求，能省则省）。 */
const VISION_MODEL_HINTS = /(?:gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|qwen(?:2(?:\.5)?-?vl|3?-?vl)|vl[-_]|vision|llava|internvl|pixtral|glm-4(?:\.\d+)?v|minicpm-v|step-1v|doubao[-_ ]?vision)/i;

const REJECTION_HINT = /(?:not\s+support|unsupported|does\s*n[o']t\s+support|not\s+allowed|invalid|unknown|only\s+(?:accepts?|supports?)\s+text|text[-_ ]only|不支持|仅支持|无法处理|无效|未知)/i;
const IMAGE_HINT = /(?:image|vision|multimodal|modalit|content[-_ ]?type|image_url|input_image|inline[_ ]?data|图片|图像|视觉)/i;
/** 这些状态码说明“请求本身不被接受”，可结合响应体判断是否针对图片；其余一律模糊。 */
const REJECTION_STATUS = new Set([400, 404, 413, 415, 422]);

const cache = new Map<string, boolean>();
const cacheKey = (provider: VisionProvider) => `${provider.id}|${provider.baseUrl}|${provider.model}|${provider.apiFormat}`;

export function hasImageParts(messages: LlmMessage[]): boolean {
    return messages.some(message => message.parts.some(part => "image" in part));
}

function unsupportedError(provider: VisionProvider): Error {
    return new Error(`模型「${provider.name}」不支持图片输入，本轮包含图片。请在渠道配置里把该模型标记为支持图片，或改用支持视觉的模型后重试`);
}

/**
 * 确认本轮带图的请求可以发。只有“明确不支持”才抛错；无法判断时放行。
 * 用户主动取消会照常抛出，不吞掉中断。
 */
export async function ensureImageSupport(provider: VisionProvider, signal?: AbortSignal): Promise<void> {
    if (provider.supportsImages === false) throw unsupportedError(provider);
    if (provider.supportsImages === true || provider.kind === "codex-cli") return;
    if (VISION_MODEL_HINTS.test(provider.model)) return;
    const key = cacheKey(provider);
    const cached = cache.get(key);
    if (cached === true) return;
    if (cached === false) throw unsupportedError(provider);
    const result = await probeImageSupport(provider, signal);
    if (result === "unknown") return;
    cache.set(key, result);
    if (!result) throw unsupportedError(provider);
}

/** 返回 true（确认支持）、false（确认不支持）或 "unknown"（探测无定论，不得据此阻断）。 */
async function probeImageSupport(provider: VisionProvider, signal?: AbortSignal): Promise<boolean | "unknown"> {
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
        response = await fetch(probeRequest(provider), { method: "POST", headers: probeHeaders(provider), body: JSON.stringify(probeBody(provider)), signal: combined });
    } catch (error) {
        if (signal?.aborted) throw error;
        return "unknown";
    }
    if (response.ok) {
        await response.body?.cancel().catch(() => {});
        return true;
    }
    // 不对外回显响应体（可能含凭据或完整请求），只在本地用于区分“明确拒绝图片”与模糊失败。
    const body = await response.text().catch(() => "");
    if (REJECTION_STATUS.has(response.status) && REJECTION_HINT.test(body) && IMAGE_HINT.test(body)) return false;
    return "unknown";
}

function probeHeaders(provider: VisionProvider): Record<string, string> {
    if (provider.apiFormat === "gemini") return { ...provider.headers, "content-type": "application/json", ...(provider.apiKey ? { "x-goog-api-key": provider.apiKey } : {}) };
    return { ...provider.headers, "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) };
}

function probeRequest(provider: VisionProvider): string {
    if (provider.apiFormat === "gemini") {
        const base = provider.baseUrl.replace(/\/+$/, "");
        return `${/\/v1(?:beta)?$/.test(base) ? base : `${base}/v1beta`}/models/${encodeURIComponent(provider.model.replace(/^models\//, ""))}:generateContent`;
    }
    const base = openAiBase(provider.baseUrl);
    return provider.apiFormat === "openai-chat" ? `${base}/chat/completions` : `${base}/responses`;
}

function probeBody(provider: VisionProvider): Record<string, unknown> {
    if (provider.apiFormat === "gemini") {
        const [, data] = PROBE_IMAGE_DATA_URL.split(",", 2);
        return { contents: [{ role: "user", parts: [{ text: "ping" }, { inlineData: { mimeType: "image/jpeg", data } }] }], generationConfig: { maxOutputTokens: 16 } };
    }
    if (provider.apiFormat === "openai-chat") {
        return { model: provider.model, stream: false, max_tokens: 16, messages: [{ role: "user", content: [{ type: "text", text: "ping" }, { type: "image_url", image_url: { url: PROBE_IMAGE_DATA_URL } }] }] };
    }
    return { model: provider.model, stream: false, store: false, max_output_tokens: 16, input: [{ role: "user", content: [{ type: "input_text", text: "ping" }, { type: "input_image", image_url: PROBE_IMAGE_DATA_URL }] }] };
}
