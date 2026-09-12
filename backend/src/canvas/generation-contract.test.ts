import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function source(relativePath: string) {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("前端、Agent 和 Backend 的生成调用方共用唯一 HTTP 入口", () => {
    const callers = [
        "web/src/services/backend-api.ts",
        "canvas-agent/src/runtime/backend-client.ts",
        "backend/src/server/canvas-generation-routes.ts",
    ];
    for (const file of callers) {
        const text = source(file);
        assert.match(text, /\/canvas\/generation/);
        assert.doesNotMatch(text, /\/canvas\/(?:h3\/runs|image-generation)/);
    }
    assert.match(source("backend/src/mcp.ts"), /backendApi\.canvasRunGeneration/);
    assert.match(source("canvas-agent/src/plugins/minimax-h3/mcp.ts"), /context\.backend\.canvasRunGeneration/);
});

test("取消与重试由所有客户端共用 Backend 任务端点", () => {
    const web = source("web/src/services/backend-api.ts");
    const agent = source("canvas-agent/src/runtime/backend-client.ts");
    for (const action of ["cancel", "retry"]) {
        assert.match(web, new RegExp(`/tasks/\\$\\{encodeURIComponent\\(id\\)\\}/${action}`));
        assert.match(agent, new RegExp(`/tasks/\\$\\{encodeURIComponent\\(id\\)\\}/${action}`));
    }
});
