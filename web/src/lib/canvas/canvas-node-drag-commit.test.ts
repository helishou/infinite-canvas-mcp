import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { buildCanvasNodeDragCommit } from "./canvas-node-drag-commit";

function node(id: string, type: string, position: Position, metadata: Record<string, unknown> = {}, width = 80, height = 60): CanvasNodeData {
    return { id, type, title: id, position, width, height, metadata } as unknown as CanvasNodeData;
}

test("ordinary canvas drag commits the final preview position and preserves unrelated nodes", () => {
    const moving = node("moving", CanvasNodeType.Text, { x: 10, y: 20 });
    const untouched = node("untouched", CanvasNodeType.Image, { x: 900, y: 700 });
    const result = buildCanvasNodeDragCommit(
        [moving, untouched],
        new Set([moving.id]),
        new Map([[moving.id, moving.position]]),
        new Map([[moving.id, { x: 140, y: 160 }]]),
        { x: 120, y: 140 },
    );

    assert.deepEqual(result[0]?.position, { x: 140, y: 160 });
    assert.equal(result[1], untouched);
});

test("ordinary canvas drag snaps moved members into the group under their center", () => {
    const target = node("target", CanvasNodeType.Group, { x: 0, y: 0 }, {}, 300, 300);
    const moving = node("moving", CanvasNodeType.Image, { x: 500, y: 500 });
    const result = buildCanvasNodeDragCommit(
        [target, moving],
        new Set([moving.id]),
        new Map([[moving.id, moving.position]]),
        new Map([[moving.id, { x: 100, y: 100 }]]),
        { x: -400, y: -400 },
    );

    assert.equal(result[1]?.metadata?.groupId, "target");
    assert.deepEqual(result[1]?.position, { x: 100, y: 100 });
});

test("moving a group preserves its ordered membership rather than inferring members from new geometry", () => {
    const group = node("ordered", CanvasNodeType.Group, { x: 0, y: 0 }, { orderedGroup: true, groupSlots: ["member"] }, 300, 240);
    const member = node("member", CanvasNodeType.Text, { x: 40, y: 70 }, { groupId: "ordered" });
    const result = buildCanvasNodeDragCommit(
        [group, member],
        new Set([group.id, member.id]),
        new Map([[group.id, group.position], [member.id, member.position]]),
        new Map([[group.id, { x: 500, y: 500 }], [member.id, { x: 540, y: 570 }]]),
        { x: 500, y: 500 },
    );

    assert.deepEqual(result[0]?.metadata?.groupSlots, ["member"]);
    assert.equal(result[1]?.metadata?.groupId, "ordered");
    assert.deepEqual(result[1]?.position, { x: 540, y: 570 });
});

test("leaving an ordered group updates its slot list and retains the remaining membership", () => {
    const group = node("ordered", CanvasNodeType.Group, { x: 0, y: 0 }, { orderedGroup: true, groupSlots: ["moving", "staying"] }, 440, 260);
    const moving = node("moving", CanvasNodeType.Text, { x: 48, y: 120 }, { groupId: "ordered" });
    const staying = node("staying", CanvasNodeType.Text, { x: 160, y: 120 }, { groupId: "ordered" });
    const result = buildCanvasNodeDragCommit(
        [group, moving, staying],
        new Set([moving.id]),
        new Map([[moving.id, moving.position]]),
        new Map([[moving.id, { x: 800, y: 500 }]]),
        { x: 752, y: 380 },
    );

    assert.deepEqual(result[0]?.metadata?.groupSlots, ["staying"]);
    assert.equal(result[1]?.metadata?.groupId, undefined);
    assert.equal(result[2]?.metadata?.groupId, "ordered");
});
