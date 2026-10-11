// Use only against an isolated deployment. seed creates a fixture project/media;
// verify checks the same records after a container restart/recreation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [mode, baseArg, fixtureFile] = process.argv.slice(2);
if (!['seed', 'verify'].includes(mode) || !baseArg || !fixtureFile) throw new Error('Use: node scripts/test-deployment.mjs seed|verify <isolated-backend-url> <fixture.json> [--browser]');
const base = baseArg.replace(/\/$/, '');
const token = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
if (!token) throw new Error('Set INFINITE_CANVAS_BACKEND_TOKEN for the isolated test deployment');
const origin = new URL(base).origin;
const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
const call = (route, options = {}) => fetch(`${base}${route}`, { headers, ...options });
const json = async (route, body) => {
    const response = await call(route, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    return response.json();
};
const deadline = Date.now() + 60_000; // Diagnostic readiness wait, not a product timeout.
for (;;) {
    try { if ((await call('/health')).ok) break; } catch {}
    if (Date.now() >= deadline) throw new Error('Isolated deployment did not become ready');
    await new Promise(resolve => setTimeout(resolve, 250));
}
assert.equal((await fetch(`${base}/config`, { headers: { Origin: origin } })).status, 401);
assert.equal((await call('/canvas/projects', { headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403);
assert.equal((await json('/config')).ok, true);

let fixture;
if (mode === 'seed') {
    const id = `deployment-${randomUUID()}`;
    fixture = { id, title: `Deployment smoke ${id}`, operationId: randomUUID() };
    await json('/canvas/projects', { id, title: fixture.title, nodes: [], connections: [], viewport: { x: 0, y: 0, zoom: 1 } });
    fixture.command = { operationId: fixture.operationId, expectedRevision: 0, source: { clientId: 'deployment-smoke', kind: 'browser', label: 'Isolated deployment smoke' }, operations: [{ type: 'add_node', id: 'smoke-text', nodeType: 'text', title: 'Persisted text', position: { x: 0, y: 0 }, metadata: { content: 'Persists across restart' } }] };
    const applied = await json(`/canvas/projects/${id}/ops`, fixture.command);
    assert.equal(applied.revision, 1);
    const archived = await json('/media/upload', { name: 'smoke.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l9sAAAAASUVORK5CYII=' });
    fixture.storageKey = archived.media.storageKey;
    fs.mkdirSync(path.dirname(path.resolve(fixtureFile)), { recursive: true });
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2));
} else fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const loaded = await json(`/canvas/projects/${fixture.id}`);
assert.equal(loaded.project.title, fixture.title);
assert.equal(loaded.project.nodes[0].metadata.content, 'Persists across restart');
const replay = await json(`/canvas/projects/${fixture.id}/ops`, fixture.command);
assert.equal(replay.duplicated, true);
assert.equal(replay.revision, 1);
const media = await call(`/media/${encodeURIComponent(fixture.storageKey)}`);
assert.equal(media.status, 200);
assert.ok((await media.arrayBuffer()).byteLength > 0);
const controller = new AbortController();
try {
    const events = await call('/events', { signal: controller.signal });
    assert.match(events.headers.get('content-type'), /text\/event-stream/);
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event:/);
    await reader.cancel();
} finally { controller.abort(); }

const agentRequire = createRequire(new URL('../canvas-agent/package.json', import.meta.url));
const { Client } = await import(pathToFileURL(agentRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(agentRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
const client = new Client({ name: 'isolated-deployment-smoke', version: '1' });
try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    assert.ok((await client.listTools()).tools.length > 0);
} finally { await client.close(); }

if (process.argv.includes('--browser')) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        await context.addInitScript(value => localStorage.setItem('backend-token', value), token);
        const page = await context.newPage();
        const sync = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Browser did not receive canvas.sync through the proxy prefix')), 30_000);
            page.on('websocket', socket => {
                const url = new URL(socket.url());
                if (url.pathname !== `${new URL(base).pathname}/canvas/realtime`) return;
                socket.on('framereceived', ({ payload }) => {
                    if (String(payload).includes('"canvas.sync"')) { clearTimeout(timer); resolve(); }
                });
            });
        });
        await page.goto(`${origin}/canvas/${fixture.id}`);
        await sync;
        await page.getByText('Persists across restart', { exact: true }).first().waitFor();
        const connection = await page.evaluate(() => JSON.parse(sessionStorage.getItem('backend-connection')));
        assert.equal(connection.url, base);
        await context.close();
    } finally { await browser.close(); }
}
console.log(`Deployment ${mode}: auth, origins, persistence, receipt replay, media, SSE, MCP${process.argv.includes('--browser') ? ', browser WebSocket' : ''} passed`);
