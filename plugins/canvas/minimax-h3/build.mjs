import { buildPlugin } from "@infinite-canvas/plugin-sdk/build";
import { resolve, dirname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// 支持 Vite 风格的 `?raw` 导入(如 `import x from "./a.md?raw")`，
// 由 esbuild 直接读取文件内容并以字符串 default 导出。
// 否则 smart-storyboard.ts 引入的 `*.md?raw` / `*.txt?raw` 会让构建失败。
const rawPlugin = {
    name: "raw-loader",
    setup(builder) {
        builder.onResolve({ filter: /\?raw(\?.*)?$/ }, (args) => {
            const clean = args.path.replace(/\?raw(\?.*)?$/, "");
            return { path: resolve(args.resolveDir, clean), namespace: "raw" };
        });
        builder.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => {
            const contents = await readFile(args.path, "utf8");
            return { contents: `export default ${JSON.stringify(contents)};`, loader: "js" };
        });
    },
};

const here = dirname(fileURLToPath(import.meta.url));
const versionSource = await readFile(resolve(here, "../../../canvas-agent/src/plugins/minimax-h3/version.ts"), "utf8");
const version = versionSource.match(/H3_PLUGIN_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
if (!version) throw new Error("无法读取 H3 插件版本常量");

for (const [file, spaces] of [["package.json", 4], ["plugin.manifest.json", 2]]) {
    const path = resolve(here, file);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.version = version;
    await writeFile(path, `${JSON.stringify(manifest, null, spaces)}\n`, "utf8");
}
const lockPath = resolve(here, "package-lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.version = version;
lock.packages[""].version = version;
await writeFile(lockPath, `${JSON.stringify(lock, null, 4)}\n`, "utf8");

// H3 是宿主内置插件：Web 经 `@/lib/canvas/plugin-loader` 直接 import 本目录源码并打进宿主 JS，
// 不加载 web/public 下的 bundle（loader 以 HOST_SYSTEM_PLUGIN_IDS 跳过它）。
// 因此这里不向 web 同步任何副本，只产出 dist/minimax-h3.js 供外部宿主分发使用。
await buildPlugin(import.meta.url, {
    publicDir: null,
    plugins: [rawPlugin],
    ...(process.env.NODE_ENV !== "production" ? { esbuild: { minify: false } } : {}),
});
