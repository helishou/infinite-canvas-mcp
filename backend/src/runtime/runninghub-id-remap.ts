/**
 * 云端节点编号变化时的字段映射迁移。
 *
 * 什么时候会变：用户在 RunningHub 网页端增删节点、或用另一份图覆盖后，平台重新分配节点 id；
 * 本地档案里保存的映射（`nodeId::fieldName`）就指向了不存在的节点——
 * 字段会静默失效、运行提交写到错节点。这里把旧映射按「节点类型 + 出现顺序」搬到新编号上。
 *
 * 只在同类型节点数量一致时才搬：数量变了说明真的增删过节点，按顺序硬凑会把配置错位到别的节点，
 * 宁可让这个类型下的字段回到未启用状态，也不写错。
 */
import type { RunningHubField } from "@basketikun/canvas-agent/generation-contract";

type Json = Record<string, any>;

function numericId(id: string): number {
    const value = Number(id);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** 按 class_type 分组，组内按节点编号排序。 */
function groupByClass(graph: Json): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const [nodeId, raw] of Object.entries(graph || {})) {
        const type = String((raw as Json)?.class_type || "");
        if (!type) continue;
        const list = groups.get(type) || [];
        list.push(nodeId);
        groups.set(type, list);
    }
    for (const list of groups.values()) list.sort((left, right) => numericId(left) - numericId(right));
    return groups;
}

/** 旧编号 → 新编号；同类型数量不一致的组不参与。 */
export function buildNodeIdMapping(previousGraph: Json, nextGraph: Json): Map<string, string> {
    const before = groupByClass(previousGraph);
    const after = groupByClass(nextGraph);
    const mapping = new Map<string, string>();
    for (const [type, oldIds] of before) {
        const newIds = after.get(type);
        if (!newIds || newIds.length !== oldIds.length) continue;
        oldIds.forEach((oldId, index) => {
            const newId = newIds[index];
            if (newId && newId !== oldId) mapping.set(oldId, newId);
        });
    }
    return mapping;
}

/**
 * 运行提交前的对齐：字段编号全都在新图上就直接用；有对不上的才按类型迁移。
 * 迁移后一个都落不下时仍返回原字段，让上层报出「请重新同步映射」，而不是静默丢字段。
 */
export function alignFieldsToGraph(previousGraph: Json, nextGraph: Json, fields: RunningHubField[]): RunningHubField[] {
    if (!fields?.length) return fields;
    if (fields.every((field) => Object.hasOwn(nextGraph || {}, field.nodeId))) return fields;
    const moved = remapRunningHubFields(previousGraph, nextGraph, fields);
    return moved.length ? moved : fields;
}

/**
 * 把字段映射迁移到新节点图。
 * - 节点编号没变的原样保留；
 * - 编号变了的按映射改 `nodeId` 并重建 `id`（运行提交用 id 当参数键，必须一起改）；
 * - 新图里找不到对应节点的字段丢弃，避免提交到不存在的节点。
 */
export function remapRunningHubFields(previousGraph: Json, nextGraph: Json, fields: RunningHubField[]): RunningHubField[] {
    if (!fields?.length) return [];
    const mapping = buildNodeIdMapping(previousGraph, nextGraph);
    const remapped: RunningHubField[] = [];
    for (const field of fields) {
        if (Object.hasOwn(nextGraph || {}, field.nodeId)) {
            remapped.push(field);
            continue;
        }
        const target = mapping.get(field.nodeId);
        if (!target || !Object.hasOwn(nextGraph, target)) continue;
        remapped.push({ ...field, nodeId: target, id: `${target}::${field.fieldName}` });
    }
    return remapped;
}
