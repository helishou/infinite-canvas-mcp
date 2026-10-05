// Explicit, non-generating acceptance against existing local projects. Use an isolated browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(root, 'backend/package.json'));
(await import(pathToFileURL(req.resolve('tsx/esm/api')).href)).register();
const { loadConfig } = await import('../backend/src/config.ts');
const cfg = loadConfig(), backendUrl = `http://127.0.0.1:${cfg.port}`;
const read = async endpoint => { const response = await fetch(backendUrl + endpoint, { headers: { Authorization: `Bearer ${cfg.token}` } }); if (!response.ok) throw new Error(`Read ${endpoint}: HTTP ${response.status}`); return response.json(); };
const fingerprints = production => crypto.createHash('sha256').update(JSON.stringify(production)).digest('hex');
const cases = process.argv.slice(2).map(id => ({ id }));
if (!cases.length) throw new Error('Usage: node scripts/test-production-live.mjs <existing-episode-id> [...]');
const evidence = path.join(os.tmpdir(), 'production-live-acceptance'); fs.mkdirSync(evidence, { recursive: true });
const reports = [], blocked = [], errors = [], requestFailures = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 960 } });
await context.addInitScript(connection => { sessionStorage.setItem('backend-connection', JSON.stringify(connection)); localStorage.setItem('backend-url', connection.url); localStorage.setItem('backend-token', connection.token); }, { url: backendUrl, token: cfg.token });
await context.route(`${backendUrl}/**`, async route => {
  const request = route.request(), url = new URL(request.url());
  if (request.method() !== 'GET' && request.method() !== 'OPTIONS' && (/\/canvas\/generation/.test(url.pathname) || /\/production\/(ops|publish|restore|runs|prepare-targets|arrange-scene|shared-assets)/.test(url.pathname) || /\/agent\/.*(turn|send|approval)/.test(url.pathname) || /\/canvas\/projects\/[^/]+\/ops$/.test(url.pathname))) {
    blocked.push({ path: url.pathname, method: request.method() });
    return route.fulfill({ status: 403, json: { ok: false, error: 'Live acceptance does not mutate production, layout or submit media.' } });
  }
  return route.continue();
});
const closeEditor = async page => { const button = page.locator('.ant-modal-wrap:not(.ant-modal-hidden) .ant-modal-close:visible'); if (await button.count()) await button.last().click(); };
try {
  for (const [index, item] of cases.entries()) {
    const before = (await read(`/drama/episodes/${item.id}/production`)).production;
    const episode = (await read(`/drama/episodes/${item.id}`)).episode;
    const project = (await read(`/canvas/projects/${episode.canvasId}`)).project;
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) requestFailures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    const report = { title: episode.title, episodeId: item.id, checks: [], findings: [] }; reports.push(report);
    try {
      await page.goto(`http://127.0.0.1:3001/production?dramaId=${encodeURIComponent(episode.dramaId)}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-drama-shared-canvas]').waitFor();
      await page.getByRole('button', { name: '剧目规划', exact: true }).click();
      const planning = page.getByRole('dialog', { name: '剧目规划', exact: true });
      for (const label of ['角色／服装图片模型', '场景图片模型', '道具图片模型', '风格图模型', '分镜／关键帧图片模型']) assert.equal(await planning.getByText(label, { exact: true }).isVisible(), true);
      await page.screenshot({ path: path.join(evidence, `${index}-plan-models.png`), animations: 'disabled' });
      await closeEditor(page);
      await page.reload();
      await page.locator('[data-drama-shared-canvas]').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('dramaId'), episode.dramaId);
      await page.screenshot({ path: path.join(evidence, `${index}-drama-overview.png`), animations: 'disabled' });
      report.checks.push('drama planning precedes the canvas; category models and shared asset card are visible; refresh preserves the selected drama');
      await page.goto(`http://127.0.0.1:3001/drama/episodes/${item.id}/production`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`**/canvas/${episode.canvasId}**`);
      await page.getByRole('button', { name: '找画面', exact: true }).waitFor();
      assert.equal(await page.locator('#canvas-director-dialog').isVisible(), false);
      report.checks.push('existing episode entry opens its fixed canvas with no permanent conversation');
      await page.screenshot({ path: path.join(evidence, `${index}-entry.png`), animations: 'disabled' });
      await page.getByRole('button', { name: '切换制作画布', exact: true }).click();
      await page.getByRole('menuitem').filter({ hasText: episode.title }).waitFor();
      const episodeMenu = await page.getByRole('menuitem').allTextContents();
      report.episodeChoices = episodeMenu.filter(text => /第.*集/.test(text)).length;
      await page.screenshot({ path: path.join(evidence, `${index}-switcher.png`), animations: 'disabled' });
      await page.keyboard.press('Escape'); await page.mouse.click(1000, 100);
      report.checks.push('episode and shared-asset menu is reachable');
      assert.equal(await page.getByRole('button', { name: '本场剧本', exact: true }).count(), 0);
      const scriptNodes = project.nodes.filter(node => node.type === 'text' && node.metadata?.productionScriptId);
      report.scriptTextNodes = scriptNodes.length;
      for (const node of scriptNodes) {
        const block = before.draft.director?.source.script_scenes?.find(block => String(block.id || block.scene_id) === node.metadata.productionScriptId);
        assert.equal(node.metadata.content, block?.text || '');
      }
      report.checks.push('no separate script button; existing script text nodes match the formal source');
      await page.getByRole('button', { name: '找画面', exact: true }).click();
      await page.locator('[data-production-directory-target]').first().waitFor();
      report.directoryScenes = await page.locator('[data-production-directory-target^="scene:"]').count();
      report.directoryShots = await page.locator('[data-production-directory-target^="shot:"]').count();
      report.formalShots = before.draft.shots.length;
      const shotTargets = await page.locator('[data-production-directory-target^="shot:"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-production-directory-target')));
      report.uniqueDirectoryShots = new Set(shotTargets).size;
      assert.equal(report.uniqueDirectoryShots, report.formalShots, 'every formal shot must be reachable');
      await page.screenshot({ path: path.join(evidence, `${index}-directory.png`), animations: 'disabled' });
      const asset = Object.entries(before.draft.director.assets).find(([, asset]) => asset.nodeId && asset.storageKey);
      if (asset) {
        await page.locator(`[data-production-directory-target="asset:${asset[0]}"] button`).first().click();
        const dock = page.locator('[data-production-node-actions]'); await dock.waitFor();
        await page.getByRole('button', { name: '找画面', exact: true }).click();
        await page.locator(`[data-production-directory-target="asset:${asset[0]}"] button`).first().click();
        await dock.waitFor();
        await page.getByRole('dialog', { name: '找画面', exact: true }).waitFor({ state: 'hidden' });
        await page.locator(`[data-node-id="${asset[1].nodeId}"]`).click();
        await dock.waitFor();
        await dock.getByRole('button', { name: '编辑说明', exact: true }).click();
        await page.locator('[data-production-object-editor]').waitFor({ state: 'visible' });
        assert.equal(await page.locator('[data-production-dialog] nav').count(), 0);
        await closeEditor(page);
        await dock.getByRole('button', { name: '更多节点操作', exact: true }).click();
        await page.getByRole('menuitem', { name: '历史版本', exact: true }).click();
        await page.getByText('仅显示当前节点或视频片段的生成记录与原始结果。查看历史不会替换当前采用的版本。', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(evidence, `${index}-history.png`), animations: 'disabled' });
        await closeEditor(page);
        report.checks.push('existing asset supports repeated directory selection and direct node clicks; focused editor and object history open');
      } else { await closeEditor(page); report.findings.push('No archived asset has a formal node mapping.'); }
      const group = before.draft.clipGroups.find(group => group.nodeId && group.segmentId);
      if (group) {
        await page.getByRole('button', { name: '找画面', exact: true }).click();
        const row = page.locator(`[data-production-directory-target="segment:${group.id}"]`).first();
        if (await row.count()) {
          await row.locator('button').first().click();
          await page.waitForFunction(async ({ canvasId, nodeId, segmentId }) => (await import('/src/stores/canvas/plugin-node-view.ts')).getPluginNodeView(canvasId, nodeId).getSnapshot().selectedSegmentId === segmentId, { canvasId: episode.canvasId, nodeId: group.nodeId, segmentId: group.segmentId });
          assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('video')).every(video => video.paused)), true);
          report.checks.push('directory selects the exact existing H3 Clip without autoplay');
        } else report.findings.push('The formal Clip is missing from the scene directory.');
      }
      const tasks = page.getByRole('button', { name: '任务与交付', exact: true });
      if (await tasks.count()) {
        await tasks.click(); await page.locator('[data-production-tasks-panel]').waitFor({ state: 'visible' });
        const downloads = page.locator('[data-production-tasks-panel]').getByRole('button', { name: '下载', exact: true });
        report.deliveryCount = await downloads.count();
        if (report.deliveryCount) { const download = page.waitForEvent('download'); void download.catch(() => undefined); await downloads.first().click(); const file = await download; await file.saveAs(path.join(evidence, `${index}-delivery-${file.suggestedFilename()}`)); report.checks.push('existing archived video downloads from the task panel'); }
        else report.findings.push('The task panel contains no delivery despite existing completed production tasks.');
        await page.screenshot({ path: path.join(evidence, `${index}-tasks.png`), animations: 'disabled' });
        await closeEditor(page);
      } else report.findings.push('The task entry is unavailable without a current presentation.');
      const after = (await read(`/drama/episodes/${item.id}/production`)).production;
      assert.equal(fingerprints(after), fingerprints(before), 'live acceptance must leave formal source and media bindings unchanged');
      report.checks.push('formal production record and adopted media remain unchanged');
    } catch (error) {
      report.findings.push(String(error));
      await page.screenshot({ path: path.join(evidence, `${index}-failure.png`), animations: 'disabled' });
    } finally {
      assert.equal(fingerprints((await read(`/drama/episodes/${item.id}/production`)).production), fingerprints(before), 'live acceptance must leave formal source and media bindings unchanged');
      assert.equal(fingerprints((await read(`/canvas/projects/${episode.canvasId}`)).project), fingerprints(project), 'live acceptance must leave canvas layout and media unchanged');
      await page.close();
    }
  }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ reports, blocked, errors, requestFailures }, null, 2));
  console.log(JSON.stringify({ reports, blocked, errors, requestFailures, evidence }));
  assert.deepEqual(blocked, [], 'no production writes or model submissions may be attempted');
  assert.deepEqual(errors, []);
  assert.deepEqual(requestFailures, []);
  assert.equal(reports.every(report => report.findings.length === 0), true, 'live acceptance found an incomplete interaction');
} finally { await context.close(); await browser.close(); }
