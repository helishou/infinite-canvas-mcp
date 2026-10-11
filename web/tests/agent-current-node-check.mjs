import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/agent-current-node.html`);
    const locate = () => page.getByRole("button", { name: "回到 Agent 当前节点", exact: true });
    await locate().waitFor();
    await page.evaluate(() => window.currentNodeFixture.advance());
    await locate().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="location"]').textContent.includes("nodeId=node-b"));
    let snapshot = await page.evaluate(() => window.currentNodeFixture.snapshot());
    assert.equal(snapshot.follow, true);
    assert.equal(snapshot.open, false);
    assert.equal(snapshot.prompt, "保留草稿");
    assert.equal(snapshot.waiting, true);
    // Repeated use while already following must refocus the same current Clip.
    await page.evaluate(() => window.currentNodeFixture.open());
    await locate().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="focus"]').textContent.includes('"segmentId":"clip-b"'));
    await page.setViewportSize({ width: 390, height: 700 });
    await page.evaluate(() => { window.currentNodeFixture.appearance("en-US", "dark"); window.currentNodeFixture.open(); });
    const english = page.getByRole("button", { name: "Return to Agent's current node", exact: true });
    await english.waitFor();
    const reads = (await page.evaluate(() => window.currentNodeFixture.snapshot())).reads;
    await english.click();
    await page.waitForFunction(before => window.currentNodeFixture.snapshot().reads > before && !window.currentNodeFixture.snapshot().open, reads);
    await page.waitForFunction(() => document.getElementById("canvas-director-dialog").getAttribute("aria-hidden") === "true");
    await page.evaluate(() => { window.currentNodeFixture.clear(); window.currentNodeFixture.open(); });
    assert.equal(await english.isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log("PASS: real director header returns to newest Backend node/Clip, restores following, refocuses while following, preserves draft/running turn, works on narrow screens and both languages/themes, and disables without a target.");
} finally { await browser.close(); }
