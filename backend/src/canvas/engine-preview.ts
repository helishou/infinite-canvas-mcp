/**
 * 把执行引擎的生成态预览帧接到画布任务详情上。
 *
 * 引擎在 `GET /api/tasks/{engineTaskId}` 回 `preview`（KJ 逐帧桥每步更新的 dataUrl），
 * 但画布自己的任务详情此前一律 `preview: null`，前端因而永远看不到生成中的画面。
 * 这里按提交时刻落库的 `engine_submitted` 事件反查引擎任务，现取现回，不落库、不归档。
 *
 * 任务关系：H3 父任务 → currentChildTaskId（canvas-video 子任务）→ engine_submitted。
 * 所以既支持子任务直查，也能从 H3 父任务顺着 currentChildTaskId 找到引擎任务。
 */
import type { Stores } from "../stores/types.js";
import { CanvasEngineClient, type EngineTaskLivePreview } from "./engine-client.js";

export type { EngineTaskLivePreview };

export type EngineSubmission = { engineTaskId: string; baseUrl: string; model?: string };

const PREVIEW_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 300;
const cache = new Map<string, { at: number; value: EngineTaskLivePreview | null; inflight?: Promise<EngineTaskLivePreview | null> }>();

function trimSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

/** 令牌不落库；按提交时的 baseUrl 在当前渠道配置里现查，环境变量优先。 */
function tokenFor(stores: Stores, baseUrl: string, model?: string): string | undefined {
    const envToken = String(process.env.COMFYUI2API_TOKEN ?? process.env.MEDIA_ENGINE_TOKEN ?? "").trim();
    if (envToken) return envToken;
    const config = stores.settings.get("ai.config");
    const channels = config && typeof config === "object" && Array.isArray((config as { channels?: unknown }).channels)
        ? (config as { channels: Array<Record<string, unknown>> }).channels
        : [];
    const expected = trimSlash(baseUrl);
    const byUrl = channels.find((channel) => trimSlash(String(channel.baseUrl ?? "")) === expected);
    const byModel = model ? channels.find((channel) => {
        const models = Array.isArray(channel.models) ? channel.models : [];
        return models.some((item) => String((item as Record<string, unknown>)?.name ?? "") === model);
    }) : undefined;
    const token = String((byUrl ?? byModel)?.apiKey ?? "").trim();
    return token || undefined;
}

/** 纯函数：从任务自身事件 → 当前子任务 → 父任务找一次提交的引擎任务坐标。 */
export function engineSubmissionOf(
    stores: Pick<Stores, "tasks">,
    taskId: string,
    seen: ReadonlySet<string> = new Set(),
): EngineSubmission | null {
    if (!taskId || seen.has(taskId)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(taskId);
    const task = stores.tasks.get(taskId);
    if (!task) return null;

    const submission = [...stores.tasks.events(taskId)].reverse().find((event) => event.type === "engine_submitted");
    if (submission) {
        const payload = submission.payload || {};
        const engineTaskId = String(payload.engineTaskId ?? "").trim();
        const baseUrl = String(payload.baseUrl ?? "").trim();
        if (engineTaskId && baseUrl) {
            return { engineTaskId, baseUrl, ...(typeof payload.model === "string" ? { model: payload.model } : {}) };
        }
    }

    const result = task.result || {};
    const childId = String(result.currentChildTaskId ?? "").trim();
    const fromChild = childId ? engineSubmissionOf(stores, childId, nextSeen) : null;
    if (fromChild) return fromChild;

    const parentId = String(task.parentTaskId ?? "").trim();
    return parentId ? engineSubmissionOf(stores, parentId, nextSeen) : null;
}

function isPreview(value: unknown): value is EngineTaskLivePreview {
    if (!value || typeof value !== "object") return false;
    const dataUrl = String((value as { dataUrl?: unknown }).dataUrl ?? "");
    // 预览覆盖层按 dataUrl 的 MIME 渲染 <img> 或 <video>。
    // KJ 桥的逐帧事件既可能是 JPEG 静帧，也可能是 MP4 动态预览（preview_frames>1），
    // 只收 image/ 会把最有用的「视频预览」整批丢掉。
    return /^data:(image|video)\//.test(dataUrl);
}

export type PreviewFetcher = (submission: EngineSubmission, token: string | undefined) => Promise<EngineTaskLivePreview | null>;

const defaultFetcher: PreviewFetcher = async (submission, token) => {
    const client = new CanvasEngineClient(submission.baseUrl, token, PREVIEW_TIMEOUT_MS);
    const detail = await client.taskDetail(submission.engineTaskId);
    return isPreview(detail.preview) ? detail.preview : null;
};

/**
 * 现取画布任务对应的引擎预览帧。任何查询失败都当「暂无预览」，
 * 绝不让预览链路反过来打断生成或任务查询。
 */
export async function resolveTaskLivePreview(
    stores: Stores,
    taskId: string,
    fetcher: PreviewFetcher = defaultFetcher,
): Promise<EngineTaskLivePreview | null> {
    const task = stores.tasks.get(taskId);
    // 终态任务的引擎帧已被清掉，没必要再打引擎。
    if (!task || !["queued", "running", "awaiting_confirmation"].includes(task.status)) return null;
    const submission = engineSubmissionOf(stores, taskId);
    if (!submission) return null;

    const key = `${submission.baseUrl}|${submission.engineTaskId}`;
    const hit = cache.get(key);
    if (hit?.inflight) return await hit.inflight;
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const token = tokenFor(stores, submission.baseUrl, submission.model);
    const inflight = (async () => {
        try {
            return await fetcher(submission, token);
        } catch {
            return null;
        }
    })();
    cache.set(key, { at: Date.now(), value: hit?.value ?? null, inflight });
    const value = await inflight;
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 256) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - 256);
        for (const [k] of oldest) cache.delete(k);
    }
    return value;
}
