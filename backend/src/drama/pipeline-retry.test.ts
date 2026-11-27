/**
 * C3 失败重试分级单测：按 kind 分级统计 + render 合成成功仅写回失败时复用恢复点。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// 双 runner：vitest 验收与项目 node:test runner 共用同一份用例。
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { DramaPipeline } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-retry-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    return { dir, file };
}

function enqueue(store: PipelineStore, id: string, kind: string) {
    store.enqueue({ id, dramaId: "d1", episodeId: "ep1", kind, stage: kind, dedupeKey: id, payload: { episodeId: "ep1", episodeNumber: 1 } });
    store.job(id);
}

test("retryFailed 按 kind 分级统计，requeued 仍为总数（前端兼容）", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "auto", mediaMode: "auto" });
            for (const [id, kind] of [["j1", "script"], ["j2", "prompts"], ["j3", "video"], ["j4", "render"]] as const) {
                enqueue(store, id, kind);
                store.fail(id, "boom");
            }
            const r = p.retryFailed("d1");
            assert.equal(r.requeued, 4);
            assert.equal(r.skippedByLimit, 0);
            assert.deepEqual(r.byKind, { script: 1, prompts: 1, video: 1, render: 1 });
            assert.equal(r.replayedRender, 0, "无恢复点时不算复用");
            assert.equal(store.listJobs("d1", ["queued"]).length, 4, "全部重新入队");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("render 有合成恢复点时 replayedRender 计数，重放无需二次合成", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "auto", mediaMode: "auto" });
            enqueue(store, "jr", "render");
            store.setJobRecovery("jr", { renderRecoveryStorageKey: "final/x.mp4", renderRecoveryTaskId: "task-1" });
            store.fail("jr", "写回制作稿失败");

            const r = p.retryFailed("d1");
            assert.equal(r.replayedRender, 1);
            assert.equal(r.byKind.render, 1);
            // 恢复点仍在 payload（重放 runRender 会直接复用）
            assert.equal(store.jobPayload(store.job("jr")!).renderRecoveryStorageKey, "final/x.mp4");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("setJobRecovery 幂等合并，不覆盖其它 payload 字段", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        try {
            enqueue(store, "j1", "render");
            store.setJobRecovery("j1", { renderRecoveryStorageKey: "k", renderRecoveryTaskId: "task-9" });
            const payload = store.jobPayload(store.job("j1")!);
            assert.equal(payload.renderRecoveryStorageKey, "k");
            assert.equal(payload.renderRecoveryTaskId, "task-9");
            assert.equal(payload.episodeId, "ep1", "已有 payload 字段不被清掉");
        } finally { store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("retryFailed 熔断：attempt 已达硬上限的作业保留 failed，正常作业重置 attempt", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "auto", mediaMode: "auto" });
            // 超额作业：反复 requeue→start→fail 累加 attempt 到 6（模拟历史反复重试）
            enqueue(store, "j_over", "script");
            for (let i = 0; i < 6; i += 1) {
                store.requeue("j_over");
                store.claimById("j_over");
                store.fail("j_over", "反复失败");
            }
            assert.equal(store.job("j_over")!.attempt, 6);
            // 正常作业
            enqueue(store, "j_ok", "video");
            store.fail("j_ok", "偶发失败");

            const r = p.retryFailed("d1");
            assert.equal(r.requeued, 1, "只重排正常作业");
            assert.equal(r.skippedByLimit, 1, "超额作业计入熔断跳过数，供前端说明为何没重排");
            assert.equal(store.job("j_over")!.status, "failed", "超额作业保持 failed 终态");
            assert.equal(store.job("j_ok")!.status, "queued", "正常作业重新入队");
            assert.equal(store.job("j_ok")!.attempt, 0, "重排时 attempt 重置，避免累加触发死锁");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("人工重试熔断作业：重置 attempt 后重新入队，不受硬上限拦截", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "auto", mediaMode: "auto" });
            enqueue(store, "j_manual", "assets");
            store.failCircuit("j_manual", "ATTEMPT_LIMIT_EXCEEDED: assets/assets attempt=15 超过硬上限 6", 6);
            assert.equal(p.retryFailed("d1").requeued, 0, "自动重试仍跳过熔断作业");

            const result = p.retryJobManually("d1", "j_manual");
            assert.equal(result.ok, true);
            assert.equal(store.job("j_manual")!.status, "queued");
            assert.equal(store.job("j_manual")!.attempt, 0, "人工确认必须清零 attempt");
            assert.equal(store.job("j_manual")!.error, null);
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("人工重试拒绝非失败作业与跨剧目作业", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "auto", mediaMode: "auto" });
            enqueue(store, "j_queued", "script");
            assert.throws(() => p.retryJobManually("d1", "j_queued"), /只有失败的作业可以手动重试/);
            assert.throws(() => p.retryJobManually("other", "j_queued"), /不属于该剧本/);
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failCircuit 熔断作业：attempt 顶到硬上限，retryFailed 不捞起", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "auto", mediaMode: "auto" });
            enqueue(store, "j_busy", "video");
            store.claimById("j_busy");
            // 资源占用熔断：顶到硬上限 6
            store.failCircuit("j_busy", "RESOURCE_BUSY_CIRCUIT: H3 Clip 正被任务 xxx 占用", 6);

            assert.equal(store.job("j_busy")!.status, "failed");
            assert.equal(store.job("j_busy")!.attempt, 6, "attempt 被顶到硬上限");
            assert.match(store.job("j_busy")!.error || "", /RESOURCE_BUSY_CIRCUIT/);

            const r = p.retryFailed("d1");
            assert.equal(r.requeued, 0, "熔断作业不被 retryFailed 捞起");
            assert.equal(r.skippedByLimit, 1, "熔断作业必须回报跳过数，不能只返回 0 让前端误报无可重试项");
            assert.equal(store.job("j_busy")!.status, "failed", "保持 failed 终态");
            const statusJobs = p.status("d1").jobs as Array<Record<string, unknown>>;
            assert.equal(statusJobs.find(j => j.id === "j_busy")?.retryExhausted, true, "status 投影应标出需人工介入的终态");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
