import assert from "node:assert/strict";
import test from "node:test";

import { selectOutputNodes } from "./executor.js";
import { selectRunningHubResults } from "../runtime/runninghub.js";

// ComfyUI history.outputs 的形状：节点 ID → 该节点产物。
const outputs = {
    "9": { images: [{ filename: "preview.png" }] },
    "10": { images: [{ filename: "final.png" }] },
    "11": { gifs: [{ filename: "video.gif" }] },
};

test("不指定输出节点时保留全部产物", () => {
    assert.deepEqual(selectOutputNodes(outputs, undefined), outputs);
    assert.deepEqual(selectOutputNodes(outputs, []), outputs);
});

test("指定输出节点后只保留选中节点的产物", () => {
    assert.deepEqual(Object.keys(selectOutputNodes(outputs, ["10"])), ["10"]);
    assert.deepEqual(Object.keys(selectOutputNodes(outputs, ["10", "11"])), ["10", "11"]);
});

test("节点 ID 用字符串匹配，避免数字/字符串形态不一致导致全被丢掉", () => {
    const selected = selectOutputNodes({ 9: { images: [] }, 10: { images: [] } } as Record<string, unknown>, ["10"]);
    assert.deepEqual(Object.keys(selected), ["10"]);
});

test("指定了不存在的输出节点时返回空对象，由调用方给出可读报错", () => {
    assert.deepEqual(selectOutputNodes(outputs, ["999"]), {});
});

test("整体失败时仍能从指定输出节点取到产物（抢救用例）", () => {
    // 整体状态是 error，但指定节点 10 已经有图：应挑出产物，而不是丢弃整次运行。
    const failedOutputs = { "10": { images: [{ filename: "partial.png" }] }, "12": { images: [{ filename: "other.png" }] } };
    const rescued = selectOutputNodes(failedOutputs, ["10"]);
    assert.deepEqual(Object.keys(rescued), ["10"]);
    assert.equal((rescued["10"] as { images: unknown[] }).images.length, 1);
});

test("整体失败且指定输出节点没有产物时返回空，交由调用方报错", () => {
    assert.deepEqual(selectOutputNodes(outputs, ["999"]), {});
});

test("RunningHub 结果按 nodeId 过滤，未指定时原样返回", () => {
    const results = [
        { nodeId: "9", url: "https://example.com/a.png" },
        { nodeId: "10", url: "https://example.com/b.png" },
        { nodeId: "", text: "没有节点归属的文本" },
    ];
    assert.equal(selectRunningHubResults(results, []).length, 3);
    assert.equal(selectRunningHubResults(results, ["10"]).length, 1);
    assert.equal(selectRunningHubResults(results, ["10"])[0].url, "https://example.com/b.png");
    assert.equal(selectRunningHubResults(results, ["404"]).length, 0);
});