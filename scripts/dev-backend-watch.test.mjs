import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startBackendWatch } from './dev-backend-watch.mjs';

test('real file watcher coalesces changes and reloads only after its child is idle', { timeout: 15000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-watch-'));
    const source = path.join(directory, 'src');
    await fs.mkdir(source);
    const busyFile = path.join(directory, 'busy.json'), pidFile = path.join(directory, 'pids.txt');
    await fs.writeFile(busyFile, 'true');
    const gateUrl = pathToFileURL(path.resolve('backend/src/runtime/dev-reload.ts')).href;
    const program = `import fs from 'node:fs';
import { createDevReloadGate } from ${JSON.stringify(gateUrl)};
const gate = createDevReloadGate();
fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid+'\\n');
process.on('message', message => {
 if (message?.type !== 'dev:reload') return;
 const accepted = gate.tryReload(() => JSON.parse(fs.readFileSync(${JSON.stringify(busyFile)}, 'utf8')));
 process.send({ type:'dev:reload-status', accepted }, undefined, undefined, () => { if(accepted) process.exit(0); });
});
process.send({ type:'dev:ready', pid:process.pid });
`;
    const entry = path.join(source, 'index.ts'); await fs.writeFile(entry, program);
    const messages = [];
    const watcher = startBackendWatch({ cwd: directory, directories: [source], log: { log: text => messages.push(text), error: text => messages.push(text) } });
    t.after(async () => {
        await watcher.stop();
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const waitFor = async condition => {
        const deadline = Date.now() + 7000;
        while (!await condition()) { assert.ok(Date.now() < deadline, messages.join('\n')); await new Promise(resolve => setTimeout(resolve, 30)); }
    };
    const pids = async () => { try { return (await fs.readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean); } catch { return []; } };
    await waitFor(async () => (await pids()).length === 1);
    await fs.writeFile(entry, program + '\n// first edit\n');
    await fs.writeFile(entry, program + '\n// final edit\n');
    await waitFor(() => messages.some(message => message.includes('reload pending')));
    assert.equal((await pids()).length, 1, 'busy work must not be interrupted');
    await fs.writeFile(busyFile, 'false');
    await waitFor(async () => (await pids()).length === 2);
    assert.notEqual((await pids())[0], (await pids())[1]);
    assert.equal(messages.filter(message => message.includes('idle; reloading')).length, 1);
    await fs.writeFile(entry, program + '\n// next edit\n');
    await fs.writeFile(entry, program + '\n// latest edit\n');
    await waitFor(async () => (await pids()).length === 3);
    assert.equal(messages.filter(message => message.includes('idle; reloading')).length, 2, 'an idle/startup edit burst is also coalesced');
});
