import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.CANVAS_TEST_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    // 1) 真实首页冒烟：确认 hero 挂在真实路由上、没有运行时异常。
    {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const pad = page.locator("[data-testid='creative-launch-pad']");
        await pad.waitFor({ timeout: 25000 });
        assert.match(await pad.innerText(), /今天想创作什么/);
        assert.equal(await page.locator("[data-testid^='creative-mode-']").count(), 4);
        assert.equal(await page.locator("[data-testid='home-workbench']").count(), 1, "existing home sections must remain");
        assert.deepEqual(errors, [], "real home page must not throw");
        console.log("PASS: real home page renders the creative launch pad without errors");
        await page.close();
    }

    // 2) 独立 harness：内存 store 注入，真实点击完整链路，不写任何持久化数据。
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${BASE}/tests/creative-launch-pad.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    const draft = page.locator("[data-testid='creative-draft']");
    await draft.waitFor({ timeout: 25000 });

    const canvasPlaceholder = await draft.getAttribute("placeholder");
    await page.locator("[data-testid='creative-mode-image']").click();
    const imagePlaceholder = await draft.getAttribute("placeholder");
    assert.ok(canvasPlaceholder && imagePlaceholder && canvasPlaceholder !== imagePlaceholder, "mode tabs must change the prompt hint");
    await page.locator("[data-testid='creative-mode-canvas']").click();
    await page.locator("[data-testid='creative-quick-example0']").click();
    const idea = await draft.inputValue();
    assert.ok(idea.length > 10, "quick card must fill a real example prompt");

    const start = page.locator("[data-testid='creative-start']");
    assert.equal(await start.isEnabled(), true, "a non-empty idea enables start");

    await page.locator("[data-testid='creative-add-reference']").click();
    const picker = page.locator("[data-testid='reference-asset-picker']");
    await picker.waitFor({ timeout: 15000 });
    const facets = page.locator("[data-testid='reference-asset-facets']");
    const facetRow = label => facets.locator("button").filter({ hasText: label }).first();
    assert.match(await facets.innerText(), /媒体类型/);
    assert.match(await facets.innerText(), /分类/);

    const cards = page.locator("[data-reference-card]");
    assert.equal(await cards.count(), 8, "9 injected assets paginate to 8 on page 1");
    await facetRow("视频").click();
    assert.equal(await cards.count(), 1, "mediaType facet filters to the single video");
    assert.match(await facetRow("全部类型").innerText(), /9/, "facet count ignores its own dimension");
    await facetRow("全部类型").click();
    await page.locator("[data-testid='reference-asset-picker'] input[placeholder]").fill("测试图片-1");
    assert.equal(await cards.count(), 1, "search matches title");
    await page.locator("[data-testid='reference-asset-picker'] input[placeholder]").fill("");
    assert.equal(await cards.count(), 8);

    for (const id of ["a1", "a2", "a3", "a4", "v1"]) await page.locator(`[data-reference-card='${id}']`).click();
    assert.match(await page.locator("[data-testid='reference-selected-count']").innerText(), /5\/5/);
    await page.locator("[data-reference-card='a5']").click();
    assert.match(await page.locator("[data-testid='reference-selected-count']").innerText(), /5\/5/, "cap must not silently displace a pick");
    await page.locator("[data-testid='reference-confirm']").click();
    await picker.waitFor({ state: "hidden" });
    assert.equal(await page.locator("[data-testid='creative-reference-chip']").count(), 5, "confirmed references become chips");
    assert.match(await page.locator("[data-testid='creative-launch-pad']").innerText(), /1 项非图片素材只登记名称/);

    await start.click();
    const route = page.locator("[data-test-route]");
    await route.waitFor({ timeout: 10000 });
    assert.equal(await route.innerText(), "TEST_CANVAS_ID");
    const result = await page.evaluate(() => ({
        title: window.__createdTitle,
        panelOpened: window.__panelOpened,
        prompt: window.__agentPatch?.prompt,
        attachments: window.__agentPatch?.attachments?.map(item => item.id),
        activeTab: window.__agentPatch?.activeTab,
    }));
    assert.equal(result.title, `${idea.trim().replace(/\s+/g, " ").slice(0, 24)}…`, "canvas title derives from the authored idea");
    assert.equal(result.prompt, idea, "idea is handed to the Agent draft verbatim");
    assert.deepEqual(result.attachments, ["a1", "a2", "a3", "a4"], "only image assets become attachments");
    assert.equal(result.activeTab, "chat");
    assert.equal(result.panelOpened, true);
    assert.deepEqual(errors, [], "no runtime errors during the full click-through");

    console.log("PASS: mode tabs, quick cards, facets, search, 5-item cap, confirm, non-image notice and full create-to-Agent chain");
} finally {
    await browser.close();
}
