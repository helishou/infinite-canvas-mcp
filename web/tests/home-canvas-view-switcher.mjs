// 回归验收：从首页「最近生成」跳进画布覆盖层后，制作台/画布视图切换器必须可见且可切回制作台。
// 用法：node web/tests/home-canvas-view-switcher.mjs
import { createRequire } from "node:module";
const require = createRequire("E:/无限画布/Infinite-Canvas-MCP/package.json");
const { chromium } = require("playwright");

const APP = process.env.CANVAS_TEST_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(String(error).slice(0, 220)));
const results = [];
const check = (name, ok, extra = "") => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

try {
    await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector('[data-testid="creative-launch-pad"]', { timeout: 25000 });
    const section = page.locator('section[aria-label="最近生成"]');
    await section.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !!document.querySelector('section[aria-label="最近生成"] button.group'), null, { timeout: 40000 }).catch(() => undefined);

    const card = section.locator("button.group").first();
    check("最近生成有可点卡片", await card.count() > 0);
    if (await card.count()) {
        await card.click();
        await page.locator(".ant-modal-wrap").first().waitFor({ timeout: 10000 });
        await page.getByRole("button", { name: /源画布/ }).first().click();
        await page.waitForTimeout(1800);

        check("画布覆盖层已打开", await page.locator("[data-workbench-canvas]").count() > 0);
        const switcher = page.locator('[data-testid="workspace-view-switcher"]');
        check("覆盖层里出现视图切换器", await switcher.count() > 0);
        if (await switcher.count()) {
            const canvasBtn = page.locator('[data-testid="workspace-view-canvas"]');
            check("切换器处于画布视图态", (await canvasBtn.getAttribute("data-active")) === "true");

            const productionBtn = page.locator('[data-testid="workspace-view-production"]');
            check("切回制作台按钮可点", await productionBtn.count() > 0 && (await productionBtn.getAttribute("data-active")) === "false");
            await productionBtn.click();
            await page.waitForTimeout(2000);
            check("已导航到制作台", /\/production\?dramaId=/.test(page.url()), page.url());
            check("画布覆盖层已关闭", await page.locator("[data-workbench-canvas]").count() === 0);
            check("制作台工作台已渲染", await page.locator("[data-production-workspace-shell]").count() > 0);
        }
    }
    check("无运行时错误", errors.length === 0, errors.join(" | ").slice(0, 220));
} finally {
    await browser.close();
}

const failed = results.filter(item => !item.ok);
console.log(`\nTOTAL ${results.length} PASS ${results.length - failed.length} FAIL ${failed.length}`);
if (failed.length) process.exitCode = 1;
