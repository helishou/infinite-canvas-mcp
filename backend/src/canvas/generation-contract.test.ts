import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function source(relativePath: string) {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("前端、Agent 和 Backend 的生成调用方共用唯一 HTTP 入口", () => {
    const api = source("canvas-agent/src/canvas/generation-api.ts");
    assert.match(api, /CANVAS_GENERATION_PATH = "\/canvas\/generation"/);
    assert.match(api, /CANVAS_TASKS_PATH = "\/tasks"/);
    const callers = [
        "web/src/services/backend-api.ts",
        "canvas-agent/src/runtime/backend-client.ts",
        "backend/src/server/canvas-generation-routes.ts",
    ];
    for (const file of callers) {
        const text = source(file);
        assert.match(text, /CANVAS_GENERATION_PATH/);
        assert.doesNotMatch(text, /\/canvas\/(?:h3\/runs|image-generation)/);
    }
    assert.match(source("backend/src/mcp.ts"), /backendApi\.canvasRunGeneration/);
    assert.match(source("canvas-agent/src/plugins/minimax-h3/mcp.ts"), /context\.backend\.canvasRunGeneration/);
});

test("H3 片段更新按稳定 segmentId 定位，禁止 MCP 依赖数组下标", () => {
    const agentMcp = source("canvas-agent/src/plugins/minimax-h3/mcp.ts");
    assert.match(agentMcp, /segmentId: \{ type: "string"/);
    assert.match(agentMcp, /required: \["projectId", "nodeId", "segmentId", "patch"\]/);
    assert.match(agentMcp, /findIndex\(\(segment\) => String\(segment\.id \|\| ""\) === segmentId\)/);
});

test("取消与重试由所有客户端共用 Backend 任务端点", () => {
    const web = source("web/src/services/backend-api.ts");
    const agent = source("canvas-agent/src/runtime/backend-client.ts");
    const pluginHost = source("web/src/pages/canvas/hooks/use-plugin-host.tsx");
    assert.match(web, /canvasTaskActionPath/);
    assert.match(agent, /canvasTaskActionPath/);
    assert.match(pluginHost, /canvasTaskActionPath/);
    assert.doesNotMatch(web, /`\/tasks\/\$\{encodeURIComponent\(id\)\}/);
    assert.doesNotMatch(agent, /`\/tasks\/\$\{encodeURIComponent\(id\)\}/);
    assert.doesNotMatch(pluginHost, /`\$\{getBackendUrl\(\)\}\/tasks\//);
});

test("浏览器自定义脚本也先创建 Backend 权威任务", () => {
    const service = source("backend/src/canvas/generation-service.ts");
    const page = source("web/src/pages/canvas/project.tsx");
    const worker = source("web/src/services/api/canvas-browser-task.ts");
    assert.match(service, /resolveModelScript[\s\S]*browserScript\.start/);
    assert.match(service, /requiresBrowserProvider[\s\S]*browser-provider/);
    assert.match(page, /maskEditImageNode[\s\S]*runCanvasImageTask/);
    assert.match(page, /generateAngleNode[\s\S]*runCanvasImageTask/);
    assert.match(page, /writeBackToSelf[\s\S]*writeBackToTarget: true/);
    assert.doesNotMatch(page, /requestEdit|requestGeneration|requestImageQuestion|requestVideoGeneration|requestAudioGeneration/);
    assert.match(worker, /claimBackendBrowserTask[\s\S]*completeBackendBrowserTask/);
    assert.match(worker, /uploadMediaFile[\s\S]*mediaHandle/);
    assert.doesNotMatch(source("backend/src/canvas/browser-script-dispatcher.ts"), /new Function|node:vm/);
});

test("媒体结果占位节点只由 Backend 创建，网页不再复制一套布局逻辑", () => {
    const target = source("backend/src/canvas/generation-target.ts");
    const page = source("web/src/pages/canvas/project.tsx");
    for (const dispatcher of ["image-dispatcher.ts", "video-dispatcher.ts", "audio-dispatcher.ts", "browser-script-dispatcher.ts"]) {
        assert.match(source(`backend/src/canvas/${dispatcher}`), /prepareCanvasGenerationTarget/);
    }
    assert.match(target, /Media result-node creation belongs to Backend/);
    assert.doesNotMatch(page, /const (?:rootNode|videoNode|audioNode): CanvasNodeData/);
    assert.match(page, /网页不再自行创建占位节点/);
});
