import type { CanvasNodeContext, CanvasTextSuggestions } from "@infinite-canvas/plugin-sdk";

export type PromptJob = { requestId: string; base: string; documentId: string; status: "running" | "suggestion" | "done" | "error"; text?: string; error?: string };

export function promptJobs(ctx: CanvasNodeContext): Record<string, PromptJob> {
    return (ctx.view.getSnapshot().h3PromptJobs || {}) as Record<string, PromptJob>;
}

export function setPromptJob(ctx: CanvasNodeContext, segmentId: string, job: PromptJob) {
    ctx.view.update({ h3PromptJobs: { ...promptJobs(ctx), [segmentId]: job } });
}

// suggestions 必须在发起模型请求时捕获（同时绑定 Backend / 项目 / Clip）。
export async function persistPromptCandidate(suggestions: CanvasTextSuggestions, job: Pick<PromptJob, "requestId" | "documentId" | "base">, text: string): Promise<void> {
    await suggestions.save({ id: job.requestId, documentId: job.documentId, base: job.base, text });
    await suggestions.apply(job.requestId, job.documentId, job.base);
}
