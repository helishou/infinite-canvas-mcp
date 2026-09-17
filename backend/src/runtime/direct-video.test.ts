import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { DirectVideoBackend } from "./direct-video.js";

test("直连视频由 Backend 创建并归档，轮询使用持久远端任务 ID", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    stores.settings.set("ai.config", { baseUrl: "http://127.0.0.1:8000", apiKey: "key", apiFormat: "openai", channels: [{ id: "cloud", kind: "api", baseUrl: "http://127.0.0.1:8000", apiKey: "key", apiFormat: "openai", models: [{ name: "grok-imagine-video", capability: "video" }] }] });
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: any, _init: any) => {
        calls.push(String(url));
        if (String(url).endsWith("/videos")) return Response.json({ id: "remote-video-1" });
        if (String(url).endsWith("/content")) return new Response(Buffer.from("video"), { status: 200, headers: { "content-type": "video/mp4" } });
        return Response.json({ id: "remote-video-1", status: "completed" });
    });
    const backend = new DirectVideoBackend({ url: "http://127.0.0.1:17370" } as never, stores.settings, stores.tasks, stores.media);
    backend.run({ model: "cloud::grok-imagine-video", prompt: "测试视频" }, "direct-parent", { seconds: "4", size: "1280x720", resolution: "720p" });
    for (let index = 0; index < 20 && ["queued", "running"].includes(db.getTask("direct-parent")!.status); index++) await new Promise((resolve) => setTimeout(resolve, 200));
    const task = db.getTask("direct-parent")!;
    assert.equal(task.status, "succeeded");
    assert.deepEqual(calls, ["http://127.0.0.1:8000/v1/videos", "http://127.0.0.1:8000/v1/videos/remote-video-1", "http://127.0.0.1:8000/v1/videos/remote-video-1/content"]);
    assert.equal((task.result?.media as Array<Record<string, unknown>>)[0].mimeType, "video/mp4");
    assert.ok(stores.media.meta(String((task.result?.media as Array<Record<string, unknown>>)[0].storageKey || "")));
    backend.run({ model: "cloud::grok-imagine-video", prompt: "测试视频" }, "direct-parent");
    assert.equal(calls.length, 3, "重试同一幂等键不能再次创建远端视频");
});
