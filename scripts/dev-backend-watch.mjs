import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { watch, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStableBackendProxy } from './dev-backend-proxy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const tsx = pathToFileURL(createRequire(path.join(backend, 'package.json')).resolve('tsx')).href;

function backendDataDir(cwd, env = process.env) {
    if (env.INFINITE_CANVAS_DATA_DIR) return path.resolve(cwd, env.INFINITE_CANVAS_DATA_DIR);
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

function clearPreviousBackend(cwd, log, env = process.env, canStop = true) {
    const lockPath = path.join(backendDataDir(cwd, env), 'backend.lock');
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

    if (!canStop) throw new Error(`Backend PID=${pid} is already running; stop it while idle before starting stable mode.`);

    process.kill(pid, 'SIGKILL');
    removeLockIfOwned(lockPath, pid);
    log.log(`[backend-watch] stopped previous Backend PID=${pid}`);
}

export function startBackendWatch({ cwd = backend, directories = [path.join(backend, 'src'), path.join(root, 'canvas-agent', 'dist')], watchSources = true, log = console, publicPort: configuredPublicPort, backendPort: configuredBackendPort, env = process.env } = {}) {
    let child, ready = false, dirty = false, requested = false, restarting = false, stopped = false, reportedBusy = false;
    let debounce, retry;
    let changedAt, reloadStartedAt, lastChangedFile;
    const watchers = [];
    const publicPort = configuredPublicPort ?? (Number(env.PORT) || 17370);
    const backendPort = configuredBackendPort ?? (Number(env.INFINITE_CANVAS_BACKEND_LISTEN_PORT) || 17372);
    const proxy = createStableBackendProxy({ port: publicPort, targetPort: backendPort, log });

    function requestReload() {
        if (stopped || !dirty || debounce) return;
        if (!child) return start();
        if (!ready || requested || restarting) return;
        requested = true;
        child.send({ type: 'dev:reload' }, error => { if (error) requested = false; });
    }

    function start() {
        if (stopped) return;
        dirty = false; ready = false; requested = false; restarting = false; reportedBusy = false;
        proxy.setBackendReady(false);
        try { clearPreviousBackend(cwd, log, env, watchSources); }
        catch (error) {
            log.error(`[backend-watch] ${error.message}`);
            if (!watchSources) { proxy.close(); process.exitCode = 1; }
            return;
        }
        const startedAt = performance.now();
        child = spawn(process.execPath, watchSources ? ['--import', tsx, 'src/index.ts'] : ['dist/index.js'], {
            cwd, env: { ...env, PORT: String(publicPort), INFINITE_CANVAS_BACKEND_LISTEN_PORT: String(backendPort), INFINITE_CANVAS_DEV_WATCH: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
        child.on('message', message => {
            if (message?.type === 'dev:ready') {
                const readyChild = child;
                void proxy.setListenHost(message.listenHost).then(() => {
                    if (stopped || child !== readyChild) return;
                    ready = true;
                    proxy.setBackendReady(true);
                    log.log(`[backend-watch] ready PID=${message.pid} publicHost=${proxy.server.address()?.address}`);
                    log.log(`[backend-watch] timings ${JSON.stringify({ mode: watchSources ? 'watch' : 'stable', startupMs: Math.round(performance.now() - startedAt), ...(reloadStartedAt !== undefined ? { unavailableMs: Math.round(performance.now() - reloadStartedAt) } : {}) })}`);
                    reloadStartedAt = undefined;
                    requestReload();
                }).catch(error => log.error(`[backend-watch] public listener bind failed: ${error.message}`));
                return;
            }
            if (message?.type !== 'dev:reload-status') return;
            requested = false;
            if (message.accepted) {
                dirty = false; restarting = true;
                reloadStartedAt = performance.now();
                proxy.setBackendReady(false);
                clearTimeout(retry);
                log.log('[backend-watch] idle; reloading Backend');
                log.log(`[backend-watch] trigger ${JSON.stringify({ file: lastChangedFile, waitForIdleMs: changedAt === undefined ? 0 : Math.round(performance.now() - changedAt) })}`);
                changedAt = undefined;
            } else {
                if (!reportedBusy) log.log('[backend-watch] reload pending; waiting for tasks, Agent turns and writes to finish');
                reportedBusy = true;
                retry = setTimeout(requestReload, 1000);
            }
        });
        child.on('error', error => { log.error(`[backend-watch] ${error.message}`); child = undefined; ready = false; requested = false; });
        child.on('exit', code => {
            if (reloadStartedAt !== undefined) log.log(`[backend-watch] shutdown ${JSON.stringify({ code, shutdownMs: Math.round(performance.now() - reloadStartedAt) })}`);
            const shouldRestart = restarting || dirty;
            child = undefined; ready = false; requested = false; proxy.setBackendReady(false);
            if (stopped) return;
            if (shouldRestart) start();
            else log.error(`[backend-watch] Backend exited (${code}); waiting for the next source edit`);
        });
    }

    for (const directory of watchSources ? directories : []) {
        if (!existsSync(directory)) continue;
        watchers.push(watch(directory, { recursive: true }, (_event, name) => {
            const relative = String(name || '');
            if (!/\.(?:ts|tsx|js|mjs|cjs|json)$/.test(relative) || /\.test\.[cm]?[jt]sx?$/.test(relative) || /\.d\.ts$/.test(relative)) return;
            dirty = true;
            changedAt ??= performance.now();
            lastChangedFile = path.relative(root, path.join(directory, relative));
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
        proxy.close();
    }
    proxy.server.once('listening', () => {
        log.log(`[backend-watch] stable Backend proxy listening on 127.0.0.1:${publicPort} → 127.0.0.1:${backendPort}`);
        start();
    });
    proxy.server.on('error', error => log.error(`[backend-watch] stable Backend proxy failed: ${error.message}`));
    return { stop, get proxyPort() { return proxy.server.address()?.port || publicPort; }, get proxyAddress() { return proxy.server.address(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const watcher = startBackendWatch({ watchSources: !process.argv.includes('--stable') });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => watcher.stop(signal));
}
