import assert from "node:assert/strict";
import test from "node:test";
import { generationTaskCounts, parseToolResult, toolResultFailure } from "./tool-result.js";
import { threadMessages } from "./codex-history.js";

const result = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const history = (item: object) => threadMessages({ id: "thread", turns: [{ id: "turn", status: "completed", items: [{ id: "query", type: "mcpToolCall", tool: "generation_get_status", status: "completed", ...item }] }] }).find(item => item.itemId === "query")!;

test("real task-only response counts states in both parsing and history", () => {
    const raw = result({ tasks: ["queued", "running", "succeeded", "failed", "cancelled"].map(status => ({ status })) });
    assert.deepEqual(generationTaskCounts(parseToolResult(raw)), { total: 5, queued: 1, running: 1, succeeded: 1, failed: 1 });
    assert.equal(history({ result: raw }).text, "共 5 个任务，排队 1，运行中 1，成功 1，失败 1");
    assert.equal(history({ result: raw }).detail?.status, "completed", "failed media tasks do not mean a failed query");
    assert.equal(history({ result: result({ tasks: [] }) }).text, "共 0 个任务，排队 0，运行中 0，成功 0，失败 0");
    assert.equal(generationTaskCounts({}), null);
    assert.equal(history({ result: {} }).text, "未取得任务列表，无法统计生成状态");
});

test("structured error result is failed even if the transport completed", () => {
    const raw = { ...result({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: "fetch failed" } }), isError: true };
    const message = history({ result: raw });
    assert.equal(message.detail?.status, "failed");
    assert.match(message.text, /fetch failed/);
    assert.match(message.text, /新回合/);
    assert.doesNotMatch(message.text, /共 0 个任务/);
    assert.equal(message.detail?.output, message.text);
    assert.equal(toolResultFailure({ result: result({ ok: false, error: "参数错误" }) }).message, "参数错误");
});

test("transport failure and failure without a message never become zero-task summaries", () => {
    for (const item of [{ status: "failed" }, { error: { message: "Transport closed" } }, { result: { isError: true, content: [{ type: "text", text: "HTTP 502" }] } }]) {
        const message = history(item);
        assert.equal(message.detail?.status, "failed");
        assert.ok(message.text);
        assert.doesNotMatch(message.text, /共 0 个任务/);
    }
});

test("structured content is preferred and returned-list counts ignore unrelated totals", () => {
    const raw = { ...result({ tasks: [] }), structuredContent: { total: 100, summary: { running: 100 }, tasks: [{ status: "running" }] } };
    assert.equal(generationTaskCounts(parseToolResult(raw))?.total, 1);
    assert.equal(generationTaskCounts(parseToolResult(raw))?.running, 1);
});

test("history preserves business compilation state separately from successful tool transport", () => {
    for (const status of ["queued", "running", "blocked", "failed", "interrupted", "succeeded"]) {
        const messages = threadMessages({ id: "thread", turns: [{ id: "turn", status: "completed", items: [{ id: "compile", type: "mcpToolCall", tool: "production_get_compilation", status: "completed", arguments: { view: "diagnostics" }, result: result({ compilation: { status, operationId: "new", expectedRevision: 5, reused: true, reusedFromOperationId: "original", blockingDiagnostic: { code: "PROMPT_EXTERNAL_CONTEXT", targetId: "SEG1", shotId: "SH1", path: "director.source.shots.SH1.visual", matchedText: "preceding segment" } } }) }] }] });
        const message = messages[0];
        assert.equal(message.title, "读取编译诊断");
        assert.equal(message.detail?.status, "completed");
        assert.equal((message.detail as Record<string, unknown>).compilationStatus, status);
        assert.match(message.text, /复用原阻塞/);
        assert.match(message.text, /SH1.visual/);
        assert.ok(JSON.stringify(message.detail).includes("original"));
    }
});
