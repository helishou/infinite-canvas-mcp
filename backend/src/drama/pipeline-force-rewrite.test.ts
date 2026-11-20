/**
 * 强制重写段提示词单测：
 * - 默认（execute 的 prompts 段）仍跳过画布已有非空 prompt 的段，不重复跑 LLM；
 * - forceRewrite=true / rewritePrompts(episodeId) 忽略旧 prompt，逐段用真 LLM 重写并 update_h3_segment 写回。
 * 用本地 HTTP 服务替身只隔离网络边界；DramaPipeline、buildSegmentWriterPrompt、generateText、
 * cleanWrittenPrompt、condense 与写回链路都是真实代码路径。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
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
const NEW_PROMPT = "全新重写提示词-A1B2C3";
const SHOT_VISUAL = "雪夜街道，主角撑伞远去";

type Op = { type: string; nodeId: string; segmentId: string; patch: { prompt?: string; [k: string]: unknown } };

interface Fixture {
    p: DramaPipeline;
    state: { generationCalls: number; generationPrompts: string[]; ops: Op[]; episodeReads: number };
    close: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-force-rewrite-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);

    const state: Fixture["state"] = { generationCalls: 0, generationPrompts: [], ops: [], episodeReads: 0 };
    const canvasNodes = [{
        id: "h3-node-1",
        type: "h3",
        metadata: { segments: [{ id: "cs-1", prompt: OLD_PROMPT, productionClipProjection: { targetId: "seg-1" } }] },
    }];
    const production = {
        revision: 1,
        draft: { director: { source: {
            fps_num: 24, fps_den: 1,
            segments: [{ id: "seg-1", title: "第一段", shot_ids: ["shot-1"], ending: "夜色渐深" }],
            shots: [{ id: "shot-1", visual: SHOT_VISUAL, duration_frames: 48, camera: { description: "缓慢推镜" } }],
            utterances: [{ text: "我等你", speaker: "甲", start: { shotId: "shot-1" } }],
        } } },
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
                return send({ ok: true, task: { status: "succeeded", result: { texts: [{ content: NEW_PROMPT }] } } });
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

test("forceRewrite=true：非空 prompt 的段被真 LLM 重写，并 update_h3_segment 写回新提示词", async () => {
    const f = await fixture();
    try {
        const result = await (f.p as any).runPrompts(EP, DRAMA, { forceRewrite: true });
        assert.equal(result.segments, 1);
        assert.equal(result.written, 1);
        assert.equal(result.skipped, 0, "force 模式下旧 prompt 不再跳过");
        assert.equal(f.state.generationCalls, 1, "真跑了一次文本 LLM");
        assert.match(f.state.generationPrompts[0], /雪夜街道/, "生成请求带真实素材稿（含镜头画面）");
        assert.equal(f.state.ops.length, 1);
        assert.equal(f.state.ops[0].type, "update_h3_segment");
        assert.equal(f.state.ops[0].nodeId, "h3-node-1");
        assert.equal(f.state.ops[0].patch.prompt, NEW_PROMPT, "写回的是新生成的提示词");
        assert.notEqual(f.state.ops[0].patch.prompt, OLD_PROMPT, "旧烂提示词已被替换");
    } finally { await f.close(); }
});

test("rewritePrompts(episodeId)：从 episode 查 dramaId，再以 forceRewrite 重写已有提示词", async () => {
    const f = await fixture();
    try {
        const result = await (f.p as any).rewritePrompts(EP);
        assert.deepEqual(result, { segments: 1, written: 1, skipped: 0 });
        assert.ok(f.state.episodeReads >= 1, "通过 episode 查询拿到所属 dramaId");
        assert.equal(f.state.generationCalls, 1);
        assert.equal(f.state.ops[0].patch.prompt, NEW_PROMPT);
    } finally { await f.close(); }
});
