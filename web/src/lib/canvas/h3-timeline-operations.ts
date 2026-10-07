import { compactH3SegmentStarts } from "@basketikun/canvas-agent/runtime-fields";

type Operation = Record<string, unknown>;

/** 沿已存在的成员序列生成移动命令，新增/删除由调用方先应用。 */
export function h3SegmentOrderOperations(nodeId: string, previous: string[], desired: string[]): Operation[] {
    const order = [...previous];
    const operations: Operation[] = [];
    desired.forEach((id, index) => {
        if (order[index] === id) return;
        const from = order.indexOf(id);
        if (from < 0 || !order[index]) throw new Error("H3 排序成员不一致，保留原草稿");
        operations.push({ type: "move_h3_segment", nodeId, segmentId: id, beforeSegmentId: order[index] });
        order.splice(from, 1);
        order.splice(index, 0, id);
    });
    return operations;
}

/** 仅用于用户明确选择恢复后的旧命令转换；不改写原请求或未确认请求。 */
export function recoverH3StartOperations(operations: Operation[], base: { nodes: any[] }): Operation[] | null {
    const affected = new Set(operations.filter((op) => op.type === "update_h3_segment"
        && (Object.hasOwn((op.patch || {}) as object, "start") || (op.patchDelete as string[] | undefined)?.includes("start")))
        .map((op) => String(op.nodeId)));
    if (!affected.size) return structuredClone(operations);
    const result: Operation[] = [];
    const timelines = new Map<string, { segments: Operation[]; fallback: unknown }>();
    for (const nodeId of affected) {
        const node = base.nodes.find((node) => String(node.id) === nodeId);
        if (!Array.isArray(node?.metadata?.segments)) return null;
        timelines.set(nodeId, { segments: compactH3SegmentStarts(structuredClone(node.metadata.segments), node.metadata.duration), fallback: node.metadata.duration });
    }
    // 重放的是捕获的命令字段，只从完整、连续且唯一的旧起点恢复丢失的排序意图。
    for (const original of operations) {
        const op = structuredClone(original);
        const timeline = timelines.get(String(op.nodeId));
        if (timeline) {
            const segments = timeline.segments;
            const index = segments.findIndex((segment) => String(segment.id) === String(op.segmentId));
            if (op.type === "update_h3_segment") {
                if (index < 0) return null;
                Object.assign(segments[index], op.patch || {});
                for (const key of (op.patchDelete || []) as string[]) delete segments[index][key];
                delete (op.patch as Operation | undefined)?.start;
                if (Array.isArray(op.patchDelete)) op.patchDelete = op.patchDelete.filter((key) => key !== "start");
                if (!Object.keys(op.patch || {}).length && !(op.patchDelete as string[] | undefined)?.length) continue;
            } else if (op.type === "add_h3_segment") {
                const incoming = op.segment as Operation;
                const anchor = op.beforeSegmentId || op.afterSegmentId;
                const anchorIndex = anchor ? segments.findIndex((segment) => String(segment.id) === String(anchor)) : segments.length;
                if (anchorIndex < 0) return null;
                segments.splice(anchorIndex + (op.afterSegmentId ? 1 : 0), 0, structuredClone(incoming));
            } else if (op.type === "delete_h3_segment") {
                if (index >= 0) segments.splice(index, 1);
            } else if (op.type === "move_h3_segment" || op.type === "replace_h3_segments") return null;
        }
        result.push(op);
    }
    for (const [nodeId, timeline] of timelines) {
        const sorted = [...timeline.segments].sort((a, b) => Number(a.start) - Number(b.start));
        const compact = compactH3SegmentStarts(sorted, timeline.fallback);
        if (sorted.some((segment, index) => typeof segment.start !== "number" || !Number.isFinite(segment.start)
            || Math.abs(segment.start - Number(compact[index].start)) > 1e-6)) return null;
        result.push(...h3SegmentOrderOperations(nodeId, timeline.segments.map((segment) => String(segment.id)), sorted.map((segment) => String(segment.id))));
    }
    return result;
}
