import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasVideoDispatcher } from "./video-dispatcher.js";

/**
 * 重启恢复：已有 engine_submitted 回执的 running 视频任务，resume 必须按原 engineTaskId
 * 接回观察，不能重新 createVideo（否则同一段被提交两次、引擎里出现两个 prompt、重复出片）。
 * 本测试用替换 execute/waitReclaimed 的方式断言走了回捞路径而非重提路径。
 */
test("有引擎回执的 running 任务 resume 走回捞观察，不重新提交", () => {
    const db = new BackendDatabase(":memory:");
    const stores = createStores(db);
    try {
        const id = "video-with-engine-receipt";
        stores.tasks.create(id, "canvas-video", { model: "ch1::custom/pipe.json" }, {});
        stores.tasks.update(id, { status: "running" });
        stores.tasks.addEvent(id, "engine_submitted", { engineTaskId: "engine-existing", baseUrl: "http://127.0.0.1:8300", model: "ch1::custom/pipe.json" });
        stores.settings.set("ai.config", { channels: [{ id: "ch1", kind: "comfyui", name: "引擎", baseUrl: "http://127.0.0.1:8300", apiKey: "t0ken", apiFormat: "openai" }] });
        let executed = false, reclaimed = false;
        const dispatcher = new CanvasVideoDispatcher(stores, {} as never, {} as never, {} as never, {} as never);
        (dispatcher as any).execute = () => { executed = true; };
        (dispatcher as any).waitReclaimed = async () => { reclaimed = true; };
        dispatcher.resume(stores.tasks.get(id)!);
        assert.equal(executed, false, "已有引擎回执的任务不得重新 execute/createVideo");
        assert.equal(reclaimed, true, "应按原 engineTaskId 接回观察");
    } finally { db.close(); }
});
