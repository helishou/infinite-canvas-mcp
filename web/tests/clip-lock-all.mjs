import assert from "node:assert/strict";
import { chromium } from "playwright";

// 真实点击「全部锁定 / 全部解锁」：验证目标集合、乐观态、禁用边界与失败回滚。
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/canvas/projects/CLIP_LOCK_TEST/production?**", route => route.fulfill({ json: { ok: true, production: { workbench: {} } } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/clip-lock-all.html`);
    const lockAll = page.locator("[data-production-lock-all]");
    const unlockAll = page.locator("[data-production-unlock-all]");
    await lockAll.waitFor();
    const events = () => page.locator("[data-test-events]").innerText().then(JSON.parse);
    const waitForEventCount = (count) => page.waitForFunction(expected => JSON.parse(document.querySelector("[data-test-events]").textContent || "[]").length >= expected, count);

    // 初始 C1 已锁、C2 未锁：两个按钮都应有目标。
    assert.equal(await lockAll.isEnabled(), true, "lock-all should have C2 as target");
    assert.equal(await unlockAll.isEnabled(), true, "unlock-all should have C1 as target");
    assert.match(await lockAll.getAttribute("title") || "", /1 个 Clip/);

    await lockAll.click();
    await waitForEventCount(1);
    assert.deepEqual(await events(), [{ ids: ["C2"], locked: true }]);
    await page.waitForFunction(() => document.querySelector("[data-production-lock-all]").disabled === true);
    assert.equal(await lockAll.isDisabled(), true, "after locking all, nothing is left to lock");
    assert.equal(await unlockAll.isEnabled(), true);

    await unlockAll.click();
    await waitForEventCount(2);
    assert.deepEqual((await events())[1], { ids: ["C1", "C2"], locked: false });
    await page.waitForFunction(() => document.querySelector("[data-production-unlock-all]").disabled === true);
    assert.equal(await unlockAll.isDisabled(), true, "after unlocking all, nothing is left to unlock");
    assert.equal(await lockAll.isEnabled(), true);

    // 提交失败必须回滚乐观覆盖，否则界面会一直显示已锁定。
    await page.locator("[data-test-fail-next]").click();
    await lockAll.click();
    await waitForEventCount(3);
    assert.deepEqual((await events())[2], { ids: ["C1", "C2"], locked: true });
    await page.waitForFunction(() => document.querySelector("[data-production-lock-all]").disabled === false);
    assert.equal(await lockAll.isEnabled(), true, "failed batch must roll back optimistic overrides");
    assert.equal(await unlockAll.isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log("PASS: lock all / unlock all targets, optimistic state, disabled boundaries and failure rollback");
} finally {
    await browser.close();
}
