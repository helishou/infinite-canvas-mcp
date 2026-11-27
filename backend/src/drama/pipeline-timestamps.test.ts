/**
 * 作业真实时间投影测试（不触发真实生成）：
 * - GET /drama/:id/pipeline/status 与 /pipeline 的 jobs[] 必须带 createdAt/startedAt/finishedAt/durationMs；
 * - durationMs 由 DB 的 finished_at-started_at 计算；缺 finished_at（在跑/排队）为 null，不猜；
 * - 旧字段（id/stage/kind/status/attempt/episodeId/error）保持不变；
 * - DB 行是 snake_case，只在 status() 投影处转 camelCase，不改 schema。
 * DramaPipeline / PipelineStore 是真代码；DB 用临时库，不接任何真实网络。
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

const DRAMA = "drama-timestamps";

type Fixture = { pipeline: DramaPipeline; store: PipelineStore; raw: DatabaseSync; close: () => void };

function fixture(): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-timestamps-"));
    const file = path.join(dir, "runtime.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec(DRAMA_PIPELINE_DDL);
    seed.close();
    const store = new PipelineStore(file);
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA busy_timeout = 5000;");
    const pipeline = new DramaPipeline({
        store, token: "test-token", baseUrl: "http://127.0.0.1:9",
        resolveTextModel: () => "test-text-model",
        resolveImageModel: () => "test-image-model",
    });
    store.upsert({ dramaId: DRAMA, status: "running", reviewMode: "auto", mediaMode: "auto" });
    return {
        pipeline, store, raw,
        close: () => {
            pipeline.stop();
            raw.close();
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** 造 3 条作业：succeeded（有时间）、running（只有 started_at）、queued（都没有）。 */
function seedJobs(store: PipelineStore): void {
    for (const id of ["job-done", "job-running", "job-queued"]) {
        store.enqueue({ id, dramaId: DRAMA, episodeId: "ep-ts", kind: "video", stage: "video", priority: 3, dedupeKey: `${DRAMA}:ep-ts:${id}` });
    }
    const done = store.claimById("job-done");
    assert.ok(done, "job-done 应可认领");
    store.markRunning(done.id, "task-done");
    store.succeed(done.id, { ok: true });
    const running = store.claimById("job-running");
    assert.ok(running, "job-running 应可认领");
    store.markRunning(running.id, "task-running");
}

const jobOf = (status: Record<string, any>, id: string): Record<string, any> => {
    const job = (status.jobs as Array<Record<string, any>>).find(item => item.id === id);
    assert.ok(job, `status.jobs 里应有 ${id}`);
    return job!;
};

test("status 投影：job 带 createdAt/startedAt/finishedAt/durationMs，旧字段不变", () => {
    const f = fixture();
    try {
        seedJobs(f.store);
        const status = f.pipeline.status(DRAMA) as Record<string, any>;

        const done = jobOf(status, "job-done");
        assert.equal(done.status, "succeeded");
        assert.equal(typeof done.createdAt, "string");
        assert.equal(typeof done.startedAt, "string");
        assert.equal(typeof done.finishedAt, "string");
        assert.equal(done.durationMs, Date.parse(done.finishedAt) - Date.parse(done.startedAt), "durationMs = finishedAt - startedAt");
        assert.ok(Number.isFinite(done.durationMs) && done.durationMs >= 0);
        // durationMs 无需再减 timezone 偏移：两端同为 ISO UTC 串。
        assert.ok(done.durationMs < 60_000, "刚跑完的作业不应出现分钟级假值");

        const running = jobOf(status, "job-running");
        assert.equal(running.status, "running");
        assert.equal(typeof running.startedAt, "string");
        assert.equal(running.finishedAt, null, "在跑作业没有 finished_at");
        assert.equal(running.durationMs, null, "缺 finished_at 时 durationMs=null，不能拿集维度聚合凑数");

        const queued = jobOf(status, "job-queued");
        assert.equal(queued.status, "queued");
        assert.equal(typeof queued.createdAt, "string");
        assert.equal(queued.startedAt, null);
        assert.equal(queued.finishedAt, null);
        assert.equal(queued.durationMs, null);

        // 旧字段不破坏：id/stage/kind/status/attempt/episodeId/error 全部照旧。
        for (const job of status.jobs as Array<Record<string, any>>) {
            assert.equal(job.stage, "video");
            assert.equal(job.kind, "video");
            assert.equal(job.episodeId, "ep-ts");
            assert.equal(typeof job.attempt, "number");
            assert.ok("error" in job);
        }
    } finally { f.close(); }
});

test("status 投影：durationMs 用固定 created_at/started_at/finished_at 计算，异常区间给 null", () => {
    const f = fixture();
    try {
        seedJobs(f.store);
        const setTimes = (id: string, startedAt: string | null, finishedAt: string | null) => {
            f.raw.prepare("UPDATE drama_pipeline_jobs SET started_at=?, finished_at=? WHERE id=?").run(startedAt, finishedAt, id);
        };

        setTimes("job-done", "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:30.000Z");
        const status = f.pipeline.status(DRAMA) as Record<string, any>;
        const done = jobOf(status, "job-done");
        assert.equal(done.startedAt, "2026-01-01T00:00:00.000Z");
        assert.equal(done.finishedAt, "2026-01-01T00:01:30.000Z");
        assert.equal(done.durationMs, 90_000, "精确 90 秒");

        // finished_at 早于 started_at（时钟回拨/脏数据）→ null，不给负数。
        setTimes("job-done", "2026-01-01T00:02:00.000Z", "2026-01-01T00:01:00.000Z");
        assert.equal(jobOf(f.pipeline.status(DRAMA) as Record<string, any>, "job-done").durationMs, null);

        // 只有 started_at（在跑）→ null。
        setTimes("job-done", "2026-01-01T00:05:00.000Z", null);
        const running = jobOf(f.pipeline.status(DRAMA) as Record<string, any>, "job-done");
        assert.equal(running.finishedAt, null);
        assert.equal(running.durationMs, null);

        // 两端都清空（重排队）→ 三个字段都在但没有 durationMs 假值。
        setTimes("job-done", null, null);
        const cleared = jobOf(f.pipeline.status(DRAMA) as Record<string, any>, "job-done");
        assert.equal(cleared.startedAt, null);
        assert.equal(cleared.finishedAt, null);
        assert.equal(cleared.durationMs, null);
        assert.equal(typeof cleared.createdAt, "string", "created_at 始终存在");
    } finally { f.close(); }
});

test("重新入队的作业取新的 created_at，不再占旧 FIFO 槽位", () => {
    const f = fixture();
    try {
        for (const id of ["retried", "fresh"]) {
            f.store.enqueue({ id, dramaId: DRAMA, episodeId: "ep-ts", kind: "video", stage: "video", priority: 3, dedupeKey: `${DRAMA}:ep-ts:${id}` });
        }
        // retried 是更早提交但失败重试的作业；fresh 是后来提交的作业。
        f.raw.prepare("UPDATE drama_pipeline_jobs SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", "retried");
        f.raw.prepare("UPDATE drama_pipeline_jobs SET created_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", "fresh");
        assert.deepEqual(f.store.listJobs(DRAMA, ["queued"]).map((job) => job.id), ["retried", "fresh"]);

        f.store.requeueForRetry("retried");
        const after = f.store.listJobs(DRAMA, ["queued"]);
        assert.deepEqual(after.map((job) => job.id), ["fresh", "retried"], "重试后排到真正后提交的作业之后");
        const retried = after.find((job) => job.id === "retried")!;
        assert.ok(Date.parse(retried.created_at) > Date.parse("2026-01-01T00:00:00.000Z"), "created_at 是本次重新入队的时间");
        assert.equal(retried.started_at, null);
    } finally { f.close(); }
});

test("HTTP：GET /pipeline/status 与 /pipeline 响应里的 job 带时间字段", async () => {
    const f = fixture();
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
            for (const route of [`/drama/${DRAMA}/pipeline/status`, `/drama/${DRAMA}/pipeline`]) {
                const body = await (await fetch(`${base}${route}`)).json() as Record<string, any>;
                assert.equal(body.ok, true, `${route} 应返回 ok`);
                const job = jobOf(body, "job-done");
                assert.equal(typeof job.createdAt, "string", `${route} 的 job 带 createdAt`);
                assert.equal(typeof job.startedAt, "string", `${route} 的 job 带 startedAt`);
                assert.equal(typeof job.finishedAt, "string", `${route} 的 job 带 finishedAt`);
                assert.equal(job.durationMs, Date.parse(job.finishedAt) - Date.parse(job.startedAt), `${route} 的 durationMs 可算`);
            }
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    } finally { f.close(); }
});
