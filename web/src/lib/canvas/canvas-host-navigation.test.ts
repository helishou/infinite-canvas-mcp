import assert from "node:assert/strict";
import test from "node:test";
import { canvasHostLocation } from "./canvas-host-navigation";

test("object destinations preserve shared canvas identity and separate query parameters", () => {
    const result = canvasHostLocation({ pathname: "/canvas/shared%20assets", search: "?nodeId=picture-1&segmentId=clip-2" }, "episode");
    assert.equal(result?.projectId, "shared assets");
    assert.equal(result?.search.get("nodeId"), "picture-1");
    assert.equal(result?.search.get("segmentId"), "clip-2");
});
test("query-only navigation stays in the current canvas and does not inherit workbench parameters", () => {
    for (const to of ["?workspace=assets&target=asset%3Aa", { search: "workspace=assets&target=asset%3Aa" }]) {
        const result = canvasHostLocation(to, "shared/assets");
        assert.equal(result?.projectId, "shared/assets");
        assert.equal(result?.search.get("target"), "asset:a");
        assert.equal(result?.search.has("episodeId"), false);
    }
});
test("standalone navigation is not captured as a canvas destination", () => {
    for (const to of ["/production?episodeId=next", "/canvas", "https://example.com/canvas/other"]) assert.equal(canvasHostLocation(to, "episode"), null);
});
