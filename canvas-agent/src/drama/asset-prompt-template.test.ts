import assert from "node:assert/strict";
import test from "node:test";
import {
    ASSET_PROMPT_FALLBACK_TEMPLATE,
    buildSchemePrompt,
    defaultAssetPromptTemplate,
    renderAssetPromptWithTemplate,
    assetPromptTemplateFor,
    type AssetPromptTemplates,
} from "./asset-spec.js";

const appearance = "青衫少年，佩剑";

/** 影策 `assets.go` 真值，只把 `{{角色名称}}/{{道具名称}}/{{场景名称}}`→`{{资产名称}}`、`{{…设定}}`→`{{资产设定}}`。 */
const GO_TEMPLATES = {
    "character/portrait": "{{项目画风}}。角色定妆照：{{资产名称}}。{{资产设定}}。\n横版构图，单人居中，正面半身，中性表情，目视镜头；干净浅色纯背景，柔和均匀的正面光，五官、发型与服装细节清晰。\n禁止文字、水印、道具遮挡面部、额外人物。{{画面规则}}",
    "character/turnaround": "{{项目画风}}。专业人物三视图设定板：{{资产名称}}。{{资产设定}}。\n画面严格分成三个等宽竖向区域，从左到右依次为正面全身、右侧面全身、背面全身；三个视角是同一角色、同一服装、同一发型、同一体型与比例。\n站立中性姿势，完整显示头顶到脚底，不裁切头部和脚。纯净中性浅色背景，均匀设定稿光线，不改变项目画风的绘画或渲染媒介。\n禁止文字、边框、道具说明、表情变化和额外人物。{{画面规则}}",
    "character/fourview": "{{项目画风}}。角色四格资产参考图：{{资产名称}}。{{资产设定}}。\n横版白色纯背景，全图共 4 格，等高排列：\n① 面部特写：唯一一张清晰的脸，五官、脸型、发际线、眉眼、鼻唇、肤色、痣与疤痕等特征完整锁定；\n② 正面全身（面部弱化）；③ 90° 侧面全身（面部弱化）；④ 背面全身。\n全身格从头顶到鞋底完整入画，不裁切头部；四格中的服装、发型、体型与配饰完全一致。\n画面底部一条细横带：声纹波形 / 频谱可视化图形，旁边一行不超过 8 个英文单词的音色标签。\n除音色标签外不出现任何文字。负面：全身格出现清晰五官、第二张可辨认的脸、马赛克或像素化遮挡、额外人物。{{画面规则}}",
    "scene/scene": "{{项目画风}}。场景概念设定图：{{资产名称}}。{{资产设定}}。\n横版宽景构图，无人物，空镜，构图完整，主体空间与出入口清晰，前中后景层次分明；光源方向明确，色调与时代服化道统一。\n禁止文字、水印、边框。{{画面规则}}",
    "prop/prop": "{{项目画风}}。道具设定图：{{资产名称}}。{{资产设定}}。\n横版构图，单件道具居中完整展示，四周留白，干净浅灰背景，柔和棚拍光，外形、材质、颜色与细节清晰；无人物、无手部。\n禁止文字、水印、边框。{{画面规则}}",
} as const;

const COMBOS = [
    ["character", "portrait"],
    ["character", "turnaround"],
    ["character", "fourview"],
    ["scene", "scene"],
    ["prop", "prop"],
] as const;

/** 与影策 `renderAssetTemplate` 同口径渲染：变量替换 + 清掉空变量残留的「。。」「：。」。 */
function goRender(template: string, values: Record<string, string>): string {
    let out = template;
    for (const [key, value] of Object.entries(values)) out = out.split(`{{${key}}}`).join(value.trim());
    return out.replace(/。。/g, "。").replace(/：。/g, "。").trim();
}

const FORBIDDEN = /【参考图用法】|最终输出画幅必须为|用户长期规则：/;

test("空模板回退内置方案模板，行为与模板路径完全一致", () => {
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

test("画面规则：模板没写 {{画面规则}} 时不再追加「用户长期规则：」段，写了只出现一次", () => {
    const omitted = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆" }, { 画面规则: "不要现代元素" });
    assert.doesNotMatch(omitted.prompt, FORBIDDEN);
    assert.doesNotMatch(omitted.prompt, /不要现代元素/, "模板没有占位就不追加规则");

    const inline = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆\n规则：{{画面规则}}" }, { 画面规则: "不要现代元素" });
    assert.equal((inline.prompt.match(/不要现代元素/g) || []).length, 1);
    assert.doesNotMatch(inline.prompt, FORBIDDEN);
});

test("同一画风只出现一次：模板含 {{项目画风}} 时不再追加「全片统一画风」后缀", () => {
    const style = "国风水墨写实";
    const template = defaultAssetPromptTemplate("prop", "prop");
    const rendered = renderAssetPromptWithTemplate("prop", "铁鞭", appearance, "prop", { default: template },
        { 项目画风: style, 资产名称: "铁鞭" });
    assert.equal((rendered.prompt.match(/国风水墨写实/g) || []).length, 1);
    assert.doesNotMatch(rendered.prompt, /全片统一画风：/);

    // 带标点的画风也要按归一化包含判出来，不能因为「全片统一画风：」前缀而漏判。
    const punctuated = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{项目画风}}。角色定妆照：{{资产名称}}。" }, { 项目画风: "水墨：写实，冷色" });
    assert.equal((punctuated.prompt.match(/水墨/g) || []).length, 1);
    assert.doesNotMatch(punctuated.prompt, /全片统一画风：/);

    // 模板没有 {{项目画风}} 时仍追加一次画风后缀。
    const appended = renderAssetPromptWithTemplate("prop", "铁鞭", appearance, "prop",
        { prop: "{{资产名称}}：{{资产设定}}" }, { 项目画风: style });
    assert.equal((appended.prompt.match(/国风水墨写实/g) || []).length, 1);
    assert.match(appended.prompt, /全片统一画风：国风水墨写实/);
});

test("画幅：不再自动补「最终输出画幅必须为」行，用户模板里写的 16:9 原样保留一次", () => {
    const bare = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆" }, { 项目画风: "水墨" });
    assert.match(bare.prompt, /水墨/);
    assert.doesNotMatch(bare.prompt, FORBIDDEN);
    assert.doesNotMatch(bare.prompt, /16:9/);

    const explicit = renderAssetPromptWithTemplate("character", "崇良", appearance, "portrait",
        { character: "{{资产名称}} 定妆 16:9" }, {});
    assert.equal((explicit.prompt.match(/16:9/g) || []).length, 1);
    assert.doesNotMatch(explicit.prompt, FORBIDDEN);
});

test("模板渲染为空时回退内置模板，不发送空提示词", () => {
    const rendered = renderAssetPromptWithTemplate("scene", "七绝山", "山道", "scene", { scene: "   " });
    assert.equal(rendered.usedTemplate, false);
    assert.match(rendered.prompt, /七绝山/);
    assert.doesNotMatch(rendered.prompt, /^。/, "画风为空时不应留下孤立句号");
});

test("内置默认模板与影策 Go 模板逐字一致，只保留本地变量名", () => {
    for (const [kind, scheme] of COMBOS) {
        const key = `${kind}/${scheme}` as keyof typeof GO_TEMPLATES;
        assert.equal(defaultAssetPromptTemplate(kind, scheme), GO_TEMPLATES[key], `${key} 必须逐字照抄影策`);
    }
    assert.notEqual(defaultAssetPromptTemplate("character", "fourview"), defaultAssetPromptTemplate("character", "portrait"));
});

test("内置默认模板：变量齐全（不再有方案要求行），渲染后无残留变量与三段落追加", () => {
    for (const [kind, scheme] of COMBOS) {
        const template = defaultAssetPromptTemplate(kind, scheme);
        for (const variable of ["{{项目画风}}", "{{资产名称}}", "{{资产设定}}", "{{画面规则}}"]) {
            assert.ok(template.includes(variable), `${kind}/${scheme} 缺少 ${variable}`);
        }
        assert.equal(template.includes("{{方案要求}}"), false, `${kind}/${scheme} 不应再有方案要求行`);
        assert.equal(template.includes("崇良"), false, `${kind}/${scheme} 不应写死资产名`);

        const rendered = renderAssetPromptWithTemplate(kind, "崇良", appearance, scheme,
            { default: template } as AssetPromptTemplates,
            { 资产名称: "崇良", 资产设定: appearance, 画面规则: "不要现代元素", 项目画风: "写实" });
        assert.equal(rendered.usedTemplate, true, `${kind}/${scheme} 应走模板渲染`);
        assert.deepEqual(rendered.unknownVars, [], `${kind}/${scheme} 不应有未知变量`);
        assert.equal(rendered.prompt.includes("{{"), false, `${kind}/${scheme} 渲染后有残留变量`);
        assert.doesNotMatch(rendered.prompt, FORBIDDEN);
    }
});

test("首两行与影策 Go 模板渲染逐字一致（只比模板正文，不含量化后缀）", () => {
    for (const [kind, scheme] of COMBOS) {
        const key = `${kind}/${scheme}` as keyof typeof GO_TEMPLATES;
        const vars = { 项目画风: "写实", 资产名称: "崇良", 资产设定: appearance, 画面规则: "不要现代元素" };
        const rendered = renderAssetPromptWithTemplate(kind, "崇良", appearance, scheme, { default: GO_TEMPLATES[key] }, vars);
        const localHead = rendered.prompt.split("\n").slice(0, 2).join("\n");
        const goHead = goRender(GO_TEMPLATES[key], vars).split("\n").slice(0, 2).join("\n");
        assert.equal(localHead, goHead, `${key} 首两行与影策不一致`);
    }
});

test("未单独覆盖的组合回退通用模板，仍可渲染", () => {
    const fallback = defaultAssetPromptTemplate("character", "scene");
    assert.equal(fallback, ASSET_PROMPT_FALLBACK_TEMPLATE);
    assert.match(fallback, /\{\{方案名称\}\}/);
    assert.match(fallback, /\{\{资产设定\}\}/);
    const rendered = renderAssetPromptWithTemplate("character", "崇良", appearance, "scene", { default: fallback });
    assert.equal(rendered.prompt.includes("{{"), false);
    assert.match(rendered.prompt, /崇良/);
});
