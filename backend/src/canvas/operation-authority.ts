import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { validateNodeUpdate, validateH3Edit, validateH3Metadata } from "@basketikun/canvas-agent/schemas";
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

function isProductionBoundNode(node: Record<string, unknown>) {
    const metadata = recordOf(node.metadata);
    return Boolean(metadata.productionSceneId) || (Array.isArray(metadata.segments) && metadata.segments.some(value => Boolean(recordOf(recordOf(value).productionClipProjection).targetId)));
}
function assertProductionSegmentMembership(previousMetadata: Record<string, unknown>, incoming: unknown) {
    if (!Array.isArray(incoming)) return;
    const previous = Array.isArray(previousMetadata.segments) ? previousMetadata.segments.map(recordOf) : [];
    const ownedIds = previous.filter(segment => Boolean(recordOf(segment.productionClipProjection).targetId)).map(segment => String(segment.id));
    if (!ownedIds.length && !previousMetadata.productionSceneId) return;
    const nextIds = incoming.map(recordOf).map(segment => String(segment.id || ""));
    const expected = previous.map(segment => String(segment.id));
    if (expected.length !== nextIds.length || expected.some((id, index) => id !== nextIds[index])) {
        throw collaborationError("PRODUCTION_CLIP_MEMBERSHIP_OWNED", "制作绑定的 Clip 列表由制作台维护，不能从画布独立新增、删除或重排");
    }
}
function assertProductionStoryboardUnchanged(previous: Record<string, unknown>, incoming: Record<string, unknown>, deleted?: unknown) {
    if (!recordOf(previous.productionClipProjection).targetId) return;
    const removed = Array.isArray(deleted) ? deleted.map(String) : [];
    for (const field of ["storyboardShots", "storyboardDurations"]) {
        if (removed.includes(field) || Object.hasOwn(incoming, field) && commandFingerprint(incoming[field]) !== commandFingerprint(previous[field])) {
            throw collaborationError("PRODUCTION_SHOTBOARD_SOURCE_OWNED", `字段 ${field} 必须通过制作台 Shot 数据写入`);
        }
    }
    if (removed.includes("referenceBindings")) {
        if (productionStoryboardRefs(previous.referenceBindings).length) throw collaborationError("PRODUCTION_SHOTBOARD_SOURCE_OWNED", "制作分镜图绑定必须通过 Shot 关键帧操作修改");
    } else if (Object.hasOwn(incoming, "referenceBindings")
        && commandFingerprint(productionStoryboardRefs(incoming.referenceBindings)) !== commandFingerprint(productionStoryboardRefs(previous.referenceBindings))) {
        throw collaborationError("PRODUCTION_SHOTBOARD_SOURCE_OWNED", "制作分镜图绑定必须通过 Shot 关键帧操作修改");
    }
}
function productionStoryboardRefs(value: unknown) {
    return Array.isArray(value) ? value.map(recordOf).filter(ref => String(ref.role || "") === "storyboard") : [];
}

/** 客户端携带的 source.kind 只是展示信息，不是写后台状态的权限。 */
export function prepareClientCanvasOperation(project: Record<string, unknown>, operation: CanvasOperation) {
    let patch = recordOf(operation.patch);
    if (operation.type === "delete_node") {
        const ids = new Set(Array.isArray(operation.ids) ? operation.ids.map(String) : [String(operation.id || "")]);
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        if (nodes.some(node => ids.has(String(node.id)) && isH3CanvasNode(node) && isProductionBoundNode(node))) {
            throw collaborationError("PRODUCTION_SCENE_NODE_OWNED", "场次 H3 节点由制作台维护；请在制作台确认删除场次");
        }
    }
    if (operation.type === "update_node" && (Object.hasOwn(patch, "id") || Object.hasOwn(patch, "metadata"))) {
        throw collaborationError("INVALID_NODE_PATCH", "节点 ID 不可修改；metadata 必须使用独立的增量字段，不能放在 patch 中整体覆盖");
    }
    if (operation.type === "update_node") {
        const previous = (project.nodes as any[] || []).find(node => node.id === operation.id);
        operation.patch = validateNodeUpdate(operation, previous); patch = recordOf(operation.patch);
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
    if (operation.type === "update_node" && node) {
        const incoming = recordOf(operation.metadata), previous = recordOf(node.metadata);
        if (Object.hasOwn(incoming, "sharedPromotionOrigin") && commandFingerprint(incoming.sharedPromotionOrigin) !== commandFingerprint(previous.sharedPromotionOrigin) || Array.isArray(operation.metadataDelete) && operation.metadataDelete.includes("sharedPromotionOrigin")) throw collaborationError("SHARED_ORIGIN_OWNED", "存量共享接入来源由 Backend 登记，不能直接修改");
    }
    if (!isH3CanvasNode(node)) return;
    const metadata = recordOf(node!.metadata);
    const segments = Array.isArray(metadata.segments) ? metadata.segments as Record<string, unknown>[] : [];
    if (operation.type === "delete_h3_segment") {
        const previous = segments.find(segment => segment.id === operation.segmentId);
        if (previous && recordOf(previous.productionClipProjection).targetId) throw collaborationError("PRODUCTION_CLIP_OWNED", "制作 Clip 由制作台维护；不能从画布单独删除");
    }
    const protectFormal = (previous: Record<string, unknown>, incoming: Record<string, unknown>, deleted?: unknown) => {
        if (Object.hasOwn(incoming, "productionClipProjection") && commandFingerprint(incoming.productionClipProjection) !== commandFingerprint(previous.productionClipProjection) || Array.isArray(deleted) && deleted.includes("productionClipProjection")) throw collaborationError("FORMAL_CLIP_OWNED", "制作投影摘要由 Backend 管理");
        if (!previous.productionClipProjection) return;
        // 创作字段允许手动编辑；保留原编译摘要作为基线，重新投影时检测并保留人工修改。
        for (const field of ["directorEngine", "directorSourceHash"]) if (Array.isArray(deleted) && deleted.includes(field) || Object.hasOwn(incoming, field) && commandFingerprint(incoming[field]) !== commandFingerprint(previous[field])) throw collaborationError("FORMAL_CLIP_OWNED", `字段 ${field} 由 Backend 维护，不能直接修改编译身份`);
    };
    const preserveSegments = (incoming: unknown) => {
        if (!Array.isArray(incoming)) return;
        for (const value of incoming) {
            const segment = recordOf(value);
            const previous = segments.find((item) => item.id === segment.id);
            if (!previous) continue; // 新实体/导入不是对已有任务状态的覆盖。
            assertProductionStoryboardUnchanged(previous, segment);
            const changed = Object.fromEntries(Object.entries(segment).filter(([key, value]) => commandFingerprint(value) !== commandFingerprint(previous[key])));
            Object.assign(segment, withH3ParameterEdits(previous, changed));
            protectFormal(previous, segment);
            if (previous.productionClipProjection) {
                segment.productionClipProjection = structuredClone(previous.productionClipProjection);
                for (const field of ["prompt", "referenceBindings", "directorEngine", "directorSourceHash", "h3CharacterGroups", "storyboardShots", "tailFrameContinuation", "motionContextEnabled"]) if (!Object.hasOwn(segment, field) && Object.hasOwn(previous, field)) segment[field] = structuredClone(previous[field]);
            }
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
        if (isProductionBoundNode(node!)) {
            for (const field of ["productionSceneId", "productionOwnerKind", "productionOwnerId"]) {
                if (Array.isArray(operation.metadataDelete) && operation.metadataDelete.includes(field)
                    || Object.hasOwn(update, field) && commandFingerprint(update[field]) !== commandFingerprint(metadata[field])) {
                    throw collaborationError("PRODUCTION_SCENE_BINDING_OWNED", "制作场次绑定由制作台维护");
                }
            }
            assertProductionSegmentMembership(metadata, update.segments);
        }
        if (Array.isArray(operation.metadataDelete)) operation.metadataDelete = operation.metadataDelete.filter((field) => !H3_LOCAL_VIEW_FIELDS.includes(field as typeof H3_LOCAL_VIEW_FIELDS[number]));
        checkPatch(metadata, update, operation.metadataDelete, H3_RUNTIME_NODE_FIELDS);
        preserveSegments(update.segments);
        validateH3Metadata(update);
    } else if (operation.type === "update_h3_segment") {
        if (Object.hasOwn(patch, "id") || (Array.isArray(operation.patchDelete) && operation.patchDelete.includes("id"))) throw collaborationError("INVALID_NODE_PATCH", "Clip ID 不可修改");
        const previous = segments.find((segment) => segment.id === operation.segmentId);
        if (previous) {
            Object.assign(patch, withH3ParameterEdits(previous, patch));
            assertProductionStoryboardUnchanged(previous, patch, operation.patchDelete);
            protectFormal(previous, patch, operation.patchDelete);
            checkPatch(previous, patch, operation.patchDelete, H3_RUNTIME_SEGMENT_FIELDS);
        }
        validateH3Edit(Object.fromEntries(Object.entries(patch).filter(([key]) => !H3_RUNTIME_SEGMENT_FIELDS.includes(key as any) && key !== "productionClipProjection")), true);
    } else if (operation.type === "replace_h3_segments") {
        assertProductionSegmentMembership(metadata, operation.segments);
        preserveSegments(operation.segments);
    }
}
