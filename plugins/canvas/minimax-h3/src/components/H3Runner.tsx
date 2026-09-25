import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { useH3RunEvents } from "../hooks/useH3RunEvents";
import { segmentsFor } from "../hooks/useH3Segments";
import { message } from "antd";

export function H3Runner({ ctx }: { ctx: CanvasNodeContext }) {
    const runInFlight = useRef(false);
    useEffect(() => {
        const taskId = String(ctx.node.metadata?.runtimeTaskId || "");
        if (!taskId || String(ctx.node.metadata?.status || "") !== "loading") return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const parent = await ctx.ai.getCanvasH3Task(taskId);
                if (stopped) return;
                if (["awaiting_confirmation", "succeeded", "failed", "cancelled"].includes(parent.status)) return;
                const result = (parent.result || {}) as Record<string, unknown>;
                const childId = String(result.currentChildTaskId || "");
                const childKind = String(result.currentChildKind || "");
                if (childId) {
                    const child = childKind === "runninghub:minimax-h3" ? await ctx.ai.getRunningHubH3Task(childId) : await ctx.ai.getLocalH3Task(childId);
                    if (!stopped && child.preview?.dataUrl && typeof window !== "undefined") {
                        window.dispatchEvent(new CustomEvent("minimax-h3-preview", { detail: { parentTaskId: taskId, sourceTaskId: childId, url: child.preview.dataUrl, mime: child.preview.mime, promptId: child.preview.promptId, step: child.preview.step, total: child.preview.total } }));
                    }
                }
            } catch { /* Backend SSE 负责状态；短暂查询失败只跳过本轮预览。 */ }
            if (!stopped) timer = setTimeout(() => void poll(), 1500);
        };
        void poll();
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [ctx.node.id, ctx.node.metadata?.runtimeTaskId, ctx.node.metadata?.status]);

    const run = async (runFromCurrent = false, forceRegenerate = false) => {
        if (runInFlight.current) return;
        runInFlight.current = true;
        try {
            const metadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
            if (metadata.status === "awaiting_confirmation") return;
            const segments = segmentsFor(metadata);
            if (!segments.length) throw new Error("当前节点没有可生成的 Clip");
            const selectedId = String(metadata.selectedSegmentId || segments[0].id || "");
            if (!selectedId) throw new Error("当前节点没有可定位的 Clip");
            await ctx.flush();
            await ctx.ai.runCanvasGeneration({ mode: "video", operation: "h3-run", projectId: ctx.projectId, nodeId: ctx.node.id, segmentId: selectedId, runFromCurrent, forceRegenerate });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            runInFlight.current = false;
        }
    };

    useH3RunEvents(ctx, run);
    return null;
}
