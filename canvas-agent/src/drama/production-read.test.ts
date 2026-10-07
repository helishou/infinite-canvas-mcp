import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { projectProductionRead, projectProductionVersion, productionReadQuery, productionWriteReceipt } from "./production-read.js";
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

test("workspace write receipts retain layout, identity and conflicts without repeating source or prompt data", () => {
    const production = record();
    const result: any = productionWriteReceipt({ ok: true, production: { ...production, referenceSync: [{ targetId: "seg2", status: "blocked", diagnostics: [{ code: "CLIP_EDIT_CONFLICT" }] }] }, layoutReceipt: { planHash: "layout", created: [{ nodeIds: ["node"] }] }, mediaSubmitted: false });
    assert.equal(result.production.revision, 3);
    assert.equal(result.layoutReceipt.planHash, "layout");
    assert.equal(result.warnings.codes[0], "CLIP_EDIT_CONFLICT");
    assert.equal(result.mediaSubmitted, false);
    assert.equal(result.production.draft, undefined);
    assert.ok(!JSON.stringify(result).includes("长提示词"));
});

test("ledger entries can be read by stable identity without pulling the complete context", () => {
    const production = record(); (production.draft.director.source as any).ledger = { contract_version: 2, events: [{ id: "E1", reason: "full authored reason" }, { id: "E2", reason: "other" }] };
    const result: any = projectProductionRead(production, { view: "source", sourceSection: "ledger.events", targetIds: ["E1"] });
    assert.deepEqual(result.source, [{ id: "E1", reason: "full authored reason" }]);
    const context: any = projectProductionRead(production, { view: "source", sourceSection: "context" });
    assert.equal(context.source.ledger, undefined);
    assert.equal(context.ledgerSummary.counts.events, 2);
    assert.ok(context.omittedSourceSections.includes("ledger"));
});

test("default summaries exclude growing collections and honor the selected published snapshot", () => {
    const production: any = record();
    production.draft.keyframes = { huge: { prompt: "private".repeat(100000) } };
    production.published = { ...production.draft, director: { ...production.draft.director, sourceHash: "published" } };
    const summary: any = projectProductionRead(production, { snapshot: "published" });
    assert.equal(summary.draft, undefined);
    assert.equal(summary.published.director.sourceHash, "published");
    assert.equal(summary.published.director.counts.artifacts, 28);
    assert.ok(JSON.stringify(summary).length < 2000);
    assert.ok(!JSON.stringify(summary).includes("private"));
});

test("historical chunks bind immutable version and snapshot content, never the live draft", () => {
    const version = { version: 2, stage: "director", snapshot: record().draft, createdAt: "2026-01-01" };
    const query = { view: "artifacts", targetIds: ["seg0"], chunkBytes: 2049 };
    const first: any = projectProductionVersion({ episodeId: "e" }, version, query, digest);
    let cursor = first.snapshot.chunk.nextCursor; let text = first.snapshot.chunk.text;
    while (cursor) {
        const part: any = projectProductionVersion({ episodeId: "e" }, version, { ...query, cursor }, digest);
        text += part.snapshot.chunk.text; cursor = part.snapshot.chunk.nextCursor;
    }
    assert.equal(text, version.snapshot.director.artifacts[0].prompt);
    assert.throws(() => projectProductionVersion({ episodeId: "e" }, { ...version, version: 3 }, { ...query, cursor: first.snapshot.chunk.nextCursor }, digest), /READ_CURSOR_EXPIRED/);
    assert.throws(() => projectProductionVersion({ episodeId: "e" }, { ...version, snapshot: { ...version.snapshot, changed: true } }, { ...query, cursor: first.snapshot.chunk.nextCursor }, digest), /READ_CURSOR_EXPIRED/);
});

test("write receipts discard top-level snapshots and retain operation replay identity", () => {
    const payload: any = { ok: true, replayed: true, production: record(), canvas: { prompt: "huge".repeat(100000) }, layoutReceipt: { created: Array(100).fill({ nodes: "huge" }), reused: [], diagnostics: [] } };
    const receipt: any = productionWriteReceipt(payload, { tool: "production_prepare_targets", input: { kind: "canvas", id: "c", operationId: "original" } });
    assert.equal(receipt.operationId, "original"); assert.equal(receipt.replayed, true);
    assert.equal(receipt.layoutReceipt.created, 100); assert.equal(receipt.canvas.prompt, undefined);
    assert.deepEqual(receipt.nextRead, { tool: "production_get", input: { kind: "canvas", id: "c", view: "summary" } });
    assert.ok(JSON.stringify(receipt).length < 2000);
    console.log(`write projection: ${Buffer.byteLength(JSON.stringify(payload))} -> ${Buffer.byteLength(JSON.stringify(receipt))} bytes`);
});
