import test from "node:test";
import assert from "node:assert/strict";

import { aggregateClipRuntimeState, clipRuntimeState } from "./h3-clip-runtime";

test("生成状态按 Clip 独立读取，不受另一个 Clip 终态影响", () => {
    const running = clipRuntimeState({ id: "a", status: "loading", parentTaskId: "parent-a", runtimeTaskId: "child-a" });
    const finished = clipRuntimeState({ id: "b", status: "success", parentTaskId: "", runtimeTaskId: "" });
    assert.equal(running.taskId, "parent-a");
    assert.equal(running.busy, true);
    assert.equal(finished.status, "success");
    assert.equal(finished.busy, false);
});

test("多个 Clip 同时运行时节点聚合状态仍指向活动 Clip", () => {
    const state = aggregateClipRuntimeState([
        { id: "a", status: "success", progress: 1 },
        { id: "b", status: "loading", parentTaskId: "parent-b", runtimeTaskId: "child-b", progress: 0.4 },
        { id: "c", status: "loading", parentTaskId: "parent-c", runtimeTaskId: "child-c", progress: 0.2 },
    ]);
    assert.equal(state.status, "loading");
    assert.equal(state.taskId, "parent-b");
    assert.equal(state.progress, 0.4);
});
