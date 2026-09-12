import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { useH3RunEvents } from "../hooks/useH3RunEvents";
import { segmentsFor } from "../hooks/useH3Segments";

export function H3Runner({ ctx }: { ctx: CanvasNodeContext }) {
    const runInFlight = useRef(false);
    const update = (patch: Record<string, unknown>) => ctx.updateMetadata(patch);

    useEffect(() => {
        const taskId = String(ctx.node.metadata?.runtimeTaskId || "");
        if (!taskId || String(ctx.node.metadata?.status || "") !== "loading") return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const parent = await ctx.ai.getCanvasH3Task(taskId);
                if (stopped || ["succeeded", "failed", "cancelled"].includes(parent.status)) return;
                const result = (parent.result || {}) as Record<string, unknown>;
                const childId = String(result.currentChildTaskId || "");
                const childKind = String(result.currentChildKind || "");
                if (childId) {
                    const child = childKind === "runninghub:minimax-h3" ? await ctx.ai.getRunningHubH3Task(childId) : await ctx.ai.getLocalH3Task(childId);
                    if (!stopped && child.preview?.dataUrl && typeof window !== "undefined") {
                        window.dispatchEvent(new CustomEvent("minimax-h3-preview", { detail: { taskId: childId, url: child.preview.dataUrl, mime: child.preview.mime, promptId: child.preview.promptId, step: child.preview.step, total: child.preview.total } }));
                    }
                }
            } catch { /* Backend SSE 负责状态；短暂查询失败只跳过本轮预览。 */ }
            if (!stopped) timer = setTimeout(() => void poll(), 1500);
        };
        void poll();
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [ctx.node.id, ctx.node.metadata?.runtimeTaskId, ctx.node.metadata?.status]);

    const run = async (runFromCurrent = false) => {
        if (runInFlight.current) return;
        runInFlight.current = true;
        try {
            const metadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
            const segments = segmentsFor(metadata);
            if (!segments.length) throw new Error("当前节点没有可生成的 Clip");
            const selectedId = String(metadata.selectedSegmentId || segments[0].id || "");
            const segmentIndex = Math.max(0, segments.findIndex((segment) => String(segment.id || "") === selectedId));
            await ctx.ai.runCanvasGeneration({ mode: "video", operation: "h3-run", projectId: ctx.projectId, nodeId: ctx.node.id, segmentIndex, runFromCurrent });
        } catch (error) {
            update({ runtimeTaskId: "", runtimeRunId: "", status: "error", runProgress: 0, errorDetails: error instanceof Error ? error.message : String(error), cancelRequested: false });
        } finally {
            runInFlight.current = false;
        }
    };

    useH3RunEvents(ctx, run, update);
    return null;
}
