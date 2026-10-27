import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { directorModules, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { ClipRefreshCoordinator, ClipRefreshStore, clipRefreshReceipt, type ClipRefreshJob } from "./clip-refresh.js";

function makeStore() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE production_clip_refresh_jobs (owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, parent_operation_id TEXT NOT NULL, compilation_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, job_json TEXT NOT NULL, PRIMARY KEY(owner_kind, owner_id, operation_id))");
    return { db, store: new ClipRefreshStore(db, { kind: "episode", id: "EP" }) };
}

function director(): DirectorProduction {
    return {
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "4.3.9" },
        source: {
            prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, scene_registry: [], script_scenes: [],
            subject_registry: [], asset_plan: [], asset_cards: [], utterances: [],
            shots: [{ id: "S1", timeline_id: "main", story_order: 0, duration_frames: 48, subject_usages: [], keyframes: [], utterance_refs: [] }],
            segments: [{ id: "CLIP_A", shot_ids: ["S1"], mode: "Ref2VA" }],
            ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] },
        },
        sourceHash: "a".repeat(64),
        modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned", evidence: [], unresolved: [] }])),
        artifacts: [], assets: {}, shotInputs: { S1: { keyframePolicy: "none", assetIds: [] } }, boundaries: [],
        executionAuthorized: false, unresolved: [], workflow: {},
    } as DirectorProduction;
}

function job(operationId: string, segmentId: string, updatedAt: string, status: ClipRefreshJob["status"], owner: ClipRefreshJob["owner"] = { kind: "episode", id: "EP" }): ClipRefreshJob {
    return {
        owner, operationId, parentOperationId: "edit", compilationOperationId: "compile:" + operationId,
        continuityOperationId: "continuity:" + operationId, segmentId, savedRevision: 3, sourceHash: "s", inputHash: "i",
        snapshot: {} as any, affectedTargets: [], diagnostics: [], timings: {}, status, createdAt: updatedAt, updatedAt,
    };
}

test("current refresh receipt is the newest operation per Clip and remains owner-scoped", () => {
    const { db, store } = makeStore();
    const insert = db.prepare("INSERT INTO production_clip_refresh_jobs(owner_kind,owner_id,operation_id,parent_operation_id,compilation_id,status,job_json) VALUES(?,?,?,?,?,?,?)");
    for (const value of [
        job("A-old", "CLIP_A", "2026-01-01T00:00:00.000Z", "blocked"),
        job("A-new", "CLIP_A", "2026-01-02T00:00:00.000Z", "succeeded"),
        job("B-new", "CLIP_B", "2026-01-03T00:00:00.000Z", "compiling"),
        job("other-owner", "CLIP_C", "2026-01-04T00:00:00.000Z", "blocked", { kind: "canvas", id: "EP" }),
    ]) insert.run(value.owner.kind, value.owner.id, value.operationId, value.parentOperationId, value.compilationOperationId, value.status, JSON.stringify(value));
    assert.deepEqual(store.currentBySegment().map(value => [value.segmentId, value.status]).sort(), [["CLIP_A", "succeeded"], ["CLIP_B", "compiling"]]);
    db.close();
});

test("automatic Clip refresh advances once from continuity check through compile and reference sync", async () => {
    const { db, store } = makeStore();
    const source = director();
    const job = store.register("edit-1", 4, source, source, "CLIP_A");
    let enqueues = 0, applications = 0;
    const service = {
        clipRefreshStore: () => store,
        get: () => ({ revision: 4, draft: { director: source } }),
        resolveSubjectPictureInputs: (_id: string, value: DirectorProduction) => value,
        targetOccupancy: () => [],
        continuityForDirector: () => ({ status: "passed", sourceHash: source.sourceHash, runtime: { runtimeId: "runtime" },
            report: { stale: false, sourceHash: source.sourceHash, runtimeId: "runtime", selectedTargets: ["CLIP_A"], diagnostics: [] } }),
        checkContinuity: () => { throw new Error("a current continuity receipt should be reused"); },
    };
    const compilations = {
        enqueue: () => { enqueues++; return { status: "succeeded", preparedId: "prepared-1" }; },
        getCompilation: (_id: string, _owner: string, _operationId: string, view?: string) => view === "targets"
            ? { items: [{ targetId: "CLIP_A", status: "ready" }], total: 1 }
            : { status: "succeeded", preparedId: "prepared-1" },
        apply: () => { applications++; return { revision: 5, sourceHash: "b".repeat(64), referenceSync: [{ targetId: "CLIP_A", status: "ready", referenceCount: 2 }] }; },
    };
    new ClipRefreshCoordinator(service as any, compilations as any, "owner").wake("EP");
    await new Promise<void>(resolve => setImmediate(resolve));
    const current = store.get(job.compilationOperationId)!;
    assert.equal(current.status, "succeeded");
    assert.equal(enqueues, 1);
    assert.equal(applications, 1);
    assert.equal(clipRefreshReceipt(current).mediaSubmitted, false);
    assert.equal(current.application.referenceSync[0].referenceCount, 2);
    db.close();
});

test("automatic Clip refresh is superseded when the target input changes and never enqueues stale output", async () => {
    const { db, store } = makeStore();
    const snapshot = director();
    store.register("edit-old", 4, snapshot, snapshot, "CLIP_A");
    const current = structuredClone(snapshot);
    (current.source.segments as Array<Record<string, unknown>>)[0].mode = "T2VA";
    let enqueues = 0;
    const service = {
        clipRefreshStore: () => store,
        get: () => ({ revision: 5, draft: { director: current } }),
        resolveSubjectPictureInputs: (_id: string, value: DirectorProduction) => value,
        targetOccupancy: () => [],
    };
    const compilations = { enqueue: () => { enqueues++; return { status: "succeeded", preparedId: "unexpected" }; } };
    const coordinator = new ClipRefreshCoordinator(service as any, compilations as any, "owner");
    coordinator.wake("EP");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(store.byEdit("edit-old")?.status, "superseded");
    assert.equal(enqueues, 0);
    db.close();
});

test("automatic Clip refresh carries the compiler target diagnostic instead of replacing it with a generic not-ready error", async () => {
    const { db, store } = makeStore();
    try {
        const source = director(), entry = store.register("edit-diagnostic", 4, source, source, "CLIP_A");
        const service = {
            clipRefreshStore: () => store,
            get: () => ({ revision: 4, draft: { director: source } }),
            resolveSubjectPictureInputs: (_id: string, value: DirectorProduction) => value,
            targetOccupancy: () => [],
        };
        const compilations = {
            enqueue: () => ({ status: "succeeded", preparedId: "prepared-not-ready" }),
            getCompilation: (_id: string, _owner: string, _operationId: string, view?: string) => view === "targets"
                ? { items: [{ targetId: "CLIP_A", status: "blocked", diagnostics: [{ code: "INVALID_SUBJECT_SOURCE", path: "shots.S1.camera", message: "framing is required" }] }], total: 1 }
                : { status: "succeeded", preparedId: "prepared-not-ready" },
        };
        new ClipRefreshCoordinator(service as any, compilations as any, "owner").wake("EP");
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(store.get(entry.compilationOperationId)?.status, "blocked");
        assert.deepEqual(store.get(entry.compilationOperationId)?.diagnostics, [{ code: "INVALID_SUBJECT_SOURCE", path: "shots.S1.camera", message: "framing is required" }]);
    } finally { db.close(); }
});


test("refresh receipts resolve both public operation identity and compilation identity within their owner", () => {
 const { db, store } = makeStore();
 try {
  const d = director(), entry = store.register("edit", 1, d, d, "CLIP_A");
  assert.equal(store.get(entry.operationId)?.segmentId, "CLIP_A");
  assert.equal(store.get(entry.compilationOperationId)?.operationId, entry.operationId);
  assert.equal(new ClipRefreshStore(db, {kind:"episode",id:"OTHER"}).get(entry.operationId), undefined);
  assert.equal(store.get("edit"), undefined);
 } finally { db.close(); }
});

test("a parent edit operation returns one aggregated status for all its targeted Clip refreshes", () => {
 const { db, store } = makeStore();
 try {
  const first = job("parent:clip:CLIP_A", "CLIP_A", "2026-02-01T00:00:00.000Z", "succeeded");
  const second = job("parent:clip:CLIP_B", "CLIP_B", "2026-02-01T00:00:01.000Z", "compiling");
  first.application = { revision: 5, sourceHash: "s", referenceSync: [{ targetId: "CLIP_A", status: "ready" }, { targetId: "UNRELATED", status: "blocked" }] };
  first.parentOperationId = "parent"; second.parentOperationId = "parent";
  const insert = db.prepare("INSERT INTO production_clip_refresh_jobs(owner_kind,owner_id,operation_id,parent_operation_id,compilation_id,status,job_json) VALUES(?,?,?,?,?,?,?)");
  for (const item of [first, second]) insert.run(item.owner.kind, item.owner.id, item.operationId, item.parentOperationId, item.compilationOperationId, item.status, JSON.stringify(item));
  const coordinator = new ClipRefreshCoordinator({ clipRefreshStore: () => store } as any, {} as any, "owner");
  const summary: any = coordinator.inspect("EP", "parent");
  assert.equal(summary.targetCount, 2);
  assert.equal(summary.status, "running");
  assert.deepEqual(summary.counts, { ready: 1, running: 1, blocked: 0, failed: 0, translated: 0, translating: 0, translationRetryRequired: 0, translationRejectedStale: 0 });
  assert.deepEqual(summary.phases, { source: "saved", compilation: "running", application: "pending", translation: "not_started", mediaSubmitted: false });
  assert.deepEqual(summary.targets.map((item: any) => item.segmentId), ["CLIP_A", "CLIP_B"]);
  assert.equal(summary.mediaSubmitted, false);
  const one: any = coordinator.inspect("EP", first.operationId);
  assert.deepEqual(one.phases, { source: "saved", compilation: "succeeded", application: "ready", translation: "not_started", mediaSubmitted: false });
  assert.deepEqual(one.referenceSync.map((item: any) => item.targetId), ["CLIP_A"], "a per-Clip receipt never carries unrelated sync blockers");
 } finally { db.close(); }
});
