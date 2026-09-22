import assert from "node:assert/strict";
import test from "node:test";

import { writeStoryboardPrompt } from "./storyboard-write.js";
import { buildStoryboardPromptSections } from "../../../../plugins/canvas/minimax-h3/src/services/storyboard-prompt.js";

test("h3_write_storyboard_prompt 将旧版分镜引用占位符归一化为 Picture 标签", () => {
    const binding = {
        id: "ep01-s01-03",
        assetId: "asset-storyboard-3",
        label: "分镜图 3",
        role: "storyboard",
        tags: ["character-group", "character_turnaround"],
        enabled: true,
        usage: "reference",
        mediaType: "image",
        url: "https://example.test/storyboard-3.png",
    };
    const segment = {
        id: "segment-1",
        mode: "ref2va",
        prompt: [
            "旧版自由文本，不应继续保留。",
            "主体定义：旧版中文主体定义。",
            "",
            "subject_definitions:",
            "",
            "summary:",
            "",
            "retention_analysis:",
            "",
            "detailed_description:",
            "旧内容",
            "",
            "overall_soundscape:",
            "",
            "non_diegetic_music:",
            "N/A",
        ].join("\n"),
        referenceBindings: [binding],
    };
    const generated = writeStoryboardPrompt({
        referenceCatalog: [{
            id: binding.assetId,
            label: binding.label,
            mediaType: "image",
            role: "storyboard",
            tags: [],
            url: binding.url,
        }],
    }, segment, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "主体继续向前走，并参考 {{ref:ep01-s01-03}}。", pictureBindingId: binding.id }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    });

    assert.equal(generated.prompt.includes("{{ref:"), false);
    assert.equal(generated.prompt.startsWith("subject_definitions:"), true);
    assert.equal(generated.prompt.includes("主体定义："), false);
    assert.match(generated.prompt, /detailed_description:\n\[Shot 1\].*<Picture 1>/s);
    assert.doesNotMatch(generated.prompt, /character-group|character_turnaround/);
});

test("h3_write_storyboard_prompt 只写入服装描述而不写服装名称", () => {
    const binding = {
        id: "character-outfit-binding",
        assetId: "asset-outfit",
        label: "夜行服参考",
        role: "character_identity",
        tags: [],
        enabled: true,
        usage: "reference",
        mediaType: "image",
        url: "https://example.test/outfit.png",
        sourceNodeId: "character-1",
        subjectId: "subject-1",
        groupId: "group-1",
        outfitId: "outfit-1",
    };
    const segment = {
        id: "segment-1",
        mode: "ref2va",
        prompt: "detailed_description:\n旧内容\n\noverall_soundscape:\n\nnon_diegetic_music:\nN/A",
        referenceBindings: [binding],
        h3CharacterGroups: {
            "group-1": {
                id: "group-1",
                characterNodeId: "character-1",
                subjectId: "subject-1",
                characterName: "沈昭宁",
                outfits: [{ id: "outfit-1", name: "夜行服", enabled: true }, { id: "outfit-2", name: "礼服", enabled: true }],
            },
        },
    };
    const generated = writeStoryboardPrompt({
        nodes: [{
            id: "character-1",
            type: "character",
            metadata: {
                characterDescription: "年轻女性，黑色长发。; character-group, character_turnaround;",
                characterImages: [{ outfit: "夜行服", outfitDescription: "深蓝长风衣，银色扣子。" }, { outfit: "礼服", outfitDescription: "暗绛红礼服，金冠" }],
            },
        }],
    }, segment, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "<Subject 1> 走过街角。" }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    });

    assert.match(generated.prompt, /深蓝长风衣，银色扣子/);
    assert.equal(generated.prompt.includes("夜行服"), false);
    assert.doesNotMatch(generated.prompt, /暗绛红|character-group|character_turnaround|。\./);
    const browser = buildStoryboardPromptSections(generated.content.subjects, generated.content.references, generated.content.shots);
    assert.equal(browser.subjectDefinitions, generated.subjectDefinitions);
    assert.equal(browser.retentionAnalysis, generated.retentionAnalysis);
});

test("MCP 编译拒绝失效引用和非法时间，合法输入只生成一次切镜", () => {
    const segment = { mode: "ref2va", duration: 10 };
    const input = { openingDescription: "Winter daylight.", shots: [{ description: "Snow falls." }, { switchTime: "0:05", description: 'The shot hard-cuts to the folded document. <d>[Chinese] 不要。</d>' }], overallSoundscape: "Wind.", nonDiegeticMusic: "N/A" };
    const result = writeStoryboardPrompt({}, segment, input);
    assert.match(result.prompt, /\[Shot 2\] At 00:05.000, the shot hard-cuts\. the folded document\./);
    assert.equal((result.prompt.match(/hard-cuts/gu) || []).length, 1);
    assert.match(result.prompt, /<d>\[Chinese\] 不要。<\/d>/u);
    assert.throws(() => writeStoryboardPrompt({}, segment, { ...input, shots: [{ description: "<Picture 1>" }] }), /引用/u);
    assert.throws(() => writeStoryboardPrompt({}, segment, { ...input, shots: [{ description: "Snow." }, { ...input.shots[1], switchTime: "10" }] }), /Clip 时长/u);
    assert.throws(() => writeStoryboardPrompt({}, segment, { ...input, shots: [{ description: "Snow." }, { ...input.shots[1], switchTime: "bad" }] }), /切换时间无效/u);
});
