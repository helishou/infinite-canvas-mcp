import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.CANVAS_TEST_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const failedApi = [];
page.on("pageerror", error => errors.push(error.message));
page.on("response", response => {
    if (/\/api\/skill-market/.test(response.url()) && !response.ok()) failedApi.push(`${response.status()} ${response.url()}`);
});

try {
    await page.goto(`${BASE}/skills`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator("[data-testid='skill-market']").waitFor({ timeout: 25000 });
    await page.locator("[data-testid='market-grid']").waitFor({ timeout: 20000 });

    const total = await page.locator("[data-testid='market-skill-card']").count();
    assert.ok(total >= 52, `expect builtin + 45 catalog cards, got ${total}`);
    console.log(`PASS: ${total} skill cards loaded (builtin + 45 catalog)`);

    // 未安装 catalog 技能：安装按钮 + 功能槽标签
    const fresh = page.locator("[data-testid='market-skill-card'][data-skill='drama-05-board']");
    await fresh.waitFor({ timeout: 8000 });
    const installCount = await fresh.locator("[data-testid='market-card-install']").count();
    const useCount = await fresh.locator("[data-testid='market-card-use']").count();
    assert.ok(installCount + useCount === 1, "catalog card shows install or use button");
    assert.ok((await fresh.locator("[data-testid='market-card-slots']").count()) >= 1, "catalog card shows slot tags");
    console.log(`PASS: catalog card shows ${installCount ? "install" : "use"} + slot tags`);

    // 详情：中文标题，且界面不再展示版权提示条
    await fresh.locator("[data-testid='market-card-detail']").click();
    await page.locator("[data-testid='market-detail-preview']").waitFor({ timeout: 10000 });
    assert.equal(await page.locator("[data-testid='market-detail-license']").count(), 0, "detail has no copyright notice banner");
    assert.equal((await page.locator(".ant-drawer-title").last().innerText()).trim(), "拆分镜表-简洁版", "Chinese frontmatter name as title");
    await page.locator(".ant-drawer-close").last().click();
    await page.waitForTimeout(300);
    console.log("PASS: catalog detail shows Chinese title without copyright banner");

    // 功能槽映射视图：27 行
    await page.locator("[data-testid='market-view'] .ant-segmented-item").filter({ hasText: "创作环节" }).first().click();
    await page.locator("[data-testid='market-slot-map']").waitFor({ timeout: 10000 });
    const slotRows = await page.locator("[data-testid='market-slot-row']").count();
    assert.equal(slotRows, 27, `expect 27 workflow slots, got ${slotRows}`);
    console.log("PASS: slot map shows 27 workflow slots");

    // 「用此技能对话」总线事件正确携带中文名/slug/预填提示
    await page.locator("[data-testid='market-view'] .ant-segmented-item").filter({ hasText: "技能列表" }).first().click();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        window.__useSkillEvents = [];
        window.addEventListener("infinite-canvas:use-market-skill", e => window.__useSkillEvents.push(e.detail));
    });
    const installed = page.locator("[data-testid='market-skill-card'][data-skill='drama-topic']");
    const useBtn = installed.locator("[data-testid='market-card-use']");
    if (await useBtn.count()) {
        await useBtn.click();
        await page.waitForTimeout(400);
        const events = await page.evaluate(() => window.__useSkillEvents);
        assert.equal(events.length, 1, "use-skill event fired once");
        assert.equal(events[0].name, "选题立项");
        assert.equal(events[0].slug, "drama-topic");
        assert.match(events[0].prompt, /选题立项/);
        console.log("PASS: use-skill event carries name/slug/prompt");
    } else {
        console.log("SKIP: use-skill event (drama-topic not installed in this environment)");
    }

    assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
    assert.deepEqual(failedApi, [], `failed API: ${failedApi.join(" | ")}`);
    console.log("PASS: no runtime errors, no failed skill-market API");
    console.log("ALL PASS");
} catch (error) {
    console.error("FAIL:", error instanceof Error ? error.message : String(error));
    if (errors.length) console.error("page errors:", errors);
    if (failedApi.length) console.error("failed API:", failedApi);
    process.exitCode = 1;
} finally {
    await browser.close();
}
