import assert from "node:assert/strict";
import test from "node:test";
import { buildChapterDemandPrompt, fallbackChapterDemand, parseChapterDemand } from "./chapter-demand.js";
import { planChapterStoryboard } from "./chapter-storyboard.js";

const environments = [{ id: "env-temple", name: "破庙" }, { id: "env-street", name: "长街" }];
const characterRefs = [{ id: "CHAR-CHEN", name: "陈九" }, { id: "CHAR-HONG", name: "小红" }];
const propRefs = [{ id: "PROP-SWORD", name: "长刀" }, { id: "PROP-LANTERN", name: "灯笼" }];

test("提示词带上环境清单、JSON 结构与时长上限", () => {
    const { system, user } = buildChapterDemandPrompt({ chapterTitle: "第二章 破庙", chapterBody: "雨夜。", environments });
    assert.ok(system.includes("env-temple｜破庙"));
    assert.ok(system.includes("3–8")); // 影策节奏：让 LLM 按剧情给 3-8 秒时长提示（动作短/情绪长）
    assert.ok(system.includes("情绪戏"));
    assert.ok(system.includes("【镜头 N】"));
    assert.ok(user.includes("第二章 破庙"));
    assert.ok(user.includes("雨夜。"));
});

test("拆镜提示词把原文叙述句标为 speaker=旁白（对齐影策 prompts.go）", () => {
    const { system } = buildChapterDemandPrompt({ chapterTitle: "第三章", chapterBody: "雨夜。", environments });
    assert.match(system, /旁白/, "拆镜提示词必须提到旁白");
    assert.match(system, /逐字摘.*原文叙述|逐字.*旁白|speaker.*旁白/, "必须要求 model 把原文叙述句逐字摘成 speaker=旁白");
    assert.match(system, /不要自己写旁白|不要编造旁白/, "必须禁止 model 自编旁白");
});

test("解析容忍 ```json 围栏与前后闲聊", () => {
    const reply = [
        "好的，这是分镜草案：",
        "```json",
        JSON.stringify({
            demand: "【场景：破庙】【时间：夜】\n【镜头 1】\n推门。",
            scenes: [{ sceneKey: "temple", environmentId: "env-temple", beats: [{ title: "推门", visual: "推门。", seconds: 2, dialogue: "有人么？", speaker: "陈九" }] }],
        }),
        "```",
        "以上。",
    ].join("\n");
    const draft = parseChapterDemand(reply, { environments });
    assert.equal(draft.scenes.length, 1);
    assert.equal(draft.scenes[0].environmentId, "env-temple");
    assert.equal(draft.scenes[0].beats[0].dialogue, "有人么？");
    assert.ok(draft.demand.includes("【镜头 1】"));
});

test("模型瞎编 environmentId 时直接拒绝", () => {
    const reply = JSON.stringify({ demand: "【场景：X】", scenes: [{ sceneKey: "x", environmentId: "env-made-up", beats: [{ title: "一", visual: "画面" }] }] });
    assert.throws(() => parseChapterDemand(reply, { environments }), /CHAPTER_DEMAND_ENVIRONMENT/);
});

test("缺场次/缺画面/缺 demand 分别给出报错码", () => {
    assert.throws(() => parseChapterDemand(JSON.stringify({ demand: "x", scenes: [] })), /CHAPTER_DEMAND_SCENES/);
    assert.throws(() => parseChapterDemand(JSON.stringify({ scenes: [] })), /CHAPTER_DEMAND_EMPTY/);
    assert.throws(() => parseChapterDemand(JSON.stringify({ demand: "x", scenes: [{ environmentId: "env-temple", beats: [{ title: "空" }] }] }), { environments }), /CHAPTER_DEMAND_BEATS/);
    assert.throws(() => parseChapterDemand("没有 JSON"), /CHAPTER_DEMAND_JSON/);
});

test("兜底把原文按段落搬成镜头占位，且 demand 带齐标记", () => {
    const body = Array.from({ length: 5 }, (_, index) => `第${index + 1}段正文，${"雨".repeat(80)}`).join("\n\n");
    const draft = fallbackChapterDemand({ chapterTitle: "第二章", chapterBody: body, environmentId: "env-temple", sceneName: "破庙" });
    assert.ok(draft.scenes[0].beats.length >= 5);
    assert.ok(draft.demand.startsWith("【场景：破庙】"));
    assert.equal((draft.demand.match(/【镜头 \d+】/g) || []).length, draft.scenes[0].beats.length);
    const plan = planChapterStoryboard({ chapterId: "EP-1", scenes: draft.scenes });
    assert.ok(plan.shots.length >= 5);
    assert.ok(plan.segments.length >= 1);
});

test("兜底拒绝空正文与空环境", () => {
    assert.throws(() => fallbackChapterDemand({ chapterTitle: "t", chapterBody: "  ", environmentId: "env-temple" }), /CHAPTER_DEMAND_BEATS/);
    assert.throws(() => fallbackChapterDemand({ chapterTitle: "t", chapterBody: "有字", environmentId: "" }), /CHAPTER_DEMAND_ENVIRONMENT/);
});

test("提示词含角色/道具/场景三段清单、schema 新字段与禁编造规则", () => {
    const { system } = buildChapterDemandPrompt({
        chapterTitle: "第二章", chapterBody: "雨夜。", environments, characterRefs, propRefs,
    });
    // 三段「id｜名称」清单
    assert.ok(system.includes("CHAR-CHEN｜陈九"));
    assert.ok(system.includes("PROP-SWORD｜长刀"));
    assert.ok(system.includes("env-temple｜破庙"));
    assert.ok(system.includes("角色清单："));
    assert.ok(system.includes("道具清单："));
    assert.ok(system.includes("场景清单："));
    // schema 每 beat 带三个引用字段
    assert.ok(system.includes('"character_ids":["角色ID数组"]'));
    assert.ok(system.includes('"prop_ids":["道具ID数组"]'));
    assert.ok(system.includes('"scene_id":"场景ID或空串"'));
    // 硬性要求：逐字复制 / 不得新编 / 空数组 / 按出场顺序去重
    assert.ok(system.includes("逐字复制"));
    assert.ok(system.includes("不得新编"));
    assert.ok(system.includes("按出场顺序去重"));
});

test("注册表为空时提示词带空清单说明，不编造引用", () => {
    const { system } = buildChapterDemandPrompt({ chapterTitle: "t", chapterBody: "雨夜。", environments });
    assert.ok(system.includes("本集还没有登记角色"));
    assert.ok(system.includes("本集还没有登记道具"));
});

test("解析：白名单过滤 + 保序去重 + 非法 id 丢弃", () => {
    const reply = JSON.stringify({
        demand: "【场景：破庙】",
        scenes: [{ sceneKey: "temple", environmentId: "env-temple", beats: [{
            title: "一", visual: "陈九推门。", seconds: 3,
            character_ids: ["CHAR-HONG", "CHAR-CHEN", "CHAR-HONG", "CHAR-FAKE"],
            prop_ids: ["PROP-SWORD", "PROP-SWORD", "PROP-FAKE"],
            scene_id: "env-temple",
        }, {
            title: "二", visual: "雨停。", seconds: 3,
            character_ids: ["CHAR-FAKE"], prop_ids: [], scene_id: "env-FAKE",
        }] }],
    });
    const draft = parseChapterDemand(reply, {
        environments,
        allowedCharacterIds: new Set(characterRefs.map(ref => ref.id)),
        allowedPropIds: new Set(propRefs.map(ref => ref.id)),
        allowedSceneIds: new Set(environments.map(env => env.id)),
    });
    const [first, second] = draft.scenes[0].beats;
    // 非法 id 丢弃、合法项保序、重复项只留第一次
    assert.deepEqual(first.characterIds, ["CHAR-HONG", "CHAR-CHEN"]);
    assert.deepEqual(first.propIds, ["PROP-SWORD"]);
    assert.equal(first.sceneId, "env-temple");
    assert.deepEqual(second.characterIds, []);
    assert.deepEqual(second.propIds, []);
    assert.equal(second.sceneId, "", "非法 scene_id 被清空");
});

test("解析：未提供白名单时兼容老调用方（不过滤但保序去重）", () => {
    const reply = JSON.stringify({
        demand: "【场景：X】",
        scenes: [{ sceneKey: "x", beats: [{ visual: "画面", character_ids: ["A", "A", "B"], prop_ids: ["P", "P"], scene_id: "S" }] }],
    });
    const beat = parseChapterDemand(reply).scenes[0].beats[0];
    assert.deepEqual(beat.characterIds, ["A", "B"]);
    assert.deepEqual(beat.propIds, ["P"]);
    assert.equal(beat.sceneId, "S");
});

test("兜底输出空角色/道具引用，sceneId=environmentId", () => {
    const draft = fallbackChapterDemand({ chapterTitle: "第二章", chapterBody: "雨夜。", environmentId: "env-temple", sceneName: "破庙" });
    for (const beat of draft.scenes[0].beats) {
        assert.deepEqual(beat.characterIds, []);
        assert.deepEqual(beat.propIds, []);
        assert.equal(beat.sceneId, "env-temple");
    }
});
