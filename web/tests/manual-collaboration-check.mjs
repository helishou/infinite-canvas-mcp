import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:17370/**', route => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || 'http://localhost:3001'}/tests/manual-collaboration.html`);
    const evidence = () => page.getByLabel('evidence').textContent().then(JSON.parse);
    await page.getByText('查看差异', { exact: true }).click();
    assert.deepEqual((await evidence()).writes, []);
    await page.getByRole('checkbox', { name: '提示词', exact: true }).check();
    await page.getByRole('button', { name: '采用选定导演字段', exact: true }).click();
    let state = await evidence();
    assert.equal(state.current.prompt, '导演的新对白、动作与镜头描述。');
    assert.equal(state.current.title, '人工标题'); assert.equal(state.current.duration, 6);
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Duration', exact: true }).check();
    await page.getByRole('button', { name: 'Saving', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Adopt selected director fields', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Saving', exact: true }).click();
    await page.setViewportSize({ width: 480, height: 850 });
    await page.getByRole('button', { name: 'Adopt selected director fields', exact: true }).click();
    state = await evidence();
    assert.equal(state.current.duration, 5); assert.equal(state.current.referenceBindings[0].id, 'director-reference');
    assert.equal(state.current.title, '人工标题'); assert.deepEqual(state.writes, [['prompt'], ['duration']]);
    assert.deepEqual(errors, []);
    console.log('PASS: field selection, related adoption, preservation, StrictMode, themes, languages and narrow viewport');
} finally { await browser.close(); }
