import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    for (const scenario of ["normal", "failed", "changed", "prompt-changed", "manual"]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/clip-generation-preparation.html?case=${scenario}`);
        const generate = page.locator('[data-shot-clip-actions="C1"] button').last();
        await generate.waitFor();
        assert.match(await page.locator('[data-subject-shot-editor="S1"]').innerText(), /在这里用中文核对/);
        assert.equal(await page.getByText("等待翻译", { exact: true }).count(), 0);
        await generate.click();
        if (["normal", "manual"].includes(scenario)) await page.waitForFunction(() => window.__preparationEvents?.some(event => event.run));
        else await page.getByText(scenario === "changed" ? /制作内容在准备期间发生变化/ : scenario === "prompt-changed" ? /提示词在翻译期间发生变化/ : /模拟翻译失败/, { exact: false }).waitFor();
        const events = await page.evaluate(() => window.__preparationEvents || []);
        const runs = events.filter(event => event.run), translations = events.filter(event => event.translation), writes = events.filter(event => event.ops);
        if (scenario === "normal") {
            assert.equal(translations.length, 1);
            assert.equal(translations[0].translation.items.length, 1, "Prepare only the requested Clip");
            assert.equal(writes.length, 1);
            assert.equal(runs.length, 1);
            assert.deepEqual(runs[0].run.targets, ["segment:C1"]);
            assert.equal(runs[0].run.expectedCanvasRevision, 2);
            assert.match(runs[0].prompt, /A child watches/);
            // Re-running unchanged inputs consumes the current translation without another model call.
            await generate.click();
            await page.waitForFunction(() => window.__preparationEvents.filter(event => event.run).length === 2);
            assert.equal((await page.evaluate(() => window.__preparationEvents)).filter(event => event.translation).length, 1);
        } else if (scenario === "manual") {
            assert.equal(translations.length, 0);
            assert.equal(writes.length, 0);
            assert.equal(runs[0].prompt, "My hand-edited prompt");
        } else {
            assert.equal(runs.length, 0, "A translation failure or changed source must not submit media generation");
            assert.equal(writes.length, 0, "A changed source must not receive the old translation");
        }
        assert.deepEqual(errors, []);
        await context.close();
        console.log(`PASS: ${scenario}`);
    }
} finally { await browser.close(); }
