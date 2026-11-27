import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner, boundH3ParentTaskIds } from "./h3-runner.js";
const localProvider = () => ({ ready: () => false, queue: { select: () => "local", unreserve() {} } });

/**
 * 后端在写回窗口内重启（dev watch 热重载）会杀掉父任务的执行循环，遗留 status=running
 * 的父任务与其 loading 段；此时子任务可能已 failed。启动时必须收敛这类僵尸父任务，
 * 否则画布段永远 loading、界面永远「生成中」，即便引擎侧早已失败。
 */
function fixture(t: TestContext) {
    const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "h3-orphan-"));
    const file = join(directory, "tasks.sqlite");
    const db = new BackendDatabase(file);
    const stores = createStores(db);
    const events = new BackendEventBus();
    stores.projects.create({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A bell.", mode: "t2v", duration: 4 },
        { id: "clip-b", prompt: "Another bell.", mode: "t2v", duration: 4 },
    ] } }], connections: [] });
    const comfy = { async run() { return null as never; }, resume() {}, cancel() {} };
    const runner = () => new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
    return { stores, events, runner };
}

function seedOrphan(stores: ReturnType<typeof createStores>, childStatus: string, childError: string) {
    const parent = stores.tasks.create("orphan-parent", "canvas-h3-run", { projectId: "p", nodeId: "n" } as never, {});
    stores.tasks.update(parent.id, { status: "running", result: { plans: [{ nodeId: "n", segmentId: "clip-a" }], currentChildTaskId: "orphan-child", currentChildKind: "canvas-video" } });
    const child = stores.tasks.create("orphan-child", "canvas-video", { projectId: "p", nodeId: "n", parentTaskId: parent.id } as never, {});
    stores.tasks.update(child.id, { status: childStatus as never, error: childError });
    stores.projects.applyOperations("p", undefined, [
        { type: "update_node", id: "n", metadata: { runtimeTaskId: parent.id, status: "loading" } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-a", patch: { runtimeTaskId: "orphan-child", parentTaskId: parent.id, status: "loading" } },
    ], { runtimeWrite: true });
    return { parent, child };
}

test("启动恢复：running 父任务的子任务已 failed 时收敛父任务并释放段绑定", async (t) => {
    const f = fixture(t);
    const { parent } = seedOrphan(f.stores, "failed", "查询 ComfyUI 任务状态失败");
    // 方法尚不存在，预期红灯；实现后父任务转 failed、段不再 loading。
    await (f.runner() as any).reconcileOrphanedRunning(f.stores.tasks.get(parent.id));
    assert.equal(f.stores.tasks.get(parent.id)!.status, "failed");
    const seg = (f.stores.projects.get("p")!.nodes[0] as any).metadata.segments[0];
    assert.equal(seg.status, "error");
    assert.equal(String(seg.parentTaskId || ""), "");
    assert.equal(String(seg.runtimeTaskId || ""), "");
});

test("终态父任务但段卡 loading 时，reconcileTerminal 收敛段绑定", async (t) => {
    const f = fixture(t);
    const parent = f.stores.tasks.create("terminal-parent", "canvas-h3-run", { projectId: "p", nodeId: "n" } as never, {});
    f.stores.tasks.update(parent.id, { status: "failed", error: "boom", result: { plans: [{ nodeId: "n", segmentId: "clip-a" }] } });
    f.stores.projects.applyOperations("p", undefined, [
        { type: "update_node", id: "n", metadata: { runtimeTaskId: parent.id, status: "loading" } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-a", patch: { runtimeTaskId: "child-x", parentTaskId: parent.id, status: "loading" } },
    ], { runtimeWrite: true });
    // 绑定集合能让启动恢复选中这个终态父任务
    const ids = [...boundH3ParentTaskIds([f.stores.projects.get("p")!])];
    assert.ok(ids.includes(parent.id), "卡住段的父任务 id 应进入绑定集合");
    await f.runner().reconcileTerminal(f.stores.tasks.get(parent.id)!);
    const seg = (f.stores.projects.get("p")!.nodes[0] as any).metadata.segments[0];
    assert.equal(String(seg.parentTaskId || ""), "", "终态收敛后段不应再绑定父任务");
    assert.notEqual(seg.status, "loading");
});

test("启动恢复：真正在跑的子任务（running）不得被误收敛", async (t) => {
    const f = fixture(t);
    const { parent } = seedOrphan(f.stores, "running", "");
    await (f.runner() as any).reconcileOrphanedRunning(f.stores.tasks.get(parent.id));
    assert.equal(f.stores.tasks.get(parent.id)!.status, "running", "活跃子任务不能被收敛");
});
