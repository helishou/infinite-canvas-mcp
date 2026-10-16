import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import test from 'node:test';
import { createStableBackendProxy } from './dev-backend-proxy.mjs';

const WebSocket = createRequire(import.meta.url)('ws');

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function close(server) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
}

test('holds the public request through reload and forwards it once when the Backend is ready', async t => {
    let requests = 0;
    const backend = http.createServer((req, res) => { requests++; res.end('ok'); });
    const targetPort = await listen(backend);
    const proxy = createStableBackendProxy({ port: 0, targetPort, readyWaitMs: 200 });
    await once(proxy.server, 'listening');
    t.after(async () => { proxy.close(); await close(backend); });
    const port = proxy.server.address().port;
    const pending = fetch(`http://127.0.0.1:${port}/mcp`);
    setTimeout(() => proxy.setBackendReady(true), 25);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(requests, 1);
});

test('returns structured 503 after the readiness wait expires', async t => {
    const backend = http.createServer();
    const targetPort = await listen(backend);
    const proxy = createStableBackendProxy({ port: 0, targetPort, readyWaitMs: 20 });
    await once(proxy.server, 'listening');
    t.after(async () => { proxy.close(); await close(backend); });
    const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/mcp`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal((await response.json()).code, 'BACKEND_RELOADING');
});

test('waits for a competing watcher to release the public port before binding', async t => {
    const occupied = http.createServer();
    const port = await listen(occupied);
    const backend = http.createServer((_req, res) => res.end('ready'));
    const targetPort = await listen(backend);
    const proxy = createStableBackendProxy({ port, targetPort, readyWaitMs: 100 });
    t.after(async () => { proxy.close(); await close(occupied); await close(backend); });
    await new Promise(resolve => setTimeout(resolve, 50));
    await close(occupied);
    const deadline = Date.now() + 1500;
    while (!proxy.server.listening && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(proxy.server.listening, true);
    proxy.setBackendReady(true);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(await response.text(), 'ready');
});

test('marks a forwarded write unknown and never resubmits it after the socket drops', async t => {
    let writes = 0;
    const backend = http.createServer((req, res) => {
        writes++;
        req.resume();
        req.on('end', () => req.socket.destroy());
    });
    const targetPort = await listen(backend);
    const proxy = createStableBackendProxy({ port: 0, targetPort, readyWaitMs: 50 });
    await once(proxy.server, 'listening');
    proxy.setBackendReady(true);
    t.after(async () => { proxy.close(); await close(backend); });
    const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'tools/call', id: 7 }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json().then(({ code, outcomeUnknown }) => ({ code, outcomeUnknown })), { code: 'BACKEND_OUTCOME_UNKNOWN', outcomeUnknown: true });
    assert.equal(writes, 1);
});

/** A dropped upgrade never answers, so bound every wait instead of hanging the runner. */
const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时：升级请求没有得到任何响应`)), 3_000))]);

test('forwards a WebSocket upgrade to the Backend instead of answering it as plain HTTP', async t => {
    const backend = http.createServer();
    const server = new WebSocket.Server({ server: backend });
    let upgradePath = '';
    server.on('connection', (socket, req) => { upgradePath = String(req.url || ''); socket.on('message', data => socket.send(String(data))); });
    const targetPort = await listen(backend);
    const proxy = createStableBackendProxy({ port: 0, targetPort, readyWaitMs: 50 });
    await once(proxy.server, 'listening');
    proxy.setBackendReady(true);
    t.after(async () => { proxy.close(); await close(backend); });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.server.address().port}/canvas/realtime?projectId=P`);
    t.after(() => client.terminate());
    await within(once(client, 'open'), 'open');
    assert.equal(upgradePath, '/canvas/realtime?projectId=P', 'a rejected upgrade means the browser can never open a canvas socket');
    client.send('ping');
    assert.equal(String((await within(once(client, 'message'), 'echo'))[0]), 'ping', 'the tunnel must stay bidirectional');
});

test('rejects an upgrade with 503 while the Backend is reloading', async t => {
    const backend = http.createServer();
    const targetPort = await listen(backend);
    const proxy = createStableBackendProxy({ port: 0, targetPort, readyWaitMs: 20 });
    await once(proxy.server, 'listening');
    t.after(async () => { proxy.close(); await close(backend); });
    const client = new WebSocket(`ws://127.0.0.1:${proxy.server.address().port}/canvas/realtime?projectId=P`);
    t.after(() => client.terminate());
    const [error] = await within(once(client, 'error'), 'error');
    assert.match(String(error.message), /503/);
});
