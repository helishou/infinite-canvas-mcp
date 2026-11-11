import assert from "node:assert/strict";
import test from "node:test";
import type { EpisodeProductionData, ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { productionSceneCreationOperations } from "./production-scene-nodes.js";

const owner = { kind: "episode" as const, id: "ep" };
const production = (scenes: string[] = [], groups: Array<{ nodeId: string }> = []) => ({
    director: { source: { script_scenes: scenes.map(id => ({ id, scene_id: `environment-${id}`, beat_ids: [] })), shots: [] } },
    clipGroups: groups,
} as unknown as EpisodeProductionData);
const layout = { units: [] } as unknown as ProductionLayoutPlan;
const orphan = (metadata: Record<string, unknown> = {}) => ({
    id: "old-h3", type: "minimax-h3:video", title: "Old inherited Clips", position: { x: 20, y: 40 }, width: 1960, height: 1080,
    metadata: { productionSceneId: "removed", productionOwnerKind: owner.kind, productionOwnerId: owner.id,
        productionLayoutUnitId: "video:old-h3", productionLayoutBounds: { width: 1960, height: 1080 },
        segments: [], content: "old.mp4", storageKey: "video:old", status: "cancelled", ...metadata },
});

test("orphan reconciliation releases stale ownership, retains media and permits ordinary deletion", t => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "canvas", nodes: [orphan()], connections: [] });
    const before = db.getCanvasProject("canvas")!;
    const operations = productionSceneCreationOperations(before, production(), layout, owner, [], {});
    assert.equal(operations.length, 1);
    const { project } = db.applyCanvasProjectOperations("canvas", undefined, operations, { runtimeWrite: true, operationId: "reconcile" });
    const node = project.nodes[0] as Record<string, any>;
    assert.equal(node.metadata.productionSceneId, undefined);
    assert.equal(node.metadata.content, "old.mp4");
    assert.equal(node.metadata.storageKey, "video:old");
    assert.equal(node.width, 1960);
    assert.deepEqual(node.position, { x: 20, y: 40 });
    assert.deepEqual(productionSceneCreationOperations(project, production(), layout, owner, [], {}), []);
    const result = db.applyCanvasProjectOperations("canvas", undefined, [{ type: "delete_node", id: node.id }]);
    assert.equal(result.project.nodes.length, 0);
});

test("reconciliation preserves live, claimed, published, running and archived scene nodes", () => {
    for (const metadata of [
        { productionSceneId: "live" }, { productionSceneId: "environment-live" },
        { productionOwnerId: "other" }, { productionOwnerKind: "canvas" },
        { segments: [{ id: "clip" }] }, { segments: undefined },
        { runtimeTaskId: "task" }, { status: "loading" }, { status: "queued" },
        { status: "awaiting_confirmation" }, { status: "generating" }, { productionArchiveLabel: "archive" },
    ]) {
        assert.deepEqual(productionSceneCreationOperations({ nodes: [orphan(metadata)] }, production(["live"]), layout, owner, [], {}), [], JSON.stringify(metadata));
    }
    assert.deepEqual(productionSceneCreationOperations({ nodes: [orphan()] }, production([], [{ nodeId: "old-h3" }]), layout, owner, [], {}), []);
    assert.deepEqual(productionSceneCreationOperations({ nodes: [orphan()] }, production(), layout, owner, [], {}, production(["removed"])), []);
    assert.deepEqual(productionSceneCreationOperations({ nodes: [orphan()] }, production(), layout, owner, [], {}, production([], [{ nodeId: "old-h3" }])), []);
    const incomplete = { clipGroups: [] } as unknown as EpisodeProductionData;
    assert.deepEqual(productionSceneCreationOperations({ nodes: [orphan()] }, incomplete, layout, owner, [], {}), []);
});

test("a node being reassigned to a current layout scene is not detached", () => {
    const currentLayout = { units: [{ sceneId: "live", members: [{ role: "video", nodeId: "old-h3" }] }] } as unknown as ProductionLayoutPlan;
    assert.deepEqual(productionSceneCreationOperations({ nodes: [orphan()] }, production(["live"]), currentLayout, owner, [], {}), []);
});
