import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { executeCollaborationTool } from "./collaboration-tools.js";
import { toolDescriptions, toolInputSchemas, toolNames } from "./schemas.js";
import { collaborationToolNames } from "./collaboration-contract.js";

test("候选工具统一使用命令协议，采用时缺少原文不得请求后台", async () => {
    const requests: unknown[] = [];
    const api = { get: async (path: string) => { requests.push(path); }, post: async (path: string, body: unknown) => { requests.push([path, body]); } };
    const source = { clientId: "mcp", kind: "mcp", label: "MCP" };
    const suggestion = { id: "s", target: { field: "globalPrompt" }, documentId: "doc", base: "原文", text: "候选" };
    await executeCollaborationTool(api, "canvas_save_text_suggestion", { projectId: "c", operationId: "save", suggestion }, source);
    assert.deepEqual(requests[0], ["/canvas/projects/c/ops?response=delta", { operationId: "save", source, operations: [{ type: "save_text_suggestion", suggestion }] }]);
    await executeCollaborationTool(api, "canvas_list_text_suggestions", { projectId: "c", target: { nodeId: "n", segmentId: "clip", field: "prompt" } }, source);
    assert.match(String(requests[1]), /text-suggestions\?nodeId=n&segmentId=clip&field=prompt/);
    await assert.rejects(executeCollaborationTool(api, "canvas_resolve_text_suggestion", { projectId: "c", operationId: "adopt", id: "s", action: "apply" }, source), /expectedText/);
    assert.equal(requests.length, 2);
});

test("协作工具全部进入 Agent/MCP 公共目录与 schema", () => {
    for (const name of collaborationToolNames) {
        assert.ok(toolNames.includes(name));
        assert.ok(toolDescriptions[name]);
        assert.ok(toolInputSchemas[name]);
    }
});

test("同一文本操作经不同来源执行构造相同增量，保留稳定回执 ID", async () => {
    const seed = new Y.Doc();
    seed.getText("text").insert(0, "甲乙");
    const command = { projectId: "canvas", operationId: "request-1", documentId: "doc-1", target: { field: "globalPrompt" }, baseState: Buffer.from(Y.encodeStateAsUpdate(seed)).toString("base64"), edits: [{ index: 1, deleteCount: 0, insert: "中文😀" }] };
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const api = { get: async () => null, post: async (path: string, body: unknown) => { requests.push({ path, body: body as Record<string, unknown> }); } };
    for (const kind of ["mcp", "agent"]) await executeCollaborationTool(api, "canvas_edit_text", command, { kind, clientId: kind, label: kind });
    assert.equal(requests[0].path, "/canvas/projects/canvas/ops?response=delta");
    assert.equal(requests[0].body.operationId, command.operationId);
    assert.deepEqual(requests[0].body.operations, requests[1].body.operations);
    const operation = (requests[0].body.operations as Array<{ update: string; documentId: string }>)[0];
    assert.equal(operation.documentId, "doc-1");
    Y.applyUpdate(seed, Buffer.from(operation.update, "base64"));
    assert.equal(seed.getText("text").toString(), "甲中文😀乙");
    seed.destroy();
});

test("条件替换直达事务入口；读取批量文本项保留 textItemId", async () => {
    const requests: unknown[] = [];
    const api = { get: async (path: string) => { requests.push(path); }, post: async (path: string, body: unknown) => { requests.push([path, body]); } };
    const source = { clientId: "agent", kind: "agent", label: "Agent" };
    await executeCollaborationTool(api, "canvas_read_text", { projectId: "c", target: { nodeId: "n", textItemId: "t", field: "content" } }, source);
    assert.match(String(requests[0]), /textItemId=t/);
    await executeCollaborationTool(api, "canvas_replace_text", { projectId: "c", operationId: "id", documentId: "doc", target: { field: "globalPrompt" }, expectedText: "旧", text: "新" }, source);
    assert.deepEqual(requests[1], ["/canvas/projects/c/ops?response=delta", { operationId: "id", source, operations: [{ type: "text_replace", documentId: "doc", target: { field: "globalPrompt" }, expectedText: "旧", text: "新" }] }]);
});
