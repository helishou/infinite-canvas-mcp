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

test("conditional reads reuse a complete revision and return new source after edits", () => {
    const production = record();
    const query = { view: "source", sourceSection: "segments", targetIds: ["seg2"] };
    const initial: any = projectProductionRead(production, query);
    const cached: any = projectProductionRead(production, { ...query, ifRevision: initial.revision });
    assert.equal(cached.unchanged, true);
    assert.equal(cached.source, undefined);
    assert.equal(cached.sourceHash, production.draft.director.sourceHash);
    assert.ok(JSON.stringify(cached).length < 500);
    const changed = structuredClone(production);
    changed.revision++;
    changed.draft.director.source.segments[2].action = "新的镜头内容";
    const refreshed: any = projectProductionRead(changed, { ...query, ifRevision: initial.revision });
    assert.equal(refreshed.unchanged, undefined);
    assert.equal(refreshed.source[0].action, "新的镜头内容");
    assert.match(productionReadQuery({ ...query, ifRevision: 0 }), /ifRevision=0/);
    const full: any = projectProductionRead(production, { view: "full", ifRevision: production.revision });
    assert.equal(full.unchanged, true);
    assert.equal(full.draft, undefined);
    assert.equal(projectProductionRead(production, { view: "full", ifRevision: 0 }), production);
});

test("conditional checks never hide unread pages or bypass expired cursor validation", () => {
    const production = record();
    const query = { view: "source", sourceSection: "segments", pageSize: 1 };
    const first: any = projectProductionRead(production, query);
    const next: any = projectProductionRead(production, { ...query, ifRevision: production.revision, cursor: first.source.nextCursor });
    assert.equal(next.unchanged, undefined);
    assert.equal(next.source.items[0].id, "seg1");
    assert.throws(() => projectProductionRead({ ...production, revision: 4 }, { ...query, ifRevision: 4, cursor: first.source.nextCursor }), /READ_CURSOR_EXPIRED/);
});

test("repeated full checks preserve content while reducing total UTF-8 response bytes", () => {
    const production = record();
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const reads = 18;
    const previousBytes = reads * bytes(projectProductionRead(production, { view: "full" }));
    const newBytes = bytes(projectProductionRead(production, { view: "full" }))
        + (reads - 1) * bytes(projectProductionRead(production, { view: "full", ifRevision: production.revision }));
    assert.ok(newBytes < previousBytes / 10);
    console.log(`same task: ${reads} checks, UTF-8 bytes ${previousBytes} -> ${newBytes}`);
    const receipt: any = productionWriteReceipt({ ok: true, production }, { tool: "production_edit", input: { kind: "episode", id: "e", operationId: "saved" } });
    assert.equal(receipt.readPolicy.nextReadRequired, false);
    assert.equal(receipt.production.sourceHash, production.draft.director.sourceHash);
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
    assert.equal(summary.nextRead.input.pageSize, 100);
    const index: any = projectProductionRead(production, summary.nextRead.input);
    assert.equal(index.artifacts.items.length, 28);
    assert.equal(index.artifacts.nextCursor, null);
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
