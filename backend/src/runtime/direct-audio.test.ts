import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { DirectAudioBackend } from "./direct-audio.js";

test("直连音频由 Backend 归档，重复幂等键不会再次请求 provider", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    stores.settings.set("ai.config", { channels: [{ id: "cloud", kind: "api", baseUrl: "http://127.0.0.1:8000", apiKey: "key", apiFormat: "openai", models: [{ name: "gpt-4o-mini-tts", capability: "audio" }] }] });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: any) => { calls++; return new Response(Buffer.from("audio"), { status: 200, headers: { "content-type": "audio/mpeg" } }); });
    const backend = new DirectAudioBackend({ url: "http://127.0.0.1:17370" } as never, stores.settings, stores.tasks, stores.media);
    backend.run({ model: "cloud::gpt-4o-mini-tts", prompt: "测试语音", voice: "alloy", format: "mp3", speed: "1" }, "audio-1");
    for (let index = 0; index < 20 && ["queued", "running"].includes(db.getTask("audio-1")!.status); index++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(db.getTask("audio-1")!.status, "succeeded");
    assert.equal(calls, 1);
    const media = (db.getTask("audio-1")!.result?.media as Array<Record<string, unknown>>)[0];
    assert.equal(media.mimeType, "audio/mpeg");
    assert.ok(stores.media.meta(String(media.storageKey)));
    backend.run({ model: "cloud::gpt-4o-mini-tts", prompt: "测试语音" }, "audio-1");
    assert.equal(calls, 1);
});
