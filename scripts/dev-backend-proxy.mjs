import http from 'node:http';

const DEFAULT_READY_WAIT_MS = 10_000;
const LISTEN_RETRY_MS = 250;

/** Keep the public development Backend endpoint bound while its watched child restarts. */
export function createStableBackendProxy({ port, targetPort, readyWaitMs = DEFAULT_READY_WAIT_MS, host = '127.0.0.1' }) {
    let backendReady = false;
    let closed = false;
    let listenRetry;
    const waiting = new Set();
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

function sendError(res, status, code, error, outcomeUnknown = false) {
    if (res.destroyed || res.writableEnded) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (status === 503 && !res.hasHeader('Retry-After')) res.setHeader('Retry-After', '1');
    res.end(JSON.stringify({ ok: false, code, ...(outcomeUnknown ? { outcomeUnknown: true } : {}), error }));
}
