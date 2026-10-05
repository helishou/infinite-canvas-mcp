import assert from "node:assert/strict";
import test from "node:test";

import { productionWorkspaceRequest } from "./production-workspace-contract.js";

test("scene production workspace routes retain the scene owner namespace", () => {
    assert.deepEqual(productionWorkspaceRequest("production_get_scene_production", { sceneId: "SC/01" }), {
        method: "GET", path: "/drama/scenes/SC%2F01/production",
    });
    assert.deepEqual(productionWorkspaceRequest("production_edit_scene_production", {
        sceneId: "SC01", operationId: "edit-1", expectedRevision: 2, ops: [{ type: "set_director_brief", brief: "Only this scene" }],
    }), {
        method: "POST", path: "/drama/scenes/SC01/production/ops",
        body: { operationId: "edit-1", expectedRevision: 2, ops: [{ type: "set_director_brief", brief: "Only this scene" }] },
    });
    assert.deepEqual(productionWorkspaceRequest("production_publish_scene_production", {
        sceneId: "SC01", operationId: "publish-1", expectedRevision: 3, stage: "director",
    }), {
        method: "POST", path: "/drama/scenes/SC01/production/publish",
        body: { operationId: "publish-1", expectedRevision: 3, stage: "director" },
    });
});

test("scene readiness and version tools map to the bound scene production record", () => {
    assert.deepEqual(productionWorkspaceRequest("production_get_scene_readiness", { sceneId: "SC01", source: "published" }), {
        method: "GET", path: "/drama/scenes/SC01/production/readiness?source=published",
    });
    assert.deepEqual(productionWorkspaceRequest("production_list_scene_versions", { sceneId: "SC01" }), {
        method: "GET", path: "/drama/scenes/SC01/production/versions",
    });
    assert.deepEqual(productionWorkspaceRequest("production_get_scene_version", { sceneId: "SC01", version: 2 }), {
        method: "GET", path: "/drama/scenes/SC01/production/versions/2",
    });
    assert.deepEqual(productionWorkspaceRequest("production_restore_scene_production", {
        sceneId: "SC01", version: 2, operationId: "restore-1", expectedRevision: 4,
    }), {
        method: "POST", path: "/drama/scenes/SC01/production/restore",
        body: { version: 2, operationId: "restore-1", expectedRevision: 4 },
    });
});
