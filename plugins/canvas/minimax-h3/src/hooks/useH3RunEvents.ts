import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import { message } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { segmentsFor } from "../hooks/useH3Segments";
import { clipRuntimeState } from "../services/h3-clip-runtime";

type RunH3 = (runAll?: boolean, forceRegenerate?: boolean, segmentId?: string) => void | Promise<void>;

function currentClip(metadata: Record<string, unknown>) {
    const segments = segmentsFor(metadata);
    return segments.find((segment) => segment.id === String(metadata.selectedSegmentId || "")) || segments[0];
}

export function useH3RunEvents(ctx: CanvasNodeContext, run: RunH3) {
    const ctxRef = useRef(ctx);
    const runRef = useRef(run);
    useEffect(() => { ctxRef.current = ctx; runRef.current = run; }, [ctx, run]);

    useEffect(() => ctx.on("minimax-h3:run", (payload) => {
        const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        if (String(value.nodeId || "") !== ctx.node.id) return;
        const current = ctxRef.current.getNode(ctx.node.id)?.metadata || {};
        const requestedId = String(value.segmentId || "");
        const target = requestedId ? segmentsFor(current).find((segment) => segment.id === requestedId) : currentClip(current);
        const state = clipRuntimeState(target);
        if (state.status === "awaiting_confirmation") return;
        void runRef.current(value.all === true, value.forceRegenerate === true, target?.id);
    }), [ctx.node.id]);

    useEffect(() => ctx.on("minimax-h3:run-all", (payload) => {
        const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        if (String(value.nodeId || "") === ctx.node.id) void runRef.current(true);
    }), [ctx.node.id]);

    useEffect(() => ctx.on("minimax-h3:cancel", (payload) => {
        const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        if (String(value.nodeId || "") !== ctx.node.id) return;
        const state = clipRuntimeState(currentClip(ctxRef.current.getNode(ctx.node.id)?.metadata || {}));
        const taskId = state.taskId;
        if (!taskId) { message.error("当前没有可取消的 H3 任务"); return; }
        void ctxRef.current.ai.cancelCanvasH3Task(taskId).catch((error) => message.error(error instanceof Error ? error.message : String(error)));
    }), [ctx.node.id]);

    useEffect(() => ctx.on("minimax-h3:reset-and-run", (payload) => {
        const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        if (String(value.nodeId || "") !== ctx.node.id) return;
        const metadata = ctxRef.current.getNode(ctx.node.id)?.metadata || {};
        const requestedId = String(value.segmentId || "");
        const segments = segmentsFor(metadata);
        const target = requestedId ? segments.find((segment) => segment.id === requestedId) : currentClip(metadata);
        const state = clipRuntimeState(target);
        if (state.status === "awaiting_confirmation") return;
        const restart = () => void runRef.current(value.all === true, true, target?.id);
        const taskId = state.taskId;
        if (taskId && state.busy) {
            void ctxRef.current.ai.cancelCanvasH3Task(taskId).then(restart).catch((error) => message.error(error instanceof Error ? error.message : String(error)));
        } else restart();
    }), [ctx.node.id]);
}
