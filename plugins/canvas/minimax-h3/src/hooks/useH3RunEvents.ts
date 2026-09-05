import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

type RunH3 = (runAll?: boolean) => void | Promise<void>;

export function useH3RunEvents(ctx: CanvasNodeContext, run: RunH3, update: (patch: Record<string, unknown>) => void) {
    const runRef = useRef(run);
    const updateRef = useRef(update);
    useEffect(() => {
        runRef.current = run;
        updateRef.current = update;
    }, [run, update]);

    useEffect(() => ctx.on("minimax-h3:run", (payload) => {
        if (!payload || typeof payload !== "object" || String((payload as Record<string, unknown>).nodeId || "") !== ctx.node.id) return;
        const requestId = String((payload as Record<string, unknown>).requestId || "");
        const current = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
        if (!requestId && ["queued", "loading"].includes(String(current.status || ""))) return;
        if (requestId) updateRef.current({ runRequestConsumedId: requestId, status: "loading", errorDetails: "", runProgress: 0 });
        void runRef.current(Boolean((payload as Record<string, unknown>).all));
    }), [ctx.node.id]);

    useEffect(() => ctx.on("minimax-h3:run-all", (payload) => {
        if (!payload || typeof payload !== "object" || String((payload as Record<string, unknown>).nodeId || "") !== ctx.node.id) return;
        void runRef.current(true);
    }), [ctx.node.id]);

    useEffect(() => ctx.on("minimax-h3:cancel", (payload) => {
        if (!payload || typeof payload !== "object" || String((payload as Record<string, unknown>).nodeId || "") !== ctx.node.id) return;
        const current = ctx.getNode(ctx.node.id)?.metadata || {};
        const taskId = String(current.runtimeTaskId || "");
        const currentStatus = String(current.status || "");
        // 没有真正的视频生成任务在跑（可能是智能分镜残留、或异常把 status 卡在 loading），
        // 直接把节点重置回可运行，让“生成当前 Clip”按钮从“取消生成”恢复，避免死循环。
        if (!taskId || !["queued", "loading"].includes(currentStatus)) {
            if (["queued", "loading"].includes(currentStatus)) {
                updateRef.current({ status: "idle", errorDetails: "", runProgress: 0, cancelRequested: false, runtimeTaskId: "" });
            }
            return;
        }
        const runningHub = String(current.minimaxEngine || "").toLowerCase() === "runninghub";
        updateRef.current({ cancelRequested: true });
        void (runningHub ? ctx.ai.cancelRunningHubH3Task(taskId) : ctx.ai.cancelLocalH3Task(taskId)).then(() => updateRef.current({ status: "cancelled", errorDetails: "任务已取消", runProgress: 0, runtimeTaskId: "" })).catch((error) => updateRef.current({ status: "error", errorDetails: error instanceof Error ? error.message : String(error) }));
    }), [ctx.node.id]);

    useEffect(() => {
        const current = ctx.getNode(ctx.node.id)?.metadata || {};
        const requestId = String(current.runRequestId || "");
        if (!requestId || requestId === String(current.runRequestConsumedId || "")) return;
        updateRef.current({ runRequestConsumedId: requestId, status: "loading", errorDetails: "", runProgress: 0 });
        void runRef.current(current.runRequestAll === true);
    }, [ctx.node.id, ctx.node.metadata?.runRequestId, ctx.node.metadata?.runRequestConsumedId, ctx.node.metadata?.runRequestAll]);
}
