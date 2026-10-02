import type { H3Segment } from "../types";

const ACTIVE = new Set(["queued", "loading", "awaiting_confirmation"]);

export function clipRuntimeState(segment?: H3Segment) {
    const status = String(segment?.status || "idle");
    const taskId = String(segment?.parentTaskId || (status === "awaiting_confirmation" ? segment?.runtimeTaskId : "") || "");
    return {
        status,
        taskId,
        childTaskId: String(segment?.runtimeTaskId || ""),
        busy: ["queued", "loading"].includes(status),
        awaitingConfirmation: status === "awaiting_confirmation",
        stuck: ["queued", "loading"].includes(status) && !taskId,
    };
}

/** 节点顶层只作为所有 Clip 的聚合显示；生成归属始终以 Clip 字段为准。 */
export function aggregateClipRuntimeState(segments: H3Segment[]) {
    const states = segments.map(clipRuntimeState);
    const active = states.find((state) => ACTIVE.has(state.status));
    const failed = states.find((state) => state.status === "error");
    const status = active?.status || failed?.status || (states.some((state) => state.status === "success") ? "success" : "idle");
    const taskId = active?.taskId || states.find((state) => state.taskId)?.taskId || "";
    const activeProgress = Math.max(0, ...segments.filter((segment) => ACTIVE.has(String(segment.status || ""))).map((segment) => Number(segment.progress || 0)));
    const progress = activeProgress || segments.reduce((max, segment) => Math.max(max, Number(segment?.progress || 0)), 0);
    return { status, taskId, progress };
}
