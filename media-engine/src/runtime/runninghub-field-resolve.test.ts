import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveLocalFieldTargets } from "./runninghub-field-resolve.js";

const uiWorkflow = {
    nodes: [
        { id: 266, type: "SetNode", widgets_values: ["提示词"] },
        { id: 267, type: "GetNode", widgets_values: ["提示词"] },
    ],
};

describe("runninghub-field-resolve.resolveLocalFieldTargets", () => {
    it("输入本身就是常量时原样保留", () => {
        const graph = { "265": { class_type: "MiniMaxH3", inputs: { prompt: "写死的提示词" } } };
        const { targets, unresolved } = resolveLocalFieldTargets(graph, undefined, [{ node: "265", input: "prompt", name: "提示词" }]);
        assert.equal(unresolved.length, 0);
        assert.deepEqual([targets[0].nodeId, targets[0].fieldName], ["265", "prompt"]);
    });

    it("连线到普通文本节点时下钻到它的文本输入", () => {
        const graph = {
            "265": { class_type: "MiniMaxH3", inputs: { prompt: ["949", 0] } },
            "949": { class_type: "Text", inputs: { text: "正文" } },
        };
        const { targets } = resolveLocalFieldTargets(graph, undefined, [{ node: "265", input: "prompt" }]);
        assert.deepEqual([targets[0].nodeId, targets[0].fieldName], ["949", "text"]);
    });

    it("经过 GetNode / SetNode 变量也能追到真正的常量来源", () => {
        const graph = {
            "265": { class_type: "MiniMaxH3", inputs: { prompt: ["267", 0] } },
            "267": { class_type: "GetNode", inputs: {} },
            "266": { class_type: "SetNode", inputs: { STRING: ["263", 0] } },
            "263": { class_type: "Text", inputs: { text: "真实的提示词" } },
        };
        const { targets, unresolved } = resolveLocalFieldTargets(graph, uiWorkflow, [{ node: "265", input: "prompt", name: "提示词" }]);
        assert.equal(unresolved.length, 0);
        assert.deepEqual([targets[0].nodeId, targets[0].fieldName], ["263", "text"]);
    });

    it("没有 UI 原件时 GetNode 的变量名配不上，报未解析而不是乱指", () => {
        const graph = {
            "265": { class_type: "MiniMaxH3", inputs: { prompt: ["267", 0] } },
            "267": { class_type: "GetNode", inputs: {} },
            "266": { class_type: "SetNode", inputs: { STRING: ["263", 0] } },
        };
        const { targets, unresolved } = resolveLocalFieldTargets(graph, undefined, [{ node: "265", input: "prompt", name: "提示词" }]);
        assert.equal(targets.length, 0);
        assert.equal(unresolved[0].reason, "link-unresolved");
        assert.equal(unresolved[0].name, "提示词");
    });

    it("节点或输入不存在时报未解析", () => {
        const { targets, unresolved } = resolveLocalFieldTargets({ "1": { class_type: "X", inputs: {} } }, undefined, [{ node: "99", input: "prompt" }]);
        assert.equal(targets.length, 0);
        assert.equal(unresolved.length, 1);
    });

    it("连线成环时不会死循环", () => {
        const graph = {
            "1": { class_type: "A", inputs: { text: ["2", 0] } },
            "2": { class_type: "B", inputs: { text: ["1", 0] } },
        };
        const { targets, unresolved } = resolveLocalFieldTargets(graph, undefined, [{ node: "1", input: "text" }]);
        assert.equal(targets.length, 0);
        assert.equal(unresolved.length, 1);
    });

    it("一个字段映射多个节点时取第一个能解析的", () => {
        const graph = { "7": { class_type: "Text", inputs: { text: "abc" } } };
        const { targets } = resolveLocalFieldTargets(graph, undefined, [{ node: "9,7", input: "text" }]);
        assert.equal(targets[0].nodeId, "7");
    });
});
