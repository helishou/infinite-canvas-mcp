import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { directorModules, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { ClipRefreshCoordinator, ClipRefreshStore, clipRefreshReceipt, retryableRefreshFailure, type ClipRefreshJob } from "./clip-refresh.js";

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

test("只有异步校验期间的瞬时冲突才算可重排", () => {
    assert.equal(retryableRefreshFailure(new Error("SOURCE_CHANGED_DURING_VALIDATION: 制作依赖在异步校验期间变化，请重试")), true);
    assert.equal(retryableRefreshFailure(Object.assign(new Error("制作稿版本已变化，请核对当前版本后重试"), { current: {} })), true);
    assert.equal(retryableRefreshFailure(Object.assign(new Error("boom"), { code: "COMPILATION_INPUT_CHANGED" })), true);
    // 真正的校验错误必须留给用户：重排只会重复失败。
    assert.equal(retryableRefreshFailure(new Error("缺少正式导演源稿")), false);
    assert.equal(retryableRefreshFailure(Object.assign(new Error("path: message"), { diagnostics: [{ code: "INVALID_SUBJECT_SOURCE" }] })), false);
});

test("异步校验期间被其它编辑改写时按退避重排同一 operationId，而不是直接 failed", async () => {
    const { db, store } = makeStore();
    const source = director();
    const entry = store.register("edit-conflict", 4, source, source, "CLIP_A");
    const enqueues: string[] = [];
    let applies = 0;
    const service = {
        clipRefreshStore: () => store,
        get: () => ({ revision: 4, draft: { director: source } }),
        resolveSubjectPictureInputs: (_id: string, value: DirectorProduction) => value,
        targetOccupancy: () => [],
    };
    const compilations = {
        enqueue: (_id: string, _owner: string, operationId: string) => { enqueues.push(operationId); return { status: "succeeded", preparedId: `prepared-${enqueues.length}` }; },
        getCompilation: (_id: string, _owner: string, _operationId: string, view?: string) => view === "targets"
            ? { items: [{ targetId: "CLIP_A", status: "ready" }], total: 1 }
            : { status: "succeeded", preparedId: `prepared-${enqueues.length}` },
        apply: () => {
            applies++;
            if (applies === 1) throw new Error("SOURCE_CHANGED_DURING_VALIDATION: 制作依赖在异步校验期间变化，请重试");
            return { revision: 5, sourceHash: "b".repeat(64), referenceSync: [{ targetId: "CLIP_A", status: "ready", referenceCount: 1 }] };
        },
    };
    const coordinator = new ClipRefreshCoordinator(service as any, compilations as any, "owner");
    coordinator.wake("EP");
    await new Promise<void>(resolve => setImmediate(resolve));
    const retried = store.get(entry.operationId)!;
    assert.equal(retried.status, "queued", "瞬时冲突不应落成终态 failed");
    assert.equal(retried.attempts, 1);
    assert.equal(retried.compileOperationId, `${entry.compilationOperationId}:r1`, "重排必须换编译 id，否则同 id 幂等重放拿不到新结果");
    assert.equal(retried.diagnostics[0].code, "CLIP_REFRESH_RETRY_SCHEDULED");
    assert.ok(Date.parse(retried.nextAttemptAt!) > Date.now());
    // 退避等待期内再次唤醒不推进
    coordinator.wake("EP");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(enqueues.length, 1);
    // 到点后按新编译 id 重排并成功，刷新任务的 operationId 保持不变
    const due = store.get(entry.operationId)!;
    due.nextAttemptAt = new Date(Date.now() - 1).toISOString();
    store.save(due);
    coordinator.wake("EP");
    await new Promise<void>(resolve => setImmediate(resolve));
    const settled = store.get(entry.operationId)!;
    assert.equal(settled.operationId, entry.operationId);
    assert.equal(settled.status, "succeeded");
    assert.equal(enqueues.length, 2);
    assert.notEqual(enqueues[1], enqueues[0]);
    db.close();
});

test("重排次数用尽后仍然失败，不会无限重试", async () => {
    const { db, store } = makeStore();
    const source = director();
    const entry = store.register("edit-exhausted", 4, source, source, "CLIP_A");
    const service = {
        clipRefreshStore: () => store,
        get: () => ({ revision: 4, draft: { director: source } }),
        resolveSubjectPictureInputs: (_id: string, value: DirectorProduction) => value,
        targetOccupancy: () => [],
    };
    const compilations = {
        enqueue: () => ({ status: "succeeded", preparedId: "prepared" }),
        getCompilation: (_id: string, _owner: string, _operationId: string, view?: string) => view === "targets"
            ? { items: [{ targetId: "CLIP_A", status: "ready" }], total: 1 }
            : { status: "succeeded", preparedId: "prepared" },
        apply: () => { throw new Error("SOURCE_CHANGED_DURING_VALIDATION: 一直冲突"); },
    };
    const coordinator = new ClipRefreshCoordinator(service as any, compilations as any, "owner");
    for (let attempt = 0; attempt < 5; attempt++) {
        const pending = store.get(entry.operationId)!;
        if (pending.nextAttemptAt) { pending.nextAttemptAt = new Date(Date.now() - 1).toISOString(); store.save(pending); }
        coordinator.wake("EP");
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    const settled = store.get(entry.operationId)!;
    assert.equal(settled.status, "failed");
    assert.equal(settled.attempts, 3);
    db.close();
});
