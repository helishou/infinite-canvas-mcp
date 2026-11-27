/**
 * 逐次尝试记录测试（不触发真实生成）：
 * - fail()/failCircuit() 都要把本次 {at, attempt, error} 追加进 attempts_json，不再只留最终 error；
 * - 顺序为写入顺序（最旧在前），超过 20 条只留最近 20；
 * - 错误沿用 2000 字符截断；
 * - status() 投影的 job.attempts 能读出该数组，解析失败/旧作业给 []，既有键不变。
 * DramaPipeline / PipelineStore 是真代码；DB 用临时库，不接任何真实网络。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
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

const DRAMA = "drama-attempts";
const JOB = "job-attempts";

type Fixture = { pipeline: DramaPipeline; store: PipelineStore; raw: DatabaseSync; close: () => void };

function fixture(): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-attempts-"));
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
    store.enqueue({ id: JOB, dramaId: DRAMA, episodeId: "ep-attempts", kind: "assets", stage: "assets", priority: 3, dedupeKey: `${DRAMA}:ep-attempts:${JOB}` });
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

/** 认领一次（attempt 自增一格）后按普通失败落库。 */
function claimAndFail(store: PipelineStore, id: string, error: string): void {
    assert.ok(store.claimById(id), `${id} 应可认领`);
    store.fail(id, error);
    store.requeue(id);
}

const attemptsOf = (store: PipelineStore, id: string): Array<Record<string, unknown>> => {
    const row = store.job(id);
    assert.ok(row, `应存在作业 ${id}`);
    return JSON.parse(row!.attempts_json) as Array<Record<string, unknown>>;
};

test("fail 两次 + failCircuit 一次：attempts_json 三条且顺序/字段正确", () => {
    const f = fixture();
    try {
        claimAndFail(f.store, JOB, "FIRST_FAIL: 第一次失败");
        claimAndFail(f.store, JOB, "SECOND_FAIL: 第二次失败");

        // 第三次走资源占用熔断（attempt 取硬上限，DB 行也写成该值）。
        assert.ok(f.store.claimById(JOB), "第三次应可认领");
        f.store.failCircuit(JOB, "RESOURCE_BUSY_CIRCUIT: H3 Clip 正被任务 xxx 占用", 6);

        const attempts = attemptsOf(f.store, JOB);
        assert.equal(attempts.length, 3, "每次失败都要留一条，不能只留最终错误");
        assert.deepEqual(attempts.map(item => item.attempt), [1, 2, 6], "按写入顺序记录第几次");
        assert.equal(attempts[0].error, "FIRST_FAIL: 第一次失败");
        assert.equal(attempts[1].error, "SECOND_FAIL: 第二次失败");
        assert.equal(attempts[2].error, "RESOURCE_BUSY_CIRCUIT: H3 Clip 正被任务 xxx 占用");
        for (const item of attempts) {
            assert.equal(typeof item.at, "string", "每条都带时间");
            assert.ok(Number.isFinite(Date.parse(String(item.at))), "时间是可解析的 ISO 串");
        }
        // 时间递增（同毫秒内也允许相等）。
        assert.ok(Date.parse(String(attempts[1].at)) >= Date.parse(String(attempts[0].at)));

        // 终态字段不变：status/error/attempt 仍是熔断后的值。
        const row = f.store.job(JOB)!;
        assert.equal(row.status, "failed");
        assert.equal(row.attempt, 6);
        assert.equal(row.error, "RESOURCE_BUSY_CIRCUIT: H3 Clip 正被任务 xxx 占用");
    } finally { f.close(); }
});

test("失败错误沿用 2000 字符截断，attempts 里与 error 列一致", () => {
    const f = fixture();
    try {
        const long = `LONG_FAIL: ${"x".repeat(3000)}`;
        f.store.claimById(JOB);
        f.store.fail(JOB, long);
        const row = f.store.job(JOB)!;
        assert.equal(row.error.length, 2000);
        const attempts = attemptsOf(f.store, JOB);
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].error, row.error);
    } finally { f.close(); }
});

test("超过 20 条只留最近 20 条，成功记录与失败记录同格式共存", () => {
    const f = fixture();
    try {
        for (let i = 1; i <= 25; i += 1) claimAndFail(f.store, JOB, `FLAKY_${i}: 第 ${i} 次失败`);
        const attempts = attemptsOf(f.store, JOB);
        assert.equal(attempts.length, 20, "最多保留 20 条");
        assert.deepEqual(attempts.map(item => item.attempt), Array.from({ length: 20 }, (_v, i) => i + 6), "保留最近 20 次，最旧在第 6 次");

        // 成功也按同格式追加 {at, attempt, result}：同一作业的每轮尝试共用一套编号，前端不会串号。
        assert.ok(f.store.claimById(JOB), "第 26 次应可认领");
        f.store.succeed(JOB, { storageKey: "assets/ep1.png" });
        const mixed = attemptsOf(f.store, JOB);
        assert.equal(mixed.length, 20, "成功后再追加仍只留 20 条");
        const last = mixed[mixed.length - 1];
        assert.equal(last.attempt, 26, "成功记录带本轮 attempt");
        assert.equal(typeof last.at, "string");
        assert.deepEqual(last.result, { storageKey: "assets/ep1.png" });
    } finally { f.close(); }
});

test("status 投影带 attempts；解析失败/旧作业给 []，既有键不变", () => {
    const f = fixture();
    try {
        claimAndFail(f.store, JOB, "FIRST_FAIL: 第一次失败");
        assert.ok(f.store.claimById(JOB));
        f.store.fail(JOB, "SECOND_FAIL: 第二次失败");

        const jobOf = () => ((f.pipeline.status(DRAMA) as Record<string, any>).jobs as Array<Record<string, any>>).find(item => item.id === JOB)!;
        const job = jobOf();
        assert.ok(Array.isArray(job.attempts), "投影必须有 attempts 数组");
        assert.equal(job.attempts.length, 2);
        assert.equal(job.attempts[1].error, "SECOND_FAIL: 第二次失败");
        assert.equal(job.attempts[1].attempt, 2);
        // 既有键照旧。
        assert.equal(job.stage, "assets");
        assert.equal(job.status, "failed");
        assert.equal(job.error, "SECOND_FAIL: 第二次失败");
        assert.equal(typeof job.attempt, "number");

        // 脏数据/旧作业：解析失败给 []，不让整份 status 崩掉。
        f.raw.prepare("UPDATE drama_pipeline_jobs SET attempts_json=? WHERE id=?").run("not-json{", JOB);
        assert.deepEqual(jobOf().attempts, []);
        f.raw.prepare("UPDATE drama_pipeline_jobs SET attempts_json=? WHERE id=?").run("{}", JOB);
        assert.deepEqual(jobOf().attempts, [], "非数组也给 []");
        f.raw.prepare("UPDATE drama_pipeline_jobs SET attempts_json=? WHERE id=?").run("[]", JOB);
        assert.deepEqual(jobOf().attempts, []);
    } finally { f.close(); }
});
