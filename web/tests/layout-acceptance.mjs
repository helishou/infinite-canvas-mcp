// 页面框架验收：批次 A/B/C 的可执行断言，固定 1440×900 视口。
// 用法：node web/tests/layout-acceptance.mjs [--base http://localhost:3001]
import { chromium } from "playwright";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = argOf("--base", "http://localhost:3001").replace(/\/$/, "");
const viewport = { width: 1440, height: 900 };
const routes = ["/", "/projects", "/canvas", "/production", "/assets", "/prompts", "/image", "/video", "/workflows", "/config", "/diagnostics/mcp", "/analytics/local"];

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

const browser = await chromium.launch();

/** 每个断言用独立上下文，避免上一条的滚动态或 store 影响下一条。 */
async function withPage(route, run, waitFor) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
        await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
        await page.waitForSelector("h1", { timeout: 12000 }).catch(() => {});
        // 列表页等网格出现，否则量到的是加载态页高（等于视口高），会误判为"已达标"。
        if (waitFor) await page.waitForSelector(waitFor, { timeout: 8000 }).catch(() => {});
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.waitForTimeout(700);
        return await run(page);
    } finally {
        await context.close();
    }
}

const measures = [];
for (const route of routes) {
    const snapshot = await withPage(route, (page) => page.evaluate(() => {
        const h1 = document.querySelector("h1");
        const main = document.querySelector("main") || document.scrollingElement;
        const style = h1 ? getComputedStyle(h1) : null;
        const rect = h1?.getBoundingClientRect();
        const grid = document.querySelector("[data-card-grid]");
        return {
            title: h1 ? h1.textContent.replace(/\s+/g, " ").trim() : null,
            fontSize: style?.fontSize ?? null,
            fontWeight: style?.fontWeight ?? null,
            left: rect ? Math.round(rect.left) : null,
            gap: h1 && main ? Math.round(rect.top - main.getBoundingClientRect().top) : null,
            scrollHeight: main ? main.scrollHeight : null,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            cards: grid
                ? {
                    total: grid.children.length,
                    columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
                    visible: [...grid.children].filter((card) => {
                        const box = card.getBoundingClientRect();
                        return box.top < window.innerHeight && box.bottom > 0;
                    }).length,
                }
                : null,
        };
    }), ["/projects", "/assets", "/prompts"].includes(route) ? "[data-card-grid]" : undefined);
    measures.push({ route, ...snapshot });
}

const byRoute = (route) => measures.find((item) => item.route === route);

// A1 标题排版只有一组：24px / 600（<640px 时 token 降为 22px，故只在桌面视口断言）
const sizes = [...new Set(measures.map((item) => item.fontSize))];
const weights = [...new Set(measures.map((item) => item.fontWeight))];
check("h1 字号唯一", sizes.length === 1 && sizes[0] === "24px", sizes.join(","));
check("h1 字重唯一", weights.length === 1 && weights[0] === "600", weights.join(","));

// A2 左边界只有三组：画廊 32 / 数据 112 / 带侧栏 256（绝对 left 由内容列宽度决定，无法压到两组）
const lefts = [...new Set(measures.map((item) => item.left))].sort((a, b) => a - b);
check("h1 左边界三组内", lefts.every((value) => [32, 112, 256].includes(value)), lefts.join(","));

// A3 顶栏到页头只一种留白
const gaps = [...new Set(measures.map((item) => item.gap))].sort((a, b) => a - b);
check("页头留白唯一", gaps.length === 1 && gaps[0] === 24, gaps.join(","));

// A4 无横向溢出
const overflow = measures.filter((item) => item.overflowX !== 0).map((item) => `${item.route}:${item.overflowX}`);
check("无横向溢出", overflow.length === 0, overflow.join(",") || "ok");

// A5 遗留入口标题跟随分区
check("/canvas 标题", byRoute("/canvas").title === "自由画布", byRoute("/canvas").title);
check("/production 标题", byRoute("/production").title === "剧目制作", byRoute("/production").title);
check("/projects 标题", byRoute("/projects").title === "项目", byRoute("/projects").title);

// A6 /workflows 使用 main 语义
const workflowsMain = await withPage("/workflows", (page) => page.evaluate(() => document.querySelectorAll("main").length));
check("/workflows 有 main", workflowsMain >= 1, String(workflowsMain));

// A7 /workflows 页签降为两层
const workflowTabs = await withPage("/workflows", (page) => page.evaluate(() => [...document.querySelectorAll(".ant-tabs-tab")].map((node) => node.textContent.trim())));
check("/workflows 两层页签", workflowTabs.length === 2, workflowTabs.join(" | "));

// B1/B2/B3 首屏卡片密度（1440×900）
check("/projects 首屏卡数 ≥6", (byRoute("/projects").cards?.visible ?? 0) >= 6, String(byRoute("/projects").cards?.visible));
check("/prompts 首屏卡数 ≥6", (byRoute("/prompts").cards?.visible ?? 0) >= 6, String(byRoute("/prompts").cards?.visible));
check("/assets 首屏卡数 ≥8", (byRoute("/assets").cards?.visible ?? 0) >= 8, String(byRoute("/assets").cards?.visible));
check("/assets 四列", byRoute("/assets").cards?.columns === 4, String(byRoute("/assets").cards?.columns));

// B4 长列表页高
check("/prompts 页高 ≤3200", (byRoute("/prompts").scrollHeight ?? 0) <= 3200, String(byRoute("/prompts").scrollHeight));
check("/assets 页高 ≤2100", (byRoute("/assets").scrollHeight ?? 0) <= 2100, String(byRoute("/assets").scrollHeight));

// B5 无封面不再占位：提示词卡不应出现空 cover 区
const emptyCover = await withPage("/prompts", (page) => page.evaluate(() => {
    const card = document.querySelector(".ant-card");
    if (!card) return { hasCover: false, coverHeight: 0 };
    const cover = card.querySelector(".ant-card-cover");
    return { hasCover: Boolean(cover), coverHeight: cover ? Math.round(cover.getBoundingClientRect().height) : 0 };
}));
check("无封面卡不渲染 cover", !emptyCover.hasCover || emptyCover.coverHeight > 0, JSON.stringify(emptyCover));

// C1 空态收缩
for (const route of ["/image", "/video"]) {
    const height = await withPage(route, (page) => page.evaluate(() => {
        const node = document.querySelector('[data-testid="workbench-empty"]');
        return node ? Math.round(node.getBoundingClientRect().height) : null;
    }));
    check(`${route} 空态高 <160`, height != null && height < 160, String(height));
}

// C2 /mcp 首屏同时出现 KPI 与结论区（无异常时结论区是提示条而非表格）
const mcpFirst = await withPage("/diagnostics/mcp", (page) => page.evaluate(() => {
    const vh = window.innerHeight;
    const visible = (node) => {
        const box = node.getBoundingClientRect();
        return box.top < vh && box.bottom > 0;
    };
    const heading = [...document.querySelectorAll("h2")].find((node) => node.textContent.includes("诊断结论"));
    const conclusion = heading?.closest("section");
    return {
        kpi: [...document.querySelectorAll(".ant-statistic-title")].filter(visible).length,
        table: [...document.querySelectorAll("table")].some(visible),
        // 有异常时表格可见，无异常时提示条可见，两者都算结论区已进入首屏。
        conclusionVisible: Boolean(conclusion && visible(conclusion)),
    };
}), '[data-testid="mcp-kpi"] .ant-statistic-title');
check("/mcp 首屏 KPI", mcpFirst.kpi > 0, JSON.stringify(mcpFirst));
check("/mcp 首屏结论区", mcpFirst.conclusionVisible || mcpFirst.table, JSON.stringify(mcpFirst));

// C3 首页气泡不再压住第三张卡的操作区
const homeHit = await withPage("/", (page) => page.evaluate(() => {
    const previews = [...document.querySelectorAll("button")].filter((node) => {
        const label = node.getAttribute("aria-label") || "";
        return label.includes("previewNamed") || label.includes("预览") || label.includes("Preview");
    });
    const button = previews[2] || previews.at(-1);
    if (!button) return { inside: false, hit: `no-preview-button(${previews.length})` };
    const box = button.getBoundingClientRect();
    const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const card = button.closest("[data-home-card]") || button.closest("article") || button.parentElement;
    return {
        hit: element ? `${element.tagName}.${String(element.className).slice(0, 40)} insideCard=${Boolean(card && card.contains(element))}` : "null",
        inside: Boolean(card && element && card.contains(element)),
    };
}));
check("首页第三张卡操作不被浮层遮挡", homeHit.inside === true, homeHit.hit);

await browser.close();

const failed = checks.filter((item) => !item.pass);
console.table(checks.map((item) => ({ 断言: item.name, 结果: item.pass ? "PASS" : "FAIL", 实测: item.detail })));
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) process.exitCode = 1;
