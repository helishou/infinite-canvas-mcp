// 共享构建助手:插件的 build.mjs 只需一行 `buildPlugin(import.meta.url)`。
// 统一 esbuild 配置(automatic JSX 指向本 SDK、react external、TS/TSX/CSS loader、
// 产物写入插件 dist/ 并可供 URL 安装),消除各插件重复的构建脚本。

import { build, context } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} metaUrl 插件 build.mjs 的 import.meta.url
 * @param {{ name?: string, entry?: string, publicDir?: string, esbuild?: object, plugins?: import("esbuild").Plugin[] }} [overrides]
 */
export async function buildPlugin(metaUrl, overrides = {}) {
    const root = dirname(fileURLToPath(metaUrl));
    const name = overrides.name ?? basename(root); // 目录名即产物名,如 markdown → markdown.js
    const distDir = join(root, "dist");
    // 开发时同步到前端静态目录,供手动 URL 安装或 VITE_DEV_PLUGINS 热刷新。
    const publicDir = overrides.publicDir ?? join(root, "..", "..", "..", "web", "public", "plugins");
    const watch = process.argv.includes("--watch");
    const entry = overrides.entry ?? join(root, "src", "index.tsx");

    const syncToPublic = {
        name: "sync-to-public",
        setup(builder) {
            builder.onEnd(async (result) => {
                if (result.errors.length) return;
                await mkdir(publicDir, { recursive: true });
                await cp(join(distDir, `${name}.js`), join(publicDir, `${name}.js`));
                console.log(`[${name}] synced → web/public/plugins/${name}.js`);
            });
        },
    };

    const options = {
        entryPoints: [entry],
        outfile: join(distDir, `${name}.js`),
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2020",
        // automatic JSX → 转发到本 SDK 的 jsx-runtime(内部用宿主 React),插件无需自带 React
        jsx: "automatic",
        jsxImportSource: "@infinite-canvas/plugin-sdk",
        loader: { ".js": "jsx", ".jsx": "jsx", ".ts": "ts", ".tsx": "tsx", ".css": "text" },
        // 宿主提供单例 React,插件不打包 react;https:// 依赖 esbuild 自动 external
        external: ["react", "react-dom"],
        minify: !watch,
        plugins: [syncToPublic, ...(overrides.plugins ?? [])],
        ...overrides.esbuild,
    };

    if (watch) {
        const ctx = await context(options);
        await ctx.watch();
        console.log(`[${name}] watching src/ ...`);
    } else {
        await build(options);
        console.log(`[${name}] built → dist/${name}.js`);
    }
}
