/**
 * 自动流水线的队列顺序：先按集号，集内按阶段（script→assets→prompts→video→render）。
 * 用临时 SQLite + 真 PipelineStore，不接网络、不触发生成。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { DramaPipeline } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

const DRAMA = "drama-order";
const STAGES = ["script", "assets", "prompts", "video", "render"];

function fixture(t: { after: (fn: () => void) => void }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-order-"));
    const file = path.join(dir, "runtime.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec(DRAMA_PIPELINE_DDL);
    seed.close();
    const store = new PipelineStore(file);
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return store;
}

test("plan：只入队到达阶段的作业，render 要等 video 成功才出现", async (t) => {
    const store = fixture(t);
    const pipeline = new DramaPipeline({ store, token: "t" });
    (pipeline as unknown as { request: (method: string, path: string) => Promise<unknown> }).request = async (_method, urlPath) => {
        if (urlPath.includes("/stage")) return { states: [] };
        if (urlPath.includes("/episodes")) return { episodes: [{ id: "ep1", episodeNumber: 1 }] };
        return {};
    };
    store.upsert({ dramaId: DRAMA, status: "running", reviewMode: "auto", mediaMode: "auto" });

    await pipeline.plan(DRAMA);
    assert.deepEqual(store.listJobs(DRAMA).map((job) => job.stage), ["script"], "初始只入队剧本作业");

    for (const [stage, next] of [["script", "assets"], ["assets", "prompts"], ["prompts", "video"]] as const) {
        store.succeed(store.job(`${DRAMA}:ep1:${stage}`)!.id, {});
        await pipeline.plan(DRAMA);
        const stages = store.listJobs(DRAMA).map((job) => job.stage);
        assert.ok(stages.includes(next), `${stage} 成功后入队 ${next}`);
    }
    assert.equal(store.job(`${DRAMA}:ep1:render`), undefined, "video 还没成功，render 不该出现在队列里");
    store.succeed(store.job(`${DRAMA}:ep1:video`)!.id, {});
    await pipeline.plan(DRAMA);
    assert.ok(store.job(`${DRAMA}:ep1:render`), "video 成功后才入队成片作业");
});

test("listJobs：集号优先、集内阶段优先，旧作业没有集号时排到最后", (t) => {
    const store = fixture(t);
    for (const no of [3, 1, 2]) {
        STAGES.forEach((stage, index) => {
            store.enqueue({
                id: `ep${no}-${stage}`, dramaId: DRAMA, episodeId: `ep-${no}`, kind: stage as never, stage,
                priority: STAGES.length - 1 - index, dedupeKey: `${DRAMA}:ep-${no}:${stage}`,
                payload: { episodeId: `ep-${no}`, episodeNumber: no },
            });
        });
    }
    // 老作业只有 episodeId，没有 episodeNumber。
    store.enqueue({ id: "legacy-job", dramaId: DRAMA, episodeId: "legacy", kind: "script" as never, stage: "script", priority: 4, dedupeKey: `${DRAMA}:legacy:script` });

    const ordered = store.listJobs(DRAMA, ["queued"]).map((job) => job.id);
    assert.deepEqual(ordered.slice(0, 5), STAGES.map((stage) => `ep1-${stage}`));
    assert.deepEqual(ordered.slice(5, 10), STAGES.map((stage) => `ep2-${stage}`));
    assert.deepEqual(ordered.slice(10, 15), STAGES.map((stage) => `ep3-${stage}`));
    assert.equal(ordered[15], "legacy-job");
});
