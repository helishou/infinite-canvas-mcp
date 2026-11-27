/**
 * 暂停/继续语义集成测试（对齐影策 drama_orchestrator.go / drama_actions.go，不触发真实生成）：
 * - 暂停只停止派发新作业：running 作业保持 running，画布任务不被取消；
 * - 暂停期间已派发作业照常写回 succeeded/failed（否则段会永远停在生成中）；
 * - resume 只把状态改回 running，不把任何作业退回 queued 重排；
 * - dispatch 在暂停态不领取新作业，resume 后按 stage 派发。
 * DramaPipeline / PipelineStore 是真代码，只把网络边界换成临时 HTTP 替身；DB 用临时库。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { registerDramaPipelineRoutes } from "../server/drama-pipeline-routes.js";
import { DramaPipeline } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供，项目自身不需要该依赖
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}

const DRAMA = "drama-pause";
const CANVAS = "canvas-pause";

type Fixture = {
    pipeline: DramaPipeline;
    store: PipelineStore;
    cancels: string[];
    agentCancels: string[];
    tasks: Map<string, string>;
    close: () => Promise<void>;
};

async function fixture(initialTasks: Array<{ id: string; status: "running" | "queued" }>): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pause-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);
    const cancels: string[] = [];
    const agentCancels: string[] = [];
    const tasks = new Map<string, string>(initialTasks.map(task => [task.id, task.status] as const));

    const server = http.createServer((req, res) => {
        const parsed = new URL(String(req.url || "/"), "http://127.0.0.1");
        const url = parsed.pathname;
        const send = (data: unknown, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
        if (req.method === "GET" && url === `/drama/projects/${DRAMA}/episodes`) {
            return send({ ok: true, episodes: [{ id: "ep-pause", episodeNumber: 1, canvasId: CANVAS }] });
        }
        if (req.method === "GET" && url === "/tasks") {
            const status = parsed.searchParams.get("status");
            if (parsed.searchParams.get("projectId") !== CANVAS || !status) return send({ ok: true, tasks: [] });
            const list = [...tasks].filter(([, value]) => value === status).map(([id]) => ({ id, status, kind: "canvas-h3-run", projectId: CANVAS }));
            return send({ ok: true, tasks: list });
        }
        const cancel = url.match(/^\/tasks\/([^/]+)\/cancel$/);
        if (req.method === "POST" && cancel) {
            const id = decodeURIComponent(cancel[1]);
            cancels.push(id);
            tasks.set(id, "cancelled");
            return send({ ok: true, task: { id, status: "cancelled" } });
        }
        const agentCancel = url.match(/^\/agent\/video-concat\/tasks\/([^/]+)\/cancel$/);
        if (req.method === "POST" && agentCancel) {
            agentCancels.push(decodeURIComponent(agentCancel[1]));
            return send({ ok: true });
        }
        send({ ok: false, error: `unexpected ${req.method} ${url}` }, 404);
    });
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as AddressInfo).port;
    const pipeline = new DramaPipeline({
        store, token: "test-token", baseUrl: `http://127.0.0.1:${port}`,
        resolveTextModel: () => "test-text-model",
        resolveImageModel: () => "test-image-model",
    });
    store.upsert({ dramaId: DRAMA, status: "running", reviewMode: "auto", mediaMode: "auto" });
    return {
        pipeline, store, cancels, agentCancels, tasks,
        close: async () => {
            pipeline.stop();
            await new Promise<void>(resolve => server.close(() => resolve()));
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** 1 个 running job（已认领并绑定 task-running）+ 1 个 queued job。 */
function seedJobs(store: PipelineStore): void {
    store.enqueue({ id: "job-video", dramaId: DRAMA, episodeId: "ep-pause", kind: "video", stage: "video", priority: 3, dedupeKey: `${DRAMA}:ep-pause:video` });
    store.enqueue({ id: "job-script", dramaId: DRAMA, episodeId: "ep-pause", kind: "script", stage: "script", priority: 4, dedupeKey: `${DRAMA}:ep-pause:script` });
    const claimed = store.claimById("job-video");
    assert.ok(claimed, "running job 应能被认领");
    store.markRunning(claimed.id, "task-running");
    assert.equal(store.job("job-video")!.status, "running");
}

test("pause：running 作业保持 running、不取消画布任务、不重排；resume 只恢复状态", async () => {
    const f = await fixture([{ id: "task-running", status: "running" }]);
    try {
        seedJobs(f.store);
        const report = await f.pipeline.pause(DRAMA);

        assert.equal(report.pausedJobs, 0, "不把 running 作业退回 queued");
        assert.equal(report.canceledTasks, 0, "不取消已提交任务");
        assert.deepEqual(f.cancels, [], "暂停不应请求 /tasks/:id/cancel");
        assert.equal(f.store.job("job-video")!.status, "running", "已派发作业保持 running");
        assert.equal(f.store.job("job-script")!.status, "queued", "未派发作业保持 queued");
        assert.equal(f.store.get(DRAMA)!.status, "paused");

        // 暂停态 dispatch 不领取新作业。
        const launched: string[] = [];
        (f.pipeline as any).launchJob = (_pipeline: unknown, job: { id: string }) => { launched.push(job.id); };
        (f.pipeline as any).dispatch(f.store.get(DRAMA)!);
        assert.deepEqual(launched, [], "暂停期间不派发新作业");

        const second = await f.pipeline.pause(DRAMA);
        assert.equal(second.canceledTasks, 0, "连续暂停幂等");

        f.pipeline.resume(DRAMA);
        assert.equal(f.store.get(DRAMA)!.status, "running", "resume 只改状态");
        assert.equal(f.store.job("job-video")!.status, "running", "resume 不重排已在跑的作业");
        (f.pipeline as any).dispatch(f.store.get(DRAMA)!);
        assert.deepEqual(launched, ["job-script"], "resume 后按 stage 派发未开始的作业");
    } finally { await f.close(); }
});

test("暂停期间已派发作业完成仍写回 succeeded（影策 syncJobs 语义）", async () => {
    const f = await fixture([]);
    try {
        seedJobs(f.store);
        const pipeline = f.pipeline as unknown as {
            execute: (job: unknown) => Promise<Record<string, unknown>>;
            launchJob: (pipeline: unknown, job: unknown) => void;
        };
        pipeline.execute = async () => ({ ok: true });
        await f.pipeline.pause(DRAMA);
        pipeline.launchJob(f.store.get(DRAMA)!, f.store.job("job-video")!);
        await new Promise<void>(resolve => setTimeout(resolve, 30));
        assert.equal(f.store.job("job-video")!.status, "succeeded", "暂停不吞掉已派发作业的终态");
        assert.equal(f.store.get(DRAMA)!.status, "paused", "作业回写不改变暂停状态");
    } finally { await f.close(); }
});

test("render 合成任务暂停时不走 Agent 取消路由，作业保持 running", async () => {
    const f = await fixture([]);
    try {
        f.store.enqueue({ id: "job-render", dramaId: DRAMA, episodeId: "ep-pause", kind: "render", stage: "render", priority: 0, dedupeKey: `${DRAMA}:ep-pause:render` });
        const claimed = f.store.claimById("job-render");
        assert.ok(claimed);
        f.store.markRunning(claimed.id, "task-concat");
        const report = await f.pipeline.pause(DRAMA);
        assert.equal(report.canceledTasks, 0);
        assert.deepEqual(f.cancels, []);
        assert.deepEqual(f.agentCancels, [], "不请求 /agent/video-concat/tasks/:id/cancel");
        assert.equal(f.store.job("job-render")!.status, "running");
    } finally { await f.close(); }
});

test("HTTP：POST /pipeline/pause 与 GET /pipeline/status 同源，不再带取消数", async () => {
    const f = await fixture([{ id: "task-running", status: "running" }]);
    try {
        seedJobs(f.store);
        const app = express();
        app.use(express.json());
        registerDramaPipelineRoutes(app as unknown as Parameters<typeof registerDramaPipelineRoutes>[0], f.pipeline);
        const server = await new Promise<http.Server>(resolve => {
            const started = app.listen(0, "127.0.0.1", () => resolve(started));
        });
        try {
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const paused = await (await fetch(`${base}/drama/${DRAMA}/pipeline/pause`, { method: "POST" })).json() as Record<string, any>;
            assert.equal(paused.ok, true);
            assert.equal(paused.canceledTasks, 0, "暂停摘要不再有取消任务");
            const status = await (await fetch(`${base}/drama/${DRAMA}/pipeline/status`)).json() as Record<string, any>;
            assert.equal(status.ok, true);
            assert.equal(status.pause.paused, true);
            assert.equal(status.pause.reason, "manual");
            assert.equal(status.totals.failed, undefined, "暂停不得产生 failed 作业");
            const alias = await (await fetch(`${base}/drama/${DRAMA}/pipeline`)).json() as Record<string, any>;
            assert.equal(alias.pause.paused, true, "GET /drama/:id/pipeline 与 status 同源");
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    } finally { await f.close(); }
});
