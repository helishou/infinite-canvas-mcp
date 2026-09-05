import { buildPlugin } from "@infinite-canvas/plugin-sdk/build";
import { resolve, dirname } from "node:path";
import { readFile, copyFile, mkdir } from "node:fs/promises";
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

await buildPlugin(import.meta.url, {
    plugins: [rawPlugin],
    ...(process.env.NODE_ENV !== "production" ? { esbuild: { minify: false } } : {}),
});

// web/dist 是 vite build 的产物（构建时把 public/ 一起拷走），之后只重建插件不会更新 dist，
// 页面加载 dist 里的插件就会一直跑旧代码。这里顺手同步一份；dist 不存在（纯 dev 模式）时跳过。
try {
    const here = dirname(fileURLToPath(import.meta.url));
    const distDir = resolve(here, "../../../web/dist/plugins");
    await mkdir(distDir, { recursive: true });
    await copyFile(resolve(here, "../../../web/public/plugins/minimax-h3.js"), resolve(distDir, "minimax-h3.js"));
    console.log("[minimax-h3] synced → web/dist/plugins/minimax-h3.js");
} catch { /* 没有 dist 构建产物时不处理 */ }
