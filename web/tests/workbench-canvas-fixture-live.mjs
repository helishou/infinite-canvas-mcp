import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root.dataDir || path.join(os.homedir(), ".infinite-canvas"), "backend.json"), "utf8"));
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], rejectedWrites = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ url, token }) => { localStorage.setItem("backend-url", url); localStorage.setItem("backend-token", token); }, config);
    // Only ephemeral projects are mocked. All mutation routes are blocked before reaching Backend.
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
            rejectedWrites.push(url.pathname); await route.fulfill({ status: 200, json: { ok: true } }); return;
        }
        const projectId = url.pathname.match(/\/canvas\/projects\/(overlay-test-[^/]+)/)?.[1];
        if (!projectId) { await route.continue(); return; }
        if (url.pathname.endsWith("/production-context")) { await route.fulfill({ json: { ok: true, context: { role: "ordinary", canvasId: projectId } } }); return; }
        const shared = projectId === "overlay-test-shared";
        await route.fulfill({ json: { ok: true, project: { id: projectId, title: shared ? "共享资产测试画布" : "分集测试画布", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", nodes: [{ id: `${projectId}-node`, type: "text", title: shared ? "共享图片节点" : "测试节点", position: { x: shared ? 10000 : 0, y: shared ? 10000 : 0 }, width: 240, height: 160, metadata: { content: "仅用于交互验收，不生成媒体。" } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false } } });
    });
    await page.goto(`${process.env.WORKBENCH_WEB_URL || "http://127.0.0.1:3001"}/tests/workbench-canvas-fixture.html`);
    const draft = page.getByRole("textbox", { name: "制作草稿" });
    await draft.fill("保留这个制作对象的编辑");
    const originalURL = page.url();
    const shotEditor = page.locator('[data-subject-shot-editor="shot-fixture"]');
    await shotEditor.getByRole("tab", { name: "分镜图与关键帧", exact: true }).click();
    await shotEditor.getByRole("link", { name: "打开画布创建或迭代分镜图", exact: true }).click();
    await page.locator('[data-node-id="overlay-test-main-node"]').waitFor();
    assert.equal(page.url(), originalURL, "keyframe creation keeps the workbench mounted");
    await page.getByRole("button", { name: "收起画布", exact: true }).click();
    assert.equal(await draft.inputValue(), "保留这个制作对象的编辑");
    // A plain canvas delta must reach the workbench selector without any production update or reload.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "canvas.updated", entityId: "overlay-test-main", revision: 2, payload: { operations: [{ type: "add_node", id: "overlay-test-new-picture", nodeType: "config", title: "刚创建的图片节点", position: { x: 10000, y: 0 }, width: 320, height: 240, metadata: { smart: true, generationMode: "image" } }] } } })));
    const selector = shotEditor.getByRole("combobox").first();
    await selector.click();
    await page.getByText("刚创建的图片节点 · 当前画布", { exact: true }).last().click();
    const bind = shotEditor.getByRole("button", { name: "绑定分镜图", exact: true });
    assert.equal(await bind.isEnabled(), true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "canvas.updated", entityId: "overlay-test-main", revision: 3, payload: { operations: [{ type: "update_node", id: "overlay-test-new-picture", patch: { title: "改名后的图片节点" } }] } } })));
    await shotEditor.getByTitle("改名后的图片节点 · 当前画布", { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "canvas.updated", entityId: "overlay-test-main", revision: 4, payload: { operations: [{ type: "delete_node", id: "overlay-test-new-picture" }] } } })));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-subject-shot-editor="shot-fixture"] button')).some(button => button.textContent === "绑定分镜图" && button.disabled));
    assert.equal(await bind.isEnabled(), false, "removed nodes cannot be bound from a stale selector value");
    assert.equal(await shotEditor.getByTitle("改名后的图片节点 · 当前画布", { exact: true }).count(), 0, "deleted temporary choice is cleared without changing Shot drafts");
    assert.equal(page.url(), originalURL);

    await page.getByRole("button", { name: "展开画布", exact: true }).click();
    await page.locator('[data-node-id="overlay-test-main-node"]').waitFor();
    await page.getByRole("button", { name: "收起画布", exact: true }).click();
    await page.getByRole("link", { name: "定位到图片画布" }).click();
    await page.locator('[data-node-id="overlay-test-shared-node"]').waitFor();
    assert.equal(await page.locator('[data-node-id="overlay-test-main-node"]').count(), 0);
    await page.waitForFunction(() => {
        const node = document.querySelector('[data-node-id="overlay-test-shared-node"]'), panel = document.querySelector('[data-workbench-canvas]');
        if (!node || !panel) return false;
        const n = node.getBoundingClientRect(), p = panel.getBoundingClientRect();
        return n.left >= p.left && n.right <= p.right && n.top >= p.top && n.bottom <= p.bottom;
    });
    const sharedCanvas = await page.locator("[data-workbench-canvas] main").evaluateHandle(element => element);
    await page.getByRole("button", { name: "收起画布", exact: true }).click();
    assert.equal(await draft.inputValue(), "保留这个制作对象的编辑");
    assert.equal(page.url(), originalURL);
    for (const [key, code] of [["Delete", "Delete"], [" ", "Space"], ["v", "KeyV"]]) {
        assert.equal(await page.evaluate(({ key, code }) => { const event = new KeyboardEvent("keydown", { key, code, ctrlKey: key === "v", bubbles: true, cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }, { key, code }), false);
    }
    assert.equal(await page.evaluate(() => {
        const clipboard = new DataTransfer(); clipboard.setData("text/plain", "hidden paste must not create a node");
        const event = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
        window.dispatchEvent(event); return event.defaultPrevented;
    }), false, "hidden canvas must not consume paste");
    await page.getByRole("button", { name: "展开画布", exact: true }).click();
    assert.equal(await page.locator("[data-workbench-canvas] main").evaluate((element, previous) => element === previous, sharedCanvas), true);
    await page.getByRole("button", { name: "收起画布", exact: true }).click();
    await page.getByRole("button", { name: "切换制作对象", exact: true }).click();
    assert.equal(await page.locator("[data-workbench-canvas]").count(), 0);
    assert.equal(await draft.inputValue(), "");
    assert.equal(await page.evaluate(() => document.body.style.overflow), "");
    assert.deepEqual(errors, []);
    assert.equal(rejectedWrites.filter(url => /\/(tasks|production\/ops|canvas\/projects\/[^/]+\/ops)$/.test(url)).length, 0);
    console.log(JSON.stringify({ passed: true, strictMode: true, sharedCanvasRestored: true, draftScopeIsolated: true, hiddenKeyboardIsolated: true, previousCanvasReleased: true, nodeSelectorFollowsCanvasDeltas: true, removedNodeCannotBind: true, mediaRequests: 0 }));
} finally { await browser.close(); }
