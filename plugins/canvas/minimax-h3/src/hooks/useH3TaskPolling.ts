import { useEffect } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { appendVideoMaterials } from "../services/h3-data";
import { finishH3Log } from "../services/h3-logs";

export function useH3TaskPolling(ctx: CanvasNodeContext, metadata: Record<string, unknown>, update: (patch: Record<string, unknown>) => void) {
    useEffect(() => {
        const taskId = String(metadata.runtimeTaskId || "");
        if (!taskId || !["loading", "queued"].includes(String(metadata.status))) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const task = String(metadata.minimaxEngine || "").toLowerCase() === "runninghub"
                    ? await ctx.ai.getRunningHubH3Task(taskId)
                    : await ctx.ai.getLocalH3Task(taskId);
                if (cancelled) return;
                if (task.status === "succeeded" && task.result?.url) {
                    const storageKey = task.result.storageKey || (typeof metadata.storageKey === "string" ? metadata.storageKey : undefined);
                    update({
                        content: task.result.url,
                        storageKey,
                        mimeType: task.result.mimeType,
                        ...(task.result.segments?.length ? { segments: task.result.segments } : {}),
                        materials: appendVideoMaterials(metadata.materials, [{ url: task.result.url, storageKey, type: "video", name: "H3 输出", segmentId: String(metadata.selectedSegmentId || "") }]),
                        status: "success",
                        errorDetails: "",
                    });
                    void finishH3Log(ctx, taskId, "success", {
                        finishedAt: new Date().toISOString(),
                        durationMs: Date.now() - Number(metadata.runStartedAt || Date.now()),
                        outputs: [{ url: task.result.url, storageKey, type: "video", mimeType: task.result.mimeType }],
                    });
                } else if (["failed", "cancelled"].includes(task.status)) {
                    const status = task.status === "cancelled" ? "cancelled" : "error";
                    update({ status, errorDetails: task.error || "H3 任务失败" });
                    void finishH3Log(ctx, taskId, task.status === "cancelled" ? "cancelled" : "failed", {
                        finishedAt: new Date().toISOString(),
                        durationMs: Date.now() - Number(metadata.runStartedAt || Date.now()),
                        error: task.error || "H3 任务失败",
                    });
                } else {
                    timer = setTimeout(() => void poll(), 1500);
                }
            } catch {
                if (!cancelled) timer = setTimeout(() => void poll(), 2500);
            }
        };
        void poll();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [ctx.node.id, metadata.runtimeTaskId, metadata.status, update]);
}
