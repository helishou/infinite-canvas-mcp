import http from 'node:http';
import net from 'node:net';

const DEFAULT_READY_WAIT_MS = 10_000;
const LISTEN_RETRY_MS = 250;

/** Keep the public development Backend endpoint bound while its watched child restarts. */
export function createStableBackendProxy({ port, targetPort, readyWaitMs = DEFAULT_READY_WAIT_MS, host = '127.0.0.1' }) {
    let backendReady = false;
    let closed = false;
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
            forward(req, res, targetPort, host);
        };
        if (backendReady) return dispatch();
        waiting.add(dispatch);
        timer = setTimeout(() => {
            if (settled || res.destroyed) return;
            settled = true;
            waiting.delete(dispatch);
            sendError(res, 503, 'BACKEND_RELOADING', `Backend 正在开发重载，等待 ${readyWaitMs}ms 后仍未就绪；稍后可沿原 operationId/taskId 恢复。`);
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
        if (backendReady) return forwardUpgrade(req, socket, head, targetPort, host, tunnels);
        // 与 HTTP 一致：重载期间明确拒绝，客户端按自身退避重试，不把半开连接当成已连上。
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n');
    });
    server.on('error', error => {
        if (error.code !== 'EADDRINUSE' || closed || listenRetry) return;
        listenRetry = setTimeout(() => {
            listenRetry = undefined;
            if (!closed) server.listen(port, host);
        }, LISTEN_RETRY_MS);
        listenRetry.unref?.();
    });
    server.listen(port, host);
    return {
        server,
        setBackendReady(value) {
            backendReady = Boolean(value);
            if (!backendReady) return;
            for (const dispatch of [...waiting]) dispatch();
        },
        close() {
            closed = true;
            clearTimeout(listenRetry);
            for (const dispatch of [...waiting]) waiting.delete(dispatch);
            for (const socket of [...tunnels]) socket.destroy();
            if (server.listening) server.close();
        },
    };
}

function forward(req, res, targetPort, host) {
    const headers = { ...req.headers, host: `${host}:${targetPort}` };
    delete headers.connection;
    delete headers['proxy-connection'];
    const upstream = http.request({ host, port: targetPort, method: req.method, path: req.url, headers }, response => {
        res.writeHead(response.statusCode || 502, response.statusMessage, response.headers);
        response.pipe(res);
    });
    let forwarded = false;
    upstream.once('finish', () => { forwarded = true; });
    upstream.once('error', error => {
        if (res.headersSent || res.destroyed) return res.destroy();
        const write = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
        res.setHeader('Retry-After', '1');
        sendError(res, 503, write && forwarded ? 'BACKEND_OUTCOME_UNKNOWN' : 'BACKEND_RELOADING', write && forwarded
            ? `Backend 接收请求后连接中断，结果未知。请用原 operationId/taskId 查询回执，不要重放写请求。（${error.message}）`
            : `Backend 重载期间暂不可用；稍后读取原状态。（${error.message}）`, write && forwarded);
    });
    req.once('aborted', () => upstream.destroy(new Error('client request aborted')));
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(new Error('client response closed')); });
    req.pipe(upstream);
}

/** 把 Upgrade 请求按原始字节转发给 Backend，保留 Connection/Upgrade 头与后续双向流。 */
function forwardUpgrade(req, socket, head, targetPort, host, tunnels) {
    const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`];
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index];
        if (['host', 'proxy-connection'].includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
    }
    lines.push(`host: ${host}:${targetPort}`, '', '');
    const upstream = net.connect({ host, port: targetPort });
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

function sendError(res, status, code, error, outcomeUnknown = false) {
    if (res.destroyed || res.writableEnded) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (status === 503 && !res.hasHeader('Retry-After')) res.setHeader('Retry-After', '1');
    res.end(JSON.stringify({ ok: false, code, ...(outcomeUnknown ? { outcomeUnknown: true } : {}), error }));
}
