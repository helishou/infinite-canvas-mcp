import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";

test("各 Clip 的视觉来源描述经 ops 独立持久化，重放不覆盖另一段或运行状态", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "a", status: "awaiting_confirmation", runtimeTaskId: "parent-a", subjectDefinitions: [{ id: "hero", name: "Hero", pictures: ["<Picture 1>"], pictureDescriptions: { shared: "CLIP_A" } }] },
        { id: "b", status: "success", subjectDefinitions: [{ id: "hero", name: "Hero", pictures: ["<Picture 1>"], pictureDescriptions: { shared: "CLIP_B" } }] },
    ] } }], connections: [] });
    const stores = createStores(db);
    const operation = { type: "update_h3_segment" as const, nodeId: "n", segmentId: "b", patch: { subjectDefinitions: [{ id: "hero", name: "Hero", pictures: ["<Picture 1>"], pictureDescriptions: { shared: "EDITED_B" } }] } };
    const context = { operationId: "source-description-edit", source: { clientId: "test", kind: "user" as const } };
    const applied = stores.projects.applyOperations("p", 0, [operation], context);
    const replay = stores.projects.applyOperations("p", 0, [operation], context);
    assert.equal(replay.duplicated, true);
    assert.equal(replay.revision, applied.revision);
    const segments = (stores.projects.get("p")!.nodes as any[])[0].metadata.segments;
    assert.equal(segments[0].subjectDefinitions[0].pictureDescriptions.shared, "CLIP_A");
    assert.equal(segments[0].runtimeTaskId, "parent-a");
    assert.equal(segments[0].status, "awaiting_confirmation");
    assert.equal(segments[1].subjectDefinitions[0].pictureDescriptions.shared, "EDITED_B");
});
