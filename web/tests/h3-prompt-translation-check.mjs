import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", (route) => route.fulfill({ status: 503, json: { ok: false } }));
    const open = () => page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/h3-prompt-translation.html`);
    const evidence = () => page.getByTestId("translation-evidence").textContent().then(JSON.parse);
    const chinese = page.getByRole("textbox", { name: "中文翻译（只读）" });
    await open();
    const original = await page.getByRole("textbox", { name: "Original prompt" }).inputValue();
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    await chinese.waitFor();
    assert.equal(await chinese.inputValue(), original.replaceAll("Camera follows the hero.", "镜头跟随主角。").replace("Final wind sound.", "最终风声。").replace("<Subject 1> is Alex.", "<Subject 1>是Alex。"));
    assert.equal((await evidence()).requests.length, 7);
    assert.equal((await evidence()).sourceUnchanged, true);
    await page.getByRole("button", { name: "切换回原提示词" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Original prompt" }).inputValue(), original);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.setViewportSize({ width: 480, height: 900 });
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    await chinese.waitFor();
    assert.equal((await evidence()).requests.length, 7, "cached complete translation must not submit again");

    await open();
    await page.getByLabel("Model scenario").selectOption("refusal");
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "长度限制说明" }).waitFor();
    assert.equal(await chinese.count(), 0);
    assert.equal((await evidence()).requests.length, 1);
    assert.equal((await evidence()).sourceUnchanged, true);
    await page.getByLabel("Model scenario").selectOption("success");
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    await chinese.waitFor();
    assert.equal((await evidence()).requests.length, 8, "failed partial results must not populate the cache");

    await open();
    await page.getByLabel("Model scenario").selectOption("hold");
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已完成 0/7 段" }).waitFor();
    const progressStyle = () => page.locator(".minimax-prompt-translate-status").evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const wrapper = element.parentElement.getBoundingClientRect();
        return { background: style.backgroundColor, color: style.color, inside: rect.left >= wrapper.left && rect.right <= wrapper.right && rect.bottom <= wrapper.bottom };
    });
    const darkProgress = await progressStyle();
    assert.equal(darkProgress.inside, true);
    assert.notEqual(darkProgress.background, "rgba(0, 0, 0, 0)");
    await page.getByRole("button", { name: "Toggle theme" }).click();
    const lightProgress = await progressStyle();
    assert.equal(lightProgress.inside, true);
    assert.notEqual(lightProgress.background, darkProgress.background);
    await page.getByRole("button", { name: "Finish next response" }).click();
    await page.getByRole("status").filter({ hasText: "已完成 1/7 段" }).waitFor();
    await page.locator(".minimax-prompt-translate-wrap").screenshot({ path: fileURLToPath(new URL("../../artifacts/h3-translations/translation-progress.png", import.meta.url)) });
    assert.equal((await evidence()).requests.length, 2);
    for (let completed = 2; completed <= 7; completed++) {
        await page.getByRole("button", { name: "Finish next response" }).click();
        if (completed < 7) await page.getByRole("status").filter({ hasText: `已完成 ${completed}/7 段` }).waitFor();
    }
    await chinese.waitFor();
    await page.locator(".minimax-prompt-translate-status").waitFor({ state: "hidden" });

    await open();
    await page.getByLabel("Model scenario").selectOption("hold");
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    await page.getByRole("button", { name: "正在翻译", exact: true }).waitFor();
    await page.getByRole("button", { name: "Switch Clip" }).click();
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    assert.deepEqual((await evidence()).requests.map(({ segmentId, aborted }) => ({ segmentId, aborted })), [{ segmentId: "a", aborted: true }, { segmentId: "b", aborted: false }]);
    await page.getByRole("button", { name: "Finish next response" }).click();
    assert.equal(await page.getByRole("button", { name: "正在翻译", exact: true }).isDisabled(), true, "late A completion must leave B busy");
    await page.getByRole("button", { name: "Finish next response" }).click();
    await chinese.waitFor();
    assert.equal(await chinese.inputValue(), "summary:\nB深吸一口气。\n\nnon_diegetic_music:\nN/A");
    assert.equal((await evidence()).requests.length, 2);

    await open();
    await page.getByLabel("Model scenario").selectOption("hold");
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).click();
    await page.getByRole("button", { name: "Edit source" }).click();
    await page.getByRole("button", { name: "Finish next response" }).click();
    await page.getByRole("button", { name: "查看中文翻译", exact: true }).waitFor();
    assert.equal(await chinese.count(), 0);
    assert.equal((await evidence()).requests.length, 1);
    assert.equal((await evidence()).requests[0].aborted, true);
    assert.equal(await page.getByRole("textbox", { name: "Original prompt" }).inputValue(), "summary:\nEdited prompt.");
    assert.deepEqual(errors, []);
    console.log("PASS: batched H3 translation, visible progress, structure, cache, refusal recovery, late Clip results, source edits, light/dark and narrow layout");
} finally {
    await browser.close();
}
