import assert from "node:assert/strict";
import test from "node:test";
import { productionPresentationPath } from "./production-navigation";

test("canvas production presentations open the Production workspace at the exact target", () => {
    const path = productionPresentationPath({
        key: "work:shot:shot-1",
        workId: "work-1",
        owner: { kind: "episode", id: "episode-1" },
        canvasId: "canvas-1",
        workspace: "shots",
        action: "produce",
        targetKind: "shot",
        targetId: "shot-1",
        nodeId: "node-1",
        status: "ready",
    });
    const url = new URL(path, "http://localhost");

    assert.equal(url.pathname, "/canvas/canvas-1");
    assert.equal(url.searchParams.get("edit"), "1");
    assert.equal(url.searchParams.get("productionKind"), "episode");
    assert.equal(url.searchParams.get("productionId"), "episode-1");
    assert.equal(url.searchParams.get("workspace"), "shots");
    assert.equal(url.searchParams.get("target"), "shot:shot-1");
    assert.equal(url.searchParams.get("nodeId"), "node-1");
    assert.equal(url.searchParams.get("workId"), "work-1");
});

test("standalone production routes remain on their existing page", () => {
    const path = productionPresentationPath({
        key: "work:shot:shot-1",
        workId: "work-1",
        owner: { kind: "episode", id: "episode-1" },
        workspace: "shots",
        action: "produce",
        targetKind: "shot",
        targetId: "shot-1",
        status: "ready",
    });

    assert.match(path, /^\/drama\/episodes\/episode-1\/production\?/);
    assert.doesNotMatch(path, /edit=1/);
});
