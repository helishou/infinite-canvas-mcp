import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasNodeData, CanvasConnection } from "@/types/canvas";
import { createCanvasGraphIndexSelector } from "@/lib/canvas/canvas-graph-index";
import { createPluginGraphAccess } from "./plugin-graph-access";

const node = (id: string): CanvasNodeData => ({ id, title: id, type: "text", position: { x: 0, y: 0 }, width: 100, height: 100 });
test("plugins keep raw connection order, repeated sources and one self-loop; returned lists cannot mutate the index", () => {
    const a = node("a"), b = node("b"), c = node("c");
    const snapshot = { nodes: [a, b, c], connections: [
        { id: "bc", fromNodeId: "b", toNodeId: "c", order: 10 },
        { id: "ac", fromNodeId: "a", toNodeId: "c", order: 0 },
        { id: "ac2", fromNodeId: "a", toNodeId: "c", order: 1 },
        { id: "cc", fromNodeId: "c", toNodeId: "c" },
        { id: "missing", fromNodeId: "missing", toNodeId: "c" },
    ] };
    const select = createCanvasGraphIndexSelector();
    const access = createPluginGraphAccess(() => snapshot, () => snapshot, select);
    assert.deepEqual(access.getUpstream("c").map((n) => n.id), ["b", "a", "a", "c"]);
    const returned = access.getDownstream("a"); returned.length = 0;
    assert.deepEqual(access.getDownstream("a"), [c, c]);
    assert.equal(select(snapshot.nodes, snapshot.connections).incomingByNodeId.get("c")![0], a, "canvas reference sorting stays independent of plugin connection order");
});
test("plugin calls see immediate local changes before render and separate authoritative getNode snapshots", () => {
    const a = node("a"), b = node("b");
    const saved = { nodes: [a, b], connections: [] as CanvasConnection[] };
    let live = saved;
    let project: typeof saved | undefined = saved;
    const access = createPluginGraphAccess(() => project, () => live, createCanvasGraphIndexSelector());
    assert.deepEqual(access.getUpstream("b"), []);
    const edited = { ...a, title: "local" };
    live = { nodes: [edited, b], connections: [{ id: "ab", fromNodeId: "a", toNodeId: "b" }] };
    assert.equal(access.getUpstream("b")[0], edited);
    assert.equal(access.getNode("a"), a);
    assert.equal(access.getUpstream("b")[0], edited);
    project = live;
    assert.equal(access.getNode("a"), edited);
    live = { nodes: [b], connections: [] };
    assert.deepEqual(access.getUpstream("b"), []);
    project = undefined;
    assert.equal(access.getNode("a"), null);
});
