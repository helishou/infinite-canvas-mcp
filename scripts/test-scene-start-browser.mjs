import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.CANVAS_TEST_WEB || "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/tests/scene-production.html?scenario=waiting`);
    const start = page.getByRole("button", { name: /并行推进到 H3/ });
    await page.getByText("workspace routing discovery failed", { exact: false }).first().waitFor();
    await page.getByText("制作遇到问题，需要导演处理", { exact: true }).waitFor();
    await page.getByRole("button", { name: "交给导演处理", exact: true }).nth(2).click();
    const directorRequests = JSON.parse(await page.getByTestId("director-requests").textContent());
    assert.equal(directorRequests.length, 1);
    assert.equal(directorRequests[0].targetId, "B");
    assert.equal(directorRequests[0].workId, "work-B");
    assert.match(directorRequests[0].instruction, /workspace routing discovery failed/);
    assert.match(directorRequests[0].instruction, /scene-fixture/);
    assert.deepEqual(JSON.parse(await page.getByTestId("commands").textContent()), [], "director handoff must not start, resume or approve production work");
    await start.click();
    await page.getByText("已提交 4 个场次继续推进到 H3", { exact: false }).waitFor();
    const commands = JSON.parse(await page.getByTestId("commands").textContent());
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].sceneIds, ["A", "B", "C", "D"]);
    assert.equal(commands[0].generateMedia, true);
    assert.equal(await page.locator("table").getByText("workspace routing discovery failed", { exact: false }).count(), 4, "acceptance must not hide the upstream review blocker");
    await page.evaluate(() => window.__sceneProductionTest.failNextStart());
    await start.click();
    await page.locator(".ant-alert-error").getByText("模拟：推进请求被拒绝", { exact: false }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent.includes("并行推进到 H3"))?.disabled);
    assert.match(await page.locator(".ant-alert-error").innerText(), /推进请求被拒绝/, "error survives commandPending returning to false");

    await page.goto(`${base}/tests/scene-production.html`);
    await page.getByRole("button", { name: "并行制作源稿", exact: true }).waitFor();
    await page.getByRole("button", { name: /并行推进到 H3/ }).click();
    await page.getByText("已提交 3 个场次继续推进到 H3", { exact: false }).waitFor();
    const selective = JSON.parse(await page.getByTestId("commands").textContent());
    assert.deepEqual(selective[0].sceneIds, ["A", "B", "D"], "completed scenes are not regenerated");
    assert.deepEqual(errors, []);
    console.log("PASS: source-stage shared-review continuation, selective unfinished scenes, visible acceptance, persistent rejection, and no implicit upstream success.");
} finally {
    await browser.close();
}
