import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { generateImagesOpenAI } from "./engine-client.js";

/**
 * 画布自己的 OpenAI 图片调用（不再依赖引擎包的 chatgpt-image）：
 * 无参考图打 /v1/images/generations，有参考图打 /v1/images/edits（multipart），
 * url 与 b64_json 两种回包都要能落成产物。
 */

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

async function startFakeOpenAI() {
    const seen: Array<{ path: string; contentType: string; body: string }> = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            seen.push({ path: req.url ?? "", contentType: String(req.headers["content-type"] ?? ""), body: body.toString("latin1") });
            const json = (payload: unknown) => {
                const text = JSON.stringify(payload);
                res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
                res.end(text);
            };
            if ((req.url ?? "").startsWith("/v1/images/generations")) return json({ created: 1, data: [{ url: "http://cdn/a.png" }] });
            if ((req.url ?? "").startsWith("/v1/images/edits")) return json({ created: 1, data: [{ b64_json: PNG.toString("base64") }] });
            return json({});
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { baseUrl: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("无参考图 → /v1/images/generations，回 url", async () => {
    const fake = await startFakeOpenAI();
    try {
        const result = await generateImagesOpenAI({ baseUrl: fake.baseUrl, model: "2.1", prompt: "一只猫", size: "1024x768", count: 2 });
        assert.deepEqual(result.urls, ["http://cdn/a.png"]);
        assert.equal(fake.seen[0].path, "/v1/images/generations");
        const body = JSON.parse(fake.seen[0].body) as { model: string; n: number; size: string };
        assert.equal(body.model, "2.1");
        assert.equal(body.n, 2);
        assert.equal(body.size, "1024x768");
    } finally {
        await fake.close();
    }
});

test("有参考图 → /v1/images/edits（multipart），回 b64 落成字节", async () => {
    const fake = await startFakeOpenAI();
    try {
        const result = await generateImagesOpenAI({
            baseUrl: `${fake.baseUrl}/v1`,
            token: "t",
            model: "2.1",
            prompt: "改成赛博朋克",
            references: [{ mimeType: "image/png", data: PNG }],
        });
        assert.equal(fake.seen[0].path, "/v1/images/edits", "带参考图必须打 edits");
        assert.match(fake.seen[0].contentType, /multipart\/form-data/);
        assert.ok(fake.seen[0].body.includes('name="image"'), "参考图要作为 image 文件上传");
        assert.equal(result.blobs.length, 1);
        assert.equal(result.blobs[0].data.subarray(0, 4).toString("hex"), "89504e47", "b64 要解回 PNG");
    } finally {
        await fake.close();
    }
});

test("baseUrl 结尾带 /v1 不会拼成 /v1/v1；错误响应要抛出可读信息", async () => {
    const fake = await startFakeOpenAI();
    try {
        await generateImagesOpenAI({ baseUrl: `${fake.baseUrl}/`, model: "m", prompt: "x" });
        assert.equal(fake.seen[0].path, "/v1/images/generations");
    } finally {
        await fake.close();
    }
    await assert.rejects(
        () => generateImagesOpenAI({ baseUrl: "http://127.0.0.1:1", model: "m", prompt: "x" }),
        /图片接口|fetch failed|ECONNREFUSED/i,
    );
});
