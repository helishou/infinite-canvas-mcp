import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { useH3RunEvents } from "../hooks/useH3RunEvents";
import { segmentsFor } from "../hooks/useH3Segments";
import { refsForSegment, withSegmentRefs } from "../services/h3-data";
import { refreshSmartImageReference } from "../services/h3-refs";

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
        if (!taskId || !["loading", "awaiting_confirmation"].includes(String(ctx.node.metadata?.status || ""))) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const parent = await ctx.ai.getCanvasH3Task(taskId);
                if (stopped) return;
                if (parent.status === "awaiting_confirmation") {
                    update({ status: "awaiting_confirmation", runProgress: Math.min(0.99, parent.progress), runtimeTaskId: parent.id, errorDetails: parent.error || "" });
                    return;
                }
                if (["succeeded", "failed", "cancelled"].includes(parent.status)) {
                    const current = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
                    const currentSegments = segmentsFor(current);
                    const terminalStatus = parent.status === "succeeded" ? "success" : parent.status === "cancelled" ? "cancelled" : "error";
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
                        window.dispatchEvent(new CustomEvent("minimax-h3-preview", { detail: { parentTaskId: taskId, sourceTaskId: childId, url: child.preview.dataUrl, mime: child.preview.mime, promptId: child.preview.promptId, step: child.preview.step, total: child.preview.total } }));
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
            if (metadata.status === "awaiting_confirmation") return;
            let segments = segmentsFor(metadata);
            if (!segments.length) throw new Error("当前节点没有可生成的 Clip");
            const selectedId = String(metadata.selectedSegmentId || segments[0].id || "");
            if (!selectedId) throw new Error("当前节点没有可定位的 Clip");
            const changedAssets = new Map<string, NonNullable<(typeof segments)[number]["referenceBindings"]>[number]>();
            let referencesChanged = false;
            segments = segments.map((segment) => {
                const refs = refsForSegment(segment);
                const refreshed = refs.map((ref) => {
                    const next = ref.nodeId ? refreshSmartImageReference(ref, ctx.getNode(ref.nodeId)) : ref;
                    if (next !== ref) referencesChanged = true;
                    return next;
                });
                if (refreshed.every((ref, index) => ref === refs[index])) return segment;
                const nextSegment = withSegmentRefs(segment, refreshed);
                refreshed.forEach((ref, index) => {
                    if (ref === refs[index]) return;
                    const binding = nextSegment.referenceBindings?.find((item) => item.id === ref.bindingId);
                    if (binding) changedAssets.set(binding.assetId, binding);
                });
                return nextSegment;
            });
            if (referencesChanged) {
                update({ segments });
                await ctx.flush();
                await Promise.all(Array.from(changedAssets.values(), (binding) => ctx.references.upsert({ id: binding.assetId, label: binding.label, mediaType: binding.mediaType || "image", role: binding.role, tags: binding.tags || [], url: binding.url, storageKey: binding.storageKey, mimeType: binding.mimeType, sourceNodeId: binding.sourceNodeId, subjectId: binding.subjectId })));
            }
            await ctx.flush();
            const validation = await ctx.references.validate(ctx.node.id, selectedId);
            const localBindings = segments.find((segment) => segment.id === selectedId)?.referenceBindings;
            if (localBindings && bindingSignature(localBindings) !== bindingSignature(validation.bindings)) throw new Error("参考绑定尚未同步到 Backend；请先处理画布同步冲突后再生成");
            const errors = validation.issues.filter((issue) => issue.severity === "error");
            if (errors.length) throw new Error(errors.map((issue) => issue.message).join("；"));
            update({ referenceWarnings: validation.issues.filter((issue) => issue.severity === "warning") });
            await ctx.ai.runCanvasGeneration({ mode: "video", operation: "h3-run", projectId: ctx.projectId, nodeId: ctx.node.id, segmentId: selectedId, runFromCurrent });
        } catch (error) {
            if (String((ctx.getNode(ctx.node.id)?.metadata || {}).status || "") !== "awaiting_confirmation")
                update({ runtimeTaskId: "", runtimeRunId: "", status: "error", runProgress: 0, errorDetails: error instanceof Error ? error.message : String(error), cancelRequested: false });
        } finally {
            runInFlight.current = false;
        }
    };

    useH3RunEvents(ctx, run, update);
    return null;
}
