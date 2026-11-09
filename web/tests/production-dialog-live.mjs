import { chromium } from "playwright";

// 画布 →「对象/制作台」抽屉的真实页面验证：用路由拦截提供临时画布与制作数据，不连接真实 Backend、不写用户数据。
// 运行：node web/tests/production-dialog-live.mjs
const base = process.env.CANVAS_TEST_URL || "http://localhost:3001";
const projectId = "production-dialog-live", episodeId = "production-dialog-live-episode", dramaId = "production-dialog-live-drama";
const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `live-${index}`, type: "text", title: `Live ${index}`, position: { x: (index % 4) * 320, y: Math.floor(index / 4) * 240 }, width: 280, height: 180, metadata: { content: `## Node ${index}`, status: "success" } }));
const project = { id: projectId, title: "抽屉验证画布", revision: 1, nodes, connections: [], viewport: { x: 60, y: 80, k: 1 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", chatSessions: [], activeChatId: null };
const shots = Array.from({ length: 12 }, (_, index) => ({ id: `SHOT_${index}`, source_scene_id: "SCENE_0", story_order: index, timeline_id: "T1", duration_frames: 96, title: `镜头 ${index + 1}`, visual: "画面描述", camera: { framing: "CU" }, subject_usages: [] }));
const segments = Array.from({ length: 4 }, (_, index) => ({ id: `CLIP_${index}`, shot_ids: shots.filter((_, shotIndex) => shotIndex % 4 === index).map(shot => shot.id), mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "参考生成" }));
const production = {
    episodeId, revision: 3, publishedVersion: 0, published: null, updatedAt: new Date().toISOString(), clipRefreshes: [],
    draft: { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], legacyImports: [],
        settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, imageModelsByKind: {}, h3Models: {}, parallelScenes: true, reviewPolicy: { mode: "manual", shared: "manual", scene: "manual" } },
        director: { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, sourceHash: "b".repeat(64),
            source: { brief: "抽屉验证用画布", fps_num: 24, fps_den: 1, prompt_assembly: { version: 2 }, script_scenes: [{ id: "SCENE_0", scene_id: "SCENE_0", title: "场次 1", heading: "内景", text: "剧本正文" }], shots, segments, asset_plan: [], subject_registry: [], ledger: { contract_version: 2, facts: [], timelines: [{ id: "T1" }], initial: [], events: [], requirements: [], coverage: [] } },
            modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} } },
};
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    await page.addInitScript(() => {
        localStorage.setItem("backend-url", "http://127.0.0.1:17370");
        localStorage.setItem("backend-token", "perf-token");
    });
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== "http://127.0.0.1:17370") return route.continue();
        const path = url.pathname;
        const json = body => route.fulfill({ json: body });
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) return json({ ok: true, revision: 4, production });
        if (path.endsWith("/production-context")) return json({ ok: true, context: { role: "standalone", canvasId: projectId, owner: { kind: "canvas", id: projectId } } });
        if (path.endsWith(`/drama/episodes/${episodeId}`)) return json({ ok: true, episode: { id: episodeId, dramaId, canvasId: projectId, title: "抽屉验证分集", episodeNumber: 1 } });
        if (path.endsWith(`${episodeId}/production`)) return json({ ok: true, production });
        if (path.endsWith(`/canvas/projects/${projectId}/production`)) return json({ ok: true, production });
        if (path.endsWith("/production/readiness")) return json({ ok: true, readiness: { revision: 3, publishedVersion: 0, source: "draft", canvasRevision: 1, targets: [], modules: {}, unresolved: [], nextAction: "准备完成" } });
        if (path.endsWith("/production/batches")) return json({ ok: true, runs: [] });
        if (path.endsWith("/production/versions")) return json({ ok: true, versions: [] });
        if (path.endsWith("/production/continuity")) return json({ ok: true, continuity: { status: "missing", items: [], total: 0, nextCursor: null, diagnostics: { total: 0, blocked: 0, unresolved: 0 } } });
        if (path.endsWith("/production/scene-work")) return json({ ok: true, state: { revision: 3, works: [], shared: null } });
        if (path.endsWith("/scene-archives")) return json({ ok: true, archives: [] });
        if (path.endsWith("/shared-assets")) return json({ ok: true, assets: [], versions: [] });
        if (path.includes("/operations/")) return json({ ok: true, found: false });
        if (path.endsWith(`/canvas/projects/${projectId}`)) return json({ ok: true, project });
        if (path.endsWith("/canvas/projects")) return json({ ok: true, projects: [{ id: projectId, title: project.title, revision: 1 }] });
        if (path.endsWith("/canvas/tasks") || path.endsWith("/tasks")) return json({ ok: true, tasks: [] });
        if (path.endsWith("/drama")) return json({ ok: true, episode: null, drama: null });
        return json({ ok: true, settings: {}, tasks: [], models: [], workflows: [], pending: [], updates: [], folders: [], episodes: [] });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const readMetrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(item => [item.name, item.value]));
    await page.goto(`${base}/canvas/${projectId}?productionKind=canvas&productionId=${projectId}`);
    await page.locator('[data-node-id="live-0"]').waitFor({ timeout: 30000 });
    const objectTab = page.getByRole("button", { name: "当前对象", exact: true });
    // 当前对象/Agent 页签在导演对话面板头部：先展开对话再进入对象页签（画布上的真实入口）。
    await page.getByRole("button", { name: "与导演对话" }).first().click();
    // 等画布与制作上下文稳定，让抽屉内容按 forceRender 预挂载完成，再测稳定态打开成本。
    await page.waitForTimeout(3000);
    const storeState = await page.evaluate(async () => {
        const entry = performance.getEntriesByType("resource").find(item => /use-production-workspace-store\.ts/.test(item.name));
        if (!entry) return { missing: true };
        const { useProductionWorkspaceStore } = await import(entry.name);
        return { context: useProductionWorkspaceStore.getState().context, panelTab: useProductionWorkspaceStore.getState().panelTab };
    }).catch(error => ({ error: String(error) }));
    const buttons = await page.locator("button").evaluateAll(elements => elements.map(element => element.textContent?.trim()).filter(Boolean).slice(0, 40));
    await objectTab.waitFor({ timeout: 20000 }).catch(error => { console.log(JSON.stringify({ storeState, buttons, errors }, null, 2)); throw error; });
    // 抽屉关闭时制作台已预挂载（forceRender），对象页签来自画布制作上下文。
    const mountedWhileClosed = await page.locator("[data-production-dialog]").count();
    const before = await readMetrics();
    await objectTab.click();
    const dialog = page.locator("[data-production-dialog]");
    await dialog.waitFor({ state: "visible", timeout: 20000 });
    const started = Date.now();
    await page.waitForTimeout(1200);
    const after = await readMetrics();
    const result = {
        mountedWhileClosed, visibleAfterClick: await dialog.isVisible(), waitMs: Date.now() - started - 1200,
        scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
        layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
        text: (await dialog.innerText()).slice(0, 200),
        errors,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.visibleAfterClick || !result.text) throw new Error("制作台抽屉未渲染");
    if (errors.length) throw new Error(`页面运行错误：${errors[0]}`);
} finally {
    await browser.close();
}
