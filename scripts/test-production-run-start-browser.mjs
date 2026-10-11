import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "production-run-start-browser-"));
process.env.INFINITE_CANVAS_DATA_DIR = directory;
process.env.CANVAS_TEST_VITE_CACHE = path.join(directory, "vite-cache");
const backendRequire = createRequire(path.join(root, "backend", "package.json"));
(await import(pathToFileURL(backendRequire.resolve("tsx/esm/api")).href)).register();

let db, backendServer, vite, browser;
try {
    const [database, server, production, runnerModule, routes, canvas, directorModule] = await Promise.all([
        import("../backend/src/db.ts"), import("../backend/src/server.ts"), import("../backend/src/drama/production.ts"),
        import("../backend/src/drama/production-runner.ts"), import("../backend/src/server/drama-production-routes.ts"),
        import("../backend/src/drama/production-canvas.ts"), import("../backend/src/drama/director.ts"),
    ]);
    db = new database.BackendDatabase(path.join(directory, "runtime.sqlite"));
    const origins = [];
    const { app, stores, events } = server.startServer(db, { token: "fixture", port: 0, url: "http://127.0.0.1", origins });
    const service = new production.EpisodeProductionService(db, events, directory, false, () => {});
    let mediaStarts = 0;
    const runner = new runnerModule.EpisodeProductionRunner(service, stores, { start() { mediaStarts++; throw new Error("This verification must not submit media"); } });
    routes.registerDramaProductionRoutes(app, service, runner);
    db.upsertCanvasFolder({ id: "drama", name: "Fixture", isDrama: true, createdAt: new Date().toISOString() });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Fixture episode", synopsis: "" });
    const { project } = canvas.ensureProductionCanvas(db, "episode", "ep", events);

    const source = {
        fps_num: 24, fps_den: 1, brief: "A short fixture image request.",
        scene_registry: [], script_scenes: [], shots: [], segments: [],
        asset_plan: [{ asset_id: "ROLE", asset_name: "Fixture image", kind: "prop", version: "v1", canvas_scope: "episode", depends_on: [] }],
        asset_cards: [{ id: "ROLE", asset_kind: "prop", asset_version: "v1", recipe: "portrait", prompt: "A clean neutral fixture image.", references: [] }],
    };
    const sourceHash = directorModule.directorHash(source);
    const prompt = "A clean neutral fixture image.";
    const promptHash = directorModule.promptHash(prompt);
    const director = {
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture-engine", version: "4.3.9" },
        source, sourceHash, modules: {}, artifacts: [{ id: "ROLE", targetId: "ROLE", kind: "image", status: "ready", prompt, sha256: promptHash, sourceHash, references: [],
            receipt: { sourceHash, promptHash, engineRuntimeId: "fixture-engine", validator: "fixture" } }],
        assets: { ROLE: { version: "v1", status: "planned" } }, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [],
        workflow: { currentWork: { workId: "fixture-work", module: "assets", action: "produce", targetKind: "asset", targetId: "ROLE", inputRevision: 1, sourceHash }, mediaProductionMode: "per_item" },
    };
    service.edit("ep", { operationId: "seed", expectedRevision: 0, ops: [
        { type: "set_director_production", director },
        { type: "set_settings", patch: { mode: "manual", imageModel: "fixture-image", imageModels: { ROLE: "fixture-image" }, reviewPolicy: { mode: "none", shared: "none", scene: "none" } } },
    ] });
    const prepared = runner.prepareTargets("ep", service.get("ep").revision, ["asset:ROLE"], "prepare-role");
    assert.equal(service.workflowReadiness("ep").targets.find(item => item.id === "asset:ROLE")?.status, "ready");

    const backendServerPromise = new Promise(resolve => { backendServer = app.listen(0, "127.0.0.1", resolve); });
    await backendServerPromise;
    const backendUrl = `http://127.0.0.1:${backendServer.address().port}`;
    process.env.CANVAS_TEST_BACKEND = backendUrl;
    const webRequire = createRequire(path.join(root, "web", "package.json"));
    const { createServer } = await import(pathToFileURL(webRequire.resolve("vite")).href);
    vite = await createServer({ root: path.join(root, "web"), configFile: path.join(root, "web", "vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, cacheDir: path.join(directory, "vite-cache") });
    await vite.listen();
    const webUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
    origins.push(webUrl);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 960 } });
    await context.addInitScript(({ backendUrl }) => {
        sessionStorage.setItem("backend-connection", JSON.stringify({ url: backendUrl, token: "fixture" }));
        localStorage.setItem("backend-url", backendUrl); localStorage.setItem("backend-token", "fixture");
    }, { backendUrl });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [];
    const runRequests = [];
    const unexpectedPreflights = [];
    const productionRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const pathname = new URL(request.url()).pathname;
        if (/production/.test(pathname)) productionRequests.push(`${request.method()} ${pathname}`);
        if (request.method() === "POST" && pathname.endsWith("/production/runs")) runRequests.push(request.postDataJSON());
        if (request.method() === "POST" && pathname.endsWith("/production/preflight")) unexpectedPreflights.push(pathname);
    });
    await page.goto(`${webUrl}/production?dramaId=drama&episodeId=ep&workspace=production`, { waitUntil: "domcontentloaded" });
    const generate = page.getByRole("button", { name: "生成此项目", exact: true });
    await generate.waitFor({ state: "visible" });
    assert.equal(await generate.isDisabled(), false, "a technically ready unreviewed target remains executable");
    const startedResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/production/runs"));
    await generate.click();
    const response = await startedResponse;
    const responseText = await response.text();
    assert.equal(response.ok(), true, responseText);
    const started = JSON.parse(responseText);
    await page.waitForTimeout(250);
    assert.equal(runRequests.length, 1, "one click sends one start request");
    assert.deepEqual(runRequests[0].targets, ["asset:ROLE"]);
    assert.equal(runRequests[0].inputBasis, "canvas");
    assert.equal(runRequests[0].workId, "fixture-work");
    assert.equal(runRequests[0].runId, runRequests[0].idempotencyKey);
    assert.deepEqual(unexpectedPreflights, [], "generation does not send a duplicate preflight request");
    assert.deepEqual(errors, []);
    const persisted = service.getBatch("ep", started.run.runId);
    assert.ok(persisted, "Backend persists the run before dispatching work");
    assert.equal(persisted.settings.reviewPolicy.mode, "none");
    assert.equal(service.get("ep").draft.director.workflow.currentWork?.workId, "fixture-work");
    assert.equal(service.get("ep").draft.director.workflow.currentWork?.runId, started.run.runId);
    assert.equal(stores.tasks.list().length, 0, "the throwing generation adapter cannot create or submit a media task");
    console.log(JSON.stringify({ passed: true, oneRunStartRequest: runRequests.length, target: runRequests[0].targets[0], preflights: unexpectedPreflights.length, mediaTasks: stores.tasks.list().length }));
    await context.close();
} finally {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (backendServer) await new Promise(resolve => backendServer.close(resolve));
    if (db) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
}
