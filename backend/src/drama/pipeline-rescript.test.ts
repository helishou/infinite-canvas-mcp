/**
 * 级联重拆镜单测（按章编辑原文 → 确定保存并重新改编）：
 * - runScript 在已有 shots 的分集上不再跳过拆镜，而是清旧镜 + 按新稿重拆，shots/segments 数量与内容都变；
 * - 清旧与写新在同一个 productionOps 批次（整批原子），任一步失败都不进入 promote，杜绝半写；
 * - promoteToCanvas 真跑 发布→编译→应用→再发布→准备节点→sync-clips，画布 H3 segments 同步到新 Clip；
 * - rescript 幂等重置本集作业（script/assets/prompts/video/render）并保持 instruction 透传。
 * 用本地 HTTP 服务替身只隔离网络边界；DramaPipeline、planChapterStoryboard、toSceneStoryboardOps、
 * promoteToCanvas、PipelineStore 都是真实代码路径。
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
import { replaceDirectorSceneStoryboard } from "./scene-storyboard.js";
import { productionOperationContract } from "@basketikun/canvas-agent/drama/production-validation";

type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供，项目自身不需要该依赖
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}

const EP = "ep-rescript";
const DRAMA = "d-rescript";
const ENV = "ENV-SHRINE";
const OLD_SHOT = "OLD-SHOT-1";
const OLD_SEG = "OLD-SEG-1";

const NEW_DEMAND = JSON.stringify({
    demand: "【场景：山神庙】\n【时间：夜】\n【镜头 1】新稿镜头甲。\n【镜头 2】新稿镜头乙。\n【镜头 3】新稿镜头丙。",
    scenes: [{
        sceneKey: "s1", environmentId: ENV, sceneName: "山神庙",
        beats: [
            { title: "新镜甲", visual: "新稿镜头甲：刀客推门而入。", seconds: 6, character_ids: ["CHAR-DAOKE"], prop_ids: ["PROP-DAO"], scene_id: ENV },
            { title: "新镜乙", visual: "新稿镜头乙：少年抬起头。", seconds: 6, character_ids: ["CHAR-SHAONIAN", "CHAR-DAOKE", "CHAR-DAOKE", "CHAR-FAKE"], prop_ids: ["PROP-DAO", "PROP-FAKE"], scene_id: "ENV-FAKE" },
            { title: "新镜丙", visual: "新稿镜头丙：雨停月出。", seconds: 6, character_ids: ["CHAR-FAKE"], prop_ids: [], scene_id: ENV },
        ],
    }],
});

type Fixture = {
    p: DramaPipeline;
    store: PipelineStore;
    state: {
        proposalBodies: Array<Record<string, unknown>>;
        episodePatches: Array<Record<string, unknown>>;
        opsBatches: Array<Array<Record<string, any>>>;
        promoteCalls: string[];
        generationPrompts: string[];
        failOps: boolean;
        production: any;
    };
    close: () => Promise<void>;
};

async function fixture(options?: { emptyChapters?: boolean }): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-rescript-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);

    const state: Fixture["state"] = {
        proposalBodies: [], episodePatches: [], opsBatches: [], promoteCalls: [], generationPrompts: [],
        failOps: false,
        production: {
            revision: 3,
            draft: {
                director: {
                    schemaVersion: 1,
                    engine: { provider: "test", model: "test" },
                    sourceHash: "old-hash",
                    modules: {},
                    artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
                    source: {
                        fps_num: 24, fps_den: 1,
                        scene_registry: [{ id: ENV, name: "山神庙" }],
                        character_registry: [
                            { id: "CHAR-DAOKE", name: "刀客" },
                            { id: "CHAR-SHAONIAN", name: "少年" },
                        ],
                        asset_cards: [
                            { id: "PROP-DAO", asset_kind: "prop", prompt: "长刀" },
                        ],
                        shots: [{ id: OLD_SHOT, scene_id: ENV, source_scene_id: ENV, timeline_id: "main", story_order: 0, title: "旧镜", visual: "旧稿镜头：雪夜街道。", duration_frames: 240, camera: { framing: "WS", movement: "static", editorial_reason: "旧" } }],
                        segments: [{ id: OLD_SEG, shot_ids: [OLD_SHOT], mode: "auto" }],
                    },
                },
            },
        },
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
                return send({ ok: true, episode: { id: EP, dramaId: DRAMA, title: "第1集" }, canvas: { id: "canvas-rescript", nodes: [] } });
            }
            if (req.method === "GET" && url === `/drama/${DRAMA}/stage`) return send({ ok: true, states: {} });
            if (req.method === "GET" && url === `/drama/projects/${DRAMA}/episodes`) return send({ ok: true, episodes: [{ id: EP, episodeNumber: 1 }] });
            if (req.method === "POST" && url === `/drama/episodes/${EP}/script-proposal`) {
                state.proposalBodies.push(JSON.parse(body || "{}"));
                return send({ ok: true, text: "【场景：山神庙】\n新稿分场正文：刀客推门、少年抬头、雨停月出。", synopsis: "新稿梗概" });
            }
            if (req.method === "GET" && url === `/drama/episodes/${EP}/chapters`) {
                if (options?.emptyChapters) return send({ ok: true, chapters: [] });
                return send({ ok: true, chapters: [{ body: "刀客推门而入。少年抬起头。雨停月出。" }] });
            }
            if (req.method === "GET" && url === `/drama/${DRAMA}/planning`) {
                // 老剧目整份原文：绝不能成为拆镜输入，否则每集都拿全书、镜头跨集重复。
                return send({ ok: true, sourceScript: "全书独有剧情：皇宫大火、边关雪战、深海沉船。" });
            }
            if (req.method === "PATCH" && url === `/drama/episodes/${EP}`) {
                state.episodePatches.push(JSON.parse(body || "{}"));
                return send({ ok: true, episode: { id: EP } });
            }
            if (req.method === "GET" && url === `/drama/episodes/${EP}/production`) return send({ ok: true, production: state.production });
            if (req.method === "POST" && url === `/drama/episodes/${EP}/production/ops`) {
                const parsed = JSON.parse(body || "{}");
                const ops = (parsed.ops || []) as Array<Record<string, any>>;
                state.opsBatches.push(ops);
                if (state.failOps) return send({ ok: false, error: "INVALID_OPERATION: 模拟写稿失败" }, 400);
                for (const op of ops) {
                    if (op.type === "set_director_production") state.production.draft.director = structuredClone(op.director);
                    if (op.type === "replace_director_scene_storyboard") {
                        const source = state.production.draft.director.source;
                        source.shots = (op.shots as any[]).map((shot) => ({ ...shot }));
                        source.segments = (op.segments as any[]).map((seg) => ({ ...seg }));
                    }
                }
                state.production = { ...state.production, revision: state.production.revision + 1 };
                return send({ ok: true, production: state.production });
            }
            if (req.method === "POST" && url === `/drama/episodes/${EP}/production/publish`) {
                state.promoteCalls.push("publish"); return send({ ok: true, publishedVersion: 1 });
            }
            if (req.method === "POST" && url === `/drama/episodes/${EP}/production/compile`) {
                state.promoteCalls.push("compile"); return send({ ok: true, compilation: { operationId: "compile-1" } });
            }
            if (req.method === "GET" && url.startsWith(`/drama/episodes/${EP}/production/compilations/`)) {
                return send({ ok: true, compilation: { status: "succeeded", nextAction: { input: { preparedId: "prepared-1" } } } });
            }
            if (req.method === "POST" && url === `/drama/episodes/${EP}/production/apply-compilation`) {
                state.promoteCalls.push("apply"); return send({ ok: true });
            }
            if (req.method === "GET" && url === `/drama/episodes/${EP}/production/readiness`) {
                const targets = (state.production.draft.director.source.segments || []).map((seg: any) => ({ kind: "segment", id: String(seg.id), status: "ready" }));
                return send({ ok: true, readiness: { targets } });
            }
            if (req.method === "POST" && url === `/drama/episodes/${EP}/production/prepare-targets`) {
                const parsed = JSON.parse(body || "{}");
                state.promoteCalls.push(`prepare:${(parsed.targets || []).join(",")}`); return send({ ok: true });
            }
            if (req.method === "POST" && url === `/drama/episodes/${EP}/production/sync-clips`) {
                state.promoteCalls.push("sync"); return send({ ok: true });
            }
            if (req.method === "POST" && url === "/canvas/generation") {
                const parsed = JSON.parse(body || "{}");
                state.generationPrompts.push(String(parsed.prompt || ""));
                return send({ ok: true, taskId: "task-storyboard-1" });
            }
            if (req.method === "GET" && url === "/tasks/task-storyboard-1") {
                return send({ ok: true, task: { status: "succeeded", result: { texts: [{ content: NEW_DEMAND }] } } });
            }
            return send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const p = new DramaPipeline({ store, token: "t", baseUrl: `http://127.0.0.1:${port}`, resolveTextModel: () => "test-text-model" });
    // 单测只验作业重置与指令透传，不让 wake 起的调度循环真的去 claim/execute（否则会干扰计数）。
    (p as any).wake = () => {};

    return {
        p, store, state,
        close: async () => {
            p.stop();
            store.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("已有镜头时分集仍重拆：清旧镜 + 新 shots/segments 数量与内容都变，并指令透传", async () => {
    const f = await fixture();
    try {
        const result = await (f.p as any).runScript(EP, DRAMA, { instruction: "按新原文改编", model: "plan-model-x" });
        // 1) 不再 skipped：返回的是新拆镜数量（3 镜 / 多段），不是旧镜数量。
        assert.equal(result.skipped, undefined);
        assert.equal(result.shots, 3);
        assert.ok(result.segments >= 2, "新稿段数与原 1 段不同，证明绕开了 Clip ID 集合约束");
        // 2) synopsis=proposal.synopsis，fullPlot=分场正文（不是只写 synopsis）。
        assert.equal(f.state.episodePatches.length, 1);
        assert.equal(f.state.episodePatches[0].synopsis, "新稿梗概");
        assert.equal(String(f.state.episodePatches[0].fullPlot).includes("新稿分场正文"), true);
        // 3) 指令透传进 script-proposal。
        assert.ok(String(f.state.proposalBodies[0].instruction).includes("按新原文改编"));
        assert.equal(f.state.proposalBodies[0].model, "plan-model-x");
        // 4) 写稿批次第一个 op 是清空旧镜，随后才是 replace；同一批次原子。
        const batch = f.state.opsBatches[0];
        assert.equal(batch[0].type, "set_director_production");
        assert.deepEqual(batch[0].director.source.shots, []);
        assert.deepEqual(batch[0].director.source.segments, []);
        assert.equal(batch[1].type, "replace_director_scene_storyboard");
        const newShots = batch[1].shots as Array<Record<string, unknown>>;
        assert.equal(newShots.length, 3);
        assert.ok(newShots.every((shot) => String(shot.id) !== OLD_SHOT), "旧镜 ID 不再复用");
        assert.ok(newShots.some((shot) => String(shot.visual).includes("新稿镜头甲")), "新镜内容来自新稿");
        assert.notEqual((batch[1].segments as Array<Record<string, unknown>>)[0].id, OLD_SEG, "新 Clip ID，段数可与旧的不同");
        // 5) 画布同步链真跑到底：sync-clips 用新段 ID。
        assert.ok(f.state.promoteCalls.includes("publish"));
        assert.ok(f.state.promoteCalls.includes("compile"));
        assert.ok(f.state.promoteCalls.includes("apply"));
        assert.ok(f.state.promoteCalls.includes("sync"));
        const prepare = f.state.promoteCalls.find((c) => c.startsWith("prepare:")) || "";
        const newSegIds = (batch[1].segments as Array<Record<string, unknown>>).map((seg) => String(seg.id));
        assert.ok(newSegIds.every((id) => prepare.includes(id)), "准备节点用的是重拆后的新 Clip");
    } finally { await f.close(); }
});

test("写稿失败时不进入画布同步链：清旧与写新在同一批次，失败整批回滚不会半写", async () => {
    const f = await fixture();
    try {
        f.state.failOps = true;
        await assert.rejects(() => (f.p as any).runScript(EP, DRAMA, {}), /INVALID_OPERATION|模拟写稿失败|HTTP 400/);
        assert.equal(f.state.opsBatches.length, 1, "只有一次原子写稿请求");
        const batch = f.state.opsBatches[0];
        assert.equal(batch[0].type, "set_director_production");
        assert.equal(batch[1].type, "replace_director_scene_storyboard", "清与写同批，后端整批原子");
        assert.equal(f.state.promoteCalls.length, 0, "写稿失败后不发布/编译/同步画布");
    } finally { await f.close(); }
});

test("rescript 幂等重置本集全部作业，script payload 保留 instruction/model，重复调用不堆作业", async () => {
    const f = await fixture();
    try {
        const stages = ["script", "assets", "prompts", "video", "render"];
        for (const stage of stages) {
            f.store.enqueue({ id: `${DRAMA}:${EP}:${stage}`, dramaId: DRAMA, episodeId: EP, kind: stage as any, stage, dedupeKey: `${DRAMA}:${EP}:${stage}`, payload: { episodeId: EP } });
        }
        f.store.fail(`${DRAMA}:${EP}:${stages[0]}`, "旧失败");
        const first = await (f.p as any).rescript(EP, { instruction: "写作技能要点", model: "plan-model-x" });
        assert.equal(first.resetJobs, 5);
        const after = f.store.listJobs(DRAMA).filter((j) => j.episode_id === EP);
        assert.equal(after.length, 5, "重复编排不堆重复作业");
        assert.ok(after.every((j) => j.status === "queued"), "全部阶段重置为 queued");
        const scriptJob = after.find((j) => j.stage === "script")!;
        const payload = f.store.jobPayload(scriptJob);
        assert.equal(payload.instruction, "写作技能要点");
        assert.equal(payload.model, "plan-model-x");
        assert.equal(String(scriptJob.error || ""), "", "旧错误被清掉");
        assert.equal(Number(scriptJob.attempt), 0, "attempt 归零");
        assert.equal(String(f.store.get(DRAMA)?.status), "running", "改编强制流水线 running");
        const second = await (f.p as any).rescript(EP, { instruction: "写作技能要点" });
        assert.equal(second.resetJobs, 5);
        assert.equal(f.store.listJobs(DRAMA).filter((j) => j.episode_id === EP).length, 5, "幂等：第二次仍是 5 条");
    } finally { await f.close(); }
});

test("结构化引用随拆镜落库：ops 带 characters/shotInputs.assetIds，编造 id 被白名单过滤", async () => {
    const f = await fixture();
    try {
        await (f.p as any).runScript(EP, DRAMA, {});
        // 提示词注入了注册表/道具清单
        const storyboardPrompt = f.state.generationPrompts.join("\n");
        assert.ok(storyboardPrompt.includes("CHAR-DAOKE｜刀客"), "提示词含角色清单");
        assert.ok(storyboardPrompt.includes("PROP-DAO｜长刀"), "提示词含道具清单");
        // 写稿批次的 replace op 带结构化引用
        const batch = f.state.opsBatches[0];
        const replace = batch.find((op) => op.type === "replace_director_scene_storyboard")!;
        const shots = replace.shots as Array<Record<string, any>>;
        assert.equal(shots.length, 3);
        assert.deepEqual(shots[0].characters, ["CHAR-DAOKE"]);
        assert.deepEqual(shots[1].characters, ["CHAR-SHAONIAN", "CHAR-DAOKE"], "非法 id 丢弃、重复去重、保序");
        assert.equal(shots[2].characters, undefined, "只有编造 id 的镜头不带空 characters 字段");
        for (const shot of shots) {
            assert.equal(shot.scene_id, ENV, "scene_id 必须是 environmentId");
            assert.equal(Object.hasOwn(shot, "assetIds"), false);
        }
        const inputs = replace.shotInputs as Record<string, { assetIds: string[]; keyframePolicy: string }>;
        const ids = shots.map((shot) => String(shot.id));
        assert.deepEqual(Object.keys(inputs).sort(), [...ids].sort());
        assert.deepEqual(inputs[ids[0]].assetIds, ["PROP-DAO"]);
        assert.deepEqual(inputs[ids[1]].assetIds, ["PROP-DAO"], "编造的 PROP-FAKE 被过滤，合法的 PROP-DAO 保留");
        assert.deepEqual(inputs[ids[2]].assetIds, []);
        for (const id of ids) assert.equal(inputs[id].keyframePolicy, "none");
    } finally { await f.close(); }
});

test("无本集章节映射时拆镜不注入整份 sourceScript（避免跨集重复镜头）", async () => {
    const f = await fixture({ emptyChapters: true });
    try {
        await (f.p as any).runScript(EP, DRAMA, {});
        const prompts = f.state.generationPrompts.join("\n");
        assert.ok(!prompts.includes("皇宫大火"), "拆镜提示词不得含全书独有剧情");
        assert.ok(!prompts.includes("边关雪战"), "拆镜提示词不得含别集剧情");
        assert.ok(!prompts.includes("深海沉船"), "拆镜提示词不得含别集剧情");
        assert.ok(f.state.opsBatches.length > 0, "没有原文时仍用本集分场文本正常拆镜");
    } finally { await f.close(); }
});

test("真实 scene-storyboard 校验：不清空会撞 Clip 集合约束，清空后不同 Clip 数可整批写回", () => {
    const example = productionOperationContract("set_director_production").operations[0].example;
    assert.equal(example.type, "set_director_production");
    if (example.type !== "set_director_production") throw new Error("fixture");
    const director = structuredClone(example.director) as any;
    director.source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        script_scenes: [{ id: "SC1", scene_id: ENV, scene_name: "山神庙", text: "旧稿", beat_ids: ["B1"] }],
        scene_registry: [{ id: ENV, name: "山神庙" }],
        subject_registry: [], character_registry: [], asset_plan: [], asset_cards: [],
        shots: [{ id: OLD_SHOT, source_scene_id: "SC1", scene_id: ENV, timeline_id: "main", story_order: 0, duration_frames: 96 }],
        segments: [{ id: OLD_SEG, shot_ids: [OLD_SHOT], mode: "T2VA" }],
        utterances: [],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] },
    };
    const replacement = {
        sceneId: "SC1",
        shots: ["NEW-1", "NEW-2", "NEW-3"].map(id => ({ id, source_scene_id: "SC1", scene_id: ENV, duration_frames: 96 })),
        segments: [
            { id: "NEW-SEG-A", shot_ids: ["NEW-1", "NEW-2"], mode: "T2VA" },
            { id: "NEW-SEG-B", shot_ids: ["NEW-3"], mode: "T2VA" },
        ],
        shotInputs: Object.fromEntries(["NEW-1", "NEW-2", "NEW-3"].map(id => [id, { keyframePolicy: "none", assetIds: [] }])),
    };
    // 不清空：新 Clip ID 集合与旧的不同 → 后端硬约束拒绝（这正是旧代码跳过重拆的原因）。
    assert.throws(() => replaceDirectorSceneStoryboard(structuredClone(director), replacement as any), /SCENE_STORYBOARD_SEGMENTS/);
    // 清空本场 shots/segments 后，同样草案被接受，Clip 数可从 1 变 2。
    const cleared = structuredClone(director);
    cleared.source.shots = [];
    cleared.source.segments = [];
    replaceDirectorSceneStoryboard(cleared, replacement as any);
    assert.deepEqual((cleared.source.shots as any[]).map(s => s.id), ["NEW-1", "NEW-2", "NEW-3"]);
    assert.deepEqual((cleared.source.segments as any[]).map(s => s.id), ["NEW-SEG-A", "NEW-SEG-B"]);
});
