import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { observeCanvasGenerationTask } from "./canvas-generation-task";

/** Backend 视频任务只观察终态；节点结果由任务 ops 实时回写。 */
export async function runCanvasVideoTask(input: CanvasGenerationCommand, signal: AbortSignal) {
    return observeCanvasGenerationTask(input, signal, "视频");
}
