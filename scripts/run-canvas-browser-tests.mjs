import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "collaboration";
if (!["collaboration", "performance"].includes(mode)) throw new Error("Expected collaboration or performance");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-browser-"));
const artifacts = path.resolve(root, "artifacts/browser-tests", `${mode}-${Date.now()}`);
fs.mkdirSync(artifacts, { recursive: true });
const children = [];
const streams = [];
async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}
const backendPort = await freePort();
let webPort = await freePort();
while (webPort === backendPort) webPort = await freePort();
const backend = `http://127.0.0.1:${backendPort}`;
const web = `http://localhost:${webPort}`;
const token = crypto.randomBytes(24).toString("hex");
const agentConfigDir = path.join(directory, "agent");
fs.mkdirSync(agentConfigDir);
const env = { ...process.env, PORT: String(backendPort), INFINITE_CANVAS_DATA_DIR: directory, INFINITE_CANVAS_MEDIA_DIR: path.join(directory, "media"), INFINITE_CANVAS_AGENT_CONFIG_DIR: agentConfigDir, CANVAS_TEST_VITE_CACHE: path.join(directory, "vite-cache"), CANVAS_TEST_BACKEND: backend, CANVAS_TEST_WEB: web, CANVAS_TEST_ARTIFACTS: artifacts };
fs.writeFileSync(path.join(agentConfigDir, "canvas-agent.json"), JSON.stringify({ url: backend, token, backendUrl: backend, workspace: { workspacePath: path.join(directory, "agent-workspace") } }));
fs.writeFileSync(path.join(directory, "backend.json"), JSON.stringify({ token, port: backendPort, url: backend, origins: [web, `http://127.0.0.1:${webPort}`], listenHost: "127.0.0.1" }));
function launch(name, args, cwd = root) {
    const log = fs.createWriteStream(path.join(artifacts, `${name}.log`));
    streams.push(log);
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout.pipe(log); child.stderr.pipe(log);
    child.on("error", (error) => log.write(String(error)));
    return child;
}
async function ready(url, child) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode) throw new Error(`Test server exited; see ${artifacts}`);
        try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Test server readiness failed: ${url}; see ${artifacts}`);
}
async function stopChildren() {
    for (const child of children.toReversed()) {
        if (child.exitCode !== null || child.signalCode) continue;
        const ended = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (child.exitCode === null && !child.signalCode) { child.kill("SIGKILL"); await ended; }
    }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stopChildren().then(() => process.exit(1)); });
try {
    const api = launch("backend", ["dist/index.js"], path.join(root, "backend"));
    const webRequire = createRequire(path.join(root, "web/package.json"));
    const viteCli = path.join(path.dirname(webRequire.resolve("vite/package.json")), "bin/vite.js");
    const vite = launch("vite", [viteCli, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], path.join(root, "web"));
    await Promise.all([ready(backend + "/health", api), ready(web, vite)]);
    const script = mode === "performance" ? "benchmark-canvas-browser.mjs" : "test-canvas-text-browser.mjs";
    const test = launch("test", [path.join(root, "scripts", script), ...process.argv.slice(3)]);
    test.stdout.on("data", (chunk) => process.stdout.write(chunk));
    test.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const code = await new Promise((resolve, reject) => { test.once("error", reject); test.once("exit", (code) => resolve(code ?? 1)); });
    process.exitCode = code;
} finally {
    await stopChildren();
    for (const stream of streams) stream.end();
    console.log(`Browser test artifacts: ${artifacts}`);
    // Only the freshly allocated test directory may be removed.
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith("canvas-browser-")) throw new Error("Invalid test cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
}
