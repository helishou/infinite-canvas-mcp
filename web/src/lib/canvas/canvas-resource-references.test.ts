import assert from "node:assert/strict";
import test from "node:test";
import { buildCanvasGraphIndex, createMentionReferenceSelector } from "./canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("无关节点更新和裁剪变化保留引用数组，关联资源变化才失效", () => {
    const a: CanvasNodeData = { id: "a", type: CanvasNodeType.Text, title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "a" } };
    const b = { ...a, id: "b", title: "B" };
    const select = createMentionReferenceSelector();
    let nodes = [a, b];
    const first = select(nodes, nodes, [], buildCanvasGraphIndex(nodes, []));
    nodes = [a, { ...b, metadata: { content: "edited" } }];
    const second = select(nodes, nodes, [], buildCanvasGraphIndex(nodes, []));
    assert.equal(first.get("a"), second.get("a"));
    assert.notEqual(first.get("b"), second.get("b"));
    assert.equal(select([a], nodes, [], buildCanvasGraphIndex(nodes, [])).get("a"), first.get("a"));
});
