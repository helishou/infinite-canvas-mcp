import { createHash } from "node:crypto";

const STATIC_READS = new Set(["canvas_get_state", "canvas_read_text", "production_get", "production_get_source", "production_get_workbench", "production_get_artifact", "production_get_artifact_index", "production_get_version", "production_get_version_source", "production_get_version_artifact", "production_get_version_artifact_index", "production_get_scene_production", "production_get_scene_version", "h3_get_node", "h3_get_clip", "h3_get_clip_prompt", "h3_get_clip_references", "h3_get_clip_runtime"]);
const SCOPE_KEYS = ["kind", "id", "projectId", "nodeId", "nodeIds", "sceneId", "segmentId", "segmentIds", "targetId", "targetIds", "version", "snapshot", "sourceSection", "view", "fields", "include", "includeContext", "includeRuntime", "projection", "includeConnections", "pageSize", "nodeLimit", "chunkBytes"];
const PAGE_KEYS = ["cursor", "nodeOffset", "offset", "ifRevision"];
/** 条件读取参数：只影响「要不要返回正文」，不属于内容范围，因此不进 scope 指纹。 */
const CONDITION_KEYS = ["ifChanged"];
const READ_KEYS = new Set([...SCOPE_KEYS, ...PAGE_KEYS, ...CONDITION_KEYS]);
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function observeReadRequest(tool: string, input: Record<string, unknown>, projectId?: string) {
    if (!STATIC_READS.has(tool) || Object.keys(input).some(key => !READ_KEYS.has(key)) || input.includeRuntime === true
        || tool === "h3_get_clip" && Array.isArray(input.include) && input.include.includes("result")
        || tool === "h3_get_clip_runtime" && input.view !== "saved") return {};
    const source: Record<string, unknown> = { ...input, ...(projectId ? { projectId } : {}) };
    const scope = Object.fromEntries(SCOPE_KEYS.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    const page = Object.fromEntries(PAGE_KEYS.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    return { readScopeFingerprint: hash({ tool, scope }), requestFingerprint: hash({ tool, scope, page }),
        readContinuation: Boolean(input.cursor) || Number(input.nodeOffset || input.offset || 0) > 0 };
}

/**
 * 本次请求是否属于「静态内容读取」（同一范围重复读应得到同一内容）。
 * 动态查询（任务状态、等待、结果）不在此列 —— 返回旧值比多读一次更危险。
 */
export function isStaticRead(tool: string, input: Record<string, unknown>, projectId?: string) {
    return "readScopeFingerprint" in observeReadRequest(tool, input, projectId);
}

export function observeReadResult(tool: string, input: Record<string, unknown>, value: unknown, projectId?: string) {
    const request = observeReadRequest(tool, input, projectId);
    if (!("readScopeFingerprint" in request)) return {};
    const result = object(value);
    const envelope = object(result.production && typeof result.production === "object" ? result.production : result.version && typeof result.version === "object" ? result.version : result);
    const body = object(envelope.snapshot && typeof envelope.snapshot === "object" ? envelope.snapshot : envelope);
    const chunk = object(body.chunk);
    const revision = body.revision ?? result.revision;
    const contentHash = chunk.sha256 || body.sha256 || (["production_get_source", "production_get_version_source"].includes(tool) ? body.sourceHash : undefined) || envelope.sha256;
    const unchanged = body.unchanged === true || result.unchanged === true
        || Array.isArray(result.items) && result.items.length > 0 && result.items.every((item: any) => item.unchanged === true);
    const hasMore = body.nextCursor != null || object(body.source).nextCursor != null || chunk.nextCursor != null || body.nextNodeOffset != null;
    const version = typeof revision === "number" ? String(revision) : input.version !== undefined ? `history:${input.version}` : undefined;
    return { ...request, readVersion: version, contentFingerprint: typeof contentHash === "string" && /^[a-f0-9]{64}$/i.test(contentHash) ? contentHash : undefined,
        readReturnedContent: !unchanged && !hasMore && !request.readContinuation, unchanged };
}

export function observeTaskReadResult(tool: string, input: Record<string, unknown>, value: unknown) {
    if (!["canvas_task_status", "h3_get_task", "comfyui_get_task", "generation_get_status"].includes(tool) || typeof input.taskId !== "string") return {};
    const result = object(value);
    const tasks = Array.isArray(result.tasks) ? result.tasks : [result.task || result];
    const task = tasks.map(object).find(task => (task.taskId || task.id) === input.taskId);
    if (!task || typeof task.status !== "string") return {};
    return { observedTaskFingerprint: hash({ tool, taskId: input.taskId }), observedTaskStatus: task.status };
}
