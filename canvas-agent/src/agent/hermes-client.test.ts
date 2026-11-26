import assert from "node:assert/strict";
import test from "node:test";
import { toolFailureReason } from "./hermes-client.js";

const acpFailedFrame = (text: string) => ({
    status: "failed",
    content: [{ type: "content", content: { type: "text", text } }],
});

test("ACP 嵌套 content 块的失败原因能读出来", () => {
    const reason = "mcp__infinite_canvas__drama_stage_status failed: MCP server 'infinite-canvas' is not connected";
    assert.equal(toolFailureReason(acpFailedFrame(reason)), reason);
});

test("剧目未选定的业务错误原样显示，不再退回通用文案", () => {
    const reason = "mcp__editor_infinite_canvas_a0db7f05__drama_stage_status failed: PROJECT_SELECTION_REQUIRED 当前网页活动画布没有所属剧目";
    assert.equal(toolFailureReason(acpFailedFrame(reason)), reason);
});

test("确实没有原因时才用兜底文案", () => {
    assert.match(toolFailureReason({ status: "failed" }), /没有返回失败原因/);
});
