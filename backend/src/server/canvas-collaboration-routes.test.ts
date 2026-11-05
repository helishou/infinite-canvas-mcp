import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";
import { registerCanvasCollaborationRoutes } from "./canvas-collaboration-routes.js";

test("collaboration returns current revision without hydrating canvas assets", async t => {
    const db = new BackendDatabase(":memory:");
    const seed = { id: "P", title: "Canvas", nodes: [], connections: [] };
    db.createCanvasProject(seed);
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "test", port: 0, origins: [] });
    const participants = [{ clientId: "browser:test", kind: "browser" as const, label: "Browser" }];
    registerCanvasCollaborationRoutes(app, db, { participants: () => participants });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/canvas/projects`;
    const headers = { Authorization: "Bearer test" };
    const read = async () => {
        const original = db.getCanvasProject;
        db.getCanvasProject = () => { throw new Error("Full canvas reads are forbidden in collaboration polling"); };
        try {
            const response = await fetch(`${url}/P/collaboration`, { headers });
            assert.equal(response.status, 200);
            return await response.json();
        } finally { db.getCanvasProject = original; }
    };
    assert.deepEqual(await read(), { ok: true, projectId: "P", revision: 0, participants });
    db.applyCanvasProjectOperations("P", 0, [{ type: "update_project", patch: { title: "Updated" } }], { operationId: "edit" });
    assert.equal((await read()).revision, 1);
    const denied = await fetch(`${url}/P/collaboration`);
    assert.equal(denied.status, 401);
    const missing = await fetch(`${url}/missing/collaboration`, { headers });
    assert.equal(missing.status, 404);
});
