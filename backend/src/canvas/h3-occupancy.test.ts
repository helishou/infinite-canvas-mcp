import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";
const localProvider = () => ({ ready: () => false, queue: { select: () => "local", unreserve() {} } });

type RunInput = Parameters<CanvasH3Runner["start"]>[0];

function fixture(t: TestContext) {
    const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "h3-occupancy-"));
    const file = join(directory, "tasks.sqlite");
    const db = new BackendDatabase(file);
    const stores = createStores(db);
    const events = new BackendEventBus();
    const submitted: string[] = [];
    stores.projects.create({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A bell.", mode: "t2v", duration: 4 },
        { id: "clip-b", prompt: "Another bell.", mode: "t2v", duration: 4 },
        { id: "clip-c", prompt: "Third bell.", mode: "t2v", duration: 4 },
    ] } }], connections: [] });
    // 外部执行边界：不真正生成，挂起等待释放；记录每次提交的子任务。
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string) {
            const child = stores.tasks.create(id!, "comfyui:minimax-h3", input, params);
            submitted.push(child.id);
            await new Promise<void>((resolve) => { (comfy as any)._release = resolve; });
            return stores.tasks.update(child.id, { status: "failed", error: "isolated" });
        },
        resume() {},
        cancel() {},
        settle() { const r = (comfy as any)._release; if (r) { (comfy as any)._release = null; r(); } },
    };
    const runner = () => new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    t.after(() => { comfy.settle(); db.close(); rmSync(directory, { recursive: true, force: true }); });
    return { stores, events, runner, submitted, comfy };
}

/**
 * 方案二：在跑的尾帧链任务 plans 覆盖整条链，但 clip-b 并未真正开始生成（无 parentTaskId、
 * status=error）。此时单独重提 clip-b 不应被判为占用而拒绝——占用只认画布上实际锁定的段。
 */
test("在跑任务 plans 覆盖了失败段但该段未实际锁定时，允许单独重提该段", async (t) => {
    const f = fixture(t);
    // 造一个 running 父任务，plans 覆盖 clip-a 与 clip-b；但只有 clip-a 真正被绑定为 loading。
    const parent = f.stores.tasks.create("running-parent", "canvas-h3-run",
        { projectId: "p", nodeId: "n" } as never, {});
    f.stores.tasks.update(parent.id, { status: "running", result: { plans: [{ nodeId: "n", segmentId: "clip-a" }, { nodeId: "n", segmentId: "clip-b" }] } });
    f.stores.projects.applyOperations("p", undefined, [
        { type: "update_node", id: "n", metadata: { runtimeTaskId: parent.id, status: "loading" } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-a", patch: { runtimeTaskId: "child-a", parentTaskId: parent.id, status: "loading" } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-b", patch: { status: "error", runtimeTaskId: "", parentTaskId: "" } },
    ], { runtimeWrite: true });

    // 单独重提 clip-b（新 key）——应成功新建任务，而不是被 H3_CLIP_OCCUPIED 拒绝。
    const created = f.runner().start({ projectId: "p", nodeId: "n", segmentId: "clip-b" } as RunInput, "retry-clip-b");
    assert.equal(created.kind, "canvas-h3-run");
    assert.notEqual(created.id, parent.id, "应为重试创建新任务，而非返回占用它的父任务");
});

/**
 * 反面保护：真正被锁定的段（parentTaskId 指向在跑任务、status=loading）仍必须拒绝重提，
 * 否则同一段会被两个任务同时生成、重复出片。
 */
test("真正被在跑任务锁定的段仍拒绝重提", (t) => {
    const f = fixture(t);
    const parent = f.stores.tasks.create("running-parent-2", "canvas-h3-run",
        { projectId: "p", nodeId: "n" } as never, {});
    f.stores.tasks.update(parent.id, { status: "running", result: { plans: [{ nodeId: "n", segmentId: "clip-a" }] } });
    f.stores.projects.applyOperations("p", undefined, [
        { type: "update_node", id: "n", metadata: { runtimeTaskId: parent.id, status: "loading" } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-a", patch: { runtimeTaskId: "child-a2", parentTaskId: parent.id, status: "loading" } },
    ], { runtimeWrite: true });

    assert.throws(() => f.runner().start({ projectId: "p", nodeId: "n", segmentId: "clip-a" } as RunInput, "retry-locked-clip-a"),
        (error: unknown) => (error as { code?: string }).code === "H3_CLIP_OCCUPIED",
        "真正锁定的段必须拒绝重提");
});
