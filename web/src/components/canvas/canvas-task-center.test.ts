import assert from "node:assert/strict";
import test from "node:test";

import { groupActiveTasks } from "@/hooks/use-running-task-count";
import { taskProgress } from "@/lib/canvas/task-progress";
import type { BackendRuntimeTask } from "@/services/backend-api";

const task = (progress: number, status: BackendRuntimeTask["status"] = "running") => ({ progress, status } as BackendRuntimeTask);
const activeTask = (id: string, status: "running" | "queued", parentTaskId?: string) => ({ id, status, progress: 0, parentTaskId } as BackendRuntimeTask);

test("任务中心无子任务时使用父任务进度", () => {
    assert.equal(taskProgress(task(0.42), []), 0.42);
});

test("任务中心单个子任务时使用子任务进度", () => {
    assert.equal(taskProgress(task(0), [task(0.86)]), 0.86);
});

test("任务中心多个子任务时使用子任务进度平均值", () => {
    assert.equal(taskProgress(task(0), [task(0.2), task(0.8)]), 0.5);
});

test("任务中心未正式完成时最多显示 99%，即使子任务已完成", () => {
    assert.equal(taskProgress(task(0), [task(1)]), 0.99);
});

test("任务中心总进度不会因最新值回退", () => {
    assert.equal(taskProgress(task(0), [task(0.2)], 0.8), 0.8);
});

test("任务中心父任务正式成功后显示 100%", () => {
    assert.equal(taskProgress(task(0, "succeeded"), [task(1)], 0.99), 1);
});

test("任务中心角标按父任务聚合运行中任务", () => {
    const groups = groupActiveTasks([
        activeTask("parent", "running"),
        activeTask("child", "running", "parent"),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].parent.id, "parent");
    assert.equal(groups[0].children.length, 1);
});
