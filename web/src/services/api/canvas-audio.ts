import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { observeCanvasGenerationTask } from "./canvas-generation-task";

/** Backend 音频任务只观察终态；音频媒体和节点状态由 Backend ops 回写。 */
export async function runCanvasAudioTask(input: CanvasGenerationCommand, signal: AbortSignal) {
    return observeCanvasGenerationTask(input, signal, "音频");
}
