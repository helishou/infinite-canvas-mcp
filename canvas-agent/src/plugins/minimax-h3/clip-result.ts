import type { PluginMcpContext } from "../../server/plugin-mcp.js";

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(record) : [];
}
function mismatch(message: string): never {
    throw Object.assign(new Error(message), { code: "MEDIA_IDENTITY_MISMATCH" });
}

/** Resolve an archived output from its authoritative task, never from a directory or a flat parent result. */
export async function readClipResult(context: PluginMcpContext, input: Record<string, unknown>, segment: Record<string, unknown>) {
    const projectId = String(input.projectId || ""), nodeId = String(input.nodeId || ""), segmentId = String(input.segmentId || "");
    const storageKey = String(input.storageKey || segment.resultStorageKey || "");
    const history = records(segment.results).find((item) => item.storageKey === storageKey);
    const taskId = String(input.taskId || history?.taskId || segment.runtimeTaskId || segment.parentTaskId || "");
    if (!storageKey || !taskId) {
        if (input.taskId || input.storageKey) mismatch("指定任务与媒体必须同时可确定；不能从最新文件猜测结果");
        return { available: false, reason: "NO_VERIFIABLE_ARCHIVED_RESULT", projectId, nodeId, segmentId };
    }
    const { task, events } = await context.backend.getTask(taskId);
    if (task.id !== taskId) mismatch(`返回的任务 ID 与请求不符:${taskId}`);
    const params = record(task.params), taskInput = record(task.input), binding = record(params.canvasBinding);
    // Conflicting identity fields are not aliases: reject rather than letting a fallback hide a mismatch.
    for (const value of [task.projectId, taskInput.projectId, params.projectId, binding.projectId]) {
        if (value !== undefined && value !== "" && value !== projectId) mismatch(`任务不属于画布:${projectId}`);
    }
    if (![task.projectId, taskInput.projectId, params.projectId, binding.projectId].some((value) => value === projectId)) mismatch("任务缺少可核对的画布归属");
    let media: Record<string, unknown> | undefined;
    if (task.kind === "canvas-h3-run") {
        // A multi-Clip parent's unlabelled media array cannot prove which Clip owns the file.
        const candidates = (events || []).filter((event) => event.type === "clip_completed" || event.type === "clip_reused")
            .map((event) => record(event.payload))
            .filter((event) => event.nodeId === nodeId && event.segmentId === segmentId)
            .map((event) => record(event.output))
            .filter((output) => output.storageKey === storageKey);
        media = candidates.at(-1);
        if (!media) mismatch(`父任务没有此 Clip 与媒体的完成记录:${segmentId}`);
    } else {
        const nodeValues = [task.nodeId, taskInput.nodeId, params.nodeId, binding.nodeId];
        const segmentValues = [task.segmentId, taskInput.segmentId, params.segmentId, binding.segmentId];
        for (const value of nodeValues) if (value !== undefined && value !== "" && value !== nodeId) mismatch(`任务不属于节点:${nodeId}`);
        for (const value of segmentValues) if (value !== undefined && value !== "" && value !== segmentId) mismatch(`任务不属于 Clip:${segmentId}`);
        if (!nodeValues.includes(nodeId) || !segmentValues.includes(segmentId)) mismatch("任务缺少精确节点或 Clip 归属");
        if (task.status !== "succeeded") mismatch(`任务尚无成功归档结果:${taskId}`);
        const result = record(task.result);
        const outputs = [...records(task.outputs), ...records(result.media), ...records(result.images)];
        media = outputs.find((output) => output.storageKey === storageKey);
        if (!media) mismatch(`媒体不属于指定任务:${storageKey}`);
    }
    for (const [field, expected] of [["projectId", projectId], ["nodeId", nodeId], ["segmentId", segmentId]] as const) {
        if (media[field] !== undefined && media[field] !== expected) mismatch(`任务输出的 ${field} 与目标不符`);
    }
    if (!storageKey.startsWith("video:") || (media.mimeType && !String(media.mimeType).startsWith("video/"))) mismatch("指定归档媒体不是视频");
    return {
        available: true,
        identity: { projectId, nodeId, segmentId, taskId, storageKey },
        currentOutput: storageKey === segment.resultStorageKey,
        taskStatus: task.status,
        media: {
            storageKey, url: `/media/${encodeURIComponent(storageKey)}`,
            ...(typeof media.filename === "string" ? { filename: media.filename } : {}),
            mimeType: typeof media.mimeType === "string" ? media.mimeType : "video/mp4",
        },
    };
}
