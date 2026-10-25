import assert from "node:assert/strict";
import test from "node:test";

import { runComfyTask } from "./comfyui";

test("Comfy task polling recovers from a temporary Backend 503 using the same task ID", async t => {
    const paths: string[] = [];
    const taskIds: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        paths.push(url.pathname);
        if (url.pathname === "/comfy/tasks") {
            return Response.json({ task: { id: "comfy-task-1", status: "queued", progress: 0 } });
        }
        if (paths.filter(path => path === "/comfy/tasks/comfy-task-1").length === 1) {
            return Response.json({ error: "Backend is reloading" }, { status: 503 });
        }
        return Response.json({ task: {
            id: "comfy-task-1", status: "succeeded", progress: 1,
            result: { media: [{ url: "/media/video%3Aresult", storageKey: "video:result", mimeType: "video/mp4" }] },
        } });
    });

    const result = await runComfyTask("http://agent.test", "token", "http://comfy.test", "z-image", "prompt", [], {}, undefined, id => taskIds.push(id));

    assert.deepEqual(taskIds, ["comfy-task-1"]);
    assert.deepEqual(paths, ["/comfy/tasks", "/comfy/tasks/comfy-task-1", "/comfy/tasks/comfy-task-1"]);
    assert.equal(result.storageKey, "video:result");
    assert.equal(new URL(result.url, "http://app.test").pathname, "/media/video%3Aresult");
});

test("Comfy task polling does not retry a deterministic 404", async t => {
    let statusReads = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/comfy/tasks") return Response.json({ task: { id: "missing-task", status: "queued", progress: 0 } });
        statusReads += 1;
        return Response.json({ error: "task not found" }, { status: 404 });
    });

    await assert.rejects(runComfyTask("http://agent.test", "token", "http://comfy.test", "z-image", "prompt", [], {}), /task not found/);
    assert.equal(statusReads, 1);
});
