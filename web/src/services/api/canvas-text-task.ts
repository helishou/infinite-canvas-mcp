import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { observeCanvasGenerationTask } from "./canvas-generation-task";

/** Backend 文本任务只观察终态；结果文本节点由 CanvasTextDispatcher 通过 ops 创建。 */
export async function runCanvasTextTask(input: CanvasGenerationCommand, signal: AbortSignal) {
    return observeCanvasGenerationTask(input, signal, "文本");
}
