import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLocalFieldsToDiscovered } from "./runninghub-field-sync.js";
import type { RunningHubField } from "@basketikun/canvas-agent/generation-contract";

function discovered(nodeId: string, fieldName: string, extra: Partial<RunningHubField> = {}): RunningHubField {
    return { id: `${nodeId}::${fieldName}`, nodeId, fieldName, fieldValue: "raw", fieldType: "text", label: `node · ${fieldName}`, enabled: false, source: "constant", ...extra };
}

describe("runninghub-field-sync.applyLocalFieldsToDiscovered", () => {
    it("命中本地字段就启用，并带上名称/类型/默认值", () => {
        const [field] = applyLocalFieldsToDiscovered(
            [discovered("11", "aspect_ratio")],
            [{ node: "11", input: "aspect_ratio", name: "画面比例", type: "dropdown", default: "9:16" }],
        );
        assert.equal(field.enabled, true);
        assert.equal(field.label, "画面比例");
        assert.equal(field.fieldType, "dropdown");
        assert.equal(field.fieldValue, "9:16");
        assert.equal(field.source, "constant");
    });

    it("isPrompt 的本地字段按提示词来源上传", () => {
        const [field] = applyLocalFieldsToDiscovered([discovered("4", "text")], [{ node: "4", input: "text", isPrompt: true }]);
        assert.equal(field.source, "prompt");
        assert.equal(field.enabled, true);
    });

    it("媒体字段按 image/video/audio 来源上传", () => {
        const fields = applyLocalFieldsToDiscovered(
            [discovered("20", "image"), discovered("30", "video"), discovered("40", "audio")],
            [{ node: "20", input: "image", type: "image" }, { node: "30", input: "video", type: "video" }, { node: "40", input: "audio", type: "audio" }],
        );
        assert.deepEqual(fields.map((item) => item.source), ["image", "video", "audio"]);
    });

    it("一个本地字段映射多个节点时每个节点都启用", () => {
        const fields = applyLocalFieldsToDiscovered(
            [discovered("a", "seed"), discovered("b", "seed")],
            [{ node: "a,b", input: "seed", name: "种子" }],
        );
        assert.deepEqual(fields.map((item) => item.enabled), [true, true]);
        assert.deepEqual(fields.map((item) => item.label), ["种子", "种子"]);
    });

    it("本地没配的字段保持禁用且原值不变", () => {
        const untouched = discovered("2", "filename_prefix");
        const [field] = applyLocalFieldsToDiscovered([untouched], [{ node: "11", input: "aspect_ratio" }]);
        assert.deepEqual(field, untouched);
        assert.equal(field.enabled, false);
    });

    it("本地没有字段时原样返回", () => {
        const list = [discovered("1", "x")];
        assert.equal(applyLocalFieldsToDiscovered(list, []), list);
    });

    it("required 标记一起带上", () => {
        const [field] = applyLocalFieldsToDiscovered([discovered("5", "prompt")], [{ node: "5", input: "prompt", required: true }]);
        assert.equal(field.required, true);
    });
});
