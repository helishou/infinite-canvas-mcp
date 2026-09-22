import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { arrangeOrderedGroupMembers, insertOrderedGroupSlot, orderedGroupDisplaySlots, orderedGroupDraggedCenter, orderedGroupDropTarget, orderedGroupResizeLayout, orderedGroupSlots, swapOrderedGroupSlot } from "@/lib/canvas/ordered-group";

const group = (slots: Array<string | null>): CanvasNodeData => ({
    id: "g",
    type: CanvasNodeType.Group,
    title: "组",
    position: { x: 0, y: 0 },
    width: 760,
    height: 480,
    metadata: { orderedGroup: true, groupSlots: slots as string[] },
});

const member = (id: string, groupId?: string): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x: 0, y: 0 },
    width: 200,
    height: 120,
    metadata: groupId ? { groupId } : {},
});

test("ordered group removes stale empty slots when a member leaves", () => {
    const result = orderedGroupSlots(group(["a", null, "b"]), [group(["a", null, "b"]), member("a", "g"), member("b", "g")]);
    assert.deepEqual(result, ["a", "b"]);
});

test("ordered group automatically completes the last row and adds a fresh row when full", () => {
    assert.deepEqual(orderedGroupDisplaySlots(["a", "b", "c"]), ["a", "b", "c", null]);
    assert.deepEqual(orderedGroupDisplaySlots(["a", "b", "c", "d"]), ["a", "b", "c", "d", null, null, null, null]);
    assert.deepEqual(orderedGroupDisplaySlots(["a", "b", "c", "d", "e", "f", "g"]), ["a", "b", "c", "d", "e", "f", "g", null]);
});

test("ordered group arrange preserves member sizes and derives rows and columns from them", () => {
    const target = { ...group(["a", "b", "c"]), width: 700, height: 420 };
    const nodes = [target, { ...member("a", "g"), width: 180, height: 120 }, { ...member("b", "g"), width: 220, height: 140 }, { ...member("c", "g"), width: 160, height: 100 }];
    const result = arrangeOrderedGroupMembers(target, nodes);
    assert.ok(result.columns >= 1);
    assert.equal(result.members.size, 3);
    assert.ok(result.width > 0 && result.height > 0);
    assert.equal(result.position.x + result.width / 2, target.position.x + target.width / 2);
    assert.equal(result.position.y + result.height / 2, target.position.y + target.height / 2);
    assert.equal(nodes[1].width, 180);
    assert.equal(nodes[2].height, 140);
});

test("ordered group arrange caps columns and stays stable on repeated arrange", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `n${index}`);
    const target = { ...group(ids), width: 1200, height: 600 };
    const nodes = [target, ...ids.map((id) => ({ ...member(id, "g"), width: 100, height: 80 }))];
    const first = arrangeOrderedGroupMembers(target, nodes);
    assert.ok(first.columns <= 12);
    const arrangedGroup = { ...target, position: first.position, width: first.width, height: first.height, metadata: { ...target.metadata, orderedGroupColumns: first.columns } };
    const arrangedNodes = nodes.map((node) => first.members.has(node.id) ? { ...node, position: first.members.get(node.id)! } : node.id === target.id ? arrangedGroup : node);
    const second = arrangeOrderedGroupMembers(arrangedGroup, arrangedNodes);
    assert.equal(second.columns, first.columns);
    assert.deepEqual(second.position, first.position);
    assert.equal(second.width, first.width);
    assert.equal(second.height, first.height);
});

test("gap insertion and occupied-slot swap preserve ordered semantics", () => {
    assert.deepEqual(insertOrderedGroupSlot(["a", "b", null], "c", 1), ["a", "c", "b"]);
    assert.deepEqual(swapOrderedGroupSlot(["a", "b", "c"], 0, 2), ["c", "b", "a"]);
});

test("drop target distinguishes an occupied member from visual whitespace between members", () => {
    const target = group(["a", "b", "c", "d"]);
    const occupied = [
        { index: 0, x: 100, y: 90, width: 120, height: 100 },
        { index: 1, x: 250, y: 90, width: 120, height: 100 },
    ];
    const member = orderedGroupDropTarget(target, 4, { x: 150, y: 120 }, occupied);
    const visualGap = orderedGroupDropTarget(target, 4, { x: 235, y: 120 }, occupied);
    assert.deepEqual(member, { kind: "slot", index: 0 });
    assert.equal(visualGap?.kind, "gap");
    assert.equal(visualGap?.index, 1);
});

test("drop targeting follows the dragged node center instead of the grabbed cursor offset", () => {
    assert.deepEqual(orderedGroupDraggedCenter({ x: 100, y: 80 }, { x: 200, y: 40 }, { width: 160, height: 100 }), { x: 380, y: 170 });
});

test("blank area after the final occupied slot resolves to the end gap", () => {
    const target = group(["a", "b", "c"]);
    const result = orderedGroupDropTarget(target, 3, { x: 700, y: 350 }, []);
    assert.deepEqual(result, { kind: "gap", index: 3 });
});

test("resizing an ordered group reflows slots without changing member sizes", () => {
    const target = group(["a", "b", "c"]);
    const nodes = [target, member("a", "g"), member("b", "g"), member("c", "g")];
    const layout = orderedGroupResizeLayout(target, { position: { x: 40, y: 30 }, width: 420, height: 760 }, nodes);
    assert.equal(layout.size, 3);
    assert.equal(layout.get("a")?.width, nodes[1].width);
    assert.equal(layout.get("a")?.height, nodes[1].height);
    assert.notDeepEqual(layout.get("a")?.position, layout.get("b")?.position);
});
