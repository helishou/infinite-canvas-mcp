import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackendDatabase } from '../db.js';
import { createStores } from '../stores/index.js';
import { BackendEventBus } from '../events.js';
import { EpisodeProductionService } from './production.js';
import { EpisodeProductionRunner } from './production-runner.js';
import { NativeProductionGeneration } from './native-generation.js';
import { CanvasH3Runner } from '../canvas/h3-runner.js';
import { CanvasGenerationService as GenerationService } from '../canvas/generation-service.js';
import { captureCanvasInputs, effectiveTargetInput, inputHash } from './canvas-inputs.js';
import { mergeDirectorInput, adoptedDirectorFields } from './input-merge.js';
import { emptyEpisodeProduction } from '@basketikun/canvas-agent/drama/production-contract';
import type { CanvasGenerationService } from '../canvas/generation-service.js';

function fixture(t: test.TestContext, persisted = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-manual-'));
    const file = persisted ? path.join(directory, 'db.sqlite') : ':memory:';
    const db = new BackendDatabase(file), stores = createStores(db), events = new BackendEventBus();
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: 'drama', name: 'Drama', isDrama: true, createdAt: new Date().toISOString() });
    const frameFile = path.join(directory, 'reference.png'); fs.writeFileSync(frameFile, 'reference');
    db.upsertMediaFile({ storageKey: 'ref', filePath: frameFile, mimeType: 'image/png', bytes: 9, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    db.createCanvasProject({ id: 'canvas', nodes: [
        { id: 'reference', type: 'image', metadata: { storageKey: 'ref' } },
        { id: 'image', type: 'image', metadata: { prompt: 'My image prompt', model: 'test-image', comfyParams: { quality: 'high' } } },
        { id: 'h3', type: 'minimax-h3', metadata: { segments: [{ id: 'clip', taskMode: 't2v', prompt: 'My edited dialogue and camera', duration: 5, aspectRatio: '16:9' }] } },
    ], connections: [{ id: 'ref-edge', fromNodeId: 'reference', toNodeId: 'image', order: 0 }] });
    db.upsertDramaEpisode({ id: 'ep', dramaId: 'drama', episodeNumber: 1, title: 'Episode', synopsis: '', canvasId: 'canvas' });
    const data = emptyEpisodeProduction();
    data.settings.imageModel = 'test-image';
    data.director = { schemaVersion: 1, engine: { commit: 'a'.repeat(40), patchVersion: 'test', runtimeId: 'test', version: 'test' },
        source: {}, executionAuthorized: false, sourceHash: 'b'.repeat(64), artifacts: [], modules: {}, unresolved: [], workflow: {}, boundaries: [],
        assets: { A: { nodeId: 'image', version: 'v1', status: 'planned' }, R: { nodeId: 'reference', storageKey: 'ref', version: 'v1', status: 'generated' } }, shotInputs: {} };
    data.clipGroups = [{ id: 'G', nodeId: 'h3', segmentId: 'clip', shotIds: ['S'], sourceVersion: 0 }];
    db.db.prepare("INSERT INTO episode_productions (episode_id,revision,draft_json,published_json,published_version,updated_at) VALUES ('ep',0,?,NULL,0,?)").run(JSON.stringify(data), new Date().toISOString());
    const service = new EpisodeProductionService(db, events, undefined, false, () => {});
    const observer = new NativeProductionGeneration(db, stores, service, new EpisodeProductionService(db, events, undefined, true, () => {}), events);
    const project = () => stores.projects.get('canvas')!;
    return { db, stores, service, observer, data, project, directory, file };
}

test('unpublished edited Clip and image run from current saved input with unapproved references', t => {
    const f = fixture(t);
    const image = f.observer.prepare({ mode: 'image', projectId: 'canvas', nodeId: 'image', prompt: 'stale caller prompt', model: 'stale caller model' });
    assert.equal(image.command.prompt, 'My image prompt');
    assert.equal(image.command.model, 'test-image');
    assert.deepEqual(image.command.references!.map(ref => ref.storageKey), ['ref']);
    assert.equal(image.context?.version, 0);
    assert.equal(image.command.params?.canvasFrozenInput, true);
    const clip = f.observer.prepare({ mode: 'video', operation: 'h3-run', projectId: 'canvas', nodeId: 'h3', segmentId: 'clip' });
    assert.equal(clip.context?.targets[0].targetId, 'G');
    assert.equal(f.stores.tasks.list().length, 0);
    assert.throws(() => f.observer.prepare({ mode: 'image', projectId: 'canvas', nodeId: 'image', expectedCanvasRevision: 999 }), /版本/);
});

test('three-way merge preserves manual prompt and atomic references while updating unrelated fields', () => {
    const baseline = { prompt: inputHash('old'), title: inputHash('old title'), referenceBindings: inputHash(['A']), storyboardShots: inputHash(['S']), duration: inputHash(5) };
    const current = { prompt: 'manual', title: 'old title', referenceBindings: ['B'], storyboardShots: ['M'], duration: 6 };
    const next = { prompt: 'director update', title: 'new title', referenceBindings: ['C'], storyboardShots: ['N'], duration: 7 };
    const groups = [['prompt'], ['title'], ['referenceBindings', 'storyboardShots', 'duration']];
    const merged = mergeDirectorInput(current, next, baseline, groups);
    assert.equal(merged.merged.prompt, 'manual'); assert.equal(merged.merged.title, 'new title');
    assert.deepEqual(merged.merged.referenceBindings, ['B']); assert.equal(merged.merged.duration, 6);
    assert.deepEqual(adoptedDirectorFields(current, { nextValues: next, fieldGroups: groups }, ['duration']).patch, { referenceBindings: ['C'], storyboardShots: ['N'], duration: 7 });
    assert.deepEqual(mergeDirectorInput(next, next, baseline, groups).manualFields, []);
    assert.equal(mergeDirectorInput(current, next, undefined, groups).merged.prompt, 'manual');
});

test('batch snapshot is read-only, defaults to canvas, replays after edits, and resumes the original scope', t => {
    const f = fixture(t), before = JSON.stringify(f.project());
    const request = { runId: 'run', idempotencyKey: 'run', expectedRevision: 0, targets: ['asset:A', 'segment:G'], scope: 'selected' };
    const checked = f.service.preflight('ep', { action: 'generate', request }) as any;
    assert.equal(checked.valid, true, JSON.stringify(checked)); assert.equal(checked.readyTargets.length, 2);
    assert.equal(JSON.stringify(f.project()), before); assert.equal(f.service.listBatches('ep').length, 0);
    const batch = f.service.startBatch('ep', { ...request, expectedPlanHash: checked.planHash });
    assert.equal(batch.executionSnapshot?.targets[0].command.prompt, 'My image prompt');
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_node', id: 'image', metadata: { prompt: 'After batch start' } }]);
    assert.deepEqual(f.service.startBatch('ep', { ...request, expectedPlanHash: checked.planHash }), batch);
    f.service.pauseBatch('ep', batch.runId);
    assert.equal(f.service.resumeBatch('ep', batch.runId).executionSnapshot?.targets[0].command.prompt, 'My image prompt');
    assert.throws(() => f.service.startBatch('ep', { ...request, runId: 'other', idempotencyKey: 'other' }), /占用/);
    assert.throws(() => f.service.startBatch('ep', { ...request, targets: ['asset:R'] }), /idempotencyKey/);
});

test('invalid references block their own target without blocking independent clips or creating media tasks', t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.directory, 'reference.png'));
    const snapshot = f.service.canvasExecution('ep', ['asset:A', 'segment:G']);
    assert.deepEqual(snapshot.targets.map(target => target.id), ['segment:G']);
    assert.equal(snapshot.blockedTargets[0].targetId, 'asset:A');
    assert.equal(f.stores.tasks.list().length, 0);
});

test('frozen H3 planning does not overwrite later canvas edits', t => {
    const f = fixture(t), runner = new CanvasH3Runner(f.stores, new BackendEventBus(), {} as never, {} as never);
    const frozen = structuredClone(f.project());
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { prompt: 'Next generation' } }]);
    t.mock.method(runner as any, 'execute', async () => {});
    const task = runner.startFrozen({ projectId: 'canvas', nodeId: 'h3', segmentId: 'clip' }, 'frozen-h3', frozen, {});
    assert.equal((task.input.runPlan as any).project.nodes.find((node: any) => node.id === 'h3').metadata.segments[0].prompt, 'My edited dialogue and camera');
    assert.equal((f.project().nodes as any[]).find(node => node.id === 'h3').metadata.segments[0].prompt, 'Next generation');
});

test('edited image input keeps prior active media and archives old-input completion', t => {
    const f = fixture(t), hash = inputHash(effectiveTargetInput(f.project(), 'image'));
    const task = f.stores.tasks.create('image-task', 'canvas-image', { projectId: 'canvas', nodeId: 'image', params: { writeBackToTarget: true, canvasInputHash: hash } }, {});
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_node', id: 'image', metadata: { prompt: 'New input', storageKey: 'ref', runtimeTaskId: task.id } }], { runtimeWrite: true });
    f.db.writeBackCanvasImageTask(task, { projectId: 'canvas', nodeId: 'image', prompt: 'My image prompt', model: 'test-image' }, [{ storageKey: 'old-result', url: '/old-result' }]);
    const node = (f.project().nodes as any[]).find(node => node.id === 'image');
    assert.equal(node.metadata.prompt, 'New input'); assert.equal(node.metadata.storageKey, 'ref');
    assert.equal(node.metadata.generatedImageHistory[0].storageKey, 'old-result'); assert.equal(node.metadata.inputOutdated, true);
});

test('batch executes saved inputs, continues an independent target after failure, and records exact tasks', async t => {
    const f = fixture(t), calls: any[] = [];
    const videoPath = path.join(f.directory, 'mock.mp4'); fs.writeFileSync(videoPath, 'mock-video');
    f.db.upsertMediaFile({ storageKey: 'mock-video', filePath: videoPath, mimeType: 'video/mp4', bytes: 10, width: 8, height: 8, durationMs: 5000, createdAt: new Date().toISOString() });
    const generation = { start: async (command: any) => {
        calls.push(command);
        const task = f.stores.tasks.create(command.idempotencyKey, command.operation === 'h3-run' ? 'canvas-h3-run' : 'canvas-image', command, {});
        f.stores.tasks.update(task.id, { status: command.mode === 'image' ? 'failed' : 'succeeded', error: command.mode === 'image' ? 'mock failure' : null, result: { media: command.mode === 'image' ? [] : [{ storageKey: 'mock-video' }] } });
        return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    f.service.startBatch('ep', { runId: 'run', idempotencyKey: 'run', expectedRevision: 0, targets: ['asset:A', 'segment:G'] });
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_node', id: 'image', metadata: { prompt: 'Changed after start' } }]);
    await new EpisodeProductionRunner(f.service, f.stores, generation).runBatch('ep', 'run');
    assert.equal(calls.length, 2); assert.equal(calls[0].prompt, 'My image prompt');
    const batch = f.service.getBatch('ep', 'run')!;
    assert.equal(batch.status, 'failed'); assert.equal(batch.submitted[1].status, 'succeeded', batch.error || ''); assert.deepEqual(batch.submitted.map(item => item.status), ['failed', 'succeeded']);
});

test('migration adds nullable frozen snapshots, backs up persisted databases, and preserves old batches', t => {
    const f = fixture(t, true);
    assert.equal(f.db.db.prepare('SELECT MAX(version) as version FROM schema_migrations').get()!.version, 33);
    for (const table of ['episode_production_batches', 'canvas_production_batches', 'scene_production_batches']) {
        assert.ok(f.db.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === 'execution_snapshot_json'));
    }
    const legacy = f.db.db.prepare("INSERT INTO episode_production_batches (run_id,episode_id,idempotency_key,request_hash,version,source_revision,status,targets_json,plan_json,settings_json,submitted_json,created_at,updated_at) VALUES ('old','ep','old','old',1,0,'paused','[]','{}','{}','[]','now','now')"); legacy.run();
    assert.equal(f.service.getBatch('ep', 'old')?.executionSnapshot, null);
    f.db.db.exec('DELETE FROM schema_migrations WHERE version=33');
    const reopened = new BackendDatabase(f.file); reopened.close();
    assert.ok(fs.readdirSync(f.directory).some(name => name.includes('pre-schema-v32-to-v33')));
});

test('field adoption is read-only in preflight and applies only selected director fields', t => {
    const f = fixture(t);
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: {
        styleTemplateId: 'soft-light', productionClipProjection: { targetId: 'G', nextValues: { prompt: 'Director revision', styleTemplateId: 'modern-korean' }, fieldGroups: [['prompt'], ['styleTemplateId']] },
    } }], { runtimeWrite: true });
    const revision = Number(f.project().revision);
    const request = { operationId: 'adopt', expectedRevision: 0, ops: [{ type: 'adopt_director_fields', targetId: 'G', nodeId: 'h3', segmentId: 'clip', fields: ['prompt'], canvasRevision: revision }] };
    assert.equal(f.service.preflight('ep', { action: 'edit', request }).valid, true);
    assert.equal(f.project().revision, revision);
    f.service.edit('ep', request);
    const segment = (f.project().nodes as any[]).find(node => node.id === 'h3').metadata.segments[0];
    assert.equal(segment.prompt, 'Director revision'); assert.equal(segment.styleTemplateId, 'soft-light');
    assert.equal(f.service.edit('ep', request).replayed, true);
});

test('missing selected references bind once to exact upstream task media without optional review', async t => {
    const f = fixture(t);
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_node', id: 'reference', metadata: { prompt: 'Upstream saved input', model: 'test-image' }, metadataDelete: ['storageKey'] }]);
    const calls: any[] = [];
    const generation = { start: async (command: any) => {
        calls.push(command);
        const task = f.stores.tasks.create(command.idempotencyKey, 'canvas-image', command, {});
        const output = { storageKey: 'ref', url: '/ref' };
        f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_node', id: command.nodeId, metadata: { storageKey: 'ref' } }], { runtimeWrite: true });
        f.stores.tasks.update(task.id, { status: 'succeeded', result: { media: [output] } });
        return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const batch = f.service.startBatch('ep', { runId: 'dependency', idempotencyKey: 'dependency', expectedRevision: 0, targets: ['asset:A', 'asset:R'] });
    assert.equal(batch.executionSnapshot!.targets[0].dependencies[0].targetId, 'asset:R');
    await new EpisodeProductionRunner(f.service, f.stores, generation).runBatch('ep', batch.runId);
    const finished = f.service.getBatch('ep', batch.runId)!;
    assert.equal(finished.status, 'succeeded', finished.error || '');
    assert.deepEqual(calls.map(command => command.nodeId), ['reference', 'image']);
    assert.deepEqual(calls[1].references.map((ref: any) => ref.storageKey), ['ref']);
    const dependency = finished.executionSnapshot!.targets[0].dependencies[0];
    assert.equal(dependency.taskId, finished.submitted.find(item => item.id === 'asset:R')!.taskId);
    assert.throws(() => f.service.resolveCanvasDependency('ep', batch.runId, 'asset:A', 'reference', 'other-task', 'ref'), /无效/);
    assert.equal(f.service.get('ep').draft.director!.assets.R.status, 'generated');
});

test('editing a completed Clip marks its existing media as old input without replacing it', t => {
    const f = fixture(t);
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { resultStorageKey: 'old-video' } }], { runtimeWrite: true });
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { prompt: 'My next version' } }]);
    const segment = (f.project().nodes as any[]).find(node => node.id === 'h3').metadata.segments[0];
    assert.equal(segment.inputOutdated, true); assert.equal(segment.resultStorageKey, 'old-video');
});


test('manual model, sampler and explicit null style override defaults without changing other parameters', t => {
    const f = fixture(t);
    f.stores.settings.set('plugin:minimax-h3:defaults:v1', { modelName: 'default-model', sampler: 'er_sde', styleTemplateId: 'soft-light', megapixels: 0.6 });
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { h3ParameterPolicy: 'defaults' } }]);
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { modelName: 'my-model', sampler: 'euler', styleTemplateId: null } }]);
    const snapshot = f.service.canvasExecution('ep', ['segment:G']);
    const params = snapshot.targets[0].command.params!;
    assert.equal(params.modelName, 'my-model'); assert.equal(params.sampler, 'euler'); assert.equal(params.styleTemplateId, null); assert.equal(params.megapixels, 0.6);
});


test('explicit review policy waits for media approval and resumes without a second submission', async t => {
    const f = fixture(t);
    f.data.settings.reviewPolicy = { mode: 'manual', shared: 'manual', scene: 'manual' };
    f.db.db.prepare("UPDATE episode_productions SET draft_json=? WHERE episode_id='ep'").run(JSON.stringify(f.data));
    let calls = 0;
    const generation = { start: async (command: any) => {
        calls++;
        const task = f.stores.tasks.create(command.idempotencyKey, 'canvas-image', command, {});
        f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_node', id: 'image', metadata: { storageKey: 'ref' } }], { runtimeWrite: true });
        f.stores.tasks.update(task.id, { status: 'succeeded', result: { media: [{ storageKey: 'ref' }] } });
        return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    f.service.startBatch('ep', { runId: 'review', idempotencyKey: 'review', expectedRevision: 0, targets: ['asset:A'] });
    const runner = new EpisodeProductionRunner(f.service, f.stores, generation);
    await runner.runBatch('ep', 'review');
    assert.equal(f.service.getBatch('ep', 'review')!.status, 'awaiting_review');
    const current = f.service.get('ep'), asset = current.draft.director!.assets.A;
    f.service.edit('ep', { operationId: 'approve', expectedRevision: current.revision, ops: [{ type: 'review_director_asset', assetId: 'A', version: 0, sourceHash: current.draft.director!.sourceHash, nodeId: 'image', storageKey: 'ref', sha256: asset.sha256!, verdict: 'approved', evidence: 'Reviewed this exact output' }] });
    f.service.resumeBatch('ep', 'review'); await runner.runBatch('ep', 'review');
    assert.equal(f.service.getBatch('ep', 'review')!.status, 'succeeded'); assert.equal(calls, 1);
});


test('H3 preflight ignores Backend provenance, task progress and unrelated changes, but detects real input changes', t => {
    const f = fixture(t), runner = new CanvasH3Runner(f.stores, new BackendEventBus(), {} as never, {} as never);
    const input = { projectId: 'canvas', nodeId: 'h3', segmentId: 'clip', params: { sampler: 'euler' } };
    const before = runner.preview(input);
    assert.equal(runner.preview({ ...input, params: { ...input.params, canvasInputHash: 'internal', canvasCallerHash: 'internal', canvasInputDefaults: {}, canvasProductionTarget: { owner: 'internal' } } }).planHash, before.planHash);
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { status: 'loading', progress: 0.3 } }, { type: 'update_node', id: 'image', metadata: { prompt: 'Unrelated image edit' } }], { runtimeWrite: true });
    assert.equal(runner.preview(input).planHash, before.planHash);
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { prompt: 'Changed actual prose' } }]);
    assert.notEqual(runner.preview(input).planHash, before.planHash);
});

test('the actual native H3 generation entry accepts the preview hash after adding task provenance', async t => {
    const f = fixture(t), runner = new CanvasH3Runner(f.stores, new BackendEventBus(), {} as never, {} as never);
    t.mock.method(runner as any, 'execute', async () => {});
    const service = new GenerationService({} as never, runner, f.stores, new BackendEventBus(), {} as never, {} as never);
    service.observeProduction(f.observer);
    const input = { mode: 'video' as const, operation: 'h3-run' as const, projectId: 'canvas', nodeId: 'h3', segmentId: 'clip', params: { sampler: 'euler' } };
    const preview = service.previewH3(input);
    assert.equal(preview.ready, true);
    const request = { ...input, expectedPlanHash: preview.planHash, idempotencyKey: 'native-preview-replay' };
    const task = await service.start(request);
    assert.equal(task.taskId, 'native-preview-replay');
    assert.ok(task.task);
    assert.equal((task.task.input.params as any).canvasCallerHash.length, 64);
    f.stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'clip', patch: { prompt: 'After submission' } }]);
    assert.equal((await service.start(request)).taskId, task.taskId);
    assert.equal(f.stores.tasks.list().filter(task => task.kind === 'canvas-h3-run').length, 1);
});


test('restoring an image prompt to the director baseline clears current conflict without rewriting it', t => {
    const { db, service } = fixture(t);
    const baseline = 'Compiled style mother';
    db.applyCanvasProjectOperations('canvas', undefined, [{ type: 'update_node', id: 'image', metadata: { prompt: 'A real manual edit', productionImageProjection: { fieldHashes: { prompt: inputHash(baseline) }, nextValues: { prompt: baseline }, conflicts: ['prompt'], manualFields: ['prompt'] } } }], { runtimeWrite: true });
    assert.deepEqual(service.canvasEditorialState('ep', ['A'])[0].directorChanges, ['prompt']);
    db.applyCanvasProjectOperations('canvas', undefined, [{ type: 'update_node', id: 'image', metadata: { prompt: baseline } }], { operationId: 'restore-prompt' });
    const before = db.getCanvasProject('canvas')!.revision;
    assert.deepEqual(service.canvasEditorialState('ep', ['A'])[0].directorChanges, []);
    assert.deepEqual(service.canvasEditorialState('ep', ['A'])[0].manualFields, []);
    assert.equal(db.getCanvasProject('canvas')!.revision, before);
});
