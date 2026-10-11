import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'web/package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-image-browser-'));
process.env.CANVAS_TEST_VITE_CACHE = cache;
const server = await createServer({ root: path.join(root, 'web'), configFile: path.join(root, 'web/vite.config.ts'), cacheDir: cache, server: { port: 0, host: '127.0.0.1' } });
let browser;
try {
    await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(), writes = [], errors = [];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') writes.push(url.pathname);
        if (url.pathname.startsWith('/media/') && /fixture-/.test(url.pathname)) return route.fulfill({ contentType: 'image/png', body: png });
        if (url.origin !== base || /^\/(api|agent|events|canvas\/realtime|media)(\/|$)/.test(url.pathname)) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Backend isolated"}' });
        return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/tests/formal-image-inputs.html');
    await page.getByLabel('count').waitFor();
    assert.equal(await page.getByLabel('count').textContent(), '5');
    const parsed = JSON.parse(await page.getByLabel('context').textContent());
    assert.deepEqual(parsed.referenceImages.map(ref => ref.storageKey), [0,1,2,3,4].map(i => `image:fixture-${i}`));
    assert.equal(parsed.prompt, 'Complete approved prompt');
    assert.equal(await page.locator('main img').count(), 5, 'projection displays five pinned images despite zero supplied graph resources');
    await page.locator('main img').last().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('main img')].every(img => img.complete && img.naturalWidth > 0));
    await page.getByRole('button', { name: 'theme', exact: true }).click();
    await page.getByRole('button', { name: 'language', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const cards = page.locator('[draggable="true"]');
    await cards.nth(0).dragTo(cards.nth(1));
    assert.equal(await page.getByLabel('event').textContent(), 'order:CUIZI:SHUANZI');
    assert.equal(JSON.parse(await page.getByLabel('context').textContent()).referenceImages[0].storageKey, 'image:fixture-1');
    await page.getByRole('button', { name: 'Disconnect reference' }).nth(2).click();
    assert.equal(await page.getByLabel('event').textContent(), 'remove:NEIGHBOR:source');
    assert.equal(await page.getByLabel('count').textContent(), '4');
    await page.getByTitle('Select references from canvas', { exact: true }).click();
    assert.equal(await page.getByLabel('event').textContent(), 'pick:source');
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log('PASS: exact formal media and counts, no self-image or extra outfits, thumbnails, reorder, remove and add target the formal source, English, dark theme and narrow layout. No Backend mutations.');
} finally {
    await browser?.close(); await server.close();
    const resolved = fs.realpathSync(cache), temporaryRoot = fs.realpathSync(os.tmpdir());
    if (!resolved.startsWith(temporaryRoot + path.sep) || !path.basename(resolved).startsWith('formal-image-browser-')) throw new Error('Unsafe formal-image test cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
}
