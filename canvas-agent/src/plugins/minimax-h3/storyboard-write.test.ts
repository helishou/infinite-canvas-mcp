import assert from "node:assert/strict";
import test from "node:test";

import { writeStoryboardPrompt } from "./storyboard-write.js";
import { compileReferenceSubmission } from "../../canvas/reference-contract.js";
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
    assert.match(generated.prompt, /detailed_description:[\s\S]*\[Shot 1\].*<Picture 1>/s);
    assert.doesNotMatch(generated.prompt, /character-group|character_turnaround/);
});

test("MCP 按逐镜绑定顺序排列分镜图，并让 Picture 标签仍指向原图", () => {
    const frame = (number: number) => ({ id: `frame-${number}`, assetId: `asset-${number}`, label: `分镜图 ${number}`, role: "storyboard", enabled: true, usage: "reference", mediaType: "image", url: `https://example.test/${number}.png` });
    const identity = { id: "identity", assetId: "identity-asset", label: "人物身份", role: "character_identity", enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/identity.png" };
    const generated = writeStoryboardPrompt({}, {
        id: "segment-ordered", mode: "ref2va", duration: 6,
        referenceBindings: [frame(3), identity, frame(1), frame(2)],
        storyboardShots: [
            { id: "shot-3", referenceBindingId: "frame-3", duration: 2 },
            { id: "shot-1", referenceBindingId: "frame-1", duration: 2 },
            { id: "shot-2", referenceBindingId: "frame-2", duration: 2 },
        ],
    }, {
        openingDescription: "Opening uses <Picture 1>.",
        shots: [
            { description: "First frame.", pictureBindingId: "frame-1" },
            { switchTime: "2", description: "Second frame.", pictureBindingId: "frame-2" },
            { switchTime: "4", description: "Third frame.", pictureBindingId: "frame-3" },
        ],
        overallSoundscape: "", nonDiegeticMusic: "N/A",
    });
    assert.deepEqual(generated.referenceBindings?.map((binding) => binding.id), ["frame-1", "identity", "frame-2", "frame-3"]);
    assert.deepEqual(generated.storyboardShots?.map((shot) => shot.id), ["shot-1", "shot-2", "shot-3"]);
    assert.match(generated.prompt, /Opening uses <Picture 4>/u);
    assert.match(generated.prompt, /\[Shot 1\][^\n]*<Picture 1>/u);
    assert.match(generated.prompt, /\[Shot 2\][^\n]*<Picture 3>/u);
    assert.match(generated.prompt, /\[Shot 3\][^\n]*<Picture 4>/u);
    const submitted = compileReferenceSubmission({}, { taskMode: "ref2va", prompt: generated.prompt, referenceBindings: generated.referenceBindings });
    assert.deepEqual(submitted.references.filter((reference) => reference.mediaType === "image").map((reference) => [reference.token, reference.id]), [
        ["<Picture 1>", "frame-1"], ["<Picture 2>", "identity"], ["<Picture 3>", "frame-2"], ["<Picture 4>", "frame-3"],
    ]);
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

test("关闭服装后旧实体清单里的失效图片来源不会让编译报错", () => {
    const voiceBinding = {
        id: "voice-binding",
        assetId: "asset-voice",
        label: "沈侯·原声参考",
        role: "character_voice",
        tags: [],
        enabled: true,
        usage: "reference",
        mediaType: "audio",
        url: "https://example.test/voice.wav",
        sourceNodeId: "character-shen",
        subjectId: "shenhou",
        groupId: "group-shen",
    };
    const segment = {
        id: "segment-stale-source",
        mode: "ref2va",
        prompt: "detailed_description:\n旧内容\n\noverall_soundscape:\n\nnon_diegetic_music:\nN/A",
        referenceBindings: [voiceBinding],
        // 关掉服装前保存的实体清单：<Picture 2> 是沈侯的服装四视图，现在已不在素材里。
        subjectDefinitions: [
            { id: "shenhou", name: "沈侯", profile: "侯爵", pictures: ["<Picture 2>"], outfits: [], role: "character_identity" },
        ],
        h3CharacterGroups: {
            "group-shen": {
                id: "group-shen",
                characterNodeId: "character-shen",
                subjectId: "shenhou",
                characterName: "沈侯",
                outfits: [],
                outfitEnabled: false,
                voiceEnabled: true,
            },
        },
    };
    const generated = writeStoryboardPrompt({
        nodes: [{ id: "character-shen", type: "character", metadata: { characterDescription: "年约四十九岁的侯爵。" } }],
    }, segment, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "沈侯用 <Audio 1> 的音色开口说话。" }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    });

    assert.match(generated.prompt, /<Subject 1> is 沈侯/);
    assert.doesNotMatch(generated.prompt, /<Picture 2>/);
});

test("只有声线没有服装图的角色也进入主体定义与保留分析", () => {
    const voiceBinding = {
        id: "voice-binding",
        assetId: "asset-voice",
        label: "沈侯·原声参考",
        role: "character_voice",
        tags: [],
        enabled: true,
        usage: "reference",
        mediaType: "audio",
        url: "https://example.test/voice.wav",
        sourceNodeId: "character-shen",
        subjectId: "shenhou",
        groupId: "group-shen",
    };
    const segment = {
        id: "segment-voice-only",
        mode: "ref2va",
        prompt: "detailed_description:\n旧内容\n\noverall_soundscape:\n\nnon_diegetic_music:\nN/A",
        referenceBindings: [voiceBinding],
        h3CharacterGroups: {
            "group-shen": {
                id: "group-shen",
                characterNodeId: "character-shen",
                subjectId: "shenhou",
                characterName: "沈侯",
                outfits: [],
                outfitEnabled: false,
                voiceEnabled: true,
            },
        },
    };
    const generated = writeStoryboardPrompt({
        nodes: [{ id: "character-shen", type: "character", metadata: { characterDescription: "年约四十九岁的侯爵。" } }],
    }, segment, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "沈侯用 <Audio 1> 的音色开口说话。" }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    });

    assert.match(generated.prompt, /<Subject 1> is 沈侯/);
    assert.match(generated.prompt, /<Subject 1> \(appears in \[Shot 1\]\)/);
});

test("站位图独立定义和结算空间关系，不充当人物身份图", () => {
    const identity = { id: "identity-1", assetId: "asset-identity", label: "人物身份图", role: "character_identity", enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/identity.png", subjectId: "hero" };
    const blocking = { id: "blocking-1", assetId: "asset-blocking", label: "雪院站位图", role: "blocking", enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/blocking.png" };
    const generated = writeStoryboardPrompt({}, {
        id: "segment-1",
        mode: "ref2va",
        duration: 5,
        referenceBindings: [identity, blocking],
    }, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "人物沿雪院动作轴走向门口。" }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    });

    assert.match(generated.subjectDefinitions, /^<Picture 2> is the blocking and 180-degree action-axis map for the target shot sequence/mu);
    assert.match(generated.retentionAnalysis, /^<Picture 2> \(target shot sequence\): fully_preserved - preserve the defined relative positions/mu);
    assert.doesNotMatch(generated.subjectDefinitions, /<Subject \d+> is Blocking/u);
    assert.doesNotMatch(generated.subjectDefinitions, /visual identity defined by reference\(s\) <Picture 2>/u);
    const browser = buildStoryboardPromptSections(generated.content.subjects, generated.content.references, generated.content.shots);
    assert.equal(browser.subjectDefinitions, generated.subjectDefinitions);
    assert.equal(browser.retentionAnalysis, generated.retentionAnalysis);

    const savedSubjectPictures = generated.content.subjects.map((subject) => ({ ...subject, pictures: [...subject.pictures, "<Picture 2>"] }));
    const withSavedDefinitions = buildStoryboardPromptSections(savedSubjectPictures, generated.content.references, generated.content.shots);
    assert.match(withSavedDefinitions.subjectDefinitions, /spatial blocking guided by <Picture 2>/u);
    assert.doesNotMatch(withSavedDefinitions.subjectDefinitions, /visual identity defined by reference\(s\) <Picture 2>/u);
    const mapOnlyShot = buildStoryboardPromptSections(savedSubjectPictures, generated.content.references, [{ description: "镜头只引用 <Picture 2> 的站位规划。" }]);
    assert.match(mapOnlyShot.retentionAnalysis, /<Subject 1> \(no shot appearance is explicitly assigned\)/u);
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

test("分镜帧不污染 Subject 身份，摘要和持续时长从分镜轨道统一生成", () => {
    const storyboardA = { id: "storyboard-a", assetId: "asset-storyboard-a", label: "分镜图 A", role: "storyboard", enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/a.png", subjectId: "subject-1" };
    const storyboardB = { id: "storyboard-b", assetId: "asset-storyboard-b", label: "分镜图 B", role: "storyboard", enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/b.png", subjectId: "subject-1" };
    const identity = { id: "identity-1", assetId: "asset-identity-1", label: "人物身份", role: "character_identity", enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/identity.png", subjectId: "subject-1" };
    const voice = { id: "voice-1", assetId: "asset-voice-1", label: "人物声音", role: "character_voice", enabled: true, usage: "reference", mediaType: "audio", url: "https://example.test/voice.wav", subjectId: "subject-1" };
    const generated = writeStoryboardPrompt({
        nodes: [{ id: "character-1", type: "character", metadata: { characterName: "谢临渊", characterDescription: "年轻男子，黑发。" } }],
    }, {
        id: "segment-1",
        mode: "ref2va",
        duration: 7.5,
        referenceBindings: [storyboardA, storyboardB, identity, voice],
        h3CharacterGroups: { "group-1": { id: "group-1", characterNodeId: "character-1", subjectId: "subject-1", characterName: "谢临渊", outfits: [] } },
    }, {
        summary: "一段连续动作。",
        openingDescription: "The axis is locked.",
        shots: [
            { description: "谢临渊站在门前。", pictureBindingId: storyboardA.id },
            { switchTime: "5", description: "谢临渊抬头。", pictureBindingId: storyboardB.id },
        ],
        overallSoundscape: "Wind.",
        nonDiegeticMusic: "N/A",
    });

    assert.match(generated.prompt, /\[keyframe completion \+ reference generation \+ audio reference\]/u);
    assert.match(generated.prompt, /<Subject 1> is 谢临渊\./u);
    assert.doesNotMatch(generated.prompt, /<Subject 1> is[\s\S]*visual identity defined by reference\(s\) <Picture 1>/u);
    assert.match(generated.prompt, /Storyboard images establish shot-entry keyframes, not frozen poses/u);
    assert.match(generated.prompt, /can perform naturally while the camera remains stable/u);
    assert.deepEqual(generated.storyboardDurations, { "storyboard-a": 5, "storyboard-b": 2.5 });
});

test("分镜图摘要只是素材名回显时不写进提示词", () => {
    const binding = {
        id: "binding-slot-2",
        assetId: "asset-ep01-s0102-group-slot2-anchor",
        label: "S01-02·沈侯持婚书单人对峙·新版分镜组第2槽",
        role: "storyboard",
        tags: ["EP01", "S01-02", "hard-composition-anchor"],
        enabled: true,
        usage: "reference",
        mediaType: "image",
        url: "https://example.test/slot2.png",
    };
    const generated = writeStoryboardPrompt({
        referenceCatalog: [{
            id: binding.assetId,
            label: binding.label,
            mediaType: "image",
            role: "storyboard",
            tags: binding.tags,
            url: binding.url,
            analysis: { summary: binding.label, model: "MCP caller" },
        }],
    }, {
        id: "segment-1",
        mode: "ref2va",
        duration: 5,
        referenceBindings: [binding],
    }, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "沈侯站在雪院中。", pictureBindingId: binding.id }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    });

    assert.doesNotMatch(generated.prompt, /组第2槽/u);
    assert.doesNotMatch(generated.prompt, /沈侯持婚书单人对峙/u);
    assert.match(generated.prompt, /Use the approved storyboard frame from <Picture 1>/u);
});

test("重新编译时剥掉正文里残留的分镜图 cue，不重复叠加", () => {
    const binding = { id: "storyboard-a", assetId: "asset-storyboard-a", label: "分镜图 A", role: "storyboard", tags: [], enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/a.png" };
    const generated = writeStoryboardPrompt({
        referenceCatalog: [{ id: binding.assetId, label: binding.label, mediaType: "image", role: "storyboard", tags: [], url: binding.url }],
    }, {
        id: "segment-1",
        mode: "ref2va",
        duration: 5,
        referenceBindings: [binding],
    }, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "Use the approved 分镜图 A from <Picture 1> as the target composition reference for this shot. Use the approved 分镜图 A from <Picture 1> as the shot-entry keyframe and composition anchor for this shot. After the keyframe, keep the camera setup and spatial relationship stable while allowing natural performance. 沈侯站在雪院中。", pictureBindingId: binding.id }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    });

    assert.equal((generated.prompt.match(/Use the approved/gu) || []).length, 1);
    assert.match(generated.prompt, /\[Shot 1\] Use the approved storyboard frame from <Picture 1> as the shot-entry keyframe and composition anchor for this shot\.[\s\S]*沈侯站在雪院中。/u);
});

test("拒绝不完整的分镜图引用句，避免生成 to the approved 残句", () => {
    assert.throws(() => writeStoryboardPrompt({}, { mode: "ref2va", duration: 5 }, {
        summary: "",
        openingDescription: "",
        shots: [{ description: "Use the approved storyboard frame from <Picture 1> as the visual anchor for this shot. to the next pose." }],
        overallSoundscape: "",
        nonDiegeticMusic: "N/A",
    }), /malformed reference instruction/u);
});
