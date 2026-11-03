import assert from "node:assert/strict";
import test from "node:test";

import { ensureImageSupport, hasImageParts, type VisionProvider } from "./vision-capability.js";

const provider = (patch: Partial<VisionProvider> = {}): VisionProvider => ({
    id: "probe",
    model: "mystery-model",
    name: "Mystery",
    baseUrl: "http://probe.local/v1",
    apiKey: "test-key",
    apiFormat: "openai-chat",
    ...patch,
});

function stubFetch(t: import("node:test").TestContext, respond: (url: string, body: Record<string, any>) => Response | Promise<Response>) {
    const original = globalThis.fetch;
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body || "{}"));
        seen.push({ url, body });
        return respond(url, body);
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = original; });
    return seen;
}

test("显式声明为仅文本时直接报错，不发探针请求", async (t) => {
    const seen = stubFetch(t, () => new Response("{}", { status: 200 }));
    await assert.rejects(ensureImageSupport(provider({ id: "declared-no", supportsImages: false })), /不支持图片输入/);
    assert.equal(seen.length, 0);
});

test("显式声明支持或模型名带视觉能力时跳过探针", async (t) => {
    const seen = stubFetch(t, () => new Response("{}", { status: 200 }));
    await ensureImageSupport(provider({ id: "declared-yes", supportsImages: true }));
    await ensureImageSupport(provider({ id: "named-vision", model: "gpt-4o-mini" }));
    assert.equal(seen.length, 0, "探针是计费请求，能省则省");
});

test("探针明确拒绝图片时给出可操作错误，并按渠道缓存结论", async (t) => {
    const seen = stubFetch(t, () => new Response(JSON.stringify({ error: { message: "This model does not support image input" } }), { status: 400 }));
    const target = provider({ id: "rejects-images" });
    await assert.rejects(ensureImageSupport(target), /请在渠道配置里把该模型标记为支持图片/);
    await assert.rejects(ensureImageSupport(target), /不支持图片输入/);
    assert.equal(seen.length, 1, "确定不支持的结论要缓存，避免每次发图都再探测一次");
});

test("5xx、网络错误与无关 400 都视为未知并放行，且不缓存", async (t) => {
    const seen = stubFetch(t, () => new Response("upstream error", { status: 500 }));
    const flaky = provider({ id: "flaky-500" });
    await ensureImageSupport(flaky);
    await ensureImageSupport(flaky);
    assert.equal(seen.length, 2, "模糊失败不能缓存成“支持”，下次仍可重新判断");

    const offline = provider({ id: "offline" });
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    await ensureImageSupport(offline);
    await ensureImageSupport(offline);
});

test("400 但与图片无关时不判定为不支持", async (t) => {
    const seen = stubFetch(t, () => new Response(JSON.stringify({ error: "invalid api key" }), { status: 400 }));
    await ensureImageSupport(provider({ id: "bad-key" }));
    assert.equal(seen.length, 1);
});

test("用户主动取消照常抛出，不吞掉中断", async (t) => {
    stubFetch(t, () => { throw new Error("unreachable"); });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(ensureImageSupport(provider({ id: "cancelled" }), controller.signal));
});

test("Gemini 渠道使用 generateContent 与 inlineData 探针", async (t) => {
    const seen = stubFetch(t, () => new Response("{}", { status: 200 }));
    await ensureImageSupport(provider({ id: "gemini-probe", apiFormat: "gemini", model: "mystery-model", baseUrl: "https://example.test" }));
    assert.equal(seen[0].url, "https://example.test/v1beta/models/mystery-model:generateContent");
    assert.equal(seen[0].body.generationConfig.maxOutputTokens, 16);
    assert.equal(seen[0].body.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
});

test("hasImageParts 只认已展开的真实图片", () => {
    assert.equal(hasImageParts([{ role: "user", parts: [{ image: "data:image/png;base64,AA==" }] }]), true);
    assert.equal(hasImageParts([{ role: "user", parts: [{ imageRef: "image:1" }] }]), false);
});
