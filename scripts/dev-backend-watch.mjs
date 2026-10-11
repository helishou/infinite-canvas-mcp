import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { watch, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const tsx = pathToFileURL(createRequire(path.join(backend, 'package.json')).resolve('tsx')).href;

function backendDataDir(cwd) {
    if (process.env.INFINITE_CANVAS_DATA_DIR) return path.resolve(cwd, process.env.INFINITE_CANVAS_DATA_DIR);
    try {
        const config = JSON.parse(readFileSync(path.join(os.homedir(), '.infinite-canvas-root.json'), 'utf8'));
        if (config.dataDir) return path.resolve(cwd, config.dataDir);
    } catch { /* use the Backend default */ }
    return path.join(os.homedir(), '.infinite-canvas');
}

function processCommandLine(pid) {
    if (process.platform === 'win32') {
        return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 2500, windowsHide: true }).trim();
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 2500 }).trim();
}

function isBackendFromThisProject(commandLine, cwd) {
    const value = commandLine.toLowerCase().replaceAll('\\', '/');
    const backendUrl = pathToFileURL(path.resolve(cwd)).href.toLowerCase();
    const backendPath = backendUrl.replace(/^file:\/\//, '').replace(/\/$/, '').replaceAll('%20', ' ');
    const ownsPath = value.includes(backendUrl) || value.includes(backendPath);
    return ownsPath && /(?:src\/index\.ts|dist\/index\.js)(?:\s|$)/i.test(value);
}

function removeLockIfOwned(lockPath, pid) {
    try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number(current.pid) === pid) rmSync(lockPath, { force: true });
    } catch { /* process shutdown or another instance already released it */ }
}

function clearPreviousBackend(cwd, log) {
    const lockPath = path.join(backendDataDir(cwd), 'backend.lock');
    let record;
    try { record = JSON.parse(readFileSync(lockPath, 'utf8')); }
    catch { return; }
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
    try {
        process.kill(pid, 0);
    } catch (error) {
        if (error?.code === 'EPERM') throw error;
        removeLockIfOwned(lockPath, pid);
        log.log(`[backend-watch] removed stale Backend lock PID=${pid}`);
        return;
    }

    let commandLine;
    try { commandLine = processCommandLine(pid); }
    catch { throw new Error(`Backend lock PID=${pid} is live but its command line could not be verified; refusing to stop it.`); }
    if (!isBackendFromThisProject(commandLine, cwd)) {
        throw new Error(`Backend lock PID=${pid} belongs to another process; refusing to stop it. Lock: ${lockPath}`);
    }

    process.kill(pid, 'SIGKILL');
    removeLockIfOwned(lockPath, pid);
    log.log(`[backend-watch] stopped previous Backend PID=${pid}`);
}

export function startBackendWatch({ cwd = backend, directories = [path.join(backend, 'src'), path.join(root, 'canvas-agent', 'dist')], log = console } = {}) {
    let child, ready = false, dirty = false, requested = false, restarting = false, stopped = false, reportedBusy = false;
    let debounce, retry;
    const watchers = [];

    function requestReload() {
        if (stopped || !dirty || debounce) return;
        if (!child) return start();
        if (!ready || requested || restarting) return;
        requested = true;
        child.send({ type: 'dev:reload' }, error => { if (error) requested = false; });
    }

    function start() {
        dirty = false; ready = false; requested = false; restarting = false; reportedBusy = false;
        try { clearPreviousBackend(cwd, log); }
        catch (error) { log.error(`[backend-watch] ${error.message}`); return; }
        child = spawn(process.execPath, ['--import', tsx, 'src/index.ts'], {
            cwd, env: { ...process.env, INFINITE_CANVAS_DEV_WATCH: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
        child.on('message', message => {
            if (message?.type === 'dev:ready') { ready = true; log.log(`[backend-watch] ready PID=${message.pid}`); requestReload(); }
            if (message?.type !== 'dev:reload-status') return;
            requested = false;
            if (message.accepted) {
                dirty = false; restarting = true;
                clearTimeout(retry);
                log.log('[backend-watch] idle; reloading Backend');
            } else {
                if (!reportedBusy) log.log('[backend-watch] reload pending; waiting for tasks, Agent turns and writes to finish');
                reportedBusy = true;
                retry = setTimeout(requestReload, 1000);
            }
        });
        child.on('error', error => { log.error(`[backend-watch] ${error.message}`); child = undefined; ready = false; requested = false; });
        child.on('exit', code => {
            const shouldRestart = restarting || dirty;
            child = undefined; ready = false; requested = false;
            if (stopped) return;
            if (shouldRestart) start();
            else log.error(`[backend-watch] Backend exited (${code}); waiting for the next source edit`);
        });
    }

    for (const directory of directories) {
        if (!existsSync(directory)) continue;
        watchers.push(watch(directory, { recursive: true }, (_event, name) => {
            const relative = String(name || '');
            if (!/\.(?:ts|tsx|js|mjs|cjs|json)$/.test(relative) || /\.test\.[cm]?[jt]sx?$/.test(relative) || /\.d\.ts$/.test(relative)) return;
            dirty = true;
            clearTimeout(debounce);
            debounce = setTimeout(() => { debounce = undefined; requestReload(); }, 500);
        }));
    }
    async function stop(signal = 'SIGTERM') {
        if (stopped) return;
        stopped = true;
        clearTimeout(debounce); clearTimeout(retry);
        for (const watcher of watchers) watcher.close();
        if (child) {
            const closing = child;
            await new Promise(resolve => { closing.once('exit', resolve); closing.kill(signal); });
        }
    }
    start();
    return { stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const watcher = startBackendWatch();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => watcher.stop(signal));
}
