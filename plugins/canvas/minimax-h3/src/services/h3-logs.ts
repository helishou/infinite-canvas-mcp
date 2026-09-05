import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";

function logMedia(ref: H3Ref) {
    const payload: Record<string, unknown> = { name: ref.name, type: ref.type };
    if (ref.url) payload.url = ref.url;
    if (ref.storageKey) payload.storageKey = ref.storageKey;
    if (ref.mimeType) payload.mimeType = ref.mimeType;
    return payload;
}

export async function createH3Log(ctx: CanvasNodeContext, segment: H3Segment | undefined, prompt: string, refs: H3Ref[], params: Record<string, unknown>) {
    try {
        return await ctx.generationLogs.create({
            projectId: ctx.projectId,
            nodeId: ctx.node.id,
            segmentId: segment?.id,
            status: "queued",
            platform: String(params.engine || "ComfyUI"),
            workflow: String(params.workflow || "MiniMax H3"),
            model: String(params.modelName || ""),
            taskMode: String(params.taskMode || segment?.taskMode || "r2v"),
            prompt,
            references: refs.map(logMedia),
            inputCounts: {
                image: refs.filter((ref) => ref.type === "image").length,
                video: refs.filter((ref) => ref.type === "video").length,
                audio: refs.filter((ref) => ref.type === "audio").length,
            },
            startedAt: new Date().toISOString(),
            durationMs: 0,
            outputs: [],
            params,
        });
    } catch (error) {
        console.warn("[minimax-h3] failed to create generation log", error);
        return null;
    }
}

export async function finishH3Log(ctx: CanvasNodeContext, taskId: string, status: "success" | "failed" | "cancelled", patch: Record<string, unknown>) {
    try {
        const logs = await ctx.generationLogs.list({ projectId: ctx.projectId, nodeId: ctx.node.id, limit: 500 });
        const log = logs.find((item) => item.runtimeTaskId === taskId);
        if (log) await ctx.generationLogs.update(log.id, { status, ...patch });
    } catch (error) {
        console.warn("[minimax-h3] failed to update generation log", error);
    }
}
