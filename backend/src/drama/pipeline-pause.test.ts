/**
 * 暂停语义集成测试（不触发真实生成）：
 * - queued 作业保持 queued（不删除、不改 dedupe），resume 后能被重新领取；
 * - running 作业被退回 queued + error=paused_by_user（可恢复，不写 succeeded/failed）；
 * - 本剧画布上的 running/queued 生成任务收到既有 POST /tasks/:id/cancel（mock 记录）；
 * - 连续 pause 幂等，不重复取消同一任务；
 * - 取消失败逐个记日志，不静默吞掉。
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

async function fixture(initialTasks: Array<{ id: string; status: "running" | "queued" }>, options?: { failCancel?: boolean }): Promise<Fixture> {
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
            if (options?.failCancel) return send({ ok: false, error: "执行器取消失败" }, 500);
            const current = tasks.get(id);
            if (current !== "running" && current !== "queued") return send({ ok: false, error: `任务状态 ${current ?? "missing"} 不可取消` }, 409);
            tasks.set(id, "cancelled");
            return send({ ok: true, task: { id, status: "cancelled" } });
        }
        // Agent 侧成片合成任务走独立取消路由（/tasks/:id/cancel 查不到它）。
        const agentCancel = url.match(/^\/agent\/video-concat\/tasks\/([^/]+)\/cancel$/);
        if (req.method === "POST" && agentCancel) {
            const id = decodeURIComponent(agentCancel[1]);
            agentCancels.push(id);
            tasks.set(id, "cancelled");
            return send({ ok: true, task: { id, status: "cancelled" } });
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

test("pause：停派发 + 在跑作业退回可恢复排队 + 取消在跑画布任务；resume 后可重新派发", async () => {
    const f = await fixture([{ id: "task-running", status: "running" }]);
    try {
        seedJobs(f.store);
        const report = await f.pipeline.pause(DRAMA);

        assert.equal(report.pausedJobs, 1, "1 个 running 作业应退回 queued");
        assert.equal(report.canceledTasks, 1, "1 个在跑画布任务应收到取消");
        assert.equal(report.failedTasks, 0);
        assert.deepEqual(f.cancels, ["task-running"], "取消走既有 POST /tasks/:id/cancel");

        const running = f.store.job("job-video")!;
        assert.equal(running.status, "queued", "running 作业必须可恢复（queued），不能写 succeeded/failed");
        assert.equal(running.error, "paused_by_user");
        assert.equal(running.attempt, 0, "取消不是失败，不消耗 attempt");

        const queued = f.store.job("job-script")!;
        assert.equal(queued.status, "queued", "已排队作业保持 queued");
        assert.equal(queued.error, null);

        const row = f.store.get(DRAMA)!;
        assert.equal(row.status, "paused");
        assert.equal(row.pause_reason, "manual");

        const status = f.pipeline.status(DRAMA) as Record<string, any>;
        assert.equal(status.pause.paused, true);
        assert.equal(status.pause.reason, "manual");
        assert.equal(status.pause.lastResult.canceledTasks, 1, "status 能看出取消了多少在跑任务");
        assert.equal(status.totals.failed, undefined, "暂停不得产生 failed 作业");
        assert.equal(status.totals.succeeded, undefined);

        // 连续暂停幂等：不报错、不重复取消同一任务。
        const second = await f.pipeline.pause(DRAMA);
        assert.equal(second.pausedJobs, 0);
        assert.equal(second.canceledTasks, 0);
        assert.deepEqual(f.cancels, ["task-running"], "同一任务不得重复取消");

        f.pipeline.resume(DRAMA);
        assert.equal(f.store.get(DRAMA)!.status, "running", "resume 恢复 running");
        // resume 后调度器真的会领取排队作业（只替换 launchJob，避免触发真实生成）。
        const launched: string[] = [];
        (f.pipeline as any).launchJob = (_pipeline: unknown, job: { id: string }) => { launched.push(job.id); };
        (f.pipeline as any).dispatch(f.store.get(DRAMA)!);
        assert.deepEqual(launched, ["job-script"], "resume 后 queued 作业被重新派发");
        assert.equal(f.store.job("job-script")!.status, "running");
    } finally { await f.close(); }
});

test("pause：render 合成长任务走 Agent 合成取消路由，不误用画布任务取消", async () => {
    const f = await fixture([]);
    try {
        f.store.enqueue({ id: "job-render", dramaId: DRAMA, episodeId: "ep-pause", kind: "render", stage: "render", priority: 0, dedupeKey: `${DRAMA}:ep-pause:render` });
        const claimed = f.store.claimById("job-render");
        assert.ok(claimed);
        f.store.markRunning(claimed.id, "task-concat");
        const report = await f.pipeline.pause(DRAMA);
        assert.equal(report.canceledTasks, 1);
        assert.deepEqual(f.cancels, [], "Agent 任务不在画布 /tasks 表里");
        assert.deepEqual(f.agentCancels, ["task-concat"], "走 /agent/video-concat/tasks/:id/cancel");
        assert.equal(f.store.job("job-render")!.status, "queued");
        assert.equal(f.store.job("job-render")!.error, "paused_by_user");
    } finally { await f.close(); }
});

test("pause：本剧画布上排队的生成任务也走取消接口，并计入 canceledQueuedTasks", async () => {
    const f = await fixture([
        { id: "task-running", status: "running" },
        { id: "task-queued", status: "queued" },
    ]);
    try {
        seedJobs(f.store);
        const report = await f.pipeline.pause(DRAMA);
        assert.equal(report.canceledTasks, 2);
        assert.equal(report.canceledQueuedTasks, 1, "排队中的画布任务单独计数");
        assert.ok(f.cancels.includes("task-queued"));
        assert.ok(f.cancels.includes("task-running"));
    } finally { await f.close(); }
});

test("pause：取消失败逐条记日志（不静默吞掉）并如实计入 failedTasks", async () => {
    const f = await fixture([{ id: "task-running", status: "running" }], { failCancel: true });
    try {
        seedJobs(f.store);
        const report = await f.pipeline.pause(DRAMA);
        assert.ok(report.failedTasks >= 1, "取消失败必须计入摘要");
        assert.equal(report.canceledTasks, 0);
        const logs = f.store.logs(DRAMA, 50).map(item => String(item.message || ""));
        assert.ok(logs.some(message => message.includes("取消") && message.includes("失败")), "取消失败应有日志");
    } finally { await f.close(); }
});

test("HTTP：POST /pipeline/pause 返回暂停摘要，GET /pipeline/status 能看到暂停原因与取消数", async () => {
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
            assert.equal(paused.canceledTasks, 1, "暂停响应带取消结果摘要");
            assert.equal(paused.pausedJobs, 1);
            const status = await (await fetch(`${base}/drama/${DRAMA}/pipeline/status`)).json() as Record<string, any>;
            assert.equal(status.ok, true);
            assert.equal(status.pause.paused, true);
            assert.equal(status.pause.reason, "manual");
            assert.equal(status.pause.lastResult.canceledTasks, 1);
            const alias = await (await fetch(`${base}/drama/${DRAMA}/pipeline`)).json() as Record<string, any>;
            assert.equal(alias.pause.paused, true, "GET /drama/:id/pipeline 与 status 同源");
            assert.equal(alias.pause.lastResult.canceledTasks, 1);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    } finally { await f.close(); }
});
