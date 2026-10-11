import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", route => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/agent-llm.html`);
    await page.getByTestId("model").waitFor();
    assert.equal(await page.getByTestId("model").textContent(), "A::same-model");
    assert.equal(await page.getByTestId("effort").textContent(), "");
    const chooseB = async () => {
        await page.getByRole("combobox").click();
        await page.getByRole("option", { name: "B / same-model" }).click();
        assert.equal(await page.getByTestId("model").textContent(), "B::same-model");
    };
    await chooseB();
    await page.getByRole("checkbox", { name: "Codex 历史对话" }).check();
    assert.equal(await page.getByTestId("legacy").textContent(), "true");
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await page.getByRole("button", { name: "Language", exact: true }).click();
    await page.getByRole("checkbox", { name: "Codex conversations" }).uncheck();
    await page.setViewportSize({ width: 390, height: 700 });
    await chooseB();
    await page.getByRole("combobox").waitFor();
    assert.equal(await page.getByRole("combobox").count(), 1);
    assert.deepEqual(errors, []);
    console.log("PASS: channel-qualified model selection without effort controls, legacy history, Chinese/English, light/dark and narrow viewport");
} finally { await browser.close(); }
