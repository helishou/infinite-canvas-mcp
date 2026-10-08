import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.CANVAS_TEST_URL || 'http://localhost:3001'}/tests/h3-motion-group.html`);
    const card = id => page.locator(`[data-segment-id="${id}"]`);
    await card('a').waitFor();
    for (const dark of [false, true]) {
        if (dark) await page.getByRole('button', { name: 'Theme', exact: true }).click();
        assert.match(await card('a').innerText(), /接续组 1–2/);
        assert.match(await card('b').innerText(), /接续组 1–2/);
        assert.doesNotMatch(await card('outside').innerText(), /接续组/);
        await page.getByRole('button', { name: '生成当前 Clip', exact: true }).click();
        await page.waitForFunction(count => JSON.parse(document.querySelector('[data-testid="evidence"]').textContent).calls.length === count, dark ? 2 : 1);
    }
    const evidence = JSON.parse(await page.getByTestId('evidence').textContent());
    assert.equal(evidence.flushes, 2);
    assert.ok(evidence.calls.every(command => command.segmentId === 'a' && command.operation === 'h3-run' && command.runFromCurrent === false));
    await card('outside').click();
    assert.equal(await page.getByText('接续组：Clip 1–2。', { exact: false }).count(), 0);
    await card('a').click();
    await page.getByText('续段衔接', { exact: true }).click();
    const row = page.locator('.nfh3-control').filter({ hasText: '潜空间续写到下一段 Motion Context（V15）' });
    await row.getByRole('switch').click();
    assert.doesNotMatch(await card('a').innerText(), /接续组/);
    assert.doesNotMatch(await card('b').innerText(), /接续组/);
    assert.deepEqual(errors, []);
    console.log('Motion groups: labels, boundaries, saved switch edits, both themes and flushed current-Clip requests passed.');
} finally { await browser.close(); }
