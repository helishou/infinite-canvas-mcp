/**
 * 运行期补对白 + 无真参考图防假引用单测。
 *
 * 与 pipeline-force-rewrite.test.ts 共存：runPrompts 第三参 options 的 forceRewrite 分支不受影响；
 * 本文件聚焦 (1) 真源有对白时不派生、(2) 蟒妻真实 fixture 无对白时内存派生、(3) 失败降级、
 * (4) 无真绑定时清除假参考图、(5) 有真绑定时模板与输出保持原样。
 * 复用本地 HTTP 服务替身只隔离网络边界；DramaPipeline / canvas-agent dist 模板 / generateText /
 * cleanWrittenPrompt / condense / 写回链路都是真实代码路径。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import {
    DramaPipeline,
    knownCharacterNames,
    flattenPromptShots,
    buildDialogueUserPrompt,
    parseDerivedUtterances,
    sanitizeNoReferencePrompt,
} from "./pipeline.js";
import { buildSegmentWriterPrompt, buildSegmentCondensePrompt } from "@basketikun/canvas-agent/drama/segment-writer";
import { PipelineStore } from "./pipeline-store.js";

// 双 runner：项目自带 node:test 与验收用 `npx vitest run` 都能收集。
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}

const EP = "ep-dialogue-derive";
const DRAMA = "d-dialogue-derive";
const CANVAS = "canvas-dialogue-derive";
const WRITER_TEXT = "第1段提示词正文：二人相视而立，烛火摇曳。";

type Op = { type: string; nodeId: string; segmentId: string; patch: { prompt?: string; [k: string]: unknown } };

interface HarnessOptions {
    source: Record<string, any>;
    canvasSegments: Array<Record<string, any>>;
    /** 按生成请求顺序返回文本；返回 { fail: true } 模拟文本模型任务失败。 */
    respond: (prompt: string, callIndex: number) => string | { fail: true };
    forceRewrite?: boolean;
}

interface Harness {
    p: DramaPipeline;
    state: { generationPrompts: string[]; ops: Op[]; taskResults: Array<{ fail?: boolean; text?: string }> };
    store: PipelineStore;
    close: () => Promise<void>;
}

async function harness(opts: HarnessOptions): Promise<Harness> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-dialogue-derive-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);

    const state: Harness["state"] = { generationPrompts: [], ops: [], taskResults: [] };
    const canvasNodes = [{
        id: "h3-node-1",
        type: "h3",
        metadata: { segments: opts.canvasSegments.map((cs) => ({
            id: cs.id,
            prompt: String(cs.prompt || ""),
            productionClipProjection: { targetId: String(cs.targetId || cs.id) },
            ...(cs.referenceBindings ? { referenceBindings: cs.referenceBindings } : {}),
            ...(cs.refItems ? { refItems: cs.refItems } : {}),
            ...(cs.taskMode ? { taskMode: cs.taskMode } : {}),
        })) },
    }];
    const production = { revision: 1, draft: { director: { source: opts.source } } };

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
            const url = String(req.url || "").split("?")[0];
            const body = Buffer.concat(chunks).toString("utf8");
            res.setHeader("Content-Type", "application/json");
            const send = (data: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };

            if (req.method === "GET" && url === `/drama/episodes/${EP}`) {
                return send({ ok: true, episode: { id: EP, dramaId: DRAMA, title: "第1集" }, canvas: { id: CANVAS, nodes: canvasNodes } });
            }
            if (req.method === "GET" && url === `/drama/episodes/${EP}/production`) {
                return send({ ok: true, production });
            }
            if (req.method === "POST" && url === "/canvas/generation") {
                const parsed = JSON.parse(body || "{}");
                const prompt = String(parsed.prompt || "");
                const index = state.generationPrompts.length;
                state.generationPrompts.push(prompt);
                const reply = opts.respond(prompt, index);
                const result = typeof reply === "string" ? { text: reply } : { fail: true };
                state.taskResults.push(result);
                return send({ ok: true, taskId: `task-${index + 1}` });
            }
            if (req.method === "GET" && /^\/tasks\/task-\d+$/.test(url)) {
                const n = Number(url.split("-")[1]) - 1;
                const result = state.taskResults[n];
                if (!result || result.fail) return send({ ok: true, task: { status: "failed", error: "PIPELINE_TEXT_MODEL_MISSING" } });
                return send({ ok: true, task: { status: "succeeded", result: { texts: [{ content: result.text }] } } });
            }
            if (req.method === "GET" && url === `/canvas/projects/${CANVAS}`) {
                return send({ ok: true, project: { id: CANVAS, revision: 7 } });
            }
            if (req.method === "POST" && url === `/canvas/projects/${CANVAS}/ops`) {
                const parsed = JSON.parse(body || "{}");
                if (Array.isArray(parsed.operations)) state.ops.push(...parsed.operations as Op[]);
                return send({ ok: true });
            }
            return send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const p = new DramaPipeline({ store, token: "t", baseUrl: `http://127.0.0.1:${port}`, resolveTextModel: () => "test-text-model" });

    return {
        p, state, store,
        close: async () => {
            p.stop();
            store.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

function simpleSource(utterances: Array<Record<string, any>>): Record<string, any> {
    return {
        fps_num: 24, fps_den: 1,
        segments: [{ id: "seg-a", title: "第一段", shot_ids: ["shot-a"], ending: "" }],
        shots: [{ id: "shot-a", visual: "崇良持灯引妻入洞府", title: "入洞", duration_frames: 48, camera: { description: "跟拍" } }],
        utterances,
        script_scenes: [{ text: "场1｜内景·洞府｜夜｜崇良、妻｜二人相视而立。" }],
    };
}

const DIALOGUE_RESPONSE = [
    "好的，这是补写的对白：",
    "```json",
    '{"shots":[{"index":0,"speaker":"妻子","text":"你回来了。"}]}',
    "```",
    "以上。",
].join("\n");

test("source.utterances 非空时不调用补写（回归 forceRewrite 链路）", async () => {
    const h = await harness({
        source: simpleSource([{ start: { shotId: "shot-a" }, speaker: "甲", text: "我等你" }]),
        canvasSegments: [{ id: "cs-a", targetId: "seg-a", prompt: "" }],
        respond: (_prompt, i) => i === 0 ? WRITER_TEXT : WRITER_TEXT,
        forceRewrite: true,
    });
    try {
        const result = await (h.p as any).runPrompts(EP, DRAMA, { forceRewrite: true });
        assert.equal(result.written, 1);
        assert.equal(h.state.generationPrompts.length, 1, "只有一次 writer LLM 调用，没有派生调用");
        assert.ok(!h.state.generationPrompts[0].includes("你是短剧对白编剧"), "没有触发补对白 system");
        assert.ok(h.state.generationPrompts[0].includes("我等你"), "writer 素材稿仍用真源对白");
        assert.ok(h.state.generationPrompts[0].includes("甲：“我等你”"));
        assert.equal(h.state.ops[0].patch.prompt, WRITER_TEXT);
    } finally { await h.close(); }
});

test("蟒妻真实 fixture：无对白 → knownCharacterNames 从 script_scenes 兜底，派生出非空 {start:{shotId},speaker,text}", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../server/fixtures/clip-video-versions-real.json", import.meta.url), "utf8")) as any;
    const snapshot = JSON.parse(String(fixture.versions[0].snapshotJson));
    const source = snapshot.director.source as Record<string, any>;
    assert.equal(source.utterances.length, 0, "fixture 真源确实无对白");
    assert.equal(source.character_registry.length, 0);
    assert.equal(source.subject_registry.length, 0);
    assert.equal(source.asset_cards.length, 0);

    const shots: Array<Record<string, any>> = source.shots;
    const names = knownCharacterNames(source, shots);
    assert.ok(names.includes("崇良"));
    assert.ok(names.includes("妻"));
    assert.ok(names.includes("巨蟒"));
    assert.ok(!names.some((name) => name.includes("（")), "括号后缀已清理");

    const shotById = new Map(shots.map((shot) => [String(shot.id), shot]));
    const refs = flattenPromptShots(source.segments, shotById, names);
    assert.ok(refs.length > 0);
    assert.ok(refs.every((ref, i) => ref.index === i && shotById.has(ref.shotId)));
    const userPrompt = buildDialogueUserPrompt(refs, names);
    assert.ok(userPrompt.includes("可用角色（speaker 只能用这里的名字）"));
    const derived = parseDerivedUtterances(DIALOGUE_RESPONSE, refs, names);
    assert.equal(derived.length, 1);
    assert.equal(derived[0].speaker, "妻", "「妻子」被归一到已知角色「妻」");
    assert.equal(derived[0].text, "你回来了。");
    assert.equal(derived[0].start.shotId, refs[0].shotId, "用制作稿 shots[].id，不是 index/画布 clip.id");
    assert.deepEqual(Object.keys(derived[0]).sort(), ["speaker", "start", "text"]);

    // 全链路：派生对白进入 writer 素材稿；真源不被写回。
    const h = await harness({
        source,
        canvasSegments: source.segments.map((seg: any) => ({ id: `cs-${seg.id}`, targetId: String(seg.id), prompt: "" })),
        respond: (prompt) => prompt.includes("你是短剧对白编剧") ? DIALOGUE_RESPONSE : WRITER_TEXT,
    });
    try {
        const result = await (h.p as any).runPrompts(EP, DRAMA);
        assert.ok(result.written >= 1);
        assert.ok(h.state.generationPrompts.some((p) => p.includes("你是短剧对白编剧")), "无对白时确实调用了派生");
        assert.ok(h.state.generationPrompts.some((p) => p.includes("妻：“你回来了。”")), "派生对白进入 writer 素材稿");
        assert.equal(source.utterances.length, 0, "派生仅内存，不写回 draft.director.source.utterances");
    } finally { await h.close(); }
});

test("补写失败/JSON 坏时优雅降级返回 [] 不抛错，writer 仍写「绝对无台词」", async () => {
    for (const mode of ["task-fail", "bad-json"] as const) {
        const h = await harness({
            source: simpleSource([]),
            canvasSegments: [{ id: "cs-a", targetId: "seg-a", prompt: "" }],
            respond: (prompt, i) => {
                if (i === 0) return mode === "task-fail" ? { fail: true } : "模型跑偏了，没有 JSON";
                return WRITER_TEXT;
            },
        });
        try {
            const result = await (h.p as any).runPrompts(EP, DRAMA);
            assert.equal(result.written, 1, `${mode}: 不阻断提示词撰写`);
            assert.equal(h.state.generationPrompts.length, 2);
            assert.ok(h.state.generationPrompts[1].includes("绝对无台词"), `${mode}: 无对白素材稿`);
            assert.equal(h.state.ops[0].patch.prompt, WRITER_TEXT);
            const warns = h.store.logs(DRAMA).filter((row) => row.level === "warn");
            assert.ok(warns.some((row) => String(row.message).includes("运行期补对白失败")), `${mode}: 有 warn 日志`);
            assert.throws(() => parseDerivedUtterances("模型跑偏了，没有 JSON", [], ["妻"]), /DIALOGUE_JSON_MISSING/);
        } finally { await h.close(); }
    }
});

test("无真参考图：模板禁用编号写法，输出侧清除模型编造的假引用", async () => {
    const HALLUCINATED = "崇良（参考图3）｜空间锁定（场景名并标注参考图编号）｜外貌以参考图1-5为准｜标准镜头";
    const noRefInput = {
        index: 0, count: 1, title: "第一段", totalSec: 2,
        shots: [{ startSec: 0, endSec: 2, visual: "二人相视", references: [1, 2] }],
        noReferenceBindings: true,
    };
    const prompt = buildSegmentWriterPrompt(noRefInput);
    assert.ok(!prompt.user.includes("参考图N"), "模板不再要求写参考图N占位");
    assert.ok(prompt.user.includes("本段没有绑定任何参考图"));
    assert.ok(prompt.user.includes("已设定的角色形象"));
    assert.ok(!prompt.user.includes("参考：参考图"), "素材稿不再输出参考图引用");
    assert.ok(buildSegmentCondensePrompt("x", 100, true).includes("不得出现“参考图”字样"));
    assert.ok(sanitizeNoReferencePrompt(HALLUCINATED).includes("已设定的角色形象"));
    assert.ok(!sanitizeNoReferencePrompt(HALLUCINATED).includes("参考图"));

    // t2v 即使有 bindings 也不消费参考图 → 仍走无绑定分支。
    const h = await harness({
        source: simpleSource([{ start: { shotId: "shot-a" }, speaker: "妻", text: "我在" }]),
        canvasSegments: [{ id: "cs-a", targetId: "seg-a", prompt: "", taskMode: "t2v", referenceBindings: [{ enabled: true, storageKey: "img/x.png" }] }],
        respond: () => HALLUCINATED,
    });
    try {
        const result = await (h.p as any).runPrompts(EP, DRAMA);
        assert.equal(result.written, 1);
        const written = String(h.state.ops[0].patch.prompt);
        assert.ok(!written.includes("参考图"), "写回提示词无参考图字样");
        assert.ok(written.includes("已设定的角色形象"));
        assert.ok(h.store.logs(DRAMA).some((row) => String(row.message).includes("已清除提示词中的参考图编号")), "清洗有 warn");
    } finally { await h.close(); }
});

test("有真绑定：模板与 condense 保留原写法，输出不被 sanitize", async () => {
    const WITH_REF = "姓名（参考图N）＋参考图1-5：空间锁定（场景名并标注参考图编号）";
    const input = {
        index: 0, count: 1, title: "第一段", totalSec: 2,
        shots: [{ startSec: 0, endSec: 2, visual: "二人相视", references: [1] }],
        referenceCount: 2,
    };
    const prompt = buildSegmentWriterPrompt(input);
    assert.ok(prompt.user.includes("姓名（参考图N）"));
    assert.ok(prompt.user.includes("参考：参考图1"));
    assert.ok(buildSegmentCondensePrompt("x", 100).includes("每个“参考图N”编号写法不变"));

    const h = await harness({
        source: simpleSource([{ start: { shotId: "shot-a" }, speaker: "妻", text: "我在" }]),
        canvasSegments: [{
            id: "cs-a", targetId: "seg-a", prompt: "", taskMode: "T2VA",
            referenceBindings: [{ enabled: true, storageKey: "img/real.png" }],
        }],
        respond: () => WITH_REF,
    });
    try {
        const result = await (h.p as any).runPrompts(EP, DRAMA);
        assert.equal(result.written, 1);
        assert.equal(h.state.ops[0].patch.prompt, WITH_REF, "有真绑定时输出原样保留");
        assert.ok(String(h.state.ops[0].patch.prompt).includes("参考图N"));
        assert.equal(h.store.logs(DRAMA).filter((row) => String(row.message).includes("已清除提示词中的参考图编号")).length, 0);
    } finally { await h.close(); }
});
