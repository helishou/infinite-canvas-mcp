import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.CANVAS_TEST_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    // 首页也用了 WorkbenchCanvas，但切换器只能出现在制作台，不能全局误挂。
    {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.locator("[data-testid='creative-launch-pad']").waitFor({ timeout: 25000 });
        assert.equal(await page.locator("[data-testid='workspace-view-switcher']").count(), 0, "home must not show the workspace switcher");
        assert.deepEqual(errors, []);
        console.log("PASS: switcher is scoped to the production desk, home page is unaffected");
        await page.close();
    }

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${BASE}/tests/workspace-view-switcher.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    const switcher = page.locator("[data-testid='workspace-view-switcher']");
    await switcher.waitFor({ timeout: 25000 });

    assert.equal(await switcher.evaluate(el => el.parentElement === document.body), true, "switcher must be portaled to body above the z-900 overlay");
    const canvasButton = page.locator("[data-testid='workspace-view-canvas']");
    const productionButton = page.locator("[data-testid='workspace-view-production']");
    const events = () => page.locator("[data-test-events]").innerText().then(JSON.parse);

    assert.equal(await productionButton.getAttribute("aria-pressed"), "true");
    assert.equal(await canvasButton.getAttribute("aria-pressed"), "false");
    // 顺序：制作台在左、画布在右（用户指定）。
    const order = await page.evaluate(() => {
        const box = (id) => document.querySelector(`[data-testid='workspace-view-${id}']`).getBoundingClientRect().left;
        return { left: box("production"), right: box("canvas") };
    });
    assert.ok(order.left < order.right, `production button must sit left of the canvas button, got ${JSON.stringify(order)}`);
    assert.equal(await page.locator("[data-test-mode]").innerText(), "production");
    assert.equal(await page.locator("[data-test-overlay]").count(), 0);

    await canvasButton.hover();
    await page.waitForTimeout(800);
    assert.match(await page.locator('[role="tooltip"]:visible').last().innerText(), /切换到画布视图/);

    await canvasButton.click();
    await page.waitForFunction(() => document.querySelector("[data-test-mode]")?.textContent === "canvas");
    assert.deepEqual(await events(), ["canvas"]);
    assert.equal(await canvasButton.getAttribute("aria-pressed"), "true");
    assert.equal(await productionButton.getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("[data-test-overlay]").count(), 1);

    // 覆盖层出现后，切换器仍必须在最上层可点（不是被 z-900 盖住）。
    const hit = await canvasButton.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(top?.closest("[data-testid^='workspace-view-']"));
    });
    assert.equal(hit, true, "switcher must stay clickable above the canvas overlay");

    await canvasButton.click();
    assert.deepEqual(await events(), ["canvas"], "clicking the active view must be a no-op");

    await productionButton.hover();
    await page.waitForTimeout(800);
    assert.match(await page.locator('[role="tooltip"]:visible').last().innerText(), /切换到制作台视图/);
    await productionButton.click();
    await page.waitForFunction(() => document.querySelector("[data-test-mode]")?.textContent === "production");
    assert.deepEqual(await events(), ["canvas", "production"]);
    assert.equal(await page.locator("[data-test-overlay]").count(), 0);
    await productionButton.hover();
    await page.waitForTimeout(800);
    assert.match(await page.locator('[role="tooltip"]:visible').last().innerText(), /当前：制作台视图/);

    await page.screenshot({ path: "E:/无限画布/Infinite-Canvas-MCP/tmp/oac/workspace-view-switcher.png" });
    assert.deepEqual(errors, []);
    console.log("PASS: two-state capsule, pressed state, tooltips, portal stacking, no-op on active view");
} finally {
    await browser.close();
}
