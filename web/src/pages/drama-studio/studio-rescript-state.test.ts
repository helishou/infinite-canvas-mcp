import assert from "node:assert/strict";
import test from "node:test";
import { updateRescriptingIds } from "./studio-rescript-state.js";

test("改编按集独立：A 集改编不占用 B 集，两集可同时改编", () => {
    let ids: ReadonlySet<string> = new Set();
    ids = updateRescriptingIds(ids, "ep-A", true);
    assert.deepEqual([...ids], ["ep-A"]);
    assert.equal(ids.has("ep-B"), false, "B 集按钮仍可用");

    ids = updateRescriptingIds(ids, "ep-B", true);
    assert.deepEqual([...ids].sort(), ["ep-A", "ep-B"], "两集可同时改编");

    ids = updateRescriptingIds(ids, "ep-A", false);
    assert.deepEqual([...ids], ["ep-B"], "A 集结束不影响 B 集的改编中状态");
});

test("重复切换幂等，不产生重复 id", () => {
    let ids: ReadonlySet<string> = new Set();
    ids = updateRescriptingIds(ids, "ep-A", true);
    ids = updateRescriptingIds(ids, "ep-A", true);
    assert.equal(ids.size, 1);
    ids = updateRescriptingIds(ids, "ep-A", false);
    ids = updateRescriptingIds(ids, "ep-A", false);
    assert.equal(ids.size, 0);
});
