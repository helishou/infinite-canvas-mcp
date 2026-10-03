import test from "node:test";
import assert from "node:assert/strict";
import { projectProductionRead, productionWriteReceipt, productionReadQuery } from "./production-read.js";

test("large production reads omit duplicate source/prompt/history without altering authored bytes", () => {
    const prompt = "完整正文\r\n".repeat(100000);
    const director = { engine: { runtimeId: "pinned" }, sourceHash: "hash", workflow: {}, modules: {}, assets: {}, source: { brief: "sample", shots: [{ id: "shot", visual: prompt }] }, artifacts: [{ id: "h3-segment", targetId: "segment", prompt, sha256: "bytes", references: [] }] };
    const data = { episodeId: "episode", revision: 13, publishedVersion: 1, draft: { director, shots: [], scenes: [], clipGroups: [] }, published: { director } };
    const summary = projectProductionRead(data);
    assert.ok(JSON.stringify(summary).length < 5000);
    assert.equal(summary.revision, 13);
    assert.equal(summary.draft.director.artifacts[0].sha256, "bytes");
    assert.equal(projectProductionRead(data, { view: "source" }).source, director.source);
    assert.equal(projectProductionRead(data, { view: "artifacts", targetIds: ["segment"] }).artifacts[0].prompt, prompt);
    assert.deepEqual(projectProductionRead(data, { view: "artifacts", targetIds: ["other"] }).artifacts, []);
    assert.equal(director.artifacts[0].prompt, prompt);
    assert.equal(projectProductionRead(data, { view: "full" }), data);
    const receipt = productionWriteReceipt({ ok: true, production: { ...data, replayed: true } });
    assert.equal(receipt.production.replayed, true);
    assert.equal(receipt.production.sourceHash, "hash");
    assert.ok(JSON.stringify(receipt).length < 1000);
    assert.match(productionReadQuery({ view: "artifacts", targetIds: ["segment"] }), /targetIds=segment/);
});
