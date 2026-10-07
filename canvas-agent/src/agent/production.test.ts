import assert from "node:assert/strict";
import test from "node:test";
import { ProductionAgentPool, WorkPool, type ProductionAgentRequest } from "./production.js";

test("three independent worker slots overlap, preserve thread/events and deduplicate an active work", async () => {
    const releases: Array<() => void> = [], events: string[] = [], threads: string[] = [];
    let clients = 0, active = 0, peak = 0;
    const pool = new ProductionAgentPool(async emit => {
        const index = ++clients;
        return {
            startProductionThread: async () => ({ id: `thread-${index}` }) as any,
            resumeProductionThread: async () => ({}) as any,
            generateProductionOutput: async threadId => {
                active++; peak = Math.max(peak, active); emit("agent_log", { threadId });
                await new Promise<void>(resolve => releases.push(resolve)); active--;
                return JSON.stringify({ threadId });
            }, stopProductionClient: () => undefined,
        };
    });
    const request = (workId: string): ProductionAgentRequest => ({ workId, cwd: ".", prompt: "return data", schema: {}, onThread: threadId => threads.push(threadId), emit: (_type, data: any) => events.push(`${workId}:${data.threadId}`) });
    const first = pool.run(request("A"));
    assert.equal(pool.run(request("A")), first);
    const jobs = [first, pool.run(request("B")), pool.run(request("C")), pool.run(request("D"))];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 3); assert.equal(pool.busy, true); assert.equal(peak, 3); assert.equal(clients, 3);
    releases.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve)); releases.splice(0).forEach(resolve => resolve());
    const results = await Promise.all(jobs);
    assert.deepEqual(results.slice(0, 3).map(result => result.threadId), ["thread-1", "thread-2", "thread-3"]);
    assert.deepEqual(events.slice(0, 3), ["A:thread-1", "B:thread-2", "C:thread-3"]);
    assert.equal(threads.length, 4); assert.equal(pool.busy, false); pool.stop();
});

test("pool gives queued director reviews priority and releases a failed slot without retry", async () => {
    const pool = new WorkPool(1), order: string[] = [];
    let release!: () => void;
    const first = pool.submit(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error("failed once"); });
    const handled = assert.rejects(first, /failed once/);
    const author = pool.submit(async () => { order.push("author"); });
    const review = pool.submit(async () => { order.push("review"); }, 1);
    release(); await Promise.all([handled, author, review]); assert.deepEqual(order, ["review", "author"]);
});

test("restart recovery reads completed output from the original thread without a new model turn", async () => {
    let generated = 0, recovered = 0;
    const pool = new ProductionAgentPool(async () => ({
        startProductionThread: async () => { throw new Error("must retain thread"); },
        resumeProductionThread: async () => ({}) as any,
        generateProductionOutput: async () => { generated++; return "{}"; },
        recoverProductionOutput: async threadId => { assert.equal(threadId, "original"); recovered++; return '{"status":"complete"}'; },
        stopProductionClient: () => undefined,
    }));
    const result = await pool.run({ workId: "restored", threadId: "original", recoverOutput: true, cwd: ".", prompt: "", schema: {}, onThread: () => assert.fail("must retain thread") });
    assert.equal(generated, 0); assert.equal(recovered, 1); assert.deepEqual(result.output, { status: "complete" }); pool.stop();
});

test("configured Codex channel resolves its native model before entering the existing worker pool", async () => {
    let model = "", apiCalls = 0;
    const pool = new ProductionAgentPool(async () => ({
        startProductionThread: async () => ({ id: "native-thread" }) as any,
        resumeProductionThread: async () => ({}) as any,
        generateProductionOutput: async (_thread, _prompt, _schema, _images, nativeModel) => { model = nativeModel || ""; return '{"status":"complete"}'; },
        stopProductionClient: () => {},
    }), { canRun: request => Boolean(request.model?.includes("::")), run: async () => { apiCalls++; return { threadId: "wrong", output: {} }; } }, name => name === "cli::native" ? "native" : name);
    const result = await pool.run({ workId: "native-channel", model: "cli::native", cwd: ".", prompt: "return data", schema: {}, onThread: () => {} });
    assert.equal(model, "native"); assert.equal(apiCalls, 0); assert.equal(result.threadId, "native-thread"); pool.stop();
});
