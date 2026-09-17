import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasAudioDispatcher } from "./audio-dispatcher.js";

test("配置节点触发音频会创建结果节点并由任务 ops 回写", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "config", type: "config", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: {} }], connections: [] });
    const stores = createStores(db);
    const directAudio = { run: (input: any, id: string) => { stores.tasks.create(id, "direct-audio", input, {}); stores.tasks.update(id, { status: "succeeded", result: { media: [{ url: "voice.mp3", storageKey: "voice:key", mimeType: "audio/mpeg", bytes: 5 }] } }); return stores.tasks.get(id)!; }, cancel: () => {} };
    const dispatcher = new CanvasAudioDispatcher(stores, directAudio as never);
    dispatcher.start({ projectId: "p", nodeId: "config", model: "cloud::tts", prompt: "你好", clientTaskId: "canvas-audio-1" });
    for (let index = 0; index < 20 && ["queued", "running"].includes(db.getTask("canvas-audio-1")!.status); index++) await new Promise((resolve) => setTimeout(resolve, 5));
    const project = db.getCanvasProject("p")!;
    const output = (project.nodes as Array<Record<string, any>>).find((node) => node.id === "audio-canvas-audio-1");
    assert.equal(output?.type, "audio");
    assert.equal(output?.metadata?.content, "voice.mp3");
    assert.equal(db.getTask("canvas-audio-1")!.status, "succeeded");
});
