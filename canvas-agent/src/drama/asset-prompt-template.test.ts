import assert from "node:assert/strict";
import test from "node:test";
import {
    buildSchemePrompt,
    renderAssetPromptWithTemplate,
    assetPromptTemplateFor,
} from "./asset-spec.js";

const appearance = "青衫少年，佩剑";

test("空模板回退内置方案模板，行为与旧路径完全一致", () => {
    const legacy = buildSchemePrompt("character", "崇良", appearance, "portrait", { artStyle: "写实" });
    const rendered = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait", null, { 项目画风: "写实" });
    assert.equal(rendered.usedTemplate, false);
    assert.equal(rendered.prompt, legacy);
    assert.deepEqual(rendered.unknownVars, []);
});

test("按类型取模板：本类覆盖优先，缺省落 default", () => {
    const templates = { default: "默认{{资产名称}}", character: "角色{{资产名称}}", scene: "" };
    assert.equal(assetPromptTemplateFor("character", templates), "角色{{资产名称}}");
    assert.equal(assetPromptTemplateFor("scene", templates), "默认{{资产名称}}");
    assert.equal(assetPromptTemplateFor("prop", templates), "默认{{资产名称}}");
    assert.equal(assetPromptTemplateFor("prop", { prop: "  " }), "");
});

test("变量替换：名称/设定/方案要求都进正文，未知变量原样保留并回报", () => {
    const rendered = renderAssetPromptWithTemplate("character", "崇良", appearance, "turnaround",
        { default: "{{资产名称}}｜{{资产设定}}｜{{方案要求}}｜{{不存在}}" },
        { 资产设定: appearance });
    assert.equal(rendered.usedTemplate, true);
    assert.match(rendered.prompt, /崇良/);
    assert.match(rendered.prompt, /青衫少年，佩剑/);
    assert.match(rendered.prompt, /三视图设定板/);
    assert.match(rendered.prompt, /\{\{不存在\}\}/, "未知变量不能被静默删除");
    assert.deepEqual(rendered.unknownVars, ["不存在"]);
});

test("画面规则：模板未写变量时追加一次，写了则用模板位置不重复", () => {
    const appended = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆" }, { 画面规则: "不要现代元素" });
    assert.match(appended.prompt, /用户长期规则：不要现代元素/);

    const inline = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆\n规则：{{画面规则}}" }, { 画面规则: "不要现代元素" });
    assert.equal((inline.prompt.match(/不要现代元素/g) || []).length, 1);
});

test("画幅与画风：模板没写时补齐，写了不重复", () => {
    const bare = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆" }, { 项目画风: "水墨" });
    assert.match(bare.prompt, /16:9/);
    assert.match(bare.prompt, /水墨/);

    const explicit = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆 16:9" }, {});
    assert.equal((explicit.prompt.match(/16:9/g) || []).length, 1);
});

test("模板渲染为空时回退内置模板，不发送空提示词", () => {
    const rendered = renderAssetPromptWithTemplate("scene", "七绝山", "山道", "scene", { scene: "   " });
    assert.equal(rendered.usedTemplate, false);
    assert.match(rendered.prompt, /七绝山/);
});
