import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
    createStoryboardManifest,
    readStoryboardManifest,
    sha256File,
    validateStoryboardManifest,
    validateStoryboardManifestAgainstCanvas,
    writeStoryboardManifest,
    type StoryboardManifest,
} from "./storyboard-manifest.js";

function item(shotId: string, overrides: Partial<StoryboardManifest["items"][number]> = {}) {
    return {
        shotId,
        nodeId: `node-${shotId}`,
        generationLogId: `log-${shotId}`,
        runtimeTaskId: `task-${shotId}`,
        storageKey: `image:${shotId}`,
        filePath: `/media/${shotId}.png`,
        sha256: `hash-${shotId}`,
        width: 864,
        height: 1536,
        sourceCreatedAt: "2026-09-22T00:00:00.000Z",
        status: "verified" as const,
        ...overrides,
    };
}

function manifest(items = [item("S01-01"), item("S01-03")]): StoryboardManifest {
    return {
        schema: 1,
        projectId: "project-1",
        groupNodeId: "group-1",
        version: "v2",
        expectedShotIds: ["S01-01", "S01-03"],
        sourceTaskIds: ["task-S01-01", "task-S01-03"],
        items,
        createdAt: "2026-09-22T00:00:00.000Z",
    };
}

test("accepts a complete verified manifest", () => {
    assert.doesNotThrow(() => validateStoryboardManifest(manifest(), { requireVerified: true, expectedWidth: 864, expectedHeight: 1536 }));
});

test("builds a sidecar only from task outputs returned by the current generation call", () => {
    const built = createStoryboardManifest({
        projectId: "project-1",
        groupNodeId: "group-1",
        version: "v2",
        expectedShotIds: ["S01-01", "S01-03"],
        currentTaskIds: ["task-S01-01", "task-S01-03"],
        outputs: [item("S01-01"), item("S01-03")],
        createdAt: "2026-09-22T00:00:00.000Z",
    });
    assert.deepEqual(built.sourceTaskIds, ["task-S01-01", "task-S01-03"]);
    assert.deepEqual(built.items.map((value) => value.status), ["pending", "pending"]);
});

test("rejects an old task when constructing the current sidecar", () => {
    assert.throws(
        () => createStoryboardManifest({
            projectId: "project-1",
            groupNodeId: "group-1",
            version: "v2",
            expectedShotIds: ["S01-01", "S01-03"],
            currentTaskIds: ["task-new"],
            outputs: [
                item("S01-01", { runtimeTaskId: "task-new" }),
                item("S01-03", { runtimeTaskId: "task-old" }),
            ],
        }),
        /outside the current generation call/,
    );
});

test("rejects missing shots instead of silently falling back to old media", () => {
    assert.throws(
        () => validateStoryboardManifest(manifest([item("S01-01")])) ,
        /missing shots: S01-03/,
    );
});

test("requires the sidecar to declare every source task explicitly", () => {
    const value = manifest([
        item("S01-01", { generationLogId: "new-log", runtimeTaskId: "new-task" }),
        item("S01-03", { generationLogId: "old-log", runtimeTaskId: "old-task", sourceCreatedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    assert.throws(
        () => validateStoryboardManifest(value),
        /outside sourceTaskIds/,
    );
});

test("rejects duplicate shot, node, and storage identities", () => {
    assert.throws(
        () => validateStoryboardManifest(manifest([item("S01-01"), item("S01-01", { nodeId: "node-other", storageKey: "image:other" })])),
        /items\.shotId contains duplicates/,
    );
    assert.throws(
        () => validateStoryboardManifest(manifest([item("S01-01"), item("S01-03", { nodeId: "node-S01-01" })])),
        /items\.nodeId contains duplicates/,
    );
    assert.throws(
        () => validateStoryboardManifest(manifest([item("S01-01"), item("S01-03", { storageKey: "image:S01-01" })])),
        /items\.storageKey contains duplicates/,
    );
});

test("requires every manifest node to remain in the referenced group", () => {
    const nodes = [
        { id: "group-1", type: "group" },
        { id: "node-S01-01", type: "image", metadata: { groupId: "group-1", storageKey: "image:S01-01" } },
        { id: "node-S01-03", type: "image", metadata: { groupId: "group-old", storageKey: "image:S01-03" } },
    ];
    assert.throws(
        () => validateStoryboardManifestAgainstCanvas(manifest(), nodes),
        /S01-03 node node-S01-03 is not a member of group group-1/,
    );
});

test("requires node storageKey to match the manifest", () => {
    const nodes = [
        { id: "group-1", type: "group" },
        { id: "node-S01-01", type: "image", metadata: { groupId: "group-1", storageKey: "image:S01-01" } },
        { id: "node-S01-03", type: "image", metadata: { groupId: "group-1", storageKey: "image:old" } },
    ];
    assert.throws(
        () => validateStoryboardManifestAgainstCanvas(manifest(), nodes),
        /S01-03 storageKey mismatch/,
    );
});

test("writes and reads the manifest atomically", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "storyboard-manifest-"));
    const filePath = path.join(dir, "release-v2.json");
    writeStoryboardManifest(filePath, manifest());
    const loaded = readStoryboardManifest(filePath);
    assert.deepEqual(loaded, manifest());
    assert.match(readFileSync(filePath, "utf8"), /\"groupNodeId\": \"group-1\"/);
});

test("computes a stable hash for an exported source file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "storyboard-hash-"));
    const filePath = path.join(dir, "frame.txt");
    writeFileSync(filePath, "frame");
    assert.equal(sha256File(filePath), "9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e");
});
