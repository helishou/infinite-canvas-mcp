import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", route => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/h3-focus.html`);
    await page.getByTestId("focused-clip").filter({ hasText: "clip-2" }).waitFor();
    const bounds = () => page.locator('[data-node-id="h3-fixture"]').boundingBox();
    const verify = async (availableWidth = 1920) => {
        await page.waitForFunction(width => {
            const rect = document.querySelector('[data-node-id="h3-fixture"]')?.getBoundingClientRect();
            return rect && rect.left >= 0 && rect.right <= width && rect.top >= 64 && rect.bottom <= innerHeight;
        }, availableWidth);
        const box = await bounds();
        assert.ok(box.width <= availableWidth * .7, `whole H3 node should retain context, width=${box.width}`);
        assert.equal(await page.getByTestId("focused-clip").textContent(), "clip-2");
    };
    await verify();
    // Waiting for the existing focus animation is a test observation, not a product delay.
    await page.waitForTimeout(600);
    const before = await bounds();
    await page.evaluate(() => window.focusFixture.focus());
    await page.waitForTimeout(600);
    const after = await bounds();
    assert.ok(Math.abs(before.width - after.width) < 1, "Clip readiness must not enlarge an already visible H3 node");
    await page.evaluate(() => {
        const dialog = document.createElement("div"); dialog.id = "canvas-director-dialog"; dialog.setAttribute("aria-hidden", "false");
        Object.assign(dialog.style, { position: "fixed", right: "16px", bottom: "80px", width: "460px", height: "640px" }); document.body.append(dialog);
        window.focusFixture.theme("dark"); window.focusFixture.focus();
    });
    await page.waitForTimeout(600);
    await verify(1920 - 460 - 32);
    await page.evaluate(() => document.getElementById("canvas-director-dialog").remove());
    await page.setViewportSize({ width: 390, height: 700 });
    await page.evaluate(() => window.focusFixture.focus());
    await page.waitForTimeout(600);
    await verify(390);
    assert.equal((await page.evaluate(() => window.focusFixture.metadata())).h3FocusRequest, undefined);
    assert.deepEqual(errors, []);
    console.log("PASS: real canvas deep link and director focus fit the complete H3 node, preserve Clip selection, avoid preview zoom, account for the dialog, and work on narrow screens");
} finally { await browser.close(); }
