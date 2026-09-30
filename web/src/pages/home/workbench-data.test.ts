import assert from "node:assert/strict";
import test from "node:test";
import { collectOutputs, outputMedia, projectCover, retainProjectCovers, taskDestination } from "./workbench-data";
import type { BackendGenerationLog } from "../../services/backend-api";
import type { CanvasProject } from "../../stores/canvas/use-canvas-store";

function generationLog(patch: Pick<BackendGenerationLog, "id"> & Partial<BackendGenerationLog>): BackendGenerationLog {
    return {
        projectId: "p", status: "success", platform: "test", references: [], inputCounts: {},
        startedAt: "", durationMs: 0, outputs: [], params: {}, createdAt: "", updatedAt: "",
        ...patch,
    };
}

test("recent results keep only completed media and do not misclassify text or unknown files", () => {
    assert.equal(outputMedia({ type: "text", content: "a paragraph" }), null);
    assert.equal(outputMedia({ storageKey: "file:unknown", url: "/report.pdf" }), null);
    assert.equal(outputMedia({ storageKey: "file:clip", mimeType: "video/mp4" })?.kind, "video");
    assert.equal(outputMedia({ localUrl: "https://host/clip.mp4?token=secret" })?.kind, "video");
    const logs = [
        { id: "old", status: "success", createdAt: "2026-01-01", outputs: [{ storageKey: "image:a" }] },
        {
            id: "new",
            status: "success",
            createdAt: "2026-02-01",
            outputs: [
                { type: "text", text: "hello" },
                { storageKey: "file:b", mimeType: "audio/wav" },
            ],
        },
        { id: "failed", status: "failed", createdAt: "2026-03-01", outputs: [{ storageKey: "image:c" }] },
    ].map((log) => generationLog({ ...log, status: log.status as BackendGenerationLog["status"] }));
    assert.deepEqual(
        collectOutputs(logs).map((x) => x.id),
        ["new:1", "old:0"],
    );
});

test("late log snapshots cannot replace a shown project cover, but a new project version can", () => {
    const cachedPortrait = { kind: "image", storageKey: "image:portrait" } as const;
    const lateLandscape = { kind: "image", storageKey: "image:landscape" } as const;
    const initial = retainProjectCovers({}, [{ key: "backend/project/v1", media: null }]);
    const shown = retainProjectCovers(initial, [{ key: "backend/project/v1", media: cachedPortrait }]);
    const late = retainProjectCovers(shown, [{ key: "backend/project/v1", media: lateLandscape }]);
    assert.equal(late, shown);
    assert.equal(late["backend/project/v1"], cachedPortrait);
    const changed = retainProjectCovers(late, [{ key: "backend/project/v2", media: lateLandscape }]);
    assert.equal(changed["backend/project/v2"], lateLandscape);
    assert.equal(retainProjectCovers(changed, [{ key: "another-backend/project/v1", media: lateLandscape }])["another-backend/project/v1"], lateLandscape);
});

test("project covers never borrow another project's output or use audio as an image", () => {
    const project = { id: "p", nodes: [], summary: { nodeCount: 5, connectionCount: 3 } } as unknown as CanvasProject;
    const outputs = collectOutputs([
        generationLog({ id: "1", projectId: "other", status: "success", createdAt: "2026-01-01", outputs: [{ storageKey: "image:other" }] }),
        generationLog({ id: "2", projectId: "p", status: "success", createdAt: "2026-01-02", outputs: [{ storageKey: "audio:voice" }] }),
    ]);
    assert.equal(projectCover(project, outputs), null);
    assert.deepEqual(projectCover(project, outputs, { id: "f", name: "Drama", createdAt: "", coverStorageKey: "image:cover" }), { kind: "image", storageKey: "image:cover" });
});

test("task navigation preserves project ownership, including deleted projects", () => {
    const ids = new Set(["p/one"]);
    assert.equal(taskDestination({ id: "existing", status: "succeeded", progress: 1, projectId: "p/one" }, ids), "/canvas/p%2Fone");
    assert.equal(taskDestination({ id: "deleted", status: "succeeded", progress: 1, projectId: "deleted", input: { scope: "image" } }, ids), null);
    assert.equal(taskDestination({ id: "workbench", status: "succeeded", progress: 1, input: { scope: "video" } }, ids), "/video");
});

test("covers use the selected character image and never old image-mode results on a video node", () => {
    const project = { id: "p", nodes: [{ type: "character", metadata: { characterPrimaryIndex: 1, characterImages: [{ storageKey: "image:first" }, { storageKey: "image:selected" }] } }] } as unknown as CanvasProject;
    assert.equal(projectCover(project, [])?.storageKey, "image:selected");
    project.nodes = [{ type: "config", metadata: { smart: true, generationMode: "video", mimeType: "video/mp4", storageKey: "video:current", images: [{ id: "old", status: "success", content: "", storageKey: "image:old" }] } }] as CanvasProject["nodes"];
    assert.equal(projectCover(project, [])?.storageKey, "video:current");
});
