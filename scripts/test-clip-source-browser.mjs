import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs';

// Use the isolated fixture page on an already running Vite server.
const base = process.env.CANVAS_TEST_WEB || 'http://127.0.0.1:3001';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 只拦真正的媒体请求：dev 模式下媒体是同源相对路径 /media/<key>，
  // 而源码模块 /src/components/media/media-image.tsx 也含 "/media/"，宽泛的 **/media/** 会把模块也拦掉导致整页空白。
  await page.route(url => url.pathname.startsWith('/media/') && !/\.(tsx|ts|js|mjs|css|json)(\?|$)/.test(url.pathname),
    route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"/>' }));
  for (const [clip, shot, state] of [['SEG1', '信使确认封口', '信件仍未拆封'], ['SEG2', '守门人不松手', '守门人握着信封']]) {
    await page.goto(`${base}/tests/acheng-production.html?clip=${clip}`);
    const editor = page.locator('[data-production-object-editor]');
    await editor.getByRole('heading', { name: '这段怎么拍', exact: true }).waitFor();
    // 镜头源字段现在是内联块（原先折叠在 [data-shot-source-details] 里），默认只读，点「修改」才变成输入框。
    const fields = editor.locator('[data-shot-source-fields]').first();
    await fields.waitFor();
    assert.equal(await fields.locator('textarea').count(), 0);
    assert.equal(await editor.locator('[data-shot-complete-source-details]').first().evaluate(element => element.open), false);
    assert.equal(await editor.locator('[data-clip-complete-source]').evaluate(element => element.open), false);
    assert.doesNotMatch(await editor.innerText(), /Ref2VA|F_COAT|story_order|编译前|integrated_multimodal_description/);
    assert.match(await fields.innerText(), new RegExp(state));
    await fields.getByRole('button', { name: '修改', exact: true }).click();
    assert.equal(await fields.locator('textarea').count(), 4);
    assert.match(await editor.locator('[data-clip-source-shots]').innerText(), new RegExp(shot));
    await editor.locator('[data-shot-complete-source-details] > summary').first().click();
    assert.match(await editor.locator('[data-shot-complete-source]').first().innerText(), new RegExp(state));
    assert.equal(await editor.locator('[data-clip-source-continuity]').evaluate(element => element.open), false);
    await editor.locator('[data-clip-source-continuity] > summary').click();
    assert.equal(await editor.locator('[data-clip-source-continuity]').getByRole('switch').count(), 2);
    assert.match(await editor.locator('[data-clip-source-continuity] textarea').inputValue(), /同一动作跨机位/);
    await editor.locator('[data-clip-complete-source] > summary').click();
    await editor.getByText('本集连续性账本', { exact: true }).click();
    assert.match(await editor.innerText(), /F_COAT/);
    const evidence = JSON.parse(await page.getByLabel('evidence').textContent());
    assert.equal(evidence.saves, 0);
    assert.equal(evidence.batches.length, 0);
    assert.equal(evidence.director.artifacts.find(item => item.targetId === clip).prompt.includes('integrated_multimodal_description'), true);
    await page.getByRole('button', { name: 'theme', exact: true }).click();
    await page.getByRole('button', { name: 'language', exact: true }).click();
    assert.match(await editor.innerText(), /What happens in this clip/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await editor.getByText('View and edit full continuity', { exact: true }).click();
    await page.locator('[data-continuity-workspace]').waitFor();
  }
  for (const [scenario, clip, boundaryCount] of [['single', 'SEG1', 0], ['middle', 'SEG2', 2]]) {
    await page.goto(`${base}/tests/acheng-production.html?clip=${clip}&scenario=${scenario}`);
    const editor = page.locator('[data-production-object-editor]');
    await editor.waitFor();
    if (boundaryCount) await editor.locator('[data-clip-source-continuity] > summary').click();
    assert.equal(await editor.locator('[data-clip-source-continuity]').getByRole('switch').count(), boundaryCount * 2);
    const evidence = JSON.parse(await page.getByLabel('evidence').textContent());
    assert.equal(evidence.saves, 0);
    assert.equal(evidence.batches.length, 0);
  }
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(`${base}/tests/acheng-production.html?clip=SEG1&scenario=ready`);
  const readyEditor = page.locator('[data-production-object-editor]');
  await readyEditor.getByRole('button', { name: '生成视频', exact: true }).waitFor();
  fs.mkdirSync('.tmp', { recursive: true });
  await readyEditor.screenshot({ path: '.tmp/clip-reading-light.png' });
  await page.getByRole('button', { name: 'theme', exact: true }).click();
  await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.includes('生成视频')); return button && Number(getComputedStyle(button).color.match(/[\d.]+/)[0]) > 230; });
  await readyEditor.screenshot({ path: '.tmp/clip-reading-dark.png' });
  await readyEditor.getByRole('button', { name: '生成视频', exact: true }).click();
  await readyEditor.getByText('正在生成', { exact: true }).waitFor();
  assert.equal(await readyEditor.getByRole('button', { name: '生成视频', exact: true }).isDisabled(), true);
  const generated = JSON.parse(await page.getByLabel('evidence').textContent());
  assert.deepEqual(generated.batches[0].targets, ['segment:SEG1']);
  assert.equal(generated.saves, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: readable clip view, collapsed technical details, editable original source and boundaries, ledger, no open-time writes, targeted generation and duplicate guard, bilingual themes and narrow screen.');
} finally {
  await browser.close();
}
