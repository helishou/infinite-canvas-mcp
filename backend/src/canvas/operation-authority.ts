import { CANVAS_ACTIVE_TASK_NODE_FIELDS, H3_LOCAL_VIEW_FIELDS, H3_RUNTIME_NODE_FIELDS, H3_RUNTIME_SEGMENT_FIELDS } from "@basketikun/canvas-agent/runtime-fields";
import { isH3CanvasNode, type CanvasOperation } from "./project-ops.js";
import { collaborationError, commandFingerprint } from "./collaboration.js";

const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reject = (field: string) => { throw collaborationError("RUNTIME_FIELD_OWNED", `字段 ${field} 由后台任务维护，请使用生成/取消等任务命令`); };

function withoutH3LocalViewFields(value: unknown) {
    const metadata = { ...recordOf(value) };
    for (const field of H3_LOCAL_VIEW_FIELDS) delete metadata[field];
    return metadata;
}

/** 新建/导入边界同样剥离个人视图，避免旧客户端把窗口状态写进共享项目种子。 */
export function stripCanvasLocalViewState<T extends Record<string, unknown>>(input: T): T {
    const project = structuredClone(input) as T & { nodes?: unknown[] };
    if (!Array.isArray(project.nodes)) return project;
    project.nodes = project.nodes.map((value) => {
        const node = recordOf(value);
        return isH3CanvasNode(node) ? { ...node, metadata: withoutH3LocalViewFields(node.metadata) } : node;
    });
    return project as T;
}

function checkPatch(previous: Record<string, unknown>, patch: Record<string, unknown>, deleted: unknown, fields: readonly string[]) {
    for (const key of fields) {
        if (Array.isArray(deleted) && deleted.includes(key)) reject(key);
        if (Object.hasOwn(patch, key) && commandFingerprint([previous[key]]) !== commandFingerprint([patch[key]])) reject(key);
    }
}

/** 客户端携带的 source.kind 只是展示信息，不是写后台状态的权限。 */
export function prepareClientCanvasOperation(project: Record<string, unknown>, operation: CanvasOperation) {
    const patch = recordOf(operation.patch);
    if (operation.type === "update_node" && (Object.hasOwn(patch, "id") || Object.hasOwn(patch, "metadata"))) {
        throw collaborationError("INVALID_NODE_PATCH", "节点 ID 不可修改；metadata 必须使用独立的增量字段，不能放在 patch 中整体覆盖");
    }
    if (operation.type === "add_node" && isH3CanvasNode({ type: operation.nodeType })) {
        operation.metadata = withoutH3LocalViewFields(operation.metadata);
    }
    const nodeId = operation.type === "update_node" ? operation.id : operation.nodeId;
    const node = (Array.isArray(project.nodes) ? project.nodes as Record<string, unknown>[] : []).find((node) => node.id === nodeId);
    if (operation.type === "update_node" && node && !isH3CanvasNode(node)) {
        const metadata = recordOf(node.metadata);
        // 普通媒体/文本生成（含浏览器脚本执行器）先由 Backend 绑定任务；绑定期间收口瞬态字段。
        // 旧窗口夹带这些字段时直接保留后台值，避免连同同批提示词/布局编辑一起拒绝。
        if (String(metadata.runtimeTaskId || "")) {
            const update = recordOf(operation.metadata);
            for (const field of CANVAS_ACTIVE_TASK_NODE_FIELDS) delete update[field];
            operation.metadata = update;
            if (Array.isArray(operation.metadataDelete)) operation.metadataDelete = operation.metadataDelete.filter((field) => !CANVAS_ACTIVE_TASK_NODE_FIELDS.includes(field as typeof CANVAS_ACTIVE_TASK_NODE_FIELDS[number]));
        }
    }
    if (!isH3CanvasNode(node)) return;
    const metadata = recordOf(node!.metadata);
    const segments = Array.isArray(metadata.segments) ? metadata.segments as Record<string, unknown>[] : [];
    const preserveSegments = (incoming: unknown) => {
        if (!Array.isArray(incoming)) return;
        for (const value of incoming) {
            const segment = recordOf(value);
            const previous = segments.find((item) => item.id === segment.id);
            if (!previous) continue; // 新实体/导入不是对已有任务状态的覆盖。
            checkPatch(previous, segment, undefined, H3_RUNTIME_SEGMENT_FIELDS);
            // 重排/完整替换可以省略只读字段，必须按稳定 ID 从后台继承，不能丢掉结果。
            for (const key of H3_RUNTIME_SEGMENT_FIELDS) if (Object.hasOwn(previous, key)) segment[key] = structuredClone(previous[key]);
        }
    };
    if (operation.type === "update_node") {
        if (Object.hasOwn(patch, "type") && patch.type !== node!.type) reject("type（运行节点类型）");
        if (Array.isArray(operation.metadataDelete) && operation.metadataDelete.includes("segments")) {
            throw collaborationError("INVALID_NODE_PATCH", "删除 Clip 必须使用 delete_h3_segment 或 replace_h3_segments，不能删除整个 segments 字段");
        }
        const update = withoutH3LocalViewFields(operation.metadata);
        operation.metadata = update;
        if (Array.isArray(operation.metadataDelete)) operation.metadataDelete = operation.metadataDelete.filter((field) => !H3_LOCAL_VIEW_FIELDS.includes(field as typeof H3_LOCAL_VIEW_FIELDS[number]));
        checkPatch(metadata, update, operation.metadataDelete, H3_RUNTIME_NODE_FIELDS);
        preserveSegments(update.segments);
    } else if (operation.type === "update_h3_segment") {
        if (Object.hasOwn(patch, "id") || (Array.isArray(operation.patchDelete) && operation.patchDelete.includes("id"))) throw collaborationError("INVALID_NODE_PATCH", "Clip ID 不可修改");
        const previous = segments.find((segment) => segment.id === operation.segmentId);
        if (previous) checkPatch(previous, patch, operation.patchDelete, H3_RUNTIME_SEGMENT_FIELDS);
    } else if (operation.type === "replace_h3_segments") preserveSegments(operation.segments);
}
