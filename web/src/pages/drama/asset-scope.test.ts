import assert from "node:assert/strict";
import test from "node:test";

import { assetCanvasScope } from "./asset-scope";

test("角色/场景/道具底稿落共享资产画布，集画布只有引用", () => {
    // 剧目下的分集：有共享资产画布 → 一律 shared
    assert.equal(assetCanvasScope({ role: "episode", sharedAssetCanvasId: "production-shared-assets-x" }), "shared");
    // 正在编辑共享画布本身
    assert.equal(assetCanvasScope({ role: "shared-assets" }), "shared");
    // 没有共享画布的独立画布 / 单集 → 只能落本集
    assert.equal(assetCanvasScope({ role: "episode", sharedAssetCanvasId: null }), "episode");
    assert.equal(assetCanvasScope({ role: "scene" }), "episode");
    assert.equal(assetCanvasScope({ role: "ordinary", sharedAssetCanvasId: "" }), "episode");
    assert.equal(assetCanvasScope(null), "episode");
});
