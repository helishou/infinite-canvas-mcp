// 回归验收：剧目数据延迟到达时，DramaManagePanel 不得因 hook 数量变化而崩溃。
// 用法：node web/tests/drama-hooks-order-live.mjs
import { chromium } from "playwright";

const base = process.env.CANVAS_TEST_URL || "http://127.0.0.1:3001";
const backend = process.env.CANVAS_TEST_BACKEND || "http://127.0.0.1:17370";
const dramaId = "hooks-order-live";
const folder = {
    id: dramaId,
    name: "Hooks 验收剧目",
    outline: "用于验证剧目数据延迟到达时不发生 hooks 顺序错误。",
    description: "",
    tags: [],
    coverStorageKey: null,
    sharedAssetCanvasId: null,
    productionPlan: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
let loaded = false;
let hookErrors = [];
let otherErrors = [];
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    page.on("console", msg => {
        if (msg.type() === "error" && process.env.HOOKS_LIVE_DEBUG) console.error("DEBUG console:", msg.text().slice(0, 2000));
    });
    await page.addInitScript((value) => {
        localStorage.setItem("backend-url", value);
        localStorage.setItem("backend-token", "hooks-order-live-token");
    }, backend);
    await page.route("**/*", async route => {
        const request = route.request();
        let url;
        try { url = new URL(request.url()); } catch { return route.continue(); }
        if (url.origin !== backend) return route.continue();
        const path = url.pathname;
        const json = body => route.fulfill({ json: body });
        if (path.endsWith("/canvas/folders") && request.method() === "GET") {
            // 关键：让首次渲染发生在 folder 还不存在时，随后再送达剧目数据。
            await new Promise(resolve => setTimeout(resolve, 900));
            return json({ ok: true, folders: [folder] });
        }
        if (path.endsWith("/canvas/folders")) return json({ ok: true, folder });
        if (path.includes(`/drama/projects/${dramaId}/episodes`)) return json({ ok: true, dramaId, episodes: [] });
        if (path.endsWith(`/drama/${dramaId}/stage`)) return json({
            ok: true, dramaId, name: folder.name, states: [],
            next: { stage: null, action: "完成", skill: "", skillPath: "", gaps: [], line: "" },
            context: "", activity: null, episodes: [],
        });
        if (path.endsWith("/canvas/assets")) return json({ ok: true, assets: [], folders: [] });
        if (path.endsWith("/canvas/projects")) return json({ ok: true, projects: [] });
        if (path.includes("/canvas/tasks") || path.endsWith("/tasks")) return json({ ok: true, tasks: [] });
        return json({ ok: true, folders: [], episodes: [], assets: [], projects: [], settings: {}, models: [] });
    });
    await page.goto(`${base}/production?dramaId=${dramaId}&workspace=series&seriesView=planning`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator("[data-planning-outline-summary]").waitFor({ timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    loaded = (await page.locator("[data-planning-outline-summary]").count()) > 0;
    if (!loaded && process.env.HOOKS_LIVE_DEBUG) {
        console.error("DEBUG body:", (await page.locator("body").innerText()).slice(0, 1200));
        console.error("DEBUG url:", page.url());
    }
    hookErrors = errors.filter(message => /Rendered (more|fewer) hooks/.test(message));
    otherErrors = errors.filter(message => !/Rendered (more|fewer) hooks/.test(message));
} finally {
    await browser.close();
}

console.log(JSON.stringify({ loaded, hookErrors, otherErrors: otherErrors.slice(0, 3) }, null, 2));
if (!loaded || hookErrors.length) process.exitCode = 1;
