import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { resolveChapterText } from "../maintenance/backfill-shot-dialogues.js";
import { DramaPipeline } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";
import {
    backfillShots,
    dialogueKey,
    missingDialogue,
    quotedSourceLines,
    splitChapters,
    type ShotLike,
    type UtteranceLike,
} from "./shot-dialogue-backfill.js";

const CHAPTER3 = `第 3 章 卷中之谜

沈砚把那封信托在袖中，反复琢磨“真相在卷中”这五个字。他忽然想起，柳文卿死时怀里死死揣着的正是自己的会试卷。难道答案就在那卷文章里？

他重新展开那卷墨卷，逐字逐句地读。文章表面讲的是治国安民，可当他读到第三段时，目光停住了。那一段里有八个字的对仗，看似寻常，可若将每句的首字连起来读，竟是一句隐语：“周郎害我，谨防寒波。”

“周郎……寒波……”沈砚喃喃自语。寒波寺，正是柳文卿陈尸之处。周郎又是谁？

他猛地想起赵孟坚提到的那个“周举子”。可掌柜说从无此人，这说明周举子要么是化名，要么根本就不存在——是有人故意放出的烟幕。沈砚重新审视赵孟坚的证词，越想越觉得此人居心叵测。

他连夜提审赵孟坚。起初赵孟坚矢口否认，直到沈砚念出那句隐语，他的脸色才骤然变了。原来，今科会试的主考官之一，正是赵孟坚的叔父。二人舞弊，将柳文卿的卷子掉包，又把真正的会元卷据为己有。柳文卿察觉真相，写下隐语藏于卷中，却被赵孟坚先行发现。

“寒波寺那晚，是我把他骗去的。”赵孟坚瘫坐在地，泪如雨下，“我本只想吓他退让，谁知失手……”

真相大白。沈砚望着窗外初晴的雪色，长长舒了一口气。一桩会因贪念而起的命案，终究没能瞒过那卷藏在尸身怀里的文章。他提笔写下判词，心中却久久不能平静：读书人本该以文章立身，为何偏偏有人，把聪明用在了歪路上。`;

const VISUALS = [
    "场1｜内景·开封府书房｜夜｜沈砚｜沈砚反复琢磨“真相在卷中”，因想起柳文卿死时怀揣会试卷而决定重查墨卷。",
    "场2｜内景·开封府书房｜夜｜沈砚｜沈砚逐字细读柳文卿的会试墨卷，从第三段对仗首字中读出“周郎害我，谨防寒波”的隐语。",
    "场3｜内景·开封府书房｜夜｜沈砚｜沈砚联想到寒波寺与赵孟坚所言的周举子，断定周举子是烟幕而将疑心锁定赵孟坚。",
    "场4｜内景·开封府大牢｜夜｜沈砚、赵孟坚｜沈砚连夜提审矢口否认的赵孟坚，因念出卷中隐语而令其神色骤变。",
    "场5｜内景·开封府大牢｜夜｜沈砚、赵孟坚｜赵孟坚崩溃供出叔父舞弊掉包试卷、自己骗柳文卿至寒波寺失手害命的真相。",
    "场6｜内景·开封府书房｜日｜沈砚｜雪霁天晴，沈砚提笔写下判词，却因读书人以聪明行歪路而久久难平。",
];
const SHOTS: ShotLike[] = VISUALS.map((visual, i) => ({ id: `shot-${i}`, visual }));

test("splitChapters 拆出第 3 章正文", () => {
    const source = "第 1 章 雪夜沉尸\n\n甲。\n\n第 2 章 会元疑云\n\n乙。\n\n" + CHAPTER3;
    const chapters = splitChapters(source);
    assert.deepEqual(chapters.map(c => c.no), [1, 2, 3]);
    assert.equal(chapters[2].title, "第 3 章 卷中之谜");
    assert.ok(chapters[2].body.includes("周郎害我，谨防寒波"));
});

test("quotedSourceLines 提取原文 6 句引号台词", () => {
    const lines = quotedSourceLines(CHAPTER3);
    assert.equal(lines.length, 6, JSON.stringify(lines));
    assert.deepEqual(lines, [
        "真相在卷中",
        "周郎害我，谨防寒波。",
        "周郎……寒波……",
        "周举子",
        "寒波寺那晚，是我把他骗去的。",
        "我本只想吓他退让，谁知失手……",
    ]);
});

test("回填映射：前2句→镜头1/2，周郎寒波与周举子→镜头3，后2句→镜头5", () => {
    const result = backfillShots({
        chapterText: CHAPTER3,
        shots: SHOTS,
        characterRegistryNames: ["沈砚", "赵孟坚"],
    });
    assert.equal(result.added, 6, `assignments=${JSON.stringify(result.assignments)}`);
    const byText = new Map(result.assignments.map(a => [a.text, a]));
    assert.equal(byText.get("真相在卷中")?.shotIndex, 0, "真相在卷中 → 镜头1（visual 逐字）");
    assert.equal(byText.get("周郎害我，谨防寒波。")?.shotIndex, 1, "周郎害我 → 镜头2（visual 逐字）");
    assert.equal(byText.get("周郎……寒波……")?.shotIndex, 2, "周郎寒波 → 镜头3（关键字重叠）");
    assert.equal(byText.get("周举子")?.shotIndex, 2, "周举子 → 镜头3（visual 逐字）");
    assert.equal(byText.get("寒波寺那晚，是我把他骗去的。")?.shotIndex, 4, "寒波寺那晚 → 镜头5（关键字重叠）");
    assert.equal(byText.get("我本只想吓他退让，谁知失手……")?.shotIndex, 4, "我本只想吓他 → 镜头5（关键字重叠）");
    assert.equal(byText.get("寒波寺那晚，是我把他骗去的。")?.speaker, "赵孟坚");
    assert.equal(byText.get("我本只想吓他退让，谁知失手……")?.speaker, "赵孟坚");
    assert.equal(byText.get("真相在卷中")?.speaker, "沈砚");
    assert.equal(byText.get("周举子")?.method, "exact-visual");
    assert.equal(byText.get("周郎……寒波……")?.method, "keyword-overlap");

    // 回填后逐字核查缺失归零
    const shotLines = result.shots.flatMap(s => {
        const ds = Array.isArray(s.dialogues) ? s.dialogues as Array<Record<string, unknown>> : [];
        return ds.map(d => String(d?.text || ""));
    });
    assert.deepEqual(missingDialogue(quotedSourceLines(CHAPTER3), shotLines), []);
});

test("回填幂等：已有对白后再次回填 added=0", () => {
    const first = backfillShots({ chapterText: CHAPTER3, shots: SHOTS, characterRegistryNames: ["沈砚", "赵孟坚"] });
    const second = backfillShots({ chapterText: CHAPTER3, shots: first.shots, characterRegistryNames: ["沈砚", "赵孟坚"] });
    assert.equal(second.added, 0);
    assert.equal(second.assignments.length, 0);
    assert.equal(second.alreadyPresent, 6);
});

test("dialogueKey 与前端一致：去标点/空白/引号并小写", () => {
    assert.equal(dialogueKey("周郎……寒波……"), "周郎寒波");
    assert.equal(dialogueKey("“真相在卷中”"), "真相在卷中");
    assert.equal(dialogueKey("我本只想吓他退让，谁知失手……"), "我本只想吓他退让谁知失手");
});

// ---- 真值链补全：utterances + utterance_refs + 逐字替换 ----

const SHOTS_V2: ShotLike[] = SHOTS.map((s, i) => ({
    ...s,
    id: `shot-${i}`,
    scene_id: "ENV_NIGHT",
    characters: ["CHAR_SHENYAN"],
    duration_frames: 96,
    camera: { description: "缓慢推镜" },
}));
const BACKFILL_CHARS = [{ id: "CHAR_SHENYAN", name: "沈砚" }, { id: "CHAR_ZHAO", name: "赵孟坚" }];
const BACKFILL_SUBS = [
    { id: "SUB_SY", kind: "character", entityRef: { ownerKind: "episode", ownerId: "d-backfill", kind: "character", id: "CHAR_SHENYAN" } },
];
const backfillOpts = { chapterText: CHAPTER3, shots: SHOTS_V2, characterRegistry: BACKFILL_CHARS, subjectRegistry: BACKFILL_SUBS };

test("backfill 产出合法 utterances 与 shot.utterance_refs（对齐 ep3 结构）", () => {
    const result = backfillShots(backfillOpts);
    assert.equal(result.utterances.length, 6);
    for (const u of result.utterances) {
        assert.ok(String(u.id || ""), "utterance 必须有 id");
        assert.ok(String(u.text || "").trim(), "utterance 必须有 text");
        assert.equal(Boolean(u.speakerSubjectId) !== Boolean(u.speakerName), true, "说话人必须是 Subject 或 speakerName 之一");
        assert.equal(typeof u.voiceover, "boolean");
        assert.ok(u.start && typeof u.start.shotId === "string", "必须有 start.shotId");
        assert.ok(u.end && typeof u.end.shotId === "string", "必须有 end.shotId");
        const start = Number(u.start?.localFrame), end = Number(u.end?.localFrame);
        assert.ok(Number.isInteger(start) && start >= 0, "start.localFrame 为非负整数");
        assert.ok(Number.isInteger(end) && end > start && end <= 96, "end.localFrame 在镜头时长内且递增");
    }
    const refs = result.shots.flatMap(s => (Array.isArray(s.utterance_refs) ? s.utterance_refs : []) as Array<Record<string, any>>);
    assert.equal(refs.length, 6, "每个 utterance 都要被 shot 引用");
    for (const ref of refs) {
        const u = result.utterances.find(x => x.id === ref.utteranceId);
        assert.ok(u, `ref ${ref.utteranceId} 必须能定位到 utterance`);
        assert.equal(ref.role, "speaker");
        assert.equal(ref.localStartFrame, u!.start?.localFrame, "ref 起点与 utterance.start 一致");
        assert.equal(ref.localEndFrame, u!.end?.localFrame, "ref 终点与 utterance.end 一致");
        assert.equal(ref.textStart, 0);
        assert.equal(ref.textEnd, Array.from(String(u!.text)).length);
        assert.ok(ref.localEndFrame <= 96);
    }
    // speakerSubjectId 从 character_registry.name → subject_registry.entityRef.id 解析。
    assert.equal(result.utterances.find(u => u.text === "真相在卷中")?.speakerSubjectId, "SUB_SY");
    // 赵孟坚无稳定 Subject（subject_registry 只登记了沈砚）：不能再把 entity id 塞进
    // speakerSubjectId，否则 production schema 校验会挡住写回；应退回 speakerName。
    const zhaoUtterance = result.utterances.find(u => u.text === "寒波寺那晚，是我把他骗去的。");
    assert.equal(zhaoUtterance?.speakerSubjectId, undefined);
    assert.equal(zhaoUtterance?.speakerName, "赵孟坚");
});

test("重复 backfill 幂等：utterances 不重复、不替换、不丢弃", () => {
    const first = backfillShots(backfillOpts);
    const second = backfillShots({ ...backfillOpts, shots: first.shots, utterances: first.utterances });
    assert.equal(second.added, 0);
    assert.equal(second.addedUtterances, 0);
    assert.equal(second.replacedUtterances, 0);
    assert.equal(second.droppedUtterances, 0);
    assert.equal(second.retainedUtterances, first.utterances.length);
    assert.equal(second.utterances.length, first.utterances.length);
    assert.deepEqual(second.utterances.map(u => u.text), first.utterances.map(u => u.text));
});

test("已有逐字台词不覆盖：id / delivery / 帧窗原样保留", () => {
    const verbatim: UtteranceLike = {
        id: "UTT_KEEP", speakerName: "沈砚", text: "真相在卷中", delivery: "轻声自语", voiceover: false,
        start: { shotId: "shot-0", localFrame: 10 }, end: { shotId: "shot-0", localFrame: 60 },
    };
    const result = backfillShots({ ...backfillOpts, utterances: [verbatim] });
    assert.equal(result.retainedUtterances, 1);
    assert.deepEqual(result.utterances.find(u => u.id === "UTT_KEEP"), verbatim);
});

test("原文逐字优先：同镜位 LLM 改写版被原文台词替换（用户投诉的根因）", () => {
    const rewritten: UtteranceLike = {
        id: "UTT:E3-S20:1", speakerName: "赵孟坚", text: "寒波寺那晚，我把他骗去了。",
        delivery: "LLM 改写语气", voiceover: false,
        start: { shotId: "shot-4", localFrame: 18 }, end: { shotId: "shot-4", localFrame: 78 },
    };
    const result = backfillShots({ ...backfillOpts, utterances: [rewritten] });
    assert.equal(result.replacedUtterances, 1);
    const after = result.utterances.find(u => u.id === rewritten.id);
    assert.ok(after);
    assert.equal(after!.text, "寒波寺那晚，是我把他骗去的。");
    assert.equal(dialogueKey(after!.text), dialogueKey("寒波寺那晚，是我把他骗去的。"));
    assert.equal(after!.start?.localFrame, 18, "替换保留原帧窗");
    assert.equal(after!.end?.localFrame, 78);
    assert.ok(!result.utterances.some(u => dialogueKey(String(u.text)) === dialogueKey(rewritten.text!)), "改写版不再留在真值里");
    const ref = (result.shots[4].utterance_refs as Array<Record<string, any>>).find(r => r.utteranceId === rewritten.id);
    assert.equal(ref?.textEnd, Array.from(after!.text!).length, "ref 的 textEnd 跟随新台词长度");
});

test("preserve-existing 策略保留改写版（可选兼容模式）", () => {
    const rewritten: UtteranceLike = {
        id: "UTT_OLD", speakerName: "赵孟坚", text: "寒波寺那晚，我把他骗去了。", voiceover: false,
        start: { shotId: "shot-4", localFrame: 18 }, end: { shotId: "shot-4", localFrame: 78 },
    };
    const result = backfillShots({ ...backfillOpts, utterances: [rewritten], utteranceStrategy: "preserve-existing" });
    assert.equal(result.replacedUtterances, 0);
    assert.ok(result.utterances.some(u => u.text === rewritten.text));
});

/** pipeline-force-rewrite 风格：仅 HTTP 边界用替身，runPrompts / buildSegmentWriterPrompt 是真实路径。 */
async function promptsFixture(utterances: UtteranceLike[], shots: ShotLike[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-prompts-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);
    const state = { prompts: [] as string[], ops: [] as Array<Record<string, any>>, revision: 4 };
    const canvasNodes = [{
        id: "h3-node-1", type: "h3",
        metadata: { segments: [{ id: "cs-1", prompt: "", productionClipProjection: { targetId: "seg-1" } }] },
    }];
    const production = { revision: 1, draft: { director: { assets: {}, source: {
        fps_num: 24, fps_den: 1,
        segments: [{ id: "seg-1", title: "第一段", shot_ids: SHOTS_V2.map(s => s.id), ending: "夜色渐深" }],
        shots, utterances,
    } } } };
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", c => chunks.push(Buffer.from(c)));
        req.on("end", () => {
            const url = String(req.url || "").split("?")[0];
            const body = Buffer.concat(chunks).toString("utf8");
            res.setHeader("Content-Type", "application/json");
            const send = (data: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };
            if (req.method === "GET" && url === "/drama/episodes/ep-backfill-dialogue") {
                return send({ ok: true, episode: { id: "ep-backfill-dialogue" }, canvas: { id: "canvas-backfill-dialogue", nodes: canvasNodes } });
            }
            if (req.method === "GET" && url === "/drama/episodes/ep-backfill-dialogue/production") return send({ ok: true, production });
            if (req.method === "POST" && url === "/canvas/generation") {
                const parsed = JSON.parse(body || "{}");
                state.prompts.push(String(parsed.prompt || ""));
                return send({ ok: true, taskId: `task-${state.prompts.length}` });
            }
            if (req.method === "GET" && /^\/tasks\/task-\d+$/.test(url)) {
                return send({ ok: true, task: { status: "succeeded", result: { texts: [{ content: "重写后的完整提示词" }] } } });
            }
            if (req.method === "GET" && url === "/canvas/projects/canvas-backfill-dialogue") {
                return send({ ok: true, project: { id: "canvas-backfill-dialogue", revision: state.revision } });
            }
            if (req.method === "POST" && url === "/canvas/projects/canvas-backfill-dialogue/ops") {
                const parsed = JSON.parse(body || "{}");
                if (Array.isArray(parsed.operations)) state.ops.push(...parsed.operations as Array<Record<string, any>>);
                state.revision += 1;
                return send({ ok: true });
            }
            return send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const pipeline = new DramaPipeline({
        store, token: "t", baseUrl: `http://127.0.0.1:${port}`, resolveTextModel: () => "test-text-model",
    });
    return { pipeline: pipeline as any, state, close: async () => {
        pipeline.stop(); store.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    } };
}

test("runPrompts 能读到 backfill 产出的逐字台词并写进提示词", async () => {
    const backfilled = backfillShots(backfillOpts);
    const f = await promptsFixture(backfilled.utterances, backfilled.shots);
    try {
        const result = await f.pipeline.runPrompts("ep-backfill-dialogue", "d-backfill-dialogue", { forceRewrite: true });
        assert.equal(result.written, 1);
        assert.equal(f.state.prompts.length, 1, "真跑了一次文本 LLM");
        const prompt = f.state.prompts[0];
        // runPrompts 每镜取第一条命中 utterance（既有行为），断言原文逐字台词进入素材稿。
        assert.match(prompt, /台词：“真相在卷中”/, "逐字台词进入素材稿");
        assert.match(prompt, /台词：“周郎害我，谨防寒波。”/, "长台词进入素材稿");
        assert.match(prompt, /台词：“周郎……寒波……”/, "叙述化台词也进入素材稿");
        assert.match(prompt, /台词：(?:赵孟坚：)?“寒波寺那晚，是我把他骗去的。”/, "后段台词进入素材稿（可带说话人名）");
        assert.doesNotMatch(prompt, /绝对无台词.*寒波寺那晚/, "不再是零台词素材稿");
        assert.equal(f.state.ops.length, 1, "写回画布段");
    } finally { await f.close(); }
});

test("原文真值默认取 source_chapters.body（与前端核查同源），sourceScript 只作回退", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-chapters-"));
    const file = path.join(dir, "chapters.sqlite");
    const db = new DatabaseSync(file);
    try {
        db.exec(`
            CREATE TABLE drama_episodes (id TEXT PRIMARY KEY, drama_id TEXT, episode_number INTEGER, title TEXT, chapter_ids_json TEXT);
            CREATE TABLE source_chapters (id TEXT PRIMARY KEY, drama_id TEXT, chapter_index INTEGER, title TEXT, body TEXT);
            CREATE TABLE drama_projects (folder_id TEXT PRIMARY KEY, production_plan_json TEXT);
        `);
        const chapterLines = Array.from({ length: 16 }, (_, i) => `第${i + 1}句正文台词`);
        const chapterBody = `第 1 章 对白测试\n\n` + chapterLines.map(l => `某人说：“${l}”。`).join("\n");
        const oldLines = Array.from({ length: 9 }, (_, i) => `旧版第${i + 1}句`);
        const oldScript = `第 1 章 对白测试\n\n` + oldLines.map(l => `“${l}”。`).join("\n");
        db.prepare("INSERT INTO drama_episodes VALUES (?,?,?,?,?)").run("ep-1", "d-1", 1, "第 1 章 对白测试", JSON.stringify(["ch-1"]));
        db.prepare("INSERT INTO source_chapters VALUES (?,?,?,?,?)").run("ch-1", "d-1", 1, "第 1 章 对白测试", chapterBody);
        db.prepare("INSERT INTO drama_projects VALUES (?,?)").run("d-1", JSON.stringify({ sourceScript: oldScript }));
        const ep = { id: "ep-1", dramaId: "d-1", episodeNumber: 1, title: "第 1 章 对白测试" };

        const resolved = resolveChapterText(db, { chapterSource: "chapters" }, ep);
        assert.equal(resolved.source, "source_chapters");
        assert.deepEqual(resolved.chapterIndexes, [1]);
        assert.equal(quotedSourceLines(resolved.text).length, 16, "source_chapters.body 的 16 句逐字台词与前端核查一致");
        assert.deepEqual(quotedSourceLines(resolved.text), chapterLines);

        const fallback = resolveChapterText(db, { chapterSource: "sourceScript" }, ep);
        assert.equal(fallback.source, "sourceScript");
        assert.equal(quotedSourceLines(fallback.text).length, 9, "sourceScript 是另一版本，仅作回退");
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
