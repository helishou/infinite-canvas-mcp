import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const STORYBOARD_MANIFEST_SCHEMA = 1 as const;

export type StoryboardReviewStatus = "pending" | "verified" | "rejected" | "unclear";

export type StoryboardManifestItem = {
    shotId: string;
    nodeId: string;
    generationLogId: string;
    runtimeTaskId: string;
    storageKey: string;
    filePath: string;
    sha256: string;
    width: number;
    height: number;
    sourceCreatedAt: string;
    status: StoryboardReviewStatus;
};

export type StoryboardManifest = {
    schema: typeof STORYBOARD_MANIFEST_SCHEMA;
    projectId: string;
    groupNodeId: string;
    version: string;
    expectedShotIds: string[];
    sourceTaskIds: string[];
    items: StoryboardManifestItem[];
    createdAt: string;
};

export type StoryboardManifestBuildInput = {
    projectId: string;
    groupNodeId: string;
    version: string;
    expectedShotIds: string[];
    currentTaskIds: string[];
    outputs: Array<Omit<StoryboardManifestItem, "status">>;
    createdAt?: string;
};

export type StoryboardCanvasNode = {
    id: string;
    type: string;
    metadata?: {
        groupId?: string;
        storageKey?: string;
    };
};

export type ManifestValidationOptions = {
    requireVerified?: boolean;
    expectedWidth?: number;
    expectedHeight?: number;
};

function fail(message: string): never {
    throw new Error(`Storyboard manifest invalid: ${message}`);
}

function assertNonEmpty(value: unknown, field: string) {
    if (typeof value !== "string" || !value.trim()) fail(`${field} is required`);
}

function assertUnique(values: string[], field: string) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    if (duplicates.size) fail(`${field} contains duplicates: ${[...duplicates].join(", ")}`);
}

export function validateStoryboardManifest(
    manifest: StoryboardManifest,
    options: ManifestValidationOptions = {},
): StoryboardManifest {
    if (!manifest || manifest.schema !== STORYBOARD_MANIFEST_SCHEMA) {
        fail(`unsupported schema: ${String((manifest as Partial<StoryboardManifest> | null)?.schema)}`);
    }

    assertNonEmpty(manifest.projectId, "projectId");
    assertNonEmpty(manifest.groupNodeId, "groupNodeId");
    assertNonEmpty(manifest.version, "version");
    assertNonEmpty(manifest.createdAt, "createdAt");

    if (!Array.isArray(manifest.expectedShotIds) || !manifest.expectedShotIds.length) {
        fail("expectedShotIds must be a non-empty array");
    }
    assertUnique(manifest.expectedShotIds, "expectedShotIds");

    if (!Array.isArray(manifest.sourceTaskIds) || !manifest.sourceTaskIds.length) {
        fail("sourceTaskIds must be a non-empty array");
    }
    assertUnique(manifest.sourceTaskIds, "sourceTaskIds");

    if (!Array.isArray(manifest.items)) fail("items must be an array");
    assertUnique(manifest.items.map((item) => item.shotId), "items.shotId");
    assertUnique(manifest.items.map((item) => item.nodeId), "items.nodeId");
    assertUnique(manifest.items.map((item) => item.storageKey), "items.storageKey");

    const expected = new Set(manifest.expectedShotIds);
    const sourceTasks = new Set(manifest.sourceTaskIds);
    const actual = new Set(manifest.items.map((item) => item.shotId));
    const missing = manifest.expectedShotIds.filter((shotId) => !actual.has(shotId));
    const unexpected = manifest.items.map((item) => item.shotId).filter((shotId) => !expected.has(shotId));
    if (missing.length) fail(`missing shots: ${missing.join(", ")}`);
    if (unexpected.length) fail(`unexpected shots: ${unexpected.join(", ")}`);
    const unknownTasks = manifest.items.map((item) => item.runtimeTaskId).filter((taskId) => !sourceTasks.has(taskId));
    if (unknownTasks.length) fail(`items contain taskIds outside sourceTaskIds: ${[...new Set(unknownTasks)].join(", ")}`);

    for (const item of manifest.items) {
        assertNonEmpty(item.shotId, "item.shotId");
        assertNonEmpty(item.nodeId, `${item.shotId}.nodeId`);
        assertNonEmpty(item.generationLogId, `${item.shotId}.generationLogId`);
        assertNonEmpty(item.runtimeTaskId, `${item.shotId}.runtimeTaskId`);
        assertNonEmpty(item.storageKey, `${item.shotId}.storageKey`);
        assertNonEmpty(item.filePath, `${item.shotId}.filePath`);
        assertNonEmpty(item.sha256, `${item.shotId}.sha256`);
        assertNonEmpty(item.sourceCreatedAt, `${item.shotId}.sourceCreatedAt`);
        if (!Number.isInteger(item.width) || item.width <= 0) fail(`${item.shotId}.width must be a positive integer`);
        if (!Number.isInteger(item.height) || item.height <= 0) fail(`${item.shotId}.height must be a positive integer`);
        if (options.expectedWidth !== undefined && item.width !== options.expectedWidth) {
            fail(`${item.shotId} width ${item.width} != ${options.expectedWidth}`);
        }
        if (options.expectedHeight !== undefined && item.height !== options.expectedHeight) {
            fail(`${item.shotId} height ${item.height} != ${options.expectedHeight}`);
        }
        if (options.requireVerified && item.status !== "verified") {
            fail(`${item.shotId} is not verified: ${item.status}`);
        }
    }

    return manifest;
}

export function createStoryboardManifest(input: StoryboardManifestBuildInput): StoryboardManifest {
    assertNonEmpty(input.projectId, "projectId");
    assertNonEmpty(input.groupNodeId, "groupNodeId");
    assertNonEmpty(input.version, "version");
    if (!Array.isArray(input.currentTaskIds) || !input.currentTaskIds.length) fail("currentTaskIds must be a non-empty array");
    assertUnique(input.currentTaskIds, "currentTaskIds");

    const currentTasks = new Set(input.currentTaskIds);
    const staleOutputs = input.outputs.filter((item) => !currentTasks.has(item.runtimeTaskId));
    if (staleOutputs.length) {
        fail(`outputs contain tasks outside the current generation call: ${staleOutputs.map((item) => `${item.shotId}:${item.runtimeTaskId}`).join(", ")}`);
    }

    const manifest: StoryboardManifest = {
        schema: STORYBOARD_MANIFEST_SCHEMA,
        projectId: input.projectId,
        groupNodeId: input.groupNodeId,
        version: input.version,
        expectedShotIds: [...input.expectedShotIds],
        sourceTaskIds: [...new Set(input.outputs.map((item) => item.runtimeTaskId))],
        items: input.outputs.map((item) => ({ ...item, status: "pending" })),
        createdAt: input.createdAt || new Date().toISOString(),
    };
    return validateStoryboardManifest(manifest);
}

export function validateStoryboardManifestAgainstCanvas(
    manifest: StoryboardManifest,
    nodes: StoryboardCanvasNode[],
    options: ManifestValidationOptions = {},
): StoryboardManifest {
    validateStoryboardManifest(manifest, options);

    const group = nodes.find((node) => node.id === manifest.groupNodeId);
    if (!group) fail(`group node not found: ${manifest.groupNodeId}`);
    if (group.type !== "group") fail(`node ${manifest.groupNodeId} is not a group node`);

    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const item of manifest.items) {
        const node = byId.get(item.nodeId);
        if (!node) fail(`${item.shotId} node not found: ${item.nodeId}`);
        if (node.metadata?.groupId !== manifest.groupNodeId) {
            fail(`${item.shotId} node ${item.nodeId} is not a member of group ${manifest.groupNodeId}`);
        }
        if (node.metadata?.storageKey && node.metadata.storageKey !== item.storageKey) {
            fail(`${item.shotId} storageKey mismatch between manifest and node`);
        }
    }

    return manifest;
}

export function sha256File(filePath: string): string {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function writeStoryboardManifest(filePath: string, manifest: StoryboardManifest): void {
    validateStoryboardManifest(manifest);
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
}

export function readStoryboardManifest(filePath: string): StoryboardManifest {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as StoryboardManifest;
    return validateStoryboardManifest(parsed);
}
