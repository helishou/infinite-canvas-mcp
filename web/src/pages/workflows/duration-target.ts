import type { DurationUnit, WorkflowDurationTarget } from "@/types/workflow";

/**
 * 节点浮窗里「作为时长」勾选的纯逻辑。
 * 交互与「作为提示词」一致：点节点启用输入 → 勾一下 → 配置落在 WorkflowConfig.durationTarget 单值上。
 */

/** length / frames 语义的输入吃帧，其余（PrimitiveFloat.value 等）吃秒。与 backend/src/workflows/duration.ts 对齐。 */
export function inferDurationUnit(input: string): DurationUnit {
    return /^(length|num_frames|frames|frame_count|frame_num|video_length|total_frames|frame)$/i.test(input.trim()) ? "frames" : "seconds";
}

/** 从字段派生时长目标。多节点字段（node 含逗号）没有唯一注入目标，返回 null。 */
export function durationTargetFromField(field: { node?: string; input?: string }): WorkflowDurationTarget | null {
    const nodeId = String(field.node || "").trim();
    const input = String(field.input || "").trim();
    if (!nodeId || !input || nodeId.includes(",")) return null;
    return { nodeId, input, unit: inferDurationUnit(input) };
}

/** 勾选态只从配置派生，不在字段上另存一份，避免两处状态漂移。 */
export function isDurationTargetFor(target: WorkflowDurationTarget | null | undefined, nodeId: string, input: string): boolean {
    return Boolean(target && target.nodeId === nodeId && target.input === input);
}
