import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";
import { buildLocalModelsUrl } from "./local-model-proxy.js";

function listen(server: Server) {
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server: Server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("local model proxy targets only loopback OpenAI model-list endpoints", () => {
    assert.equal(buildLocalModelsUrl("http://127.0.0.1:8080/v1").href, "http://127.0.0.1:8080/v1/models");
    assert.equal(buildLocalModelsUrl("http://localhost:11434").href, "http://localhost:11434/v1/models");
    for (const baseUrl of [
        "https://api.example.com/v1",
        "http://192.168.1.20:8080/v1",
        "http://user:secret@127.0.0.1:8080/v1",
        "http://127.0.0.1:8080/v1?token=secret",
        "file:///etc/passwd",
    ]) {
        assert.throws(() => buildLocalModelsUrl(baseUrl));
    }
});

test("loopback model-list proxy avoids browser CORS and keeps the API key server-side", async () => {
    let receivedAuthorization = "";
    let receivedPath = "";
    const upstream = createHttpServer((req, res) => {
        receivedAuthorization = String(req.headers.authorization || "");
        receivedPath = req.url || "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "qwen-local" }, { id: "another-model" }] }));
    });
    await listen(upstream);

    const db = new BackendDatabase(":memory:");
    const origin = "http://127.0.0.1:3001";
    const { app } = startServer(db, {
        url: "http://127.0.0.1",
        token: "test-backend-token",
        port: 0,
        listenHost: "127.0.0.1",
        origins: [origin],
    });
    const backend = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => backend.once("listening", resolve));
    const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    const headers = {
        Origin: origin,
        Authorization: "Bearer test-backend-token",
        "Content-Type": "application/json",
    };

    try {
        const preflight = await fetch(`${backendUrl}/api/local-models`, {
            method: "OPTIONS",
            headers: {
                Origin: origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

        const response = await fetch(`${backendUrl}/api/local-models`, {
            method: "POST",
            headers,
            body: JSON.stringify({ baseUrl: upstreamUrl, apiKey: "local-upstream-key" }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        assert.deepEqual(await response.json(), {
            ok: true,
            models: ["another-model", "qwen-local"],
            // items 是 capability 透传通道：没有能力上报时只有 name（原用例写于 items 加入前，此处同步到现行契约）。
            items: [{ name: "qwen-local" }, { name: "another-model" }],
        });
        assert.equal(receivedPath, "/v1/models");
        assert.equal(receivedAuthorization, "Bearer local-upstream-key");
    } finally {
        await close(backend);
        await close(upstream);
        db.close();
    }
});

test("引擎真上报的视频能力字段经代理原样透传，未上报的字段不出现", async () => {
    const upstream = createHttpServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/v1/models") {
            return res.end(JSON.stringify({
                data: [{
                    id: "h3-video",
                    capability: "video",
                    media_inputs: { audios: ["音频1", "音频2"] },
                    video_ratios: ["16:9", "9:16"],
                    generate_audio: true,
                    tail_frame_chain: false,
                    max_video_seconds: 15,
                    prompt_max_chars: 8000,
                }],
            }));
        }
        return res.end(JSON.stringify({ id: "h3-video", videoResolutions: ["720p"], generateAudio: false, promptMaxChars: 32000 }));
    });
    await listen(upstream);

    const db = new BackendDatabase(":memory:");
    const origin = "http://127.0.0.1:3001";
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "test-backend-token", port: 0, listenHost: "127.0.0.1", origins: [origin] });
    const backend = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => backend.once("listening", resolve));
    const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    const headers = { Origin: origin, Authorization: "Bearer test-backend-token", "Content-Type": "application/json" };

    try {
        const list = await fetch(`${backendUrl}/api/local-models`, {
            method: "POST", headers,
            body: JSON.stringify({ baseUrl: upstreamUrl, apiKey: "local-key" }),
        });
        const listBody = await list.json() as { items: Array<Record<string, unknown>> };
        assert.deepEqual(listBody.items[0], {
            name: "h3-video", capability: "video", maxAudios: 2,
            videoRatios: ["16:9", "9:16"], generateAudio: true, tailFrameChain: false, maxVideoSeconds: 15, promptMaxChars: 8000,
        });

        const detail = await fetch(`${backendUrl}/api/local-model-detail`, {
            method: "POST", headers,
            body: JSON.stringify({ baseUrl: upstreamUrl, model: "h3-video", apiKey: "local-key" }),
        });
        const detailBody = await detail.json() as Record<string, unknown>;
        assert.equal(detailBody.videoResolutions?.[0], "720p");
        assert.equal(detailBody.generateAudio, false);
        assert.equal(detailBody.promptMaxChars, 32000, "详情上报的字数上限原样透传");
        assert.equal(detailBody.videoRatios, undefined, "详情没上报的字段不得出现，前端按未知处理");
    } finally {
        await close(backend);
        await close(upstream);
        db.close();
    }
});
