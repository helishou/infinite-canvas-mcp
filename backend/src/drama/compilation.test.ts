import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { ProductionCompilationService } from "./compilation.js";
import { directorHash } from "./director.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

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

test("changed revision, engine and owner cannot silently overwrite a production", t => {
    const { service, compilations, director } = fixture(t);
    const prepared = compilations.prepare("episode", "episode", 1);
    assert.throws(() => compilations.prepare("episode", "episode", 0), ProductionConflictError);
    assert.throws(() => compilations.prepare("episode", "episode", 1, { ...director, engine: { ...director.engine, runtimeId: "other" } }), (error: any) => error.diagnostics?.some((item: any) => item.code === "ENGINE_MISMATCH"));
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
