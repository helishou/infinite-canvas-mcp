import assert from "node:assert/strict";
import test from "node:test";
import { consumeProductionEntryMark, markProductionEntry, productionPresentationPath } from "./production-navigation";

test("canvas production presentations open the Production workspace at the exact target", () => {
    const path = productionPresentationPath({
        key: "work:shot:shot-1",
        workId: "work-1",
        owner: { kind: "episode", id: "episode-1" },
        canvasId: "canvas-1",
        workspace: "shots",
        action: "produce",
        targetKind: "shot",
        targetId: "shot-1",
        nodeId: "node-1",
        status: "ready",
    });
    const url = new URL(path, "http://localhost");

    assert.equal(url.pathname, "/canvas/canvas-1");
    assert.equal(url.searchParams.get("edit"), "1");
    assert.equal(url.searchParams.get("productionKind"), "episode");
    assert.equal(url.searchParams.get("productionId"), "episode-1");
    assert.equal(url.searchParams.get("workspace"), "shots");
    assert.equal(url.searchParams.get("target"), "shot:shot-1");
    assert.equal(url.searchParams.get("nodeId"), "node-1");
    assert.equal(url.searchParams.get("workId"), "work-1");
});

test("native H3 follow retains the mounted canvas route across Clip and task changes", () => {
    const presentation = {
        key: "work:segment:clip-1", workId: "work-1",
        owner: { kind: "episode" as const, id: "episode-1" },
        canvasId: "canvas-1", workspace: "production" as const,
        action: "produce" as const, targetKind: "segment" as const, targetId: "segment-1",
        nodeId: "node-1", segmentId: "clip-1", status: "ready" as const,
    };
    for (const path of ["/production?dramaId=drama&episodeId=episode-1", "/canvas/canvas-1?nodeId=node-1"]) {
        const mounted = { id: "canvas-1", path };
        assert.equal(productionPresentationPath(presentation, mounted), path);
        assert.equal(productionPresentationPath({ ...presentation, segmentId: "clip-2", taskId: "task-2", status: "blocked" }, mounted), path);
    }
    assert.match(productionPresentationPath(presentation, { id: "other-canvas", path: "/production" }), /^\/canvas\/canvas-1\?/);
});

test("standalone production routes remain on their existing page", () => {
    const path = productionPresentationPath({
        key: "work:shot:shot-1",
        workId: "work-1",
        owner: { kind: "episode", id: "episode-1" },
        workspace: "shots",
        action: "produce",
        targetKind: "shot",
        targetId: "shot-1",
        status: "ready",
    });

    assert.match(path, /^\/drama\/episodes\/episode-1\/production\?/);
    assert.doesNotMatch(path, /edit=1/);
});

test("in-app navigation marks are consumed exactly once so unreachable destinations return to the caller", () => {
    const store = new Map<string, string>();
    const previousStorage = (globalThis as Record<string, unknown>).sessionStorage;
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => store.has(key) ? store.get(key)! : null,
            setItem: (key: string, value: string) => void store.set(key, String(value)),
            removeItem: (key: string) => void store.delete(key),
        },
    });
    try {
        assert.equal(consumeProductionEntryMark(), false, "no mark after a fresh module load");
        markProductionEntry();
        assert.equal(consumeProductionEntryMark(), true, "a click mark lets the destination go back");
        assert.equal(consumeProductionEntryMark(), false, "the mark is single-use and never repeats the bounce");
    } finally {
        if (previousStorage === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
        else Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: previousStorage });
    }
});
