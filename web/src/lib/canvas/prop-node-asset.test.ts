import assert from "node:assert/strict";
import test from "node:test";
import { propNodeAssetImage } from "./prop-node-asset";

test("only prop nodes with a saved propImage can be stored as image assets", () => {
    const image = { storageKey: "lantern-image", url: "/media/lantern-image.png" };
    assert.equal(propNodeAssetImage({ id: "prop", type: "prop", metadata: { propImage: image } } as any), image);
    assert.equal(propNodeAssetImage({ id: "prop-empty", type: "prop", metadata: {} } as any), undefined);
    assert.equal(propNodeAssetImage({ id: "image", type: "image", metadata: { propImage: image } } as any), undefined);
});
