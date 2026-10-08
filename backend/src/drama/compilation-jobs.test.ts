import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { ProductionCompilationService, productionCompilationBusy } from "./compilation.js";
const director: any = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "1" }, source: { brief: "source" }, sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };

test("active Python audit preserves standalone-error provenance through the shared compiler adapter", async t => {
    const { resolveAchengEngine, compileAchengDirector, achengEngineIdentity } = await import("@basketikun/canvas-agent/skills/acheng");
    const { canonicalProduction } = await import("@basketikun/canvas-agent/drama/production-contract");
    const crypto = await import("node:crypto");
    const runtime = resolveAchengEngine();
    const candidate = structuredClone(director);
    candidate.engine = achengEngineIdentity(runtime);
    candidate.source = JSON.parse(fs.readFileSync(path.join(runtime.path, "examples", "01-mecha.production.json"), "utf8"));
    delete candidate.source.prompt_detail_policy;
    const segment = candidate.source.segments[0]; delete segment.prompt_detail_policy;
    const shot = candidate.source.shots.find((item: any) => item.id === segment.shot_ids[0]);
    shot.visual += " Keep the same camera axis as the preceding segment.";
    candidate.sourceHash = crypto.createHash("sha256").update(canonicalProduction(candidate.source)).digest("hex");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "actual-prompt-diagnostic-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reference = path.join(root, "fixture.png");
    fs.writeFileSync(reference, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=", "base64"));
    const compiled = compileAchengDirector(candidate, root, () => reference, runtime.runtimeId);
    const error = compiled.diagnostics.find(item => item.code === "PROMPT_EXTERNAL_CONTEXT" && item.shotId === shot.id);
    assert.ok(error, JSON.stringify(compiled.diagnostics));
    assert.equal(error.path, `director.source.shots.${shot.id}.visual`);
    assert.equal(error.targetId, segment.id); assert.equal(error.origin, "source"); assert.equal(error.blocksCompilation, true);
});
function setup(t: any, compiler: any) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compilation-jobs-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let current: any = { revision: 1, draft: { director: structuredClone(director) } };
    const service: any = { get: () => structuredClone(current), verifyCompilationBindings: () => {}, compilationReferenceFiles: () => ({}), edit: (_id: string, input: any) => {
        if (current.revision !== input.expectedRevision) throw new Error("conflict"); current = { ...current, revision: 2, draft: { director: input.ops[0].director } }; return structuredClone(current);
    } };
    return { root, service, compilations: new ProductionCompilationService(service, root, compiler), change: () => { current.revision++; } };
}
const result = (input: any) => ({ director: input, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} });
test("queued and running compilations keep development reload busy until settlement", async t => {
    assert.equal(productionCompilationBusy(), false);
    const f = setup(t, result);
    f.compilations.enqueue("e", "owner", "busy-guard", 1);
    assert.equal(productionCompilationBusy(), true);
    await done(f.compilations, "busy-guard");
    assert.equal(productionCompilationBusy(), false);
});
async function done(compilations: ProductionCompilationService, op: string) {
    for (let i = 0; i < 20; i++) { await immediate(); const status = compilations.getCompilation("e", "owner", op); if (!["queued", "running"].includes(status.status)) return status; }
    throw new Error("job did not finish");
}
test("lost response and identical submissions retain one compiler invocation and a prompt-free receipt", async t => {
    let calls = 0; const f = setup(t, (input: any) => { calls++; return result(input); });
    const first = f.compilations.enqueue("e", "owner", "op", 1);
    assert.ok(["queued", "running"].includes(first.status)); assert.equal((f.compilations.enqueue("e", "owner", "op", 1) as any).replayed, true);
    assert.throws(() => f.compilations.enqueue("e", "owner", "op", 2), /IDEMPOTENCY_CONFLICT/);
    const completed: any = await done(f.compilations, "op"); assert.equal(completed.status, "succeeded"); assert.equal(calls, 1);
    assert.equal(JSON.stringify(completed).includes('"prompt"'), false);
    f.compilations.apply("e", "owner", completed.preparedId);
    assert.equal(f.compilations.getCompilation("e", "owner", "op").application.revision, 2);
    assert.throws(() => f.compilations.getCompilation("e", "other", "op"), /不属于/);
});
test("failed compilation is persistent and is not rerun by queries", async t => {
    let calls = 0; const f = setup(t, () => { calls++; throw new Error("Python exited"); });
    f.compilations.enqueue("e", "owner", "op", 1); const completed: any = await done(f.compilations, "op");
    assert.equal(completed.status, "failed"); assert.equal(completed.preparedId, undefined);
    const restored = new ProductionCompilationService(f.service, f.root, () => { throw new Error("must not run"); }); restored.recover("owner");
    assert.equal(restored.getCompilation("e", "owner", "op").status, "failed"); assert.equal(calls, 1);
});
test("recovery resumes queued records and marks uncompleted running records interrupted", async t => {
    const f = setup(t, result); f.compilations.enqueue("e", "owner", "op", 1); await done(f.compilations, "op");
    const file = path.join(f.root, "operations", fs.readdirSync(path.join(f.root, "operations"))[0]);
    const job = JSON.parse(fs.readFileSync(file, "utf8")); job.status = "running"; fs.rmSync(path.join(f.root, job.preparedId, "packet.json")); fs.writeFileSync(file, JSON.stringify(job));
    const restored = new ProductionCompilationService(f.service, f.root, result); restored.recover("owner");
    assert.equal(restored.getCompilation("e", "owner", "op").status, "interrupted");
    job.operationId = "queued"; job.status = "queued";
    const crypto = await import("node:crypto"); const index = crypto.createHash("sha256").update(JSON.stringify("queued")).digest("hex");
    fs.writeFileSync(path.join(f.root, "operations", index + ".json"), JSON.stringify(job)); restored.recover("owner");
    assert.equal((await done(restored, "queued")).status, "succeeded");
});

test("a real background worker keeps reads responsive and diagnoses an incomplete source without compiling", async t => {
    const f = setup(t, undefined); const worker = new ProductionCompilationService(f.service, f.root);
    worker.enqueue("e", "owner", "real-worker", 1);
    let responsive = false; setImmediate(() => { responsive = true; });
    const { setTimeout: pause } = await import("node:timers/promises");
    let status: any;
    for (let i = 0; i < 300; i++) { await pause(10); status = worker.getCompilation("e", "owner", "real-worker"); if (!["queued", "running"].includes(status.status)) break; }
    assert.equal(responsive, true); assert.equal(status.status, "blocked"); assert.equal(status.preparedId, undefined);
    const diagnostics: any = worker.getCompilation("e", "owner", "real-worker", "diagnostics", 0, 10);
    assert.ok(diagnostics.items.some((item: any) => item.code === "COMPILE_STAGE_NOT_READY"));
});
test("queued compilation reads frozen media even when the original file changes", async t => {
    const f = setup(t, undefined); const original = path.join(f.root, "reference.png"); fs.writeFileSync(original, "approved bytes");
    f.service.compilationReferenceFiles = () => ({ "A\0asset": original });
    const candidate = structuredClone(director); candidate.assets.A = { version: "1", status: "approved", storageKey: "reference.png" };
    const compiler: any = (input: any, _directory: string, resolve: any) => { assert.equal(fs.readFileSync(resolve("A", "asset"), "utf8"), "approved bytes"); return result(input); };
    const jobs = new ProductionCompilationService(f.service, f.root, compiler);
    jobs.enqueue("e", "owner", "frozen", 1, candidate); fs.writeFileSync(original, "changed bytes");
    assert.equal((await done(jobs, "frozen")).status, "succeeded");
});
test("completed compilation cannot overwrite a concurrently edited source", async t => {
    const f = setup(t, result); f.compilations.enqueue("e", "owner", "op", 1); f.change();
    const status: any = await done(f.compilations, "op"); assert.equal(status.status, "succeeded");
    assert.throws(() => f.compilations.apply("e", "owner", status.preparedId), /conflict/);
});

test("active Python compiler succeeds in the worker and returns only compact program receipts", async t => {
    const { resolveAchengEngine } = await import("@basketikun/canvas-agent/skills/acheng");
    const { canonicalProduction } = await import("@basketikun/canvas-agent/drama/production-contract");
    const crypto = await import("node:crypto");
    const runtime = resolveAchengEngine();
    const candidate = structuredClone(director);
    candidate.engine = { commit: runtime.commit, patchVersion: runtime.patchVersion, runtimeId: runtime.runtimeId, version: runtime.version };
    candidate.source = JSON.parse(fs.readFileSync(path.join(runtime.path, "templates", "style-anchor-stage.json"), "utf8"));
    candidate.sourceHash = crypto.createHash("sha256").update(canonicalProduction(candidate.source)).digest("hex");
    const f = setup(t, undefined); const base = f.service.get(); base.draft.director = candidate; f.service.get = () => structuredClone(base);
    const jobs = new ProductionCompilationService(f.service, f.root); jobs.enqueue("e", "owner", "python", 1);
    const { setTimeout: pause } = await import("node:timers/promises"); let status: any;
    for (let i = 0; i < 1000; i++) { await pause(10); status = jobs.getCompilation("e", "owner", "python"); if (!["queued", "running"].includes(status.status)) break; }
    assert.equal(status.status, "succeeded", JSON.stringify(jobs.getCompilation("e", "owner", "python", "diagnostics", 0, 20)));
    assert.ok(status.preparedId); assert.ok(status.targetCount > 0);
    const index: any = jobs.getCompilation("e", "owner", "python", "targets", 0, 10);
    assert.ok(index.items.every((item: any) => !('prompt' in item)));
});

test("queued and synchronous real compilation retain their captured runtime across activation changes", async t => {
    const { resolveAchengEngine } = await import("@basketikun/canvas-agent/skills/acheng");
    const { canonicalProduction } = await import("@basketikun/canvas-agent/drama/production-contract");
    const crypto = await import("node:crypto");
    const installed = resolveAchengEngine();
    const f = setup(t, result), home = path.join(f.root, "codex-home"), base = path.join(home, "skill-runtimes", "acheng-director");
    const originalHome = process.env.CODEX_HOME;
    t.after(() => { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; });
    const makeRuntime = (letter: string) => {
        const commit = letter.repeat(40), patchVersion = letter.repeat(16), runtimeId = `${commit}-${patchVersion}`;
        const directory = path.join(base, "versions", runtimeId);
        fs.cpSync(installed.path, directory, { recursive: true });
        const identity = { commit, patchVersion, runtimeId, version: `test-${letter}` };
        const manifestFile = path.join(directory, "canvas-engine.json");
        fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), ...identity }));
        return { ...identity, path: directory };
    };
    const old = makeRuntime("a"), next = makeRuntime("b");
    const activate = (runtime: typeof old) => fs.writeFileSync(path.join(base, "active.json"), JSON.stringify({ active: runtime }));
    process.env.CODEX_HOME = home; activate(next);
    const candidate = structuredClone(director);
    candidate.engine = { commit: old.commit, patchVersion: old.patchVersion, runtimeId: old.runtimeId, version: old.version };
    candidate.source = JSON.parse(fs.readFileSync(path.join(installed.path, "templates", "style-anchor-stage.json"), "utf8"));
    candidate.sourceHash = crypto.createHash("sha256").update(canonicalProduction(candidate.source)).digest("hex");
    const baseline = f.service.get(); baseline.draft.director = candidate; f.service.get = () => structuredClone(baseline);
    // Hold all three slots so activation changes before the real worker starts.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.after(release);
    const blockers = new ProductionCompilationService(f.service, f.root, (async (input: any) => { await gate; return result(input); }) as any);
    for (let i = 0; i < 3; i++) blockers.enqueue("e", "owner", `block-${i}`, 1);
    const jobs = new ProductionCompilationService(f.service, f.root);
    jobs.enqueue("e", "owner", "captured", 1);
    assert.equal(jobs.getCompilation("e", "owner", "captured").status, "queued");
    activate(old);
    assert.equal((jobs.enqueue("e", "owner", "captured", 1) as any).replayed, true);
    release();
    const { setTimeout: pause } = await import("node:timers/promises");
    let status: any;
    for (let i = 0; i < 1000; i++) {
        await pause(10); status = jobs.getCompilation("e", "owner", "captured");
        if (!["queued", "running"].includes(status.status)) break;
    }
    assert.equal(status.status, "succeeded", JSON.stringify(jobs.getCompilation("e", "owner", "captured", "diagnostics", 0, 20)));
    const packet = JSON.parse(fs.readFileSync(path.join(f.root, status.preparedId, "packet.json"), "utf8"));
    assert.equal(packet.director.engine.runtimeId, next.runtimeId);
    assert.ok(packet.director.artifacts.every((artifact: any) => artifact.receipt.engineRuntimeId === next.runtimeId));
    assert.deepEqual(f.service.get(), baseline);
    assert.equal((jobs.enqueue("e", "owner", "captured", 1) as any).replayed, true);
    activate(next);
    f.service.preflight = (_id: string, _request: unknown, runtimeId: string) => {
        assert.equal(runtimeId, next.runtimeId);
        activate(old); return { valid: true, diagnostics: [] };
    };
    f.service.compilationReferenceFile = () => undefined;
    const prepared = jobs.prepare("e", "owner", 1);
    assert.equal(prepared.engine.runtimeId, next.runtimeId);
    const synchronous = JSON.parse(fs.readFileSync(path.join(f.root, prepared.preparedId, "packet.json"), "utf8"));
    assert.ok(synchronous.director.artifacts.every((artifact: any) => artifact.receipt.engineRuntimeId === next.runtimeId));
});
