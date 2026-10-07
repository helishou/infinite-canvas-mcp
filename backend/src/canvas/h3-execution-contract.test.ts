import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendDatabase } from '../db.js';
import { createStores } from '../stores/index.js';
import { BackendEventBus } from '../events.js';
import { CanvasH3Runner } from './h3-runner.js';
import { resolveH3Runtime, estimateH3Dimensions, h3StoryboardIssues } from './h3-params.js';
import { assertH3WorkflowContract, compareH3MediaSpecification } from './h3-execution-contract.js';
import { resolveNanFengWorkflowParams } from '../comfyui/bridge.js';

function fixture(t: test.TestContext, manualClip: Record<string, unknown> = {}) {
    const db = new BackendDatabase(':memory:');
    t.after(() => db.close());
    const stores = createStores(db);
    stores.projects.create({ id: 'p', nodes: [{ id: 'n', type: 'minimax-h3', metadata: { sampler: 'res_multistep', segments: [{ id: 'a', mode: 't2v', prompt: '完整对白和动作', aspectRatio: '9:16', h3ParameterPolicy: 'defaults', ...manualClip }, { id: 'b', mode: 't2v', prompt: '下一段', aspectRatio: '9:16', h3ParameterPolicy: 'defaults' }] } }], connections: [] });
    stores.settings.set('plugin:minimax-h3:defaults:v1', { sampler: 'er_sde', megapixels: 0.6, loraSlots: [{ name: 'turbo', strength: 0.75, enabled: true }] });
    return { db, stores, runner: new CanvasH3Runner(stores, new BackendEventBus(), {} as never, {} as never) };
}

test('defaults policy ignores stale generation overrides but preserves planned aspect, duration and boundaries', () => {
    const resolved = resolveH3Runtime({ h3ParameterPolicy: 'defaults', aspectRatio: '9:16', duration: 7.5, sampler: 'res_multistep', latentUpscaleEnabled: false, motionContextEnabled: false, styleTemplateId: 'modern-korean' }, {}, { megapixels: 0.4 }, { aspectRatio: '16:9', megapixels: 0.6, sampler: 'er_sde', latentUpscaleEnabled: true, loraSlots: [{ name: 'turbo', enabled: true, strength: 0.75 }], styleTemplateId: 'soft-light' });
    assert.equal(resolved.params.aspectRatio, '9:16');
    assert.equal(resolved.params.duration, 7.5);
    assert.equal(resolved.params.motionContextEnabled, false);
    assert.equal(resolved.params.latentUpscaleEnabled, true);
    assert.equal(resolved.params.sampler, 'er_sde');
    assert.equal(resolved.sources.sampler, 'defaults');
    assert.equal(resolved.params.styleTemplateId, 'modern-korean');
    assert.equal(resolved.sources.styleTemplateId, 'clip');
    const cleared = resolveH3Runtime({ styleTemplateId: null }, {}, {}, { styleTemplateId: 'soft-light' });
    assert.equal(cleared.params.styleTemplateId, null);
    assert.equal(cleared.sources.styleTemplateId, 'clip');
    assert.equal(resolveH3Runtime({ sampler: 'euler' }, {}, {}, { sampler: 'er_sde' }).params.sampler, 'euler');
});

test('preview is read-only; draft revision and defaults changes invalidate its submission identity', t => {
    const { stores, runner } = fixture(t);
    const input = { projectId: 'p', nodeId: 'n', segmentId: 'a', skipCompleted: false };
    const before = JSON.stringify({ project: stores.projects.get('p'), tasks: stores.tasks.list() });
    const preview = runner.preview(input);
    assert.equal(preview.ready, true);
    assert.equal(preview.clips[0].effectiveRuntime.sampler, 'er_sde');
    assert.equal(runner.preview({ ...input, mode: 'video', operation: 'h3-run', idempotencyKey: 'transport-only' } as any).planHash, preview.planHash);
    assert.equal(JSON.stringify({ project: stores.projects.get('p'), tasks: stores.tasks.list() }), before);
    stores.settings.set('plugin:minimax-h3:defaults:v1', { sampler: 'euler', megapixels: 0.6 });
    assert.throws(() => runner.start({ ...input, expectedPlanHash: preview.planHash }), /预检已过期/);
    const next = runner.preview(input);
    stores.projects.applyOperations('p', undefined, [{ type: 'update_h3_segment', nodeId: 'n', segmentId: 'a', patch: { prompt: '另一个窗口编辑' } }]);
    assert.throws(() => runner.start({ ...input, expectedPlanHash: next.planHash }), /预检已过期/);
    assert.equal(stores.tasks.list().length, 0);
});

test('direct canvas preview permits a valid manual aspect differing from episode defaults', t => {
    const { stores, runner } = fixture(t);
    stores.projects.getH3ProductionRequirements = () => ({ ownerId: 'ep', revision: 1, version: 1, videoAspectRatio: '9:16', clips: [] });
    assert.equal(runner.preview({ projectId: 'p', nodeId: 'n', segmentId: 'a', params: { aspectRatio: '16:9' } }).ready, true);
    assert.equal(stores.tasks.list().length, 0);
});

test('an out-of-range enabled LoRA is rejected rather than silently clamped in a production run', t => {
    const { stores, runner } = fixture(t);
    assert.throws(() => runner.start({ projectId: 'p', nodeId: 'n', segmentId: 'a', params: { loraSlots: [{ name: 'turbo', strength: 11, enabled: true }] } }), /拒绝静默夹紧/);
    assert.equal(stores.tasks.list().length, 0);
});

test('manual formal Clip prose generates from the saved input without republishing', t => {
    const { stores, runner } = fixture(t, { directorEngine: 'acheng', directorSourceHash: 'published-source', prompt: '我自己修改的对白、动作与运镜。' });
    const project = stores.projects.get('p')!;
    const segment = (project.nodes as any[])[0].metadata.segments[0];
    stores.projects.getH3ProductionRequirements = () => ({ ownerId: 'ep', revision: 1, version: 1, clips: [{ nodeId: 'n', segmentId: 'a', sourceHash: 'published-source', promptContentHash: 'original-prose-hash', storyboardRequired: true, shots: [{ id: 'published-shot', duration: 5 }], literalDialogues: [{ blockId: 'line', speaker: '张伟', text: '我想重新开始。' }] }] });
    const input = { projectId: 'p', nodeId: 'n', segmentId: 'a' };
    const before = JSON.stringify(project);
    const preview = runner.preview(input);
    assert.equal(preview.ready, true);
    assert.deepEqual(preview.diagnostics, []);
    assert.equal(JSON.stringify(project), before);
    assert.equal(stores.tasks.list().length, 0);
    // Inspect the frozen submission without invoking a media provider.
    t.mock.method(runner as any, 'execute', async () => {});
    const task = runner.start({ ...input, expectedPlanHash: preview.planHash }, 'manual-formal-run');
    const saved = (task.input.runPlan as any).project.nodes[0].metadata.segments[0];
    assert.equal(saved.prompt, segment.prompt);
    assert.equal(saved.directorSourceHash, 'published-source');
    assert.equal(stores.tasks.list().length, 1);
    assert.equal(runner.start({ ...input, expectedPlanHash: preview.planHash }, task.id).id, task.id);
});

test('manual storyboard edits still reject dangling current reference bindings', t => {
    const { stores, runner } = fixture(t);
    stores.projects.applyOperations('p', undefined, [{ type: 'update_h3_segment', nodeId: 'n', segmentId: 'a', patch: { duration: 5, storyboardShots: [{ id: 'manual-shot', referenceBindingId: 'missing-frame', duration: 5 }] } }]);
    assert.ok(runner.preview({ projectId: 'p', nodeId: 'n', segmentId: 'a' }).diagnostics.some(issue => issue.code === 'STORYBOARD_MISMATCH'));
    assert.throws(() => runner.start({ projectId: 'p', nodeId: 'n', segmentId: 'a' }), /storyboard 绑定/);
    assert.equal(stores.tasks.list().length, 0);
});

test('distinct shot IDs may reuse one frame; dangling, reordered and shortened tracks fail', () => {
    const segment = { duration: 5, referenceBindings: [{ id: 'frame', role: 'storyboard', enabled: true }], storyboardShots: [{ id: 'one', referenceBindingId: 'frame', duration: 2 }, { id: 'two', referenceBindingId: 'frame', duration: 3 }] };
    const expected = [{ id: 'one', duration: 2 }, { id: 'two', duration: 3 }];
    assert.deepEqual(h3StoryboardIssues(segment, expected), []);
    assert.ok(h3StoryboardIssues({ ...segment, storyboardShots: segment.storyboardShots.toReversed() }, expected).length);
    assert.ok(h3StoryboardIssues({ ...segment, referenceBindings: [] }, expected).length);
    assert.ok(h3StoryboardIssues({ ...segment, storyboardShots: [segment.storyboardShots[0]] }, expected).length);
});

test('a workflow that changes LoRAs, VAE or orientation is refused before provider submission', () => {
    const expected = { modelName: 'H3/model.safetensors', textEncoder: 'te', videoVae: 'vae', audioVae: 'audio', aspectRatio: '9:16', megapixels: 0.6, sampler: 'er_sde', scheduler: 'simple', latentUpscaleEnabled: false, loraSlots: [{ name: 'turbo', strength: 0.75, enabled: true }] };
    const inputs = { 模型: 'H3\\model.safetensors', 文本编码器: 'te', 视频VAE: 'vae', 音频VAE: 'audio', 画面比例: '9:16 (Portrait)', 百万像素: 0.6, 采样器: 'er_sde', 调度器: 'simple', 启用H3潜空间放大二采: false, 启用LoRA: true, LoRA1: 'turbo', LoRA1强度: 0.75, LoRA1启用: true };
    const graph = (patch: Record<string, unknown>) => ({ native: { class_type: 'NanFengH3MultiReferenceGeneratorV15', inputs: { ...inputs, ...patch } } });
    assert.doesNotThrow(() => assertH3WorkflowContract(graph({}), expected));
    for (const patch of [{ 画面比例: '16:9' }, { 视频VAE: 'other' }, { LoRA1启用: false }]) assert.throws(() => assertH3WorkflowContract(graph(patch), expected), /偏离冻结参数/);
});

test('first-pass and second-pass measured dimensions are checked separately; landscape stays rejected', () => {
    const params = { aspectRatio: '9:16', megapixels: 0.6, latentUpscaleEnabled: true, latentUpscaleMegapixels: 1.2, latentUpscaleAlign: 2 };
    const first = estimateH3Dimensions(params)!;
    const final = estimateH3Dimensions(params, true)!;
    assert.equal(compareH3MediaSpecification(first, { ...params, latentConfirmationPhase: 'first' }).status, 'passed');
    assert.equal(compareH3MediaSpecification(final, params).status, 'passed');
    assert.equal(compareH3MediaSpecification(first, params).status, 'mismatch');
    assert.equal(compareH3MediaSpecification({ width: 864, height: 480 }, params).status, 'mismatch');
});

test('wrong-specification media is preserved in history without replacing the old active result', t => {
    const { db, stores } = fixture(t);
    stores.projects.applyOperations('p', undefined, [{ type: 'update_h3_segment', nodeId: 'n', segmentId: 'a', patch: { result: 'old.mp4', resultStorageKey: 'old', runtimeTaskId: 'child' } }], { runtimeWrite: true });
    const child = stores.tasks.create('child', 'comfyui:minimax-h3', {}, {});
    const failed = stores.tasks.update(child.id, { status: 'failed', result: { media: [{ storageKey: 'wrong', url: '/media/wrong', mimeType: 'video/mp4' }], specification: { status: 'mismatch' } }, error: 'wrong orientation' });
    stores.projects.writeBackH3Task(failed, { projectId: 'p', nodeId: 'n', segmentId: 'a' }, { storageKey: 'wrong', url: '/media/wrong', mimeType: 'video/mp4' });
    const segment = (db.getCanvasProject('p')!.nodes as any[])[0].metadata.segments[0];
    assert.equal(segment.resultStorageKey, 'old');
    assert.ok(segment.results.some((item: any) => item.storageKey === 'wrong'));
});

test('unavailable VAE and enabled LoRA fail capability resolution instead of selecting another or disabling it', async t => {
    const choices = { 模型: [['model']], 文本编码器: [['te']], 视频VAE: [['vae']], 音频VAE: [['audio']], LoRA1: [['turbo']] };
    t.mock.method(globalThis, 'fetch', async (url: unknown) => new Response(JSON.stringify(String(url).includes('UNETLoader') ? { UNETLoader: { input: { required: { unet_name: [['model']] } } } } : { NanFengH3MultiReferenceGeneratorV15: { input: { required: choices } } }), { status: 200 }));
    const params = { h3ExecutionContract: {}, modelName: 'model', textEncoder: 'te', videoVae: 'vae', audioVae: 'audio', loraSlots: [{ name: 'turbo', strength: 0.75, enabled: true }] };
    assert.equal((await resolveNanFengWorkflowParams('http://mock', params, new AbortController().signal)).videoVae, 'vae');
    await assert.rejects(resolveNanFengWorkflowParams('http://mock', { ...params, videoVae: 'missing' }, new AbortController().signal), /所选 视频VAE 不可用/);
    await assert.rejects(resolveNanFengWorkflowParams('http://mock', { ...params, loraSlots: [{ name: 'missing', enabled: true }] }, new AbortController().signal), /LoRA 不可用/);
});

test('a frozen batch keeps its default snapshot after a settings update; a specification failure stops the next Clip', async t => {
    const { stores } = fixture(t);
    const submitted: Record<string, unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const comfy = { async run(_preset: string, input: any, params: any, _url: any, id: string, created: any) {
        const child = stores.tasks.create(id, 'comfyui:minimax-h3', input, params);
        submitted.push(params); created(child);
        await gate;
        return stores.tasks.update(id, { status: 'failed', error: 'wrong orientation', result: { media: [{ url: '/media/wrong', storageKey: 'wrong', mimeType: 'video/mp4' }], specification: { status: 'mismatch' } } });
    } };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, { ready: () => false, queue: { select: () => 'local', unreserve() {} } } as never);
    const parent = runner.start({ projectId: 'p', nodeId: 'n', runFromCurrent: true, skipCompleted: false });
    for (let i = 0; i < 50 && submitted.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    stores.settings.set('plugin:minimax-h3:defaults:v1', { sampler: 'euler' });
    assert.equal(submitted[0].sampler, 'er_sde');
    assert.equal((stores.tasks.get(parent.id)!.input.runPlan as any).defaults.sampler, 'er_sde');
    release();
    for (let i = 0; i < 50 && stores.tasks.get(parent.id)!.status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stores.tasks.get(parent.id)!.status, 'failed');
    assert.equal(stores.tasks.get(parent.id)!.result!.phase, 'specification_mismatch');
    assert.equal(submitted.length, 1);
    assert.equal(stores.tasks.get(parent.id)!.result!.media instanceof Array, true);
});

test("outgoing motion flags form a complete latent chain including the closing Clip without creating tasks", t => {
    const { stores, runner } = fixture(t);
    stores.projects.applyOperations("p", undefined, [
        { type: "update_h3_segment", nodeId: "n", segmentId: "a", patch: { motionContextEnabled: true } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "b", patch: { motionContextEnabled: true } },
        { type: "add_h3_segment", nodeId: "n", segment: { id: "c", prompt: "The bell stops.", motionContextEnabled: false } },
    ]);
    const input = { projectId: "p", nodeId: "n", runFromCurrent: true, skipCompleted: false };
    const before = JSON.stringify(stores.projects.get("p"));
    const plans = (runner as any).plansFor(input);
    assert.deepEqual(plans.map((plan: any) => plan.continuation?.index), [1, 2, 3]);
    assert.equal(new Set(plans.map((plan: any) => plan.continuation?.group)).size, 1);
    assert.equal(stores.tasks.list().length, 0); assert.equal(JSON.stringify(stores.projects.get("p")), before);
});
