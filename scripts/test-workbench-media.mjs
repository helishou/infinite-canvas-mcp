import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "playwright";

// Use an independent browser context against the running Vite dev server, with fixture-only API/media.
const web = process.env.CANVAS_TEST_WEB || "http://127.0.0.1:3001";
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const sharp = requireBackend("sharp");
const image = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#789abc" } }).png().toBuffer();
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
        localStorage.setItem("backend-url", "http://127.0.0.1:17370");
        localStorage.setItem("backend-token", "fixture");
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let originalRequests = 0, videoRequests = 0;
    const coverRequests = { fast: 0, slow: 0 };
    let releaseSlow;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    await page.route("**/generation-logs?**", async (route) => {
        const id = new URL(route.request().url()).searchParams.get("projectId");
        coverRequests[id]++;
        if (id === "slow") await slow;
        await route.fulfill({ json: { logs: [{ id, projectId: id, status: "success", createdAt: "2026-01-01", outputs: [{ storageKey: `image:${id}` }] }] } });
    });
    await page.route("**/media/**", async (route) => {
        const url = decodeURIComponent(route.request().url());
        if (url.includes("image:large")) {
            originalRequests++;
            await route.fulfill({ contentType: "image/png", body: image });
        } else if (url.includes("video:offscreen")) {
            videoRequests++;
            await route.fulfill({ status: 404 });
        } else await route.fulfill({ status: 404 });
    });
    await page.goto(`${web}/tests/workbench-media.html`);
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="covers"]').textContent)[0]?.storageKey === "image:fast");
    assert.equal(JSON.parse(await page.getByTestId("covers").textContent())[1], null, "Fast cover renders while slow request is pending");
    releaseSlow();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="covers"]').textContent)[1]?.storageKey === "image:slow");
    assert.deepEqual(coverRequests, { fast: 1, slow: 1 }, "StrictMode shares cover requests");
    await page.getByRole("button", { name: "Toggle covers" }).click();
    await page.getByRole("button", { name: "Toggle covers" }).click();
    await page.getByTestId("covers").waitFor();
    assert.deepEqual(coverRequests, { fast: 1, slow: 1 }, "Returning to cards reuses the existing query cache");
    await page.waitForFunction(() => document.querySelector('[data-testid="image"] img')?.src.startsWith("blob:"));
    const dimensions = await page.getByTestId("image").locator("img").evaluate((img) => ({ width: img.naturalWidth, height: img.naturalHeight }));
    assert.deepEqual(dimensions, { width: 768, height: 432 });
    await page.waitForFunction(() => document.querySelector('[data-testid="missing"]').textContent.includes("Missing"));
    assert.equal(videoRequests, 0, "Offscreen videos do not download metadata");
    const beforeReload = originalRequests;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid="image"] img')?.src.startsWith("blob:"));
    assert.equal(originalRequests, beforeReload, "Reload uses IndexedDB thumbnail without downloading original");
    await page.getByRole("button", { name: "Toggle original" }).click();
    assert.ok((await page.getByTestId("image").locator("img").getAttribute("src")).includes("/media/"), "Explicit preview uses original media URL");
    await page.getByTestId("offscreen").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('[data-testid="offscreen"]').textContent.includes("Video"));
    assert.ok(videoRequests > 0, "Visible video starts its metadata request");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, thumbnail: dimensions, reloadOriginalRequests: 0, coverRequests, videoRequests }));
} finally {
    await browser.close();
}
