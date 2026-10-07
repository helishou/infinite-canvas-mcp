import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { diagnoseH3Clips } from "./h3-diagnose.js";
import { h3PromptContent } from "./h3-params.js";
import { createHash } from "node:crypto";

const hash = (prompt: string) => createHash("sha256").update(h3PromptContent(prompt)).digest("hex");

/** Mounts the exact handler body used in server.ts so the route contract is pinned by a test. */
function mountDiagnoseRoute(app: express.Express, stores: ReturnType<typeof createStores>) {
    app.get("/canvas/projects/:id/h3-diagnose", (req, res) => {
        const nodeId = typeof req.query.nodeId === "string" && req.query.nodeId ? req.query.nodeId : undefined;
        let nodeIds: string[] | undefined;
        if (typeof req.query.nodeIds === "string" && req.query.nodeIds) {
            try {
                const parsed = JSON.parse(req.query.nodeIds);
                if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw new Error("must be string array");
                nodeIds = parsed as string[];
            } catch { return void res.status(400).json({ ok: false, code: "INVALID_INPUT", error: "nodeIds 必须是字符串数组 JSON" }); }
        }
        const offset = Number.parseInt(String(req.query.offset ?? "0"), 10);
        const pageSize = Number.parseInt(String(req.query.pageSize ?? "200"), 10);
        try {
            const result = diagnoseH3Clips(stores, {
                projectId: req.params.id, nodeId, nodeIds,
                offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
                pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 200,
            });
            res.json({ ok: true, ...result });
        } catch (error) {
            res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}

async function harness(t: TestContext, segments: Array<{ id: string; prompt: string }>) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    stores.projects.create({
        id: "p",
        nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: segments.map(s => ({ ...s, directorEngine: "acheng", directorSourceHash: "s1" })) } }],
        connections: [],
    });
    stores.projects.getH3ProductionRequirements = () => ({
        ownerId: "ep", revision: 3, version: 7,
        clips: segments.map(s => ({ nodeId: "n", segmentId: s.id, sourceHash: "s1", promptContentHash: hash(s.prompt), storyboardRequired: false, shots: [], literalDialogues: [] })),
    }) as never;
    const app = express();
    mountDiagnoseRoute(app, stores);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    return `http://127.0.0.1:${address.port}`;
}

test("nodeIds array filtering survives the query round-trip and paginates", async t => {
    const base = await harness(t, [{ id: "a", prompt: "A。" }, { id: "b", prompt: "B。" }]);
    const filtered = await (await fetch(`${base}/canvas/projects/p/h3-diagnose?nodeIds=${encodeURIComponent('["n"]')}`)).json();
    assert.equal(filtered.ok, true);
    assert.equal(filtered.total, 2);
    assert.equal(filtered.rows.length, 2);
    const paged = await (await fetch(`${base}/canvas/projects/p/h3-diagnose?pageSize=1`)).json();
    assert.equal(paged.total, 2);
    assert.equal(paged.rows.length, 1);
    assert.equal(paged.truncated, true);
    assert.equal(paged.nextOffset, 1);
    const second = await (await fetch(`${base}/canvas/projects/p/h3-diagnose?pageSize=1&offset=1`)).json();
    assert.equal(second.rows[0].segmentId, "b");
    assert.equal(second.truncated, false);
});

test("an unknown node id filters to zero rows instead of silently diagnosing everything", async t => {
    const base = await harness(t, [{ id: "a", prompt: "A。" }]);
    const result = await (await fetch(`${base}/canvas/projects/p/h3-diagnose?nodeIds=${encodeURIComponent('["other"]')}`)).json();
    assert.equal(result.ok, true);
    assert.equal(result.total, 0);
    assert.deepEqual(result.rows, []);
});

test("malformed nodeIds returns 400 and a missing project returns 404", async t => {
    const base = await harness(t, [{ id: "a", prompt: "A。" }]);
    const bad = await fetch(`${base}/canvas/projects/p/h3-diagnose?nodeIds=not-json`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "INVALID_INPUT");
    const arrayOfNumbers = await fetch(`${base}/canvas/projects/p/h3-diagnose?nodeIds=${encodeURIComponent("[1,2]")}`);
    assert.equal(arrayOfNumbers.status, 400);
    const missing = await fetch(`${base}/canvas/projects/nope/h3-diagnose`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /画布不存在/);
});

test("nodeId is honoured when nodeIds is absent", async t => {
    const base = await harness(t, [{ id: "a", prompt: "A。" }, { id: "b", prompt: "B。" }]);
    const scoped = await (await fetch(`${base}/canvas/projects/p/h3-diagnose?nodeId=n`)).json();
    assert.equal(scoped.total, 2);
    const empty = await (await fetch(`${base}/canvas/projects/p/h3-diagnose?nodeId=absent`)).json();
    assert.equal(empty.total, 0);
});
