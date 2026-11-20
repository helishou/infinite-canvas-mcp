/**
 * C4 开工模型门禁单测：缺文本/图片模型拒绝 start 与 resume，点名缺失项；配齐后放行。
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-model-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    return { dir, file };
}

const opts = { reviewMode: "auto" as const, mediaMode: "auto" as const };

test("缺文本+图片模型：start 拒绝开工，点名两类缺失，不落 running 状态", async () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        // 不注入任何 resolve 模型 → 全部为空
        const p = new DramaPipeline({ store, token: "t" });
        try {
            await assert.rejects(() => p.start("d1", opts), (e: Error) => {
                assert.match(e.message, /PIPELINE_MODEL_MISSING/);
                assert.match(e.message, /文本/);
                assert.match(e.message, /图片/);
                return true;
            });
            assert.equal(store.get("d1"), undefined, "被拒后不创建 running 流水线");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("配齐文本+图片模型：start 放行，resume 也放行", async () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({
            store, token: "t",
            resolveTextModel: () => "text-model-1",
            resolveImageModel: () => "image-model-1",
        });
        try {
            await p.start("d1", opts);
            assert.equal(store.get("d1")?.status, "running");
            assert.doesNotThrow(() => p.resume("d1"));
            assert.equal(store.get("d1")?.status, "running");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("只有图片模型、缺文本：仍拒绝；imageModelsByKind 覆盖可满足图片真值", async () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t", resolveImageModel: () => "image-model-1" });
        try {
            await assert.rejects(() => p.start("d1", opts), /文本/);
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }

    const f2 = fixture();
    try {
        const store = new PipelineStore(f2.file);
        const p = new DramaPipeline({ store, token: "t", resolveTextModel: () => "text-model-1" });
        try {
            // 无默认图片模型，但下发 imageModelsByKind 覆盖 → 图片真值视为已配
            await p.start("d1", { ...opts, options: { imageModelsByKind: { character: "krea2" } } });
            assert.equal(store.get("d1")?.status, "running");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(f2.dir, { recursive: true, force: true }); }
});

test("resume 缺模型时拒绝：paused 流水线不得被裸放行", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        store.upsert({ dramaId: "d1", status: "paused", reviewMode: "auto", mediaMode: "auto", pauseReason: "test" });
        const p = new DramaPipeline({ store, token: "t" }); // 无模型
        try {
            assert.throws(() => p.resume("d1"), /PIPELINE_MODEL_MISSING/);
            assert.equal(store.get("d1")?.status, "paused", "被拒后仍保持 paused");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
