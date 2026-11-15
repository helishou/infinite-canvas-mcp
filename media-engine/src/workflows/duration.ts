/**
 * 自定义视频工作流的时长注入契约（纯函数，无副作用）。
 *
 * 制作台时长的唯一权威是 segment.duration（秒，由 shot.duration_frames / fps 派生）。
 * 自定义工作流只声明「哪个节点输入吃时长」以及该输入的单位；画布生成时由
 * VideoDispatcher 把秒换算后写进这个输入，不要求它同时是一个可填字段。
 * 与提示词 isPrompt 的自动注入同构：声明过就以制作台为准，覆盖手填值。
 */
export type DurationUnit = "seconds" | "frames";

export type WorkflowDurationTarget = {
    nodeId: string;
    input: string;
    unit: DurationUnit;
};

/**
 * H3 latent 帧网格 17n+5 @24fps。
 * 与 backend/workflows/MiniMax_H3.json 的 131 ComfyMathExpression 同构；
 * bridge 原生展开流与自定义工作流共用这一份实现。
 */
export function durationToFrames(seconds: number, fps = 24): number {
    const frames = Math.max(5, Math.round(seconds * fps));
    return frames + (5 - frames % 17) % 17;
}

/** 秒槽保留三位小数，避免被 buildParams 的 Math.round 抹成整数（6.5s 不能变 7s）。 */
export function resolveDurationValue(seconds: number, unit: DurationUnit, fps = 24): number {
    if (unit === "frames") return durationToFrames(seconds, fps);
    return Math.round(seconds * 1000) / 1000;
}

/** length / frames 语义的输入吃帧，其余（PrimitiveFloat.value 等）吃秒。选中后仍可人工改单位。 */
export function inferDurationUnit(input: string): DurationUnit {
    return /^(length|num_frames|frames|frame_count|frame_num|video_length|total_frames|frame)$/i.test(input.trim()) ? "frames" : "seconds";
}

/** 坏配置一律退化成「未配置」，绝不阻断生成。 */
export function parseWorkflowDurationTarget(raw: unknown): WorkflowDurationTarget | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const nodeId = String(value.nodeId ?? "").trim();
    const input = String(value.input ?? "").trim();
    const unit = value.unit === "frames" ? "frames" : value.unit === "seconds" ? "seconds" : null;
    if (!nodeId || !input || !unit) return null;
    return { nodeId, input, unit };
}

/**
 * 把换算后的时长写进目标节点输入。只做浅拷贝，不改动原图，也不触碰其他节点。
 * 目标节点不存在时返回 injected: false，调用方保留原工作流继续生成。
 */
export function injectDurationTarget(
    workflow: Record<string, unknown>,
    target: WorkflowDurationTarget,
    value: number,
): { workflow: Record<string, unknown>; injected: boolean } {
    const node = workflow?.[target.nodeId] as Record<string, unknown> | undefined;
    if (!node || typeof node !== "object") return { workflow, injected: false };
    const inputs = (node.inputs && typeof node.inputs === "object" ? node.inputs : {}) as Record<string, unknown>;
    return {
        workflow: {
            ...workflow,
            [target.nodeId]: { ...node, inputs: { ...inputs, [target.input]: value } },
        },
        injected: true,
    };
}

/** 画布视频请求的秒数。优先制作台显式 seconds，其次运行参数里的 duration / seconds。 */
export function readDurationSeconds(
    values: Record<string, unknown>,
    input: { seconds?: unknown; params?: Record<string, unknown> },
): number | null {
    const candidates = [input.seconds, values.seconds, values.duration, input.params?.duration, input.params?.seconds];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null || candidate === "") continue;
        const seconds = Number(candidate);
        if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000) / 1000;
    }
    return null;
}
