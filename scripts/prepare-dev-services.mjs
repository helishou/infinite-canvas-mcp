import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Check file contents rather than timestamps: checkout, restored files and missing
// outputs must all invalidate the cache. Never include dependency/build directories.
async function fingerprint(root, entries) {
    const hash = crypto.createHash('sha256');
    const visit = async (relative) => {
        const full = path.join(root, relative);
        let stat;
        try { stat = await fs.stat(full); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            hash.update(JSON.stringify([relative, 'missing']));
            return;
        }
        if (stat.isDirectory()) {
            hash.update(JSON.stringify([relative, 'directory']));
            for (const name of (await fs.readdir(full)).sort()) {
                if (['node_modules', 'dist', '.git', '.codegraph'].includes(name)) continue;
                await visit(path.join(relative, name));
            }
        } else {
            const digest = crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');
            hash.update(JSON.stringify([relative, digest]));
        }
    };
    for (const entry of entries) await visit(entry);
    return hash.digest('hex');
}

export async function prepareDevServices(root, groups, runBuild) {
    const cacheFile = path.join(root, 'node_modules', '.cache', 'infinite-canvas', 'startup-builds.json');
    let cache = {};
    try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { /* first run or invalid cache */ }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
    for (const group of groups) {
        const inputs = await fingerprint(root, group.inputs);
        const outputs = await fingerprint(root, group.outputs);
        const previous = cache[group.name];
        if (previous?.inputs === inputs && previous.outputs === outputs) {
            console.log(`[dev-local] ${group.name}: unchanged, using verified build`);
            continue;
        }
        console.log(`[dev-local] ${group.name}: source/dependencies/output changed, building...`);
        await runBuild(group);
        // Do not bless a build if someone edited a source while it was running.
        if (inputs !== await fingerprint(root, group.inputs)) {
            delete cache[group.name];
        } else {
            cache[group.name] = { inputs, outputs: await fingerprint(root, group.outputs) };
        }
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
    }
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
    const root = path.resolve(path.dirname(script), '..');
    const sharedInputs = ['package.json', 'package-lock.json', 'scripts/prepare-dev-services.mjs'];
    await prepareDevServices(root, [
        { name: 'plugins', inputs: [...sharedInputs, 'plugins/canvas', 'scripts/build-official-plugins.mjs'],
            outputs: ['plugins/canvas/registry/dist', 'web/public/plugins'], command: ['run', 'build:plugins'] },
        { name: 'canvas-agent', inputs: [...sharedInputs, 'canvas-agent/src', 'canvas-agent/scripts', 'canvas-agent/package.json', 'canvas-agent/package-lock.json', 'canvas-agent/tsconfig.json', '.agents/skills/canvas-video-production-sop'],
            outputs: ['canvas-agent/dist'], command: ['run', 'build', '--workspace', 'canvas-agent'] },
    ], (group) => {
        const npmCli = process.env.npm_execpath;
        const result = npmCli
            ? spawnSync(process.execPath, [npmCli, ...group.command], { cwd: root, stdio: 'inherit', windowsHide: true })
            : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', group.command, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`${group.name} build failed (${result.status ?? result.signal})`);
    });
}
