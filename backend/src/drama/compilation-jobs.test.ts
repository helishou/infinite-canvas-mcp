import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { ProductionCompilationService, productionCompilationBusy } from "./compilation.js";
const director: any = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "1" }, source: { version: 2, prompt_assembly: { version: 2 }, brief: "source", fps_num: 24, fps_den: 1, subject_registry: [], character_registry: [], scene_registry: [], shots: [], segments: [], utterances: [], asset_plan: [], asset_cards: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } }, sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };

test("active Python audit preserves standalone quality-warning provenance through the shared compiler adapter", async t => {
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
    assert.equal(error.targetId, segment.id); assert.equal(error.origin, "source");
    assert.equal(error.severity, "warning"); assert.equal(error.blocksCompilation, false);
    assert.deepEqual(error.blockingActions, []);
});
function setup(t: any, compiler: any) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compilation-jobs-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let current: any = { revision: 1, draft: { director: structuredClone(director) } };
    const service: any = { get: () => structuredClone(current), canvasStyleAnchorInput: () => undefined, verifyCompilationBindings: () => {}, compilationReferenceFiles: () => ({}),
        resolveSubjectPictureInputs: (_id: string, input: any) => structuredClone(input), preflight: (_id: string, request: any) => request.action === "compile" &&
            !request.request?.director?.source?.asset_cards?.length && !request.request?.director?.source?.segments?.length
            ? { valid: false, diagnostics: [{ code: "COMPILE_STAGE_NOT_READY", path: "director.source", message: "incomplete", severity: "error" }] }
            : { valid: true, diagnostics: [] }, edit: (_id: string, input: any) => {
        if (current.revision !== input.expectedRevision) throw new Error("conflict"); current = { ...current, revision: 2, draft: { director: input.ops[0].director } }; return structuredClone(current);
    } };
    return { root, service, compilations: new ProductionCompilationService(service, root, compiler), change: () => {
        current = structuredClone(current); current.revision++; current.draft.director.source.brief = "changed while compiling";
    } };
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
    for (let i = 0; i < 300; i++) { await new Promise<void>(resolve => setTimeout(resolve, 1)); const status = compilations.getCompilation("e", "owner", op); if (!["queued", "running"].includes(status.status)) return status; }
    throw new Error("job did not finish");
}
test("lost response and identical submissions retain one compiler invocation and a prompt-free receipt", async t => {
    let calls = 0; const f = setup(t, (input: any) => { calls++; return result(input); });
    const first = f.compilations.enqueue("e", "owner", "op", 1);
    assert.ok(["queued", "running"].includes(first.status)); assert.equal((f.compilations.enqueue("e", "owner", "op", 1) as any).replayed, true);
    assert.throws(() => f.compilations.enqueue("e", "owner", "op", 2), /IDEMPOTENCY_CONFLICT/);
    const completed: any = await done(f.compilations, "op"); assert.equal(completed.status, "succeeded"); assert.equal(calls, 1);
    assert.equal(JSON.stringify(completed).includes('"prompt"'), false);
    const application = f.compilations.apply("e", "owner", completed.preparedId);
    assert.equal(productionCompilationBusy(), true, "async apply manifest verification keeps development reload deferred");
    await application;
    assert.equal(productionCompilationBusy(), false);
    assert.equal(f.compilations.getCompilation("e", "owner", "op").application.revision, 2);
    assert.equal((f.compilations.enqueue("e", "owner", "op", 1) as any).replayed, true, "a lost response can recover the applied result with the original request revision");
    assert.throws(() => f.compilations.getCompilation("e", "other", "op"), /不属于/);
});
test("a required image that is not archived stays generation-blocking but does not block draft compilation", async t => {
    const f = setup(t, result);
    f.service.resolveSubjectPictureInputs = (_id: string, input: any, _targets: string[] | undefined, _forCompilation: boolean, _previewSubjects: string[] | undefined, diagnostics?: any[]) => {
        diagnostics?.push({ code: "SUBJECT_IMAGE_RESULT_MISSING", path: "shots.S1.keyframes.KF1.selection", targetId: "SEG1",
            message: "图片尚未归档", severity: "warning", blocksCompilation: false, blockingActions: ["generate"] });
        return structuredClone(input);
    };
    f.compilations.enqueue("e", "owner", "draft-with-missing-keyframe", 1);
    const completed: any = await done(f.compilations, "draft-with-missing-keyframe");
    assert.equal(completed.status, "succeeded");
    const report: any = f.compilations.getCompilation("e", "owner", "draft-with-missing-keyframe", "diagnostics", 0, 10);
    assert.ok(report.items.some((item: any) => item.code === "SUBJECT_IMAGE_RESULT_MISSING" && item.targetId === "SEG1" && item.blockingActions?.includes("generate")));
    await f.compilations.apply("e", "owner", completed.preparedId);
    assert.equal(f.compilations.getCompilation("e", "owner", "draft-with-missing-keyframe").application.revision, 2);
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
test("queued compilation reads frozen media but refuses to apply after the indexed media input changes", async t => {
    const f = setup(t, undefined); const original = path.join(f.root, "reference.png"); fs.writeFileSync(original, "approved bytes");
    f.service.compilationReferenceFiles = () => ({ "A\0asset": original });
    const candidate = structuredClone(director); candidate.assets.A = { version: "1", status: "approved", storageKey: "reference.png" };
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const compiler: any = async (input: any, _directory: string, resolve: any) => {
        assert.equal(fs.readFileSync(resolve("A", "asset"), "utf8"), "approved bytes"); signalStarted();
        await new Promise(resolve => setTimeout(resolve, 20));
        return result(input);
    };
    const jobs = new ProductionCompilationService(f.service, f.root, compiler);
    jobs.enqueue("e", "owner", "frozen", 1, candidate); await started; fs.writeFileSync(original, "changed bytes");
    const status: any = await done(jobs, "frozen");
    assert.equal(status.status, "blocked");
    const details: any = jobs.getCompilation("e", "owner", "frozen", "diagnostics", 0, 10);
    assert.ok(details.items.some((item: any) => item.code === "COMPILATION_INPUT_CHANGED"));
});

test("queued media preparation uses the MediaStore digest captured at submission", async t => {
    const f = setup(t, result); const file = path.join(f.root, "reference.png"); fs.writeFileSync(file, "approved bytes");
    const approvedDigest = crypto.createHash("sha256").update("approved bytes").digest("hex");
    f.service.compilationReferenceFiles = () => ({ "A\0asset": file });
    f.service.isArchivedMediaPath = () => true;
    f.service.archivedMediaDigest = () => approvedDigest;
    const candidate = structuredClone(director); candidate.assets.A = { version: "1", status: "approved", storageKey: "reference.png" };
    const jobs = new ProductionCompilationService(f.service, f.root, result);
    jobs.enqueue("e", "owner", "changed-before-hash", 1, candidate);
    fs.writeFileSync(file, "changed bytes");
    const status: any = await done(jobs, "changed-before-hash");
    assert.equal(status.status, "blocked");
    const details: any = jobs.getCompilation("e", "owner", "changed-before-hash", "diagnostics", 0, 10);
    assert.ok(details.items.some((item: any) => item.code === "COMPILATION_MEDIA_INTEGRITY_FAILED"));
});

test("large media digests stream without blocking the Backend event loop or retaining file buffers", async t => {
    const f = setup(t, result);
    const file = path.join(f.root, "large-reference.bin");
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const fd = fs.openSync(file, "w");
    try { for (let i = 0; i < 16; i++) fs.writeSync(fd, chunk); } finally { fs.closeSync(fd); }
    const input = structuredClone(director);
    input.assets = { A: { version: "1", status: "approved", storageKey: "large-reference.bin" }, B: { version: "1", status: "approved", storageKey: "large-reference.bin" } };
    const service = f.compilations as any;
    const app = express(); app.get("/health", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    let eventLoopAdvanced = false;
    const originalCreateReadStream = fs.createReadStream;
    let streamOpens = 0;
    fs.createReadStream = ((...args: any[]) => { streamOpens++; return (originalCreateReadStream as any)(...args); }) as typeof originalCreateReadStream;
    setImmediate(() => { eventLoopAdvanced = true; });
    let material = new Map<string, any>();
    let health: Response | undefined;
    try {
        [material, health] = await Promise.all([
            service.collectMaterial({ "A\0asset": file, "B\0asset": file }, input),
            fetch(`http://127.0.0.1:${(server.address() as any).port}/health`, { signal: AbortSignal.timeout(3000) }),
        ]);
    }
    finally { fs.createReadStream = originalCreateReadStream; }
    assert.equal(eventLoopAdvanced, true);
    assert.equal(health?.status, 200, "a health probe during large-file hashing must answer before its existing 3s timeout");
    assert.equal(streamOpens, 1, "identical bound file paths are hashed once per verification boundary");
    assert.equal(material.size, 2);
    const expected = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(material.get("A\0asset").digest, expected);
    assert.equal(material.get("B\0asset").digest, expected);
    assert.equal("bytes" in material.get("A\0asset"), false);
});

test("large input manifest canonicalization runs in a Worker instead of the Backend event loop", async t => {
    const f = setup(t, result);
    const directorInput = structuredClone(director);
    directorInput.source.large_test_field = "x".repeat(8 * 1024 * 1024);
    const effective = { targetIds: [], reusable: [], input: directorInput };
    const service = f.compilations as any;
    const resultPromise = service.manifestFingerprint("e", "owner", directorInput, undefined, effective, {}, new Map());
    const firstTurn = await Promise.race([
        resultPromise.then(() => "finished"),
        new Promise<string>(resolve => setImmediate(() => resolve("yielded"))),
    ]);
    assert.equal(firstTurn, "yielded");
    assert.match((await resultPromise).fingerprint, /^[a-f0-9]{64}$/);
});
test("compilation detects a changed target input before publishing its prepared result", async t => {
    const f = setup(t, result); f.compilations.enqueue("e", "owner", "op", 1); f.change();
    const status: any = await done(f.compilations, "op"); assert.equal(status.status, "blocked");
    const details: any = f.compilations.getCompilation("e", "owner", "op", "diagnostics", 0, 10);
    assert.ok(details.items.some((item: any) => item.code === "COMPILATION_INPUT_CHANGED"));
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
    const originalHome = process.env.INFINITE_CANVAS_ACHENG_HOME;
    t.after(() => { if (originalHome === undefined) delete process.env.INFINITE_CANVAS_ACHENG_HOME; else process.env.INFINITE_CANVAS_ACHENG_HOME = originalHome; });
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
    process.env.INFINITE_CANVAS_ACHENG_HOME = home; activate(next);
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
    const prepared = await jobs.prepare("e", "owner", 1);
    assert.equal(prepared.engine.runtimeId, next.runtimeId);
    const synchronous = JSON.parse(fs.readFileSync(path.join(f.root, prepared.preparedId, "packet.json"), "utf8"));
    assert.ok(synchronous.director.artifacts.every((artifact: any) => artifact.receipt.engineRuntimeId === next.runtimeId));
});
