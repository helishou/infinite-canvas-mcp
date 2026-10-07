import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 700 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // 此页仅测试真实组件和编辑回放，不允许触及常驻 Backend 数据。
    await page.route("http://127.0.0.1:17370/**", (route) => route.fulfill({ status: 503, json: { ok: false } }));
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/h3-timeline-edits.html`);
    const state = () => page.getByTestId("segments").textContent().then(JSON.parse);
    const verify = async () => {
        assert.equal(await page.getByTestId("verified").textContent(), "true");
        const operations = JSON.parse(await page.getByTestId("operations").textContent());
        assert.ok(operations.every((operation) => !Object.hasOwn(operation.patch || {}, "start")));
    };
    await page.getByRole("button", { name: "Duration A = 8" }).click();
    await verify();
    assert.deepEqual(await state(), [{ id: "a", start: 0, duration: 8 }, { id: "b", start: 8, duration: 5 }]);
    await page.locator('[data-segment-id="b"]').dragTo(page.locator('[data-segment-id="a"]'));
    await verify();
    assert.deepEqual(await state(), [{ id: "b", start: 0, duration: 5 }, { id: "a", start: 5, duration: 8 }]);
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await page.getByRole("button", { name: "Insert C" }).click();
    await verify();
    assert.deepEqual(await state(), [{ id: "b", start: 0, duration: 5 }, { id: "c", start: 5, duration: 3 }, { id: "a", start: 8, duration: 8 }]);
    await page.locator('[data-segment-id="c"] button[title="删除 Clip"]').click();
    await verify();
    assert.deepEqual(await state(), [{ id: "b", start: 0, duration: 5 }, { id: "a", start: 5, duration: 8 }]);
    assert.deepEqual(errors, []);
    console.log("PASS: actual Clip drag, duration edit, insertion, deletion, light/dark rendering and operation replay");
} finally {
    await browser.close();
}
