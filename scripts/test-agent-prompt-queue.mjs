import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "web/package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const cache = path.join(root, ".tmp", `agent-prompt-queue-vite-${process.pid}`);
fs.mkdirSync(cache, { recursive: true });
process.env.CANVAS_TEST_VITE_CACHE = cache;
const portProbe = net.createServer();
await new Promise((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve); });
const probeAddress = portProbe.address();
if (!probeAddress || typeof probeAddress === "string") throw new Error("Could not allocate a local browser-test port");
const testPort = probeAddress.port;
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
const server = await createServer({
    root: path.join(root, "web"),
    configFile: path.join(root, "web/vite.config.ts"),
    cacheDir: cache,
    optimizeDeps: { entries: ["tests/agent-prompt-queue-harness.html"] },
    server: { port: testPort, strictPort: true, host: "127.0.0.1" },
});
let browser;
try {
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.port, testPort);
    const scanProcessing = server.environments?.client?.depsOptimizer?.scanProcessing;
    if (scanProcessing) await scanProcessing;
    const moduleResponse = await fetch(`http://127.0.0.1:${testPort}/tests/agent-prompt-queue-harness.tsx`, { signal: AbortSignal.timeout(60000) });
    assert.equal(moduleResponse.status, 200, "Vite must transform the harness entry");
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CANVAS_TEST_BROWSER ? { executablePath: process.env.CANVAS_TEST_BROWSER } : fs.existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe") ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : fs.existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? { executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    const badResponses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(`${msg.text()} at ${JSON.stringify(msg.location())}`); });
    page.on("response", (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
    page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText || "request failed"}`));
    const entry = await fetch(`http://127.0.0.1:${testPort}/tests/agent-prompt-queue-harness.html`);
    assert.equal(entry.status, 200, "Vite must serve the isolated harness entry");
    await page.goto(`http://127.0.0.1:${testPort}/tests/agent-prompt-queue-harness.html`, { waitUntil: "commit", timeout: 30000 });
    const calls = () => page.evaluate(() => window.__agentPromptQueueTest.calls);
    const snapshot = () => page.evaluate(() => window.__agentPromptQueueTest.snapshot());
    const turnBodies = async () => (await calls()).filter((call) => call.path === "/agent/codex/turn" && call.method === "POST").map((call) => call.body);

    const composer = page.getByRole("textbox").first();
    await composer.waitFor();
    assert.equal(await composer.getAttribute("contenteditable"), "true", "the composer must remain editable while Codex runs");

    await composer.fill("queued instruction A");
    await page.getByRole("button", { name: "加入队列", exact: true }).click();
    await page.getByTestId("agent-queued-prompt").filter({ hasText: "queued instruction A" }).waitFor();
    await composer.fill("queued instruction B");
    await page.getByRole("button", { name: "加入队列", exact: true }).click();
    await page.getByTestId("agent-queued-prompt").filter({ hasText: "queued instruction B" }).waitFor();
    await page.evaluate(() => window.__agentPromptQueueTest.setLanguage("en-US"));
    await page.getByRole("button", { name: "Queue next", exact: true }).waitFor();
    await page.getByRole("button", { name: "Remove", exact: true }).first().waitFor();
    await page.evaluate(() => window.__agentPromptQueueTest.setLanguage("zh-CN"));
    await composer.fill("remove this instruction");
    await page.evaluate(() => window.__agentPromptQueueTest.setAttachmentFixture());
    await page.getByRole("button", { name: "加入队列", exact: true }).click();
    const removable = page.getByTestId("agent-queued-prompt").filter({ hasText: "remove this instruction" });
    await removable.getByRole("button", { name: "移除", exact: true }).waitFor();
    const attachment = (await snapshot()).queue.find((item) => item.text === "remove this instruction")?.attachments[0];
    assert.ok(attachment?.url.startsWith("data:image/"), "queued attachments must not depend on revocable object URLs");
    assert.equal(attachment.url, attachment.dataUrl);
    await removable.getByRole("button", { name: "移除", exact: true }).click();
    await removable.waitFor({ state: "detached" });

    assert.equal((await turnBodies()).length, 0, "busy queue submission must not start a turn");
    const queuedState = await snapshot();
    assert.deepEqual(queuedState.users, [], "queued text must not appear as a sent timeline message");
    assert.deepEqual(queuedState.queue.map((item) => item.text), ["queued instruction A", "queued instruction B"]);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.filter((call) => call.path === "/agent/codex/interrupt" && call.method === "POST").length === 1);
    assert.equal((await snapshot()).paused, true, "ordinary Stop must pause the queue before the interrupt settles");
    assert.equal((await turnBodies()).length, 0, "a paused queue must not dispatch on idle");
    await page.getByRole("button", { name: "继续队列", exact: true }).click();
    await page.evaluate(() => window.__agentPromptQueueTest.setIdle(11));
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.filter((call) => call.path === "/agent/codex/turn" && call.method === "POST").length === 1);
    assert.match(JSON.stringify((await turnBodies())[0]), /queued instruction A/);
    const sentState = await snapshot();
    const firstTurn = (await turnBodies())[0];
    assert.equal(sentState.users.filter((item) => item.clientMessageId === firstTurn.messageId).length, 1, "the dispatched queue item must create exactly one user timeline message");
    await page.evaluate(() => window.__agentPromptQueueTest.setIdle(11, false));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await turnBodies()).length, 1, "a duplicate idle snapshot must not resend the claimed item");
    await page.evaluate(() => window.__agentPromptQueueTest.setBusy(12));
    await page.evaluate(() => window.__agentPromptQueueTest.setIdleInNewInstance("queue-runtime-restarted", 1));
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.filter((call) => call.path === "/agent/codex/turn" && call.method === "POST").length === 2);
    assert.match(JSON.stringify((await turnBodies())[1]), /queued instruction B/);

    await page.evaluate(() => window.__agentPromptQueueTest.setBusy(14));
    await composer.fill("queued instruction C");
    await page.getByRole("button", { name: "加入队列", exact: true }).click();
    await composer.fill("insert this instruction now");
    await page.getByRole("button", { name: "加入队列", exact: true }).click();
    const inserted = page.getByTestId("agent-queued-prompt").filter({ hasText: "insert this instruction now" });
    await page.evaluate(() => window.__agentPromptQueueTest.setInterruptStatus(409));
    await inserted.getByRole("button", { name: "插入并引导", exact: true }).click();
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.filter((call) => call.path === "/agent/codex/interrupt" && call.method === "POST").length === 2);
    await inserted.getByRole("button", { name: "重试", exact: true }).waitFor();
    assert.equal((await turnBodies()).length, 2, "a rejected interrupt must retain the item without submitting it");
    assert.equal((await snapshot()).queue.find((item) => item.text === "insert this instruction now")?.status, "failed");
    await page.evaluate(() => window.__agentPromptQueueTest.setInterruptStatus(200));
    await inserted.getByRole("button", { name: "重试", exact: true }).click();
    await inserted.getByRole("button", { name: "插入并引导", exact: true }).click();
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.filter((call) => call.path === "/agent/codex/interrupt" && call.method === "POST").length === 3);
    assert.equal((await turnBodies()).length, 2, "interrupt ACK must not submit before authoritative idle");
    await page.evaluate(() => window.__agentPromptQueueTest.setIdle(15));
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.filter((call) => call.path === "/agent/codex/turn" && call.method === "POST").length === 3);
    assert.match(JSON.stringify((await turnBodies())[2]), /insert this instruction now/);
    await page.evaluate(() => window.__agentPromptQueueTest.setBusy(16));
    await page.evaluate(() => window.__agentPromptQueueTest.setIdle(17));
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.filter((call) => call.path === "/agent/codex/turn" && call.method === "POST").length === 4);
    assert.match(JSON.stringify((await turnBodies())[3]), /queued instruction C/);

    await page.evaluate(() => window.__agentPromptQueueTest.setQueuePaused(true));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await snapshot()).queue.length, 0, "every queued instruction must have been dispatched");
    assert.equal(await page.getByTestId("agent-queued-prompt").count(), 0, "an empty queue must not render the queue panel even when paused");
    assert.equal(await page.getByText("队列已暂停", { exact: true }).count(), 0, "an empty queue must not show the paused notice");

    const writes = (await calls()).filter((call) => call.method !== "GET" && !["/agent/codex/turn", "/agent/codex/interrupt"].includes(call.path));
    assert.deepEqual(writes, [], "the isolated harness must not issue unrelated writes");
    assert.deepEqual(errors, [], `the page must not throw; bad responses: ${JSON.stringify(badResponses)}`);
    await page.evaluate(() => window.__agentPromptQueueTest.setBusy(18));
    await composer.fill("survives refresh with image");
    await page.evaluate(() => window.__agentPromptQueueTest.setAttachmentFixture());
    await page.getByRole("button", { name: "加入队列", exact: true }).click();
    await page.getByTestId("agent-queued-prompt").waitFor();
    await page.evaluate(() => window.__agentPromptQueueTest.flushQueue());
    const beforeReload = await snapshot();
    const clientId = await page.evaluate(() => sessionStorage.getItem("canvas-agent-client-id"));
    await page.reload();
    await page.getByTestId("agent-queued-prompt").waitFor();
    assert.deepEqual((await snapshot()).queue, beforeReload.queue, "reload restores the same IDs, order, and image payloads");
    assert.equal((await snapshot()).paused, true, "reload preserves the paused queue");
    await page.evaluate(() => window.__agentPromptQueueTest.setIdle(20));
    assert.equal((await turnBodies()).length, 0, "a restored paused queue must not send automatically");

    const duplicate = await page.context().newPage();
    await duplicate.addInitScript((id) => sessionStorage.setItem("canvas-agent-client-id", id), clientId);
    await duplicate.goto(page.url());
    await duplicate.waitForFunction((id) => sessionStorage.getItem("canvas-agent-client-id") !== id, clientId);
    await duplicate.getByRole("textbox").first().waitFor();
    assert.equal(await duplicate.getByTestId("agent-queued-prompt").count(), 0, "a duplicated tab must not claim another tab's queue");
    await duplicate.close();
    await page.getByRole("button", { name: "继续队列", exact: true }).click();
    await page.waitForFunction(() => window.__agentPromptQueueTest.calls.some((call) => call.path === "/agent/codex/turn"));
    assert.equal((await turnBodies()).length, 1, "resuming sends the restored instruction exactly once");
    assert.match(JSON.stringify((await turnBodies())[0]), /survives refresh with image/);
    await page.evaluate(() => window.__agentPromptQueueTest.flushQueue());
    await page.reload();
    await page.getByRole("textbox").first().waitFor();
    assert.equal((await snapshot()).queue.length, 0, "confirmed sends remain removed after reload");
    console.log("PASS: queue ordering, interrupts, refresh with images and pause state, duplicated-tab isolation, and no replay after confirmed send.");
} finally {
    await browser?.close();
    await server.close();
    const resolved = fs.realpathSync(cache);
    const allowedRoot = fs.realpathSync(path.join(root, ".tmp"));
    if (!resolved.startsWith(allowedRoot + path.sep) || !path.basename(resolved).startsWith("agent-prompt-queue-vite-")) throw new Error("Unsafe prompt-queue harness cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
}
