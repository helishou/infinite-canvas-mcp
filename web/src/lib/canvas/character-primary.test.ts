import assert from "node:assert/strict";
import test from "node:test";

import { retainCharacterPrimaryIndex } from "./character-primary";

test("角色节点与资产的主图索引互不覆盖，图片重排后仍选原图", () => {
    const images = [{ url: "one", storageKey: "image:one" }, { url: "two", storageKey: "image:two" }];
    assert.equal(retainCharacterPrimaryIndex(images, 0, images), 0);
    assert.equal(retainCharacterPrimaryIndex(images, 1, images), 1);
    assert.equal(retainCharacterPrimaryIndex(images, 0, [...images].reverse()), 1);
    assert.equal(retainCharacterPrimaryIndex(images, 1, [...images].reverse()), 0);
    assert.equal(retainCharacterPrimaryIndex(images, 1, [images[0]]), 0);
});
