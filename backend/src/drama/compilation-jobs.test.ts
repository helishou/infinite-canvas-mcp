import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { ProductionCompilationService } from "./compilation.js";
const director: any = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "1" }, source: { brief: "source" }, sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
function setup(t: any, compiler: any) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compilation-jobs-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let current: any = { revision: 1, draft: { director: structuredClone(director) } };
    const service: any = { get: () => structuredClone(current), verifyCompilationBindings: () => {}, compilationReferenceFiles: () => ({}), edit: (_id: string, input: any) => {
        if (current.revision !== input.expectedRevision) throw new Error("conflict"); current = { ...current, revision: 2, draft: { director: input.ops[0].director } }; return structuredClone(current);
    } };
    return { root, service, compilations: new ProductionCompilationService(service, root, compiler), change: () => { current.revision++; } };
}
const result = (input: any) => ({ director: input, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} });
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

test("a real background worker keeps reads responsive and reports preflight failure without compiling", async t => {
    const f = setup(t, undefined); const worker = new ProductionCompilationService(f.service, f.root);
    worker.enqueue("e", "owner", "real-worker", 1);
    let responsive = false; setImmediate(() => { responsive = true; });
    const { setTimeout: pause } = await import("node:timers/promises");
    let status: any;
    for (let i = 0; i < 300; i++) { await pause(10); status = worker.getCompilation("e", "owner", "real-worker"); if (!["queued", "running"].includes(status.status)) break; }
    assert.equal(responsive, true); assert.equal(status.status, "blocked"); assert.equal(status.preparedId, undefined);
    const diagnostics: any = worker.getCompilation("e", "owner", "real-worker", "diagnostics", 0, 10);
    assert.ok(diagnostics.items.some((item: any) => item.code === "ENGINE_UNAVAILABLE"));
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

test("pinned Python compiler succeeds in the worker and returns only compact program receipts", async t => {
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
