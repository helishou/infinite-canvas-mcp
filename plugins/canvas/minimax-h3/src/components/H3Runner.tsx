import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { useH3RunEvents } from "../hooks/useH3RunEvents";
import { segmentsFor } from "../hooks/useH3Segments";
import { clipRuntimeState } from "../services/h3-clip-runtime";
import { message } from "antd";

export function H3Runner({ ctx }: { ctx: CanvasNodeContext }) {
    const runInFlight = useRef<Set<string>>(new Set());
    const segments = segmentsFor(ctx.node.metadata || {});
    const selected = segments.find((segment) => segment.id === String(ctx.node.metadata?.selectedSegmentId || "")) || segments[0];
    const selectedRuntime = clipRuntimeState(selected);
    useEffect(() => {
        const taskId = selectedRuntime.taskId;
        if (!taskId || selectedRuntime.status !== "loading") return;
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
    }, [ctx.node.id, selected?.id, selectedRuntime.taskId, selectedRuntime.status]);

    const run = async (runFromCurrent = false, forceRegenerate = false, requestedSegmentId?: string) => {
        const initialMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
        const initialSegments = segmentsFor(initialMetadata);
        const segmentId = String(requestedSegmentId || initialMetadata.selectedSegmentId || initialSegments[0]?.id || "");
        const clipNumber = initialSegments.findIndex((segment) => segment.id === segmentId) + 1;
        if (!segmentId || runInFlight.current.has(segmentId)) return;
        runInFlight.current.add(segmentId);
        try {
            const metadata = initialMetadata;
            const segments = segmentsFor(metadata);
            const selected = segments.find((segment) => segment.id === String(requestedSegmentId || metadata.selectedSegmentId || "")) || segments[0];
            const state = clipRuntimeState(selected);
            if (state.status === "awaiting_confirmation") return;
            if (!segments.length) throw new Error("当前节点没有可生成的 Clip");
            const selectedId = String(selected?.id || metadata.selectedSegmentId || "");
            if (!selectedId) throw new Error("当前节点没有可定位的 Clip");
            await ctx.flush();
            await ctx.ai.runCanvasGeneration({ mode: "video", operation: "h3-run", projectId: ctx.projectId, nodeId: ctx.node.id, segmentId: selectedId, runFromCurrent, forceRegenerate });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const readable = clipNumber > 0
                ? detail.replaceAll(`H3 Clip ${segmentId}`, `Clip ${clipNumber}`).replaceAll(segmentId, `Clip ${clipNumber}`)
                : detail;
            message.error(!runFromCurrent && clipNumber > 0 && !/\bClip\s+\d+\b/iu.test(readable) ? `Clip ${clipNumber}：${readable}` : readable);
        } finally {
            runInFlight.current.delete(segmentId);
        }
    };

    useH3RunEvents(ctx, run);
    return null;
}
