#!/usr/bin/env node
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const pkg = createRequire(import.meta.url)("./package.json");
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*", "access-control-max-age": "86400" };
const skipRequest = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
const skipResponse = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; };
const targetFrom = (url) => { let target = url.slice(1); try { target = decodeURI(target); } catch {} target = target.replace(/^(https?:)\/*/i, "$1//"); return /^https?:\/\/[^/]/i.test(target) ? target : ""; };
const readBody = (req) => new Promise((resolve, reject) => { const chunks = []; req.on("data", (chunk) => chunks.push(chunk)); req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject); });
function headers(req) { return Object.fromEntries(Object.entries(req.headers).filter(([key, value]) => !skipRequest.has(key) && value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])); }
function upstreamHeaders(response) { const result = { ...cors }; response.headers.forEach((value, key) => { if (!skipResponse.has(key) && !key.startsWith("access-control-")) result[key] = value; }); return result; }
async function forward(req, res, target) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstream = await fetch(target, { method: req.method, headers: headers(req), body, redirect: "follow" });
    res.writeHead(upstream.status, upstreamHeaders(upstream));
    if (!upstream.body) return res.end();
    const stream = Readable.fromWeb(upstream.body); res.on("close", () => stream.destroy()); stream.pipe(res);
}
export function createProxyServer() {
    return createServer((req, res) => {
        if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
        const target = targetFrom(req.url || "/");
        if (!target) return res.writeHead(200, { ...cors, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ app: "infinite-canvas", proxy: pkg.name, version: pkg.version, usage: "/<full-target-url>" }));
        forward(req, res, target).catch((error) => { if (res.headersSent) return res.destroy(); res.writeHead(502, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
    });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) { console.log(`Usage: npx ${pkg.name} [--port 23210] [--host 127.0.0.1]`); process.exit(0); }
    const port = Number(arg("port", process.env.PORT || 23210));
    const host = arg("host", process.env.HOST || "127.0.0.1");
    createProxyServer().listen(port, host, () => console.log(`${pkg.name} v${pkg.version} listening on http://${host}:${port}`));
}
