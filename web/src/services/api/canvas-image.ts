import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { observeCanvasGenerationTask } from "./canvas-generation-task";

/** 整批只提交一次；结果与节点状态由 Backend 的 ops/delta 回写，网页只观察。 */
export async function runCanvasImageTask(input: CanvasGenerationCommand, signal: AbortSignal) {
    return observeCanvasGenerationTask(input, signal, "图片", 800);
}
