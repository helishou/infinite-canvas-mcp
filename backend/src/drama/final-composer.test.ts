import assert from "node:assert/strict";
import test from "node:test";
import { FinalComposer, collectFinalVideos, isFinalStale, renderReadiness, type RecomposeDeps } from "./final-composer.js";

const FINAL_AT = "2026-01-01T00:00:00Z";
const NOW = "2026-01-02T00:00:00Z";

function canvas(generatedAt: string, inputOutdated = false) {
    return {
        nodes: [{
            id: "h3",
            type: "minimax-h3",
            metadata: { segments: [{
                id: "seg1",
                resultStorageKey: "video:seg-new",
                inputOutdated,
                results: [{ storageKey: "video:seg-new", generationLogId: "log1" }],
            }] },
        }],
        generatedAt,
    };
}

type Fixture = {
    deps: RecomposeDeps;
    state: {
        final: Record<string, unknown> | undefined;
        revision: number;
        logs: Record<string, { finishedAt?: string; startedAt?: string }>;
        runCalls: Array<{ videos: string[]; clientTaskId?: string }>;
        edits: Array<Record<string, any>>;
        events: Array<Record<string, any>>;
        tasks: Record<string, any>;
    };
    release?: (value?: unknown) => void;
};

function fixture(options: { noFinal?: boolean; generatedAt?: string; inputOutdated?: boolean; holdRun?: boolean; failRun?: boolean } = {}): Fixture {
    const generatedAt = options.generatedAt ?? "2026-01-01T00:10:00Z";
    const graph = canvas(generatedAt, options.inputOutdated ?? false);
    const final = options.noFinal
        ? undefined
        : { storageKey: "video:old-final", at: FINAL_AT, stale: false };
    const state: Fixture["state"] = {
        final, revision: 7,
        logs: { log1: { finishedAt: generatedAt } },
        runCalls: [], edits: [], events: {}, tasks: {},
    } as Fixture["state"];
    state.events = [];
    const deps: RecomposeDeps = {
        db: {
            getDramaEpisode: (id) => id === "ep" ? { id: "ep", canvasId: "canvas" } : null,
            getCanvasProject: (id) => id === "canvas" ? graph as any : null,
            getGenerationLog: (id) => state.logs[id] || null,
        },
        production: {
            get: () => ({ revision: state.revision, draft: { director: { workflow: { finalResource: state.final } } } }),
            edit: (_id, raw) => {
                const body = raw as Record<string, any>;
                state.edits.push(body);
                state.revision += 1;
                const patch = body.ops[0].patch.finalResource;
                state.final = patch;
                return { revision: state.revision };
            },
        },
        videoConcat: {
            run: async (videos, _output, _longEdge, clientTaskId) => {
                state.runCalls.push({ videos: [...videos], clientTaskId });
                const task = { id: "concat-1", status: "running", result: null, error: null };
                state.tasks["concat-1"] = task;
                const settle = () => {
                    if (options.failRun) {
                        task.status = "failed";
                        task.error = "FFMPEG_FAILED";
                    } else {
                        task.status = "succeeded";
                        task.result = { media: { storageKey: "video:new-final" } };
                    }
                };
                if (options.holdRun) return new Promise<any>((resolve) => { (f as Fixture).release = () => { settle(); resolve(task); }; });
                settle();
                return task as any;
            },
        },
        tasks: { get: (id) => state.tasks[id] || null },
        events: { publish: (event) => { state.events.push(event); return event; } },
        now: () => NOW,
        pollMs: 1,
        timeoutMs: 500,
    };
    const f: Fixture = { deps, state };
    return f;
}

test("isFinalStale：无成片 / stale 字段都不算过期", () => {
    assert.equal(isFinalStale(undefined, [{ inputOutdated: true }]), false);
    assert.equal(isFinalStale({ storageKey: "video:f", stale: true }, [{}]), false);
});

test("isFinalStale：inputOutdated 或段视频晚于合成时间（含 1s 容差）", () => {
    const final = { storageKey: "video:f", at: FINAL_AT };
    assert.equal(isFinalStale(final, [{ inputOutdated: true }]), true);
    assert.equal(isFinalStale(final, [{ generatedAt: "2026-01-01T00:10:00Z" }]), true);
    assert.equal(isFinalStale(final, [{ generatedAt: "2025-12-31T23:00:00Z" }]), false);
    assert.equal(isFinalStale(final, [{ generatedAt: "2026-01-01T00:00:00.500Z" }]), false);
    assert.equal(isFinalStale(final, [{ generatedAt: "not-a-date" }]), false);
});

test("collectFinalVideos：每段只取当前有效产物，results[] 历史不参与拼接", () => {
    const c = { nodes: [{ metadata: { segments: [
        { resultStorageKey: "video:a", results: [{ storageKey: "video:b" }, { storageKey: "video:a" }] },
        { resultStorageKey: "video:c", results: [] },
        { results: [{ storageKey: "video:old" }, { storageKey: "video:latest" }] },
    ] } }] };
    assert.deepEqual(collectFinalVideos(c), ["video:a", "video:c", "video:latest"]);
    assert.deepEqual(collectFinalVideos(null), []);
});

test("无成片时不自动合成（from-scratch 不擅自合成）", async () => {
    const f = fixture({ noFinal: true });
    const result = await new FinalComposer(f.deps).recomposeIfStale("ep");
    assert.deepEqual(result, { status: "skipped", episodeId: "ep", reason: "no-final" });
    assert.equal(f.state.runCalls.length, 0);
});

test("成片未过期时不重复合成", async () => {
    const f = fixture({ generatedAt: "2025-12-31T23:00:00Z" });
    const result = await new FinalComposer(f.deps).recomposeIfStale("ep");
    assert.deepEqual(result, { status: "skipped", episodeId: "ep", reason: "not-stale" });
    assert.equal(f.state.runCalls.length, 0);
});

test("段视频在成片后重新生成 → 自动重合成并写真实 finalResource", async () => {
    const f = fixture();
    const composer = new FinalComposer(f.deps);
    const result = await composer.recomposeIfStale("ep");
    assert.deepEqual(result, { status: "composed", episodeId: "ep", storageKey: "video:new-final", at: NOW, videos: 1 });
    assert.deepEqual(f.state.runCalls[0].videos, ["video:seg-new"]);
    assert.match(String(f.state.runCalls[0].clientTaskId), /^final-recompose-ep-/);
    assert.equal(f.state.edits.length, 1);
    assert.deepEqual(f.state.edits[0].ops[0].patch.finalResource, { storageKey: "video:new-final", at: NOW, stale: false });
    assert.equal(f.state.final?.storageKey, "video:new-final");
    assert.equal(f.state.events[0]?.type, "final-recomposed");
    // 幂等：合成后 at 刷新，再触发不再过期。
    assert.deepEqual(await composer.recomposeIfStale("ep"), { status: "skipped", episodeId: "ep", reason: "not-stale" });
    assert.equal(f.state.runCalls.length, 1);
});

test("inputOutdated 段也能触发自动重合成", async () => {
    const f = fixture({ generatedAt: "2025-12-31T00:00:00Z", inputOutdated: true });
    const result = await new FinalComposer(f.deps).recomposeIfStale("ep");
    assert.equal(result.status, "composed");
});

test("合成中重复触发返回 busy，不重复发起拼接；结束后解锁", async () => {
    const f = fixture({ holdRun: true });
    const composer = new FinalComposer(f.deps);
    const first = composer.recomposeIfStale("ep");
    // 等第一次进入 composing 后再发第二次。
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(composer.isComposing("ep"), true);
    assert.deepEqual(await composer.recomposeIfStale("ep"), { status: "busy", episodeId: "ep" });
    f.release?.();
    assert.equal((await first).status, "composed");
    assert.equal(composer.isComposing("ep"), false);
    assert.equal(f.state.runCalls.length, 1);
});

test("拼接失败返回 failed 并释放锁，不写 finalResource", async () => {
    const f = fixture({ failRun: true });
    const composer = new FinalComposer(f.deps);
    const result = await composer.recomposeIfStale("ep");
    assert.equal(result.status, "failed");
    assert.match(String((result as { error: string }).error), /FFMPEG_FAILED/);
    assert.equal(composer.isComposing("ep"), false);
    assert.equal(f.state.edits.length, 0);
});

test("force=true 可跳过 stale 判定显式重合成", async () => {
    const f = fixture({ generatedAt: "2025-12-31T00:00:00Z" });
    const result = await new FinalComposer(f.deps).recomposeIfStale("ep", { force: true });
    assert.equal(result.status, "composed");
});

test("render 准入：未出片/过期的段不允许合成，锁定段跳过", () => {
    const groups = [
        { id: "clip-a", nodeId: "h3", segmentId: "seg-a" },
        { id: "clip-b", nodeId: "h3", segmentId: "seg-b" },
        { id: "clip-locked", nodeId: "h3", segmentId: "seg-locked" },
    ];
    const segments = [
        { id: "seg-a", resultStorageKey: "video:a" },
        { id: "seg-b", resultStorageKey: "video:b", inputOutdated: true },
        { id: "seg-locked", resultStorageKey: "" },
    ];
    const source = [{ id: "clip-locked", locked: true }];
    const ready = renderReadiness({ nodes: [{ id: "h3", metadata: { segments } }] }, groups, source);
    assert.deepEqual(ready, { total: 2, missing: 0, stale: 1 }, "锁定段不计入，过期段挡住合成");

    const halfDone = renderReadiness({ nodes: [{ id: "h3", metadata: { segments: [segments[0], { id: "seg-b", resultStorageKey: "" }] } }] }, groups, source);
    assert.deepEqual(halfDone, { total: 2, missing: 1, stale: 0 }, "只出一段视频不能合成整集");
});
