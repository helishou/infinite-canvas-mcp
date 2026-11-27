// 回归验收：后台暂时不可用时，原文对照不得从章节原文跳回分场稿；恢复后仍能读到新正文。
// 用法：node web/tests/drama-source-jump-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8"));
const dataDir = root.dataDir || path.join(os.homedir(), ".infinite-canvas");
const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "backend.json"), "utf8"));
const base = process.env.CANVAS_TEST_URL || "http://127.0.0.1:3001";
const dramaId = "VamH8sPw4qM_1H3Y0zWVb";
const epId = "episode-VamH8sPw4qM_1H3Y0zWVb-3-tsoon3";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    await page.addInitScript(({ url, token }) => {
        localStorage.setItem("backend-url", url);
        localStorage.setItem("backend-token", token);
    }, { url: cfg.url, token: cfg.token });

    const switchWorkspace = async (key) => {
        await page.locator(`[data-studio-workspace="${key}"]`).click();
        await page.waitForFunction((wanted) => {
            const el = document.querySelector(`[data-studio-workspace="${wanted}"]`);
            return Boolean(el && el.className.includes("bg-accent"));
        }, key, { timeout: 15000 });
    };
    const readSource = async () => (await page.locator("[data-studio-script-source]").innerText()).replace(/\n/g, " | ");

    await page.goto(`${base}/drama-studio?dramaId=${dramaId}&episodeId=${epId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator("[data-studio-script-source]").waitFor({ timeout: 30000 });
    // 等章节原文真正落到面板（标题从「第 N 段」变成「第 N 章」）。
    await page.waitForFunction(() => {
        const el = document.querySelector("[data-studio-script-source]");
        return Boolean(el && /第\s*\d+\s*章/.test(el.textContent || ""));
    }, null, { timeout: 30000 });
    const before = (await readSource()).slice(0, 160);

    // 用户先切到第 1 章，后台失联后重挂载应仍停在第 1 章。
    await page.locator('[data-studio-source-tabs] [role="tab"]').first().click();
    await page.waitForFunction(() => Boolean(document.querySelector('[data-studio-source-tabs] [role="tab"][aria-selected="true"]')?.textContent?.includes("第 1 章")), null, { timeout: 10000 });
    const selectedBefore = (await readSource()).slice(0, 160);

    // 模拟后台暂时不可用：章节原文与剧目级原文都返回 BACKEND_RELOADING。
    const unavailable = (route) => route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "BACKEND_RELOADING", code: "BACKEND_RELOADING" }),
    });
    await page.route(`**/drama/episodes/${epId}/chapters*`, unavailable);
    await page.route(`**/drama/${dramaId}/planning*`, unavailable);

    // 切走再切回剧本，触发 ScriptPanel 重新挂载/原文重读。
    await switchWorkspace("shots");
    await switchWorkspace("story");
    await page.waitForTimeout(2500);
    const selectedAfter = (await readSource()).slice(0, 160);

    // 后台恢复后重挂载：缓存只是占位，成功回包必须更新回当前正文。
    await page.unroute(`**/drama/episodes/${epId}/chapters*`, unavailable);
    await page.unroute(`**/drama/${dramaId}/planning*`, unavailable);
    await switchWorkspace("shots");
    await switchWorkspace("story");
    await page.waitForTimeout(2500);
    const recovered = (await readSource()).slice(0, 160);

    const passed = before === selectedBefore
        ? selectedBefore === selectedAfter && recovered === before
        : selectedBefore === selectedAfter && /第\s*1\s*章/.test(recovered);
    console.log(JSON.stringify({ before, selectedBefore, selectedAfter, recovered, passed, errors: errors.slice(0, 3) }, null, 2));
    if (!passed || errors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
