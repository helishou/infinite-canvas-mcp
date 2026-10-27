import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import type { TestContext } from "node:test";
import { createStandaloneCompatServer } from "./standalone-compat.js";

async function listen(server: Server) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function proxyFor(t: TestContext, upstream: string, readyWaitMs = 100, pollIntervalMs = 5) {
    const proxy = createStandaloneCompatServer({ url: upstream, token: "fixture" }, 0, { readyWaitMs, pollIntervalMs, healthTimeoutMs: 30 });
    t.after(() => close(proxy));
    return new Promise<string>(resolve => proxy.once("listening", () => {
        const address = proxy.address();
        assert.ok(address && typeof address === "object");
        resolve(`http://127.0.0.1:${address.port}`);
    }));
}

test("compatibility proxy waits for Backend health then forwards a write exactly once", async t => {
    let available = false, writes = 0;
    const backend = createServer((req, res) => {
        if (req.url === "/health") {
            res.statusCode = available ? 200 : 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: available }));
            return;
        }
        if (req.url === "/agent/write") {
            writes++;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    const upstream = await listen(backend);
    t.after(() => close(backend));
    const proxy = await proxyFor(t, upstream);
    setTimeout(() => { available = true; }, 35);

    const response = await fetch(`${proxy}/write`, { method: "POST", body: JSON.stringify({ operationId: "original" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(writes, 1);
});

test("compatibility proxy reports a retryable reload timeout without forwarding the write", async t => {
    let writes = 0;
    const backend = createServer((req, res) => {
        if (req.url === "/health") { res.statusCode = 503; res.end(JSON.stringify({ ok: false })); return; }
        writes++;
        res.end();
    });
    const upstream = await listen(backend);
    t.after(() => close(backend));
    const proxy = await proxyFor(t, upstream, 35, 5);

    const response = await fetch(`${proxy}/write`, { method: "POST", body: "{}" });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(body.code, "BACKEND_RELOADING");
    assert.equal(writes, 0);
});

test("compatibility proxy never replays a forwarded write after the upstream drops its response", async t => {
    let writes = 0;
    const backend = createServer((req, res) => {
        if (req.url === "/health") { res.end(JSON.stringify({ ok: true })); return; }
        if (req.url === "/agent/write") { writes++; req.socket.destroy(); return; }
        res.statusCode = 404;
        res.end();
    });
    const upstream = await listen(backend);
    t.after(() => close(backend));
    const proxy = await proxyFor(t, upstream);

    const response = await fetch(`${proxy}/write`, { method: "POST", body: "{}" });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(body.code, "BACKEND_OUTCOME_UNKNOWN");
    assert.equal(body.outcomeUnknown, true);
    assert.equal(writes, 1);
});
