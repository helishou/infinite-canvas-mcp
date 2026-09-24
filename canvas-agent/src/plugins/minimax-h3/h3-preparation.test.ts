import assert from "node:assert/strict";
import test from "node:test";

import { diffH3Settings, inheritedH3Params, selectH3InheritanceSource } from "./mcp.js";

const segments = [
    { id: "s1", status: "success", result: "media:s1", modelName: "b25-49", megapixels: 0.2, sampler: "er_sde", scheduler: "simple", duration: 8.5 },
    { id: "s2", status: "idle", modelName: "wrong-draft", megapixels: 1.5, sampler: "res_multistep", scheduler: "karras", duration: 10 },
];

test("准备片段默认继承最近已完成片段，而不是闲置草稿参数", () => {
    const source = selectH3InheritanceSource(segments, "s2");
    assert.equal(source?.id, "s1");
    assert.deepEqual(inheritedH3Params({ metadata: {}, id: "h3" }, "s1", segments), {
        modelName: "b25-49",
        megapixels: 0.2,
        sampler: "er_sde",
        scheduler: "simple",
        duration: 8.5,
    });
});

test("显式继承来源优先，且参数差异可审计", () => {
    const source = selectH3InheritanceSource(segments, "s2", "s1");
    assert.equal(source?.id, "s1");
    assert.deepEqual(diffH3Settings(
        { modelName: "b25-49", megapixels: 0.2, sampler: "er_sde" },
        { modelName: "b25-49", megapixels: 1.5, sampler: "res_multistep" },
    ), [
        { key: "megapixels", before: 0.2, after: 1.5 },
        { key: "sampler", before: "er_sde", after: "res_multistep" },
    ]);
});

test("显式继承来源必须是已完成片段", () => {
    assert.equal(selectH3InheritanceSource([{ id: "draft", status: "idle", megapixels: 1.5 }], "target", "draft"), undefined);
});
test("没有已完成来源时退回节点级配置", () => {
    const source = selectH3InheritanceSource([{ id: "s1", status: "idle" }], "s1");
    assert.equal(source, undefined);
    assert.deepEqual(inheritedH3Params({ metadata: { megapixels: 0.4, comfyParams: { sampler: "euler" } } }, undefined, [{ id: "s1" }]), {
        megapixels: 0.4,
        sampler: "euler",
    });
});
