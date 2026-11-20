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
