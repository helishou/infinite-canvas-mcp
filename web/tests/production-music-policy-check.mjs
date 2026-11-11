import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", route => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/acheng-production.html?scenario=music-policy`);
    await page.getByRole("button", { name: "Clip 组合", exact: true }).click();
    const card = page.locator('[data-clip-source-fields="SEG1"]');
    const score = card.locator('[data-clip-source-field="non_diegetic_music"]');
    assert.ok((await score.innerText()).includes("N/A"));
    assert.ok(!(await score.innerText()).includes("taiko"));
    await card.getByRole("button", { name: "编辑内容", exact: true }).click();
    assert.equal(await card.getByRole("textbox", { name: "配乐", exact: true }).count(), 0);
    assert.equal(JSON.parse(await page.getByLabel("evidence").textContent()).saves, 0);
    await page.getByRole("button", { name: "生成与交付", exact: true }).first().click();
    const toggle = page.getByRole("switch", { name: "允许背景配乐", exact: true, includeHidden: true });
    const details = toggle.locator("xpath=ancestor::details");
    for (let index = 0; index < await details.count(); index++) {
        const container = details.nth(index);
        if (!await container.evaluate(element => element.open)) await container.locator("summary").first().click();
    }
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await page.getByRole("button", { name: "Clip 组合", exact: true }).click();
    assert.ok((await score.innerText()).includes("taiko"));
    await page.getByRole("button", { name: "language", exact: true }).click();
    assert.ok((await card.innerText()).includes("Music"));
    assert.deepEqual(errors, []);

    const setup = await browser.newPage();
    await setup.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/scene-production.html`);
    const defaultToggle = setup.getByRole("switch", { name: "允许背景配乐", exact: true });
    await defaultToggle.waitFor();
    assert.equal(await defaultToggle.getAttribute("aria-checked"), "false");
    await defaultToggle.click();
    assert.equal(await setup.getByTestId("music-settings").innerText(), "true");
    await defaultToggle.click();
    assert.equal(await setup.getByTestId("music-settings").innerText(), "false");
    console.log("PASS: default music is off in drama setup and episode settings; disabled Clip scoring is N/A and not editable; explicit opt-in restores authored scoring");
} finally { await browser.close(); }
