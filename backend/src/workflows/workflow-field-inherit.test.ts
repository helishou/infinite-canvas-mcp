import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeInheritedFields, workflowFieldKey } from "./workflow-field-inherit.js";
import type { WorkflowField } from "../db.js";

function field(id: string, node: string, input: string, extra: Partial<WorkflowField> = {}): WorkflowField {
    return { id, node, input, name: id, type: "text", ...extra };
}

describe("workflow-field-inherit.mergeInheritedFields", () => {
    it("本地自定义配置优先，云端同名 node::input 不重复加", () => {
        const inherited = [field("mine", "967", "filename_prefix", { name: "文件名", type: "dropdown" })];
        const discovered = [field("cloud", "967", "filename_prefix", { name: "filename_prefix", type: "text" })];
        const merged = mergeInheritedFields(inherited, discovered);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].name, "文件名", "应该保留本地改过的名称");
        assert.equal(merged[0].type, "dropdown");
    });

    it("云端新增的节点字段追加在后面，不丢", () => {
        const inherited = [field("a", "1", "text")];
        const discovered = [field("b", "1", "text"), field("c", "2", "steps")];
        const merged = mergeInheritedFields(inherited, discovered);
        assert.deepEqual(merged.map((item) => item.id), ["a", "c"]);
    });

    it("本地没有配置时等于直接用云端字段", () => {
        const discovered = [field("b", "1", "text"), field("c", "2", "steps")];
        assert.deepEqual(mergeInheritedFields([], discovered), discovered);
    });

    it("云端没有字段时保留本地配置", () => {
        const inherited = [field("a", "1", "text")];
        assert.deepEqual(mergeInheritedFields(inherited, []), inherited);
    });

    it("配对键只看 node::input，不受字段 id 影响", () => {
        assert.equal(workflowFieldKey(field("x", "967", "seed")), workflowFieldKey(field("y", "967", "seed")));
        assert.notEqual(workflowFieldKey(field("x", "967", "seed")), workflowFieldKey(field("x", "967", "steps")));
    });
});
