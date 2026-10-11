import test from "node:test";
import assert from "node:assert/strict";
import { productionImageParams } from "./production-runner.js";

test("production keeps workflow ratio overrides and snapshots them independently of later node edits", () => {
    const node = { metadata: { size: "16:9", quality: "high", count: 1,
        comfyParams: { f_1790686390394_nzk9: "16:9 (Widescreen)", megapixels: 1.5, nested: { value: 3 }, writeBackToTarget: false } } };
    const params = productionImageParams(node);
    assert.equal(params.f_1790686390394_nzk9, "16:9 (Widescreen)");
    assert.equal(params.size, "16:9");
    assert.equal(params.quality, "high");
    assert.equal(params.count, 1);
    assert.equal(params.writeBackToTarget, true);
    node.metadata.comfyParams.f_1790686390394_nzk9 = "9:16 (Portrait Widescreen)";
    node.metadata.comfyParams.nested.value = 9;
    assert.equal(params.f_1790686390394_nzk9, "16:9 (Widescreen)");
    assert.deepEqual(params.nested, { value: 3 });
});

test("production without node overrides keeps workflow defaults", () => {
    assert.deepEqual(productionImageParams(undefined), { writeBackToTarget: true });
});
