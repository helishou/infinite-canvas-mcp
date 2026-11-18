import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasVideoDispatcher } from "./video-dispatcher.js";

function fixture() {
    const db = new BackendDatabase(":memory:");
    const stores = createStores(db);
    const dispatcher = new CanvasVideoDispatcher(stores, {} as never, {} as never, {} as never, {} as never);
    return {
        db,
        stores,
        dispatcher,
        makeTask(id: string, status: "failed" | "succeeded" | "cancelled", event?: Record<string, unknown>) {
            stores.tasks.create(id, "canvas-video", { model: "ch1::custom/pipe.json" }, {});
            stores.tasks.update(id, { status });
            if (event) stores.tasks.addEvent(id, "engine_submitted", event);
        },
    };
}

test("回捞拒绝没有引擎任务映射的旧失败任务", async () => {
    const { db, dispatcher, makeTask } = fixture();
    try {
        makeTask("old-failed", "failed");
        await assert.rejects(async () => await dispatcher.reclaim("old-failed"), /没有记录引擎任务 id/);
    } finally { db.close(); }
});

test("回捞拒绝仍在运行或已成功的任务，状态不会被改动", async () => {
    const { db, stores, dispatcher, makeTask } = fixture();
    try {
        makeTask("done", "succeeded", { engineTaskId: "engine-1", baseUrl: "http://127.0.0.1:9999", model: "ch1::custom/pipe.json" });
        await assert.rejects(async () => await dispatcher.reclaim("done"), /不可回捞/);
        assert.equal(stores.tasks.get("done")?.status, "succeeded");
        assert.equal(stores.tasks.events("done").some((event) => event.type === "engine_reclaim"), false);
    } finally { db.close(); }
});

test("原引擎渠道不在设置里时明确拒绝，不猜测目标", async () => {
    const { db, stores, dispatcher, makeTask } = fixture();
    try {
        stores.settings.set("ai.config", { channels: [] });
        makeTask("orphan", "failed", { engineTaskId: "engine-3", baseUrl: "http://127.0.0.1:9999", model: "ch1::custom/pipe.json" });
        await assert.rejects(async () => await dispatcher.reclaim("orphan"), /原引擎渠道已不在设置里/);
        assert.equal(stores.tasks.get("orphan")?.status, "failed", "拒绝时任务状态保持不变");
    } finally { db.close(); }
});
