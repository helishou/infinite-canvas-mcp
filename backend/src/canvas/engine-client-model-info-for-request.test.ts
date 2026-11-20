import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { CanvasEngineClient } from "./engine-client.js";

test("图片预检按本次参考图数取真实工作流能力，而不是 0 图默认流", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
            calls.push({ path: url.pathname, body });
            const send = (payload: unknown) => {
                const text = JSON.stringify(payload);
                res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
                res.end(text);
            };
            if (url.pathname === "/v1/images/generations" && (body as { dry_run?: boolean } | undefined)?.dry_run) {
                return send({ object: "params_preview", model: "custom/edit.json", values: {} });
            }
            if (url.pathname === "/v1/models/omni") {
                return send({ id: "custom/t2i.json", fields: [], image_input: { counts: [0], field_ids: [] } });
            }
            if (url.pathname === "/v1/models/custom%2Fedit.json") {
                return send({ id: "custom/edit.json", fields: [], image_input: { counts: [1], field_ids: ["image1"] } });
            }
            res.writeHead(404, { "content-type": "application/json" });
            return res.end("{}");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const client = new CanvasEngineClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);

        // 引擎详情接口仍然固定回 0 图默认流（用户的索引设置没被改动）。
        assert.deepEqual((await client.modelInfo("omni")).imageInput.counts, [0]);

        // 带 1 张参考的预检必须先问引擎这次路由到哪条流，再读那条流的槽位。
        const info = await client.modelInfoForRequest("omni", { prompt: "生成资产图", referenceCount: 1 });
        assert.equal(info.id, "custom/edit.json");
        assert.deepEqual(info.imageInput.counts, [1]);

        const dry = calls.find((call) => call.path === "/v1/images/generations")?.body as Record<string, unknown>;
        assert.equal(dry.dry_run, true);
        assert.equal(dry.model, "omni");
        assert.equal((dry.images as string[]).length, 1);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
