import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { projectProductionRead, productionReadQuery } from "./production-read.js";
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function record() {
    const artifacts = Array.from({ length: 28 }, (_, index) => ({ id: `h3-${index}`, targetId: `seg${index}`, kind: "h3", status: "ready", prompt: "长提示词😀abc".repeat(5000), references: [], sha256: "a".repeat(64) }));
    return { episodeId: "e", revision: 3, publishedVersion: 1, draft: { director: { sourceHash: "b".repeat(64), artifacts, source: { brief: "context", segments: artifacts.map(a => ({ id: a.targetId, action: a.prompt })) } } } };
}
test("28 long prompts can be traversed through a compact index without prompt leakage", () => {
    const production = record(); let cursor: string | undefined; const found: any[] = [];
    do { const page: any = projectProductionRead(production, { view: "artifact_index", pageSize: 5, cursor }); found.push(...page.artifacts.items); cursor = page.artifacts.nextCursor || undefined; } while (cursor);
    assert.equal(found.length, 28); assert.ok(found.every(item => !('prompt' in item))); assert.ok(JSON.stringify(found).length < 15000);
});
test("UTF-8 chunks reconstruct a complete prompt and hash; changed revisions reject the cursor", () => {
    const production = record(); let cursor: string | undefined; let text = ""; let hash = "";
    do { const part: any = projectProductionRead(production, { view: "artifacts", targetIds: ["seg0"], chunkBytes: 2049, cursor }, digest); text += part.chunk.text; hash = part.chunk.sha256; cursor = part.chunk.nextCursor || undefined; } while (cursor);
    assert.equal(text, production.draft.director.artifacts[0].prompt); assert.equal(digest(text), hash);
    const first: any = projectProductionRead(production, { view: "artifact_index", pageSize: 1 });
    assert.throws(() => projectProductionRead({ ...production, revision: 4 }, { view: "artifact_index", pageSize: 1, cursor: first.artifacts.nextCursor }), /READ_CURSOR_EXPIRED/);
    assert.throws(() => projectProductionRead({ ...production, episodeId: "other" }, { view: "artifact_index", pageSize: 1, cursor: first.artifacts.nextCursor }), /READ_CURSOR_EXPIRED/);
});
test("source selection is complete and query serializes selectors", () => {
    const production = record(); const selected: any = projectProductionRead(production, { view: "source", sourceSection: "segments", targetIds: ["seg2"] });
    assert.equal(selected.source.length, 1); assert.equal(selected.source[0].id, "seg2");
    assert.ok(productionReadQuery({ view: "source", sourceSection: "segments", targetIds: ["seg2"], chunkBytes: 100 }).includes("sourceSection=segments"));
});
