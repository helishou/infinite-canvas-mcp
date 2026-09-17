import assert from "node:assert/strict";
import test from "node:test";
import { CanvasDraftPersistence } from "./canvas-draft-persistence";
import { CanvasCommandQueue, type CanvasCommand } from "./canvas-command-queue";

test("落盘失败持续可见，导出保留原始记录，重试成功才清除", async () => {
    const persistence = new CanvasDraftPersistence();
    let fail = true;
    let notifications = 0;
    const unsubscribe = persistence.subscribe(() => { notifications++; });
    const record = { operationId: "original-id", text: "未保存正文" };
    await assert.rejects(persistence.save({ key: "a", label: "文本", record, write: async () => { if (fail) throw new Error("QuotaExceededError"); } }), /Quota/);
    record.text = "调用方随后修改";
    assert.equal(persistence.getSnapshot().length, 1);
    assert.deepEqual(persistence.exportBackup().records[0].record, { operationId: "original-id", text: "未保存正文" });
    await assert.rejects(persistence.retry(), /仍有本机草稿未保存/);
    assert.equal(persistence.getSnapshot().length, 1);
    fail = false;
    await persistence.retry();
    assert.equal(persistence.getSnapshot().length, 0);
    assert.equal(persistence.exportBackup().records.length, 0);
    assert.equal(notifications, 3);
    unsubscribe();
});

test("旧保存失败不能覆盖新值，单条记录的写入按序执行", async () => {
    const persistence = new CanvasDraftPersistence();
    let rejectFirst!: (error: Error) => void;
    const gate = new Promise<void>((_, reject) => { rejectFirst = reject; });
    const writes: string[] = [];
    const first = persistence.save({ key: "a", label: "文本", record: "旧", write: () => gate });
    const rejected = assert.rejects(first, /旧失败/);
    const latest = persistence.save({ key: "a", label: "文本", record: "新", write: async () => { writes.push("新"); } });
    assert.deepEqual(writes, []);
    assert.equal(persistence.exportBackup().records[0].record, "新");
    rejectFirst(new Error("旧失败"));
    await rejected;
    await latest;
    assert.equal(persistence.getSnapshot().length, 0);
    assert.deepEqual(writes, ["新"]);
});

test("已确认记录的清理取代失败的保存，重试不能复活旧草稿", async () => {
    const persistence = new CanvasDraftPersistence();
    let writes = 0;
    await assert.rejects(persistence.save({ key: "a", label: "文本", record: "旧", write: async () => { writes++; throw new Error("失败"); } }));
    await persistence.save({ key: "a", label: "清理", record: null, write: async () => {} });
    await persistence.retry();
    assert.equal(writes, 1);
    assert.equal(persistence.exportBackup().records.length, 0);
});

test("统一重试修复存储后，命令确认不被旧的 rejected Promise 阻塞", async () => {
    const persistence = new CanvasDraftPersistence();
    let fail = true;
    const disk = new Map<string, unknown>();
    const queue = new CanvasCommandQueue<null>({
        save: (command) => persistence.save({ key: command.operationId, label: "命令", record: command, write: async () => { if (fail) throw new Error("磁盘满"); disk.set(command.operationId, command); } }),
        remove: (id) => persistence.save({ key: id, label: "清理", record: null, write: async () => { disk.delete(id); } }),
    });
    const command: CanvasCommand<null> = { operationId: "a", projectId: "p", ownerId: "o", backend: "b", order: 1, operations: [], base: null };
    queue.enqueue(command);
    await assert.rejects(queue.persisted(), /磁盘满/);
    fail = false;
    await persistence.retry();
    assert.equal(disk.size, 1);
    await queue.acknowledge("a");
    assert.equal(queue.list().length, 0);
    assert.equal(disk.size, 0);
    await persistence.retry();
    assert.equal(disk.size, 0);
});
