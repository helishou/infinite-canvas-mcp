import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

// Drives the real subject timeline against the running Vite dev server, so the
// direct add/edit entry points are verified on the surface that consumes them.
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1:17370/**", route => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/continuity-workbench.html`);
    const grid = page.locator("[data-continuity-timeline]");
    await grid.waitFor();
    assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
    assert.match(await grid.innerText(), /抓握状态/);

    const inline = page.locator("[data-continuity-inline-editor]");

    // Row-level add: reachable without hunting for the right Shot cell, and it
    // announces the exact Shot/frame it will use.
    const rowAdd = grid.locator("[data-continuity-row-add]").first();
    await rowAdd.waitFor();
    assert.equal(await rowAdd.isDisabled(), false);
    assert.match(String(await rowAdd.getAttribute("title")), /翠子伸手抓住顺子/);
    await rowAdd.click();
    await inline.waitFor();
    // The form leads with the state, reads the position as seconds, and keeps
    // the derived before-state visible above it.
    assert.match(await inline.innerText(), /变化前[\s\S]*尚未抓住顺子的手臂[\s\S]*变化后/);
    assert.match(await inline.innerText(), /发生时刻[\s\S]*第 0\.0 秒 · 镜内第 0 \/ 96 帧/);
    // The status line explains what is still missing instead of echoing the placeholder.
    assert.match(await inline.locator("footer").innerText(), /还没选变化后的状态/);
    assert.equal(await inline.locator("[data-continuity-frame-slider]").isVisible(), true);
    const order = await inline.evaluate(element => {
        const text = element.textContent || "";
        return [text.indexOf("变化后"), text.indexOf("发生时刻"), text.indexOf("变化原因"), text.indexOf("剧本依据")];
    });
    assert.ok(order.every(index => index >= 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `field order is ${order}`);

    // The state picker accepts typed input: an unseen name is offered as a new
    // state value, which joins the fact enum so the ledger validator keeps
    // accepting the event.
    const afterSelect = inline.locator('.ant-select:has([aria-label="变化后"])');
    const fresh = "整队完毕重新列阵";
    await afterSelect.click();
    await inline.locator('input[aria-label="变化后"]').fill(fresh);
    const addOption = page.locator("[data-continuity-add-value-option]");
    await addOption.waitFor();
    assert.match(await addOption.innerText(), new RegExp(fresh));
    await addOption.click();
    await page.waitForFunction(text => document.querySelector("[data-continuity-inline-editor]")?.textContent?.includes(text), fresh);
    await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { hasText: fresh }).first().waitFor();
    await page.keyboard.press("Escape");
    assert.match(await afterSelect.innerText(), new RegExp(fresh));

    // The reason is optional metadata now, so an empty one never blocks the change.
    assert.match(await inline.innerText(), /变化原因 · 可不填/);
    assert.equal(await inline.getByRole("button", { name: "确认这次变化" }).isDisabled(), false);

    // The added value carries the description the save contract requires, so the
    // ledger can actually be written.
    await page.getByRole("button", { name: "取消新增" }).click();
    await inline.getByRole("button", { name: /关闭就地编辑/ }).click();
    await inline.waitFor({ state: "hidden" });
    await page.locator("[data-continuity-save-action]").click();
    await page.waitForFunction(
        text => (document.querySelector('[data-testid="continuity-ledger"]')?.textContent || "").includes(text),
        `"${fresh}":"${fresh}"`,
    );
    const savedLedger = JSON.parse(await page.locator('[data-testid="continuity-ledger"]').textContent());
    assert.deepEqual(savedLedger.facts[0].value_descriptions[fresh], fresh);
    assert.equal(savedLedger.facts[0].allowed_values.includes(fresh), true, "the saved ledger keeps the new state");

    // Per-cell add is always visible and larger than before.
    const cellAdd = grid.locator("[data-continuity-add]").first();
    await cellAdd.waitFor();
    const box = await cellAdd.boundingBox();
    assert.ok(box && box.width >= 24 && box.height >= 24, `cell add hit area is ${JSON.stringify(box)}`);

    // Inspector add opens the same form in the panel instead of the small popover.
    const inspector = page.locator(".continuity-live-inspector");
    const inspectorAdd = inspector.locator("[data-continuity-add-here]");
    await inspectorAdd.waitFor();
    await inspectorAdd.click();
    await inspector.locator("[data-continuity-frame-slider]").waitFor();
    assert.equal(await inline.isVisible(), false, "the inspector add must not open the on-canvas popover");
    await inspector.getByRole("button", { name: "取消新增" }).click();

    // Editing no longer depends on an 18px pin: the inspector lists the Shot's changes.
    const changes = inspector.locator(".continuity-shot-changes");
    await changes.waitFor();
    assert.match(await changes.innerText(), /本镜变化（1）/);
    assert.match(await changes.innerText(), /尚未抓住顺子的手臂 → 左手握住顺子的右上臂/);
    await changes.locator(".continuity-change-row").first().click();
    const pair = inspector.locator(".continuity-before-after");
    await pair.waitFor();
    assert.match(await pair.innerText(), /变化前[\s\S]*尚未抓住顺子的手臂/);
    // The after-state is edited once, in the picker, so it is not echoed twice.
    assert.doesNotMatch(await pair.innerText(), /左手握住顺子的右上臂/);
    assert.match(await inspector.locator('.ant-select:has([aria-label="变化后"])').innerText(), /左手握住顺子的右上臂/);
    assert.equal(await inline.isVisible(), false, "inspector editing must not steal the canvas popover");
    assert.match(await inspector.innerText(), /原文[\s\S]*翠子抓住顺子的手臂/);

    assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
    const images = join(tmpdir(), "canvas-continuity-workbench");
    await mkdir(images, { recursive: true });
    await page.screenshot({ path: join(images, "workbench-light.png"), animations: "disabled" });
    console.log("continuity workbench entry points verified");
} finally {
    await browser.close();
}
