import test from "node:test";
import assert from "node:assert/strict";
import { CanvasSession } from "./session.js";

test("Agent export delegates explicit project IDs to Backend without a connected browser", async () => {
    const receipt = { ok: true, export: { projectId: "p", revision: 3, sha256: "fixed", downloadPath: "/mcp/exports/fixed" } };
    const session = new CanvasSession("", async projectId => { assert.equal(projectId, "p"); return receipt; });
    assert.deepEqual(await session.callTool("canvas_export_snapshot", { projectId: "p" }), receipt);
    await assert.rejects(new CanvasSession().callTool("canvas_export_snapshot", { projectId: "p" }), /Backend/);
});
