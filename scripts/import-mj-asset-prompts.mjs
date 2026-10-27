// 把「MJ 码图对照库」HTML 转换成无限画布提示词源 JSON + webp 缩略图资源。
// 用法：
//   node scripts/import-mj-asset-prompts.mjs --source "<HTML 或目录>" [--out web/public/prompt-sources]
// 默认输出到 web/public/prompt-sources，按 char/scene/juwu 拆成 3 个 JSON（mj-char/scene/juwu.json），
// 缩略图转成 webp 落在 <out>/mj-assets/。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import sharp from "sharp";

const args = process.argv.slice(2);
function arg(name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const repoRoot = resolve(import.meta.dirname, "..");
const sourceArg = arg("source", "");
const outDir = resolve(repoRoot, arg("out", "web/public/prompt-sources"));

if (!sourceArg) {
    console.error("缺少 --source <MJ码图对照.html 或其所在目录>");
    process.exit(1);
}

const sourcePath = resolve(sourceArg);
const htmlPath = statSync(sourcePath).isDirectory() ? join(sourcePath, "MJ码图对照_完整版", "MJ码图对照.html") : sourcePath;
if (!existsSync(htmlPath)) {
    const fallback = join(sourcePath, "MJ码图对照.html");
    if (!existsSync(fallback)) {
        console.error(`找不到码图对照 HTML: ${htmlPath}`);
        process.exit(1);
    }
}
const htmlFullPath = existsSync(htmlPath) ? htmlPath : join(sourcePath, "MJ码图对照.html");
const sourceDir = resolve(htmlFullPath, "..");
const html = readFileSync(htmlFullPath, "utf8");

// ---------------------------------------------------------------- ITEMS ----

function extractBalanced(text, openIndex) {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === "\\") i += 1;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") quote = char;
        else if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(openIndex, i + 1);
        }
    }
    throw new Error("ITEMS 括号未闭合");
}

const itemsMarker = "const ITEMS=";
const itemsStart = html.indexOf(itemsMarker);
if (itemsStart < 0) throw new Error("HTML 中未找到 const ITEMS");
const itemsJson = extractBalanced(html, html.indexOf("{", itemsStart));
/** @type {Record<string, {prompt:string, codes:string, codeparam:string, vibe:string, thumb:string, orig:string}>} */
const ITEMS = JSON.parse(itemsJson);

// ------------------------------------------------------------ 卡片解析 ----

const tabTitles = {
    char: "角色·人像",
    scene: "场景·环境",
    juwu: "巨物·怪兽",
};

const stripTags = (value) => value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** 按出现顺序解析 h2 分组与卡片，卡片继承其所在分组与 tab。 */
const segments = [];
const splitRe = /<h2 id="(char|scene|juwu)-(\d+)"[^>]*>([\s\S]*?)<\/h2>|<div class="card (solo|multi)">([\s\S]*?)(?=<div class="card |<\/div>\s*<\/div>\s*<h2|<\/div>\s*<div class="tabpane|<\/body>)/g;
let currentTab = null;
let currentGroup = "";
let match;
while ((match = splitRe.exec(html)) !== null) {
    if (match[1]) {
        currentTab = match[1];
        currentGroup = stripTags(match[3]).replace(/\s*·\s*\d+\s*图\s*$/, "").trim();
        continue;
    }
    if (!match[4]) continue;
    const block = match[5] || "";
    const keyMatch = block.match(/openM\('([^']+)'\)/);
    if (!keyMatch) continue;
    const srcMatch = block.match(/src="([^"]+)"/);
    const codeMatch = block.match(/<div class="codebox">([\s\S]*?)<\/div>/);
    const tasteMatch = block.match(/<span class="taste">([\s\S]*?)<\/span>/);
    const medMatch = block.match(/<span class="med">([\s\S]*?)<\/span>/);
    const qMatches = [...block.matchAll(/<span class="q">([\s\S]*?)<\/span>/g)].map((item) => stripTags(item[1]));
    const comboMatch = block.match(/<div class="combo">([\s\S]*?)<\/div>/);
    segments.push({
        key: keyMatch[1],
        tab: currentTab,
        group: currentGroup,
        variant: match[4] === "solo" ? "独码" : "混码",
        thumb: srcMatch ? srcMatch[1] : "",
        codes: codeMatch ? stripTags(codeMatch[1]) : "",
        tone: tasteMatch ? stripTags(tasteMatch[1]).replace(/^色调:/, "") : "",
        medium: medMatch ? stripTags(medMatch[1]).replace(/^介质:/, "") : "",
        style: qMatches[0] || "",
        params: qMatches[1] || "",
        combo: comboMatch ? stripTags(comboMatch[1]) : "",
    });
}

/** 介质描述在原文里写法极碎（30+ 变体），归一成少量可筛标签。 */
function normalizeMedium(raw) {
    const text = (raw || "").trim();
    if (!text) return "";
    if (/半写实|绘感|插画|动漫|厚涂|国漫/.test(text)) return "半写实绘感";
    if (/真实照片|实拍|照片/.test(text)) return "真实照片质感";
    if (/3D|CG|引擎|渲染|Unreal/.test(text)) return "3D-CG渲染";
    if (/胶片/.test(text)) return "胶片质感";
    return text.slice(0, 12);
}

// ------------------------------------------------------------ 组装条目 ----

const imageDir = join(outDir, "mj-assets");
mkdirSync(imageDir, { recursive: true });

const usedNames = new Map();
const groups = { char: [], scene: [], juwu: [] };
const missingThumbs = [];
const today = new Date().toISOString();

for (const segment of segments) {
    const item = ITEMS[segment.key];
    if (!item || !item.prompt) continue;
    const thumb = segment.thumb || item.thumb || "";
    const thumbPath = join(sourceDir, thumb.split("/").join("/"));
    const fileName = basename(thumb);
    if (!fileName) continue;
    if (!existsSync(thumbPath)) {
        missingThumbs.push(thumb);
        continue;
    }
    let targetName = fileName;
    if (usedNames.has(targetName) && usedNames.get(targetName) !== thumb) {
        targetName = `${segment.key}-${fileName}`;
    }
    usedNames.set(targetName, thumb);

    // 直接转成 webp 缩略图（最长边 512，质量 80），不再落 jpg。
    const webpName = `${targetName.replace(extname(targetName), "")}.webp`;
    await sharp(thumbPath)
        .resize({ width: 512, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(join(imageDir, webpName));

    const category = tabTitles[segment.tab] || "MJ 资产";
    const titleParts = [...new Set([category, segment.group, segment.style].filter(Boolean))];
    const mediumTag = normalizeMedium(segment.medium);
    const tags = [category, segment.group, segment.variant, mediumTag].filter(Boolean);
    groups[segment.tab].push({
        id: `mj-${segment.key}`,
        title: `${titleParts.join(" · ")} #${segment.key.replace(/\D/g, "") || segment.key}`,
        prompt: item.prompt,
        description: [segment.tone ? `色调：${segment.tone}` : "", segment.medium ? `介质：${segment.medium}` : "", segment.combo ? `组合：${segment.combo}` : ""].filter(Boolean).join(" ｜ "),
        coverUrl: `/prompt-sources/mj-assets/${webpName}`,
        referenceImageUrls: [],
        tags: [...new Set(tags)],
        preview: [item.codes ? `码：${item.codes}` : "", segment.params ? `参数：${segment.params}` : ""].filter(Boolean).join("\n"),
        createdAt: today,
        updatedAt: today,
        author: "MJ 码图对照库",
        sourceUrl: "",
        imageMode: "text-to-image",
        imageModel: "Midjourney",
    });
}

const fileByTab = { char: "mj-char", scene: "mj-scene", juwu: "mj-juwu" };
let total = 0;
for (const tab of ["char", "scene", "juwu"]) {
    const arr = groups[tab];
    const outPath = join(outDir, `${fileByTab[tab]}.json`);
    writeFileSync(outPath, `${JSON.stringify(arr, null, 2)}\n`, "utf8");
    console.log(`写入 ${arr.length} 条 → ${outPath}`);
    total += arr.length;
}

console.log(`共 ${total} 条`);
console.log(`图片 ${readdirSync(imageDir).length} 张 → ${imageDir}`);
if (missingThumbs.length) console.warn(`缺失缩略图 ${missingThumbs.length} 个:`, missingThumbs.slice(0, 5));
