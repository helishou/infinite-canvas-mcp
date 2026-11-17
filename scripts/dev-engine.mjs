import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 执行引擎（comfyui2api 子仓库）的开发启动项。
 *
 * 画布的所有生成都经引擎转发 ComfyUI / RunningHub，所以 dev 栈里它必须和 backend/web 一起起来：
 *   1. 端口 8300 已经在监听 → 直接复用，不重复拉起
 *   2. 缺依赖 → npm install；缺构建产物或源码较新 → npm run build
 *   3. 前台运行 `node dist/cli/serve.js serve --port <port>`，Ctrl+C 与并发退出会一起收掉
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'comfyui2api');
const port = Number(process.env.COMFYUI2API_PORT || 8300);
const entry = path.join(engineDir, 'dist', 'cli', 'serve.js');

function log(message) {
    console.log(`[engine] ${message}`);
}

function portOpen(target) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: target });
        const done = (open) => { socket.destroy(); resolve(open); };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.setTimeout(800, () => done(false));
    });
}

function newestSourceTime(directory) {
    let newest = 0;
    const visit = (dir) => {
        for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
            if (name.name === 'node_modules' || name.name === 'dist' || name.name === '.git') continue;
            const full = path.join(dir, name.name);
            if (name.isDirectory()) visit(full);
            else if (/\.(ts|tsx|mts|cts|json)$/.test(name.name)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
        }
    };
    for (const dir of ['src', 'web/src']) {
        const full = path.join(engineDir, dir);
        if (fs.existsSync(full)) visit(full);
    }
    return newest;
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（${result.status ?? result.signal}）`);
}

async function main() {
    const buildOnly = process.argv.includes('--build');
    if (!fs.existsSync(engineDir)) {
        log(`找不到引擎目录 ${engineDir}：先执行 git submodule update --init`);
        process.exit(1);
    }
    if (!buildOnly && await portOpen(port)) {
        log(`端口 ${port} 已在监听，复用已运行的引擎`);
        return;
    }
    if (!fs.existsSync(path.join(engineDir, 'node_modules'))) {
        log('安装引擎依赖（首次启动）...');
        run('npm', ['install', '--no-audit', '--no-fund'], engineDir);
    }
    const stale = !fs.existsSync(entry) || newestSourceTime() > fs.statSync(entry).mtimeMs;
    if (stale) {
        log('引擎源码有更新，构建 dist（tsc + 控制台 vite build）...');
        run('npm', ['run', 'build'], engineDir);
    }
    if (buildOnly) {
        log('构建完成（--build）');
        return;
    }
    log(`启动 comfyui2api → http://127.0.0.1:${port}/`);
    // 告诉引擎「我是带着刚构建好的 dist 起来的」：否则构建与启动只差几秒，
    // /health 会一直报 stale，控制台顶部就是那条「服务端在跑旧构建」的红条。
    const child = spawn(process.execPath, [entry, 'serve', '--port', String(port)], {
        cwd: engineDir,
        stdio: 'inherit',
        windowsHide: true,
        env: { ...process.env, COMFYUI2API_DIST_BASELINE: String(Date.now()) },
    });
    const stop = () => { try { child.kill(); } catch { /* 已退出 */ } };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('exit', stop);
    child.once('exit', (code) => process.exit(code ?? 0));
}

main().catch((error) => {
    console.error(`[engine] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
