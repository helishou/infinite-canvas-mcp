import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadUserInterruptedTurnIds, recordUserInterrupt } from "./codex.js";

test("手动停止标记只保留有 turnId 的条目并可回读", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-user-interrupt-"));
    try {
        recordUserInterrupt(cwd, "thread-a", "turn-1");
        recordUserInterrupt(cwd, "thread-b", "");
        recordUserInterrupt("", "thread-c", "turn-2");
        // 写入是异步落盘，等待一个宏任务。
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual([...await loadUserInterruptedTurnIds(cwd)], ["turn-1"]);
        assert.equal(await loadUserInterruptedTurnIds(undefined).then((ids) => ids.size), 0);
    } finally {
        await fs.rm(cwd, { recursive: true, force: true });
    }
});
