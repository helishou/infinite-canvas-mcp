import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexEventHistory } from "./codex-event-history.js";

/** 用临时目录构造一个独立存储实例，避免触碰用户真实历史。 */
async function withStore(context: { after: (fn: () => unknown) => void }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-batch-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "codex-event-history.json");
    const flushes: number[] = [];
    const history = new CodexEventHistory(file, { onFlush: () => flushes.push(Date.now()) });
    return { file, history, flushes };
}

const item = (index: number, threadId = "thread-1") => ({
    threadId,
    turnId: `turn-${Math.floor(index / 10)}`,
    itemId: `item-${index}`,
    sequence: index,
    item: { id: `item-${index}`, type: "command_execution", command: `run-${index}`, status: "completed" },
});

test("连续记录被合并成一次落盘，而不是每个事件重写整个文件", async (context) => {
    const { file, history, flushes } = await withStore(context);

    await Promise.all(Array.from({ length: 200 }, (_, index) => history.record(item(index))));

    // 关键断言：落盘次数必须被观测到，且远少于事件数。
    // 若实现忽略 onFlush，flushes 会是空数组，这条会失败——这才是能判别实现的断言。
    assert.ok(flushes.length > 0, "实现必须报告落盘次数，否则无法证明合并生效");
    assert.ok(flushes.length <= 3, `期望合并为极少次落盘，实际 ${flushes.length} 次`);
    const restored = await new CodexEventHistory(file).readThread("thread-1");
    assert.equal(restored.items.length, 200, "合并落盘不能丢事件");
});

test("待写内容在读取前已经落盘，读到的永远是最新的值", async (context) => {
    const { file, history } = await withStore(context);
    await history.record(item(1));

    // record 本身已保证排空；用一个全新实例读，验证磁盘上确实是最新值。
    const snapshot = await new CodexEventHistory(file).readThread("thread-1");

    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].itemId, "item-1");
});

test("同一批并发事件只产生一次落盘", async (context) => {
    const { file, history, flushes } = await withStore(context);

    // 不 await 单条 record，让它们同时在途，才能观察到合批。
    const all = Promise.all(Array.from({ length: 200 }, (_, index) => history.record(item(index))));
    await all;

    assert.ok(flushes.length >= 1, "必须发生落盘");
    assert.ok(flushes.length < 20, `期望显著合批，实际 ${flushes.length} 次落盘`);
    assert.equal((await new CodexEventHistory(file).readThread("thread-1")).items.length, 200);
});

test("记录终态后返回的 Promise 之前，数据必须已经可被新实例读到", async (context) => {
    const { file, history } = await withStore(context);
    await history.record(item(1));

    // recordTurn 是 UI 完成转交的耐久门槛：不 await 它就读，必须能看到终态。
    const pending = history.recordTurn({ threadId: "thread-1", turnId: "turn-0", turn: { id: "turn-0", status: "completed" } });
    const observed = await new CodexEventHistory(file).readThread("thread-1");
    assert.equal(observed.turns.length, 0, "尚未落盘的终态不应凭空出现");

    await pending;
    assert.equal((await new CodexEventHistory(file).readThread("thread-1")).turns.length, 1);
});

test("读取前会先把待写内容刷盘，读到的永远是最新值", async (context) => {
    const { history } = await withStore(context);
    await Promise.all([history.record(item(1)), history.record(item(2)), history.recordTurn({ threadId: "thread-1", turnId: "turn-0", turn: { id: "turn-0" } })]);

    const snapshot = await history.readThread("thread-1");

    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.turns.length, 1);
});

test("同一条目多次更新仍合并字段并保留 sequence", async (context) => {
    const { history } = await withStore(context);
    await history.record({ threadId: "thread-1", turnId: "turn-1", itemId: "item-1", sequence: 1, item: { id: "item-1", type: "command_execution", command: "Get-Location", cwd: "D:\\canvas" } });
    await history.record({ threadId: "thread-1", turnId: "turn-1", itemId: "item-1", item: { id: "item-1", status: "completed", aggregatedOutput: "x".repeat(100_001) } });

    const [entry] = (await history.readThread("thread-1")).items;

    assert.equal(entry.sequence, 1);
    assert.equal(entry.item.command, "Get-Location");
    assert.equal(entry.item.cwd, "D:\\canvas");
    assert.equal(String(entry.item.aggregatedOutput).length, 100_001);
});

test("落盘失败时内存视图不领先于已确认状态", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-batch-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "history-target");
    const history = new CodexEventHistory(file);
    assert.deepEqual(await history.readThread("thread-1"), { items: [], turns: [] });

    await fs.mkdir(file);
    await assert.rejects(() => history.record(item(1)));

    assert.deepEqual(await history.readThread("thread-1"), { items: [], turns: [] });
});

test("移除线程只清空该线程，且不影响其他线程", async (context) => {
    const { history } = await withStore(context);
    await history.record(item(1, "thread-1"));
    await history.record(item(2, "thread-2"));
    await history.recordTurn({ threadId: "thread-1", turnId: "turn-0", turn: { id: "turn-0" } });

    await history.removeThread("thread-1");

    assert.deepEqual(await history.readThread("thread-1"), { items: [], turns: [] });
    assert.equal((await history.readThread("thread-2")).items.length, 1);
});

test("损坏与未知版本仍然拒绝覆盖原文件", async (context) => {
    const { file, history } = await withStore(context);
    const corrupt = '{"version":1,"items":[';
    await fs.writeFile(file, corrupt);
    await assert.rejects(() => history.record(item(1)), /JSON is invalid/);
    assert.equal(await fs.readFile(file, "utf8"), corrupt);

    const future = '{"version":99,"items":[],"turns":[]}';
    await fs.writeFile(file, future);
    await assert.rejects(() => new CodexEventHistory(file).record(item(1)), /Unsupported Codex event history version/);
    assert.equal(await fs.readFile(file, "utf8"), future);
});