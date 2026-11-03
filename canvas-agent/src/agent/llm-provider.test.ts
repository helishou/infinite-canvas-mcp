import assert from "node:assert/strict";
import test from "node:test";

import { expandImageRefs, type LlmMessage } from "./llm-provider.js";

const imageMessage = (storageKey: string): LlmMessage => ({ role: "user", parts: [{ imageRef: storageKey }] });
const imageBytes = (bytes: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes).toString("base64")}`;

test("历史图片按张数保留最近若干张，更早的替换成可回看的占位文本", async () => {
    const resolved: string[] = [];
    const messages = [imageMessage("image:1"), imageMessage("image:2"), imageMessage("image:3")];
    const output = await expandImageRefs(messages, async (key) => { resolved.push(key); return imageBytes(10); }, { maxCount: 2, maxBytes: 1024 * 1024 });
    assert.deepEqual(resolved, ["image:3", "image:2"], "只解析要保留的图片，且从最新往前");
    assert.ok("image" in output[2].parts[0]);
    assert.ok("image" in output[1].parts[0]);
    const placeholder = output[0].parts[0];
    assert.ok("text" in placeholder);
    assert.match(placeholder.text, /image:1/);
    assert.match(placeholder.text, /agent_view_image/, "占位文本要告诉模型如何回看");
    assert.ok("imageRef" in messages[0].parts[0], "不得修改传入的历史");
});

test("历史图片总量受字节预算限制，最新一张即使超预算也保留", async () => {
    const resolved: string[] = [];
    const messages = [imageMessage("image:1"), imageMessage("image:2"), imageMessage("image:3")];
    const output = await expandImageRefs(messages, async (key) => { resolved.push(key); return imageBytes(100); }, { maxCount: 10, maxBytes: 150 });
    assert.deepEqual(resolved, ["image:3", "image:2"], "预算关闭窗口后不再回源读取更早的图片");
    assert.ok("image" in output[2].parts[0]);
    assert.ok("text" in output[1].parts[0] && "text" in output[0].parts[0]);

    const only = await expandImageRefs([imageMessage("image:huge")], async () => imageBytes(1000), { maxCount: 1, maxBytes: 10 });
    assert.ok("image" in only[0].parts[0], "单张超预算时仍保留，避免本轮完全看不到图");
});

test("没有图片引用时原样返回，不做拷贝", async () => {
    const messages: LlmMessage[] = [{ role: "user", parts: [{ text: "hi" }] }];
    assert.equal(await expandImageRefs(messages, async () => imageBytes(1)), messages);
});
