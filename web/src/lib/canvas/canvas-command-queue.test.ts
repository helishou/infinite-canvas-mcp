import assert from "node:assert/strict";
import test from "node:test";
import { CanvasCommandQueue, type CanvasCommand } from "./canvas-command-queue";

const command = (id: string, order: number): CanvasCommand<{ title: string }> => ({
    operationId: id, projectId: "p", backend: "backend", ownerId: "tab", order,
    base: { title: "原文" }, operations: [{ type: "update_project", patch: { title: id } }],
});
test("动作入队立即独立保存，调用方后续修改不改变原命令", async () => {
    const saved = new Map<string, unknown>();
    const queue = new CanvasCommandQueue<{ title: string }>({ save: async (item) => { saved.set(item.operationId, structuredClone(item)); }, remove: async (id) => { saved.delete(id); } });
    const first = command("a", 1);
    queue.enqueue(first);
    queue.enqueue(command("b", 2));
    (first.operations[0].patch as { title: string }).title = "不能串改";
    await queue.persisted();
    assert.equal(saved.size, 2);
    assert.equal((queue.list()[0].operations[0].patch as { title: string }).title, "a");
    const original = await queue.prepare("a", 7);
    assert.deepEqual(await queue.prepare("a", 99), original);
    await queue.acknowledge("a");
    assert.deepEqual(queue.list().map((item) => item.operationId), ["b"]);
});

test("落盘失败不能发送；后续动作仍保留；确定拒绝在刷新后继续熔断", async () => {
    let fail = true;
    const saved = new Map<string, CanvasCommand<{ title: string }>>();
    const storage = { save: async (item: CanvasCommand<{ title: string }>) => { if (fail) throw new Error("存储失败"); saved.set(item.operationId, structuredClone(item)); }, remove: async (id: string) => { saved.delete(id); } };
    const queue = new CanvasCommandQueue(storage);
    queue.enqueue(command("a", 1));
    queue.enqueue(command("b", 2));
    await assert.rejects(queue.prepare("a", 3), /存储失败/);
    assert.equal(queue.list().length, 2);
    fail = false;
    await queue.prepare("a", 4);
    assert.equal(queue.list()[0].baseRevision, 3);
    await queue.reject("a", "确定拒绝");
    const restored = new CanvasCommandQueue(storage);
    saved.forEach((item) => restored.restore(item));
    await assert.rejects(restored.prepare("a", 5), /确定拒绝/);
});

test("冲突选择先保存替代记录，清理中断后刷新仍只恢复新意图", async () => {
    const saved = new Map<string, CanvasCommand<{ title: string }>>();
    let failRemoval = true;
    const storage = {
        save: async (item: CanvasCommand<{ title: string }>) => { saved.set(item.operationId, structuredClone(item)); },
        remove: async (id: string) => { if (failRemoval) throw new Error("删除中断"); saved.delete(id); },
    };
    const queue = new CanvasCommandQueue(storage);
    queue.enqueue(command("a", 1));
    queue.enqueue(command("b", 2));
    await queue.persisted();
    await assert.rejects(queue.replace({ ...command("replacement", 3), operations: [] }), /删除中断/);
    const restored = new CanvasCommandQueue(storage);
    // 任意落盘枚举顺序也不能复活已被替代的旧命令。
    [...saved.values()].reverse().forEach((item) => restored.restore(item));
    assert.deepEqual(restored.list().map((item) => item.operationId), ["replacement"]);
    failRemoval = false;
    await restored.acknowledge("replacement");
    assert.equal(saved.size, 0);
});
