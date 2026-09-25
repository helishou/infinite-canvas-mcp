import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { arrangeOrderedGroupMembers, inheritOrderedGroupOutputs, insertOrderedGroupSlot, moveOrderedGroupSlot, orderedGroupColumnCount, orderedGroupDisplaySlots, orderedGroupDraggedCenter, orderedGroupDropTarget, orderedGroupLayout, orderedGroupMemberPosition, orderedGroupMemberSize, orderedGroupResizeLayout, orderedGroupSlots, replaceOrderedGroupSlot, swapOrderedGroupSlot, syncOrderedGroupMembership, transferOrderedGroupH3References } from "@/lib/canvas/ordered-group";

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

test("ordered group slots are the membership record, not the group rectangle or groupId", () => {
    const target = group(["a"]);
    const recordedBySlot = member("a");
    const visuallyInside = { ...member("mcp-node"), position: { x: 120, y: 100 } };
    const explicitlyRecorded = { ...member("recorded"), position: { x: 240, y: 100 } };
    assert.deepEqual(orderedGroupSlots(target, [target, recordedBySlot, visuallyInside, explicitlyRecorded]), ["a"]);
    assert.deepEqual(orderedGroupSlots({ ...target, metadata: { ...target.metadata, groupSlots: ["recorded"] } }, [target, recordedBySlot, visuallyInside, explicitlyRecorded]), ["recorded"]);
    assert.deepEqual(orderedGroupSlots({ ...target, metadata: { ...target.metadata, groupSlots: [] } }, [target, { ...recordedBySlot, metadata: { groupId: "g" } }, visuallyInside, explicitlyRecorded]), ["a"]);
    assert.deepEqual(orderedGroupSlots({ ...target, metadata: { orderedGroup: true } }, [target, { ...recordedBySlot, metadata: { groupId: "g" } }]), ["a"]);
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
    assert.deepEqual(moveOrderedGroupSlot(["a", "b", "c"], 0, 2), ["b", "a", "c"]);
    assert.deepEqual(moveOrderedGroupSlot(["a", "b", "c"], 2, 1), ["a", "c", "b"]);
    assert.deepEqual(swapOrderedGroupSlot(["a", "b", "c"], 0, 2), ["c", "b", "a"]);
    assert.deepEqual(replaceOrderedGroupSlot(["a", "b", "c"], "outside", 1), { slots: ["a", "outside", "c"], displacedId: "b" });
});

test("an outside node inherits only the displaced ordered member's outputs", () => {
    const connections = [
        { id: "input", fromNodeId: "upstream", toNodeId: "inside" },
        { id: "output", fromNodeId: "inside", toNodeId: "downstream" },
        { id: "would-self-connect", fromNodeId: "inside", toNodeId: "outside" },
        { id: "existing", fromNodeId: "outside", toNodeId: "other" },
    ];
    assert.deepEqual(inheritOrderedGroupOutputs(connections, "inside", "outside"), [
        connections[0],
        { id: "output", fromNodeId: "outside", toNodeId: "downstream" },
        connections[3],
    ]);
});

test("transferring an ordered member output also retargets H3 clip references", () => {
    const h3 = member("h3");
    h3.metadata = { segments: [{ id: "clip-1", referenceBindings: [{ id: "binding", sourceNodeId: "inside", mediaType: "image", url: "old" }], refItems: [{ bindingId: "binding", nodeId: "inside", type: "image", url: "old" }], refs: { image: [{ bindingId: "binding", nodeId: "inside", type: "image", url: "old" }] } }] } as never;
    const outside = { ...member("outside"), title: "新图片" };
    const result = transferOrderedGroupH3References(h3, "inside", outside, [{ kind: "image", url: "new", storageKey: "new.webp" }]);
    const segment = (result.metadata as any).segments[0];
    assert.equal(segment.referenceBindings[0].sourceNodeId, "outside");
    assert.equal(segment.referenceBindings[0].url, "new");
    assert.equal(segment.refItems[0].nodeId, "outside");
    assert.equal(segment.refs.image[0].nodeId, "outside");
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

test("a picture grabbed near its edge still inserts at the slot under its center", () => {
    const target = group(["a", "b", "c"]);
    const occupied = [
        { index: 0, x: 24, y: 52, width: 150, height: 120 },
        { index: 1, x: 188, y: 52, width: 150, height: 120 },
        { index: 2, x: 352, y: 52, width: 150, height: 120 },
    ];
    const center = orderedGroupDraggedCenter({ x: 352, y: 52 }, { x: -150, y: 0 }, { width: 150, height: 120 });
    const grabbedPoint = { x: 368, y: 300 };
    assert.deepEqual(orderedGroupDropTarget(target, 3, center, occupied), { kind: "slot", index: 1 });
    assert.equal(orderedGroupDropTarget(target, 3, grabbedPoint, occupied)?.index, 2);
});

test("blank area after the final occupied slot resolves to the end gap", () => {
    const target = group(["a", "b", "c"]);
    const result = orderedGroupDropTarget(target, 3, { x: 700, y: 350 }, []);
    assert.deepEqual(result, { kind: "gap", index: 3 });
});

test("shrinking an ordered group scales members proportionally and keeps every member inside its slot", () => {
    const target = group(["a", "b", "c"]);
    const nodes = [target, member("a", "g"), member("b", "g"), member("c", "g")];
    const bounds = { position: { x: 40, y: 30 }, width: 420, height: 760 };
    const resizedGroup = { ...target, ...bounds };
    const layout = orderedGroupResizeLayout(target, bounds, nodes);
    const cells = orderedGroupLayout(resizedGroup, orderedGroupDisplaySlots(nodes.slice(1).map((node) => node.id), orderedGroupColumnCount(target)).length);

    assert.equal(layout.size, 3);
    nodes.slice(1).forEach((node, index) => {
        const memberBounds = layout.get(node.id);
        assert.ok(memberBounds);
        assert.equal(memberBounds.width / memberBounds.height, node.width / node.height);
        const memberScales = nodes.slice(1).map((node) => {
            const bounds = layout.get(node.id);
            return bounds ? bounds.width / node.width : 0;
        });
        assert.ok(memberScales.every((scale) => Math.abs(scale - memberScales[0]) < 1e-9));
        assert.ok(memberBounds.width <= cells[index].width);
        assert.ok(memberBounds.height <= cells[index].height);
        assert.ok(memberBounds.position.x >= resizedGroup.position.x + cells[index].x);
        assert.ok(memberBounds.position.y >= resizedGroup.position.y + cells[index].y);
        assert.ok(memberBounds.position.x + memberBounds.width <= resizedGroup.position.x + cells[index].x + cells[index].width);
        assert.ok(memberBounds.position.y + memberBounds.height <= resizedGroup.position.y + cells[index].y + cells[index].height);
    });
    assert.notDeepEqual(layout.get("a")?.position, layout.get("b")?.position);
});

test("small ordered groups keep their cells and members inside the frame", () => {
    const target = { ...group(["a", "b", "c"]), width: 220, height: 160 };
    const cells = orderedGroupLayout(target, orderedGroupDisplaySlots(["a", "b", "c"]).length);
    for (const cell of cells) {
        assert.ok(cell.x >= 0 && cell.y >= 0);
        assert.ok(cell.x + cell.width <= target.width);
        assert.ok(cell.y + cell.height <= target.height);
    }
    const oversized = member("a", "g");
    const size = orderedGroupMemberSize(target, 0, oversized, cells.length);
    const position = orderedGroupMemberPosition(target, 0, oversized, cells.length);
    assert.ok(size.width <= cells[0].width && size.height <= cells[0].height);
    assert.ok(position.x >= cells[0].x && position.x + size.width <= cells[0].x + cells[0].width);
    const manyCells = orderedGroupLayout(target, orderedGroupDisplaySlots(Array.from({ length: 40 }, (_, index) => `n${index}`)).length);
    assert.ok(manyCells.every((cell) => cell.y >= 0 && cell.y + cell.height <= target.height));
});

test("enlarging an ordered group grows its previously scaled members", () => {
    const small = { ...group(["a"]), width: 420, height: 264 };
    const image = { ...member("a", "g"), width: 80, height: 48 };
    const enlarged = orderedGroupResizeLayout(small, { position: small.position, width: 760, height: 480 }, [small, image]).get("a");
    assert.ok(enlarged);
    assert.ok(enlarged.width > image.width && enlarged.height > image.height);
    assert.ok(Math.abs(enlarged.width / enlarged.height - image.width / image.height) < 1e-9);
});

test("shrinking and enlarging a group restores fitting member dimensions", () => {
    const original = group(["a"]);
    const image = { ...member("a", "g"), width: 160, height: 120 };
    const smallerBounds = { position: original.position, width: 420, height: original.height * 420 / original.width };
    const smaller = orderedGroupResizeLayout(original, smallerBounds, [original, image]).get("a")!;
    const smallerGroup = { ...original, ...smallerBounds };
    const restored = orderedGroupResizeLayout(smallerGroup, { position: original.position, width: original.width, height: original.height }, [smallerGroup, { ...image, ...smaller }]).get("a")!;
    assert.ok(Math.abs(restored.width - image.width) < 1e-9);
    assert.ok(Math.abs(restored.height - image.height) < 1e-9);
});

test("an externally added member is resized to its ordered slot", () => {
    const target = { ...group(["a"]), width: 220, height: 160 };
    const incoming = { ...member("b", "g"), width: 400, height: 240 };
    const updated = syncOrderedGroupMembership([target, member("a", "g"), incoming], "b");
    const placed = updated.find((node) => node.id === "b")!;
    const cell = orderedGroupLayout(target, 4)[1];
    assert.ok(placed.width <= cell.width && placed.height <= cell.height);
    assert.ok(placed.position.x >= cell.x && placed.position.x + placed.width <= cell.x + cell.width);
});

test("external membership reflows earlier members when a new row appears", () => {
    const target = group(["a", "b", "c"]);
    const previous = ["a", "b", "c"].map((id) => ({ ...member(id, "g"), width: 160, height: 300 }));
    const updated = syncOrderedGroupMembership([target, ...previous, member("d", "g")], "d");
    const cells = orderedGroupLayout(target, 8);
    for (const [index, id] of ["a", "b", "c", "d"].entries()) {
        const placed = updated.find((node) => node.id === id)!;
        assert.ok(placed.height <= cells[index].height);
        assert.ok(placed.position.y >= cells[index].y);
        assert.ok(placed.position.y + placed.height <= cells[index].y + cells[index].height);
    }
});
