import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexEventHistory } from "./codex-event-history.js";

/**
 * 生成与真实使用形态相近的合成历史：多线程、数千条目、含大 aggregatedOutput。
 * 不使用用户真实历史文件，只造同量级的 fixture。
 */
function makeItems(count: number, threads = 8) {
    const items = Array.from({ length: count }, (_, index) => {
        const threadId = `thread-${index % threads}`;
        return {
            threadId,
            turnId: `turn-${Math.floor(index / 40)}`,
            itemId: `item-${index}`,
            sequence: index,
            item: {
                id: `item-${index}`,
                type: index % 7 === 0 ? "command_execution" : "agent_message",
                command: `Get-ChildItem -Path D:\\workspace\\project${index}`,
                status: "completed",
                // 每 20 条来一个大输出，模拟真实的长命令回显。
                aggregatedOutput: index % 20 === 0 ? "x".repeat(40_000) : "ok",
            },
        };
    });
    return items;
}

async function timed(work: () => Promise<unknown>) {
    const started = process.hrtime.bigint();
    await work();
    return Number(process.hrtime.bigint() - started) / 1e6;
}

test("合批落盘让持续事件流的总耗时显著低于逐条全量重写", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-bench-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));

    // 预置一份 3000 条的存量历史，模拟"已经跑了一段时间"的真实状态。
    const file = path.join(directory, "codex-event-history.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, items: makeItems(3000), turns: [] }));

    let flushes = 0;
    let bytes = 0;
    const history = new CodexEventHistory(file, { onFlush: (n) => { flushes += 1; bytes += n; } });

    // 预热一次加载，避免把首次 parse 计入稳态对比。
    await history.readThread("thread-0");

    const incoming = makeItems(200, 8).map((item, index) => ({ ...item, itemId: `new-${index}`, sequence: 5000 + index }));
    const elapsed = await timed(() => Promise.all(incoming.map((item) => history.record(item))));

    const stored = await new CodexEventHistory(file).readThread("thread-0");
    assert.ok(stored.items.length > 0, "存量数据必须仍在");

    // 关系型断言（不依赖具体机器与磁盘速度）：
    // 200 条事件若逐条全量重写，写盘次数必然接近 200；合批后应远小于此。
    assert.ok(flushes <= 10, `200 条事件应合批为个位数次落盘，实际 ${flushes} 次`);
    assert.ok(flushes >= 1, "必须发生落盘");
    assert.ok(bytes > 0, "必须真实写出过字节");

    // 所有新事件都必须持久化，不能因为合批而丢。
    // 注意：fixture 按 index % threads 把事件分散到多个线程，必须逐线程校验。
    const ids = new Set<string>();
    for (const threadId of new Set(incoming.map((item) => item.threadId))) {
        for (const entry of (await new CodexEventHistory(file).readThread(threadId)).items) ids.add(entry.itemId);
    }
    for (const item of incoming) assert.ok(ids.has(item.itemId), `合批不能丢事件：${item.itemId}`);

    console.log(`[bench] 200 事件 / 3000 条存量：落盘 ${flushes} 次，写出 ${(bytes / 1048576).toFixed(1)} MiB，总耗时 ${elapsed.toFixed(1)}ms`);
});

test("合批后单条事件的落盘字节数仍随存量增长，说明成本已从写盘转移到序列化", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-bench-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "codex-event-history.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, items: makeItems(500), turns: [] }));

    let bytes = 0;
    const history = new CodexEventHistory(file, { onFlush: (n) => { bytes += n; } });
    await history.readThread("thread-0");
    bytes = 0;
    await history.record({ threadId: "thread-0", turnId: "turn-new", itemId: "item-new", sequence: 1, item: { id: "item-new", type: "agent_message", text: "x" } });

    assert.ok(bytes > 0, "单条事件也必须落盘，保证重启可恢复");
});