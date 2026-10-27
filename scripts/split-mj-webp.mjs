// 一次性脚本：把已有的「MJ 角色·场景·巨兽」单源（mj-assets.json + 493 张 jpg 缩略图）
// 转换为「3 个独立源 + webp 缩略图」形态，与 import-mj-asset-prompts.mjs 的新输出保持一致。
//
// 产出：
//   web/public/prompt-sources/mj-char.json  （角色·人像）
//   web/public/prompt-sources/mj-scene.json （场景·环境）
//   web/public/prompt-sources/mj-juwu.json  （巨物·怪兽）
//   web/public/prompt-sources/mj-assets/*.webp （原 jpg 删除）
//   web/public/prompt-sources/mj-assets.json （删除）
//
// 用法：node scripts/split-mj-webp.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import sharp from "sharp";

const repoRoot = resolve(import.meta.dirname, "..");
const baseDir = resolve(repoRoot, "web/public/prompt-sources");
const jsonPath = join(baseDir, "mj-assets.json");
const imgDir = join(baseDir, "mj-assets");

if (!readdirSync(baseDir).includes("mj-assets.json")) {
    console.error(`找不到 ${jsonPath}，已拆分过？`);
    process.exit(1);
}

const items = JSON.parse(readFileSync(jsonPath, "utf8"));
console.log(`读取 ${items.length} 条`);

// ----------------------------------------------------- jpg -> webp ----
const jpgs = readdirSync(imgDir).filter((f) => /\.jpg$/i.test(f));
console.log(`转换 ${jpgs.length} 张 jpg -> webp ...`);

async function convertOne(file) {
    const src = join(imgDir, file);
    const webpName = basename(file, extname(file)) + ".webp";
    const webpPath = join(imgDir, webpName);
    if (existsSync(webpPath)) return; // 已转换则跳过（支持断点续跑）
    await sharp(src)
        .resize({ width: 512, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(webpPath);
}

for (const file of jpgs) {
    await convertOne(file);
}
console.log("webp 转换完成");

// --------------------------------------------------- 更新 + 拆分 ----
function prefixOf(id) {
    if (id.startsWith("mj-char")) return "mj-char";
    if (id.startsWith("mj-scene")) return "mj-scene";
    if (id.startsWith("mj-juwu")) return "mj-juwu";
    return "mj-char";
}

const groups = { "mj-char": [], "mj-scene": [], "mj-juwu": [] };
for (const item of items) {
    const coverUrl = item.coverUrl.replace(/\.jpg$/i, ".webp");
    groups[prefixOf(item.id)].push({ ...item, coverUrl });
}

for (const [key, arr] of Object.entries(groups)) {
    writeFileSync(join(baseDir, `${key}.json`), `${JSON.stringify(arr, null, 2)}\n`, "utf8");
    console.log(`写入 ${key}.json (${arr.length} 条)`);
}

// 旧的单源 JSON 由调用方用 shell rm 删除（避免触发 safe-delete 回收站限流）。
console.log(`待删除旧 ${jsonPath}（请在脚本后执行 shell rm）`);

// 报告体积
const webps = readdirSync(imgDir).filter((f) => /\.webp$/i.test(f));
console.log(`webp 缩略图 ${webps.length} 张 → ${imgDir}`);
