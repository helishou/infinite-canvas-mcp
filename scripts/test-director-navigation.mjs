import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(root, 'web/package.json'));
const { createServer } = await import(pathToFileURL(req.resolve('vite')).href);
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'director-entry-'));
process.env.CANVAS_TEST_VITE_CACHE = cache;
const portProbe = net.createServer();
await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
const probeAddress = portProbe.address();
if (!probeAddress || typeof probeAddress === 'string') throw new Error('Could not allocate a local browser-test port');
const testPort = probeAddress.port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
const server = await createServer({ root: path.join(root, 'web'), configFile: path.join(root, 'web/vite.config.ts'), server: { port: testPort, strictPort: true, host: '127.0.0.1' }, cacheDir: cache });
let browser, page;
const projects = [{ id: 'standalone', title: '独立角色制作', nodes: [], connections: [], updatedAt: '2026-10-01T00:00:00Z' }, { id: 'linked', title: '分集画布', nodes: [], connections: [], updatedAt: '2026-10-02T00:00:00Z' }];
const episode = { id: 'ep', title: '第一集', episodeNumber: 1, canvasId: 'linked' };
projects.push({ id: 'retry', title: '重试画布', nodes: [], connections: [], updatedAt: '2026-10-01T00:00:00Z' });
const records = new Map(); const requests = []; const turnRequests = []; const runStarts = []; const runRecords = new Map(); let creationCount = 0; let loseCreationResponse = true; let loseRunStartResponse = true; let failRead = true;
let recoveredTurnFixture = "";
let runtimeStateFixture;
let runtimeStateUnavailable = false;
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
        else if (pathname === '/agent/codex/state') {
            if (runtimeStateUnavailable) return route.fulfill({ status: 503, json: { error: 'fixture state unavailable' }, headers: { 'access-control-allow-origin': '*' } });
            data = { ok: true, ...(runtimeStateFixture ? { runtime: runtimeStateFixture } : {}) };
        }
        else if (pathname === '/agent/codex/skills') data = { ok: true, data: [
            { name: 'acheng-director', description: 'Personal Acheng Director', path: 'C:/Users/wxy/.codex/skills/acheng-director/SKILL.md', scope: 'user', enabled: true, managed: true },
            { name: 'canvas-video-production-sop', description: 'Canvas production adapter', path: 'E:/workspace/.agents/skills/canvas-video-production-sop/SKILL.md', scope: 'repo', enabled: true, managed: true },
            { name: 'acheng-director', description: 'Acheng Director', path: 'E:/workspace/.agents/skills/acheng-director/SKILL.md', scope: 'repo', enabled: true, managed: true },
        ] };
        else if (pathname === '/agent/codex/threads') data = { ok: true, data: [{ id: 'workbench-thread', preview: 'Director session' }], workspace: { workspacePath: 'E:/workspace', activeThreadId: 'workbench-thread' }, conversation: { revision: 1, conversationId: 'workbench-conversation', threadId: 'workbench-thread', status: 'ready', mcpStatuses: {} } };
        else if (/\/agent\/codex\/threads\/[^/]+$/.test(pathname)) data = { ok: true, thread: { id: 'workbench-thread', status: 'idle' }, messages: recoveredTurnFixture ? [{ id: 'recovered-interruption', threadId: 'workbench-thread', turnId: recoveredTurnFixture, role: 'error', title: '本轮已中断', text: '任务已中断，已保存的内容保留。' }] : [], settledTurnIds: recoveredTurnFixture ? [recoveredTurnFixture] : [], historyReady: true };
        if (pathname === '/canvas/projects/retry/production' && failRead) { failRead = false; return route.fulfill({ status: 503, json: { error: 'temporary fixture failure' }, headers: { 'access-control-allow-origin': '*' } }); }
        if (pathname.endsWith('/text-suggestions')) data.suggestions = [];
        else if (pathname === '/canvas/projects' && method === 'GET') data.projects = projects;
        else if (pathname === '/canvas/projects' && method === 'POST') {
            const input = request.postDataJSON(); let project = projects.find(p => p.id === input.id);
            if (!project) { project = input; projects.push(project); creationCount++; }
            if (loseCreationResponse) { loseCreationResponse = false; return route.abort(); }
            data = { ok: true, project, created: true };
        } else if (pathname.endsWith('/production-context')) {
            const id = decodeURIComponent(pathname.split('/')[3]);
            data.context = id === 'linked' ? { role: 'episode', canvasId: id, episodeId: 'ep', dramaId: 'drama', owner: { kind: 'episode', id: 'ep' } } : { role: 'standalone', canvasId: id, owner: { kind: 'canvas', id } };
        } else if (pathname.endsWith('/canvas/ensure')) data = { ok: true, project: projects[1], context: { role: 'episode', canvasId: 'linked', episodeId: 'ep', owner: { kind: 'episode', id: 'ep' } } };
        else if (pathname.endsWith('/shared-assets')) data = { ok: true, assets: [], versions: [], updates: [] };
        else if (pathname.includes('/drama/projects/') && pathname.endsWith('/episodes')) data = { ok: true, episodes: [episode] };
        else if (/\/production/.test(pathname)) {
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
    const verifyRuntimeSync = async () => {
        await page.goto(`http://127.0.0.1:${testPort}/tests/director-navigation.html?start=%2Fcanvas%2Fstandalone`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
        await page.evaluate(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.setState({ enabled: true, connected: false, url: 'http://127.0.0.1:17370/agent', token: 'fixture' }));
        await page.waitForFunction(async () => Boolean(window.__directorTestEventSource) && (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().connected);
    recoveredTurnFixture = 'lost-completion';
    await page.evaluate(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        useAgentStore.setState({ activeThreadId: 'workbench-thread', activeTurnId: 'lost-completion', waiting: true, sending: false, connected: true });
        window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(async () => { const state = (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState(); return !state.waiting && !state.activeTurnId && state.messages.some(item => item.title === '本轮已中断'); });
    recoveredTurnFixture = '';
    await page.evaluate(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        useAgentStore.setState({ activeThreadId: 'workbench-thread', activeTurnId: 'still-running', waiting: true, sending: false });
    });
    const liveHistory = page.waitForResponse(response => new URL(response.url()).pathname === '/agent/codex/threads/workbench-thread');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await liveHistory;
    assert.equal(await page.evaluate(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting), true, 'history without the active turn must not clear a real running turn');
    await page.evaluate(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.setState({ activeTurnId: '', waiting: false }));
    const runtime = await page.evaluate(async () => {
        const state = (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState();
        return { instanceId: 'runtime-fixture', revision: 10, heartbeatIntervalMs: 15000, conversation: { ...state.conversation, threadId: 'workbench-thread', status: 'running', revision: state.conversation.revision + 1 }, codex: { busy: true, threadId: 'workbench-thread', turnId: 'heartbeat-turn' }, pendingApprovals: [] };
    });
    const pushRuntime = async (type, snapshot) => page.evaluate(({ type, snapshot }) => window.__directorTestEventSource.dispatchEvent({ type, data: JSON.stringify(type === 'ping' ? { time: Date.now(), runtime: snapshot } : snapshot) }), { type, snapshot });
    await pushRuntime('runtime_state', runtime);
    await page.waitForFunction(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().activeTurnId === 'heartbeat-turn');
    recoveredTurnFixture = 'heartbeat-turn';
    const terminal = { ...runtime, revision: 11, conversation: { ...runtime.conversation, revision: runtime.conversation.revision + 1, status: 'ready' }, codex: { ...runtime.codex, busy: false } };
    await pushRuntime('ping', terminal); // Simulate a lost one-off completion event with the page continuously visible.
    await page.waitForFunction(async () => !(await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting);
    const next = { ...runtime, revision: 12, conversation: { ...runtime.conversation, revision: terminal.conversation.revision + 1 }, codex: { ...runtime.codex, turnId: 'next-turn' } };
    await pushRuntime('runtime_state', next);
    await page.waitForFunction(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().activeTurnId === 'next-turn');
    await pushRuntime('runtime_state', { ...terminal, revision: 13 });
    await pushRuntime('codex_state', terminal.codex);
    assert.equal(await page.evaluate(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().activeTurnId), 'next-turn', 'late old terminal events cannot stop the new turn');
    recoveredTurnFixture = 'next-turn';
    runtimeStateFixture = { ...terminal, revision: 13, conversation: { ...terminal.conversation, revision: next.conversation.revision + 1 }, codex: { ...next.codex, busy: false } };
    const reconciled = page.waitForResponse(response => new URL(response.url()).pathname === '/agent/codex/state');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await reconciled;
    await page.waitForFunction(async () => !(await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting);
    const disconnectedStream = { ...next, revision: 14, conversation: { ...next.conversation, revision: runtimeStateFixture.conversation.revision + 1 }, codex: { ...next.codex, turnId: 'http-only-turn' } };
    await pushRuntime('runtime_state', disconnectedStream);
    await page.waitForFunction(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().activeTurnId === 'http-only-turn');
    recoveredTurnFixture = 'http-only-turn';
    runtimeStateFixture = { ...disconnectedStream, revision: 15, conversation: { ...disconnectedStream.conversation, revision: disconnectedStream.conversation.revision + 1, status: 'ready' }, codex: { ...disconnectedStream.codex, busy: false } };
    await page.waitForFunction(async () => !(await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting, undefined, { timeout: 20000 }); // No focus or stream event: the advertised cadence must reconcile it.
    const unverified = { ...disconnectedStream, revision: 16, conversation: { ...disconnectedStream.conversation, revision: runtimeStateFixture.conversation.revision + 1 }, codex: { ...disconnectedStream.codex, turnId: 'unverified-turn' } };
    await pushRuntime('runtime_state', unverified);
    await page.waitForFunction(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().activeTurnId === 'unverified-turn');
    runtimeStateUnavailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(async () => Boolean((await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().connectError));
    assert.equal(await page.evaluate(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting), true, 'a failed state check cannot fabricate completion');
    runtimeStateUnavailable = false;
    recoveredTurnFixture = 'unverified-turn';
    runtimeStateFixture = { ...unverified, revision: 17, conversation: { ...unverified.conversation, revision: unverified.conversation.revision + 1, status: 'ready' }, codex: { ...unverified.codex, busy: false } };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(async () => !(await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting);
    const beforeRestart = { ...unverified, revision: 18, conversation: { ...unverified.conversation, revision: runtimeStateFixture.conversation.revision + 1 }, codex: { ...unverified.codex, turnId: 'before-restart' } };
    await pushRuntime('runtime_state', beforeRestart);
    await page.waitForFunction(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().activeTurnId === 'before-restart');
    runtimeStateFixture = { ...beforeRestart, instanceId: 'restarted-runtime', revision: 1, conversation: { ...beforeRestart.conversation, revision: 1, status: 'ready' }, codex: { ...beforeRestart.codex, busy: false, turnId: '' } };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(async () => !(await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting);
    await pushRuntime('runtime_state', { ...beforeRestart, revision: 999 });
    assert.equal(await page.evaluate(async () => (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState().waiting), false, 'old process snapshots cannot resurrect a turn after restart');
    };
    if (process.argv.includes('--runtime-state')) {
        await verifyRuntimeSync(); assert.deepEqual(errors, []);
        console.log(JSON.stringify({ passed: true, scope: 'authoritative runtime snapshot, lost completion, stale old turn, heartbeat and active HTTP reconciliation, failed checks preserve running state; no model requests' }));
    } else {
    await page.goto(`http://127.0.0.1:${testPort}/tests/director-navigation.html?start=%2Fproduction`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('heading', { name: '制作工作室', exact: true }).waitFor();
    assert.ok(await page.getByRole('link', { name: '制作', exact: true }).count());
    assert.equal(await page.locator('[data-testid="production-home"] textarea').count(), 0);
    assert.equal(turnRequests.length, 0);
    await page.getByRole('button', { name: '今天想创作什么？', exact: true }).click();
    await page.getByRole('heading', { name: '今天想创作什么？', exact: true }).waitFor();
    await page.getByRole('button', { name: '从一句故事开始', exact: true }).click();
    assert.equal(turnRequests.length, 0, 'selecting a creative example only fills the draft');
    await page.getByRole('textbox', { name: '创意描述', exact: true }).fill('保留的创意草稿');
    await page.getByRole('button', { name: '收起 Agent 面板', exact: true }).click();
    await page.locator('#canvas-director-dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '与导演对话', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '创意描述', exact: true }).inputValue(), '保留的创意草稿');
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
    assert.equal(creativeRequest.postDataJSON().skill.name, 'acheng-director');
    assert.match(creativeRequest.postDataJSON().skill.path, /\.agents\/skills\/acheng-director\/SKILL\.md$/);
    assert.match(creativePrompt, /雨夜机械师/);
    assert.match(creativePrompt, /制作中心创意入口/);
    assert.match(creativePrompt, /\$acheng-director/);
    assert.match(creativePrompt, /制作语言默认简体中文/);
    assert.match(creativePrompt, /display_summary/);
    assert.match(creativePrompt, /视频制作启动时的必确认项/);
    assert.match(creativePrompt, /videoAspectRatioConfirmed=true/);
    assert.match(creativePrompt, /set_settings/);
    assert.match(creativePrompt, /纯独立资产包且不交付视频时不问视频画幅/);
    assert.match(creativePrompt, /canvas-video-production-sop/);
    assert.match(creativePrompt, /workflow\.currentWork/);
    assert.match(creativePrompt, /site_navigate\(\{production:/);
    assert.match(creativePrompt, /凭聊天内容自行拼路由/);
    assert.match(creativePrompt, /具体制作默认进入固定画布/);
    assert.equal(turnRequests.length, 1, 'one creative-entry submission connects Agent and dispatches the prompt');
    await page.waitForFunction(async () => {
        const { useAgentStore } = await import('/src/stores/use-agent-store.ts');
        return useAgentStore.getState().connected && !useAgentStore.getState().creativeLaunch;
    });
    assert.equal(await page.locator('[data-director-creative-entry] textarea').inputValue(), '');
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
    assert.equal(await page.getByRole('heading', { name: '今天想创作什么？', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'test production hub', exact: true }).click();
    await page.getByRole('heading', { name: '制作工作室', exact: true }).waitFor();
    assert.equal(await page.locator('[data-testid="production-home"] textarea').count(), 0);
    assert.equal(await page.getByRole('tab', { name: '独立制作', exact: true }).count(), 0);
    await page.getByRole('heading', { name: '全部剧目', exact: true }).waitFor();
    await page.getByRole('button', { name: 'test old drama route', exact: true }).click();
    await page.getByRole('heading', { name: '全部剧目', exact: true }).waitFor();
    await page.getByRole('button', { name: 'test legacy projects', exact: true }).click();
    await page.getByRole('heading', { name: '继续制作', exact: true }).waitFor();
    const artifacts = path.join(cache, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
    await page.getByRole('link').filter({ hasText: '独立角色制作' }).click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    const openEditor = async (workspace = 'overview') => {
        if (await page.locator('[data-production-tasks-panel]').isVisible()) await page.locator('[data-production-tasks-panel]').getByRole('button', { name: /^(高级与历史|Advanced and history)$/ }).click();
        const label = await page.evaluate(async key => (await import('/src/i18n')).default.t(`director.workspace.tab.${key}`), workspace);
        const open = await page.evaluate(async () => { const agent = (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState(); return agent.panelOpen && (await import('/src/stores/use-production-workspace-store.ts')).useProductionWorkspaceStore.getState().panelTab === 'object'; });
        const script = await page.locator('[data-production-scene-editor]').isVisible();
        if (open && script) await page.locator('.ant-modal-wrap:not(.ant-modal-hidden) .ant-modal-close').click();
        if (!open || script) await page.getByRole('button', { name: /^(高级与历史|Advanced and history)$/ }).click();
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.waitForFunction(({ label, workspace }) => Array.from(document.querySelectorAll('nav button')).some(button => button.getAttribute('aria-label') === label && button.getAttribute('aria-current') === 'page') || workspace === 'production' && Boolean(document.querySelector('[data-production-tasks-panel]')?.getClientRects().length), { label, workspace });
    };
    const closeEditor = async () => {
        const close = page.locator('.ant-modal-wrap:not(.ant-modal-hidden) .ant-modal-close');
        if (await close.isVisible()) await close.click();
    };
    await openEditor();
    const workspaceNavigation = page.getByRole('navigation', { name: '制作工作区', exact: true });
    await workspaceNavigation.waitFor();
    assert.equal(await page.getByRole('button', { name: '概览', exact: true }).getAttribute('aria-current'), 'page');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the workspace layout fits a narrow screen');
    assert.equal(await workspaceNavigation.isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 960 });
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
    await page.waitForFunction(() => document.querySelector('output[aria-label="production revision"]')?.textContent === '1');
    await openEditor();
    await page.getByRole('region', { name: '现在需要你处理', exact: true }).waitFor();
    assert.equal(await workspaceNavigation.getByRole('button', { name: '剧本', exact: true }).count(), 1, 'workspace navigation remains unambiguous');
    assert.equal(await page.getByLabel('agent draft').textContent(), '保留的聊天草稿');
    assert.deepEqual(JSON.parse(await page.getByLabel('agent preservation').textContent()), { prompt: '保留的聊天草稿', attachmentCount: 1, referenceCount: 1 });
    await page.locator('summary').filter({ hasText: '创作说明' }).click();
    await brief.fill('第二段需求写回 Backend，但不得覆盖聊天草稿');
    await page.getByRole('button', { name: '推进当前工作', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="production revision"]')?.textContent === '2');
    await openEditor();
    assert.equal(await page.getByLabel('agent draft').textContent(), '保留的聊天草稿');
    assert.deepEqual(JSON.parse(await page.getByLabel('agent preservation').textContent()), { prompt: '保留的聊天草稿', attachmentCount: 1, referenceCount: 1 });
    assert.equal(turnRequests.length, 1, "only the single automatic creative-entry request was dispatched; an offline scoped request must stop without retry");
    const standaloneProduction = records.get('canvas:standalone') || records.get('standalone');
    assert.match(String(standaloneProduction?.draft.director?.source.brief), /第二段需求写回 Backend/);
    await page.getByRole('button', { name: '生成与交付', exact: true }).click();
    await page.locator('[data-production-tasks-panel]').waitFor({ state: 'visible' });
    await page.locator('[data-production-tasks-panel]').getByRole('button', { name: '高级与历史', exact: true }).click();
    await page.getByText('制作设置、校验与发布', { exact: true }).click();
    await page.getByRole('button', { name: '生成此 Segment', exact: true }).click();
    await page.getByText(/生产启动尚未取得回执/).waitFor();
    await page.waitForTimeout(250);
    const lostRunId = runStarts[0].runId;
    await page.reload();
    await page.getByRole('heading', { name: '全部剧目', exact: true }).waitFor();
    await page.getByRole('button', { name: 'test legacy projects', exact: true }).click();
    await page.getByRole('heading', { name: '继续制作', exact: true }).waitFor();
    await page.getByRole('link').filter({ hasText: '独立角色制作' }).click();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    await openEditor('production');
    await page.getByText(lostRunId, { exact: false }).first().waitFor();
    await page.getByRole('button', { name: '用原请求取回执', exact: true }).click();
    await page.locator('[data-production-dialog]').waitFor({ state: 'hidden' });
    await openEditor('production');
    await page.getByText('排队中', { exact: true }).waitFor();
    assert.equal(runStarts.length, 1, 'recovery reads the original runId and does not create another production batch');
    assert.equal(runRecords.size, 1);
    await page.locator('[data-production-tasks-panel]').getByRole('button', { name: '高级与历史', exact: true }).click();
    await page.getByText('制作设置、校验与发布', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '生成此 Segment', exact: true }).isDisabled(), true);
    await closeEditor();
    await page.getByRole('button', { name: 'test retry', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '本场剧本', exact: true }).count(), 0); await page.getByRole('button', { name: '高级与历史', exact: true }).click();
    await page.getByText('暂时无法读取制作数据', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^刷\s*新$/ }).click();
    await page.getByRole('heading', { name: '重试画布', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    await closeEditor();
    await page.getByRole('button', { name: 'test episode', exact: true }).click();
    await page.getByRole('heading', { name: '第一集', exact: true }).waitFor();
    await openEditor();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    assert.equal(await page.getByPlaceholder('描述故事、角色、场景或想继续完成的内容。已有素材可以在画布或右侧对话中添加。').inputValue(), '');
    await page.getByPlaceholder('描述故事、角色、场景或想继续完成的内容。已有素材可以在画布或右侧对话中添加。').fill('单集草稿保持一致');
    await closeEditor();
    await page.getByRole('button', { name: 'test linked canvas', exact: true }).click();
    await page.getByRole('heading', { name: '第一集', exact: true }).waitFor();
    await openEditor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(input => input.getClientRects().length && input.value === '单集草稿保持一致'));
    await closeEditor();
    await page.getByRole('button', { name: 'test canvas', exact: true }).click();
    await openEditor();
    await page.getByRole('heading', { name: '独立角色制作', exact: true }).waitFor();
    await closeEditor();
    await page.getByRole('button', { name: 'test legacy projects', exact: true }).click();
    await page.getByRole('button', { name: '新建空白项目', exact: true }).click();
    await page.getByRole('textbox', { name: '制作名称', exact: true }).fill('新短片');
    await page.locator('.ant-modal-footer button.ant-btn-primary').click();
    await page.getByText(/无法连接 Backend.*POST/).first().waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.ant-modal-footer button')).some(button => button.textContent?.includes('创建并进入') && !button.disabled && !button.classList.contains('ant-btn-loading')));
    await page.locator('.ant-modal-footer button.ant-btn-primary').click();
    await page.getByRole('heading', { name: '新短片', exact: true }).waitFor(); assert.equal(creationCount, 1);
    assert.equal(requests.some(r => /generate|h3-run|chat\/send/.test(r.pathname)), false);
    assert.equal(requests.some(r => r.pathname === '/drama/episodes/standalone'), false);
    await page.getByRole('button', { name: 'test language', exact: true }).click();
    await page.getByRole('button', { name: 'Talk with the director', exact: true }).waitFor();
    await page.mouse.move(900, 650);
    await page.waitForFunction(() => document.querySelectorAll('.ant-message-notice').length === 0);
    await page.getByRole('button', { name: 'test production hub', exact: true }).click();
    await page.getByRole('heading', { name: 'Production studio', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Production', exact: true }).click();
    await page.getByRole('heading', { name: 'Production studio', exact: true }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: 'test canvas', exact: true }).click();
    await openEditor();
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
    await page.waitForFunction(async () => Boolean((await import('/src/stores/use-production-follow-store.ts')).useProductionFollowStore.getState().pendingPresentation));
    assert.ok((await page.getByLabel('location').textContent())?.includes('workspace=overview'), 'the open editor defers automatic focus');
    await closeEditor();
    await page.waitForFunction(() => document.querySelector('output[aria-label="location"]')?.textContent?.includes('/canvas/standalone?') && document.querySelector('output[aria-label="location"]')?.textContent?.includes('workspace=assets'));
    assert.equal(await page.locator('output[aria-label="location"]').textContent().then(value => value.includes('workspace=assets')), true);
    await closeEditor();
    await page.getByRole('button', { name: 'test production hub', exact: true }).click();
    await page.getByRole('heading', { name: 'Production studio', exact: true }).waitFor();
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
    await page.waitForFunction(() => document.querySelector('output[aria-label="location"]')?.textContent?.includes('/canvas/standalone?') && document.querySelector('output[aria-label="location"]')?.textContent?.includes('workspace=story'));
    assert.equal(await page.locator('#canvas-director-dialog').isVisible(), false, 'resuming focus does not open the conversation');
    await verifyRuntimeSync();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, creationCount, scope: 'unified production entry and object views, creative entry handoff, legacy routes, independent canvas, episode alias, shared draft, canvas shortcut, new production, Agent disconnected draft protection, runId receipt recovery, active-target duplicate prevention, follow presentation, manual pause and return, mobile navigation, no media generation' }));
    }
} catch (error) { console.error("Agent state:", await page?.evaluate(async () => { const s = (await import('/src/stores/use-agent-store.ts')).useAgentStore.getState(); return { url: s.url, enabled: s.enabled, connected: s.connected, waiting: s.waiting, activeTurnId: s.activeTurnId, conversation: s.conversation, error: s.connectError }; })); console.error("Agent requests:", JSON.stringify(requests.filter(item => /codex/.test(item.pathname)).slice(-20))); console.error("Production requests:", JSON.stringify(requests.filter(item => /production/.test(item.pathname)))); console.error("Rendered page:", await page?.locator("body").innerText()); throw error; } finally { await browser?.close(); await server.close(); if (path.dirname(cache) === os.tmpdir() && path.basename(cache).startsWith('director-entry-')) fs.rmSync(cache, { recursive: true, force: true }); }
