import assert from "node:assert/strict";
import test from "node:test";
import {
    ASSET_KIND_SKILL,
    assetSpecReadiness,
    assetSpecSummary,
    buildAssetImagePrompt,
    missingAssetSpecFields,
    type AssetSpec,
} from "./asset-spec.js";

const character: AssetSpec = {
    kind: "character",
    character: {
        age: "二十五岁", gender: "男", identity: "狄家少主", trueIdentity: "观音点选的降龙人",
        personality: "孝顺、克制、守信、外温内硬", appearance: "身形清瘦挺拔，藏青长衫，束发一冠，袖中百宝锦囊",
        motivation: "救母性命", conflict: "要降龙娶妻，与他从未近女色的本性相冲", catchphrase: "", role: "hero",
        arc: "从跪庙孝子到当众降龙", tags: ["孝子", "降龙人"], relationships: [{ name: "沈云", relation: "母亲" }],
        negativePrompt: "现代服装，文字，水印",
    },
};

const scene: AssetSpec = {
    kind: "scene",
    scene: { lighting: "清晨，主光从东南侧门廊斜入", landmarks: "正堂居中，门廊通前厅，东厢病榻靠窗", styleNotes: "写实电影质感，暖灰木色", negativePrompt: "人物，文字，水印" },
};

const prop: AssetSpec = {
    kind: "prop",
    prop: { material: "泥塑彩绘金身，漆面剥落", sizeNote: "高大于宽大于厚，约一人高，需立莲台", styleNotes: "冷灰底色配暖烛硬侧光", negativePrompt: "真人，手，第二件道具" },
};

test("角色提示词是三视图结构，外形和负面词都要进去", () => {
    const prompt = buildAssetImagePrompt("character", character, "陆沉");
    assert.match(prompt, /角色设定三视图｜陆沉/);
    assert.match(prompt, /正面、侧面、背面三个全身站姿/);
    assert.match(prompt, /藏青长衫/);
    assert.match(prompt, /【负面】现代服装/);
    assert.match(prompt, /面部特写/);
});

test("场景提示词强调无人空镜、机位和分层", () => {
    const prompt = buildAssetImagePrompt("scene", scene, "城南狄家");
    assert.match(prompt, /场景主图｜城南狄家/);
    assert.match(prompt, /画面里没有人/);
    assert.match(prompt, /16:9/);
    assert.match(prompt, /【光线】清晨/);
});

test("道具提示词是左侧大特写 + 右侧 2×2 四角度，尺寸写死", () => {
    const prompt = buildAssetImagePrompt("prop", prop, "观音像");
    assert.match(prompt, /道具设定图｜观音像/);
    assert.match(prompt, /2×2 四格/);
    assert.match(prompt, /约一人高/);
    assert.match(prompt, /【材质】泥塑彩绘/);
});

test("缺字段时能点名：角色必须有人物欲望与冲突，场景必须有光线", () => {
    assert.deepEqual(missingAssetSpecFields("character", { kind: "character", character: { age: "二十五", gender: "男" } }), ["公开身份", "性格", "外形", "欲望", "冲突"]);
    assert.deepEqual(missingAssetSpecFields("scene", { kind: "scene", scene: { landmarks: "正堂" } }), ["光线", "质感与风格"]);
    assert.deepEqual(missingAssetSpecFields("prop", null), ["材质", "尺寸与比例", "质感与风格"]);
});

test("每种资产绑定自己的技能段落和出图类型", () => {
    assert.match(ASSET_KIND_SKILL.character.section, /角色提示词/);
    assert.match(ASSET_KIND_SKILL.scene.section, /场景提示词/);
    assert.match(ASSET_KIND_SKILL.prop.section, /道具提示词/);
    assert.equal(ASSET_KIND_SKILL.character.imageKind, "角色设定三视图");
    for (const kind of ["character", "scene", "prop"] as const) assert.match(ASSET_KIND_SKILL[kind].path, /^\.agents\/skills\//);
});

test("摘要只留必须一致的部分，就绪提示带技能段落", () => {
    assert.match(assetSpecSummary("character", character), /藏青长衫/);
    assert.match(assetSpecSummary("scene", scene), /正堂居中/);
    assert.match(assetSpecSummary("prop", prop), /泥塑彩绘/);
    const ready = assetSpecReadiness("character", character);
    assert.equal(ready.ready, true);
    assert.match(ready.hint, /角色提示词/);
    assert.equal(assetSpecReadiness("prop", null).ready, false);
});
