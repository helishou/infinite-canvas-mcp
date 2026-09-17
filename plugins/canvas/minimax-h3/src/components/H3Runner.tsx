import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { useH3RunEvents } from "../hooks/useH3RunEvents";
import { segmentsFor } from "../hooks/useH3Segments";

function bindingSignature(value: unknown) {
    if (!Array.isArray(value)) return "[]";
    return JSON.stringify(value.map((raw) => {
        const binding = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        return [
            String(binding.id || binding.bindingId || ""),
            String(binding.assetId || ""),
            String(binding.role || "other"),
            binding.enabled !== false,
            String(binding.usage || "reference"),
            String(binding.url || ""),
            String(binding.storageKey || ""),
        ];
    }));
}

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
                if (stopped) return;
                if (["succeeded", "failed", "cancelled"].includes(parent.status)) {
                    const current = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
                    const currentSegments = segmentsFor(current);
                    const hasAwaitingFirstPass = parent.status === "succeeded" && currentSegments.some((segment) => segment.firstPassReady === true && String(segment.status || "") === "awaiting_confirmation");
                    const terminalStatus = hasAwaitingFirstPass ? "awaiting_confirmation" : parent.status === "succeeded" ? "success" : parent.status === "cancelled" ? "cancelled" : "error";
                    const errorDetails = parent.error || "";
                    const segments = currentSegments.map((segment) => ["queued", "loading"].includes(String(segment.status || ""))
                        ? { ...segment, status: terminalStatus, progress: parent.progress, runtimeTaskId: "", errorDetails }
                        : segment);
                    update({
                        segments,
                        status: terminalStatus,
                        runProgress: parent.progress,
                        errorDetails,
                        runtimeTaskId: "",
                        runtimeRunId: "",
                        runRequestId: "",
                        runRequestConsumedId: "",
                        cancelRequested: false,
                    });
                    return;
                }
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

    const run = async (runFromCurrent = false, confirmSecondPass = false) => {
        if (runInFlight.current) return;
        runInFlight.current = true;
        try {
            const metadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
            const segments = segmentsFor(metadata);
            if (!segments.length) throw new Error("当前节点没有可生成的 Clip");
            const selectedId = String(metadata.selectedSegmentId || segments[0].id || "");
            if (!selectedId) throw new Error("当前节点没有可定位的 Clip");
            await ctx.flush();
            const validation = await ctx.references.validate(ctx.node.id, selectedId);
            const localBindings = segments.find((segment) => segment.id === selectedId)?.referenceBindings;
            if (localBindings && bindingSignature(localBindings) !== bindingSignature(validation.bindings)) throw new Error("参考绑定尚未同步到 Backend；请先处理画布同步冲突后再生成");
            const errors = validation.issues.filter((issue) => issue.severity === "error");
            if (errors.length) throw new Error(errors.map((issue) => issue.message).join("；"));
            update({ referenceWarnings: validation.issues.filter((issue) => issue.severity === "warning") });
            await ctx.ai.runCanvasGeneration({ mode: "video", operation: "h3-run", projectId: ctx.projectId, nodeId: ctx.node.id, segmentId: selectedId, runFromCurrent, ...(confirmSecondPass ? { params: { confirmSecondPass: true } } : {}) });
        } catch (error) {
            update({ runtimeTaskId: "", runtimeRunId: "", status: "error", runProgress: 0, errorDetails: error instanceof Error ? error.message : String(error), cancelRequested: false });
        } finally {
            runInFlight.current = false;
        }
    };

    useH3RunEvents(ctx, run, update);
    return null;
}
