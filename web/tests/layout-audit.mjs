// 页面框架布局审计：采集 h1 排版、main 滚动高度、首块间距与横向溢出。
// 用法：node web/tests/layout-audit.mjs [--out <file>] [--base http://localhost:3001]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = argOf("--base", "http://localhost:3001").replace(/\/$/, "");
const outFile = argOf("--out", "");
const viewport = { width: Number(argOf("--width", "1440")), height: Number(argOf("--height", "900")) };

// 方案覆盖的 10 条主路由 + 两个遗留入口。
const routes = ["/", "/projects", "/canvas", "/production", "/assets", "/prompts", "/image", "/video", "/workflows", "/config", "/diagnostics/mcp", "/analytics/local"];

const browser = await chromium.launch();
const root = await browser.newContext({ viewport });
const results = [];

for (const route of routes) {
    // 每条路由独立上下文，避免上一条的 store/localStorage 影响下一条的初始态。
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
    try {
        await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
        // 等首屏数据渲染完：h1 出现 + 布局稳定两帧。
        await page.waitForSelector("h1", { timeout: 12000 }).catch(() => {});
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.waitForTimeout(600);

        const snapshot = await page.evaluate(() => {
            const pick = (node) => {
                if (!node) return null;
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return {
                    text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
                    fontSize: style.fontSize,
                    fontWeight: style.fontWeight,
                    lineHeight: style.lineHeight,
                    // 相对视口的位置：吸收顶栏高度差异，只看页内一致性与首屏位置。
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                };
            };
            const headings = [...document.querySelectorAll("h1")];
            const main = document.querySelector("main");
            const scrollNode = main || document.scrollingElement;
            // main 的直接子元素里第一个有可见高度的块，代表"页头之后第一块内容"的容器。
            const firstBlock = main
                ? [...main.children].find((child) => child.getBoundingClientRect().height > 0) || null
                : null;
            return {
                title: document.title,
                h1Count: headings.length,
                h1: pick(headings[0]),
                h1All: headings.map((node) => pick(node)),
                mainTag: main ? main.tagName.toLowerCase() : null,
                mainScrollHeight: scrollNode ? scrollNode.scrollHeight : null,
                mainClientHeight: scrollNode ? scrollNode.clientHeight : null,
                mainTop: main ? Math.round(main.getBoundingClientRect().top) : null,
                firstBlockTop: firstBlock ? Math.round(firstBlock.getBoundingClientRect().top) : null,
                // 页头到 main 的间距：抵消顶栏与提示条的高度差异，只看页内留白是否一致。
                headerGap: main && headings[0] ? Math.round(headings[0].getBoundingClientRect().top - main.getBoundingClientRect().top) : null,
                cardGrid: (() => {
                    const grid = document.querySelector("[data-card-grid]");
                    if (!grid) return null;
                    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
                    // 首屏可见卡片数：按视口裁剪，用于核对"首屏能看见几张"这类验收。
                    const visible = [...grid.children].filter((card) => {
                        const rect = card.getBoundingClientRect();
                        return rect.top < window.innerHeight && rect.bottom > 0;
                    }).length;
                    return { total: grid.children.length, columns, visible };
                })(),
                overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                docScrollHeight: document.documentElement.scrollHeight,
            };
        });

        results.push({ route, ok: true, ...snapshot, errors });
    } catch (error) {
        results.push({ route, ok: false, error: String(error).slice(0, 300), errors });
    } finally {
        await context.close();
    }
}

await browser.close();

const report = { base, viewport, capturedAt: new Date().toISOString(), routes: results };
const text = JSON.stringify(report, null, 2);
if (outFile) writeFileSync(resolve(outFile), text, "utf8");

// 终端摘要：人工核对用，完整数据看 --out。
const rows = results.map((item) => ({
    route: item.route,
    h1: item.h1 ? `${item.h1.text} ${item.h1.fontSize}/${item.h1.fontWeight} L${item.h1.left}` : "(none)",
    gap: item.headerGap,
    main: item.mainScrollHeight != null ? `${item.mainScrollHeight}/${item.mainClientHeight}` : "(none)",
    cards: item.cardGrid ? `${item.cardGrid.visible}/${item.cardGrid.total} (${item.cardGrid.columns}列)` : "",
    overflowX: item.overflowX,
}));
console.table(rows);
if (outFile) console.log(`written: ${resolve(outFile)}`);
if (results.some((item) => item.ok === false)) process.exitCode = 1;
