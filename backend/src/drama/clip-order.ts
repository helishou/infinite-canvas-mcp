import type { CanvasOperation } from "../canvas/project-ops.js";

/** Reorder formal slots without losing results or moving foreign Clip slots. */
export function formalClipOrderOperations(nodeId: string, existingIds: string[], formalIds: string[]): CanvasOperation[] {
    const formal = new Set(formalIds);
    const ordered = formalIds.filter(id => existingIds.includes(id));
    if (new Set(ordered).size !== ordered.length) throw new Error("Formal Clip IDs must be unique");
    let cursor = 0;
    const desired = existingIds.map(id => formal.has(id) ? ordered[cursor++] : id);
    const current = [...existingIds], operations: CanvasOperation[] = [];
    for (let index = 0; index < desired.length; index++) {
        const id = desired[index];
        if (!formal.has(id) || current[index] === id) continue;
        current.splice(current.indexOf(id), 1);
        if (index === 0) {
            operations.push({ type: "move_h3_segment", nodeId, segmentId: id, beforeSegmentId: current[0] });
            current.unshift(id);
        } else {
            const prior = desired[index - 1];
            operations.push({ type: "move_h3_segment", nodeId, segmentId: id, afterSegmentId: prior });
            current.splice(current.indexOf(prior) + 1, 0, id);
        }
    }
    if (current.join("\0") !== desired.join("\0")) throw new Error("Cannot preserve foreign Clip slots while ordering formal Clips");
    return operations;
}
