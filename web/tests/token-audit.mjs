// 色彩与字号专项验收：在真实渲染上量对比度、纯白块和最小字号。
// 对比度用 canvas 做 CSS 颜色 → sRGB 转换，能正确处理 oklch（项目 token 用的是 oklch）。
// 用法：node web/tests/token-audit.mjs [--base http://localhost:3001]
import { chromium } from "playwright";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = argOf("--base", "http://localhost:3001").replace(/\/$/, "");
const routes = ["/", "/projects", "/assets", "/prompts", "/workflows", "/diagnostics/mcp", "/config"];

const browser = await chromium.launch();
const results = [];

for (const route of routes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("h1", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const snapshot = await page.evaluate(() => {
        // CSS 颜色（含 oklch）→ sRGB，借 canvas 做规范化。
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const toRgb = (color) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = "#000";
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return { r, g, b, a };
        };
        const luminance = ({ r, g, b }) => {
            const channel = (value) => {
                const s = value / 255;
                return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const contrast = (fg, bg) => {
            const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
            return (hi + 0.05) / (lo + 0.05);
        };
        const opaqueBgOf = (node) => {
            let el = node;
            while (el) {
                const { r, g, b, a } = toRgb(getComputedStyle(el).backgroundColor);
                if (a > 250) return { r, g, b };
                el = el.parentElement;
            }
            return { r: 255, g: 255, b: 255 };
        };
        const isVisible = (node) => {
            const box = node.getBoundingClientRect();
            if (box.width < 4 || box.height < 4) return false;
            if (box.bottom < 0 || box.top > window.innerHeight * 4) return false;
            const style = getComputedStyle(node);
            return style.visibility !== "hidden" && Number(style.opacity) > 0.2;
        };

        const lowContrast = [];
        let minFontSize = 999;
        let minFontSample = null;
        let textNodes = 0;
        // 画布节点内部与媒体覆盖层有自己的字号体系（节点缩略图角标、多人协作头像），
        // 它们的 9px 是空间所迫，不参与"正文最小字号"判定。
        const canvasScope = "[data-canvas-no-zoom], [data-canvas-node], .react-flow__node, [data-canvas-shortcuts-ignore]";

        for (const node of document.querySelectorAll("body *")) {
            if (node.closest("[aria-hidden='true']")) continue;
            // 只取"直接承载文字"的元素，避免容器重复计数。
            const ownText = [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent.trim()).join("");
            if (!ownText) continue;
            if (!isVisible(node)) continue;
            textNodes += 1;
            const style = getComputedStyle(node);
            const size = Number.parseFloat(style.fontSize);
            // SVG 里的文字是图形的一部分（节点编号、连接标签），不受 UI 字号体系约束。
            if (!node.closest(canvasScope) && !node.closest("svg") && size < minFontSize) {
                minFontSize = size;
                minFontSample = { text: ownText.slice(0, 18), size, cls: String(node.className || "").slice(0, 60), tag: node.tagName.toLowerCase() };
            }
            const ratio = contrast(toRgb(style.color), opaqueBgOf(node));
            // AA：正文 4.5，大号文本（≥18.66px 或 ≥14px 且加粗）3.0。
            const large = size >= 18.66 || (size >= 14 && Number(style.fontWeight) >= 700);
            const threshold = large ? 3 : 4.5;
            if (ratio < threshold) {
                lowContrast.push({ text: ownText.slice(0, 22), size, ratio: Math.round(ratio * 100) / 100, cls: String(node.className || "").slice(0, 46) });
            }
        }

        // 深色主题下不该出现大面积纯白背景。
        const whiteBlocks = [...document.querySelectorAll("body *")].filter((node) => {
            const { r, g, b, a } = toRgb(getComputedStyle(node).backgroundColor);
            if (a < 250 || r !== 255 || g !== 255 || b !== 255) return false;
            const box = node.getBoundingClientRect();
            return box.width * box.height > 4000 && box.top < window.innerHeight && box.bottom > 0;
        }).length;

        return {
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            textNodes,
            minFontSize: minFontSize === 999 ? null : minFontSize,
            minFontSample,
            lowContrastCount: lowContrast.length,
            worst: lowContrast.sort((a, b) => a.ratio - b.ratio).slice(0, 4),
            whiteBlocks,
        };
    });

    results.push({ route, ...snapshot });
    await context.close();
}

await browser.close();

console.table(results.map((item) => ({
    路由: item.route,
    主题: item.theme,
    文本节点: item.textNodes,
    最小字号: item.minFontSize,
    最小字号样本: item.minFontSample ? item.minFontSample.text + " @" + item.minFontSample.tag + "." + item.minFontSample.cls.slice(0, 28) : "",
    低于AA: item.lowContrastCount,
    纯白块: item.whiteBlocks,
})));

for (const item of results) {
    if (!item.lowContrastCount) continue;
    console.log(`\n${item.route} 最低对比度样本：`);
    for (const row of item.worst) console.log(`  ${row.ratio}:1  ${row.size}px  "${row.text}"  ${row.cls}`);
}

const failed = results.filter((item) => item.whiteBlocks > 0 || (item.minFontSize ?? 99) < 11);
console.log(`\n${failed.length ? `异常：${failed.map((item) => item.route).join(", ")}` : "纯白块 0、最小字号 ≥11px"}`);
if (failed.length) process.exitCode = 1;
