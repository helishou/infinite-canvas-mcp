import assert from "node:assert/strict";
import test from "node:test";

import {
    ComfyExecutionClock, DEFAULT_COMFY_TIMEOUT_MS, DEFAULT_COMFY_QUEUE_TIMEOUT_MS,
    MAX_COMFY_TIMEOUT_MS, MIN_COMFY_TIMEOUT_MS,
    comfyTimeoutMessage, readComfyQueueState, resolveComfyTimeoutMs,
} from "./execution-clock.js";

const MINUTE = 60_000;

test("resolveComfyTimeoutMs：缺省 120 分钟，自定义值限制在 5–120 分钟", () => {
    assert.equal(resolveComfyTimeoutMs(undefined), DEFAULT_COMFY_TIMEOUT_MS);
    assert.equal(resolveComfyTimeoutMs(""), DEFAULT_COMFY_TIMEOUT_MS);
    assert.equal(resolveComfyTimeoutMs("abc"), DEFAULT_COMFY_TIMEOUT_MS);
    assert.equal(resolveComfyTimeoutMs(1000), MIN_COMFY_TIMEOUT_MS);
    assert.equal(resolveComfyTimeoutMs(10 * 60 * MINUTE), MAX_COMFY_TIMEOUT_MS);
    assert.equal(resolveComfyTimeoutMs(45 * MINUTE), 45 * MINUTE);
});

test("排队等前序任务 3 小时后，本任务自己只跑 1 分钟不算超时", () => {
    // 旧逻辑从 /prompt 提交起算 30 分钟：这里在队列里等 3 小时，本任务刚开跑就会被判失败。
    const submittedAt = 1_000_000;
    const clock = new ComfyExecutionClock(submittedAt, 30 * MINUTE);
    assert.equal(clock.phase, "queued");
    assert.equal(clock.timeout(submittedAt + 3 * 60 * MINUTE), null, "排队时间不能消耗执行预算");
    clock.markRunning(submittedAt + 3 * 60 * MINUTE);
    assert.equal(clock.phase, "running");
    assert.equal(clock.timeout(submittedAt + 3 * 60 * MINUTE + MINUTE), null);
    assert.equal(clock.timeout(submittedAt + 3 * 60 * MINUTE + 31 * MINUTE)?.phase, "running");
});

test("每个任务一份独立时钟，前序任务的耗时不累计到后一个任务", () => {
    const first = new ComfyExecutionClock(0, 30 * MINUTE);
    first.markRunning(0);
    assert.equal(first.timeout(31 * MINUTE)?.phase, "running", "前序任务确实超时");

    const second = new ComfyExecutionClock(31 * MINUTE, 30 * MINUTE);
    second.markRunning(31 * MINUTE);
    assert.equal(second.timeout(32 * MINUTE), null, "后一个任务只按自己的执行时间计");
    assert.equal(second.timeout(62 * MINUTE)?.waitedMs, 31 * MINUTE);
});

test("排队不消耗执行预算，只有队列彻底卡死才按兜底上限报「队列等待超时」", () => {
    const clock = new ComfyExecutionClock(0, 120 * MINUTE);
    assert.equal(clock.timeout(3 * 60 * MINUTE), null, "前序任务耗时 3 小时仍不该杀掉排队中的本任务");
    const timeout = clock.timeout(DEFAULT_COMFY_QUEUE_TIMEOUT_MS + MINUTE);
    assert.deepEqual(timeout, {
        phase: "queued",
        waitedMs: DEFAULT_COMFY_QUEUE_TIMEOUT_MS + MINUTE,
        limitMs: DEFAULT_COMFY_QUEUE_TIMEOUT_MS,
    });
    const message = comfyTimeoutMessage(timeout!, "prompt-queued");
    assert.match(message, /队列等待超时/);
    assert.match(message, /8 小时/);
    assert.match(message, /prompt-queued/);
});

test("执行预算从本任务开始执行起算，报错显示实际时限", () => {
    const clock = new ComfyExecutionClock(0, 120 * MINUTE);
    clock.markRunning(10 * MINUTE);
    assert.equal(clock.timeout(10 * MINUTE + 119 * MINUTE), null);
    const timeout = clock.timeout(10 * MINUTE + 121 * MINUTE);
    assert.deepEqual(timeout, { phase: "running", waitedMs: 121 * MINUTE, limitMs: 120 * MINUTE });
    assert.match(comfyTimeoutMessage(timeout!, "prompt-running"), /任务执行超时/);
    assert.match(comfyTimeoutMessage(timeout!, "prompt-running"), /2 小时/);
    assert.match(comfyTimeoutMessage(timeout!, "prompt-running"), /请检查 ComfyUI/);
});

test("markRunning 只认第一次，后续进度事件不会把起点不断往后推", () => {
    const clock = new ComfyExecutionClock(0, 30 * MINUTE);
    clock.markRunning(10 * MINUTE);
    clock.markRunning(50 * MINUTE);
    assert.equal(clock.timeout(39 * MINUTE), null);
    assert.equal(clock.timeout(41 * MINUTE)?.waitedMs, 31 * MINUTE);
});

test("readComfyQueueState：区分 running / pending / 探测失败", async () => {
    const originalFetch = globalThis.fetch;
    const respond = (body: unknown, ok = true) => async () => new Response(JSON.stringify(body), { status: ok ? 200 : 503 });
    const entry = (id: string) => [1, id, {}, {}, []];
    try {
        globalThis.fetch = respond({ queue_running: [entry("prompt-a")], queue_pending: [] }) as never;
        assert.deepEqual(await readComfyQueueState("http://127.0.0.1:8188", "prompt-a", new AbortController().signal), { running: true, queued: true });

        globalThis.fetch = respond({ queue_running: [entry("other")], queue_pending: [entry("prompt-a")] }) as never;
        assert.deepEqual(await readComfyQueueState("http://127.0.0.1:8188/", "prompt-a", new AbortController().signal), { running: false, queued: true });

        globalThis.fetch = respond({ queue_running: [], queue_pending: [] }) as never;
        assert.deepEqual(await readComfyQueueState("http://127.0.0.1:8188", "prompt-a", new AbortController().signal), { running: false, queued: false });

        globalThis.fetch = (async () => { throw new Error("connection refused"); }) as never;
        assert.equal(await readComfyQueueState("http://127.0.0.1:8188", "prompt-a", new AbortController().signal), null);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
