import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", (route) => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/acheng-production.html`);
    await page.getByRole("button", { name: "Edit Clip style", exact: true }).click();
    await page.getByRole("button", { name: "采用用户修改：柔光", exact: true }).click();
    const evidence = () => page.getByLabel("evidence").textContent().then(JSON.parse);
    assert.equal((await evidence()).director.source.segments[0].styleTemplateId, "soft-light");
    assert.equal((await evidence()).director.source.segments[1].styleTemplateId, undefined);
    assert.equal(await page.getByRole("button", { name: "采用用户修改：柔光", exact: true }).count(), 0);
    const prompt = (await evidence()).director.artifacts.find(artifact => artifact.targetId === "SEG1").prompt;
    assert.ok(!prompt.includes("Visual style:"));
    await page.getByRole("button", { name: "theme", exact: true }).click();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.getByRole("button", { name: "language", exact: true }).click();
    await page.setViewportSize({ width: 480, height: 850 });
    await page.getByRole("combobox", { name: "H3 visual style", exact: true }).click();
    await page.getByText("No style template", { exact: true }).click();
    assert.equal((await evidence()).director.source.segments[0].styleTemplateId, null);
    assert.equal((await evidence()).director.artifacts.find(artifact => artifact.targetId === "SEG1").prompt, prompt);
    assert.equal(await page.getByRole("button", { name: "Adopt user change: Soft light", exact: true }).isVisible(), true);
    assert.deepEqual(errors, []);
    console.log("PASS: focused Clip style adoption, formal source editing, unchanged prompt and sibling Clip, both languages/themes and narrow screen");
} finally { await browser.close(); }
