import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(root, 'web/package.json'));
const { createServer } = await import(pathToFileURL(req.resolve('vite')).href);
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'director-entry-'));
process.env.CANVAS_TEST_VITE_CACHE = cache;
const server = await createServer({ root: path.join(root, 'web'), configFile: path.join(root, 'web/vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, cacheDir: cache });
let browser, page;
const projects = [{ id: 'standalone', title: '独立角色制作', nodes: [], connections: [], updatedAt: '2026-10-01T00:00:00Z' }, { id: 'linked', title: '分集画布', nodes: [], connections: [], updatedAt: '2026-10-02T00:00:00Z' }];
const episode = { id: 'ep', title: '第一集', episodeNumber: 1, canvasId: 'linked' };
projects.push({ id: 'retry', title: '重试画布', nodes: [], connections: [], updatedAt: '2026-10-01T00:00:00Z' });
const records = new Map(); const requests = []; let creationCount = 0; let loseCreationResponse = true; let failRead = true;
const record = id => {
    const owner = id === 'linked' ? 'ep' : id;
    if (!records.has(owner)) records.set(owner, { episodeId: owner, revision: 0, publishedVersion: 0, published: null, draft: { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: 'manual', imageModel: '', h3Model: '', imageModels: {}, h3Models: {} }, legacyImports: [] } });
    return records.get(owner);
};
try {
    await server.listen(); browser = await chromium.launch({ headless: true }); page = await browser.newPage();
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
    await page.addInitScript(() => sessionStorage.setItem('backend-connection', JSON.stringify({ url: 'http://127.0.0.1:17370', token: 'fixture' })));
    await page.route('http://127.0.0.1:17370/**', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        requests.push({ pathname, method }); let data = { ok: true };
        if (pathname === '/canvas/projects/retry/production' && failRead) { failRead = false; return route.fulfill({ status: 503, json: { error: 'temporary fixture failure' }, headers: { 'access-control-allow-origin': '*' } }); }
        if (pathname.endsWith('/text-suggestions')) data.suggestions = [];
        else if (pathname === '/canvas/projects' && method === 'GET') data.projects = projects;
        else if (pathname === '/canvas/projects' && method === 'POST') {
            const input = request.postDataJSON(); let project = projects.find(p => p.id === input.id);
            if (!project) { project = input; projects.push(project); creationCount++; }
            if (loseCreationResponse) { loseCreationResponse = false; return route.abort(); }
            data = { ok: true, project, created: true };
        } else if (/\/production/.test(pathname)) {
            const id = decodeURIComponent(pathname.split('/')[3]); const production = record(id);
            if (pathname.endsWith('/legacy')) data.sources = [];
            else if (pathname.endsWith('/versions')) data.versions = [];
            else if (pathname.endsWith('/ops')) { production.revision++; data.production = production; }
            else data.production = production;
        } else if (pathname === '/drama/episodes/ep') data = { ok: true, episode, canvas: projects[1] };
        else if (/\/canvas\/projects\/[^/]+\/drama$/.test(pathname)) data = { ok: true, episode: pathname.includes('/linked/') ? episode : null };
        else if (/\/canvas\/projects\/[^/]+$/.test(pathname)) data.project = projects.find(p => p.id === decodeURIComponent(pathname.split('/')[3]));
        return route.fulfill({ json: data, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/director-navigation.html`);
    await page.getByRole('heading', { name: '导演工作台', exact: true }).waitFor();
    assert.ok(await page.getByRole('link', { name: '导演工作台', exact: true }).count());
    const artifacts = path.join(root, 'artifacts', 'director-entry'); fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
    await page.getByRole('link').filter({ hasText: '独立角色制作' }).click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    const brief = page.getByRole('textbox', { name: '这次想制作什么？', exact: true });
    await brief.fill('制作一个侦探角色'); await page.getByRole('button', { name: '交给导演', exact: true }).click();
    assert.match(await page.getByLabel('agent draft').textContent(), /canvasProjectId: standalone/);
    await brief.fill('第二段内容不能覆盖已有 Agent 草稿'); await page.getByRole('button', { name: '交给导演', exact: true }).click();
    assert.doesNotMatch(await page.getByLabel('agent draft').textContent(), /第二段内容/);
    await page.getByRole('button', { name: 'test retry', exact: true }).click();
    await page.getByText('暂时无法读取制作数据', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^刷\s*新$/ }).click();
    await page.getByRole('heading', { name: '重试画布', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    await page.getByRole('button', { name: 'test episode', exact: true }).click();
    await page.getByRole('heading', { name: '第一集', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    assert.equal(await page.getByRole('textbox', { name: '这次想制作什么？', exact: true }).inputValue(), '');
    await page.getByRole('textbox', { name: '这次想制作什么？', exact: true }).fill('单集草稿保持一致');
    await page.getByRole('button', { name: 'test linked canvas', exact: true }).click();
    await page.getByRole('heading', { name: '第一集', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '单集草稿保持一致');
    await page.getByRole('button', { name: 'test canvas', exact: true }).click();
    await page.getByRole('link', { name: '导演制作', exact: true }).click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    await page.getByRole('button', { name: '返回导演工作台', exact: true }).click();
    await page.getByRole('button', { name: '新建制作', exact: true }).click();
    await page.getByRole('textbox', { name: '制作名称', exact: true }).fill('新短片');
    await page.getByRole('button', { name: '创建并进入', exact: true }).click();
    await page.getByText(/无法连接 Backend.*POST/).first().waitFor();
    await page.getByRole('button', { name: '创建并进入', exact: true }).click();
    await page.getByRole('heading', { name: '新短片', exact: true }).waitFor(); assert.equal(creationCount, 1);
    assert.equal(requests.some(r => /generate|h3-run|chat\/send/.test(r.pathname)), false);
    assert.equal(requests.some(r => r.pathname === '/drama/episodes/standalone'), false);
    await page.getByRole('button', { name: 'test language', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Director Studio', exact: true }).waitFor();
    await page.mouse.move(900, 650);
    await page.waitForFunction(() => document.querySelectorAll('.ant-message-notice').length === 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Director Studio', exact: true }).click();
    await page.getByRole('heading', { name: 'Director Studio', exact: true }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, creationCount, scope: 'main nav, independent canvas, episode alias, shared draft, canvas shortcut, new production, Agent draft protection, read recovery, creation replay, English UI, mobile navigation, no generation' }));
} catch (error) { console.error("Rendered page:", await page?.locator("body").innerText()); throw error; } finally { await browser?.close(); await server.close(); if (path.dirname(cache) === os.tmpdir() && path.basename(cache).startsWith('director-entry-')) fs.rmSync(cache, { recursive: true, force: true }); }
