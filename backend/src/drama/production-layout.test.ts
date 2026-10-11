import assert from "node:assert/strict";
import test from "node:test";
import { productionAssetPosition, productionNodePosition, productionSceneLayout } from "./production-layout-geometry.js";

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
