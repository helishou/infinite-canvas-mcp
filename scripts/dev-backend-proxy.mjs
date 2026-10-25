import http from 'node:http';
import net from 'node:net';

const DEFAULT_READY_WAIT_MS = 10_000;
const LISTEN_RETRY_MS = 250;
// 代理自己生成的响应（重载期 503、预检 204）必须自带 CORS 头：
// 浏览器只看响应头，缺 Access-Control-Allow-Origin 时会把「重载中」读成
// 硬失败（net::ERR_FAILED），前端连 BACKEND_RELOADING 都读不到。
const CORS_ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS_DEFAULT = 'Content-Type, Authorization, x-canvas-agent-token, x-media-name, x-media-width, x-media-height, x-media-duration-ms, x-media-category';

function applyCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (!origin) return false;
    // Backend 的 CORS 也是 echo Origin + credentials，这里保持一致；代理只回错误码，不带数据。
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
    const requested = req.headers['access-control-request-headers'];
    res.setHeader(
        'Access-Control-Allow-Headers',
        typeof requested === 'string' && requested ? requested : CORS_ALLOWED_HEADERS_DEFAULT,
    );
    // Retry-After 不是 CORS safelisted 响应头，不暴露前端就读不到。
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    return true;
}

/** Keep the public development Backend endpoint bound while its watched child restarts. */
export function createStableBackendProxy({ port, targetPort, readyWaitMs = DEFAULT_READY_WAIT_MS, listenHost = '127.0.0.1', backendHost = '127.0.0.1' }) {
    let backendReady = false;
    let closed = false;
    let currentListenHost = listenHost;
    let listenRetry;
    const waiting = new Set();
    const tunnels = new Set();
    const server = http.createServer((req, res) => {
        let settled = false;
        let timer;
        const dispatch = () => {
            if (settled || res.destroyed) return;
            settled = true;
            clearTimeout(timer);
            waiting.delete(dispatch);
            forward(req, res, targetPort, backendHost);
        };
        dispatch.reject = () => {
            if (settled || res.destroyed) return;
            settled = true;
            clearTimeout(timer);
            waiting.delete(dispatch);
            sendError(req, res, 503, 'BACKEND_RELOADING', 'Backend 入口正在切换监听地址；稍后重试。');
        };
        // 预检请求没有副作用，重载期直接本地应答：挂到 10s 超时只会让浏览器
        // 报「preflight 失败」，前端永远读不到 BACKEND_RELOADING。
        if (!backendReady && req.method === 'OPTIONS' && applyCorsHeaders(req, res)) {
            res.setHeader('Retry-After', '1');
            res.statusCode = 204;
            return res.end();
        }
        if (backendReady) return dispatch();
        waiting.add(dispatch);
        timer = setTimeout(() => {
            if (settled || res.destroyed) return;
            settled = true;
            waiting.delete(dispatch);
            sendError(req, res, 503, 'BACKEND_RELOADING', `Backend 正在开发重载，等待 ${readyWaitMs}ms 后仍未就绪；稍后可沿原 operationId/taskId 恢复。`);
        }, readyWaitMs);
        timer.unref?.();
        res.once('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiting.delete(dispatch);
        });
    });
    // WebSocket 升级必须原样透传：没有 upgrade 监听时 Node 会把它当普通请求交给上面的
    // handler，后端只会回 404，浏览器永远握不上手（画布协作、实时增量全部失效）。
    server.on('upgrade', (req, socket, head) => {
        if (backendReady) return forwardUpgrade(req, socket, head, targetPort, backendHost, tunnels);
        // 与 HTTP 一致：重载期间明确拒绝，客户端按自身退避重试，不把半开连接当成已连上。
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n');
    });
    server.on('error', error => {
        if (error.code !== 'EADDRINUSE' || closed || listenRetry) return;
        listenRetry = setTimeout(() => {
            listenRetry = undefined;
            if (!closed) server.listen(port, currentListenHost);
        }, LISTEN_RETRY_MS);
        listenRetry.unref?.();
    });
    server.listen(port, currentListenHost);
    return {
        server,
        setBackendReady(value) {
            backendReady = Boolean(value);
            if (!backendReady) {
                for (const dispatch of [...waiting]) dispatch.reject();
                for (const socket of [...tunnels]) socket.destroy();
                return;
            }
            for (const dispatch of [...waiting]) dispatch();
        },
        setListenHost(nextHost) {
            const requestedHost = nextHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
            if (requestedHost === currentListenHost && server.listening) return Promise.resolve();
            backendReady = false;
            for (const dispatch of [...waiting]) dispatch.reject();
            for (const socket of [...tunnels]) socket.destroy();
            return new Promise((resolve, reject) => {
                const bind = () => {
                    currentListenHost = requestedHost;
                    const cleanup = () => {
                        server.off('listening', onListening);
                        server.off('error', onError);
                    };
                    const onListening = () => { cleanup(); resolve(); };
                    const onError = error => {
                        if (error.code === 'EADDRINUSE') return;
                        cleanup(); reject(error);
                    };
                    server.once('listening', onListening);
                    server.on('error', onError);
                    server.listen(port, currentListenHost);
                };
                if (!server.listening) return bind();
                server.close(error => error ? reject(error) : bind());
                server.closeAllConnections?.();
            });
        },
        close() {
            closed = true;
            clearTimeout(listenRetry);
            for (const dispatch of [...waiting]) dispatch.reject();
            for (const socket of [...tunnels]) socket.destroy();
            if (server.listening) server.close();
        },
    };
}

function forward(req, res, targetPort, backendHost) {
    const headers = { ...req.headers, host: `${backendHost}:${targetPort}`, 'x-forwarded-for': req.socket.remoteAddress || '' };
    delete headers.connection;
    delete headers['proxy-connection'];
    const upstream = http.request({ host: backendHost, port: targetPort, method: req.method, path: req.url, headers }, response => {
        res.writeHead(response.statusCode || 502, response.statusMessage, response.headers);
        response.pipe(res);
    });
    let forwarded = false;
    upstream.once('finish', () => { forwarded = true; });
    upstream.once('error', error => {
        if (res.headersSent || res.destroyed) return res.destroy();
        const write = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
        res.setHeader('Retry-After', '1');
        sendError(req, res, 503, write && forwarded ? 'BACKEND_OUTCOME_UNKNOWN' : 'BACKEND_RELOADING', write && forwarded
            ? `Backend 接收请求后连接中断，结果未知。请用原 operationId/taskId 查询回执，不要重放写请求。（${error.message}）`
            : `Backend 重载期间暂不可用；稍后读取原状态。（${error.message}）`, write && forwarded);
    });
    req.once('aborted', () => upstream.destroy(new Error('client request aborted')));
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(new Error('client response closed')); });
    req.pipe(upstream);
}

/** 把 Upgrade 请求按原始字节转发给 Backend，保留 Connection/Upgrade 头与后续双向流。 */
function forwardUpgrade(req, socket, head, targetPort, backendHost, tunnels) {
    const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`];
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index];
        if (['host', 'proxy-connection', 'x-forwarded-for'].includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
    }
    lines.push(`x-forwarded-for: ${req.socket.remoteAddress || ''}`, `host: ${backendHost}:${targetPort}`, '', '');
    const upstream = net.connect({ host: backendHost, port: targetPort });
    tunnels.add(socket);
    const shutdown = () => { tunnels.delete(socket); socket.destroy(); upstream.destroy(); };
    upstream.once('connect', () => {
        upstream.write(lines.join('\r\n'));
        if (head?.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.once('error', shutdown);
    socket.once('error', shutdown);
    socket.once('close', () => { tunnels.delete(socket); upstream.destroy(); });
    upstream.once('close', () => socket.destroy());
}

function sendError(req, res, status, code, error, outcomeUnknown = false) {
    if (res.destroyed || res.writableEnded) return;
    applyCorsHeaders(req, res);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (status === 503 && !res.hasHeader('Retry-After')) res.setHeader('Retry-After', '1');
    res.end(JSON.stringify({ ok: false, code, ...(outcomeUnknown ? { outcomeUnknown: true } : {}), error }));
}
