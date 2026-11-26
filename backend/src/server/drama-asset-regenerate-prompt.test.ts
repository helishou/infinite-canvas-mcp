import assert from "node:assert/strict";
import test from "node:test";
import { buildRegeneratePrompt, type RegenerateReferenceInput } from "./drama-asset-regenerate-routes.js";

const located = {
    episodeId: "ep1",
    canvasId: "cv1",
    nodeId: "n1",
    kind: "character" as const,
    name: "崇良",
    appearance: "青衫少年，佩剑",
    scheme: "portrait" as const,
    groupId: "",
};

const input = { dramaId: "d1", assetId: "a1", restyleSegments: true } as RegenerateReferenceInput;

test("无模板时与内置方案模板一致（默认行为不变）", () => {
    const prompt = buildRegeneratePrompt(located, input, "写实", "zh");
    assert.match(prompt, /崇良/);
    assert.match(prompt, /青衫少年，佩剑/);
    assert.match(prompt, /16:9/);
});

test("传剧目模板时用模板渲染并替换变量", () => {
    const prompt = buildRegeneratePrompt(located, input, "水墨", "zh", { character: "{{资产名称}}｜{{资产设定}}｜{{方案名称}}" });
    assert.match(prompt, /崇良｜青衫少年，佩剑｜定妆照/);
    assert.match(prompt, /水墨/, "画风仍按剧目拼接");
    assert.doesNotMatch(prompt, /\{\{/, "变量必须全部替换");
});

test("显式 prompt 覆盖模板（重做时手写提示词优先）", () => {
    const prompt = buildRegeneratePrompt({ ...located, }, { ...input, prompt: "手写：正面半身，白背景" }, "写实", "zh",
        { character: "{{资产名称}} 模板" });
    assert.match(prompt, /手写：正面半身，白背景/);
    assert.doesNotMatch(prompt, /模板/);
});

test("场景模板走 scene 档，缺省落 default", () => {
    const scene = { ...located, kind: "scene" as const, name: "七绝山道", appearance: "山道，松林", scheme: "scene" as const };
    const byScene = buildRegeneratePrompt(scene, input, "", "zh", { scene: "场景模板：{{资产名称}}", default: "默认模板" });
    assert.match(byScene, /场景模板：七绝山道/);
    const byDefault = buildRegeneratePrompt(scene, input, "", "zh", { default: "默认模板{{资产名称}}" });
    assert.match(byDefault, /默认模板七绝山道/);
});
