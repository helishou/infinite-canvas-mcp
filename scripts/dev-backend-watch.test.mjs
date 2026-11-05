import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
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

process.send({ type:'dev:ready', pid:process.pid, listenHost:'0.0.0.0' });
`;
    const entry = path.join(source, 'index.ts'); await fs.writeFile(entry, program);
    const messages = [];
    const watcher = startBackendWatch({ cwd: directory, directories: [source], publicPort: 0, backendPort: 0, env: { ...process.env, INFINITE_CANVAS_DATA_DIR: path.join(directory, 'data') }, log: { log: text => messages.push(text), error: text => messages.push(text) } });
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
    await waitFor(async () => (await pids()).length === 1 && watcher.proxyAddress?.address === '0.0.0.0');
    assert.equal(watcher.proxyAddress.address, '0.0.0.0', 'LAN opt-in must expose the stable proxy on all interfaces');
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

test('stable mode loads a built entry and ignores source and build edits', { timeout: 10000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-stable-'));
    const dist = path.join(directory, 'dist');
    const source = path.join(directory, 'src');
    await fs.mkdir(dist);
    await fs.mkdir(source);
    const entry = path.join(dist, 'index.js');
    const pidFile = path.join(directory, 'pids.txt');
    const program = `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid+'\\n');
process.on('message', () => {});
process.send({type:'dev:ready',pid:process.pid,listenHost:'127.0.0.1'});
`;
    await fs.writeFile(entry, program);
    const messages = [];
    const watcher = startBackendWatch({ cwd: directory, directories: [source, dist], watchSources: false, publicPort: 0, backendPort: 0,
        env: { ...process.env, INFINITE_CANVAS_DATA_DIR: path.join(directory, 'data') },
        log: { log: text => messages.push(text), error: text => messages.push(text) } });
    t.after(async () => {
        await watcher.stop();
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const deadline = Date.now() + 5000;
    while (!messages.some(message => message.includes('ready PID='))) {
        assert.ok(Date.now() < deadline, messages.join('\n'));
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    await fs.writeFile(path.join(source, 'index.ts'), '// source edit');
    await fs.writeFile(entry, program + '\n// build edit');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal((await fs.readFile(pidFile, 'utf8')).trim().split('\n').length, 1);
    assert.ok(messages.some(message => message.includes('"mode":"stable"')));
});

test('HTTP reads survive an actual watched child exit and restart', { timeout: 10000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-reload-http-'));
    const source = path.join(directory, 'src');
    await fs.mkdir(source);
    const reserved = http.createServer();
    reserved.listen(0, '127.0.0.1');
    await once(reserved, 'listening');
    const backendPort = reserved.address().port;
    await new Promise(resolve => reserved.close(resolve));
    const entry = path.join(source, 'index.ts');
    const program = `import http from 'node:http';
const server = http.createServer((_req,res)=>res.end(String(process.pid)));
process.on('message', message=>{
 if(message?.type!=='dev:reload') return;
 process.send({type:'dev:reload-status',accepted:true},undefined,undefined,()=>{
  server.close(); setTimeout(()=>process.exit(0),100);
 });
});
setTimeout(()=>server.listen(Number(process.env.INFINITE_CANVAS_BACKEND_LISTEN_PORT),'127.0.0.1',()=>{
 process.send({type:'dev:ready',pid:process.pid,listenHost:'127.0.0.1'});
}),100);
`;
    await fs.writeFile(entry, program);
    const messages = [];
    let pending;
    const watcher = startBackendWatch({ cwd: directory, directories: [source], publicPort: 0, backendPort,
        env: { ...process.env, INFINITE_CANVAS_DATA_DIR: path.join(directory, 'data') },
        log: { log: text => {
            messages.push(text);
            if (text.includes('idle; reloading Backend')) pending = fetch(`http://127.0.0.1:${watcher.proxyPort}/collaboration`);
        }, error: text => messages.push(text) } });
    t.after(async () => {
        await watcher.stop();
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const deadline = Date.now() + 7000;
    while (!messages.some(text => text.includes('ready PID='))) {
        assert.ok(Date.now() < deadline, messages.join('\n'));
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    const previousPid = await fetch(`http://127.0.0.1:${watcher.proxyPort}/health`).then(res => res.text());
    await fs.writeFile(entry, program + '\n// reload\n');
    while (!pending) {
        assert.ok(Date.now() < deadline, messages.join('\n'));
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    const response = await pending;
    assert.equal(response.status, 200, messages.join('\n'));
    assert.notEqual(await response.text(), previousPid);
    assert.ok(messages.some(text => text.includes('shutdownMs')));
    assert.ok(messages.some(text => text.includes('unavailableMs')));
    assert.ok(messages.some(text => text.includes('"heldRequests":1')));
});
