import assert from "node:assert/strict";
import test from "node:test";
import { productionAssetPosition, productionNodePosition, productionSceneLayout } from "./production-layout-geometry.js";
import { existingProductionSceneH3NodeId } from "./production-layout.js";

test("new assets stay in their planned grid regardless of unrelated script count", () => {
    const scripts = Array.from({ length: 30 }, (_, i) => ({ id: `script-${i}`, position: { x: -640, y: 350 + i * 360 }, width: 560, height: 320 }));
    assert.deepEqual(productionAssetPosition(scripts, ["A", "B", "C", "D"], "B"), { x: 720, y: 0 });
    assert.deepEqual(productionAssetPosition(scripts, ["A", "B", "C", "D"], "D"), { x: 0, y: 840 });
});

test("new placement avoids resized nodes without changing existing positions", () => {
    const nodes = [{ id: "manual", position: { x: 0, y: 0 }, width: 900, height: 1200 }];
    const before = structuredClone(nodes);
    const placed = productionNodePosition(nodes, { x: 0, y: 0 }, 340, 520);
    assert.ok(placed.x >= 960 || placed.y >= 1260);
    assert.deepEqual(nodes, before);
});

test("scene rows fit large images and keep each prompt below its own image", () => {
    const members = Array.from({ length: 4 }, (_, i) => [
        { id: `prompt-${i}`, type: "config", width: 520, height: 300, metadata: { productionShotId: `s${i}` } },
        { id: `image-${i}`, type: "image", width: 440, height: i === 0 ? 900 : 600, metadata: { productionShotId: `s${i}` } },
    ]).flat();
    const origin = { x: 100, y: 200 }, layout = productionSceneLayout(members, ["s0", "s1", "s2", "s3"], origin);
    const positions = new Map(layout.positions.map(item => [item.id, item.position]));
    assert.equal(positions.get("prompt-0")!.x, positions.get("image-0")!.x);
    assert.ok(positions.get("prompt-0")!.y >= positions.get("image-0")!.y + 900 + 60);
    assert.ok(positions.get("image-3")!.y > positions.get("prompt-0")!.y + 300);
    for (const node of members) {
        const p = positions.get(node.id)!;
        assert.ok(p.x + node.width <= origin.x + layout.width);
        assert.ok(p.y + node.height <= origin.y + layout.height);
    }
});

test("a script-scene id migration reuses the existing environment-bound H3 node", () => {
    const production = {
        director: { source: {
            script_scenes: [{ id: "SC01", scene_id: "S01", scene_name: "草地围车", text: "" }],
            scene_registry: [{ id: "S01", name: "草地围车" }],
            shots: [{ id: "SH-01", scene_id: "S01" }, { id: "SH-02", scene_id: "S01" }],
        } },
        clipGroups: [
            { id: "legacy-1", shotIds: ["SH-01"], nodeId: "legacy-scene-node" },
            { id: "legacy-2", shotIds: ["SH-02"], nodeId: "legacy-scene-node" },
            { id: "already-v2", shotIds: ["SH-02"], nodeId: "new-occurrence-node" },
        ],
    } as any;
    const project = { nodes: [
        { id: "legacy-scene-node", type: "minimax-h3:video", metadata: { productionOwnerKind: "episode", productionOwnerId: "ep", productionSceneId: "S01" } },
        { id: "new-occurrence-node", type: "minimax-h3:video", metadata: { productionOwnerKind: "episode", productionOwnerId: "ep", productionSceneId: "SC01" } },
    ] };
    assert.equal(existingProductionSceneH3NodeId(project, production, { kind: "episode", id: "ep" }, "SC01"), "legacy-scene-node");
});

test("scene-node reuse never selects a node explicitly archived for historical results", () => {
    const production = {
        director: { source: {
            script_scenes: [{ id: "SC01", scene_id: "S01", scene_name: "草地围车", text: "" }],
            scene_registry: [{ id: "S01", name: "草地围车" }],
            shots: [{ id: "SH-01", scene_id: "S01" }],
        } },
        clipGroups: [{ id: "legacy-1", shotIds: ["SH-01"], nodeId: "archive-node" }],
    } as any;
    const project = { nodes: [
        { id: "archive-node", type: "minimax-h3:video", metadata: { productionOwnerKind: "episode", productionOwnerId: "ep", productionSceneId: "S01", productionArchiveLabel: "原视频归档" } },
        { id: "active-node", type: "minimax-h3:video", metadata: { productionOwnerKind: "episode", productionOwnerId: "ep", productionSceneId: "SC01" } },
    ] };
    assert.equal(existingProductionSceneH3NodeId(project, production, { kind: "episode", id: "ep" }, "SC01"), "active-node");
});
