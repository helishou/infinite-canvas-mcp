/**
 * 分镜可拍性字段的行为测试。
 *
 * 背景：ep1/ep2 的分镜只有一句「视觉」描述（平均 32 字），机位理由是把运镜词复制一遍，
 * 整集景别靠正则兜底成中景。根因是生成契约里根本没有 imagePrompt / videoPrompt / shotSize
 * 这些字段，模型无从输出。这里把补齐后的行为钉住。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildShotCamera, framingOfShotSize, inferFraming, planChapterStoryboard, toSceneStoryboardOps } from "./chapter-storyboard.js";
import { buildChapterDemandPrompt, parseChapterDemand } from "./chapter-demand.js";

test("shotSize 明确给出时按它定景别，不再靠运镜词猜", () => {
    assert.equal(framingOfShotSize("特写"), "CU");
    assert.equal(framingOfShotSize("近景"), "MCU");
    assert.equal(framingOfShotSize("中景"), "MS");
    assert.equal(framingOfShotSize("全景"), "WS");
    assert.equal(framingOfShotSize("远景"), "WS");
    assert.equal(framingOfShotSize("大远景"), "EWS");
    assert.equal(framingOfShotSize("全身"), "FS");
    assert.equal(framingOfShotSize(""), undefined);
});

test("shotSize 优先于运镜词：模型说全景、运镜写跟拍，景别应为全景", () => {
    const camera = buildShotCamera({ camera: "跟拍", visual: "崇良走进城门", shotSize: "全景" });
    assert.equal(camera.framing, "WS");
    assert.equal(camera.description, "跟拍");
});

test("editorial_reason 不再复制运镜词：给了真实依据就用它", () => {
    const camera = buildShotCamera({ camera: "中景跟拍", visual: "崇良揭下告示", rationale: "揭榜是全集的起点，要让观众看清他的决心" });
    assert.equal(camera.editorial_reason, "揭榜是全集的起点，要让观众看清他的决心");
    assert.notEqual(camera.editorial_reason, camera.description);
});

test("没有运镜时 description 退到画面描述首句，而不是空的固定机位", () => {
    const camera = buildShotCamera({ visual: "夜里红灯将尽。蟒妻蹲坐添酒。" });
    assert.equal(camera.description, "夜里红灯将尽");
});

test("解析回包时透传 shotSize / action / imagePrompt / videoPrompt / sourceQuote", () => {
    const payload = JSON.stringify({
        demand: "【场景：城门】\n【时间：日】\n【镜头 1】\n崇良揭榜",
        scenes: [{
            sceneKey: "town", sceneName: "城门", environmentId: "env-town",
            beats: [{
                title: "揭榜", visual: "崇良拨开人群走到告示墙前，抬手把黄纸揭下", seconds: 5,
                shotSize: "中景", camera: "跟拍",
                action: "拨开人群、揭榜、转身",
                imagePrompt: "崇良正面偏左站位，右手抬起捏住告示下缘，人群在其身后虚化，正午顶光",
                videoPrompt: "0-2 秒拨开人群，2-4 秒揭榜，4-5 秒转身朝山方向",
                sourceQuote: "崇良一把揭下悬赏告示",
            }],
        }],
    });
    const draft = parseChapterDemand(payload, { environments: [{ id: "env-town", name: "城门" }] });
    const beat = draft.scenes[0].beats[0];
    assert.equal(beat.shotSize, "中景");
    assert.equal(beat.action, "拨开人群、揭榜、转身");
    assert.ok(String(beat.imagePrompt).includes("顶光"));
    assert.ok(String(beat.videoPrompt).includes("0-2 秒"));
    assert.equal(beat.sourceQuote, "崇良一把揭下悬赏告示");
});

test("新字段缺失时不报错，仍能解析（老回包兼容）", () => {
    const payload = JSON.stringify({
        demand: "【场景：城门】\n【镜头 1】\n崇良揭榜",
        scenes: [{ sceneKey: "s", environmentId: "env-town", beats: [{ title: "a", visual: "崇良揭榜", seconds: 4 }] }],
    });
    const draft = parseChapterDemand(payload, { environments: [{ id: "env-town", name: "城门" }] });
    assert.equal(draft.scenes[0].beats[0].shotSize, undefined);
});

test("提示词要求模型输出可拍字段与风格规则", () => {
    const prompt = buildChapterDemandPrompt({
        chapterTitle: "第一章",
        chapterBody: "崇良揭榜除害。",
        environments: [{ id: "env-town", name: "城门" }],
        stylePrompt: "写实电影感，低饱和",
        visualRules: "夜戏只用火光与月光，禁止霓虹",
        hook: "悬赏告示被风吹起一角",
        cliffhanger: "妻子笑意里闪过一丝异样",
    });
    const text = prompt.system;
    assert.ok(text.includes("imagePrompt"), "提示词必须要求起幅画面");
    assert.ok(text.includes("videoPrompt"), "提示词必须要求镜内运动");
    assert.ok(text.includes("shotSize"), "提示词必须要求景别");
    assert.ok(text.includes("写实电影感"), "视觉风格必须注入");
    assert.ok(text.includes("禁止霓虹"), "画面规则必须注入");
    assert.ok(text.includes("悬赏告示被风吹起一角"), "开场钩子必须注入");
    assert.ok(text.includes("妻子笑意里闪过一丝异样"), "结尾悬念必须注入");
});

test("镜头缺可拍字段时进 diagnostics，而不是静默降级", () => {
    const plan = planChapterStoryboard({
        chapterId: "ep",
        scenes: [{ sceneKey: "s", environmentId: "env", beats: [{ title: "揭榜", visual: "崇良揭榜", seconds: 4 }] }],
    });
    const joined = plan.diagnostics.join("\n");
    assert.ok(joined.includes("缺少起幅画面"));
    assert.ok(joined.includes("缺少镜内运动描述"));
    assert.ok(joined.includes("未给景别"));
    assert.ok(joined.includes("画面描述只有"));
});

test("字段齐全时不产生可拍性诊断", () => {
    const plan = planChapterStoryboard({
        chapterId: "ep",
        scenes: [{
            sceneKey: "s", environmentId: "env",
            beats: [{
                title: "揭榜",
                visual: "崇良拨开围观人群走到木板告示墙前，右手抬起捏住黄纸下缘，肩头铁鞭晃了一下，正午顶光把影子压在他脚边",
                seconds: 5,
                shotSize: "中景",
                action: "拨开人群、揭榜、转身",
                imagePrompt: "崇良正面偏左站位，右手捏住告示下缘，人群在身后虚化，正午顶光",
                videoPrompt: "0-2 秒拨开人群，2-4 秒揭榜，4-5 秒转身",
            }],
        }],
    });
    const joined = plan.diagnostics.join("\n");
    assert.ok(!joined.includes("缺少起幅画面"));
    assert.ok(!joined.includes("未给景别"));
    assert.equal(plan.shots[0].camera.framing, "MS");
});

test("新字段写进 replace_director_scene_storyboard 的 shot 行", () => {
    const plan = planChapterStoryboard({
        chapterId: "ep",
        scenes: [{
            sceneKey: "s", environmentId: "env",
            beats: [{
                title: "t", visual: "崇良拨开人群走到告示墙前，抬手把黄纸揭下，肩头铁鞭晃了一下，正午顶光", seconds: 5,
                shotSize: "中景", action: "揭榜", imagePrompt: "起幅构图", videoPrompt: "0-2 秒揭榜", sourceQuote: "一把揭下",
            }],
        }],
    });
    const ops = toSceneStoryboardOps(plan, new Map([["env", "scene-1"]]));
    const shot = (ops[0].shots as Array<Record<string, unknown>>)[0];
    assert.equal(shot.action, "揭榜");
    assert.equal(shot.imagePrompt, "起幅构图");
    assert.equal(shot.videoPrompt, "0-2 秒揭榜");
    assert.equal(shot.sourceQuote, "一把揭下");
});
