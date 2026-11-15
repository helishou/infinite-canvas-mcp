import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // All workbench reads and save/compile/generate callbacks use fixture data.
    await page.route("**/canvas/projects/SHOT_CLIP_TEST/production?**", route => route.fulfill({ json: { ok: true, production: { workbench: {} } } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/shot-clip-actions.html`);
    const actions = page.locator('[data-shot-clip-actions="C1"]');
    const generate = actions.locator("button").last();
    await generate.waitFor();
    assert.equal(await generate.isEnabled(), true);
    const editor = page.locator('[data-subject-shot-editor="S1"]');
    await editor.locator('textarea').first().fill("修改后的画面动作");
    assert.equal(await generate.isDisabled(), true);
    assert.match(await actions.innerText(), /先保存/);
    await editor.getByRole("button", { name: "保存镜头并同步", exact: true }).click();
    await actions.getByText(/Prompt 编译中/).waitFor();
    assert.equal(await generate.isDisabled(), true);
    await page.locator('[data-test-controls]').getByRole("button", { name: "ready", exact: true }).click();
    await generate.click();
    const events = () => page.locator('[data-test-events]').innerText().then(JSON.parse);
    assert.deepEqual((await events()).map(event => event.save || event.generate), ["S1", "C1"]);
    assert.equal((await events())[0].patch.visual, "修改后的画面动作");
    for (const phase of ["running", "locked", "compiling", "failed"]) {
        await page.locator('[data-test-controls]').getByRole("button", { name: phase, exact: true }).click();
        assert.equal(await generate.isDisabled(), true, phase);
    }
    assert.match(await actions.innerText(), /参考图片无法解析/);
    await actions.getByRole("button", { name: "更新本 Clip 提示词" }).click();
    assert.equal((await events()).at(-1).compile, "C1");
    await page.locator('[data-track-shot="S3"]').click();
    await page.locator('[data-shot-clip-actions="C2"]').getByRole("button", { name: "生成 Clip 2", exact: true }).click();
    assert.equal((await events()).at(-1).generate, "C2");
    await page.locator('[data-track-shot="S1"]').click();
    await page.locator('[data-subject-shot-editor="S1"] textarea').first().fill("保留未保存的修改");
    await page.locator('[data-track-shot="S2"]').click();
    assert.equal(await generate.isDisabled(), true, "Other shots in the same Clip must be saved too");
    await page.locator('[data-track-shot="S3"]').click();
    assert.equal(await page.locator('[data-shot-clip-actions="C2"] button').last().isEnabled(), true, "An unrelated Clip draft must not block this Clip");
    assert.deepEqual(errors, []);
    console.log("PASS: save → automatic prompt update → local generation; failure recovery, locks, running tasks, exact Clip identity and unsaved sibling isolation");
} finally { await browser.close(); }
