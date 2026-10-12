import assert from "node:assert/strict";
import test from "node:test";
import { groupRecentTasks } from "./task-groups";
test("recent task grouping preserves statuses, order and source objects", () => {
    const tasks = ["failed", "running", "queued", "awaiting_confirmation", "succeeded", "cancelled", "new_status"].map((status, id) => ({ id, status }));
    const groups = groupRecentTasks(tasks);
    assert.deepEqual(groups[0].tasks.map(task => task.id), [1, 2, 3, 6]);
    assert.deepEqual(groups[1].tasks.map(task => task.id), [0, 4, 5]);
    assert.equal(groups.flatMap(group => group.tasks).length, tasks.length);
    assert.equal(groups[0].tasks[0], tasks[1]);
    assert.deepEqual(groupRecentTasks([]), []);
});
