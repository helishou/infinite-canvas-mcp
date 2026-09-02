import { buildPlugin } from "@infinite-canvas/plugin-sdk/build";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

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
