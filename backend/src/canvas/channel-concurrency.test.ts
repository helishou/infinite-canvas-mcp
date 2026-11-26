/** 渠道并发限流器单测：配置解析 + 槽位申请/释放/FIFO 唤醒。 */
import assert from "node:assert/strict";
import test from "node:test";
import { ChannelConcurrencyLimiter, resolveChannelLimit } from "./channel-concurrency.js";

test("resolveChannelLimit: 渠道值优先于全局", () => {
    const cfg = {
        channelConcurrency: 3,
        channels: [
            { id: "text-ch", concurrencyLimit: 5, useGlobalConcurrency: false },
            { id: "image-ch", concurrencyLimit: 2, useGlobalConcurrency: false },
        ],
    };
    assert.equal(resolveChannelLimit(cfg, "text-ch"), 5);
    assert.equal(resolveChannelLimit(cfg, "image-ch"), 2);
});

test("resolveChannelLimit: 渠道没填上限时回退全局值", () => {
    const cfg = {
        channelConcurrency: 4,
        channels: [{ id: "video-ch" }, { id: "audio-ch", concurrencyLimit: 0 }],
    };
    assert.equal(resolveChannelLimit(cfg, "video-ch"), 4);
    assert.equal(resolveChannelLimit(cfg, "audio-ch"), 4);
    // 找不到渠道也用全局值。
    assert.equal(resolveChannelLimit(cfg, "unknown-ch"), 4);
});

test("resolveChannelLimit: 无配置或 0 表示不限", () => {
    assert.equal(resolveChannelLimit(null, "x"), 0);
    assert.equal(resolveChannelLimit({}, "x"), 0);
    assert.equal(resolveChannelLimit({ channelConcurrency: 0, channels: [{ id: "x", concurrencyLimit: -1, useGlobalConcurrency: false }] }, "x"), 0);
    // 上限封顶 999。
    assert.equal(resolveChannelLimit({ channelConcurrency: 5000 }, "x"), 999);
});

test("acquire: limit<=0 时立即返回，不排队", async () => {
    const limiter = new ChannelConcurrencyLimiter();
    const a = await limiter.acquire("ch", 0);
    const b = await limiter.acquire("ch", 0);
    assert.deepEqual(limiter.stats("ch"), { active: 0, waiting: 0 });
    a(); b();
});

test("acquire: limit=1 串行，第二个排队直到第一个 release", async () => {
    const limiter = new ChannelConcurrencyLimiter();
    const order: string[] = [];
    const releaseA = await limiter.acquire("ch", 1);
    order.push("A-acquired");
    let secondAcquired = false;
    const pendingB = limiter.acquire("ch", 1).then((releaseB) => {
        secondAcquired = true;
        order.push("B-acquired");
        return releaseB;
    });
    await Promise.resolve();
    assert.equal(secondAcquired, false, "B 应排队");
    assert.deepEqual(limiter.stats("ch"), { active: 1, waiting: 1 });
    releaseA();
    const releaseB = await pendingB;
    assert.equal(secondAcquired, true);
    assert.deepEqual(order, ["A-acquired", "B-acquired"]);
    assert.deepEqual(limiter.stats("ch"), { active: 1, waiting: 0 });
    releaseB();
    assert.deepEqual(limiter.stats("ch"), { active: 0, waiting: 0 });
});

test("acquire: limit=2 允许两个并行，第三个排队，FIFO 唤醒", async () => {
    const limiter = new ChannelConcurrencyLimiter();
    const r1 = await limiter.acquire("ch", 2);
    const r2 = await limiter.acquire("ch", 2);
    assert.deepEqual(limiter.stats("ch"), { active: 2, waiting: 0 });
    const order: number[] = [];
    const p3 = limiter.acquire("ch", 2).then((r) => { order.push(3); return r; });
    const p4 = limiter.acquire("ch", 2).then((r) => { order.push(4); return r; });
    await Promise.resolve();
    assert.deepEqual(limiter.stats("ch"), { active: 2, waiting: 2 });
    const r3 = await (async () => { r1(); return p3; })();
    assert.deepEqual(order, [3], "先释放应先唤醒 3");
    const r4 = await (async () => { r2(); return p4; })();
    assert.deepEqual(order, [3, 4]);
    r3(); r4();
    assert.deepEqual(limiter.stats("ch"), { active: 0, waiting: 0 });
});

test("acquire: 不同渠道互不干扰，release 幂等", async () => {
    const limiter = new ChannelConcurrencyLimiter();
    const rText = await limiter.acquire("text-ch", 1);
    const rImage = await limiter.acquire("image-ch", 1);
    assert.equal(limiter.stats("text-ch").active, 1);
    assert.equal(limiter.stats("image-ch").active, 1);
    rText(); rText(); // 重复 release 不应把计数减到负数
    rImage();
    assert.deepEqual(limiter.stats("text-ch"), { active: 0, waiting: 0 });
    assert.deepEqual(limiter.stats("image-ch"), { active: 0, waiting: 0 });
});
