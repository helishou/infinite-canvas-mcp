import assert from "node:assert/strict";
import test from "node:test";

import { registerCanvasModel, resolveCanvasExecutor } from "./executor-registry.js";

test("文本模型统一路由到 Backend direct-text 执行器", () => {
    assert.equal(resolveCanvasExecutor({ mode: "text", model: "gpt-5-5" }), "direct-text");
});

test("特定文本执行器优先于通用 fallback", () => {
    registerCanvasModel({
        id: "special-text",
        modes: ["text"],
        inputRoles: ["prompt"],
        executor: "plugin",
        matches: (model) => model === "special-text",
    });
    assert.equal(resolveCanvasExecutor({ mode: "text", model: "special-text" }), "plugin");
});
