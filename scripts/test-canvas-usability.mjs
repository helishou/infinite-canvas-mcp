import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const backend = process.env.CANVAS_TEST_BACKEND, web = process.env.CANVAS_TEST_WEB, artifacts = process.env.CANVAS_TEST_ARTIFACTS;
if (!backend || !web || !artifacts || !process.env.INFINITE_CANVAS_DATA_DIR) throw new Error("Run through the isolated browser test launcher");
const { token } = JSON.parse(fs.readFileSync(path.join(process.env.INFINITE_CANVAS_DATA_DIR, "backend.json"), "utf8"));
const id = `usability-${crypto.randomUUID()}`;
const api = async (method, route, body) => {
    const response = await fetch(backend + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
};
const node = (id, title, x, y = 150) => ({ id, title, type: "text", position: { x, y }, width: 240, height: 180, metadata: { content: `${title} original content` } });
const nodes = [node("a", "镜头 A", 120), node("b", "镜头 B", 650), node("far", "远方的猫", 4600), { ...node("h3", "H3 Clip", -1800), type: "minimax-h3:video", width: 620, height: 700, metadata: { segments: [{ id: "clip-one", prompt: "夜晚追逐", duration: 4, status: "idle", referenceBindings: [] }] } }];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript(({ backend, token }) => { localStorage.setItem("backend-url", backend); localStorage.setItem("backend-token", token); }, { backend, token });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const flush = () => page.evaluate(async () => (await import("/tests/canvas-command-harness.ts")).flushCanvasSyncNow());
const project = async () => (await api("GET", `/canvas/projects/${id}`)).project;
const readyDialog = async (title) => page.waitForFunction((title) => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) => element.textContent.includes(title));
    if (!dialog) return false;
    for (let element = dialog; element && element !== document.body; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (Number(style.opacity) < .99 || style.visibility === "hidden" || style.display === "none" || element.getAnimations().some((animation) => animation.playState === "running")) return false;
    }
    return true;
}, title);
async function visible(nodeId) {
    await page.waitForFunction((id) => {
        const node = document.querySelector(`[data-node-id="${id}"]`);
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const canvas = node.closest(".origin-top-left")?.parentElement?.getBoundingClientRect();
        return canvas && rect.width > 0 && rect.left >= canvas.left && rect.right <= canvas.right && rect.top >= canvas.top && rect.bottom <= canvas.bottom;
    }, nodeId);
}
try {
    await api("POST", "/canvas/projects", { id, title: "日常操作验证", nodes, connections: [], revision: 0, updatedAt: new Date().toISOString() });
    await page.goto(`${web}/canvas/${id}`);
    await page.locator('[data-node-id="a"]').waitFor();
    await flush();
    const initial = await project();
    await page.keyboard.press("Control+k");
    const finder = page.getByRole("dialog", { name: "查找节点", exact: true });
    await finder.waitFor();
    await readyDialog("查找节点");
    const search = finder.getByRole("textbox", { name: "搜索节点", exact: true });
    await search.fill("镜头");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await finder.waitFor({ state: "hidden" }); await visible("b");
    console.log("PASS: Ctrl+K searches nodes and ArrowDown/Enter focuses the chosen result");

    await page.getByRole("button", { name: "查找节点", exact: true }).click();
    await readyDialog("查找节点");
    await search.fill("far"); await page.keyboard.press("Enter");
    await finder.waitFor({ state: "hidden" }); await visible("far");
    assert.equal((await project()).revision, initial.revision);
    console.log("PASS: ID lookup reaches a distant node without modifying the project");

    await page.keyboard.press("Control+k");
    await readyDialog("查找节点");
    await search.fill("夜晚追逐");
    await finder.getByRole("option").first().waitFor();
    assert.match(await finder.getByRole("option").first().innerText(), /H3 Clip/);
    // Finish the preceding focus animation before checking that typing does not start another.
    await page.evaluate(() => new Promise((resolve) => {
        let previous = "", stable = 0;
        const tick = () => {
            const current = document.querySelector(".origin-top-left")?.getAttribute("style") || "";
            stable = current === previous ? stable + 1 : 0; previous = current;
            if (stable >= 3) resolve(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }));
    const beforeTyping = await page.locator(".origin-top-left").first().getAttribute("style");
    await search.fill(""); await search.press("f");
    assert.equal(await search.inputValue(), "f");
    assert.equal(await page.locator(".origin-top-left").first().getAttribute("style"), beforeTyping);
    await page.keyboard.press("Escape");
    await finder.waitFor({ state: "hidden" });
    console.log("PASS: Clip prompts are searchable; typing F in an input does not move the canvas");

    await page.keyboard.press("Escape");
    const labels = await page.evaluate(async () => { const { default: i18n } = await import("/src/i18n/index.ts"); return { expand: i18n.t("canvas.expandPanel"), select: i18n.t("canvas.sidePanel.select") }; });
    await page.getByRole("button", { name: labels.expand, exact: true }).click();
    await page.getByRole("button", { name: labels.select, exact: true }).click();
    await page.locator('[data-canvas-node-row="a"]').click();
    await page.locator('[data-canvas-node-row="b"]').click();
    assert.equal(await page.locator('[data-canvas-node-row="a"]').getAttribute("aria-pressed"), "true");
    const sidebarSearch = page.getByPlaceholder("搜索节点", { exact: true });
    await sidebarSearch.fill("镜头 A");
    const clearFiltered = await page.evaluate(async () => (await import("/src/i18n/index.ts")).default.t("canvas.sidePanel.clearAll"));
    await page.getByRole("button", { name: clearFiltered, exact: true }).click();
    await sidebarSearch.fill("");
    assert.equal(await page.locator('[data-canvas-node-row="a"]').getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator('[data-canvas-node-row="b"]').getAttribute("aria-pressed"), "true");
    await page.locator('[data-canvas-node-row="a"]').click();
    await page.getByRole("button", { name: "批量重命名", exact: true }).waitFor();
    await page.keyboard.press("f"); await visible("a"); await visible("b");
    await page.keyboard.press("Shift+f");
    for (const node of nodes) await visible(node.id);
    await page.getByRole("button", { name: "批量重命名", exact: true }).waitFor();
    console.log("PASS: Sidebar multi-selection drives canvas actions; F/Shift+F focus without clearing selection");

    const peer = await context.newPage();
    await peer.goto(`${web}/canvas/${id}`);
    await peer.locator('[data-node-id="a"]').waitFor();
    await page.getByRole("button", { name: "批量重命名", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "批量重命名", exact: true });
    await readyDialog("批量重命名");
    await rename.getByRole("textbox", { name: "名称前缀", exact: true }).fill("分镜");
    const number = rename.getByRole("spinbutton", { name: "起始序号", exact: true });
    await number.fill("");
    assert.ok(await rename.getByRole("button", { name: "重命名 0 个节点", exact: true }).isDisabled());
    await number.fill("7");
    await rename.getByText("分镜 07", { exact: true }).waitFor();
    await rename.getByText("分镜 08", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "rename-preview.png"), animations: "disabled" });
    const beforeRename = await project();
    await rename.getByRole("button", { name: "重命名 2 个节点", exact: true }).click();
    await rename.waitFor({ state: "hidden" }); await flush();
    const renamed = await project();
    assert.equal(renamed.nodes.find((node) => node.id === "a").title, "分镜 07");
    assert.equal(renamed.nodes.find((node) => node.id === "b").title, "分镜 08");
    assert.deepEqual(renamed.nodes.map(({ title, ...rest }) => rest), beforeRename.nodes.map(({ title, ...rest }) => rest));
    assert.equal(renamed.revision, beforeRename.revision + 1);
    await peer.locator('[data-node-id="a"]').hover();
    await peer.locator('[data-node-id="a"]').getByText("分镜 07", { exact: true }).waitFor();
    await page.keyboard.press("Control+z"); await flush();
    assert.deepEqual((await project()).nodes.map((node) => node.title), beforeRename.nodes.map((node) => node.title));
    await page.keyboard.press("Control+Shift+z"); await flush();
    assert.equal((await project()).nodes.find((node) => node.id === "a").title, "分镜 07");
    await peer.close();
    console.log("PASS: Batch rename previews numbering, updates the other window, changes titles only, and supports one-step undo/redo");

    await page.getByRole("button", { name: "完成多选", exact: true }).click();
    await page.getByRole("button", { name: "批量重命名", exact: true }).waitFor();
    await page.locator('[data-canvas-node-row="far"]').click({ modifiers: ["Control"] });
    await page.getByRole("button", { name: "批量重命名", exact: true }).click();
    await readyDialog("批量重命名");
    await rename.getByRole("button", { name: "重命名 3 个节点", exact: true }).waitFor();
    await rename.getByRole("button", { name: "重命名 3 个节点", exact: true }).focus();
    await page.keyboard.press("Escape"); await rename.waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-canvas-node-row="far"]').getAttribute("aria-pressed"), "true");
    console.log("PASS: Ctrl+click adds to selection; closing a dialog preserves the selection");

    await page.evaluate(async () => {
        (await import("/src/stores/use-theme-store.ts")).useThemeStore.getState().setTheme("light");
        await (await import("/src/i18n/index.ts")).default.changeLanguage("en-US");
    });
    await page.getByRole("button", { name: "Find nodes", exact: true }).click();
    const english = page.getByRole("dialog", { name: "Find nodes", exact: true });
    await readyDialog("Find nodes");
    await english.getByRole("textbox", { name: "Search nodes", exact: true }).fill("far");
    await english.getByRole("option").first().waitFor();
    await page.screenshot({ path: path.join(artifacts, "finder-light-en.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    console.log("PASS: Finder remains usable in the light theme and English locale");
} catch (error) {
    await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
    throw error;
} finally {
    await browser.close();
    await api("DELETE", `/canvas/projects/${id}`);
}
