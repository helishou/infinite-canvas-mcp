import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const backendRequire = createRequire(path.join(root, "backend/package.json"));
const { register } = await import(pathToFileURL(backendRequire.resolve("tsx/esm/api")).href);
register();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "production-canvas-browser-"));
process.env.INFINITE_CANVAS_DATA_DIR = directory;
process.env.CANVAS_TEST_VITE_CACHE = path.join(directory, "vite-cache");
const artifacts = process.env.CANVAS_TEST_ARTIFACTS || path.join(os.tmpdir(), "production-canvas-browser-evidence");
fs.mkdirSync(artifacts, { recursive: true });
const [{ BackendDatabase }, { startServer }, { EpisodeProductionService }, { EpisodeProductionRunner }, { registerDramaProductionRoutes }, { ensureProductionCanvas }, { directorHash, promptHash }] = await Promise.all([
    import("../backend/src/db.ts"), import("../backend/src/server.ts"), import("../backend/src/drama/production.ts"), import("../backend/src/drama/production-runner.ts"),
    import("../backend/src/server/drama-production-routes.ts"), import("../backend/src/drama/production-canvas.ts"), import("../backend/src/drama/director.ts"),
]);
const db = new BackendDatabase(path.join(directory, "db.sqlite"));
const allowedOrigins = [];
const { app, stores, events } = startServer(db, { token: "fixture", port: 0, url: "http://127.0.0.1", origins: allowedOrigins });
const episodeService = new EpisodeProductionService(db, events, directory, false, () => {});
const canvasService = new EpisodeProductionService(db, events, directory, true, () => {});
let submissions = 0;
const generation = { start() { submissions++; throw new Error("Browser verification must not submit media"); } };
const runner = new EpisodeProductionRunner(episodeService, stores, generation);
registerDramaProductionRoutes(app, episodeService, runner);
registerDramaProductionRoutes(app, canvasService, new EpisodeProductionRunner(canvasService, stores, generation), "/canvas/projects/:episodeId/production");
app.get('/canvas/projects/:id/collaboration', (request, response) => response.json({ ok: true, projectId: request.params.id, revision: Number(db.getCanvasProject(request.params.id)?.revision || 0), participants: [] }));
db.upsertCanvasFolder({ id: "drama", name: "画布制作验证", createdAt: new Date().toISOString(), isDrama: true });
db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "第一集", synopsis: "" });
db.upsertDramaEpisode({ id: "ep2", dramaId: "drama", episodeNumber: 2, title: "第二集", synopsis: "" });
const episodeCanvas = ensureProductionCanvas(db, "episode", "ep").project.id;
const sharedCanvas = ensureProductionCanvas(db, "shared-assets", "drama").project.id;
const engine = { commit: "a".repeat(40), patchVersion: "test", runtimeId: "browser-engine", version: "4.3.9" };
const source = { fps_num: 24, fps_den: 1, brief: "雨夜归来的角色", style_policy: "waived", style_policy_reason: "temporary test",
    scene_registry: [{ id: "room", name: "书房" }], script_scenes: [{ id: "morning", scene_id: "room", scene_name: "清晨书房", text: "她第一次进入书房。", beat_ids: ["b1"] }, { id: "night", scene_id: "room", scene_name: "夜晚书房", text: "她再次回到书房。", beat_ids: ["b2"] }],
    asset_plan: [{ asset_id: "ROLE", asset_name: "角色主图", kind: "character", version: "v1", depends_on: [] }, { asset_id: "FRAME", asset_name: "入场分镜", kind: "keyframe", version: "v1", depends_on: ["ROLE"] }, { asset_id: "PROP", asset_name: "信件道具", kind: "prop", version: "v1", depends_on: [] }],
    shots: [{ id: "s1", title: "入场", display_summary: "她进入书房。", scene_id: "room", story_beat_ids: ["b1"], start_frame: 0, end_frame: 120, visual: "She enters the room.", state_in: {}, state_out: {}, camera: { description: "Static" }, dialogues: [], required_assets: ["ROLE"] }, { id: "s2", title: "归来", display_summary: "她回到书房。", scene_id: "room", story_beat_ids: ["b2"], start_frame: 120, end_frame: 240, visual: "She returns.", state_in: {}, state_out: {}, camera: { description: "Static" }, dialogues: [], required_assets: ["ROLE"] }],
    segments: [{ id: "seg1", shot_ids: ["s1"], start_frame: 0, end_frame: 120, generation_clip_duration: 5, mode: "T2VA" }, { id: "seg2", shot_ids: ["s2"], start_frame: 120, end_frame: 240, generation_clip_duration: 5, mode: "T2VA" }] };
const sourceHash = directorHash(source);
const director = { schemaVersion: 1, engine, source, sourceHash, modules: { story: { status: "committed", evidence: [], unresolved: [] } },
    assets: { ROLE: { status: "planned", version: "v1" } }, shotInputs: { s1: { assetIds: ["ROLE"], keyframePolicy: "new", keyframeAssetId: "FRAME" }, s2: { assetIds: ["ROLE"], keyframePolicy: "none" } },
    boundaries: [{ from: "seg1", to: "seg2", tailFrame: false, motionContext: false, reason: "authored cut" }], executionAuthorized: false, unresolved: [],
    artifacts: ["ROLE", "FRAME", "seg1", "seg2"].map(id => { const prompt = `integrated_multimodal_description:\n[Shot 1] ${id}.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A\n`; const sha256 = promptHash(prompt); return { id, targetId: id, kind: id.startsWith("seg") ? "h3" : "image", status: "ready", prompt, sha256, sourceHash, references: [], receipt: { sourceHash, promptHash: sha256, engineRuntimeId: engine.runtimeId, validator: "fixture" } }; }),
    workflow: { currentWork: { workId: "work", module: "assets", action: "author", targetKind: "asset", targetId: "ROLE", inputRevision: 1, sourceHash }, mediaProductionMode: "per_item" } };
episodeService.edit("ep", { operationId: "source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
runner.prepareTargets("ep", 1, ["asset:ROLE", "frame:s1", "segment:seg1", "segment:seg2"], "prepare");
const prepared = episodeService.get("ep");
const roleNodeId = prepared.draft.director.assets.ROLE.nodeId;
const h3NodeId = prepared.draft.clipGroups[0].nodeId;
const clip2 = prepared.draft.clipGroups[1].segmentId;
const backendServer = app.listen(0, "127.0.0.1");
await new Promise(resolve => backendServer.once("listening", resolve));
const backendUrl = `http://127.0.0.1:${backendServer.address().port}`;
process.env.CANVAS_TEST_BACKEND = backendUrl;
const req = createRequire(path.join(root, "web/package.json"));
const { createServer } = await import(pathToFileURL(req.resolve("vite")).href);
const vite = await createServer({ root: path.join(root, "web"), configFile: path.join(root, "web/vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, cacheDir: path.join(directory, "vite-cache") });
let browser;
let testPage;
try {
    await vite.listen();
    const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
    allowedOrigins.push(url);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 960 } });
    await context.addInitScript(({ backendUrl }) => { sessionStorage.setItem("backend-connection", JSON.stringify({ url: backendUrl, token: "fixture" })); localStorage.setItem("backend-url", backendUrl); localStorage.setItem("backend-token", "fixture"); }, { backendUrl });
    const page = await context.newPage(); testPage = page; page.setDefaultTimeout(30000);
    const errors = []; page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`${url}/drama/episodes/ep/production?workspace=assets`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(`**/canvas/${episodeCanvas}**`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "当前对象", exact: true }).last().waitFor();
    await page.getByRole("button", { name: "当前对象", exact: true }).last().click();
    await page.evaluate(async () => {
        const { useProductionFollowStore } = await import('/src/stores/use-production-follow-store.ts');
        window.__productionFollowTrace = [];
        window.__productionTest = { follow: useProductionFollowStore, view: (await import('/src/stores/canvas/plugin-node-view.ts')).getPluginNodeView, workspace: (await import('/src/stores/use-production-workspace-store.ts')).useProductionWorkspaceStore };
        useProductionFollowStore.subscribe((state, prior) => { if (state.following !== prior.following || state.target !== prior.target) window.__productionFollowTrace.push({ following: state.following, target: state.target, pause: state.pauseReason, expected: state.expectedPath, path: state.lastPath }); });
    });
    await page.locator('[data-production-directory-target="asset:ROLE"] button').first().click();
    await page.locator(`[data-node-id="${roleNodeId}"]`).waitFor();
    assert.equal(await page.locator('[data-production-inspector]').count(), 1);
    assert.equal(await page.locator('[data-production-directory-target="scene:morning"]').count(), 1);
    assert.equal(await page.locator('[data-production-directory-target="scene:night"]').count(), 1);
    let losePreparation = true;
    const preparationRequests = [];
    await page.route('**/production/prepare-targets?*', async route => {
        preparationRequests.push(route.request().postDataJSON());
        const response = await route.fetch();
        if (losePreparation) { losePreparation = false; await route.abort('failed'); } else await route.fulfill({ response });
    });
    await page.locator('[data-production-directory-target="asset:PROP"] button').last().click();
    const recoverLabel = await page.evaluate(async () => (await import('/src/i18n')).default.t('drama.production.recoverReceipt'));
    await page.getByRole('button', { name: recoverLabel, exact: true }).waitFor();
    const draftBefore = await page.evaluate(async () => { const localforage = (await import('/node_modules/.vite/deps/localforage.js')).default; const drafts = localforage.createInstance({ name: 'episode-production-drafts', storeName: 'unfinished' }); const rows = []; await drafts.iterate((value, key) => { rows.push({ key, pending: value.pendingCommand }); }); return rows; });
    assert.equal(draftBefore.some(row => row.pending?.operationId === preparationRequests[0]?.operationId), true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '当前对象', exact: true }).last().click();
    const draftAfter = await page.evaluate(async () => { const localforage = (await import('/node_modules/.vite/deps/localforage.js')).default; const drafts = localforage.createInstance({ name: 'episode-production-drafts', storeName: 'unfinished' }); const rows = []; await drafts.iterate((value, key) => { rows.push({ key, pending: value.pendingCommand }); }); return rows; });
    assert.equal(draftAfter.some(row => row.pending?.operationId === preparationRequests[0]?.operationId), true);
    await page.getByRole('button', { name: recoverLabel, exact: true }).click();
    await page.getByRole('button', { name: recoverLabel, exact: true }).waitFor({ state: 'hidden' });
    assert.equal(preparationRequests.length, 2);
    assert.equal(preparationRequests[0].operationId, preparationRequests[1].operationId);
    assert.deepEqual(preparationRequests[0], preparationRequests[1]);
    assert.equal((db.getCanvasProject(episodeCanvas).nodes || []).filter(node => node.metadata?.productionAssetId === 'PROP').length, 1);
    await page.evaluate(async () => { window.__productionTest = { follow: (await import('/src/stores/use-production-follow-store.ts')).useProductionFollowStore, view: (await import('/src/stores/canvas/plugin-node-view.ts')).getPluginNodeView, workspace: (await import('/src/stores/use-production-workspace-store.ts')).useProductionWorkspaceStore }; });
    await page.locator('[data-production-directory-target="segment:seg2"] button').first().click();
    await page.waitForFunction(({ id, nodeId, clipId }) => window.__productionTest.view(id, nodeId).getSnapshot().selectedSegmentId === clipId, { id: episodeCanvas, nodeId: h3NodeId, clipId: clip2 });
    await page.waitForFunction(({ clipId }) => document.querySelector(`.minimax-tl-clip[data-segment-id="${clipId}"]`)?.classList.contains("active"), { clipId: clip2 });
    await page.waitForFunction(nodeId => {
        const node = document.querySelector(`[data-node-id="${nodeId}"]`); if (!node) return false;
        const rect = node.getBoundingClientRect(), key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}`;
        window.__productionFocusStable = window.__productionFocusStable?.key === key ? { key, count: window.__productionFocusStable.count + 1 } : { key, count: 0 };
        return window.__productionFocusStable.count >= 8;
    }, h3NodeId);
    assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll("video")).every(video => video.paused)), true);
    await page.screenshot({ path: path.join(artifacts, 'h3-focus.png') });
    await page.evaluate(async () => { const { useProductionFollowStore } = await import('/src/stores/use-production-follow-store.ts'); useProductionFollowStore.getState().setTarget({ kind: "episode", id: "ep", workId: "work" }); });
    await page.waitForURL('**target=asset%3AROLE**');
    await page.mouse.move(400, 200); await page.mouse.wheel(0, 150);
    await page.waitForFunction(() => !window.__productionTest.follow.getState().following);
    const pausedUrl = page.url();
    events.publish({ type: "drama-production.updated", entityId: "ep", payload: { revision: episodeService.get("ep").revision } });
    await page.waitForTimeout(200);
    assert.equal(page.url(), pausedUrl);
    await page.getByRole("button", { name: "回到当前制作", exact: true }).first().click();
    await page.waitForFunction(() => window.__productionTest.follow.getState().following);
    await page.screenshot({ path: path.join(artifacts, "episode-canvas.png") });
    await page.getByLabel("切换制作画布").click();
    await page.getByTitle("共享资产画布", { exact: true }).last().click();
    await page.waitForURL(`**/canvas/${sharedCanvas}**`);
    await page.waitForFunction(id => window.__productionTest.workspace.getState().context?.canvasId === id && window.__productionTest.workspace.getState().context?.role === 'shared-assets', sharedCanvas);
    await page.getByRole("button", { name: "当前对象", exact: true }).last().waitFor();
    assert.equal(await page.evaluate(async () => (await import('/src/stores/use-production-workspace-store.ts')).useProductionWorkspaceStore.getState().context?.role), "shared-assets");
    await page.screenshot({ path: path.join(artifacts, "shared-assets-canvas.png") });
    await page.evaluate(async () => (await import('/src/stores/use-theme-store.ts')).useThemeStore.getState().setTheme('light'));
    await page.screenshot({ path: path.join(artifacts, "shared-assets-light.png") });
    await page.setViewportSize({ width: 720, height: 900 });
    await page.screenshot({ path: path.join(artifacts, "narrow-workspace.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(submissions, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, scope: "real canvas, fixed episode entry, production inspector, scene identities, exact Clip selection, no autoplay, wheel takeover, paused updates, resume, shared canvas, themes, narrow layout; no model requests", artifacts }));
} catch (error) {
    if (testPage) { await testPage.screenshot({ path: path.join(artifacts, "failure.png") }); console.error("Follow trace:", JSON.stringify(await testPage.evaluate(() => window.__productionFollowTrace?.slice(-12)))); console.error("Fixture page:", (await testPage.locator("body").innerText()).slice(0, 2200)); }
    throw error;
} finally {
    await browser?.close(); await vite.close();
    await new Promise(resolve => backendServer.close(resolve)); db.close();
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith("production-canvas-browser-")) fs.rmSync(directory, { recursive: true, force: true });
}
