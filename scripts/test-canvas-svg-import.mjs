import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const backend = process.env.CANVAS_TEST_BACKEND;
const web = process.env.CANVAS_TEST_WEB;
const dataDir = process.env.INFINITE_CANVAS_DATA_DIR;
if (!backend || !web || !dataDir) throw new Error("Run through the isolated browser test launcher");
const { token } = JSON.parse(fs.readFileSync(path.join(dataDir, "backend.json"), "utf8"));
const projectId = `svg-import-${crypto.randomUUID()}`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 36"><rect width="64" height="36" fill="red"/></svg>';
const legacySvg = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>';
const api = async (method, route, body) => {
    const response = await fetch(backend + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
};
const browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });
const context = await browser.newContext();
await context.grantPermissions(["local-network-access"], { origin: web });
await context.addInitScript(({ backend, token }) => { localStorage.setItem("backend-url", backend); localStorage.setItem("backend-token", token); }, { backend, token });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const project = async () => (await api("GET", `/canvas/projects/${projectId}`)).project;
const flush = () => page.evaluate(async () => (await import("/tests/canvas-command-harness.ts")).flushCanvasSyncNow());

try {
    await api("POST", "/canvas/projects", { id: projectId, title: "SVG 导入验证", nodes: [{ id: "legacy-svg", type: "svg:vector", title: "旧 SVG", position: { x: -350, y: 100 }, width: 220, height: 220, metadata: { content: legacySvg } }], connections: [], revision: 0, updatedAt: new Date().toISOString() });
    await page.goto(`${web}/canvas/${projectId}`);
    await page.getByRole("button", { name: "上传资产" }).waitFor();
    await page.evaluate(async () => (await import("/src/lib/canvas/plugin-loader.ts")).installPluginFromUrl("/plugins/svg.js"));
    await page.evaluate(async () => {
        const { getNodeDefinition } = await import("/src/lib/canvas/node-registry.ts");
        if (!getNodeDefinition("svg:vector")) throw new Error("SVG plugin did not register");
    });
    const legacyPreview = page.locator('[data-node-id="legacy-svg"] img[src^="data:image/svg+xml"]');
    await legacyPreview.waitFor();
    assert.ok(await legacyPreview.evaluate((image) => image.complete && image.naturalWidth > 0), "Existing SVG source without xmlns should still preview");
    await page.getByRole("button", { name: "上传资产" }).click();
    const canvasUpload = page.locator('input[type="file"][accept*="audio/mpeg"]');
    await canvasUpload.setInputFiles({ name: "diagram.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
    await page.locator('[data-node-id] img[src^="data:image/svg+xml"]').first().waitFor();
    await flush();
    const importedNodes = (await project()).nodes;
    assert.equal(importedNodes.length, 2);
    const imported = importedNodes.find((node) => node.title === "diagram.svg");
    assert.equal(imported?.type, "svg:vector");
    assert.equal(imported.metadata.content, svg);
    await page.locator(`[data-node-id="${imported.id}"] img[src^="data:image/svg+xml"]`).waitFor();
    const rendered = await page.locator(`[data-node-id="${imported.id}"] img[src^="data:image/svg+xml"]`).evaluate((image) => image.complete && image.naturalWidth > 0);
    assert.ok(rendered, "Imported SVG should render in the existing plugin node");
    await page.screenshot({ path: path.join(process.env.CANVAS_TEST_ARTIFACTS, "svg-imported.png"), animations: "disabled" });
    await page.locator(`[data-node-id="${imported.id}"] button[title="编辑源码"]`).click();
    const editor = page.locator(`[data-node-id="${imported.id}"] .cm-content[contenteditable="true"]`);
    try {
        await editor.waitFor({ timeout: 5000 });
    } catch (error) {
        console.log("SVG node after edit click:", (await page.locator(`[data-node-id="${imported.id}"]`).first().innerText()).slice(0, 400));
        console.log("Edit button titles:", await page.locator(`[data-node-id="${imported.id}"] button`).evaluateAll((buttons) => buttons.map((button) => button.title)));
        await page.screenshot({ path: path.join(process.env.CANVAS_TEST_ARTIFACTS, "svg-edit-failure.png") });
        throw error;
    }
    const editedSvg = svg.replace('fill="red"', 'fill="blue"');
    await editor.fill(editedSvg);
    await page.evaluate(async (nodeId) => {
        const { getCanvasTextSession } = await import("/src/services/api/canvas-text.ts");
        await getCanvasTextSession(window.location.pathname.split("/").at(-1), { nodeId, field: "content" }).flush();
    }, imported.id);
    assert.equal((await project()).nodes.find((node) => node.id === imported.id)?.metadata.content, editedSvg);
    await page.locator(`[data-node-id="${imported.id}"] button[title="预览"]`).click();
    await page.reload();
    await page.locator(`[data-node-id="${imported.id}"] img[src^="data:image/svg+xml"]`).waitFor();
    assert.equal((await project()).nodes.find((node) => node.id === imported.id)?.metadata.content, editedSvg);
    const restored = await page.locator(`[data-node-id="${imported.id}"] img`).getAttribute("src");
    assert.ok(restored?.includes(encodeURIComponent('fill="blue"')));
    console.log("PASS: SVG file creates a previewable, editable SVG plugin node");

    await page.getByRole("button", { name: "上传资产" }).click();
    await canvasUpload.setInputFiles({ name: "broken.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<html>not SVG</html>") });
    await page.getByText("SVG 文件无法解析，未导入画布").waitFor();
    await flush();
    assert.equal((await project()).nodes.length, 2);
    await page.evaluate(async () => (await import("/src/lib/canvas/plugin-loader.ts")).deactivatePlugin("svg"));
    await page.getByRole("button", { name: "上传资产" }).click();
    await canvasUpload.setInputFiles({ name: "fallback.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
    await page.getByText("SVG 节点插件未启用，将按普通图片导入").waitFor();
    await page.locator('[data-node-id^="image-"]').waitFor();
    await flush();
    const fallback = (await project()).nodes.find((node) => node.title === "fallback.svg");
    assert.equal(fallback?.type, "image");
    assert.equal(fallback.metadata.mimeType, "image/svg+xml");
    assert.deepEqual(pageErrors, []);
    console.log("PASS: Edits survive refresh; invalid SVG is rejected; disabling the plugin falls back to image media");
} finally {
    await browser.close();
    await api("DELETE", `/canvas/projects/${projectId}`);
}
