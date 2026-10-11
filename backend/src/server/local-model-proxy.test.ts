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
        assert.deepEqual(await response.json(), { ok: true, models: ["another-model", "qwen-local"] });
        assert.equal(receivedPath, "/v1/models");
        assert.equal(receivedAuthorization, "Bearer local-upstream-key");
    } finally {
        await close(backend);
        await close(upstream);
        db.close();
    }
});
