import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", route => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/codex-channel.html`);
    await page.getByRole("combobox", { name: "渠道类型" }).click();
    await page.locator(".ant-select-item-option-content").filter({ hasText: /^Codex CLI$/ }).click();
    assert.equal(await page.getByText("API Key", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Base URL", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("button", { name: "拉取模型列表", exact: true }).click();
    await page.getByRole("checkbox", { name: "native-fixture", exact: true }).check();
    assert.equal(await page.getByRole("checkbox", { name: "hidden-fixture", exact: true }).count(), 0);
    await page.getByRole("button", { name: /确\s*定/ }).click();
    await page.getByRole("button", { name: /保\s*存/ }).click();
    const saved = JSON.parse(await page.getByTestId("channel").textContent());
    assert.equal(saved.kind, "codex-cli"); assert.equal(saved.models[0].capability, "text");
    await page.getByRole("button", { name: "Request text", exact: true }).click();
    await page.getByTestId("answer").filter({ hasText: "CLI fixture result" }).waitFor();
    const tasks = JSON.parse(await page.getByTestId("submitted").textContent());
    assert.equal(tasks[0].model, "cli-test::native-fixture"); assert.equal(tasks[0].mode, "text");
    assert.equal(tasks[0].references[0].dataUrl, "data:image/png;base64,AQID");
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await page.getByRole("button", { name: "Language", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 700 });
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("combobox", { name: "Channel type" }).waitFor();
    assert.equal(await page.getByText("API Key", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS: Codex channel selection, local catalog without API credentials, text capability, Backend task routing with images, Chinese/English and light/dark UI");
} finally { await browser.close(); }
