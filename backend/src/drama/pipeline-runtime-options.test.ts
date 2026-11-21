/**
 * 全自动流水线「制作设置注入补齐」单测：
 * - performance/cameraDynamics 1-10 档 → 5 档表演/运镜硬文本（与手动路径同源）注入 SegmentWriterInput.style/cameraMotion；
 * - textSkills.prompt 的方法要点真实进入段提示词 prompt；
 * - hook/cliffhanger 与 textThinking.plan 透传给 script-proposal 请求（结构化字段 + 400 时的 instruction 回退）。
 * 仅用本地 HTTP 服务替身隔离网络边界；DramaPipeline 的请求构造、buildSegmentWriterPrompt 都是真实代码路径。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { cameraMotionStyleText, DramaPipeline, performanceStyleText } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供，项目自身不需要该依赖
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}

const EP = "ep-runtime-options";
const DRAMA = "d-runtime-options";
const CANVAS = "canvas-runtime-options";
const NEW_PROMPT = "按设置重写后的段提示词-X9Y8Z7";
const SHOT_VISUAL = "雨夜天台，主角回身";

type Handler = (req: http.IncomingMessage, url: string, body: string, send: (data: unknown, status?: number) => void) => void;

async function withPipeline(handler: Handler, run: (p: DramaPipeline) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-runtime-options-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
            res.setHeader("Content-Type", "application/json");
            const send = (data: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };
            handler(req, String(req.url || "").split("?")[0], Buffer.concat(chunks).toString("utf8"), send);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const p = new DramaPipeline({ store, token: "t", baseUrl: `http://127.0.0.1:${port}`, resolveTextModel: () => "test-text-model" });
    try {
        await run(p);
    } finally {
        p.stop();
        store.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── 1) 档位映射（5 档边界，纯函数） ────────────────────────────────────────

test("performanceStyleText: 1-10 映射为与手动路径同源的 5 档表演文字", () => {
    assert.equal(performanceStyleText(1), "表演克制内敛，情绪只在眼神与细微表情变化");
    assert.equal(performanceStyleText(3), "表演自然收敛，情绪变化有分寸不夸张");
    assert.equal(performanceStyleText(5), "表演自然到位，情绪变化落在线条与呼吸上，像在演戏");
    assert.equal(performanceStyleText(8), "表演投入饱满，情绪外放但有层次，面部表情与肢体同步");
    assert.equal(performanceStyleText(10), "表演强烈张力，情绪大幅起伏，表情与身体语言充分夸张");
    assert.equal(performanceStyleText(undefined), performanceStyleText(5), "缺省按自然档 5");
    assert.equal(performanceStyleText(99), performanceStyleText(10), "越界收敛到 1-10");
});

test("cameraMotionStyleText: 1-10 映射为与手动路径同源的 5 档运镜文字", () => {
    assert.equal(cameraMotionStyleText(2), "运镜以稳定静态机位为主，几乎不运动");
    assert.equal(cameraMotionStyleText(4), "运镜克制，仅缓慢推拉，稳而有分寸");
    assert.equal(cameraMotionStyleText(6), "运镜有明确动机，稳中带动感，跟随人物动作");
    assert.equal(cameraMotionStyleText(8), "运镜灵活，推拉摇移配合节奏，增强画面动势");
    assert.equal(cameraMotionStyleText(9), "运镜强烈动感，跟拍环绕甩镜并用，节奏凌厉");
    assert.equal(cameraMotionStyleText(undefined), cameraMotionStyleText(5));
    assert.equal(cameraMotionStyleText(-3), cameraMotionStyleText(1));
});

// ── 2) runPrompts：表演/运镜档位与写作技能真实进入段提示词 prompt ───────────

test("runPrompts: performance/cameraDynamics/textSkills.prompt 注入 SegmentWriterInput", async () => {
    let generationPrompt = "";
    let generationParams: Record<string, unknown> | undefined;
    let taskNo = 0;
    let ops = 0;
    await withPipeline((req, url, body, send) => {
        if (req.method === "GET" && url === `/drama/episodes/${EP}`) {
            return send({ ok: true, episode: { id: EP, dramaId: DRAMA, title: "第1集" }, canvas: { id: CANVAS, nodes: [{ id: "node-1", type: "h3", metadata: { segments: [{ id: "cs-1", prompt: "", productionClipProjection: { targetId: "seg-1" } }] } }] } });
        }
        if (req.method === "GET" && url === `/drama/episodes/${EP}/production`) {
            return send({ ok: true, production: { revision: 1, draft: { director: { source: {
                fps_num: 24, fps_den: 1,
                segments: [{ id: "seg-1", title: "第一段", shot_ids: ["shot-1"], ending: "" }],
                shots: [{ id: "shot-1", visual: SHOT_VISUAL, duration_frames: 48, camera: { description: "缓慢推镜" } }],
                utterances: [{ text: "我等你", speaker: "甲", start: { shotId: "shot-1" } }],
            } } } } });
        }
        if (req.method === "POST" && url === "/canvas/generation") {
            const parsed = JSON.parse(body || "{}");
            generationPrompt = String(parsed.prompt || "");
            generationParams = parsed.params;
            taskNo += 1;
            return send({ ok: true, taskId: `task-${taskNo}` });
        }
        if (req.method === "GET" && /^\/tasks\/task-\d+$/.test(url)) {
            return send({ ok: true, task: { status: "succeeded", result: { texts: [{ content: NEW_PROMPT }] } } });
        }
        if (req.method === "GET" && url === `/canvas/projects/${CANVAS}`) return send({ ok: true, project: { id: CANVAS, revision: 7 } });
        if (req.method === "POST" && url === `/canvas/projects/${CANVAS}/ops`) { ops += 1; return send({ ok: true }); }
        return send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
    }, async (p) => {
        (p as any).runOptions.set(DRAMA, {
            performance: 10,
            cameraDynamics: 9,
            storyboardRules: { pacing: "快", dialogueDensity: "dense" },
            textSkills: {
                prompt: {
                    name: "prompt-skill",
                    title: "爆款提示词写法",
                    path: ".agents/skills/prompt-skill/SKILL.md",
                    content: "---\ndescription: 强化镜头节奏\n---\n# 方法\n每个镜头先写站位再写光线。",
                },
            },
        });
        const result = await (p as any).runPrompts(EP, DRAMA);
        assert.equal(result.written, 1, "真写回一段");
        assert.equal(ops, 1);
    });

    assert.match(generationPrompt, /表演强烈张力，情绪大幅起伏/, "performance=10 → 第5档表演文字进入 style");
    assert.match(generationPrompt, /运镜强烈动感，跟拍环绕甩镜并用/, "cameraDynamics=9 → 第5档运镜文字进入 cameraMotion");
    assert.match(generationPrompt, /对白密集|节奏快/, "分镜规则软约束仍与档位文字共存，未被覆盖");
    assert.match(generationPrompt, /写作方法参考「爆款提示词写法」/, "textSkills.prompt.skillName 注入");
    assert.match(generationPrompt, /每个镜头先写站位再写光线/, "textSkills.prompt.content 真进入提示词 prompt");
    assert.equal(generationParams, undefined, "本测试未设置 textThinking.prompt，不写 params");
});

test("runPrompts: 前端设置项原名 performanceIntensity 作为兼容别名生效", async () => {
    let generationPrompt = "";
    await withPipeline((req, url, body, send) => {
        if (req.method === "GET" && url === `/drama/episodes/${EP}`) return send({ ok: true, episode: { id: EP }, canvas: { id: CANVAS, nodes: [{ id: "node-1", metadata: { segments: [{ id: "cs-1", prompt: "", productionClipProjection: { targetId: "seg-1" } }] } }] } });
        if (req.method === "GET" && url === `/drama/episodes/${EP}/production`) return send({ ok: true, production: { revision: 1, draft: { director: { source: { fps_num: 24, fps_den: 1, segments: [{ id: "seg-1", shot_ids: ["shot-1"] }], shots: [{ id: "shot-1", visual: SHOT_VISUAL, duration_frames: 24 }], utterances: [{ text: "走", start: { shotId: "shot-1" } }] } } } } });
        if (req.method === "POST" && url === "/canvas/generation") { generationPrompt = String(JSON.parse(body).prompt || ""); return send({ ok: true, taskId: "task-1" }); }
        if (req.method === "GET" && url === "/tasks/task-1") return send({ ok: true, task: { status: "succeeded", result: { texts: [{ content: NEW_PROMPT }] } } });
        if (req.method === "GET" && url === `/canvas/projects/${CANVAS}`) return send({ ok: true, project: { id: CANVAS, revision: 1 } });
        if (req.method === "POST" && url === `/canvas/projects/${CANVAS}/ops`) return send({ ok: true });
        return send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
    }, async (p) => {
        (p as any).runOptions.set(DRAMA, { performanceIntensity: 2, cameraDynamics: 3 });
        await (p as any).runPrompts(EP, DRAMA);
    });
    assert.match(generationPrompt, /表演克制内敛/, "performanceIntensity=2 → 第1档表演文字");
    assert.match(generationPrompt, /运镜克制，仅缓慢推拉/, "cameraDynamics=3 → 第2档运镜文字");
});

// ── 3) runScript：hook/cliffhanger 与 textThinking.plan 透传 script-proposal ──

test("runScript: hook/cliffhanger/reasoningEffort/planModel 透传给 script-proposal 请求", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await withPipeline((req, url, body, send) => {
        if (req.method === "GET" && url === `/drama/episodes/${EP}`) return send({ ok: true, episode: { id: EP, dramaId: DRAMA, title: "第1集" } });
        if (req.method === "POST" && url === `/drama/episodes/${EP}/script-proposal`) {
            bodies.push(JSON.parse(body || "{}"));
            // 空 text 触发 SCRIPT_PROPOSAL_EMPTY，让断言停在请求构造处（无需搭完整拆镜/编译链）。
            return send({ ok: true, text: "" });
        }
        return send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
    }, async (p) => {
        (p as any).runOptions.set(DRAMA, {
            planModel: "plan-model-x",
            textThinking: { plan: "high" },
            hook: "开篇雨夜来信",
            cliffhanger: "码头跟踪者现身",
        });
        await assert.rejects((p as any).runScript(EP, DRAMA), /SCRIPT_PROPOSAL_EMPTY/);
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].model, "plan-model-x", "planModel → model");
    assert.equal(bodies[0].reasoningEffort, "high", "textThinking.plan → 真 reasoningEffort 字段（非 instruction 软文本）");
    assert.equal(bodies[0].hook, "开篇雨夜来信", "hook 结构化透传");
    assert.equal(bodies[0].cliffhanger, "码头跟踪者现身", "cliffhanger 结构化透传");
    assert.match(String(bodies[0].instruction), /开篇钩子：开篇雨夜来信/);
    assert.match(String(bodies[0].instruction), /结尾悬念：码头跟踪者现身/);
    assert.doesNotMatch(String(bodies[0].instruction || ""), /思考深度/, "升级后的路由走真 reasoningEffort，不再塞思考深度软文本");
});

test("runScript: script-proposal 旧 strict 路由 400 时回退 instruction（钩子/悬念/思考深度不丢）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await withPipeline((req, url, body, send) => {
        if (req.method === "GET" && url === `/drama/episodes/${EP}`) return send({ ok: true, episode: { id: EP } });
        if (req.method === "POST" && url === `/drama/episodes/${EP}/script-proposal`) {
            bodies.push(JSON.parse(body || "{}"));
            if (bodies.length === 1) return send({ ok: false, error: "Unrecognized key(s) in object: 'hook'" }, 400);
            return send({ ok: true, text: "" });
        }
        return send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
    }, async (p) => {
        (p as any).runOptions.set(DRAMA, { textThinking: { plan: "medium" }, hook: "雨夜开篇", cliffhanger: "结尾悬念" });
        await assert.rejects((p as any).runScript(EP, DRAMA), /SCRIPT_PROPOSAL_EMPTY/);
    });
    assert.equal(bodies.length, 2, "先结构化请求，400 后回退重试一次");
    assert.equal(bodies[0].reasoningEffort, "medium");
    assert.equal(bodies[1].reasoningEffort, undefined, "回退请求不带结构化字段");
    assert.equal(bodies[1].hook, undefined);
    assert.match(String(bodies[1].instruction), /开篇钩子：雨夜开篇/);
    assert.match(String(bodies[1].instruction), /结尾悬念：结尾悬念/);
    assert.match(String(bodies[1].instruction), /请以 medium 的思考深度/, "回退时思考深度并入 instruction");
});

test("textThinking.plan=auto 不写 reasoningEffort（对齐 generateText 的 auto 语义）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await withPipeline((req, url, body, send) => {
        if (req.method === "GET" && url === `/drama/episodes/${EP}`) return send({ ok: true, episode: { id: EP } });
        if (req.method === "POST" && url === `/drama/episodes/${EP}/script-proposal`) { bodies.push(JSON.parse(body || "{}")); return send({ ok: true, text: "" }); }
        return send({ ok: false, error: "unexpected" }, 404);
    }, async (p) => {
        (p as any).runOptions.set(DRAMA, { textThinking: { plan: "auto" } });
        await assert.rejects((p as any).runScript(EP, DRAMA), /SCRIPT_PROPOSAL_EMPTY/);
    });
    assert.equal(bodies[0].reasoningEffort, undefined);
    assert.equal(bodies[0].instruction, undefined);
});
