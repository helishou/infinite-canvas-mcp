/**
 * 作业 runtimeTaskId 投影测试（不触发真实生成，不接真实网络）：
 * - GET /drama/:id/pipeline/status 的 jobs[] 每项带 runtimeTaskId（= job.task_id，缺失为 null），旧字段不变；
 * - 未处于 running 的作业（queued / 旧作业）runtimeTaskId 为 null，不伪造；
 * - 文本任务（generateText）与资产参考图任务（generateAssetReference）拿到 taskId 后调用
 *   markRunning(jobId, taskId) 写回所属作业；不传 jobId（手动重写路由无作业行）时不得写。
 * DramaPipeline / PipelineStore 是真代码；store 用临时库或只记录调用的桩，不调模型。
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

const DRAMA = "drama-task-id";

type Fixture = { pipeline: DramaPipeline; store: PipelineStore; close: () => void };

function fixture(): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-task-id-"));
    const file = path.join(dir, "runtime.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec(DRAMA_PIPELINE_DDL);
    seed.close();
    const store = new PipelineStore(file);
    const pipeline = new DramaPipeline({
        store, token: "test-token", baseUrl: "http://127.0.0.1:9",
        resolveTextModel: () => "test-text-model",
        resolveImageModel: () => "test-image-model",
    });
    store.upsert({ dramaId: DRAMA, status: "running", reviewMode: "auto", mediaMode: "auto" });
    return {
        pipeline, store,
        close: () => {
            pipeline.stop();
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

const jobOf = (status: Record<string, any>, id: string): Record<string, any> => {
    const job = (status.jobs as Array<Record<string, any>>).find(item => item.id === id);
    assert.ok(job, `status.jobs 里应有 ${id}`);
    return job!;
};

test("status 投影：running 作业 runtimeTaskId=task_id，queued/旧作业为 null，旧字段不变", () => {
    const f = fixture();
    try {
        for (const id of ["job-running", "job-queued", "job-old"]) {
            f.store.enqueue({ id, dramaId: DRAMA, episodeId: "ep-tid", kind: "script", stage: "script", priority: 3, dedupeKey: `${DRAMA}:ep-tid:${id}` });
        }
        // 未领取（仍 queued）时 markRunning 不得写 task_id：作业状态没变，runtimeTaskId 保持 null。
        f.store.markRunning("job-queued", "task-should-not-land");
        const claimed = f.store.claimById("job-running");
        assert.ok(claimed, "job-running 应可认领");
        f.store.markRunning(claimed.id, "task-script-1");

        const status = f.pipeline.status(DRAMA) as Record<string, any>;
        const running = jobOf(status, "job-running");
        assert.equal(running.runtimeTaskId, "task-script-1", "running 作业透出自己派生的 taskId");
        assert.equal(running.stage, "script");
        assert.equal(jobOf(status, "job-queued").runtimeTaskId, null, "queued 作业不得带上未生效的 task_id");
        assert.equal(jobOf(status, "job-old").runtimeTaskId, null, "旧作业 task_id 为空 → null，不伪造");

        // 旧字段不破坏。
        for (const job of status.jobs as Array<Record<string, any>>) {
            assert.ok("createdAt" in job && "startedAt" in job && "finishedAt" in job && "durationMs" in job);
            assert.equal(job.episodeId, "ep-tid");
            assert.equal(typeof job.attempt, "number");
            assert.ok("error" in job);
        }
    } finally { f.close(); }
});

/** 只记录 markRunning 调用的假 store + 假 HTTP：覆盖 generateText / generateAssetReference 两条写回路径。 */
function stubPipeline() {
    const marks: Array<{ id: string; taskId: string | null }> = [];
    const store = {
        all: () => [],
        approvalTargets: () => [],
        log: () => {},
        markRunning: (id: string, taskId: string | null) => { marks.push({ id, taskId }); },
    } as any;
    const pipeline = new DramaPipeline({
        store, token: "test-token", baseUrl: "http://127.0.0.1:9",
        resolveTextModel: () => "test-text-model",
    });
    (pipeline as any).request = async (method: string, url: string) => {
        if (method === "POST" && url === "/canvas/generation") return { taskId: "task-1" };
        if (method === "GET" && url.startsWith("/tasks/")) {
            return { task: { status: "succeeded", result: { texts: [{ content: "拆分结果" }], media: [{ storageKey: "image:asset" }] } } };
        }
        return {};
    };
    (pipeline as any).chargeGeneration = () => {};
    return { pipeline, marks };
}

test("generateText：带 jobId 写回 markRunning，不带 jobId 不写（手动重写无作业行）", async () => {
    const { pipeline, marks } = stubPipeline();
    const text = await (pipeline as any).generateText("提示词", undefined, "drama-1", "job-script");
    assert.equal(text, "拆分结果");
    assert.deepEqual(marks, [{ id: "job-script", taskId: "task-1" }], "文本任务拿到 taskId 后写回所属作业");

    await (pipeline as any).generateText("提示词", undefined, "drama-1");
    assert.equal(marks.length, 1, "没有作业归属时不得凭空写 task_id");
});

test("generateAssetReference：生图任务拿到 taskId 后写回 assets 作业（多图覆盖为最新一张）", async () => {
    const { pipeline, marks } = stubPipeline();
    const nodes = [{ id: "production-entity-ep-1-character-A", type: "character", title: "甲",
        metadata: { productionEntity: { entityId: "entity-A" }, characterName: "甲" } }];
    const key = await (pipeline as any).generateAssetReference("ep-1", "canvas-1", nodes,
        { assetId: "asset-A", kind: "character", name: "甲", entityId: "entity-A", prompt: "参考图" }, "image-model",
        "1k", "drama-1", "job-assets");
    assert.equal(key, "image:asset");
    assert.deepEqual(marks, [{ id: "job-assets", taskId: "task-1" }], "生图子任务写回 assets 作业");
});
