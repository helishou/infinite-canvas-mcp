// 一次性脚本：把已生成的 MJ webp 缩略图就地重新压缩到更小体积（quality 70, 最长边 400px）。
// 直接覆盖原文件，无需删除。用于把总体积压到 10MB 以内。
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

const repoRoot = resolve(import.meta.dirname, "..");
const imgDir = resolve(repoRoot, "web/public/prompt-sources/mj-assets");
const fsBinding = process.binding("fs");
const webps = readdirSync(imgDir).filter((f) => /\.webp$/i.test(f));
console.log(`重新压缩 ${webps.length} 张 webp (quality 70, max 400px) ...`);

function rawUnlink(path, attempt = 0) {
    try {
        fsBinding.unlink(path);
    } catch (e) {
        if (attempt < 5) {
            // EBUSY: Windows/Defender 短暂占用，重试
            return new Promise((r) => setTimeout(r, 120)).then(() => rawUnlink(path, attempt + 1));
        }
        throw e;
    }
}

for (const f of webps) {
    const p = join(imgDir, f);
    // 先整张读入内存（sharp 处理完即关闭输入句柄），避免 unlink 时文件仍被占用
    const buf = await sharp(p).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    await rawUnlink(p);
    writeFileSync(p, buf);
}
console.log("完成");