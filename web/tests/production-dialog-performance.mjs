import { chromium } from "playwright";

// 制作台抽屉性能回归测量：页面全部请求本地模拟（见 production-dialog-performance.tsx），不连接真实 Backend。
// 用法：node web/tests/production-dialog-performance.mjs [scale] [workspace] [control] [memo] [tick]
//   memo=1 模拟“保持抽屉内容元素引用稳定”；memo=0 为修改前的写法（父组件一渲染就重建整棵制作台）。
//   tick=1 每 60ms 触发一次父组件重渲染，模拟 Agent 流式输出期间的高频更新。
const scale = process.argv[2] || "1";
const workspace = process.argv[3] || "overview";
const [control, memo, tick] = [process.argv[4] || "0", process.argv[5] || "0", process.argv[6] || "0"];
const base = process.env.CANVAS_TEST_URL || "http://localhost:3001";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], warnings = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    page.on("console", message => { if (["warning", "error"].includes(message.type())) warnings.push(`${message.type()}: ${message.text().slice(0, 300)}`); });
    await page.addInitScript(() => {
        // React 提交耗时探针必须在应用模块之前注入。
        window.__commits = [];
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true, renderers: new Map(),
            inject(renderer) { this.renderers.set(1, renderer); return 1; },
            onCommitFiberUnmount() {},
            onCommitFiberRoot(_id, root) {
                const ms = root.current?.actualDuration;
                if (typeof ms === "number" && ms > 0.05) window.__commits.push({ at: Math.round(performance.now()), ms: Math.round(ms * 10) / 10 });
            },
        };
    });
    await page.goto(`${base}/tests/production-dialog-performance.html?scale=${scale}&workspace=${workspace}&control=${control}&memo=${memo}&tick=${tick}`);
    await page.locator("[data-production-dialog]").first().waitFor({ state: "attached", timeout: 30000 }).catch(async error => {
        console.log(JSON.stringify({ errors, body: (await page.locator("body").innerText()).slice(0, 1200) }));
        throw error;
    });
    await page.waitForTimeout(2500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const readMetrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(item => [item.name, item.value]));
    const measure = async (label, action) => {
        await page.evaluate(() => { window.__commits = []; });
        const before = await readMetrics();
        await action();
        await page.waitForTimeout(1200);
        const after = await readMetrics();
        const commits = await page.evaluate(() => window.__commits);
        return { scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000), layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
            styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000), layoutCount: after.LayoutCount - before.LayoutCount,
            commitCount: commits.length, commitTotalMs: Math.round(commits.reduce((sum, item) => sum + item.ms, 0)) };
    };
    const closed = await page.evaluate(() => {
        const wrapper = document.querySelector("#production-perf-content");
        const drawerWrapper = document.querySelector(".ant-drawer-content-wrapper");
        const rect = wrapper?.getBoundingClientRect();
        return { drawerNodes: wrapper ? wrapper.querySelectorAll("*").length : 0, totalNodes: document.querySelectorAll("*").length,
            wrapperDisplay: drawerWrapper ? getComputedStyle(drawerWrapper).display : "", contentWidth: rect ? Math.round(rect.width) : 0 };
    });
    const streaming = await measure("streaming", async () => {});
    const firstOpen = await measure("firstOpen", () => page.locator("[data-perf-action=open]").click());
    const close = () => page.evaluate(() => document.querySelector("[data-perf-action=close]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await close();
    await page.waitForTimeout(600);
    const reopen = await measure("reopen", () => page.locator("[data-perf-action=open]").click());
    console.log(JSON.stringify({ scale, workspace, control, memo, tick, closed, streaming, firstOpen, reopen, errors, warnings: [...new Set(warnings)].slice(0, 10) }, null, 2));
} finally {
    await browser.close();
}
