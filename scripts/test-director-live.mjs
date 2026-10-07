// Opt-in real channel acceptance. Only fictional source and a public repository image leave the host.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LlmAgent } from '@basketikun/canvas-agent/agent/llm';
import { ProductionAgentPool } from '@basketikun/canvas-agent/agent/production';
import { CodexAppClient } from '../canvas-agent/src/agent/codex-client.ts';
import { compilationHash } from '@basketikun/canvas-agent/drama/compilation-scope';
import { projectProductionRead } from '@basketikun/canvas-agent/drama/production-contract';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireBackend = createRequire(path.join(repo, 'backend/package.json'));
const dependency = async name => import(pathToFileURL(requireBackend.resolve(name)).href);
const { default: express } = await dependency('express');
const { Client } = await dependency('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await dependency('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { BackendDatabase } = await import('../backend/src/db.ts');
const { createStores } = await import('../backend/src/stores/index.ts');
const { BackendEventBus } = await import('../backend/src/events.ts');
const { EpisodeProductionService } = await import('../backend/src/drama/production.ts');
const { DirectorSubagents, registerDirectorSubagentRoutes } = await import('../backend/src/drama/director-subagents.ts');
const { registerBackendMcpHttpRoutes } = await import('../backend/src/mcp.ts');
const { loadConfig } = await import('../backend/src/config.ts');
const live = loadConfig(false);
const response = await fetch(`${live.url}/settings/ai-config`, { headers: { authorization: `Bearer ${live.token}` } });
assert.ok(response.ok, 'Cannot read the configured channel');
const ai = (await response.json()).config;
const resumeRoot = process.env.DIRECTOR_ACCEPTANCE_RESUME_ROOT;
const root = resumeRoot ? path.resolve(resumeRoot) : await fs.mkdtemp(path.join(os.tmpdir(), 'director-live-'));
assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('director-live-'), 'Acceptance storage must be an isolated temporary directory');
const db = new BackendDatabase(path.join(root, 'acceptance.sqlite')), stores = createStores(db), events = new BackendEventBus();
// API credentials remain in memory; they are never written into the acceptance database/report.
const settings = { get: key => key === 'ai.config' ? ai : stores.settings.get(key), set: (key, value) => { assert.notEqual(key, 'ai.config'); stores.settings.set(key, value); } };
const app = express(); app.use(express.json());
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`, config = { url, token: 'fixture', port: 0, origins: [] };
const production = new EpisodeProductionService(db, events, root, true, () => {});
if (!resumeRoot) db.createCanvasProject({ id: 'acceptance', title: 'Fictional two-scene acceptance', nodes: [], connections: [] });
const source = { brief: '人物在书房看到封好的信，第二场放下信看向门外。只深化既定镜头标题，事实与范围固定。',
    script_scenes: [{ id: 'A', scene_id: 'ROOM', text: '人物看见桌上封好的信。' }, { id: 'B', scene_id: 'ROOM', text: '人物放下信，看向门外。' }],
    shots: [{ id: 'SA', source_scene_id: 'A', scene_id: 'ROOM', title: '看信', start_frame: 0, end_frame: 120 }, { id: 'SB', source_scene_id: 'B', scene_id: 'ROOM', title: '看门', start_frame: 120, end_frame: 240 }], segments: [], asset_plan: [], asset_cards: [] };
if (!resumeRoot) production.edit('acceptance', { operationId: 'seed', expectedRevision: 0, ops: [{ type: 'set_director_production', director: { schemaVersion: 1, engine: { commit: 'a'.repeat(40), patchVersion: 'acceptance', runtimeId: 'acceptance', version: 'acceptance' }, source, sourceHash: compilationHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], workflow: { contentDeliveryMode: 'interactive_segment' }, executionAuthorized: false, unresolved: [] } }] });
const worker = new LlmAgent(settings, url, 'fixture');
const providers = worker.providers(), apiModel = providers.find(item => item.id === worker.defaultModel() && item.kind !== 'codex-cli') || providers.find(item => item.kind !== 'codex-cli');
assert.ok(apiModel, 'No configured API channel for the real director loop');
let workerTurns = 0;
const pool = new ProductionAgentPool(undefined, { canRun: request => Boolean(request.model?.includes('::')),
    run: request => worker.structured(request) }, (model, threadId) => worker.nativeWorkerModel(model, threadId));
let nativeParent;
const native = providers.find(item => item.kind === 'codex-cli');
const delegation = new DirectorSubagents(stores, { run: request => { if (!request.recoverOutput) workerTurns++; return pool.run(request); } }, events, repo, (threadId, model) => model || (threadId === nativeParent ? native?.id : apiModel.id), () => production);
app.get('/plugins/mcp', (_req, res) => res.json({ declarations: [] }));
app.post('/mcp/observability/events', (_req, res) => res.json({ ok: true }));
app.get('/tasks', (req, res) => res.json({ ok: true, tasks: String(req.query.taskIds || '').split(',').filter(Boolean).map(id => stores.tasks.get(id)).filter(Boolean) }));
const edits = [];
app.post('/canvas/projects/:id/production/ops', (req, res) => { try { const value = production.edit(req.params.id, req.body); edits.push(req.body); res.json({ ok: true, production: value }); } catch (error) { res.status(400).json({ error: String(error) }); } });
app.get('/canvas/projects/:id/production', (req, res) => res.json({ ok: true, production: projectProductionRead(production.get(req.params.id), req.query) }));
registerDirectorSubagentRoutes(app, delegation);
const routes = registerBackendMcpHttpRoutes(app, config);
const trace = [], report = { fixtureRoot: root, mediaGeneration: false, apiModel: apiModel.name };
let mainClient, nativeDirector;
const previousAcceptanceToken = process.env.DIRECTOR_ACCEPTANCE_TOKEN;
try {
    let tasks;
    if (!resumeRoot) {
    const main = new LlmAgent(settings, url, 'fixture', async () => {
        mainClient = new Client({ name: 'real-director-acceptance', version: '1' });
        await mainClient.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
        const list = mainClient.listTools.bind(mainClient), call = mainClient.callTool.bind(mainClient);
        mainClient.listTools = async (...args) => { const value = await list(...args); return { ...value, tools: value.tools.filter(tool => ['production_get', 'production_edit', 'director_subagent', 'canvas_wait_tasks'].includes(tool.name)) }; };
        mainClient.callTool = async (input, ...args) => { trace.push({ tool: input.name, action: input.arguments?.action }); return call(input, ...args); };
        return mainClient;
    });
    const thread = main.startThread(repo, apiModel.id);
    const prompt = '执行隔离验收，不生成媒体、不发布。正式对象 kind=canvas,id=acceptance，画布 projectId=acceptance，revision=1，交付模式 interactive_segment。' +
        '请通过 director_subagent 派发 role=shots 的独立建议任务，绑定 production 和整份正式稿，使用稳定 operationId。要求子代理先读 skillPaths 的主合同与专业模块。' +
        '给子代理的要求必须包含：首次/游标为空仅完成 SA 的标题建议，返回 partial、cursor=B；游标 B 时给 SA/SB 的完整建议并返回 complete、空未决项。信保持封好，不增加其他事实，每个标题不超过十个汉字。' +
        '用 canvas_wait_tasks 等待精确 taskId，get/view=result 读完整产物。本轮用户明确授权这一次交互续写，请用 continuationIntent=explicit 沿原任务 continue，不另派发。' +
        '完成后核对未决项与当前正式稿，只用 patch_director_source 更新 SA/SB 的 title，通过 production_edit.ops+adoptions 保存，不改变其他字段。回复说明采纳 revision。不得将执行成功声称为视觉审核通过。';
    await main.run(prompt, () => {}, [], { threadId: thread.id, cwd: repo, model: apiModel.id });
    const mainState = main.read(thread.id, repo); assert.equal(mainState.thread.status, 'completed');
    tasks = stores.tasks.list({ kind: 'director-subagent' });
    report.apiDirector = { passed: tasks.length === 1 && Boolean(tasks[0].result?.adoption), toolTrace: [...trace] };
    if (!report.apiDirector.passed) {
        assert.equal(tasks.length, 0, 'Partially executed API work must be audited before another channel is used');
        assert.ok(native, 'No configured Codex director channel');
        report.apiDirector.reason = 'Configured API returned text without executing the declared director tools';
        process.env.DIRECTOR_ACCEPTANCE_TOKEN = 'fixture';
        nativeDirector = await CodexAppClient.start(() => {}, () => {});
        const { thread: nativeThread } = await nativeDirector.request('thread/start', { cwd: repo, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
            model: worker.nativeWorkerModel(native.id), developerInstructions: await fs.readFile(path.join(repo, 'canvas-agent/agent-instructions.md'), 'utf8'),
            config: { mcp_servers: { 'infinite-canvas': { url: url + '/mcp', bearer_token_env_var: 'DIRECTOR_ACCEPTANCE_TOKEN', default_tools_approval_mode: 'approve' } } }, threadSource: 'user' });
        nativeParent = nativeThread.id;
        await nativeDirector.startTurn(nativeParent, prompt + `\n本轮 parentThreadId=${nativeParent}，子代理 model=${native.id}。只操作隔离对象 acceptance，最终严格 JSON {"summary":"验收结果"}。`, [], 'request', worker.nativeWorkerModel(native.id), undefined, undefined, undefined, undefined,
            { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] });
        tasks = stores.tasks.list({ kind: 'director-subagent' });
    }
    } else {
        tasks = stores.tasks.list({ kind: 'director-subagent' });
        report.resumedExistingResults = true;
        report.apiDirector = { passed: false, reason: 'The configured API previously returned text without director tool calls; source work is not rerun' };
    }
    assert.equal(tasks.length, 1);
    const task = tasks[0]; assert.equal(task.status, 'succeeded'); assert.equal(task.result.status, 'complete');
    assert.ok(task.result.artifacts.some(artifact => artifact.output.status === 'partial'));
    assert.ok(task.result.adoption);
    if (!resumeRoot) assert.ok(edits.some(edit => edit.adoptions?.[0].taskId === task.id));
    assert.ok(Object.values(task.result.commands || {}).some(action => action === 'continue:explicit' || action === 'continue'));
    assert.equal(stores.tasks.list().some(item => item.kind !== 'director-subagent'), false);
    report.director = { passed: true, model: providers.find(provider => provider.id === task.model)?.name || task.model, workerTurns: resumeRoot ? task.result.artifacts.length : workerTurns, adoptionRevision: task.result.adoption.revision, continuationReceipts: task.result.commands, toolTrace: trace };

    const image = path.join(repo, '.agents/skills/acheng-director/modules/assets/scene-design/external/assets/case-studies/cloud-song-archive-final.png');
    const schema = { type: 'object', additionalProperties: false, properties: { peopleCount: { type: 'integer' }, outdoorFeature: { type: 'string' }, lighting: { type: 'string' } }, required: ['peopleCount', 'outdoorFeature', 'lighting'] };
    const imageRequest = { cwd: repo, prompt: '只根据传入图片观察：画面可见人物数量、室外主要自然景象、室内灯光色调。不要猜文件名或读取其他文件。严格返回 peopleCount/outdoorFeature/lighting。', schema, images: [image], onThread: () => {} };
    const apiImage = await worker.structured({ ...imageRequest, model: apiModel.id });
    assert.equal(apiImage.output.peopleCount, 2); assert.match(apiImage.output.outdoorFeature, /云|雾|cloud|mist|fog/i);
    report.apiImage = { passed: true, observations: apiImage.output };
    assert.ok(native, 'No configured Codex channel');
    const nativeImage = await pool.run({ ...imageRequest, workId: 'native-image-acceptance', model: native.id });
    assert.equal(nativeImage.output.peopleCount, 2); assert.match(nativeImage.output.outdoorFeature, /云|雾|cloud|mist|fog/i);
    report.codexImage = { passed: true, model: native.name, observations: nativeImage.output };
    let originalRequests = workerTurns;
    const recovered = await pool.run({ workId: 'recover-real-author', cwd: repo, prompt: '', schema: {}, model: task.model, threadId: task.result.workerThreadId, turnId: task.result.workerTurnId, recoverOutput: true, onThread: () => assert.fail('must retain original thread') });
    assert.equal(recovered.output.status, 'complete'); assert.equal(workerTurns, originalRequests);
    report.recovery = { passed: true, originalCompletedTurnOnly: true };
} catch (error) {
    report.error = String(error.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'); process.exitCode = 1;
} finally {
    pool.stop(); nativeDirector?.stopProductionClient();
    if (previousAcceptanceToken === undefined) delete process.env.DIRECTOR_ACCEPTANCE_TOKEN; else process.env.DIRECTOR_ACCEPTANCE_TOKEN = previousAcceptanceToken;
    await mainClient?.close().catch(() => {}); await routes.closeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
    await fs.mkdir(path.join(repo, '.tmp'), { recursive: true }); await fs.writeFile(path.join(repo, '.tmp/director-live-acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
// All owned work, database writes and server shutdowns are awaited above. Close remaining CLI-only network handles.
process.exit(process.exitCode || 0);
