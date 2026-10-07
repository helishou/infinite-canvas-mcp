import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareDevServices } from './prepare-dev-services.mjs';

test('startup reuses unchanged builds and rebuilds for source edits, dependencies and missing outputs', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-startup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'version one');
    await fs.writeFile(path.join(root, 'package-lock.json'), 'dependencies one');
    const groups = [{ name: 'agent', inputs: ['src', 'package-lock.json'], outputs: ['dist'] }];
    let builds = 0;
    const build = async () => {
        builds++;
        await fs.mkdir(path.join(root, 'dist'), { recursive: true });
        await fs.writeFile(path.join(root, 'dist', 'index.js'), `output ${builds}`);
    };
    const run = () => prepareDevServices(root, groups, build);
    await run(); await run();
    assert.equal(builds, 1);
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'version two');
    await run(); assert.equal(builds, 2);
    await fs.writeFile(path.join(root, 'package-lock.json'), 'dependencies two');
    await run(); assert.equal(builds, 3);
    await fs.unlink(path.join(root, 'dist', 'index.js'));
    await run(); assert.equal(builds, 4);
    await fs.writeFile(path.join(root, 'dist', 'index.js'), 'stale externally rebuilt output');
    await run(); assert.equal(builds, 5);
    await run(); assert.equal(builds, 5);
});

test('failed builds and edits during builds never create a reusable cache', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-startup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'source'), 'one');
    const groups = [{ name: 'agent', inputs: ['source'], outputs: ['output'] }];
    await assert.rejects(prepareDevServices(root, groups, async () => { throw new Error('compile failed'); }), /compile failed/);
    let builds = 0;
    await prepareDevServices(root, groups, async () => {
        builds++;
        await fs.writeFile(path.join(root, 'output'), 'output');
        await fs.writeFile(path.join(root, 'source'), 'two');
    });
    await prepareDevServices(root, groups, async () => { builds++; });
    assert.equal(builds, 2);
});
