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
    const market = page.locator("[data-testid='skill-market']");
    await market.waitFor({ timeout: 25000 });

    await page.locator("[data-testid='market-grid']").waitFor({ timeout: 20000 });
    const cards = page.locator("[data-testid='market-skill-card']");
    const initialCount = await cards.count();
    assert.ok(initialCount > 0, `market must show built-in skills, got ${initialCount}`);
    console.log(`PASS: skill market loaded ${initialCount} skill cards`);

    await page.locator("[data-testid='market-skill-card']").first().locator("[data-testid='market-card-detail']").click();
    await page.locator("[data-testid='market-detail-preview']").waitFor({ timeout: 15000 });
    const preview = await page.locator("[data-testid='market-detail-preview']").innerText();
    assert.ok(preview.length > 20, "skill detail preview should render markdown");
    assert.ok(!/^name:\s/m.test(preview), "preview must not render raw YAML frontmatter");
    console.log("PASS: skill detail drawer renders preview");

    await page.locator(".ant-drawer .ant-segmented-item").filter({ hasText: "源文件" }).first().click();
    await page.locator("[data-testid='market-detail-source']").waitFor({ timeout: 8000 });
    const source = await page.locator("[data-testid='market-detail-source']").innerText();
    assert.ok(source.length > 20, "source view shows SKILL.md");
    await page.locator(".ant-drawer-close").first().click();
    await page.waitForTimeout(300);

    await page.locator("[data-testid='market-scope-favorites']").click();
    await page.waitForTimeout(250);
    const favCount = await page.locator("[data-testid='market-skill-card']").count();
    assert.ok(favCount <= initialCount, "favorites is a subset");
    console.log(`PASS: scope switch works (favorites ${favCount}/${initialCount})`);

    await page.locator("[data-testid='market-scope-all']").click();
    await page.locator("[data-testid='market-category-creative']").click();
    await page.waitForTimeout(250);
    assert.ok(await page.locator("[data-testid='market-skill-card']").count() > 0, "creative category has skills");
    console.log("PASS: category filter works");

    await page.locator("[data-testid='market-category-all']").click();
    await page.locator("[data-testid='market-search']").fill("zzzz-no-such-skill");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("[data-testid='market-skill-card']").count(), 0, "search filters out everything");
    await page.locator("[data-testid='market-search']").fill("");
    await page.waitForTimeout(250);
    console.log("PASS: search works");

    await page.locator("[data-testid='market-install-open']").click();
    await page.locator("[data-testid='market-install-name']").waitFor({ timeout: 8000 });
    const modeSegments = await page.locator("[data-testid='market-install-mode'] .ant-segmented-item").count();
    assert.equal(modeSegments, 2, "install offers Markdown and ZIP");
    await page.locator(".ant-drawer-close").last().click();
    await page.waitForTimeout(250);
    console.log("PASS: install modal opens with two modes");

    await page.locator("[data-testid='skills-view-switch'] .ant-segmented-item").last().click();
    await page.waitForTimeout(300);
    assert.match(await page.locator("body").innerText(), /Acheng|七个创作模块/, "Acheng manager tab preserved");
    console.log("PASS: Acheng manager tab preserved");

    assert.deepEqual(errors, [], `runtime errors: ${errors.join(" | ")}`);
    assert.deepEqual(failedApi, [], `failed skill-market API calls: ${failedApi.join(" | ")}`);
    console.log("PASS: no runtime errors and no failed skill-market requests");
} finally {
    await browser.close();
}
