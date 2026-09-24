import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";

import { createReferenceWriteCoordinator } from "./reference-write-coordinator";
import { diffCanvasProject, type CanvasProject } from "../../stores/canvas/use-canvas-store";
import type { CanvasReferenceAsset, CanvasReferenceService } from "@/types/canvas-plugin";

const NODE_COUNT = 1000;
const CONNECTION_COUNT = 3000;
const SAMPLES = 5;
const NOOP_ITERATIONS = 1000;
const UPDATE_ITERATIONS = 1000;
const REFERENCE_SYNC_ITERATIONS = 100;

function makeProject(): CanvasProject {
    const nodes: CanvasProject["nodes"] = Array.from({ length: NODE_COUNT }, (_, index) => ({
        id: `node-${index}`,
        type: index % 3 === 0 ? "minimax:h3" : index % 3 === 1 ? "text" : "image",
        title: `节点 ${index}`,
        position: { x: (index % 40) * 360, y: Math.floor(index / 40) * 260 },
        width: 320,
        height: 220,
        metadata: {
            prompt: `提示词 ${index}`,
            status: "idle",
            references: [`node-${Math.max(0, index - 1)}`],
            storageKey: index % 3 === 2 ? `media/node-${index}.png` : undefined,
            nested: { keep: index, order: [1, 2, 3] },
        },
    }));
    const connections: CanvasProject["connections"] = Array.from({ length: CONNECTION_COUNT }, (_, index) => ({
        id: `connection-${index}`,
        fromNodeId: `node-${index % NODE_COUNT}`,
        toNodeId: `node-${(index * 7 + 1) % NODE_COUNT}`,
        role: "reference",
        order: index % 4,
    }));
    return {
        id: "benchmark",
        revision: 1,
        title: "1000 节点基准",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections,
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        globalPrompt: "",
        viewport: { x: 0, y: 0, k: 1 },
    };
}

function makeReferenceService(): { service: CanvasReferenceService; calls: () => number } {
    let calls = 0;
    const service = {
        list: async () => [],
        upsert: async (asset) => { calls += 1; return asset as CanvasReferenceAsset; },
        upsertMany: async (assets) => { calls += 1; return assets as CanvasReferenceAsset[]; },
        remove: async () => undefined,
        validate: async () => ({ semanticPrompt: "", compiledPrompt: "", bindings: [], references: [], issues: [], migratedLegacyRefs: false }),
    } satisfies CanvasReferenceService;
    return { service, calls: () => calls };
}

function median(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measure(name: string, iterations: number, operation: () => unknown) {
    for (let warmup = 0; warmup < 2; warmup += 1) await operation();
    const samples: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
        const started = performance.now();
        for (let index = 0; index < iterations; index += 1) await operation();
        samples.push(performance.now() - started);
    }
    return { name, iterations, samplesMs: samples.map((value) => Number(value.toFixed(3))), wallTimeMsMedian: Number(median(samples).toFixed(3)) };
}

async function measureReferenceSync(operation: () => Promise<unknown>) {
    await operation();
    await operation();
    const backendCallsBeforeSamples = calls();
    const samples: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
        const started = performance.now();
        for (let index = 0; index < REFERENCE_SYNC_ITERATIONS; index += 1) await operation();
        samples.push(performance.now() - started);
    }
    return {
        measurement: { name: "reference-sync", iterations: REFERENCE_SYNC_ITERATIONS, samplesMs: samples.map((value) => Number(value.toFixed(3))), wallTimeMsMedian: Number(median(samples).toFixed(3)) },
        backendBatchCalls: calls() - backendCallsBeforeSamples,
    };
}

const base = makeProject();
const noOp = structuredClone(base);
const changed = structuredClone(base);
changed.nodes[417] = { ...changed.nodes[417], metadata: { ...changed.nodes[417].metadata, prompt: "真实更新" } };
const serializedBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
const { service, calls } = makeReferenceService();
const assets: CanvasReferenceAsset[] = Array.from({ length: 20 }, (_, index) => ({
    id: `shared-asset-${index % 10}`,
    mediaType: "image" as const,
    label: `共享资产 ${index}`,
    role: "prop",
    tags: ["bench", `binding-${index}`],
    url: `http://127.0.0.1/media/${index}.png`,
    storageKey: `media/${index}.png`,
}));

const measurements = [
    await measure("metadata-no-op", NOOP_ITERATIONS, () => diffCanvasProject(base, noOp)),
    await measure("single-node-update", UPDATE_ITERATIONS, () => diffCanvasProject(base, changed)),
];
const referenceSync = await measureReferenceSync(async () => {
    const batch = createReferenceWriteCoordinator(service);
    await batch.upsertMany(assets);
});
measurements.push(referenceSync.measurement);
const results: Record<string, unknown> & { assertions?: Record<string, boolean> } = {
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model || "unknown", logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    graph: { nodes: NODE_COUNT, connections: CONNECTION_COUNT, serializedBytes, samplesPerScenario: SAMPLES },
    measurements,
    referenceSync: { inputCount: assets.length, backendBatchCalls: referenceSync.backendBatchCalls, expectedBatchCalls: SAMPLES * REFERENCE_SYNC_ITERATIONS },
};
results.assertions = {
    nodeCount: base.nodes.length === NODE_COUNT,
    connectionCount: base.connections.length === CONNECTION_COUNT,
    batchCallsMatch: referenceSync.backendBatchCalls === SAMPLES * REFERENCE_SYNC_ITERATIONS,
};

console.log(JSON.stringify(results, null, 2));
