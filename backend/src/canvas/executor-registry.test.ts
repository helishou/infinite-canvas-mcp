import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanvasExecutor } from "./executor-registry.js";

test("文本模型统一路由到 Backend direct-text 执行器", () => {
    assert.equal(resolveCanvasExecutor({ mode: "text", model: "gpt-5-5" }), "direct-text");
});
