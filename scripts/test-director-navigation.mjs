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
const records = new Map(); const requests = []; const turnRequests = []; const runStarts = []; const runRecords = new Map(); let creationCount = 0; let loseCreationResponse = true; let loseRunStartResponse = true; let failRead = true;
const record = id => {
    const owner = id === 'linked' ? 'ep' : id;
    if (!records.has(owner)) records.set(owner, { episodeId: owner, revision: 0, publishedVersion: 0, published: null, updatedAt: '', draft: { director: undefined, scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: 'manual', imageModel: '', h3Model: '', imageModels: {}, h3Models: {} }, legacyImports: [] } });
    return records.get(owner);
};
try {
    await server.listen(); browser = await chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
    await page.addInitScript(() => {
        sessionStorage.setItem('backend-connection', JSON.stringify({ url: 'http://127.0.0.1:17370', token: 'fixture' }));
        class TestEventSource {
            constructor(url) {
                this.url = url; this.readyState = 0; this.listeners = new Map(); this.onerror = null; window.__directorTestEventSource = this;
                this.timer = window.setTimeout(() => {
                    if (this.readyState === 2) return;
                    this.readyState = 1;
                    this.dispatchEvent({ type: 'hello', data: JSON.stringify({
                        ok: true, protocolVersion: 6, clientId: 'fixture-client', workspace: { activeThreadId: 'creative-thread' },
                        conversation: { revision: 1, conversationId: 'creative-conversation', threadId: 'creative-thread', status: 'ready', mcpStatuses: {} },
                        codex: { busy: false, threadId: 'creative-thread', turnId: '' }, pendingApprovals: [],
                    }) });
                }, 450);
            }
            addEventListener(type, listener) { const listeners = this.listeners.get(type) || []; listeners.push(listener); this.listeners.set(type, listeners); }
            dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); }
            close() { this.readyState = 2; window.clearTimeout(this.timer); }
        }
        Object.defineProperty(window, 'EventSource', { configurable: true, value: TestEventSource });
    });
    await page.route('http://127.0.0.1:17370/**', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        requests.push({ pathname, method }); let data = { ok: true };
        if (pathname === '/agent/codex/turn' && method === 'POST') { turnRequests.push(request.postDataJSON()); data = { ok: true, threadId: 'workbench-thread' }; }
        else if (pathname === '/agent/codex/skills') data = { ok: true, data: [{ name: 'canvas-video-production-sop', description: 'Acheng workbench', path: 'C:/skills/canvas-video-production-sop/SKILL.md', scope: 'user', enabled: true, managed: true }] };
        else if (pathname === '/agent/codex/threads') data = { ok: true, data: [{ id: 'workbench-thread', preview: 'Director session' }], workspace: { workspacePath: 'E:/workspace', activeThreadId: 'workbench-thread' }, conversation: { revision: 1, conversationId: 'workbench-conversation', threadId: 'workbench-thread', status: 'ready', mcpStatuses: {} } };
        else if (/\/agent\/codex\/threads\/[^/]+$/.test(pathname)) data = { ok: true, thread: { id: 'workbench-thread' }, messages: [], settledTurnIds: [], historyReady: true };
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
            if (pathname.endsWith('/readiness')) {
                const currentWork = production.draft.director?.workflow?.currentWork;
                const workspaceByModule = { story: 'story', assets: 'assets', shots: 'shots', performance: 'shots', effects: 'shots', model: 'production', continuity: 'production' };
                const ownerKind = pathname.startsWith('/canvas/projects/') ? 'canvas' : 'episode';
                const targetKind = currentWork?.targetKind === 'keyframe' ? 'frame' : currentWork?.targetKind;
                const presentation = currentWork ? { key: [currentWork.workId, currentWork.action, currentWork.targetId].join(':'), workId: currentWork.workId, owner: { kind: ownerKind, id: id }, workspace: workspaceByModule[currentWork.module] || 'overview', action: currentWork.action, targetKind: currentWork.targetKind, targetId: currentWork.targetId, canvasId: ownerKind === 'canvas' ? id : episode.canvasId, ...(currentWork.runId ? { runId: currentWork.runId } : {}), status: 'ready' } : undefined;
                data.readiness = { revision: production.revision, publishedVersion: production.publishedVersion, source: 'draft', targets: production.draft.director ? [{ id: 'segment:SEG1', targetId: 'SEG1', kind: 'segment', title: 'SEG1', status: 'ready', blockers: [] }] : [], modules: {}, unresolved: [], nextAction: production.draft.director ? '可以推进：SEG1' : '尚未接入 Acheng 制作稿', ...(presentation ? { presentation } : {}) };
            }
            else if (pathname.endsWith('/runs') && method === 'POST') {
                const input = request.postDataJSON(); runStarts.push(input);
                if (input.workId && production.draft.director?.workflow?.currentWork?.workId === input.workId) {
                    production.draft.director.workflow.currentWork = { ...production.draft.director.workflow.currentWork, runId: input.runId, inputRevision: production.revision + 1 };
                    production.revision++;
                }
                const batch = { runId: input.runId, episodeId: production.episodeId, version: input.version, sourceRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, status: 'pending', targets: input.targets, plan: { changedSceneIds: [], affectedShotIds: [], imageShotIds: [], clipGroupIds: ['SEG1'], missingAssetNodeIds: [] }, engine: production.draft.director?.engine || null, settings: {}, submitted: [], error: null, pauseRequested: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
                runRecords.set(batch.runId, batch);
                if (loseRunStartResponse) { loseRunStartResponse = false; return route.abort(); }
                data.run = batch;
            }
            else if (pathname.endsWith('/batches')) data.runs = [...runRecords.values()].filter(run => run.episodeId === production.episodeId);
            else if (/\/batches\/[^/]+$/.test(pathname)) data.run = runRecords.get(decodeURIComponent(pathname.split('/').at(-1))) || null;
            else if (pathname.endsWith('/legacy')) data.sources = [];
            else if (pathname.endsWith('/versions')) data.versions = [];
            else if (pathname.endsWith('/ops')) {
                const input = request.postDataJSON();
                for (const op of input.ops || []) {
                    if (op.type === 'set_director_brief') {
                        if (!production.draft.director) production.draft.director = {
                            schemaVersion: 1, engine: { commit: 'a'.repeat(40), patchVersion: 'mock', runtimeId: 'mock-runtime', version: '4.3.9' },
                            source: { brief: op.brief, fps_num: 24, fps_den: 1, script_scenes: [], shots: [], asset_plan: [], segments: [] },
                            sourceHash: 'a'.repeat(64), modules: Object.fromEntries(['story','assets','shots','performance','effects','model','continuity'].map(key => [key, { status: 'planned', evidence: [], unresolved: [] }])),
                            artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: { contentDeliveryMode: 'auto_file_batch', mediaProductionMode: 'per_item' },
                        };
                        else production.draft.director.source.brief = op.brief;
                        production.publishedVersion = 1; production.published = structuredClone(production.draft);
                    } else if (op.type === 'set_director_workflow' && production.draft.director) {
                        production.draft.director.workflow = { ...production.draft.director.workflow, ...op.patch };
                    }
                }
                production.revision++; data.production = production;
            }
            else data.production = production;
        } else if (pathname === '/drama/episodes/ep') data = { ok: true, episode, canvas: projects[1] };
        else if (/\/canvas\/projects\/[^/]+\/drama$/.test(pathname)) data = { ok: true, episode: pathname.includes('/linked/') ? episode : null };
        else if (/\/canvas\/projects\/[^/]+$/.test(pathname)) data.project = projects.find(p => p.id === decodeURIComponent(pathname.split('/')[3]));
        return route.fulfill({ json: data, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/director-navigation.html?start=%2Fdirector`);
    await page.getByRole('heading', { name: '制作', exact: true }).waitFor();
    assert.ok(await page.getByRole('link', { name: '制作', exact: true }).count());
    await page.getByRole('heading', { name: '从一个想法开始', exact: true }).waitFor();
    await page.getByRole('textbox', { name: '创意描述', exact: true }).fill('雨夜机械师：先设计角色、场景与制作对象。');
    const creativeTurnResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/agent/codex/turn');
    await page.evaluate(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        const agent = useAgentStore.getState();
        agent.setAgentState({
            url: 'http://127.0.0.1:17370/agent', token: 'fixture', enabled: false, connected: false,
            sending: false, waiting: false, loadingThreads: false,
            conversation: { revision: 0, conversationId: '', threadId: '', status: 'idle', mcpStatuses: {} },
        });
        document.querySelector('[aria-labelledby="production-creative-title"] form').requestSubmit();
    });
    const creativeResponse = await creativeTurnResponse;
    const creativeRequest = creativeResponse.request();
    assert.equal(creativeResponse.ok(), true);
    const creativePrompt = creativeRequest.postDataJSON().prompt;
    assert.match(creativePrompt, /雨夜机械师/);
    assert.match(creativePrompt, /制作中心创意入口/);
    assert.match(creativePrompt, /workflow\.currentWork/);
    assert.match(creativePrompt, /site_navigate\(\{production:/);
    assert.match(creativePrompt, /凭聊天内容自行拼路由/);
    assert.match(creativePrompt, /真实节点\/Clip 映射后才能切到对象画布/);
    assert.equal(turnRequests.length, 1, 'one creative-entry submission connects Agent and dispatches the prompt');
    await page.waitForFunction(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        return useAgentStore.getState().connected && !useAgentStore.getState().creativeLaunch;
    });
    assert.equal(await page.getByRole('textbox', { name: '创意描述', exact: true }).inputValue(), '');
    await page.evaluate(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        window.__directorTestEventSource.dispatchEvent({ type: 'codex_state', data: JSON.stringify({ threadId: 'creative-thread', turnId: 'creative-turn', busy: false }) });
        useAgentStore.getState().disconnectAgent({ token: '', prompt: '', attachments: [], canvasReferences: [], creativeLaunch: null, sending: false, waiting: false, panelOpen: false });
    });
    await page.waitForFunction(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        return !useAgentStore.getState().connected && !useAgentStore.getState().sending;
    });
    await page.getByRole('button', { name: 'test canvas library', exact: true }).click();
    await page.getByRole('heading', { name: '无限画布', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '从一个想法开始', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'test production hub', exact: true }).click();
    await page.getByRole('heading', { name: '从一个想法开始', exact: true }).waitFor();
    await page.getByRole('tab', { name: '剧目与分集', exact: true }).click();
    await page.getByRole('heading', { name: '全部剧目', exact: true }).waitFor();
    await page.getByRole('tab', { name: '画布项目', exact: true }).click();
    await page.getByRole('heading', { name: '画布项目', exact: true }).waitFor();
    await page.getByRole('button', { name: 'test old drama route', exact: true }).click();
    await page.getByRole('heading', { name: '全部剧目', exact: true }).waitFor();
    await page.getByRole('tab', { name: '画布项目', exact: true }).click();
    await page.getByRole('heading', { name: '画布项目', exact: true }).waitFor();
    const artifacts = path.join(cache, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
    await page.getByRole('link').filter({ hasText: '独立角色制作' }).click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    const brief = page.getByPlaceholder('描述故事、角色、场景或想继续完成的内容。已有素材可以在画布或右侧对话中添加。');
    await page.evaluate(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        useAgentStore.getState().setAgentState({
            prompt: '保留的聊天草稿',
            attachments: [{ id: 'unsent-image', name: 'unsent.png', type: 'image/png', size: 4, width: 1, height: 1, url: 'blob:unsent', dataUrl: 'data:image/png;base64,AA==' }],
            canvasReferences: [{ id: 'canvas:unsent-node', nodeId: 'unsent-node', kind: 'image', label: 'Picture 1', title: 'Unsent ref', previewUrl: 'blob:unsent-ref', active: true }],
        });
    });
    await brief.fill('制作一个侦探角色');
    await page.getByRole('button', { name: '推进当前工作', exact: true }).click();
    await page.getByText('草稿修订 1', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('agent draft').textContent(), '保留的聊天草稿');
    assert.deepEqual(JSON.parse(await page.getByLabel('agent preservation').textContent()), { prompt: '保留的聊天草稿', attachmentCount: 1, referenceCount: 1 });
    await brief.fill('第二段需求写回 Backend，但不得覆盖聊天草稿');
    await page.getByRole('button', { name: '推进当前工作', exact: true }).click();
    await page.getByText('草稿修订 2', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('agent draft').textContent(), '保留的聊天草稿');
    assert.deepEqual(JSON.parse(await page.getByLabel('agent preservation').textContent()), { prompt: '保留的聊天草稿', attachmentCount: 1, referenceCount: 1 });
    assert.equal(turnRequests.length, 1, "only the single automatic creative-entry request was dispatched; an offline scoped request must stop without retry");
    const standaloneProduction = records.get('canvas:standalone') || records.get('standalone');
    assert.match(String(standaloneProduction?.draft.director?.source.brief), /第二段需求写回 Backend/);
    await page.getByRole('tab', { name: '生产与交付', exact: true }).click();
    await page.getByRole('button', { name: '生成此 Segment', exact: true }).click();
    await page.getByText(/生产启动尚未取得回执/).waitFor();
    await page.waitForTimeout(250);
    const lostRunId = runStarts[0].runId;
    await page.reload();
    await page.getByRole('heading', { name: '画布项目', exact: true }).waitFor();
    await page.getByRole('link').filter({ hasText: '独立角色制作' }).click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    await page.getByText(lostRunId, { exact: true }).waitFor();
    await page.getByRole('button', { name: '用原请求取回执', exact: true }).click();
    await page.getByRole('tab', { name: '生产与交付', exact: true }).click();
    await page.getByText('pending · ' + lostRunId, { exact: true }).waitFor();
    assert.equal(runStarts.length, 1, 'recovery reads the original runId and does not create another production batch');
    assert.equal(runRecords.size, 1);
    assert.equal(await page.getByRole('button', { name: '生成此 Segment', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'test retry', exact: true }).click();
    await page.getByText('暂时无法读取制作数据', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^刷\s*新$/ }).click();
    await page.getByRole('heading', { name: '重试画布', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    await page.getByRole('button', { name: 'test episode', exact: true }).click();
    await page.getByRole('heading', { name: '第一集', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    assert.equal(await page.getByPlaceholder('描述故事、角色、场景或想继续完成的内容。已有素材可以在画布或右侧对话中添加。').inputValue(), '');
    await page.getByPlaceholder('描述故事、角色、场景或想继续完成的内容。已有素材可以在画布或右侧对话中添加。').fill('单集草稿保持一致');
    await page.getByRole('button', { name: 'test linked canvas', exact: true }).click();
    await page.getByRole('heading', { name: '第一集', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '单集草稿保持一致');
    await page.getByRole('button', { name: 'test canvas', exact: true }).click();
    await page.getByRole('link', { name: '进入制作', exact: true }).click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    await page.getByRole('button', { name: '返回制作对象', exact: true }).click();
    await page.getByRole('button', { name: '新建制作', exact: true }).click();
    await page.getByRole('textbox', { name: '制作名称', exact: true }).fill('新短片');
    await page.locator('.ant-modal-footer button.ant-btn-primary').click();
    await page.getByText(/无法连接 Backend.*POST/).first().waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.ant-modal-footer button')).some(button => button.textContent?.includes('创建并进入') && !button.disabled && !button.classList.contains('ant-btn-loading')));
    await page.locator('.ant-modal-footer button.ant-btn-primary').click();
    await page.getByRole('heading', { name: '新短片', exact: true }).waitFor(); assert.equal(creationCount, 1);
    assert.equal(requests.some(r => /generate|h3-run|chat\/send/.test(r.pathname)), false);
    assert.equal(requests.some(r => r.pathname === '/drama/episodes/standalone'), false);
    await page.getByRole('button', { name: 'test language', exact: true }).click();
    await page.getByRole('button', { name: 'Back to production objects', exact: true }).waitFor();
    await page.mouse.move(900, 650);
    await page.waitForFunction(() => document.querySelectorAll('.ant-message-notice').length === 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Production', exact: true }).click();
    await page.getByRole('heading', { name: 'Production', exact: true }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: 'test canvas', exact: true }).click();
    const productionShortcut = page.getByRole('link', { name: /Open production|进入制作/ }).first();
    await productionShortcut.click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).or(page.getByRole('heading', { name: 'Canvas', exact: true })).waitFor();
    await page.evaluate(async () => {
        const [{ fetchEpisodeProduction, editEpisodeProduction }, { useBackendStore }, { useProductionFollowStore }] = await Promise.all([
            import('/src/services/backend-api.ts'), import('/src/stores/use-backend-store.ts'), import('/src/stores/use-production-follow-store.ts'),
        ]);
        const target = { projectId: 'standalone' };
        const current = await fetchEpisodeProduction(target).then(result => result.production);
        const workId = 'browser-follow-work';
        await editEpisodeProduction(target, current.revision, [{ type: 'set_director_workflow', patch: { currentWork: { workId, module: 'assets', action: 'author', targetKind: 'asset', targetId: 'STYLE_MOTHER', inputRevision: current.revision + 1, sourceHash: current.draft.director.sourceHash } } }], 'browser-follow-focus');
        useBackendStore.setState({ connected: true, checking: false });
        useProductionFollowStore.getState().setTarget({ kind: 'canvas', id: 'standalone', workId });
    });
    await page.waitForFunction(() => document.querySelector('output[aria-label="location"]')?.textContent?.includes('/director/standalone?workspace=assets'));
    assert.equal(await page.getByRole('tab', { name: 'Style & Assets', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'test production hub', exact: true }).click();
    await page.getByRole('heading', { name: 'Production', exact: true }).waitFor();
    await page.waitForFunction(async () => !(await import('/src/stores/use-production-follow-store.ts')).useProductionFollowStore.getState().following);
    await page.evaluate(async () => {
        const [{ fetchEpisodeProduction, editEpisodeProduction }, { useProductionFollowStore }] = await Promise.all([
            import('/src/services/backend-api.ts'), import('/src/stores/use-production-follow-store.ts'),
        ]);
        const target = { projectId: 'standalone' };
        const current = await fetchEpisodeProduction(target).then(result => result.production);
        const work = current.draft.director.workflow.currentWork;
        await editEpisodeProduction(target, current.revision, [{ type: 'set_director_workflow', patch: { currentWork: { ...work, module: 'story', targetKind: 'story', targetId: 'scene-follow', inputRevision: current.revision + 1 } } }], 'browser-follow-advance');
        window.dispatchEvent(new CustomEvent('backend-event', { detail: { type: 'drama-production.updated', entityId: 'standalone' } }));
    });
    await page.waitForTimeout(150);
    assert.ok((await page.getByLabel('location').textContent())?.startsWith('/production'), 'manual page navigation pauses automatic following');
    const returnToProduction = page.getByRole('button', { name: 'Return to current production', exact: true });
    assert.equal(await returnToProduction.count(), 1, 'collapsed Agent controls stay out of the accessibility tree');
    await returnToProduction.click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="location"]')?.textContent?.includes('/director/standalone?workspace=story'));
    assert.equal(await page.getByRole('tab', { name: 'Story', exact: true }).getAttribute('aria-selected'), 'true');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, creationCount, scope: 'unified production entry and object views, creative entry handoff, legacy routes, independent canvas, episode alias, shared draft, canvas shortcut, new production, Agent disconnected draft protection, runId receipt recovery, active-target duplicate prevention, follow presentation, manual pause and return, mobile navigation, no media generation' }));
} catch (error) { console.error("Production requests:", JSON.stringify(requests.filter(item => /production/.test(item.pathname)))); console.error("Rendered page:", await page?.locator("body").innerText()); throw error; } finally { await browser?.close(); await server.close(); if (path.dirname(cache) === os.tmpdir() && path.basename(cache).startsWith('director-entry-')) fs.rmSync(cache, { recursive: true, force: true }); }
