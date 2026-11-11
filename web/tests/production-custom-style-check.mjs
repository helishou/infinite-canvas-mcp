import assert from "node:assert/strict";
import { chromium } from "playwright";

const id = "custom-f7144ab2-7545-442b-9d5c-6e50253c05cc";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", route => route.fulfill(new URL(route.request().url()).pathname.endsWith("/plugins/minimax-h3/defaults")
        ? { status: 200, json: { ok: true, defaults: { styleTemplates: [{ id, label: "柔焦", text: "Soft focus." }] } } }
        : { status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/acheng-production.html?scenario=custom-style&clip=SEG1`);
    const style = page.locator('[data-production-clip-style="SEG1"]');
    await style.getByText("柔焦", { exact: true }).waitFor();
    assert.ok((await style.innerText()).includes("柔焦"));
    assert.ok(!(await style.innerText()).includes(id));
    assert.ok(!(await style.innerText()).includes("director.workspace"));
    const adopt = style.getByRole("button");
    assert.ok((await adopt.innerText()).includes("柔焦"));
    await page.evaluate(id => window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: { styleTemplates: [{ id, label: "柔焦新版", text: "Soft focus." }] } })), id);
    await style.getByText("柔焦新版", { exact: true }).waitFor();
    assert.ok((await adopt.innerText()).includes("柔焦新版"));
    await adopt.click();
    assert.equal(JSON.parse(await page.getByLabel("evidence").textContent()).director.source.segments[0].styleTemplateId, id);
    await page.getByRole("button", { name: "language", exact: true }).click();
    await page.getByRole("button", { name: "theme", exact: true }).click();
    await page.setViewportSize({ width: 440, height: 1000 });
    assert.ok((await style.innerText()).includes("柔焦新版"));
    assert.ok(!(await style.innerText()).includes("director.workspace"));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", { detail: { styleTemplates: [] } })));
    await style.getByText("Unavailable style", { exact: true }).waitFor();
    assert.ok(!(await style.innerText()).includes(id));
    assert.equal(JSON.parse(await page.getByLabel("evidence").textContent()).director.source.segments[0].styleTemplateId, id);
    assert.deepEqual(errors, []);
    console.log("PASS: custom style names in dropdown/adoption, live rename, adoption ID retained, missing-template fallback, both locales and narrow layout");
} finally { await browser.close(); }
