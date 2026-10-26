// 可访问名称审计：找出没有可访问名（屏幕阅读器只会念"按钮"）的可交互元素。
// 名称来源按 ARIA 规范取：aria-label > aria-labelledby 文本 > title > 文本内容 > 内部 img 的 alt。
// 用法：node web/tests/a11y-audit.mjs [--base http://localhost:3001] [--verbose]
import { chromium } from "playwright";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = argOf("--base", "http://localhost:3001").replace(/\/$/, "");
const verbose = args.includes("--verbose");
const routes = ["/", "/projects", "/canvas", "/production", "/assets", "/prompts", "/image", "/video", "/workflows", "/config", "/diagnostics/mcp", "/analytics/local"];

const browser = await chromium.launch();
const rows = [];

for (const route of routes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
        await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForSelector("h1", { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(1600);

        const result = await page.evaluate(() => {
            const nameOf = (el) => {
                const aria = el.getAttribute("aria-label");
                if (aria && aria.trim()) return aria.trim();
                const labelledBy = el.getAttribute("aria-labelledby");
                if (labelledBy) {
                    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join("").trim();
                    if (text) return text;
                }
                const title = el.getAttribute("title");
                if (title && title.trim()) return title.trim();
                const text = (el.textContent || "").replace(/\s+/g, " ").trim();
                if (text) return text;
                const img = el.querySelector("img[alt]");
                if (img?.getAttribute("alt")?.trim()) return img.getAttribute("alt").trim();
                return "";
            };
            const isVisible = (el) => {
                // 隐藏面板（Agent 对话抽屉用 translateX(100%) 挪到视口右侧）和 inert/aria-hidden 区域不算可交互。
                if (el.closest("[aria-hidden='true'], [inert]")) return false;
                const box = el.getBoundingClientRect();
                if (box.width < 6 || box.height < 6) return false;
                // 横向也要判：只用 top/bottom 会把屏幕右侧外面那半个面板算成可见。
                if (box.bottom < 0 || box.top > window.innerHeight) return false;
                if (box.right < 0 || box.left > window.innerWidth) return false;
                const style = getComputedStyle(el);
                return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.15;
            };
            const nodes = [...document.querySelectorAll("button, a[href], [role='button'], [role='tab'], input[type='checkbox'], input[type='radio']")];
            const visible = nodes.filter(isVisible);
            const unnamed = visible.filter((el) => !nameOf(el));
            // 用 svg 的 class 反推图标种类，便于批量为同一图标统一命名。
            const iconOf = (el) => {
                const svg = el.querySelector("svg");
                if (!svg) return el.tagName.toLowerCase();
                const cls = String(svg.getAttribute("class") || "");
                const match = cls.match(/lucide-([a-z-]+)/);
                if (match) return match[1];
                const shape = svg.querySelector("path, circle, rect, line");
                return shape ? "svg" : "svg-empty";
            };
            return {
                visible: visible.length,
                unnamed: unnamed.length,
                samples: unnamed.slice(0, 40).map((el) => ({
                    icon: iconOf(el),
                    tag: el.tagName.toLowerCase(),
                    cls: String(el.className || "").slice(0, 70),
                    inTooltip: Boolean(el.closest("[class*='ant-tooltip'], [data-tooltip]")),
                    html: el.outerHTML.replace(/\s+/g, " ").slice(0, 300),
                })),
            };
        });

        rows.push({ route, ...result });
    } catch (error) {
        rows.push({ route, error: String(error).slice(0, 120) });
    } finally {
        await context.close();
    }
}

await browser.close();

console.table(rows.map((item) => ({ 路由: item.route, 可交互: item.visible, 无名称: item.unnamed })));
const total = rows.reduce((sum, item) => sum + (item.unnamed || 0), 0);
console.log(`\n合计无名称：${total}`);

if (verbose) {
    for (const item of rows) {
        if (!item.samples?.length) continue;
        console.log(`\n${item.route}`);
        for (const sample of item.samples) console.log(`  [${sample.icon}] ${sample.html}`);
    }
}

// 按图标聚合，决定批量命名的口径。
const byIcon = new Map();
for (const item of rows) {
    for (const sample of item.samples || []) byIcon.set(sample.icon, (byIcon.get(sample.icon) || 0) + 1);
}
console.log("\n出现最多的无名图标：");
console.table([...byIcon.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([icon, count]) => ({ 图标: icon, 次数: count })));

if (total > 0) process.exitCode = 1;
