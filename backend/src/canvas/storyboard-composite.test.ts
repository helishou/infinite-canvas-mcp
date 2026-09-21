import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { after, test } from "node:test";
import { createStoryboardComposite, remapCompositePrompt, storyboardCompositePlan } from "./storyboard-composite.js";

const directories: string[] = [];
after(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

function storyboardBinding(id: string) {
    return { id, assetId: `asset-${id}`, label: id, role: "storyboard", tags: [], enabled: true, usage: "reference", mediaType: "image", storageKey: `${id}.png` };
}

function planFor(ids: string[]) {
    return storyboardCompositePlan({
        mode: "ref2va", storyboardCompositeEnabled: true,
        referenceBindings: [...new Set(ids)].map(storyboardBinding),
        prompt: ids.map((id, index) => `[Shot ${index + 1}] <Picture ${index + 1}>`).join("\n"),
    });
}

test("composite grid sizes match the confirmed row-major layouts", () => {
    const expected = new Map([[2, [1, 2]], [3, [1, 3]], [4, [2, 2]], [5, [1, 5]], [6, [2, 3]], [7, [2, 4]], [8, [2, 4]], [9, [3, 3]]]);
    for (const [count, [rows, columns]] of expected) {
        const plan = planFor(Array.from({ length: count }, (_, index) => `ref-${index + 1}`));
        assert.ok(plan);
        assert.deepEqual([plan.rows, plan.columns], [rows, columns]);
        assert.deepEqual(plan.panels.map(({ index, row, column }) => [index, row, column]), Array.from({ length: count }, (_, index) => [index + 1, Math.floor(index / columns) + 1, index % columns + 1]));
    }
});

test("first shot use orders panels, duplicate bindings share a panel, and unbound references stay separate", () => {
    const plan = storyboardCompositePlan({
        mode: "ref2va", storyboardCompositeEnabled: true,
        referenceBindings: [storyboardBinding("a"), storyboardBinding("b"), storyboardBinding("unbound"), { ...storyboardBinding("other"), role: "scene" }],
        prompt: "[Shot 1] <Picture 2> <Picture 1>\n[Shot 2] <Picture 2>\n[Shot 3] <Picture 99>",
    });
    assert.ok(plan);
    assert.deepEqual(plan.sourceBindingIds, ["b", "a"]);
    assert.deepEqual(plan.panels.map((panel) => panel.shotNumbers), [[1, 2], [1]]);
    assert.deepEqual(plan.bindings.map((binding) => binding.id), ["b", "unbound", "other"]);
});

test("disabled and single-bound clips do not create a composite; prompt markers and ordinals map to the collapsed refs", () => {
    assert.equal(storyboardCompositePlan({ storyboardCompositeEnabled: false, referenceBindings: [storyboardBinding("a"), storyboardBinding("b")], prompt: "[Shot 1] <Picture 1> [Shot 2] <Picture 2>" }), null);
    assert.equal(planFor(["a"]), null);
    const plan = planFor(["a", "b"]);
    assert.ok(plan);
    const mapped = remapCompositePrompt("[Shot 1] <Picture 1>\n[Shot 2] <Picture 2>", plan, [
        { id: "a", ordinal: 1, mediaType: "image" }, { id: "b", ordinal: 2, mediaType: "image" },
    ], [{ id: "a", ordinal: 1, mediaType: "image" }]);
    assert.equal(mapped, "[Shot 1] <Picture 1>\n[Shot 2] <Picture 1>");
});

test("composite output preserves aspect ratio and does not upscale the short edge", async () => {
    const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "h3-storyboard-composite-test-"));
    directories.push(inputDirectory);
    const landscape = path.join(inputDirectory, "landscape.png");
    const portrait = path.join(inputDirectory, "portrait.png");
    await sharp({ create: { width: 100, height: 50, channels: 3, background: "red" } }).png().toFile(landscape);
    await sharp({ create: { width: 50, height: 100, channels: 3, background: "blue" } }).png().toFile(portrait);
    const plan = planFor(["a", "b"]);
    assert.ok(plan);
    const composite = await createStoryboardComposite(plan, [landscape, portrait]);
    directories.push(composite.directory);
    const { data, info } = await sharp(composite.filePath).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, info.channels], [200, 100, 4]);
    const pixelAt = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels)];
    assert.deepEqual(pixelAt(50, 50), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(150, 50), [0, 0, 255, 255]);
});
