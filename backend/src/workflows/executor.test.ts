import assert from "node:assert/strict";
import test from "node:test";

import { redactInlineMedia } from "../runtime/redact-inline-media.js";

test("工作流持久化数据会移除嵌套 data URL，但保留普通句柄和文本", () => {
    const value = redactInlineMedia({
        prompt: "test",
        image: "data:image/png;base64,AAAA",
        nested: [{ image: "data:image/jpeg;base64,BBBB" }, { storageKey: "image:ref-1" }],
    });

    assert.deepEqual(value, {
        prompt: "test",
        image: "[inline-media:image/png]",
        nested: [{ image: "[inline-media:image/jpeg]" }, { storageKey: "image:ref-1" }],
    });
    assert.doesNotMatch(JSON.stringify(value), /base64|AAAA|BBBB/);
});
