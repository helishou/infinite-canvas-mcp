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
    const saved = stores.projects.writeBackH3Task(task, {
        projectId: binding.projectId,
        nodeId: binding.nodeId,
        segmentId: binding.segmentId,
        ...(binding.generationLogId ? { generationLogId: binding.generationLogId } : {}),
    }, output);
    if (!saved) return false;
    events.publish({ type: "canvas.updated", entityId: saved.project.id, revision: Number(saved.project.revision || 0), payload: saved.project });
    if (saved.log) events.publish({ type: "generation-log.updated", entityId: saved.log.id, payload: saved.log });
    return true;
}
