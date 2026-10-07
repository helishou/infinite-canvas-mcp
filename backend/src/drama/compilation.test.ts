import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { ProductionCompilationService } from "./compilation.js";
import { directorHash, promptHash } from "./director.js";
import { ProductionContinuityReports } from "./continuity-reports.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { compilationScopeInput, currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";

function fixture(t: test.TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-compile-"));
    const db = new BackendDatabase(path.join(root, "test.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    db.createCanvasProject({ id: "canvas", title: "Canvas", nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "", fullPlot: "", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, root, false, () => {});
    const source = { brief: "Preserve the sample", shots: [], segments: [], asset_plan: [], asset_cards: [{ id: "STYLE", prompt: "The authored image prompt" }] };
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    service.edit("episode", { operationId: "seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const compiler = (input: DirectorProduction) => ({ director: input, exitCode: 0, diagnostics: [], audit: { status: "PASS" }, sourceAdjustments: [], acceptance: {} });
    const compilations = new ProductionCompilationService(service, root, compiler);
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, db, service, compilations, director };
}

test("unchanged full compilation reuses artifacts and a scoped edit compiles only its invalid target", async t => {
    const { root, service, director } = fixture(t);
    director.source.asset_plan = ["A", "B"].map(id => ({ id, kind: "prop", depends_on: [] }));
    director.source.asset_cards = ["A", "B"].map(id => ({ id, prompt: `authored ${id}` }));
    director.sourceHash = directorHash(director.source);
    service.edit("episode", { operationId: "two-targets", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    const calls: string[][] = [];
    const compiler = (input: DirectorProduction) => {
        const cards = input.source.asset_cards as Array<{ id: string; prompt: string }>;
        calls.push(cards.map(card => card.id));
        return { director: { ...input, artifacts: cards.map(card => ({ id: `image-${card.id}`, targetId: card.id, kind: "image" as const,
            prompt: card.prompt, sha256: promptHash(card.prompt), sourceHash: input.sourceHash, status: "ready" as const, references: [],
            receipt: { sourceHash: input.sourceHash, promptHash: promptHash(card.prompt), engineRuntimeId: input.engine.runtimeId, validator: "fixture" } })) },
            exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} };
    };
    const jobs = new ProductionCompilationService(service, path.join(root, "packets"), compiler);
    const run = async (operationId: string, scope?: { targetIds: string[] }) => {
        jobs.enqueue("episode", "episode", operationId, service.get("episode").revision, undefined, scope);
        await new Promise(resolve => setImmediate(resolve));
        const job = jobs.getCompilation("episode", "episode", operationId);
        assert.equal(job.status, "succeeded");
        jobs.apply("episode", "episode", job.preparedId!);
        return job;
    };
    await run("initial", { targetIds: ["A", "B"] });
    await run("unchanged-full");
    assert.deepEqual(calls, [["A", "B"]], "an unscoped unchanged request must not invoke the compiler again");
    const current = service.get("episode"), changed = structuredClone(current.draft.director!);
    const originalA = structuredClone(current.draft.director!.artifacts.find(item => item.targetId === "A"));
    (changed.source.asset_cards as Array<{ id: string; prompt: string }>)[1].prompt = "revised B";
    changed.sourceHash = directorHash(changed.source);
    changed.artifacts.find(item => item.targetId === "B")!.status = "draft";
    service.edit("episode", { operationId: "change-B", expectedRevision: current.revision, ops: [{ type: "set_director_production", director: changed }] });
    await run("partial", { targetIds: ["A", "B"] });
    assert.deepEqual(calls, [["A", "B"], ["B"]]);
    const after = service.get("episode").draft.director!;
    assert.deepEqual(after.artifacts.find(item => item.targetId === "A"), originalA, "reuse retains the actual original receipt and bytes");
    assert.equal(after.artifacts.find(item => item.targetId === "B")!.prompt, "revised B");
    assert.ok(after.artifacts.every(item => currentCompilationArtifact(after, item)));
    const prepared = jobs.prepare("episode", "episode", service.get("episode").revision);
    assert.equal(prepared.audit.status, "REUSED");
    assert.equal(calls.length, 2, "synchronous preparation uses the same reuse rules");
});

test("prompt bytes and receipt hashes must match before a ready artifact is reused", async t => {
    const { root, service, director } = fixture(t);
    director.source.asset_plan = [{ id: "STYLE", kind: "style" }];
    director.sourceHash = directorHash(director.source);
    const prompt = "original prompt";
    director.artifacts = [{ id: "style", targetId: "STYLE", kind: "image", prompt: "tampered prompt", sha256: promptHash(prompt), sourceHash: director.sourceHash,
        status: "ready", references: [], receipt: { sourceHash: director.sourceHash, promptHash: promptHash(prompt), engineRuntimeId: director.engine.runtimeId, validator: "fixture" } }];
    let calls = 0;
    const jobs = new ProductionCompilationService(service, root, input => {
        calls++;
        const next = structuredClone(input);
        next.artifacts[0].prompt = prompt;
        return { director: next, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} };
    });
    jobs.enqueue("episode", "episode", "tampered", 1, director, { targetIds: ["STYLE"] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(jobs.getCompilation("episode", "episode", "tampered").status, "succeeded");
    assert.equal(calls, 1);
    const targets: any = jobs.getCompilation("episode", "episode", "tampered", "targets", 0, 10);
    assert.equal(targets.items[0].sha256, promptHash(prompt));
});

test("repeated media bindings read bytes once per verification and still reject each mismatched binding", t => {
    const { root, db, service, director } = fixture(t);
    const filePath = path.join(root, "reference.png"), storageKey = "reference.png", bytes = "verified reference bytes";
    fs.writeFileSync(filePath, bytes);
    db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: Buffer.byteLength(bytes), width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "reference", nodeType: "image", position: { x: 0, y: 0 }, metadata: { storageKey } }]);
    director.assets = Object.fromEntries(["A", "B"].map(id => [id, { nodeId: "reference", version: "v1", status: "approved", storageKey, sha256: promptHash(bytes), evidence: "verified" }]));
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = ((file: any, ...args: any[]) => {
        if (file === filePath) reads++;
        return (read as any)(file, ...args);
    }) as typeof read;
    try { service.verifyCompilationBindings("episode", director); }
    finally { fs.readFileSync = read; }
    assert.equal(reads, 1);
    director.assets.B.sha256 = "0".repeat(64);
    assert.throws(() => service.verifyCompilationBindings("episode", director), /reference bytes changed/);
    director.assets.B.sha256 = promptHash(bytes);
    director.assets.B.nodeId = "missing-node";
    assert.throws(() => service.verifyCompilationBindings("episode", director), /not bound/);
});

test("scoped asset-only compilation applies with ledger v2 before video continuity is authored", async t => {
    const { root, service, director } = fixture(t);
    director.source.asset_plan = [{ id: "STYLE", kind: "style", version: "v1", purpose: "Lock the film rendering language.", status: "planned", depends_on: [] }];
    director.source.ledger = { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] };
    director.sourceHash = directorHash(director.source);
    service.edit("episode", { operationId: "asset-ledger", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    const jobs = new ProductionCompilationService(service, root, ((input: DirectorProduction) => {
        const prompt = "The complete authored style image", sha256 = promptHash(prompt);
        return { director: { ...input, artifacts: [{ id: "image-STYLE", kind: "image", targetId: "STYLE", prompt, sha256, sourceHash: input.sourceHash,
            status: "ready", references: [], receipt: { sourceHash: input.sourceHash, promptHash: sha256, engineRuntimeId: input.engine.runtimeId, validator: "fixture" } }] },
            exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} };
    }) as any);
    jobs.enqueue("episode", "episode", "asset-only", 2, undefined, { targetIds: ["STYLE"] });
    await new Promise(resolve => setImmediate(resolve));
    const job = jobs.getCompilation("episode", "episode", "asset-only");
    assert.equal(job.status, "succeeded");
    jobs.apply("episode", "episode", job.preparedId!);
    assert.equal(service.get("episode").draft.director!.artifacts[0].status, "ready");
    assert.equal(jobs.apply("episode", "episode", job.preparedId!).replayed, true);
});

test("three scoped compiler jobs overlap and merge disjoint results without overwriting revisions", async t => {
    const { root, service, director } = fixture(t);
    director.source = { ...director.source, script_scenes: ["A", "B", "C"].map(id => ({ id, scene_id: id, text: "confirmed" })),
        shots: ["A", "B", "C"].map(id => ({ id: `S${id}`, source_scene_id: id, scene_id: id, visual: id, required_assets: [] })), segments: [],
        asset_plan: ["A", "B", "C"].map(id => ({ id: `K${id}`, kind: "keyframe", canvas_scope: "episode", shot_ids: [`S${id}`] })),
        asset_cards: ["A", "B", "C"].map(id => ({ id: `K${id}`, prompt: "authored image" })) };
    director.sourceHash = directorHash(director.source);
    service.edit("episode", { operationId: "scenes", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    const releases: Array<() => void> = []; let concurrent = 0, peak = 0;
    const compiler = async (input: DirectorProduction) => {
        concurrent++; peak = Math.max(peak, concurrent);
        await new Promise<void>(resolve => releases.push(resolve)); concurrent--;
        const targetId = String((input.source.asset_plan as any[])[0].id), prompt = `compiled ${targetId}`;
        return { director: { ...input, artifacts: [{ id: `image-${targetId}`, kind: "image" as const, targetId, prompt, sha256: promptHash(prompt), sourceHash: input.sourceHash, status: "ready" as const, references: [], receipt: { sourceHash: input.sourceHash, promptHash: promptHash(prompt), engineRuntimeId: input.engine.runtimeId, validator: "fixture" } }] }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} };
    };
    const jobs = new ProductionCompilationService(service, root, compiler as any);
    for (const sceneId of ["A", "B", "C"]) jobs.enqueue("episode", "episode", `compile-${sceneId}`, 2, undefined, { sceneId });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 3); assert.equal(peak, 3); releases.forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
    for (const sceneId of ["A", "B", "C"]) {
        const job = jobs.getCompilation("episode", "episode", `compile-${sceneId}`);
        assert.equal(job.status, "succeeded"); jobs.apply("episode", "episode", job.preparedId!);
    }
    const current = service.get("episode");
    assert.equal(current.draft.director!.artifacts.length, 3);
    assert.deepEqual(current.draft.director!.artifacts.map(item => item.targetId).sort(), ["KA", "KB", "KC"]);
    const job = jobs.getCompilation("episode", "episode", "compile-A");
    assert.equal(jobs.apply("episode", "episode", job.preparedId!).replayed, true);
    const b = current.draft.director!.artifacts.find(item => item.targetId === "KB")!;
    const originalHash = b.sourceHash;
    const next = structuredClone(current.draft.director!);
    next.engine = { commit: "b".repeat(40), patchVersion: "next", runtimeId: "next", version: "next" };
    jobs.enqueue("episode", "episode", "compile-A-new-engine", current.revision, next, { sceneId: "A" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 4, "same-source artifacts from an older compiler must not skip the requested new compilation");
    releases[3](); await new Promise(resolve => setImmediate(resolve));
    const newer = jobs.getCompilation("episode", "episode", "compile-A-new-engine");
    assert.equal(newer.status, "succeeded"); jobs.apply("episode", "episode", newer.preparedId!);
    const mixed = service.get("episode");
    assert.equal(mixed.draft.director!.engine.runtimeId, "next");
    assert.equal(mixed.draft.director!.artifacts.find(item => item.targetId === "KA")!.receipt.engineRuntimeId, "next");
    const preservedB = mixed.draft.director!.artifacts.find(item => item.targetId === "KB")!;
    assert.equal(preservedB.prompt, b.prompt);
    assert.equal(preservedB.receipt.engineRuntimeId, b.receipt.engineRuntimeId);
    assert.equal(currentCompilationArtifact(mixed.draft.director!, preservedB), true);
    service.edit("episode", { operationId: "change-A", expectedRevision: mixed.revision, ops: [{ type: "patch_director_source", entity: "shot", id: "SA", patch: { visual: "changed A" } }] });
    const changed = service.get("episode").draft.director!;
    assert.equal(currentCompilationArtifact(changed, preservedB), true); assert.equal(preservedB.sourceHash, originalHash);
    assert.throws(() => jobs.apply("episode", "other", job.preparedId!), /different production/);
    assert.deepEqual(compilationScopeInput(changed, { sceneId: "B" }).targetIds, ["KB"]);
});

test("prepare is read-only; frozen apply is atomic and idempotent", t => {
    const { db, service, compilations } = fixture(t);
    const before = service.get("episode");
    const prepared = compilations.prepare("episode", "episode", 1);
    assert.deepEqual(service.get("episode"), before);
    assert.equal(db.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='runtime_tasks'").get()?.n, 0);
    const applied = compilations.apply("episode", "episode", prepared.preparedId);
    assert.equal(applied.revision, 2);
    assert.equal(applied.mediaSubmitted, false);
    assert.equal(compilations.apply("episode", "episode", prepared.preparedId).replayed, true);
    assert.equal(service.get("episode").revision, 2);
});

test("changed revision and owner cannot overwrite a production; old engine metadata does not lock compilation", t => {
    const { service, compilations, director } = fixture(t);
    const prepared = compilations.prepare("episode", "episode", 1);
    assert.throws(() => compilations.prepare("episode", "episode", 0), ProductionConflictError);
    assert.ok(compilations.prepare("episode", "episode", 1, { ...director, engine: { ...director.engine, runtimeId: "other" } }).preparedId);
    assert.throws(() => compilations.apply("episode", "canvas", prepared.preparedId), /different production/);
    service.edit("episode", { operationId: "concurrent", expectedRevision: 1, ops: [{ type: "set_director_brief", brief: "Another window's edit" }] });
    assert.throws(() => compilations.apply("episode", "episode", prepared.preparedId), ProductionConflictError);
    assert.equal(service.get("episode").draft.director?.source.brief, "Another window's edit");
});

test("tampered compiler packet is rejected without a revision change", t => {
    const { root, service, compilations } = fixture(t);
    const prepared = compilations.prepare("episode", "episode", 1);
    const file = path.join(root, prepared.preparedId, "packet.json");
    const packet = JSON.parse(fs.readFileSync(file, "utf8"));
    packet.director.source.brief = "Altered after compilation";
    fs.writeFileSync(file, JSON.stringify(packet));
    assert.throws(() => compilations.apply("episode", "episode", prepared.preparedId), /bytes changed/);
    assert.equal(service.get("episode").revision, 1);
});

test("continuity issues downgrade only their H3 target and another covered target can be applied and published", t => {
    const { root, service, director } = fixture(t);
    director.source = { ...director.source, ledger: { contract_version: 2 }, segments: [{ id: "SEG01" }, { id: "SEG02" }] };
    director.sourceHash = directorHash(director.source);
    service.edit("episode", { operationId: "ledger-v2", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    const owner = { kind: "episode", id: "episode" };
    new ProductionContinuityReports(path.join(root, "production-compilations", "continuity")).persist(owner, "check-partial", "check-request", {
        owner, snapshot: "draft", snapshotVersion: 0, sourceHash: director.sourceHash, runtimeId: director.engine.runtimeId, revision: 2,
        verdict: "blocked", selectedTargets: ["SEG01", "SEG02"], checkedAt: "2026-10-06T00:00:00.000Z",
        diagnostics: [{ code: "CONTINUITY_COVERAGE_MISSING", message: "SEG02 is missing coverage", severity: "error", affectedTargets: ["SEG02"] }],
    });
    const prompt = "compiled H3 prompt";
    const compiler = (input: DirectorProduction) => ({
        director: { ...structuredClone(input), artifacts: ["SEG01", "SEG02"].map(targetId => ({ id: `h3-${targetId}`, kind: "h3" as const, targetId, prompt, sha256: promptHash(prompt), sourceHash: input.sourceHash, status: "ready" as const, references: [], receipt: { sourceHash: input.sourceHash, promptHash: promptHash(prompt), engineRuntimeId: input.engine.runtimeId, validator: "fixture" } })) },
        exitCode: 0, diagnostics: [], audit: { status: "PASS" }, sourceAdjustments: [], acceptance: {},
    });
    const compilations = new ProductionCompilationService(service, path.join(root, "packets"), compiler);
    const preflight = service.preflight("episode", { action: "compile", request: { expectedRevision: 2 } });
    assert.equal(preflight.valid, true);
    assert.ok(preflight.diagnostics.some(item => item.targetId === "SEG02" && item.code === "CONTINUITY_BLOCKED"));
    const prepared = compilations.prepare("episode", "episode", 2);
    assert.deepEqual(prepared.targets.map(item => [item.targetId, item.status]), [["SEG01", "ready"], ["SEG02", "draft"]]);
    assert.ok(prepared.diagnostics.some(item => item.targetId === "SEG02" && item.code === "CONTINUITY_BLOCKED"));
    const applied = compilations.apply("episode", "episode", prepared.preparedId);
    assert.equal(applied.mediaSubmitted, false);
    const current = service.get("episode");
    assert.equal(current.draft.director?.artifacts.find(item => item.targetId === "SEG01")?.status, "ready");
    assert.equal(current.draft.director?.artifacts.find(item => item.targetId === "SEG02")?.status, "draft");
    const published = service.publish("episode", { operationId: "publish-partial-continuity", expectedRevision: current.revision, stage: "director" });
    assert.equal(published.published?.director?.artifacts.find(item => item.targetId === "SEG01")?.status, "ready");
    assert.equal(published.published?.director?.artifacts.find(item => item.targetId === "SEG02")?.status, "draft");
});

test("binding diagnostics expose source, draft and published versions separately", t => {
    const { service, director } = fixture(t);
    director.source.asset_plan = [{ id: "character", version: "v2", status: "approved" }];
    director.sourceHash = directorHash(director.source);
    director.assets.character = { version: "v1", status: "generated", nodeId: "missing" };
    service.edit("episode", { operationId: "bindings", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    const result = service.diagnoseBindings("episode");
    assert.equal(result.revision, 2);
    assert.equal(result.publishedVersion, 0);
    assert.equal(result.assets[0].sourceVersion, "v2");
    assert.equal(result.assets[0].draftBinding?.version, "v1");
    assert.ok(result.assets[0].issues.includes("SOURCE_BINDING_VERSION_MISMATCH"));
    assert.ok(result.assets[0].issues.includes("MISSING_NODE"));
    assert.equal(service.get("episode").revision, 2);
});

test("story-only compile is blocked before a compiler packet or task is created", t => {
    const { root, service, director, db } = fixture(t);
    director.source.asset_cards = [];
    director.sourceHash = directorHash(director.source);
    service.edit("episode", { operationId: "story-only", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    let compilerCalls = 0;
    const compiler = (input: DirectorProduction) => { compilerCalls++; return { director: input, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} }; };
    const packets = path.join(root, "packets");
    const compilations = new ProductionCompilationService(service, packets, compiler);
    const before = service.get("episode");
    const checked = service.preflight("episode", { action: "compile", request: { expectedRevision: 2 } });
    assert.equal(checked.valid, false); assert.equal(checked.compileReady, false);
    assert.equal(checked.diagnostics[0].code, "COMPILE_STAGE_NOT_READY");
    assert.throws(() => compilations.prepare("episode", "episode", 2), (error: any) => error.diagnostics?.some((item: any) => item.code === "COMPILE_STAGE_NOT_READY"));
    assert.equal(compilerCalls, 0);
    assert.equal(fs.existsSync(packets), false);
    assert.deepEqual(service.get("episode"), before);
    assert.equal(db.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='runtime_tasks'").get()?.n, 0);
});
