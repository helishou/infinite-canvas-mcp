import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest()],
    // 开发模式下把总后台媒体接口代理为同源，避免前端直连 127.0.0.1:17370 触发跨域 CORS。
    // 仅代理 /media（web 无 /media 客户端路由，不会与 SPA 冲突）；/canvas 等已存在 SPA 路由，不可代理。
    // 另外代理 /events 与 /agent：这两个是长连接 SSE 流。若浏览器把 127.0.0.1 走了系统代理，
    // 代理会截断 SSE（net::ERR_INCOMPLETE_CHUNKED_ENCODING）；改走 Vite 同源代理后由 Node 转发，
    // 浏览器不再直连 17370，长连接不再被代理掐断。/events、/agent 均非 SPA 路由，不会与前端冲突。
    server: {
        proxy: {
            "/media": { target: "http://127.0.0.1:17370", changeOrigin: true },
            "/events": { target: "http://127.0.0.1:17370", changeOrigin: true },
            "/agent": { target: "http://127.0.0.1:17370", changeOrigin: true },
        },
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
