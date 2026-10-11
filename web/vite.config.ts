import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const backendTarget = process.env.CANVAS_TEST_BACKEND || "http://127.0.0.1:17370";
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export default defineConfig({
    cacheDir: process.env.CANVAS_TEST_VITE_CACHE || "node_modules/.vite",
    base: process.env.VITE_BASE || "/",
    plugins: [react()],
    // 开发模式下把总后台媒体接口代理为同源，避免前端直连 127.0.0.1:17370 触发跨域 CORS。
    // 仅代理 /media（web 无 /media 客户端路由，不会与 SPA 冲突）；/canvas 等已存在 SPA 路由，不可代理。
    // 另外代理 /events 与 /agent：这两个是长连接 SSE 流。若浏览器把 127.0.0.1 走了系统代理，
    // 代理会截断 SSE（net::ERR_INCOMPLETE_CHUNKED_ENCODING）；改走 Vite 同源代理后由 Node 转发，
    // 浏览器不再直连 17370，长连接不再被代理掐断。/events、/agent 均非 SPA 路由，不会与前端冲突。
    server: {
        ...(process.env.CANVAS_TEST_VITE_CACHE ? { hmr: false, watch: null } : {}),
        // H3 内置插件走源码 HMR；构建会覆盖 public 中的分发包，Windows 上监听该文件可能触发 EBUSY。
        // 静态插件文件仍由 Vite 提供。
        watch: {
            ignored: [
                resolve(webDir, "_test_report.txt"),
                resolve(webDir, "_diag.txt"),
                resolve(webDir, "public/plugins/minimax-h3.js"),
            ],
        },
        proxy: {
            "/api": { target: backendTarget, changeOrigin: true },
            "/media": { target: backendTarget, changeOrigin: true },
            "/events": { target: backendTarget, changeOrigin: true },
            "/agent": { target: backendTarget, changeOrigin: true },
            "/canvas/realtime": { target: backendTarget.replace(/^http/, "ws"), ws: true, changeOrigin: true },
        },
    },
    resolve: {
        dedupe: ["react", "react-dom"],
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
