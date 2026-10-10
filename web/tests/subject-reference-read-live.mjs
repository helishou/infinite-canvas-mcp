import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root.dataDir || path.join(os.homedir(), ".infinite-canvas"), "backend.json"), "utf8"));
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], writes = [];
    let mode = "fail", reads = 0, release, pendingStarted, image = "image:reference-first";
    const pendingReady = new Promise(resolve => { pendingStarted = resolve; });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ url, token }) => { localStorage.setItem("backend-url", url); localStorage.setItem("backend-token", token); }, config);
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { writes.push(url.pathname); await route.fulfill({ json: { ok: true } }); return; }
        if (url.searchParams.get("view") === "subject_workbench") {
            reads++;
            if (mode === "fail") { await route.fulfill({ status: 503, json: { error: "REFERENCE_READ_FIXTURE_FAILURE" } }); return; }
            if (mode === "pending") await new Promise(resolve => { release = resolve; pendingStarted(); });
            await route.fulfill({ json: { ok: true, production: { workbench: { pictureBindings: [{ id: "BIND_MESSENGER", resolved: image ? { storageKey: image } : null }] } } } }); return;
        }
        if (url.pathname.startsWith("/media/")) { await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#888"/></svg>' }); return; }
        await route.continue();
    });
    await page.goto(`${process.env.WORKBENCH_WEB_URL || "http://127.0.0.1:3001"}/tests/production-diagnostics.html?scenario=references`);
    await page.getByRole("button", { name: "角色与素材", exact: true }).first().click();
    const bindings = page.locator('[data-subject-picture-bindings="SUBJECT_MESSENGER"]');
    await bindings.getByText("图片引用读取失败", { exact: true }).waitFor();
    assert.equal(await bindings.getByText("暂无成功图片", { exact: true }).count(), 0, "transport failure is not a missing image");
    const failedReads = reads;
    mode = "success";
    await bindings.getByRole("button", { name: "重新读取", exact: true }).click();
    const firstImage = bindings.locator('img[src*="reference-first"]');
    await firstImage.waitFor();
    assert.equal(reads, failedReads + 1);
    mode = "pending";
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "canvas.updated", entityId: "fixture", payload: { operations: [{ type: "update_node", id: "image-style", metadata: { images: [] } }] } } })));
    await bindings.getByRole("status").waitFor();
    assert.equal(await firstImage.count(), 1, "last Backend-confirmed picture stays visible during refresh");
    await pendingReady;
    image = "image:reference-updated"; release();
    await bindings.locator('img[src*="reference-updated"]').waitFor();
    assert.equal(await firstImage.count(), 0);
    assert.equal(await bindings.getByText("图片引用读取失败", { exact: true }).count(), 0);
    image = "image:reference-follow-latest"; mode = "success";
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "canvas.updated", entityId: "fixture", payload: { operations: [{ type: "update_node", id: "image-style", metadataDelete: ["smartImageReferenceSelection"] }] } } })));
    await bindings.locator('img[src*="reference-follow-latest"]').waitFor();
    mode = "success"; image = "";
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "canvas.updated", entityId: "fixture", payload: { operations: [{ type: "delete_node", ids: ["unrelated-node", "image-style"] }] } } })));
    await bindings.getByText("暂无成功图片", { exact: true }).waitFor();
    assert.equal(await bindings.locator('img[src*="reference-updated"]').count(), 0, "batch deletion invalidates references too");
    mode = "fail";
    await page.getByRole("button", { name: "更换测试图片来源", exact: true }).click();
    await bindings.getByText("图片引用读取失败", { exact: true }).waitFor();
    assert.equal(await bindings.locator('img[src*="reference-updated"]').count(), 0, "a different binding source must not inherit the old picture");
    assert.deepEqual(errors, []);
    assert.equal(writes.filter(url => /\/(tasks|production\/ops)$/.test(url)).length, 0);
    console.log(JSON.stringify({ passed: true, failureDistinctFromMissing: true, explicitRetryRecovered: true, confirmedImageRetainedDuringRefresh: true, referenceEventUpdatedPreview: true, sourceChangeClearedOldImage: true, batchDeletionUpdatedPreview: true, mediaRequests: 0 }));
} finally { await browser.close(); }
