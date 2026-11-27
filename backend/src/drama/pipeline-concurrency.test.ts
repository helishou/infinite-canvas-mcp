/**
 * 影策式单值并发：一个 Concurrency 值，text/image/video/render 四池各自独立计数。
 * 只测设置投影，不触发生成；真 PipelineStore + 临时库，设置通过 runtime_settings 注入。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { DramaPipeline } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

const DRAMA = "drama-concurrency";

function fixture(t: TestContext) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-concurrency-"));
    const file = path.join(dir, "runtime.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec(DRAMA_PIPELINE_DDL);
    seed.close();
    const store = new PipelineStore(file);
    const settings = new Map<string, unknown>();
    const pipeline = new DramaPipeline({
        store, token: "test", baseUrl: "http://127.0.0.1:9", poolLimit: 4,
        settings: { get: (key) => settings.get(key), set: (key, value) => settings.set(key, value) },
    });
    t.after(() => { pipeline.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const limitOf = (dramaId: string, pool: string) => (pipeline as unknown as {
        poolLimitOf: (dramaId: string, pool: string) => number;
    }).poolLimitOf(dramaId, pool);
    store.upsert({ dramaId: DRAMA, status: "running", reviewMode: "auto", mediaMode: "auto" });
    return { settings, limitOf };
}

test("单值并发对四个池都生效（含参考图池）", (t) => {
    const f = fixture(t);
    f.settings.set(`drama.pipeline.options.${DRAMA}`, { concurrency: 3 });
    for (const pool of ["text", "image", "video", "render"]) {
        assert.equal(f.limitOf(DRAMA, pool), 3, `${pool} 池应取同一个并发值`);
    }
});

test("未下发设置回退构造默认；旧三值设置仍按池读取", (t) => {
    const f = fixture(t);
    assert.equal(f.limitOf(DRAMA, "video"), 4);
    f.settings.set(`drama.pipeline.options.${DRAMA}`, { concurrency: { text: 2, video: 1, render: 3 } });
    assert.equal(f.limitOf(DRAMA, "text"), 2);
    assert.equal(f.limitOf(DRAMA, "video"), 1);
    assert.equal(f.limitOf(DRAMA, "render"), 3);
    assert.equal(f.limitOf(DRAMA, "image"), 4, "旧设置没有 image 键，回退默认而不是臆造");
});
