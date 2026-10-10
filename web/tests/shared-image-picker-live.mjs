import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { chromium } from "playwright";
const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root.dataDir || path.join(os.homedir(), ".infinite-canvas"), "backend.json"), "utf8"));
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ url, token }) => { localStorage.setItem("backend-url", url); localStorage.setItem("backend-token", token); }, config);
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { writes.push(url.pathname); await route.fulfill({ json: { ok: true } }); return; }
        if (url.pathname.endsWith("/canvas/projects/picker-shared")) {
            const node = (id, title) => ({ id, title, type: "config", width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { smart: true, generationMode: "image" } });
            await route.fulfill({ json: { ok: true, project: { id: "picker-shared", title: "共享画布", revision: 1, nodes: [node("same", "同名图片"), node("unadopted", "未采用图片")], connections: [], chatSessions: [], activeChatId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } } }); return;
        }
        await route.continue();
    });
    await page.goto(`${process.env.WORKBENCH_WEB_URL || "http://127.0.0.1:3001"}/tests/shared-image-picker-fixture.html`);
    await page.getByRole("tab", { name: "分镜图与关键帧", exact: true }).click();
    await page.getByRole("combobox").first().click();
    await page.getByTitle("同名图片 · 已采用共享来源", { exact: true }).waitFor();
    assert.equal(await page.getByTitle("同名图片 · 当前画布", { exact: true }).count(), 1);
    assert.equal(await page.getByText("未采用图片", { exact: true }).count(), 0);
    await page.getByTitle("同名图片 · 已采用共享来源", { exact: true }).click();
    await page.getByRole("button", { name: "绑定分镜图", exact: true }).click();
    await page.getByRole("button", { name: "保存镜头并同步", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="保存内容"]').textContent.includes('picker-shared'));
    const saved = JSON.parse(await page.getByLabel("保存内容").textContent());
    assert.deepEqual(saved.frames[0].sourceNode, { projectId: "picker-shared", nodeId: "same" }); assert.equal(saved.frames[0].assetId, "adopted");
    const duration = page.getByText("时长（制作帧率下的帧数）", { exact: true }).locator("..").getByRole("spinbutton");
    await duration.fill("48"); await duration.blur();
    await page.getByRole("button", { name: "保存镜头并同步", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[aria-label="保存内容"]').textContent).patch.duration_frames === 48);
    const resized = JSON.parse(await page.getByLabel("保存内容").textContent());
    assert.equal(resized.frames, undefined, "unchanged keyframe binding is not resubmitted on duration save");
    assert.deepEqual(errors, []); assert.equal(writes.filter(url => /\/(tasks|production\/ops)$/.test(url)).length, 0);
    console.log(JSON.stringify({ passed: true, equalNodeIdsDoNotCollide: true, adoptedAssetIdentityPreserved: true, unadoptedSourceExcluded: true, mediaSubmitted: false }));
} finally { await browser.close(); }
