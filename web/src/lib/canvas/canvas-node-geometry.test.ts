import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { findContainingGroupId, findGroupDropTarget } from "@/lib/canvas/canvas-node-geometry";

const orderedGroup = (): CanvasNodeData => ({
    id: "ordered",
    type: CanvasNodeType.Group,
    title: "有序组",
    position: { x: 0, y: 0 },
    width: 760,
    height: 480,
    metadata: { orderedGroup: true, groupSlots: [] },
});

const nodeInsideGroup = (): CanvasNodeData => ({
    id: "mcp-node",
    type: CanvasNodeType.Text,
    title: "MCP 节点",
    position: { x: 120, y: 100 },
    width: 200,
    height: 120,
    metadata: {},
});

test("有序组不因几何落入而接管 MCP 节点", () => {
    const group = orderedGroup();
    const node = nodeInsideGroup();
    assert.equal(findContainingGroupId(node, [group, node]), undefined);
    assert.equal(findGroupDropTarget(new Set([node.id]), [group, node]), null);
});
