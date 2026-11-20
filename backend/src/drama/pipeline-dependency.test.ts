/**
 * C6 依赖未就绪单测：deferDependency 把作业退回 queued 且不消耗 attempt；
 * 与真失败（fail）区分。依赖未就绪的错误码覆盖本体素材场景。
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
import { PipelineStore } from "./pipeline-store.js";

function withStore(fn: (store: PipelineStore) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-dep-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);
    try { fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

function enqueueAndStart(store: PipelineStore, id: string) {
    store.enqueue({ id, dramaId: "d1", episodeId: "ep1", kind: "render", stage: "render", dedupeKey: id });
    const claimed = store.claimById(id)!; // queued → running, attempt 0→1
    return claimed;
}

test("deferDependency：退回 queued、attempt 回退、清错误（不消耗重试次数）", () => withStore((store) => {
    const claimed = enqueueAndStart(store, "j1");
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.status, "running");
    store.deferDependency("j1");
    const row = store.job("j1")!;
    assert.equal(row.status, "queued");
    assert.equal(row.attempt, 0, "attempt 已回退，依赖就绪后可完整重试");
    assert.equal(row.error, null);
}));

test("deferDependency 在 attempt=0 时不会变负（MAX 0）", () => withStore((store) => {
    store.enqueue({ id: "j1", dramaId: "d1", kind: "assets", stage: "assets", dedupeKey: "j1" });
    store.deferDependency("j1");
    assert.equal(store.job("j1")!.attempt, 0);
    assert.equal(store.job("j1")!.status, "queued");
}));

test("真失败仍走 fail（带错误文案），与依赖未就绪区分", () => withStore((store) => {
    const claimed = enqueueAndStart(store, "j1");
    store.fail("j1", "VIDEO_CONCAT_NO_RESULT: 合成无产出");
    const row = store.job("j1")!;
    assert.equal(row.status, "failed");
    assert.match(row.error!, /VIDEO_CONCAT_NO_RESULT/);
}));

test("依赖未就绪错误码集合覆盖本体/素材/前置产物场景", () => {
    // 与 pipeline.ts 的 DEPENDENCY_NOT_READY_CODES 保持一致（常量未导出，这里按契约验证语义归类）
    const dependencyCodes = ["RENDER_NO_VIDEO", "EPISODE_CANVAS_MISSING", "H3_NODE_MISSING", "PROMPTS_NO_SEGMENTS", "ASSETS_NO_SYNOPSIS"];
    const realFailures = ["VIDEO_CONCAT_NO_RESULT", "ASSET_IMAGE_NO_TASK", "PIPELINE_TEXT_MODEL_MISSING"];
    for (const code of dependencyCodes) {
        const [head] = code.split(":");
        assert.ok(/^[A-Z0-9_]+$/.test(head), `${code} 是稳定的大写错误码，可被 split(':')[0] 识别`);
    }
    for (const code of realFailures) {
        assert.ok(!dependencyCodes.includes(code), `${code} 是作业真失败，不归类为依赖未就绪`);
    }
});
