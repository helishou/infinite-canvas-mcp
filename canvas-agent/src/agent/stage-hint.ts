import { loadConfig } from "../config.js";
import { createBackendClient } from "../runtime/comfy-client.js";

/**
 * 每轮注入给模型的「当前剧目阶段」块。
 *
 * 为什么在服务端算：阶段是硬约束，不能指望模型每轮自己记得查；
 * 由 canvas-agent 在拼提示词时先读后端派生的阶段，agent 一开口就知道自己在第几段、
 * 下一步做什么、该读哪份技能。
 */

const TTL_MS = 20_000;
let cachedBlock = "";
let cachedCanvasId = "";
let fetchedAt = 0;

/** 读当前画布所属剧目的阶段块；失败就返回上一份（没有就空串，绝不编）。 */
export async function refreshDramaStageContext(canvasId?: string): Promise<string> {
    const id = String(canvasId || "").trim();
    if (!id) return "";
    if (cachedBlock && cachedCanvasId === id && Date.now() - fetchedAt < TTL_MS) return cachedBlock;
    try {
        const config = loadConfig();
        const backend = createBackendClient(config.backendUrl || "http://127.0.0.1:17370");
        const stage = await backend.getDramaStageByCanvas(id);
        const context = String((stage as Record<string, unknown>).context || "").trim();
        if (context) {
            cachedBlock = context;
            cachedCanvasId = id;
            fetchedAt = Date.now();
        }
        return context;
    } catch {
        return cachedBlock && cachedCanvasId === id ? cachedBlock : "";
    }
}

/** 最近一次成功的阶段块（同步取，供拼提示词时用）。 */
export function currentDramaStageContext() {
    return cachedBlock;
}

/** 把阶段块拼到用户消息前面；没有阶段就不加噪声。 */
export function withDramaStageContext(prompt: string, block: string) {
    const context = String(block || "").trim();
    if (!context) return prompt;
    return `${context}\n\n---\n用户请求：${prompt}`;
}
