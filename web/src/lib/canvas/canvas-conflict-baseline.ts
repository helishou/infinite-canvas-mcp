import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export const CANVAS_CONFLICT_BASELINE_VERSION = 1;

/** 冲突判定只需要「本次 ops 指向的对象在提交那一刻长什么样」。
 *  值一律**原样复制**（不改写、不指纹化），因此与完整 CanvasProject 的字段
 *  结构完全一致，detectCanvasConflicts 的比对语义零变化。
 *
 *  依赖面（use-canvas-store.ts 逐分支核实）：
 *   - update_node → 目标节点的 metadata[key]（key 为本次 op 携带的键）
 *   - update_project → 项目顶层被 patch 的字段
 *   - delete_connections → 目标连接的整条对象
 *   - H3 段 op → 目标节点的 metadata.segments（按段 id 逐字段比对）
 *   - add_node / delete_node / connect_nodes → 不读 base */
export type CanvasConflictBaseline = {
    v: typeof CANVAS_CONFLICT_BASELINE_VERSION;
    id: string;
    title: unknown;
    revision: number;
    nodes: Array<Record<string, unknown>>;
    connections: Array<Record<string, unknown>>;
    [projectField: string]: unknown;
};

/** 深拷贝但不改写任何值：JSON 往返对画布数据（纯 JSON）是安全的，
 *  且能切断与 store 内对象的引用，避免基线被后续编辑串改。 */
function clone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** 从 operations 反推作用域：只有这些对象会被 detectCanvasConflicts 读到。
 *  - add_node / update_node / delete_node → op.id
 *  - add/update/delete_h3_segment → op.nodeId
 *  - delete_connections → op.ids 对应的连接整条
 *  - update_project → op.patch 的键在项目顶层（保留旧值供比对） */
export function buildCanvasConflictBaseline(
    project: CanvasProject,
    operations: Array<Record<string, unknown>>,
): CanvasConflictBaseline {
    const nodeIds = new Set<string>();
    const connectionIds = new Set<string>();
    const projectKeys = new Set<string>();
    for (const op of operations) {
        if (op.id !== undefined && op.id !== null && op.id !== "") nodeIds.add(String(op.id));
        if (op.nodeId !== undefined && op.nodeId !== null && op.nodeId !== "") nodeIds.add(String(op.nodeId));
        if (Array.isArray(op.ids)) for (const id of op.ids) connectionIds.add(String(id));
        if (op.type === "update_project" && op.patch && typeof op.patch === "object") {
            for (const key of Object.keys(op.patch as Record<string, unknown>)) projectKeys.add(key);
        }
    }
    const projectRecord = project as unknown as Record<string, unknown>;
    const nodes = Array.isArray(project.nodes) ? project.nodes : [];
    const connections = Array.isArray(project.connections) ? project.connections : [];
    const baseline: CanvasConflictBaseline = {
        v: CANVAS_CONFLICT_BASELINE_VERSION,
        id: project.id,
        title: project.title,
        revision: Number(project.revision || 0),
        nodes: nodes.filter((node) => nodeIds.has(String(node.id))).map((node) => clone(node) as Record<string, unknown>),
        connections: connections.filter((connection) => connectionIds.has(String(connection.id))).map((connection) => clone(connection) as Record<string, unknown>),
    };
    for (const key of projectKeys) baseline[key] = clone(projectRecord[key]);
    return baseline;
}

export function isCanvasConflictBaseline(value: unknown): value is CanvasConflictBaseline {
    return Boolean(value && typeof value === "object" && (value as { v?: unknown }).v === CANVAS_CONFLICT_BASELINE_VERSION);
}
