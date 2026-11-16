// 回归验收：从首页「最近生成」的结果弹窗点「源画布」跳走后，结果弹窗必须收起。
// 用法：node web/tests/home-recent-output-modal-close.mjs
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
    await page.waitForFunction(() => {
        const el = document.querySelector('section[aria-label="最近生成"]');
        return Boolean(el && el.querySelector("button.group"));
    }, null, { timeout: 40000 }).catch(() => undefined);

    const card = section.locator("button.group").first();
    check("最近生成有可点卡片", await card.count() > 0);
    if (await card.count()) {
        await card.click();
        await page.locator(".ant-modal-wrap").first().waitFor({ timeout: 10000 });
        check("点卡片打开预览弹窗", await page.locator(".ant-modal-wrap").count() >= 1);

        const source = page.getByRole("button", { name: /源画布/ });
        check("预览弹窗提供源画布入口", await source.count() > 0);
        if (await source.count()) {
            await source.first().click();
            await page.waitForTimeout(1800);
            const leftovers = await page.locator(".ant-modal-wrap:visible").count();
            check("跳画布后结果弹窗已关闭", leftovers === 0, `visible=${leftovers}`);
            // 剧目画布走 WorkbenchCanvas 覆盖层（URL 不变），自由画布走路由跳转，两者都算跳过去。
            const inCanvas = await page.locator("[data-workbench-canvas]").count() > 0;
            check("已跳到画布", /\/canvas\//.test(page.url()) || inCanvas, `${page.url()} overlay=${inCanvas}`);
        }
    }
    check("无运行时错误", errors.length === 0, errors.join(" | ").slice(0, 220));
} finally {
    await browser.close();
}

const failed = results.filter(item => !item.ok);
console.log(`\nTOTAL ${results.length} PASS ${results.length - failed.length} FAIL ${failed.length}`);
if (failed.length) process.exitCode = 1;
