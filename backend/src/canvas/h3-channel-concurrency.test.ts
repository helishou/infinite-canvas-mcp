/**
 * H3 父任务必须和图片/文字/音频一样遵守全局渠道并发上限。
 * 这里用真实 CanvasH3Runner + 临时 SQLite，外部视频调度边界用可控 gate 代替，
 * 不接真实引擎、不产生费用；只观察「什么时候真正开始执行」。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { channelConcurrency } from "./channel-concurrency.js";
import { CanvasH3Runner } from "./h3-runner.js";

type RunInput = Parameters<CanvasH3Runner["start"]>[0];
const localProvider = () => ({ ready: () => false, queue: { select: () => "local", unreserve() {} } });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("等待条件超时");
        await delay(20);
    }
}

function fixture(t: TestContext, limit: number | undefined) {
    const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "h3-channel-concurrency-"));
    const db = new BackendDatabase(join(directory, "tasks.sqlite"));
    const stores = createStores(db);
    stores.settings.set("ai.config", limit === undefined ? {} : { channelConcurrency: limit });
    stores.projects.create({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A bell.", mode: "t2v", duration: 4 },
        { id: "clip-b", prompt: "Another bell.", mode: "t2v", duration: 4 },
    ] } }], connections: [] });
    const submitted: string[] = [];
    const gates: Array<() => void> = [];
    const dispatcher = {
        generationSettings() { return {}; },
        start(request: Record<string, unknown>, bind?: (task: { id: string }) => void) {
            const id = String(request?.clientTaskId || `video-${submitted.length + 1}`);
            const child = stores.tasks.create(id, "canvas-video", { model: request?.model }, {});
            submitted.push(id);
            bind?.(child);
            // 外部任务不真的生成：gate 释放后才写终态，父任务执行循环随之结束并释放渠道槽位。
            void new Promise<void>((resolve) => { gates.push(resolve); }).then(() => {
                stores.tasks.update(child.id, { status: "failed", error: "isolated" });
            });
            return { taskId: child.id };
        },
        resume() {},
        cancel() {},
    };
    const runner = () => new CanvasH3Runner(stores, new BackendEventBus(), dispatcher as never, localProvider() as never);
    channelConcurrency.reset();
    t.after(async () => {
        for (const release of gates.splice(0)) release();
        // 等所有子任务与父任务的异步收口结束再关库，避免测试结束后还有 DB 写入。
        await waitFor(() => stores.tasks.list().every((task) => !["queued", "running"].includes(String(task.status))));
        channelConcurrency.reset();
        db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return { stores, runner, submitted, gates };
}

test("全局渠道并发上限 1：第二个 H3 父任务保持排队，槽位释放后才提交", async (t) => {
    const f = fixture(t, 1);
    const first = f.runner().start({ projectId: "p", nodeId: "n", segmentId: "clip-a" } as RunInput, "task-a");
    const second = f.runner().start({ projectId: "p", nodeId: "n", segmentId: "clip-b" } as RunInput, "task-b");

    await waitFor(() => f.submitted.length === 1);
    await delay(80);
    assert.equal(f.submitted.length, 1, "并发上限 1 时不应同时提交两个 H3 视频任务");
    assert.equal(f.stores.tasks.get(second.id)?.status, "queued", "超限任务保持排队而不是直接失败");
    assert.equal(channelConcurrency.stats("video:default").active, 1);

    f.gates[0]();
    await waitFor(() => f.submitted.length === 2);
    assert.notEqual(f.stores.tasks.get(first.id)?.status, "running", "第一个任务结束后释放槽位，第二个才进入执行");
});

test("未配置上限时行为不变：两个 H3 父任务立即提交", async (t) => {
    const f = fixture(t, undefined);
    f.runner().start({ projectId: "p", nodeId: "n", segmentId: "clip-a" } as RunInput, "task-a");
    f.runner().start({ projectId: "p", nodeId: "n", segmentId: "clip-b" } as RunInput, "task-b");
    await waitFor(() => f.submitted.length === 2);
    assert.equal(channelConcurrency.stats("video:default").active, 0, "未配置上限不占用槽位");
});
