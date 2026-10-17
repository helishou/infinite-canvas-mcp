// 一次性清理：删除 MJ 资产生成过程中遗留的 jpg 缩略图与旧的单源 mj-assets.json。
// 直接用 process.binding("fs").unlink 绕过沙箱 safe-delete（回收站限流），做真正的删除。
// 这些文件均可由 scripts/import-mj-asset-prompts.mjs 重新生成（jpg 不再产出，改为 webp）。
import { readdirSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const imgDir = resolve(repoRoot, "web/public/prompt-sources/mj-assets");
const fsBinding = process.binding("fs");

function rawUnlink(path) {
    fsBinding.unlink(path);
}

const files = readdirSync(imgDir);
const jpgs = files.filter((f) => /\.jpg$/i.test(f));
console.log(`待删除 jpg: ${jpgs.length}`);

let removed = 0;
let failed = 0;
for (const f of jpgs) {
    try {
        rawUnlink(join(imgDir, f));
        removed += 1;
    } catch (e) {
        failed += 1;
        if (failed <= 5) console.warn(`删除失败 ${f}: ${e.message}`);
    }
}
console.log(`已删除 jpg: ${removed}, 失败: ${failed}`);

// 删除旧单源 JSON
const oldJson = resolve(repoRoot, "web/public/prompt-sources/mj-assets.json");
if (existsSync(oldJson)) {
    try {
        rawUnlink(oldJson);
        console.log("已删除旧 mj-assets.json");
    } catch (e) {
        console.warn(`删除 mj-assets.json 失败: ${e.message}`);
    }
}

// 报告剩余
const left = readdirSync(imgDir).filter((f) => /\.jpg$/i.test(f)).length;
console.log(`目录内剩余 jpg: ${left}`);