import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Use the isolated fixture page on an already running Vite server.
const base = process.env.CANVAS_TEST_WEB || 'http://127.0.0.1:3001';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/media/**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"/>' }));
  for (const [clip, shot, state] of [['SEG1', '信使确认封口', '信件仍未拆封'], ['SEG2', '守门人不松手', '守门人握着信封']]) {
    await page.goto(`${base}/tests/acheng-production.html?clip=${clip}`);
    const editor = page.locator('[data-production-object-editor]');
    await editor.getByText('编译前制作说明', { exact: false }).waitFor();
    assert.equal(await editor.locator('[data-shot-source-details]').evaluate(element => element.open), true);
    assert.match(await editor.locator('[data-clip-source-shots]').innerText(), new RegExp(shot));
    assert.match(await editor.locator('[data-shot-complete-source]').innerText(), new RegExp(state));
    assert.equal(await editor.locator('[data-clip-source-continuity]').getByRole('switch').count(), 2);
    assert.match(await editor.locator('[data-clip-source-continuity] textarea').inputValue(), /同一动作跨机位/);
    await editor.getByText('本集连续性账本', { exact: true }).click();
    assert.match(await editor.innerText(), /F_COAT/);
    const evidence = JSON.parse(await page.getByLabel('evidence').textContent());
    assert.equal(evidence.saves, 0);
    assert.equal(evidence.batches.length, 0);
    assert.equal(evidence.director.artifacts.find(item => item.targetId === clip).prompt.includes('integrated_multimodal_description'), true);
    await page.getByRole('button', { name: 'theme', exact: true }).click();
    await page.getByRole('button', { name: 'language', exact: true }).click();
    assert.match(await editor.innerText(), /Pre-compilation production notes/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await editor.getByText('View and edit full continuity', { exact: true }).click();
    await page.locator('[data-continuity-workspace]').waitFor();
  }
  for (const [scenario, clip, boundaryCount] of [['single', 'SEG1', 0], ['middle', 'SEG2', 2]]) {
    await page.goto(`${base}/tests/acheng-production.html?clip=${clip}&scenario=${scenario}`);
    const editor = page.locator('[data-production-object-editor]');
    await editor.waitFor();
    assert.equal(await editor.locator('[data-clip-source-continuity]').getByRole('switch').count(), boundaryCount * 2);
    const evidence = JSON.parse(await page.getByLabel('evidence').textContent());
    assert.equal(evidence.saves, 0);
    assert.equal(evidence.batches.length, 0);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: Clip source notes, full shot structures, incoming/outgoing boundaries, ledger, no open-time writes/generation, bilingual themes and narrow screen.');
} finally {
  await browser.close();
}
