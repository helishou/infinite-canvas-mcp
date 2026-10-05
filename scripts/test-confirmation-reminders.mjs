import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'web/package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'confirmation-browser-'));
process.env.CANVAS_TEST_VITE_CACHE = cache;
const server = await createServer({ root: path.join(root, 'web'), configFile: path.join(root, 'web/vite.config.ts'), cacheDir: cache, server: { port: 0, host: '127.0.0.1' } });
let browser;
try {
    await server.listen();
    const address = server.httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const writes = [], errors = [];
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base || /^\/(api|agent|events|tasks|media)(\/|$)/.test(url.pathname)) {
            if (request.method() !== 'GET') writes.push({ method: request.method(), path: url.pathname });
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"Isolated notification test: Backend access disabled"}' });
        }
        return route.continue();
    });
    await context.addInitScript(() => {
        const records = [], requests = [];
        class NotificationMock {
            static permission = sessionStorage.getItem('test-notification-permission') || 'default';
            static async requestPermission() {
                requests.push({ userGesture: navigator.userActivation.isActive });
                NotificationMock.permission = 'granted'; sessionStorage.setItem('test-notification-permission', 'granted'); return 'granted';
            }
            constructor(title, options) { this.title = title; this.options = options; this.closed = false; records.push(this); }
            close() { this.closed = true; }
        }
        Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationMock });
        window.__reminders = { records, requests, setPermission(value) { NotificationMock.permission = value; sessionStorage.setItem('test-notification-permission', value); } };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/tests/confirmation-reminders.html');
    await page.getByRole('button', { name: 'pending first', exact: true }).click();
    assert.match(await page.title(), /待确认 1/);
    assert.equal(await page.evaluate(() => __reminders.requests.length), 0, 'mounting must never request permission');
    const director = page.locator('#canvas-director-dialog');
    assert.equal(await page.getByRole('button', { name: '确认提醒', exact: true }).count(), 0, 'the reminder switch is hidden with the director');
    await page.getByRole('button', { name: '与导演对话', exact: true }).click();
    await director.getByRole('button', { name: '确认提醒', exact: true }).click();
    assert.equal(await page.evaluate(() => __reminders.requests.length), 1);
    assert.equal(await page.evaluate(() => __reminders.requests[0].userGesture), true);
    assert.equal(await page.evaluate(() => __reminders.records.length), 0, 'foreground confirmations do not show system notifications');
    await director.getByRole('button', { name: '收起 Agent 面板', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '确认提醒', exact: true }).count(), 0);
    // Headless Chromium does not model an OS window switch consistently. Deliver the
    // same focus events to the real UI hook while using a separate page as the destination.
    const background = async () => { await away.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); };
    const foreground = async () => { await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
    const away = await context.newPage(); await away.goto('about:blank'); await background();
    await page.waitForFunction(() => __reminders.records.length === 1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.evaluate(() => __reminders.records.length), 1, 'focus and repeated state updates are deduplicated');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'another canvas').click());
    await page.waitForFunction(() => document.querySelector('[aria-label="test location"]').textContent === '/canvas/another');
    assert.equal(await page.evaluate(() => __reminders.records.length), 1);
    await page.evaluate(() => __reminders.records[0].onclick({ preventDefault() {} }));
    await page.waitForFunction(() => document.querySelector('[aria-label="test location"]').textContent === '/canvas/original' && document.querySelector('[aria-label="test panel"]').textContent === 'true');
    assert.equal(await page.getByLabel('test location').textContent(), '/canvas/original');
    assert.equal(await page.getByLabel('test panel').textContent(), 'true');
    assert.equal(await page.getByLabel('test draft').textContent(), '保留这条未发送草稿');
    await foreground();
    await page.getByRole('button', { name: 'resolve pending', exact: true }).click();
    assert.doesNotMatch(await page.title(), /待确认/);
    await page.getByRole('button', { name: 'pending second', exact: true }).click();
    await page.getByRole('button', { name: 'language', exact: true }).click();
    await page.getByRole('button', { name: 'theme', exact: true }).click();
    assert.match(await page.title(), /Needs input 1/);
    await page.evaluate(() => { __reminders.setPermission('denied'); window.dispatchEvent(new Event('focus')); });
    await page.getByRole('button', { name: 'Confirmation reminders', exact: true }).click();
    assert.equal(await page.evaluate(() => __reminders.requests.length), 1, 'denied permission must not repeatedly prompt');
    await background();
    assert.equal(await page.evaluate(() => __reminders.records.length), 1);
    await foreground();
    await page.evaluate(() => { __reminders.setPermission('granted'); window.dispatchEvent(new Event('focus')); });
    await background();
    await page.waitForFunction(() => __reminders.records.length === 2);
    await page.reload();
    await page.getByRole('button', { name: '与导演对话', exact: true }).waitFor();
    await background();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.evaluate(() => __reminders.records.length), 0, 'refresh recovers notification UI markers without repeating the same request');
    await foreground();
    await page.getByRole('button', { name: 'resolve pending', exact: true }).click();
    await page.getByRole('button', { name: 'pending h3', exact: true }).click();
    await background();
    await page.waitForFunction(() => __reminders.records.length === 1);
    await page.evaluate(() => __reminders.records[0].onclick({ preventDefault() {} }));
    await page.waitForFunction(() => document.querySelector('[aria-label="test location"]').textContent === '/canvas/original?nodeId=h3&segmentId=clip');
    assert.equal(await page.getByLabel('test panel').textContent(), 'false', 'H3 confirmation should focus its Clip rather than opening the chat');
    await foreground(); await page.getByRole('button', { name: 'resolve h3', exact: true }).click();
    await page.waitForFunction(() => !document.title.includes('待确认'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '与导演对话', exact: true }).click();
    const checkHeaderControl = async () => {
        const control = director.getByRole('button', { name: '确认提醒', exact: true });
        await control.waitFor();
        assert.equal(await control.evaluate(button => {
            const panel = button.closest('#canvas-director-dialog').getBoundingClientRect(), rect = button.getBoundingClientRect();
            return rect.left >= panel.left && rect.right <= panel.right && rect.top >= panel.top && rect.bottom <= panel.top + 65
                && button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        }), true, 'the reminder switch fits inside the narrow director header and receives pointer input');
    };
    await checkHeaderControl();
    await page.getByRole('button', { name: 'creative welcome', exact: true }).click();
    await director.locator('[data-director-creative-entry]:not([hidden])').waitFor();
    await checkHeaderControl();
    assert.equal(await page.evaluate(() => __reminders.requests.length), 0, 'opening either director view does not request permission');
    assert.deepEqual(writes, [], 'reminders and click navigation must not send Backend mutations');
    assert.deepEqual(errors, []);
    console.log('PASS: director-header placement, narrow conversation and welcome views, permission gesture, reminders with director collapsed, deduplication, original-canvas click, H3 Clip focus, preserved draft, resolution, denied permission, refresh, English and dark theme. No Backend mutations.');
} finally {
    await browser?.close(); await server.close();
    const resolved = fs.realpathSync(cache), temporaryRoot = fs.realpathSync(os.tmpdir());
    if (!resolved.startsWith(temporaryRoot + path.sep) || !path.basename(resolved).startsWith('confirmation-browser-')) throw new Error('Unsafe notification-test cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
}
