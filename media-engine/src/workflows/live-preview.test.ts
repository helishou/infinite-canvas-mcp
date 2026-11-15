import assert from "node:assert/strict";
import test from "node:test";

import {
    clearWorkflowLivePreview, decodeKjPreviewMessage, previewImageRefFromOutput,
    publishWorkflowLivePreview, readWorkflowLivePreview,
} from "./live-preview.js";

test("kj_preview_override 只在声明了唯一桥节点且已提交 prompt 时收", () => {
    const message = {
        type: "kj_preview_override",
        data: { image: "AAAA", mime: "image/jpeg", step: 12, total: 20 },
    };
    const frame = decodeKjPreviewMessage(message, "141", "prompt-1");
    assert.ok(frame);
    assert.equal(frame.source, "step");
    assert.equal(frame.nodeId, "141");
    assert.equal(frame.promptId, "prompt-1");
    assert.equal(frame.step, 12);
    assert.equal(frame.total, 20);
    assert.match(frame.dataUrl, /^data:image\/jpeg;base64,AAAA$/);

    assert.equal(decodeKjPreviewMessage(message, "", "prompt-1"), null);
    assert.equal(decodeKjPreviewMessage(message, "141", ""), null);
    assert.equal(decodeKjPreviewMessage({ type: "executed", data: { image: "AAAA" } }, "141", "prompt-1"), null);
    assert.equal(decodeKjPreviewMessage({ type: "kj_preview_override", data: {} }, "141", "prompt-1"), null);
    // 事件里没有节点 id / prompt_id 时，允许从消息顶层读（兼容 KJ 不同版本的发送形状）。
    assert.ok(decodeKjPreviewMessage({ type: "kj_preview_override", image: "BBBB" }, "141", "prompt-1"));
});

test("executed 的 temp 图引用只取第一张，视频/音频输出不进预览帧", () => {
    assert.deepEqual(previewImageRefFromOutput({
        images: [{ filename: "a.png", subfolder: "", type: "temp" }, { filename: "b.png", subfolder: "", type: "temp" }],
    }), { filename: "a.png", subfolder: "", type: "temp" });
    assert.equal(previewImageRefFromOutput({ gifs: [{ filename: "v.mp4" }] }), null);
    assert.equal(previewImageRefFromOutput(null), null);
    assert.equal(previewImageRefFromOutput({ images: [{ filename: "" }] }), null);
});

test("预览帧按子任务与画布父任务双写，清理互不影响", () => {
    const taskIds = ["child-task", "parent-task"];
    const frame = { dataUrl: "data:image/png;base64,AAAA", source: "step" as const, nodeId: "141" };
    clearWorkflowLivePreview(taskIds);
    publishWorkflowLivePreview(taskIds, frame);
    assert.equal(readWorkflowLivePreview("child-task")?.dataUrl, frame.dataUrl);
    assert.equal(readWorkflowLivePreview("parent-task")?.dataUrl, frame.dataUrl);
    clearWorkflowLivePreview(["child-task"]);
    assert.equal(readWorkflowLivePreview("child-task"), null);
    assert.equal(readWorkflowLivePreview("parent-task")?.dataUrl, frame.dataUrl);
    clearWorkflowLivePreview(taskIds);
    assert.equal(readWorkflowLivePreview("parent-task"), null);
});
