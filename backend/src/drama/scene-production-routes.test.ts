import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { registerDramaProductionRoutes } from "../server/drama-production-routes.js";
import { EpisodeProductionService } from "./production.js";
import { syncSceneInstances } from "./scene-instances.js";
import { ensureSceneProductionCanvas } from "./production-canvas.js";

test("scene production HTTP routes read, edit, publish and keep media runs blocked", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scene-production-routes-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    syncSceneInstances(db, { kind: "episode", id: "ep" }, { script_scenes: [{ id: "SC01", scene_id: "LOC1", scene_name: "第一场", text: "Scene text" }], shots: [] });
    ensureSceneProductionCanvas(db, "SC01");

    const app = express(); app.use(express.json());
    const sceneProduction = new EpisodeProductionService(db, undefined, directory, false, () => {}).withSceneScope();
    registerDramaProductionRoutes(app, sceneProduction, undefined, "/drama/scenes/:episodeId/production");
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const route = "/drama/scenes/SC01/production";
    const post = (suffix: string, body: unknown) => fetch(base + route + suffix, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const initial = await (await fetch(base + route)).json() as any;
    assert.equal(initial.production.episodeId, "SC01");
    assert.equal(initial.production.revision, 0);

    const edited = await post("/ops", { operationId: "scene-http-edit", expectedRevision: 0, ops: [{ type: "set_director_brief", brief: "One scene only" }] });
    assert.equal(edited.status, 200);
    const editedBody = await edited.json() as any;
    assert.equal(editedBody.production.draft.director.source.brief, "One scene only");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM episode_productions WHERE episode_id='ep'").get()!.n, 0);

    const published = await post("/publish", { operationId: "scene-http-publish", expectedRevision: 1, stage: "director" });
    assert.equal(published.status, 200);
    assert.equal((await published.json() as any).production.publishedVersion, 1);
    const versions = await (await fetch(base + route + "/versions")).json() as any;
    assert.equal(versions.versions.length, 1);

    const blockedRun = await post("/runs", {});
    assert.equal(blockedRun.status, 400);
    assert.match((await blockedRun.json() as any).error, /SCENE_GENERATION_NOT_READY/);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM scene_production_batches WHERE scene_id='SC01'").get()!.n, 0);
});
