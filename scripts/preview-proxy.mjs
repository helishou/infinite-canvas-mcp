// 生产预览同源代理：静态服务 web/dist，并把 Backend 路径反代到 127.0.0.1:17370。
// 目的：让打包后的页面只跟 3002 同源，避免浏览器直连 17370 被 Backend CORS 白名单拒绝
// （Backend 只允许 3001 来源，且不能为此改后端配置）。Node 侧转发时去掉浏览器 Origin，
// 服务端请求不带 Origin，因此不触发 CORS 403。
//
// 用法：
//   node scripts/pnpm.mjs --filter infinite-canvas run build   # 先产出 web/dist
//   node scripts/preview-proxy.mjs [--port 3002] [--backend-port 17370] [--host 127.0.0.1]
//
// 与 vite dev(3001) 完全独立：不改 dev/build 语义，也不改后端。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'web', 'dist');
const LOG_FILE = path.join(ROOT, 'tmp', 'compare2', 'preview', 'proxy.log');

function argValue(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : fallback;
}

const PORT = Number(argValue('port', '3002'));
const HOST = argValue('host', '127.0.0.1');
const BACKEND_HOST = argValue('backend-host', '127.0.0.1');
const BACKEND_PORT = Number(argValue('backend-port', '17370'));
// 静态目录可覆盖，默认 web/dist；测试时可指向临时目录。
const DIST_DIR = path.resolve(ROOT, argValue('dist', path.relative(ROOT, DIST)));

// 精确匹配：这些路径整段属于 Backend。
const BACKEND_EXACT = new Set([
    '/config', '/settings', '/data-dir', '/connection', '/health', '/events', '/agent',
    '/tasks', '/mcp-token', '/mcp', '/generation-logs', '/prompts', '/skills', '/workflows',
    '/rules', '/production/worker-status', '/production/contract',
]);
// 前缀匹配：带子路径的 Backend API。前端 SPA 同名路由（/config、/prompts、/skills、
// /workflows、/rules、/canvas、/drama、/drama-studio）在浏览器导航时走静态 fallback，
// 见 isDocumentNavigation 分支；这里只处理 XHR/fetch/媒体等非导航请求。
const BACKEND_PREFIXES = [
    '/settings/', '/media/', '/drama/', '/dramas/', '/canvas/', '/agent/', '/tasks/',
    '/prompts/', '/skills/', '/workflows/', '/generation-logs/', '/runtime/', '/api/',
    '/camera-library/', '/director/', '/codex/', '/comfy/', '/rules/', '/mcp/',
    '/production/',
    // 只代理 Backend 实际提供的插件接口；web/dist/plugins 下是静态插件产物，不能整段代理。
    '/plugins/mcp', '/plugins/installed', '/plugins/storage', '/plugins/minimax-h3/',
];

const MIME = new Map(Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
}));

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.writeFileSync(LOG_FILE, '', 'utf8');
function log(line) {
    const text = `${new Date().toISOString()} ${line}`;
    fs.appendFile(LOG_FILE, `${text}\n`, () => {});
    console.log(text);
}

if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.error(`[preview] 缺少 ${path.join(DIST_DIR, 'index.html')}；先运行 node scripts/pnpm.mjs --filter infinite-canvas run build`);
    process.exit(1);
}

function isDocumentNavigation(req) {
    // 浏览器文档导航：/config、/drama-studio、/canvas 等 SPA 路由必须回 index.html，
    // 不能因为与 Backend 同名就被反代成 JSON。
    if ((req.headers['sec-fetch-mode'] || '') === 'navigate') return true;
    const accept = String(req.headers.accept || '');
    return accept.includes('text/html') && !req.headers['x-requested-with'];
}

function backendTarget(pathname) {
    if (BACKEND_EXACT.has(pathname)) return true;
    return BACKEND_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix));
}

function safeStaticPath(pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return undefined;
    }
    if (decoded.includes('\0')) return undefined;
    const file = path.resolve(DIST_DIR, `.${decoded}`);
    if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) return undefined;
    return file;
}

function sendStatic(req, res, pathname) {
    const started = Date.now();
    const file = safeStaticPath(pathname);
    const finish = (status, extra = '') => log(`static ${req.method} ${pathname} -> ${status}${extra} ${Date.now() - started}ms`);
    if (!file) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad path');
        return finish(400);
    }
    let target = file;
    let stat;
    try {
        stat = fs.statSync(target);
        if (stat.isDirectory()) {
            target = path.join(target, 'index.html');
            stat = fs.statSync(target);
        }
    } catch {
        // SPA fallback：无扩展名的前端路由回 index.html；带扩展名视为真缺失。
        if (path.extname(pathname)) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return finish(404);
        }
        target = path.join(DIST_DIR, 'index.html');
        stat = fs.statSync(target);
    }
    const type = MIME.get(path.extname(target).toLowerCase()) || 'application/octet-stream';
    const immutable = pathname.startsWith('/assets/');
    const headers = {
        'content-type': type,
        'content-length': stat.size,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    res.writeHead(200, headers);
    finish(200, ` ${stat.size}B${immutable ? ' immutable' : ''}`);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
}

// hop-by-hop 头不能透传，否则 Node 会按上游的 chunked/connection 语义重复处理。
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function proxyRequest(req, res, pathname) {
    const started = Date.now();
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
        const key = name.toLowerCase();
        if (HOP_BY_HOP.has(key)) continue;
        // 关键：去掉浏览器 Origin/Referer，后端 CORS 只放行 3001；服务端转发不带 Origin。
        if (key === 'origin' || key === 'referer') continue;
        headers[key] = value;
    }
    headers.host = `${BACKEND_HOST}:${BACKEND_PORT}`;
    const remote = req.socket.remoteAddress || '';
    headers['x-forwarded-for'] = remote;
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] = 'http';

    const upstream = http.request({
        host: BACKEND_HOST,
        port: BACKEND_PORT,
        method: req.method,
        path: req.url,
        headers,
        // 事件流/长连接不要复用 agent 的空闲 socket 语义，直接一条连接。
        agent: false,
    }, (response) => {
        const responseHeaders = {};
        for (const [name, value] of Object.entries(response.headers)) {
            if (HOP_BY_HOP.has(name.toLowerCase())) continue;
            responseHeaders[name] = value;
        }
        // SSE：明确不缓冲，关闭 Nagle，flush 头后立即 pipe。
        const isEventStream = String(response.headers['content-type'] || '').includes('text/event-stream');
        if (isEventStream) {
            responseHeaders['cache-control'] = 'no-cache, no-transform';
            responseHeaders['x-accel-buffering'] = 'no';
            res.socket?.setNoDelay?.(true);
        }
        res.writeHead(response.statusCode || 502, responseHeaders);
        if (isEventStream) res.flushHeaders?.();
        response.pipe(res);
        const kind = isEventStream ? 'sse' : 'proxy';
        log(`${kind} ${req.method} ${pathname} -> ${response.statusCode} ${Date.now() - started}ms`);
        response.on('error', () => res.destroy());
    });

    // 长连接不设 idle 超时；Backend 侧关闭时让响应自然结束。
    upstream.setTimeout(0);
    upstream.setNoDelay?.(true);
    upstream.on('error', (error) => {
        // 客户端主动断开（关标签页/取消 fetch）不是上游失败，别记成 502。
        if (res.headersSent || res.destroyed) {
            if (!res.writableEnded) log(`proxy ${req.method} ${pathname} -> closed by client`);
            res.destroy();
            return;
        }
        log(`proxy ${req.method} ${pathname} -> 502 ${error.code || error.message}`);
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, code: 'PREVIEW_PROXY_UPSTREAM', error: String(error.message || error) }));
    });
    req.once('aborted', () => upstream.destroy(new Error('client aborted')));
    res.once('close', () => {
        if (!res.writableEnded) upstream.destroy(new Error('client closed'));
    });
    req.pipe(upstream);
}

const server = http.createServer((req, res) => {
    let pathname;
    try {
        pathname = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname;
    } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('bad request');
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && isDocumentNavigation(req)) return sendStatic(req, res, pathname);
    if (backendTarget(pathname)) return proxyRequest(req, res, pathname);
    if (req.method === 'GET' || req.method === 'HEAD') return sendStatic(req, res, pathname);
    // 未匹配的写请求也要明确回 404，避免误当静态资源挂住。
    log(`miss ${req.method} ${pathname} -> 404`);
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'PREVIEW_NOT_FOUND', path: pathname }));
});

// SSE 与画布实时协作长时间挂起：关掉 Node 默认请求/头超时。
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 72_000;

// WebSocket（/canvas/realtime）按字节隧道透传，否则浏览器握手会拿到 404。
server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname;
    if (!backendTarget(pathname)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
    }
    log(`ws ${pathname} -> tunnel`);
    const lines = [`${req.method || 'GET'} ${req.url} HTTP/1.1`];
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index];
        if (['host', 'proxy-connection', 'origin', 'x-forwarded-for'].includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
    }
    lines.push(`host: ${BACKEND_HOST}:${BACKEND_PORT}`, `x-forwarded-for: ${req.socket.remoteAddress || ''}`, '', '');
    const upstream = net.connect({ host: BACKEND_HOST, port: BACKEND_PORT });
    const shutdown = () => { socket.destroy(); upstream.destroy(); };
    upstream.once('connect', () => {
        upstream.write(lines.join('\r\n'));
        if (head?.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.once('error', shutdown);
    socket.once('error', shutdown);
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`[preview] ${HOST}:${PORT} 已被占用；先停掉旧的 preview/vite，或改用 --port。`);
        process.exit(2);
    }
    throw error;
});

server.listen(PORT, HOST, () => {
    log(`[preview] listening http://${HOST}:${PORT} dist=${DIST_DIR} backend=http://${BACKEND_HOST}:${BACKEND_PORT}`);
});
