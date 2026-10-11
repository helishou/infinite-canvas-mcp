import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { requestCodexText } from "./codex-text.js";

test("CLI channel text uses a raw model, real temporary images and an isolated structured thread", async () => {
    let cwd = "", stopped = 0;
    const result = await requestCodexText({ model: "native-model", prompt: "查看图片", images: ["data:image/png;base64,AQID"], systemPrompt: "fixture", effort: "high" }, async () => ({
        startTextThread: async directory => { cwd = directory; return { id: "text-thread" } as any; },
        generateSkillDraft: async (id, prompt, schema, model, effort, images) => {
            assert.equal(id, "text-thread"); assert.equal(model, "native-model"); assert.equal(effort, "high");
            assert.match(prompt, /fixture/); assert.equal((schema.properties as any).text.type, "string");
            assert.equal(images?.length, 1); assert.deepEqual(await fs.readFile(images![0]), Buffer.from([1, 2, 3]));
            return '{"text":"可见结果"}';
        },
        interruptCurrentTurn: async () => true,
        stopProductionClient: () => { stopped++; },
    }));
    assert.equal(result, "可见结果"); assert.equal(stopped, 1);
    await assert.rejects(fs.stat(cwd), { code: "ENOENT" });
});

test("cancelling CLI inference cannot publish a late result and releases only its client", async () => {
    const controller = new AbortController();
    let interrupted = 0, stopped = 0;
    await assert.rejects(requestCodexText({ model: "native", prompt: "fixture", signal: controller.signal }, async () => ({
        startTextThread: async () => ({ id: "cancelled-thread" } as any),
        generateSkillDraft: async () => { controller.abort(); return '{"text":"late"}'; },
        interruptCurrentTurn: async id => { assert.equal(id, "cancelled-thread"); interrupted++; return true; },
        stopProductionClient: () => { stopped++; },
    })), error => error instanceof Error && error.name === "AbortError");
    assert.equal(interrupted, 1); assert.ok(stopped > 0);
});
