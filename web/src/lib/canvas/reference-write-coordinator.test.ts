import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasReferenceAsset, CanvasReferenceService } from "@/types/canvas-plugin";
import { createReferenceWriteCoordinator, ReferenceWriteSupersededError } from "./reference-write-coordinator";

type NamedInput = Parameters<CanvasReferenceService["upsert"]>[0] & { id: string };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
type WriteResult = CanvasReferenceAsset;

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    return { promise, resolve, reject };
}

function service(write: Partial<Pick<CanvasReferenceService, "upsert" | "upsertMany" | "remove">>): CanvasReferenceService {
    return {
        list: async () => [],
        upsert: async (input) => input as CanvasReferenceAsset,
        upsertMany: async (inputs) => inputs as CanvasReferenceAsset[],
        remove: async () => {},
        validate: async () => ({ semanticPrompt: "", compiledPrompt: "", bindings: [], references: [], issues: [], migratedLegacyRefs: false }),
        ...write,
    };
}

function asset(id: string, label: string): NamedInput {
    return { id, label, mediaType: "image", role: "storyboard", tags: [] };
}

async function tick() {
    await Promise.resolve();
    await Promise.resolve();
}

test("同 asset 同 signature 的并发单项写共享同一个在途 Promise", async () => {
    const pending = deferred<WriteResult>();
    let calls = 0;
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => { calls++; assert.equal(calls, 1); return pending.promise; },
    }));

    const first = coordinator.upsert(asset("a", "A"));
    const second = coordinator.upsert({ tags: ["a"], ...asset("a", "A") });
    assert.equal(calls, 0);
    assert.strictEqual(first, second);
    pending.resolve(asset("a", "A") as CanvasReferenceAsset);
    assert.deepEqual(await first, asset("a", "A"));
    assert.deepEqual(await second, asset("a", "A"));
});

test("不同 asset 并发写入保持独立 lane", async () => {
    const calls: NamedInput[] = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => {
            const value = input as NamedInput;
            calls.push(value);
            await tick();
            return value as CanvasReferenceAsset;
        },
    }));

    const a = coordinator.upsert(asset("a", "A"));
    const b = coordinator.upsert(asset("b", "B"));
    assert.notStrictEqual(a, b);
    await Promise.all([a, b]);
    assert.deepEqual(calls.map((item) => item.id), ["a", "b"]);
});

test("同 asset 不同 signature 串行提交，旧失败也不丢失新意图", async () => {
    const first = deferred<WriteResult>();
    const second = deferred<WriteResult>();
    const calls: NamedInput[] = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => {
            const value = input as NamedInput;
            calls.push(value);
            return calls.length === 1 ? first.promise : second.promise;
        },
    }));

    const a = coordinator.upsert(asset("a", "A"));
    await tick();
    const b = coordinator.upsert(asset("a", "B"));
    await tick();
    first.reject(new Error("A offline"));
    await assert.rejects(a, /A offline/);
    await tick();
    assert.deepEqual(calls.map((item) => item.label), ["A", "B"]);
    second.resolve(asset("a", "B") as CanvasReferenceAsset);
    assert.deepEqual(await b, asset("a", "B"));
});

test("queued 被覆盖时所有旧调用都随最终获胜写入结算", async () => {
    const running = deferred<WriteResult>();
    const winning = deferred<WriteResult>();
    const calls: NamedInput[] = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => {
            const value = input as NamedInput;
            calls.push(value);
            return calls.length === 1 ? running.promise : winning.promise;
        },
    }));

    const a = coordinator.upsert(asset("a", "A"));
    await tick();
    const b = coordinator.upsert(asset("a", "B"));
    await tick();
    const c = coordinator.upsert(asset("a", "C"));
    await tick();
    assert.deepEqual(calls.map((item) => item.label), ["A"]);

    running.resolve(asset("a", "A") as CanvasReferenceAsset);
    await a;
    await tick();
    assert.deepEqual(calls.map((item) => item.label), ["A", "C"]);
    winning.resolve(asset("a", "C") as CanvasReferenceAsset);
    assert.deepEqual(await b, asset("a", "C"));
    assert.deepEqual(await c, asset("a", "C"));
});

test("回退到在途 signature 会取消旧 queued，重复调用共享当前 Promise", async () => {
    const running = deferred<WriteResult>();
    const calls: NamedInput[] = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => {
            const value = input as NamedInput;
            calls.push(value);
            assert.equal(value.label, "A");
            return value as CanvasReferenceAsset;
        },
    }));

    const a1 = coordinator.upsert(asset("a", "A"));
    await tick();
    const b = coordinator.upsert(asset("a", "B"));
    const a2 = coordinator.upsert(asset("a", "A"));
    assert.strictEqual(a1, a2);
    await tick();
    const [aResult, bResult] = await Promise.all([a1, a2, b]);
    assert.deepEqual(aResult, asset("a", "A"));
    assert.deepEqual(bResult, asset("a", "A"));
    assert.deepEqual(calls.map((item) => item.label), ["A"]);
});

test("成功后同 signature 再写必须再次提交，失败后也可恢复", async () => {
    const failed = deferred<WriteResult>();
    let calls = 0;
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => {
            calls++;
            return calls === 1 ? failed.promise : input as CanvasReferenceAsset;
        },
    }));

    const first = coordinator.upsert(asset("a", "A"));
    failed.reject(new Error("offline"));
    await assert.rejects(first, /offline/);
    assert.deepEqual(await coordinator.upsert(asset("a", "A")), asset("a", "A"));
    assert.deepEqual(await coordinator.upsert(asset("a", "A")), asset("a", "A"));
    assert.equal(calls, 3);
});

test("list 刷新后仍保留在途去重，新显式写入会重新提交", async () => {
    const pending = deferred<WriteResult>();
    let calls = 0;
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => { calls++; return calls === 1 ? pending.promise : input as CanvasReferenceAsset; },
    }));

    const first = coordinator.upsert(asset("a", "A"));
    await tick();
    await coordinator.list();
    const shared = coordinator.upsert(asset("a", "A"));
    assert.strictEqual(first, shared);
    assert.equal(calls, 1);
    pending.resolve(asset("a", "A") as CanvasReferenceAsset);
    await first;
    await tick();
    assert.deepEqual(await coordinator.upsert(asset("a", "A")), asset("a", "A"));
    assert.equal(calls, 2);
});

test("多 asset 失败互不污染", async () => {
    const aFailure = deferred<WriteResult>();
    const bResult = deferred<WriteResult>();
    const calls: Array<[string, string]> = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => {
            const value = input as NamedInput;
            calls.push([value.id, value.label]);
            return value.id === "a" ? aFailure.promise : bResult.promise;
        },
    }));

    const a = coordinator.upsert(asset("a", "A"));
    const b = coordinator.upsert(asset("b", "B"));
    bResult.resolve(asset("b", "B") as CanvasReferenceAsset);
    assert.deepEqual(await b, asset("b", "B"));
    aFailure.reject(new Error("A offline"));
    await assert.rejects(a, /A offline/);
    assert.deepEqual(calls, [["a", "A"], ["b", "B"]]);
});

test("remove 在同 asset 写入后串行执行", async () => {
    const upsert = deferred<WriteResult>();
    const removal = deferred<void>();
    const calls: string[] = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => { calls.push(`upsert:${(input as NamedInput).label}`); return upsert.promise; },
        remove: async () => { calls.push("remove"); return removal.promise; },
    }));

    const a1 = coordinator.upsert(asset("a", "A"));
    await tick();
    const a2 = coordinator.upsert(asset("a", "A"));
    assert.equal(calls.length, 1);
    const removalResult = coordinator.remove("a");
    await tick();
    assert.deepEqual(calls, ["upsert:A"]);

    upsert.resolve(asset("a", "A") as CanvasReferenceAsset);
    await Promise.all([a1, a2]);
    await tick();
    assert.deepEqual(calls, ["upsert:A", "remove"]);
    removal.resolve();
    await removalResult;
});

test("同 asset 重复 remove 会结算旧 Promise，且只执行一次删除", async () => {
    const upsert = deferred<WriteResult>();
    const calls: string[] = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => { calls.push(`upsert:${(input as NamedInput).label}`); return upsert.promise; },
        remove: async () => { calls.push("remove"); },
    }));

    const a = coordinator.upsert(asset("a", "A"));
    await tick();
    const firstRemove = coordinator.remove("a");
    const secondRemove = coordinator.remove("a");
    upsert.resolve(asset("a", "A") as CanvasReferenceAsset);
    await a;
    await Promise.all([firstRemove, secondRemove]);
    assert.deepEqual(calls, ["upsert:A", "remove"]);
});

test("remove 覆盖 queued upsert 时旧 Promise 以 typed error 结算", async () => {
    const running = deferred<WriteResult>();
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => {
            if ((input as NamedInput).label === "A") return running.promise;
            return input as CanvasReferenceAsset;
        },
    }));

    const a = coordinator.upsert(asset("a", "A"));
    await tick();
    const b = coordinator.upsert(asset("a", "B"));
    const removal = coordinator.remove("a");
    await assert.rejects(b, ReferenceWriteSupersededError);
    running.resolve(asset("a", "A") as CanvasReferenceAsset);
    await a;
    await removal;
});

test("一次 upsertMany 保持一次 batch、输入顺序、重复 ID 后项覆盖和返回位置", async () => {
    const batches: NamedInput[][] = [];
    const coordinator = createReferenceWriteCoordinator(service({
        upsertMany: async (inputs) => {
            batches.push(inputs as NamedInput[]);
            const final = new Map<string, CanvasReferenceAsset>();
            for (const input of inputs as NamedInput[]) final.set(input.id, input as CanvasReferenceAsset);
            return inputs.map((input) => final.get((input as NamedInput).id)!);
        },
    }));

    const result = await coordinator.upsertMany([asset("a", "first"), asset("b", "B"), asset("a", "last")]);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map((item) => item.id), ["a", "b", "a"]);
    assert.deepEqual(result.map((item) => item.label), ["last", "B", "last"]);
});

test("匿名单项透传，匿名 batch 明确拒绝", async () => {
    let singleCalls = 0;
    let batchCalls = 0;
    const coordinator = createReferenceWriteCoordinator(service({
        upsert: async (input) => { singleCalls++; return input as CanvasReferenceAsset; },
        upsertMany: async () => { batchCalls++; return []; },
    }));

    await coordinator.upsert({ label: "anonymous" });
    assert.equal(singleCalls, 1);
    await assert.rejects(coordinator.upsertMany([{ label: "anonymous" }]), /匿名资产不支持批量写入/);
    assert.equal(batchCalls, 0);
});
