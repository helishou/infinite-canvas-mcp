import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyNetworkEnvironment, type ResolvedConfig } from "./config.js";
import { applyNetworkSettings } from "./server/connection-routes.js";

test("部署网络变量覆盖已有文件和 SQLite 设置；来源严格校验", () => {
    const config: ResolvedConfig = { url: "http://127.0.0.1:17370", token: "test", port: 17370, listenHost: "127.0.0.1", origins: ["http://localhost:3001"] };
    const previous = { host: process.env.INFINITE_CANVAS_LISTEN_HOST, origins: process.env.INFINITE_CANVAS_ORIGINS };
    try {
        process.env.INFINITE_CANVAS_LISTEN_HOST = "0.0.0.0";
        process.env.INFINITE_CANVAS_ORIGINS = "https://canvas.example.com,https://canvas.example.com/";
        applyNetworkSettings(config, { lanEnabled: false, origins: ["http://old:3001"] });
        assert.equal(config.listenHost, "0.0.0.0");
        assert.deepEqual(config.origins, ["https://canvas.example.com"]);
        for (const origin of ["*", "https://x/path", "https://u:p@x", "https://x?token=y", "https://x#y", "file:///tmp", "https://x,"]) assert.throws(() => applyNetworkEnvironment(config, { INFINITE_CANVAS_ORIGINS: origin }));
        assert.throws(() => applyNetworkEnvironment(config, { INFINITE_CANVAS_LISTEN_HOST: "typo" }));
    } finally {
        for (const [key, value] of [["INFINITE_CANVAS_LISTEN_HOST", previous.host], ["INFINITE_CANVAS_ORIGINS", previous.origins]]) {
            if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
        }
    }
});

test("隔离数据目录中密钥跨启动保持稳定，显式端口和密钥覆盖旧配置", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-deploy-config-"));
    const run = (overrides: NodeJS.ProcessEnv = {}) => {
        const env = { ...process.env, INFINITE_CANVAS_DATA_DIR: directory, INFINITE_CANVAS_MEDIA_DIR: "", INFINITE_CANVAS_BACKEND_TOKEN: "", INFINITE_CANVAS_LISTEN_HOST: "", INFINITE_CANVAS_ORIGINS: "", PORT: "", ...overrides };
        const source = "import { loadConfig, MEDIA_DIR } from './src/config.ts'; const c = loadConfig(true); console.log(JSON.stringify({ ...c, mediaDir: MEDIA_DIR }));";
        return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: path.resolve(import.meta.dirname, ".."), env, encoding: "utf8" }));
    };
    try {
        const first = run();
        assert.equal(first.mediaDir, path.join(directory, "runtime-media"));
        assert.ok(first.token);
        assert.equal(run().token, first.token);
        const overridden = run({ PORT: "19370", INFINITE_CANVAS_BACKEND_TOKEN: "deployment-test-token", INFINITE_CANVAS_LISTEN_HOST: "0.0.0.0", INFINITE_CANVAS_ORIGINS: "https://canvas.example.com" });
        assert.equal(overridden.token, "deployment-test-token");
        assert.equal(overridden.url, "http://127.0.0.1:19370");
        assert.deepEqual(overridden.origins, ["https://canvas.example.com"]);
        assert.equal(overridden.listenHost, "0.0.0.0");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
