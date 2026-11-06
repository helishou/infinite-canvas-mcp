import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { withDerivedStoryboardTracks } from "../drama/storyboard-track.js";

/**
 * Mounts the exact handler body used in server.ts so the read contract is pinned by a test:
 * 画布分镜格必须按制作稿现算，而不是回放画布里可能过期的那份副本。
 */
function mountStoryboardTrackRoute(app: express.Express, db: BackendDatabase) {
    app.get("/canvas/projects/:id/storyboard-track", (req, res) => {
        const nodeId = typeof req.query.nodeId === "string" && req.query.nodeId ? req.query.nodeId : undefined;
        const project = db.getCanvasProject(req.params.id);
        if (!project) return void res.status(404).json({ ok: false, error: "画布不存在" });
        const scoped = { ...project, nodes: ((project.nodes as Array<Record<string, any>>) || []).filter(node => !nodeId || String(node.id) === nodeId) };
        const derived = withDerivedStoryboardTracks(db, req.params.id, scoped);
        const tracks: Record<string, unknown> = {};
        for (const node of (derived.project?.nodes as Array<Record<string, any>>) || []) {
            for (const segment of (node.metadata?.segments as Array<Record<string, any>>) || []) {
                if (!derived.changed.includes(String(segment.id || ""))) continue;
                tracks[String(segment.id)] = { storyboardShots: segment.storyboardShots, referenceBindings: segment.referenceBindings, duration: segment.duration };
            }
        }
        res.json({ ok: true, projectId: req.params.id, revision: Number(project.revision || 0), tracks });
    });
}

const draft = {
    director: {
        assets: { "storyboard:KF-NEW": { storageKey: "image:fresh", nodeId: "image-new" } },
        shotInputs: {}, artifacts: [],
        source: {
            version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 }, fps_num: 24, fps_den: 1,
            shots: [{ id: "S1", duration_frames: 48, keyframes: [
                { id: "KF:S1", assetId: "storyboard:KF-NEW", anchor: "opening", requiredForSubmission: true, sourceNode: { nodeId: "image-new" } },
            ] }],
            segments: [{ id: "CLIP-1", shot_ids: ["S1"] }],
        },
    },
    settings: {},
};

async function harness(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    createStores(db);
    db.createCanvasProject({
        id: "canvas",
        nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [{
            id: "clip-1", sourceShotId: "S1", duration: 1, storyboardModeEnabled: true,
            productionClipProjection: { targetId: "CLIP-1" },
            // 画布上停在旧图：制作台把关键帧换成了 image:fresh。
            storyboardShots: [{ id: "S1", duration: 2, referenceBindingId: "slot" }],
            referenceBindings: [{ id: "slot", role: "storyboard", mediaType: "image", storageKey: "image:old" }],
        }] } }],
        connections: [],
    } as never);
    db.db.prepare("INSERT INTO canvas_productions (project_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?,?,?,?,?,?)")
        .run("canvas", 7, JSON.stringify(draft), null, 0, new Date().toISOString());
    const app = express();
    mountStoryboardTrackRoute(app, db);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    return `http://127.0.0.1:${address.port}`;
}

test("the storyboard track route serves the authored keyframe, not the stale canvas copy", async (t) => {
    const base = await harness(t);
    const response = await fetch(`${base}/canvas/projects/canvas/storyboard-track?nodeId=h3`);
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; revision: number; tracks: Record<string, any> };
    const track = body.tracks["clip-1"];
    assert.ok(track, "the derived track must be reported for the compiler-owned Clip");
    assert.equal(track.storyboardShots[0].referenceBindingId, "slot");
    assert.equal(track.storyboardShots[0].duration, 2);
    const bindings = track.referenceBindings.filter((binding: any) => binding.role === "storyboard");
    assert.equal(bindings.length, 1, "the replaced slot must not keep the old storyboard image");
    assert.equal(bindings[0].storageKey, "image:fresh");
    assert.equal(typeof body.revision, "number");
});

test("clips without an authored keyframe are not reported, and unknown canvases 404", async (t) => {
    const base = await harness(t);
    const scoped = await fetch(`${base}/canvas/projects/canvas/storyboard-track?nodeId=missing-node`);
    assert.deepEqual((await scoped.json() as { tracks: Record<string, unknown> }).tracks, {});
    const missing = await fetch(`${base}/canvas/projects/nope/storyboard-track`);
    assert.equal(missing.status, 404);
});
