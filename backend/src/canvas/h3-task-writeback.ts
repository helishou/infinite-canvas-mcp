import type { RuntimeTask } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { Stores } from "../stores/types.js";

type Binding = { projectId?: string; nodeId?: string; segmentId?: string; generationLogId?: string };

function bindingOf(task: RuntimeTask): Binding | null {
    const value = task.params?.canvasBinding;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Binding : null;
}

function resultVideo(task: RuntimeTask) {
    const media = task.result && Array.isArray(task.result.media) ? task.result.media as Array<Record<string, unknown>> : [];
    return media.find((item) => String(item.mimeType || "").startsWith("video/")) || media[0];
}

function mediaRef(item: Record<string, unknown> | undefined) {
    if (!item) return null;
    const storageKey = String(item.storageKey || "").trim();
    const raw = String(item.url || "").trim();
    return {
        ...(storageKey ? { url: `/media/${encodeURIComponent(storageKey)}`, storageKey } : { url: raw }),
        type: "video",
        mimeType: String(item.mimeType || "video/mp4"),
    } as { url: string; storageKey?: string; type: string; mimeType: string };
}

/** ComfyUI 任务终态统一回写 H3 Clip；不依赖 MCP 进程存活。 */
export async function writeBackH3Task(stores: Stores, events: BackendEventBus, task: RuntimeTask) {
    const binding = bindingOf(task);
    if (!binding?.projectId || !binding.nodeId || !binding.segmentId) return false;
    const output = mediaRef(resultVideo(task));
    // 注意：segments[i].results[] 不再承载「生成时刻输入快照」（prompt/refs/params），
    // 否则单节点 metadata 可达 MB 级（MCP canvas_get_state 会被截断）。
    // 生成时刻的输入快照已持久化在 generation_logs.prompt + references_json + params_json，
    // 还原 Clip 时按 generationLogId 查回来即可（见 buildRestoreParamsPatch）。
    const persistedOutput = output;
    const saved = stores.projects.writeBackH3Task(task, {
        projectId: binding.projectId,
        nodeId: binding.nodeId,
        segmentId: binding.segmentId,
        ...(binding.generationLogId ? { generationLogId: binding.generationLogId } : {}),
    }, persistedOutput);
    if (!saved) {
        return false;
    }
    events.publishCanvasDelta({ entityId: saved.project.id, revision: Number(saved.project.revision || 0), operations: saved.operations, updatedAt: String(saved.project.updatedAt || "") });
    if (saved.log) events.publish({ type: "generation-log.updated", entityId: saved.log.id, payload: saved.log });
    return true;
}
