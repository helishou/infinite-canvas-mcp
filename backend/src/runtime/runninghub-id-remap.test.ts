import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alignFieldsToGraph, buildNodeIdMapping, remapRunningHubFields } from "./runninghub-id-remap.js";
import type { RunningHubField } from "@basketikun/canvas-agent/generation-contract";

function graph(nodes: Record<string, string>) {
    const out: Record<string, any> = {};
    for (const [id, classType] of Object.entries(nodes)) out[id] = { class_type: classType, inputs: {} };
    return out;
}

function field(nodeId: string, fieldName = "strength_model"): RunningHubField {
    return { id: `${nodeId}::${fieldName}`, nodeId, fieldName, enabled: true, source: "constant", fieldType: "number", label: `${nodeId}.${fieldName}` };
}

describe("runninghub-id-remap.buildNodeIdMapping", () => {
    it("同类型节点数不变时按编号顺序一一对应", () => {
        const before = graph({ "53": "LoraLoaderModelOnly", "400": "LoraLoaderModelOnly", "11": "ResolutionSelector" });
        const after = graph({ "105": "LoraLoaderModelOnly", "106": "LoraLoaderModelOnly", "12": "ResolutionSelector" });
        const mapping = buildNodeIdMapping(before, after);
        assert.equal(mapping.get("53"), "105");
        assert.equal(mapping.get("400"), "106");
        assert.equal(mapping.get("11"), "12");
    });

    it("同类型节点数量变了就不映射（避免错位到别的节点）", () => {
        const before = graph({ "53": "LoraLoaderModelOnly", "400": "LoraLoaderModelOnly" });
        const after = graph({ "105": "LoraLoaderModelOnly" });
        assert.equal(buildNodeIdMapping(before, after).size, 0);
    });

    it("不同节点类型之间不会互串", () => {
        const before = graph({ "53": "LoraLoaderModelOnly" });
        const after = graph({ "53": "UNETLoader" });
        assert.equal(buildNodeIdMapping(before, after).size, 0);
    });
});

describe("runninghub-id-remap.remapRunningHubFields", () => {
    it("编号变了也能把字段搬到新编号，并重建 id", () => {
        const before = graph({ "53": "LoraLoaderModelOnly", "400": "LoraLoaderModelOnly" });
        const after = graph({ "105": "LoraLoaderModelOnly", "106": "LoraLoaderModelOnly" });
        const [moved] = remapRunningHubFields(before, after, [field("400", "lora_name")]);
        assert.equal(moved.nodeId, "106");
        assert.equal(moved.id, "106::lora_name", "运行提交用 id 当参数键，必须一起改");
        assert.equal(moved.enabled, true, "启用状态与其它配置保留");
    });

    it("编号没变的字段原样保留", () => {
        const before = graph({ "11": "ResolutionSelector" });
        const after = graph({ "11": "ResolutionSelector" });
        const list = [field("11", "aspect_ratio")];
        assert.equal(remapRunningHubFields(before, after, list)[0], list[0]);
    });

    it("新图里彻底没有对应节点的字段被丢弃", () => {
        const before = graph({ "53": "LoraLoaderModelOnly", "400": "LoraLoaderModelOnly" });
        const after = graph({ "105": "LoraLoaderModelOnly" });
        assert.equal(remapRunningHubFields(before, after, [field("53"), field("400")]).length, 0);
    });

    it("空字段列表返回空数组", () => {
        assert.deepEqual(remapRunningHubFields(graph({ "1": "SaveImage" }), graph({ "2": "SaveImage" }), []), []);
    });
});

describe("runninghub-id-remap.alignFieldsToGraph", () => {
    it("编号全命中时不做任何处理，返回原数组", () => {
        const graph = { "11": { class_type: "ResolutionSelector", inputs: {} } };
        const fields = [field("11", "aspect_ratio")];
        assert.equal(alignFieldsToGraph(graph, graph, fields), fields);
    });

    it("部分编号对不上时按类型迁移", () => {
        const before = graph({ "53": "LoraLoaderModelOnly" });
        const after = graph({ "105": "LoraLoaderModelOnly" });
        const [moved] = alignFieldsToGraph(before, after, [field("53", "lora_name")]);
        assert.equal(moved.nodeId, "105");
    });

    it("映射不出结果时保留原字段，交给上游报「请重新同步映射」", () => {
        const before = graph({ "53": "LoraLoaderModelOnly" });
        const after = graph({ "105": "UNETLoader" });
        const fields = [field("53", "lora_name")];
        assert.equal(alignFieldsToGraph(before, after, fields), fields);
    });
});
