/**
 * 强制重写段提示词单测：
 * - 默认（execute 的 prompts 段）仍跳过画布已有非空 prompt 的段，不重复跑 LLM；
 * - forceRewrite=true / rewritePrompts(episodeId) 忽略旧 prompt，逐段用真 LLM 重写并
 *   update_h3_segment 写回 prompt / referenceBindings / referenceOrder / taskMode；
 * - 二次 runPrompts 跳过已写段；写入四字段经真画布 op 与编译投影后仍存活。
 * 用本地 HTTP 服务替身只隔离网络边界；DramaPipeline、buildSegmentWriterPrompt、generateText、
 * cleanWrittenPrompt、condense 与写回链路都是真实代码路径。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { H3_RUNTIME_SEGMENT_FIELDS } from "@basketikun/canvas-agent/runtime-fields";
import { BackendDatabase } from "../db.js";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { CLIP_PROJECTION_FIELDS, clipInputHash } from "./clip-inputs.js";
import { DramaPipeline } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

// 同一份测试同时兼容项目自带 runner（node:test）与验收用的 `npx vitest run`：
// vitest 运行时它注入自己的 test 收集器；否则回退到 node:test。断言统一用 node:assert，
// 两个 runner 下都是真断言（不是 mock-only）。
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供，项目自身不需要该依赖
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}

const EP = "ep-force-rewrite";
const DRAMA = "d-force-rewrite";
const CANVAS = "canvas-force-rewrite";
const OLD_PROMPT = "旧的烂提示词-待重写";
/** LLM 原始回包（中文编号，写作模板约定）。 */
const GENERATED_PROMPT = "全新重写提示词-A1B2C3 参考图1与参考图2";
/** 写回画布前的对齐结果：中文编号 → <Picture N>。 */
const ALIGNED_PROMPT = "全新重写提示词-A1B2C3 <Picture 1>与<Picture 2>";
const SHOT_VISUAL = "雪夜街道，主角撑伞远去";

type Op = { type: string; nodeId: string; segmentId: string; patch: { prompt?: string; [k: string]: unknown }; patchDelete?: string[] };

interface Fixture {
    p: DramaPipeline;
    state: {
        generationCalls: number; generationPrompts: string[]; ops: Op[];
        episodeReads: number; revision: number; expectedRevisions: number[];
    };
    close: () => Promise<void>;
}

async function fixture(utterances: unknown[] = [{ text: "我等你", speaker: "甲", start: { shotId: "shot-1" } }]): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-force-rewrite-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);

    const state: Fixture["state"] = {
        generationCalls: 0, generationPrompts: [], ops: [], episodeReads: 0, revision: 7, expectedRevisions: [],
    };
    const canvasNodes = [{
        id: "h3-node-1",
        type: "h3",
        metadata: { segments: [{ id: "cs-1", prompt: OLD_PROMPT, productionClipProjection: { targetId: "seg-1" } }] },
    }];
    const production = {
        revision: 1,
        draft: { director: {
            // director.assets 是归档图真值；asset_cards.name 普遍为 None，名字只从 asset_plan 取。
            assets: {
                ASSET_SCENE: { storageKey: "image:scene-night" },
                ASSET_CHAR: { storageKey: "image:char-jia" },
                ASSET_PROP: { storageKey: "image:prop-umbrella" },
            },
            shotInputs: { "shot-1": { assetIds: ["ASSET_PROP"], keyframePolicy: "none" } },
            source: {
                fps_num: 24, fps_den: 1,
                asset_plan: [
                    { id: "ASSET_SCENE", kind: "scene", asset_name: "雪夜街道", entity_id: "ENV_NIGHT" },
                    { id: "ASSET_CHAR", kind: "character", asset_name: "甲", entity_id: "CHAR_JIA" },
                    { id: "ASSET_PROP", kind: "prop", asset_name: "油纸伞" },
                ],
                asset_cards: [
                    { id: "ASSET_SCENE", name: null }, { id: "ASSET_CHAR", name: null }, { id: "ASSET_PROP", name: null },
                ],
                scene_registry: [{ id: "ENV_NIGHT", name: "雪夜街道" }],
                character_registry: [{ id: "CHAR_JIA", name: "甲" }],
                segments: [{ id: "seg-1", title: "第一段", shot_ids: ["shot-1"], ending: "夜色渐深" }],
                shots: [{
                    id: "shot-1", scene_id: "ENV_NIGHT", characters: ["CHAR_JIA"],
                    visual: SHOT_VISUAL, duration_frames: 48, camera: { description: "缓慢推镜" },
                }],
                utterances,
            },
        } },
    };

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
            const url = String(req.url || "").split("?")[0];
            const body = Buffer.concat(chunks).toString("utf8");
            res.setHeader("Content-Type", "application/json");
            const send = (data: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };

            if (req.method === "GET" && url === `/drama/episodes/${EP}`) {
                state.episodeReads += 1;
                return send({ ok: true, episode: { id: EP, dramaId: DRAMA, title: "第1集" }, canvas: { id: CANVAS, nodes: canvasNodes } });
            }
            if (req.method === "GET" && url === `/drama/episodes/${EP}/production`) {
                return send({ ok: true, production });
            }
            if (req.method === "POST" && url === "/canvas/generation") {
                state.generationCalls += 1;
                const parsed = JSON.parse(body || "{}");
                state.generationPrompts.push(String(parsed.prompt || ""));
                return send({ ok: true, taskId: `task-${state.generationCalls}` });
            }
            if (req.method === "GET" && /^\/tasks\/task-\d+$/.test(url)) {
                return send({ ok: true, task: { status: "succeeded", result: { texts: [{ content: GENERATED_PROMPT }] } } });
            }
            if (req.method === "GET" && url === `/canvas/projects/${CANVAS}`) {
                return send({ ok: true, project: { id: CANVAS, revision: state.revision } });
            }
            if (req.method === "POST" && url === `/canvas/projects/${CANVAS}/ops`) {
                const parsed = JSON.parse(body || "{}");
                state.expectedRevisions.push(Number(parsed.expectedRevision || 0));
                if (Array.isArray(parsed.operations)) {
                    state.ops.push(...parsed.operations as Op[]);
                    // 模拟画布落盘：下一次 runPrompts 应看到已写 prompt 而跳过。
                    for (const op of parsed.operations as Op[]) {
                        if (op.type !== "update_h3_segment") continue;
                        const saved = canvasNodes[0].metadata.segments.find((s) => s.id === op.segmentId);
                        if (!saved) continue;
                        if (typeof op.patch?.prompt === "string") saved.prompt = op.patch.prompt as string;
                        if (Array.isArray(op.patch?.referenceBindings)) (saved as any).referenceBindings = op.patch.referenceBindings;
                        if (Array.isArray(op.patch?.referenceOrder)) (saved as any).referenceOrder = op.patch.referenceOrder;
                        if (typeof op.patch?.taskMode === "string") (saved as any).taskMode = op.patch.taskMode;
                        if (op.patchDelete?.includes("refItems")) delete (saved as any).refItems;
                    }
                }
                state.revision += 1;
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
        p, state,
        close: async () => {
            p.stop();
            store.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("默认不传 forceRewrite：画布已有非空 prompt 的段被跳过，不跑 LLM、不写回", async () => {
    const f = await fixture();
    try {
        // execute() 里 prompts 段的调用形态：不传第三参数。
        const result = await (f.p as any).runPrompts(EP, DRAMA);
        assert.equal(result.segments, 1);
        assert.equal(result.written, 0);
        assert.equal(result.skipped, 1, "旧 prompt 段被跳过");
        assert.equal(f.state.generationCalls, 0, "没有调用文本 LLM");
        assert.equal(f.state.ops.length, 0, "没有写回画布");
    } finally { await f.close(); }
});

test("forceRewrite=true：写回 prompt/referenceBindings/referenceOrder/taskMode 四字段，且中文编号已对齐", async () => {
    const f = await fixture();
    try {
        const result = await (f.p as any).runPrompts(EP, DRAMA, { forceRewrite: true });
        assert.equal(result.segments, 1);
        assert.equal(result.written, 1);
        assert.equal(result.skipped, 0, "force 模式下旧 prompt 不再跳过");
        assert.equal(f.state.generationCalls, 1, "真跑了一次文本 LLM");
        assert.match(f.state.generationPrompts[0], /雪夜街道/, "生成请求带真实素材稿（含镜头画面）");
        assert.match(f.state.generationPrompts[0], /【参考图清单】/, "生成请求带参考图清单段落");
        assert.match(f.state.generationPrompts[0], /参考图1：雪夜街道/, "清单用 asset_plan.asset_name");
        assert.match(f.state.generationPrompts[0], /参考：参考图1、参考图2、参考图3/, "每镜 references 进入素材稿");
        assert.equal(f.state.ops.length, 1);

        const op = f.state.ops[0];
        assert.equal(op.type, "update_h3_segment");
        assert.equal(op.nodeId, "h3-node-1");
        const patch = op.patch as Record<string, any>;
        for (const field of ["prompt", "referenceBindings", "referenceOrder", "taskMode"]) {
            assert.ok(Object.hasOwn(patch, field), `patch 必须显式带 ${field}`);
        }
        assert.equal(patch.prompt, ALIGNED_PROMPT, "写回的是对齐后的新提示词");
        assert.match(patch.prompt, /<Picture 1>/);
        assert.doesNotMatch(patch.prompt, /参考图/, "中文参考图编号已全部转成 <Picture N>");
        assert.notEqual(patch.prompt, OLD_PROMPT, "旧烂提示词已被替换");
        assert.deepEqual((patch.referenceBindings as any[]).map((b) => b.assetId), ["ASSET_SCENE", "ASSET_CHAR", "ASSET_PROP"]);
        assert.deepEqual((patch.referenceBindings as any[]).map((b) => b.label), ["<Picture 1>", "<Picture 2>", "<Picture 3>"]);
        assert.deepEqual(patch.referenceOrder, (patch.referenceBindings as any[]).map((b) => b.id));
        assert.equal(patch.taskMode, "ref2va");
        assert.ok(op.patchDelete?.includes("refItems"), "清掉旧勾选态");
        assert.equal(f.state.expectedRevisions[0], 7, "expectedRevision 即时重读当前项目 revision");
    } finally { await f.close(); }
});

test("forceRewrite：一镜多句 utterance 全部进 writer 素材稿，按 localFrame 排序", async () => {
    // 故意打乱数组顺序，验证按 start.localFrame 排序而不是「取第一句」或原数组顺序。
    const utterances = [
        { text: "第三句台词", speaker: "丙", start: { shotId: "shot-1", localFrame: 40 } },
        { text: "第一句台词", speaker: "甲", start: { shotId: "shot-1", localFrame: 0 } },
        { text: "第二句台词", speaker: "乙", start: { shotId: "shot-1", localFrame: 20 } },
    ];
    const f = await fixture(utterances);
    try {
        const result = await (f.p as any).runPrompts(EP, DRAMA, { forceRewrite: true });
        assert.equal(result.written, 1);
        assert.equal(f.state.generationCalls, 1, "一次 writer LLM 调用承载全部台词");
        const prompt = f.state.generationPrompts[0];
        const draft = prompt.slice(prompt.indexOf("【本段素材稿】"));
        const lines = draft.split("\n").filter(line => line.startsWith("台词："));
        assert.deepEqual(lines, [
            "台词：甲：“第一句台词”",
            "台词：乙：“第二句台词”",
            "台词：丙：“第三句台词”",
        ], "一镜三句全部进提示词，按 localFrame 排序");
        assert.ok(!draft.includes("绝对无台词"), "有台词时不写「绝对无台词」");
    } finally { await f.close(); }
});

test("rewritePrompts(episodeId)：从 episode 查 dramaId，再以 forceRewrite 重写已有提示词", async () => {
    const f = await fixture();
    try {
        const result = await (f.p as any).rewritePrompts(EP);
        assert.deepEqual(result, { segments: 1, written: 1, skipped: 0 });
        assert.ok(f.state.episodeReads >= 1, "通过 episode 查询拿到所属 dramaId");
        assert.equal(f.state.generationCalls, 1);
        assert.equal(f.state.ops[0].patch.prompt, ALIGNED_PROMPT);
    } finally { await f.close(); }
});

test("幂等：首次写入后二次 runPrompts 跳过，不再跑 LLM / 不再发 op", async () => {
    const f = await fixture();
    try {
        const first = await (f.p as any).runPrompts(EP, DRAMA, { forceRewrite: true });
        assert.equal(first.written, 1);
        const second = await (f.p as any).runPrompts(EP, DRAMA);
        assert.equal(second.written, 0);
        assert.equal(second.skipped, 1, "已写 prompt 的段被跳过");
        assert.equal(f.state.generationCalls, 1, "二次运行没有再跑文本 LLM");
        assert.equal(f.state.ops.length, 1, "二次运行没有再发写回 op");
    } finally { await f.close(); }
});

test("编译存活：写入四字段进入投影指纹，经真画布 op 后保留 prompt/bindings/order/taskMode 与 productionClipProjection", async () => {
    const f = await fixture();
    try {
        await (f.p as any).runPrompts(EP, DRAMA, { forceRewrite: true });
        const op = f.state.ops[0] as any;
        for (const field of ["prompt", "referenceBindings", "referenceOrder", "taskMode"]) {
            assert.ok(CLIP_PROJECTION_FIELDS.includes(field as any), `${field} 应在 CLIP_PROJECTION_FIELDS`);
            assert.ok(!(H3_RUNTIME_SEGMENT_FIELDS as readonly string[]).includes(field), `${field} 不应是 H3 运行字段`);
        }

        const db = new BackendDatabase(":memory:");
        try {
            db.createCanvasProject({
                id: "p",
                nodes: [{
                    id: "h3-node-1", type: "minimax-h3:video",
                    metadata: { segments: [{ id: "cs-1", prompt: OLD_PROMPT, productionClipProjection: { targetId: "seg-1", fieldHashes: {} } }] },
                }],
                connections: [],
            });
            const receipt = db.applyCanvasProjectOperations("p", undefined, [{
                type: "update_h3_segment", nodeId: "h3-node-1", segmentId: "cs-1", patch: op.patch, patchDelete: op.patchDelete,
            }], { operationId: "prompts-write" });
            const saved = ((receipt.project.nodes as any[])[0].metadata.segments as any[])[0];
            assert.equal(saved.prompt, ALIGNED_PROMPT);
            assert.deepEqual(saved.referenceBindings, op.patch.referenceBindings);
            assert.deepEqual(saved.referenceOrder, op.patch.referenceOrder);
            assert.equal(saved.taskMode, "ref2va");
            assert.ok(saved.productionClipProjection, "productionClipProjection 不被写回冲掉");

            const before = clipInputHash({ ...saved, prompt: OLD_PROMPT, referenceBindings: [], referenceOrder: [], taskMode: "t2v" });
            const after = clipInputHash(saved);
            assert.notEqual(before, after, "四字段变化会改变投影指纹 → 编译需要发 op");
            assert.equal(clipInputHash(structuredClone(saved)), after, "内容不变时指纹稳定 → 编译不发重复 op");
        } finally { db.close(); }
    } finally { await f.close(); }
});

test("rewritePrompts 选段：onlyIndexes 只写指定段，其余不动", async () => {
    const f = await fixture();
    try {
        // fixture 只有 1 段（index 0）；指定只写 index 5 → 没有段被写，runPrompts 抛 NOTHING_WRITTEN
        let threw = false;
        try { await f.p.rewritePrompts(EP, [5]); } catch (e) { threw = String(e).includes("NOTHING_WRITTEN"); }
        assert.ok(threw, "选段全落空时抛出 PROMPTS_NOTHING_WRITTEN");
        assert.equal(f.state.generationCalls, 0, "被过滤掉的段不跑 LLM");
        assert.equal(f.state.ops.length, 0, "不写回画布");
    } finally { await f.close(); }
});

test("rewritePrompts：暂停态下可重写，但保持 status/pause_reason 一致、不唤醒出片作业", async () => {
    const f = await fixture();
    try {
        // 模拟「手动暂停」+ 带旧提示词生成的下游作业（video/render 已 failed、script/assets 已 succeeded）
        f.p.pause(DRAMA, "manual");
        // 用 store 直接准备作业（dedupe_key 幂等）；视频/渲染作业模拟「旧提示词已 failed」
        f.p.store.enqueue({ id: "j-script", dramaId: DRAMA, episodeId: EP, kind: "script", stage: "script", dedupeKey: "dk-script" });
        f.p.store.enqueue({ id: "j-assets", dramaId: DRAMA, episodeId: EP, kind: "assets", stage: "assets", dedupeKey: "dk-assets" });
        f.p.store.enqueue({ id: "j-video", dramaId: DRAMA, episodeId: EP, kind: "video", stage: "video", dedupeKey: "dk-video" });
        f.p.store.enqueue({ id: "j-render", dramaId: DRAMA, episodeId: EP, kind: "render", stage: "render", dedupeKey: "dk-render" });
        const db = (f.p.store as any).db;
        for (const id of ["j-video", "j-render"]) {
            db.prepare("UPDATE drama_pipeline_jobs SET status='failed', attempt=5, error='old prompt' WHERE id=?").run(id);
        }

        const result = await f.p.rewritePrompts(EP);
        assert.equal(result.written, 1, "即使处于暂停态，显式重写也能完成");
        // 关键回归：重写后必须保持一致的暂停态，不能出现「pause_reason=manual 但 status=running」
        // 那种界面显示暂停、调度器仍在派发出片的分裂状态。
        assert.equal(f.p.store.get(DRAMA)?.status, "paused", "重写不把流水线改成 running");
        const pausedRow = (f.p.store as any).db.prepare("SELECT pause_reason FROM drama_pipelines WHERE drama_id=?").get(DRAMA);
        assert.equal(pausedRow?.pause_reason, "manual", "pause_reason 保持 manual，与 status 一致");
        const byId = (id: string) => f.p.store.job(id)!;
        assert.equal(byId("j-video").status, "failed", "暂停态下重写不重排出片作业，不触发出片");
        assert.equal(byId("j-video").attempt, 5, "视频作业 attempt 不被重置");
        assert.equal(byId("j-render").status, "failed", "渲染作业同样不被唤醒");
    } finally { await f.close(); }
});
