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

    useEffect(() => {
        const current = ctx.getNode(ctx.node.id)?.metadata || {};
        const requestId = String(current.runRequestId || "");
        if (!requestId || requestId === String(current.runRequestConsumedId || "")) return;
        updateRef.current({ runRequestConsumedId: requestId, status: "loading", errorDetails: "", runProgress: 0 });
        void runRef.current(current.runRequestAll === true);
    }, [ctx.node.id, ctx.node.metadata?.runRequestId, ctx.node.metadata?.runRequestConsumedId, ctx.node.metadata?.runRequestAll]);
}
