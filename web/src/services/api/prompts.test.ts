import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function fixture(initial?: Record<string, unknown>) {
    let now = 1_800_000_000_000;
    let fails = true;
    let calls = 0;
    let gate: Promise<void> | undefined;
    let writes = 0;
    let persisted: any = initial;
    const source = { id: 'source', name: 'Source', url: 'https://example.org/a', homepage: '', enabled: true };
    const state = { sources: [source], schedule: { intervalMinutes: 30 } };
    const raw = readFileSync(new URL('./prompts.ts', import.meta.url), 'utf8');
    const tree = ts.createSourceFile('prompts.ts', raw, ts.ScriptTarget.Latest, true);
    const body = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n');
    const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: any = {};
    class Clock extends Date { static now() { return now; } }
    const scope = {
        exports, Date: Clock,
        runPromptSource: async () => { calls++; await gate; if (fails) throw new Error('offline'); return [{ title: 'New', prompt: 'new', tags: [] }]; },
        usePromptSourceStore: { getState: () => state },
        useCustomPromptsStore: { getState: () => ({ loaded: true, prompts: [] }) },
        CUSTOM_PROMPTS_CATEGORY: 'Custom', CUSTOM_PROMPTS_SOURCE_ID: 'custom',
        fetchBackendPromptCache: async () => ({ cache: persisted }),
        saveBackendPromptCache: async (_id: string, value: any) => { writes++; persisted = value; },
        i18n: { t: (key: string) => key },
    };
    new Function(...Object.keys(scope), code)(...Object.values(scope));
    return { api: exports, state, source, hold: (value: Promise<void>) => { gate = value; }, advance: (ms: number) => { now += ms; }, recover: () => { fails = false; }, stats: () => ({ calls, writes, persisted }) };
}
const interval = 30 * 60_000;

test('scheduler and list share failure cooldown: 29 minute ticks produce one fetch/write', async () => {
    const f = fixture();
    await f.api.refreshDueSources(interval);
    for (let minute = 1; minute < 30; minute++) {
        f.advance(60_000);
        await f.api.refreshDueSources(interval);
        await f.api.fetchSourcePrompts('source');
    }
    assert.equal(f.stats().calls, 1);
    assert.equal(f.stats().writes, 1);
    f.advance(60_000);
    await f.api.refreshDueSources(interval);
    assert.equal(f.stats().calls, 2);
});

test('recovery succeeds at the next interval and removes the failure cooldown', async () => {
    const f = fixture(); await f.api.refreshDueSources(interval);
    f.recover(); f.advance(interval);
    const result = await f.api.refreshDueSources(interval);
    assert.equal(result.successCount, 1);
    assert.equal(f.stats().persisted.lastError, '');
    assert.equal((await f.api.fetchSourcePrompts('source'))[0].title, 'New');
    assert.equal(f.stats().calls, 2);
});

test('manual single and all refresh bypass failure cooldown immediately', async () => {
    const f = fixture(); await f.api.refreshDueSources(interval);
    await assert.rejects(f.api.refreshSource('source'), /offline/);
    await f.api.refreshAllSources();
    assert.equal(f.stats().calls, 3);
});

test('changed source attempts immediately, then failed new signature is throttled', async () => {
    const f = fixture(); await f.api.refreshDueSources(interval);
    f.source.url = 'https://example.org/b';
    await f.api.fetchSourcePrompts('source');
    await f.api.refreshDueSources(interval);
    assert.equal(f.stats().calls, 2);
    f.source.name = 'Renamed';
    await f.api.refreshDueSources(interval);
    assert.equal(f.stats().calls, 3);
});

test('legacy failed cache preserves existing items and success date while gaining cooldown', async () => {
    const old = { sourceId: 'source', items: [{ title: 'Old', prompt: 'old', tags: [] }], fetchedAt: 1, signature: 'old', lastSuccessAt: '2020-01-01', lastError: 'offline' };
    const f = fixture(old);
    await f.api.refreshDueSources(interval);
    assert.equal((await f.api.fetchSourcePrompts('source'))[0].title, 'Old');
    assert.equal(f.stats().persisted.lastSuccessAt, old.lastSuccessAt);
    assert.equal(f.stats().persisted.fetchedAt, old.fetchedAt);
    assert.equal(f.stats().calls, 1);
});

test('disabled scheduling retains list TTL fallback and explicit refresh availability', async () => {
    const f = fixture(); f.state.schedule.intervalMinutes = 0;
    await assert.rejects(f.api.fetchSourcePrompts('source'));
    f.advance(interval);
    await f.api.fetchSourcePrompts('source');
    assert.equal(f.stats().calls, 1);
    f.recover(); await f.api.refreshSource('source');
    assert.equal(f.stats().calls, 2);
});

test('shorter user interval takes effect without rewriting cached attempts', async () => {
    const f = fixture(); await f.api.refreshDueSources(interval);
    f.state.schedule.intervalMinutes = 5;
    f.advance(5 * 60_000);
    await f.api.fetchSourcePrompts('source');
    assert.equal(f.stats().calls, 2);
});


test('source edited during in-flight failure retains the old attempted signature, then tries new source', async () => {
    const f = fixture();
    let release!: () => void;
    f.hold(new Promise<void>(resolve => { release = resolve; }));
    const loading = f.api.refreshDueSources(interval);
    while (!f.stats().calls) await Promise.resolve();
    f.source.url = 'https://example.org/changed-during-fetch';
    release(); await loading;
    await f.api.refreshDueSources(interval);
    assert.equal(f.stats().calls, 2);
    await f.api.refreshDueSources(interval);
    assert.equal(f.stats().calls, 2);
});

test('persisted attempt metadata throttles a fresh module after reload', async () => {
    const f = fixture(); await f.api.refreshDueSources(interval);
    const reloaded = fixture(f.stats().persisted);
    await reloaded.api.refreshDueSources(interval);
    await reloaded.api.fetchSourcePrompts('source');
    assert.equal(reloaded.stats().calls, 0);
});
