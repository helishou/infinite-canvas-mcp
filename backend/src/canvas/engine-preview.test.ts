import assert from "node:assert/strict";
import test from "node:test";

import { engineSubmissionOf, resolveTaskLivePreview, type EngineSubmission } from "./engine-preview.js";

type FakeTask = {
    id: string;
    kind: string;
    status: string;
    parentTaskId?: string;
    result?: Record<string, unknown>;
};

function fakeStores(tasks: FakeTask[], events: Record<string, Array<{ type: string; payload: Record<string, unknown> }>> = {}, settings: Record<string, unknown> = {}) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return {
        tasks: {
            get: (id: string) => byId.get(id) ?? null,
            events: (id: string) => events[id] ?? [],
        },
        settings: { get: (key: string) => settings[key] },
    } as never;
}

const SUBMISSION = { type: "engine_submitted", payload: { engineTaskId: "engine-1", baseUrl: "http://127.0.0.1:8300", model: "m" } };

test("canvas-video 子任务自己的 engine_submitted 事件直接定位引擎任务", () => {
    const stores = fakeStores(
        [{ id: "video-child", kind: "canvas-video", status: "running" }],
        { "video-child": [SUBMISSION] },
    );
    assert.deepEqual(engineSubmissionOf(stores, "video-child"), {
        engineTaskId: "engine-1", baseUrl: "http://127.0.0.1:8300", model: "m",
    });
});

test("H3 父任务顺着 currentChildTaskId 找到引擎任务，循环引用不死循环", () => {
    const stores = fakeStores(
        [
            { id: "h3-parent", kind: "canvas-h3-run", status: "running", result: { currentChildTaskId: "video-child" } },
            { id: "video-child", kind: "canvas-video", status: "running", result: { currentChildTaskId: "h3-parent" } },
        ],
        { "video-child": [SUBMISSION] },
    );
    assert.equal(engineSubmissionOf(stores, "h3-parent")?.engineTaskId, "engine-1");
    assert.equal(engineSubmissionOf(stores, "missing"), null);
});

test("KJ 动态预览的 data:video/mp4 帧同样透传，不是只收静帧", async () => {
    const stores = fakeStores(
        [{ id: "video-node", kind: "canvas-video", status: "running" }],
        { "video-node": [{ type: "engine_submitted", payload: { engineTaskId: "engine-video-preview", baseUrl: "http://127.0.0.1:8300" } }] },
    );
    const frame = await resolveTaskLivePreview(stores, "video-node", async () => ({
        dataUrl: "data:video/mp4;base64,AAAA", mime: "video/mp4", step: 4, total: 10, source: "step",
    }));
    assert.equal(frame?.dataUrl, "data:video/mp4;base64,AAAA");
    assert.equal(frame?.mime, "video/mp4");
});

test("终态任务不查引擎；运行任务拿到预览帧；取帧失败当无预览", async () => {
    const stores = fakeStores(
        [
            { id: "done", kind: "canvas-video", status: "succeeded" },
            { id: "running", kind: "canvas-video", status: "running" },
            { id: "failing", kind: "canvas-video", status: "running" },
        ],
        {
            done: [SUBMISSION],
            running: [{ type: "engine_submitted", payload: { engineTaskId: "engine-run", baseUrl: "http://127.0.0.1:8300" } }],
            failing: [{ type: "engine_submitted", payload: { engineTaskId: "engine-fail", baseUrl: "http://127.0.0.1:8300" } }],
        },
    );
    const seen: EngineSubmission[] = [];
    const fetcher = async (submission: EngineSubmission) => {
        seen.push(submission);
        if (submission.engineTaskId === "engine-fail") throw new Error("engine down");
        return { dataUrl: "data:image/jpeg;base64,AAAA", mime: "image/jpeg", step: 3, total: 20, source: "step" as const };
    };
    assert.equal(await resolveTaskLivePreview(stores, "done", fetcher), null);
    assert.equal(seen.length, 0);

    const frame = await resolveTaskLivePreview(stores, "running", fetcher);
    assert.equal(frame?.dataUrl, "data:image/jpeg;base64,AAAA");
    assert.equal(frame?.step, 3);
    assert.equal(await resolveTaskLivePreview(stores, "failing", fetcher), null);
});
