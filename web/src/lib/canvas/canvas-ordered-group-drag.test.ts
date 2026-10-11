import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildOrderedGroupDragCommit } from "./canvas-ordered-group-drag";

function group(id: string, slots: string[], x: number): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Group,
        title: id,
        position: { x, y: 0 },
        width: 760,
        height: 480,
        metadata: { orderedGroup: true, groupSlots: slots },
    };
}

function member(id: string, groupId?: string, x = 0): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, title: id, position: { x, y: 100 }, width: 200, height: 120, metadata: groupId ? { groupId } : {} };
}

test("cross-group occupied-slot drop replaces the target slot and moves its member into the source slot", () => {
    const source = group("source", ["dragged", "remaining"], 0);
    const target = group("target", ["occupied", "tail"], 1000);
    const dragged = member("dragged", "source", 100);
    const remaining = member("remaining", "source", 300);
    const occupied = member("occupied", "target", 1100);
    const tail = member("tail", "target", 1300);
    const result = buildOrderedGroupDragCommit([source, target, dragged, remaining, occupied, tail], dragged, target.id, { kind: "slot", index: 0 });

    assert.deepEqual(result.nodes.find((item) => item.id === "target")?.metadata?.groupSlots, ["dragged", "tail"]);
    assert.deepEqual(result.nodes.find((item) => item.id === "source")?.metadata?.groupSlots, ["occupied", "remaining"]);
    assert.equal(result.nodes.find((item) => item.id === "dragged")?.metadata?.groupId, "target");
    assert.equal(result.nodes.find((item) => item.id === "occupied")?.metadata?.groupId, "source");
    assert.equal(result.inheritedOutputSourceId, "occupied");
});

test("cross-group gap drop removes the member from its source and inserts it at the target gap", () => {
    const source = group("source", ["dragged", "remaining"], 0);
    const target = group("target", ["a", "b"], 1000);
    const dragged = member("dragged", "source", 100);
    const nodes = [source, target, dragged, member("remaining", "source"), member("a", "target"), member("b", "target")];
    const result = buildOrderedGroupDragCommit(nodes, dragged, target.id, { kind: "gap", index: 1 });

    assert.deepEqual(result.nodes.find((item) => item.id === "target")?.metadata?.groupSlots, ["a", "dragged", "b"]);
    assert.deepEqual(result.nodes.find((item) => item.id === "source")?.metadata?.groupSlots, ["remaining"]);
    assert.equal(result.nodes.find((item) => item.id === "dragged")?.metadata?.groupId, "target");
    assert.equal(result.inheritedOutputSourceId, undefined);
});

test("same-group occupied-slot drop swaps slots without transferring membership", () => {
    const ordered = group("ordered", ["a", "b", "c"], 0);
    const dragged = member("a", "ordered");
    const nodes = [ordered, dragged, member("b", "ordered"), member("c", "ordered")];
    const result = buildOrderedGroupDragCommit(nodes, dragged, ordered.id, { kind: "slot", index: 2 });

    assert.deepEqual(result.nodes.find((item) => item.id === "ordered")?.metadata?.groupSlots, ["c", "b", "a"]);
    assert.equal(result.nodes.find((item) => item.id === "a")?.metadata?.groupId, "ordered");
    assert.equal(result.inheritedOutputSourceId, undefined);
});

test("outside node replacing an occupied slot inherits the slot output and is placed where the member was", () => {
    const target = group("target", ["occupied", "tail"], 1000);
    const dragged = member("dragged", undefined, 600);
    const occupied = member("occupied", "target", 1100);
    const result = buildOrderedGroupDragCommit([target, dragged, occupied, member("tail", "target")], dragged, target.id, { kind: "slot", index: 0 });

    assert.deepEqual(result.nodes.find((item) => item.id === "target")?.metadata?.groupSlots, ["dragged", "tail"]);
    assert.equal(result.nodes.find((item) => item.id === "occupied")?.metadata?.groupId, undefined);
    assert.deepEqual(result.nodes.find((item) => item.id === "occupied")?.position, dragged.position);
    assert.equal(result.inheritedOutputSourceId, "occupied");
});
