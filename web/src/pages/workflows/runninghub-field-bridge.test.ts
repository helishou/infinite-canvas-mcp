import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bridgeLocalFormToProfile } from "./runninghub-field-bridge";
import type { WorkflowField } from "@/types/workflow";
import type { RunningHubWorkflowProfile } from "@/services/api/runninghub";

function localField(id: string, node: string, input: string): WorkflowField {
    return { id, node, input, name: id, type: "text" };
}

function profile(fields: Array<{ id: string; nodeId: string; fieldName: string; enabled?: boolean }>): RunningHubWorkflowProfile {
    return {
        id: "p1",
        name: "云端",
        workflowId: "w1",
        fields: fields.map((field) => ({ ...field, label: field.fieldName, fieldType: "STRING" })) as never,
    } as RunningHubWorkflowProfile;
}

describe("runninghub-field-bridge.bridgeLocalFormToProfile", () => {
    it("按 node::input 把本地表单值搬到云端字段", () => {
        const form = bridgeLocalFormToProfile(
            profile([{ id: "967::filename_prefix", nodeId: "967", fieldName: "filename_prefix" }]),
            [localField("f1", "967", "filename_prefix")],
            { f1: "ComfyUI" },
        );
        assert.deepEqual(form, { "967::filename_prefix": "ComfyUI" });
    });

    it("本地字段映射多个节点时任一命中都生效", () => {
        const form = bridgeLocalFormToProfile(
            profile([{ id: "b::seed", nodeId: "b", fieldName: "seed" }]),
            [localField("f1", "a,b", "seed")],
            { f1: "42" },
        );
        assert.deepEqual(form, { "b::seed": "42" });
    });

    it("云端有、本地没填的字段不传，沿用档案值", () => {
        const form = bridgeLocalFormToProfile(
            profile([{ id: "1::steps", nodeId: "1", fieldName: "steps" }]),
            [localField("f1", "967", "filename_prefix")],
            { f1: "x" },
        );
        assert.deepEqual(form, {});
    });

    it("云端停用的字段不参与", () => {
        const form = bridgeLocalFormToProfile(
            profile([{ id: "1::steps", nodeId: "1", fieldName: "steps", enabled: false }]),
            [localField("f1", "1", "steps")],
            { f1: "20" },
        );
        assert.deepEqual(form, {});
    });

    it("空值也会传下去（用户清空就是清空）", () => {
        const form = bridgeLocalFormToProfile(
            profile([{ id: "1::text", nodeId: "1", fieldName: "text" }]),
            [localField("f1", "1", "text")],
            { f1: "" },
        );
        assert.deepEqual(form, { "1::text": "" });
    });
});
