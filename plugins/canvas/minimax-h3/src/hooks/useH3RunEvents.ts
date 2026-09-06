import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

type RunH3 = (runAll?: boolean) => void | Promise<void>;

export function useH3RunEvents(ctx: CanvasNodeContext, run: RunH3, update: (patch: Record<string, unknown>) => void) {
    const runRef = useRef(run);
    const updateRef = useRef(update);
    // 已消费的 runRequestId：用 ref 而非 getNode() 快照判定，避免刷新后恢复运行时
    // 形成「updateMetadata → 重渲染 → effect 再触发 updateMetadata」的无限同步循环
    // （详见下方 :46 处 effect 的注释）。keyed by requestId，新的一次运行会拿到新 id。
    const consumedRunRequestRef = useRef<string>("");
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
        // 刷新后恢复运行：节点 metadata 残留 runRequestId（点击「运行当前及后续」后刷新），
        // 挂载时自动续跑。此处必须用 ref 守卫「同一 runRequestId 只消费一次」。
        // 原因：effect 依赖读取 ctx.node.metadata?.runRequestConsumedId（渲染快照），
        // 但消费判定历史上用 ctx.getNode().metadata（store 快照，滞后于渲染快照）。
        // update({runRequestConsumedId}) 触发 SDK 内部 store setState → 重渲染 → effect 再次挂载，
        // 而 getNode 此时仍返回更新前的旧 node → 守卫永远不成立 → 再次 update+run →
        // 无限同步循环 → React 抛 Maximum update depth exceeded。
        // consumedRunRequestRef 直接记录已发的 requestId，彻底断开「重渲染→再触发」链条。
        const requestId = String(ctx.node.metadata?.runRequestId || "");
        if (!requestId) {
            consumedRunRequestRef.current = "";
            return;
        }
        if (requestId === consumedRunRequestRef.current) return;
        const current = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
        if (requestId === String(current.runRequestConsumedId || "")) {
            consumedRunRequestRef.current = requestId;
            return;
        }
        consumedRunRequestRef.current = requestId;
        updateRef.current({ runRequestConsumedId: requestId, status: "loading", errorDetails: "", runProgress: 0 });
        void runRef.current(current.runRequestAll === true);
    }, [ctx.node.id, ctx.node.metadata?.runRequestId, ctx.node.metadata?.runRequestConsumedId, ctx.node.metadata?.runRequestAll]);
}
