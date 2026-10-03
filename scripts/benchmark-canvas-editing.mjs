// Run from web: node --import ../backend/node_modules/tsx/dist/loader.mjs ../scripts/benchmark-canvas-editing.mjs [baseline-ref]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasCanvasPatchChanges } from "../web/src/lib/canvas/canvas-patch-equality.ts";
import { createCanvasGraphIndexSelector } from "../web/src/lib/canvas/canvas-graph-index.ts";
import { createMentionReferenceSelector } from "../web/src/lib/canvas/canvas-resource-references.ts";
import { createPluginGraphAccess } from "../web/src/pages/canvas/hooks/plugin-graph-access.ts";
import { registerNodeDefinitions, unregisterPluginNodes } from "../web/src/lib/canvas/node-registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineCommit = execFileSync("git", ["rev-parse", "--verify", `${process.argv[2] || "HEAD"}^{commit}`], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const beforeSource = execFileSync("git", ["show", `${baselineCommit}:web/src/lib/canvas/canvas-resource-references.ts`], { cwd: root, encoding: "utf8", windowsHide: true });
if (beforeSource.includes("cached.dependencies.every")) throw new Error("Baseline already contains this optimization; pass an earlier baseline-ref");
const tempRoot = path.join(root, "web/.tmp");
fs.mkdirSync(tempRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(tempRoot, "canvas-editing-"));
const sourceUrl = new URL("../web/src/lib/canvas/canvas-resource-references.ts", import.meta.url);
fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
const beforePath = path.join(directory, "references-before.ts");
fs.writeFileSync(beforePath, beforeSource.replace(/from "(\.\.?\/[^\"]+)"/g, (_match, specifier) => `from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`));
const results = [];
const median = (items) => items.toSorted((a, b) => a - b)[Math.floor(items.length / 2)];
let providerCalls = 0;
registerNodeDefinitions([{ type: "bench:resource", title: "fixture", icon: null, defaultSize: { width: 200, height: 150 }, resource: (node) => { providerCalls++; return { kind: "image", url: node.metadata.url }; } }], "bench");
try {
    const beforeModule = await import(pathToFileURL(beforePath).href);
    for (const count of [200, 500, 1000]) {
        const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, type: i % 2 ? "config" : "bench:resource", title: `Node ${i}`, position: { x: i * 300, y: 0 }, width: 200, height: 150, metadata: { url: `fixture-${i}.png`, prompt: "fixed prompt ".repeat(256) } }));
        const outside = { ...nodes[0], id: "unrelated", type: "text" };
        const original = [...nodes, outside];
        const connections = nodes.filter((_n, i) => i % 2).map((target, i) => ({ id: `edge${i}`, fromNodeId: `n${i * 2}`, toNodeId: target.id }));
        const targets = nodes.filter((_n, i) => i % 2);
        for (let run = 0; run < 3; run++) for (const label of run % 2 ? ["after", "before"] : ["before", "after"]) {
            const equality = label === "after" ? hasCanvasPatchChanges : (before, patch) => Object.keys(patch).some((key) => JSON.stringify(before[key]) !== JSON.stringify(patch[key]));
            const references = label === "after" ? createMentionReferenceSelector() : beforeModule.createMentionReferenceSelector();
            const selectIndex = createCanvasGraphIndexSelector();
            let live = { nodes: original, connections };
            const access = createPluginGraphAccess(() => live, () => live, selectIndex);
            const upstream = label === "after" ? access.getUpstream : (nodeId) => live.connections.filter((link) => link.toNodeId === nodeId).map((link) => live.nodes.find((node) => node.id === link.fromNodeId)).filter(Boolean);
            references(targets, live.nodes, connections, selectIndex(live.nodes, connections));
            const times = { equality: [], references: [], upstream: [] };
            let calls = 0;
            for (let iteration = 0; iteration < 35; iteration++) {
                const previous = live;
                live = { nodes: [...nodes, { ...outside, title: `Edit ${iteration}` }], connections };
                const graph = selectIndex(live.nodes, connections);
                let start = performance.now();
                assert.equal(equality(previous, live), true);
                const equalityMs = performance.now() - start;
                providerCalls = 0;
                start = performance.now();
                const refs = references(targets, live.nodes, connections, graph);
                const referencesMs = performance.now() - start;
                assert.equal(refs.size, targets.length);
                assert.equal(refs.get("n1")[0].previewUrl, "fixture-0.png");
                start = performance.now();
                for (const target of targets) assert.equal(upstream(target.id)[0].id, `n${Number(target.id.slice(1)) - 1}`);
                const upstreamMs = performance.now() - start;
                if (iteration >= 5) { times.equality.push(equalityMs); times.references.push(referencesMs); times.upstream.push(upstreamMs); calls += providerCalls; }
            }
            results.push({ count, run: run + 1, label, equalityMs: median(times.equality), referencesMs: median(times.references), upstreamMs: median(times.upstream), providerCalls: calls });
        }
    }
    const medians = [200, 500, 1000].flatMap((count) => ["before", "after"].map((label) => {
        const matching = results.filter((item) => item.count === count && item.label === label);
        return { count, label, ...Object.fromEntries(["equalityMs", "referencesMs", "upstreamMs", "providerCalls"].map((key) => [key, median(matching.map((item) => item[key]))])) };
    }));
    const output = path.join(root, "artifacts/canvas-editing-performance.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ environment: { node: process.version, cpu: os.cpus()[0]?.model }, scope: "CPU helpers on immutable fixtures; index construction, React, network and persistence are outside timed sections", baselineCommit, medians, results }, null, 2));
    console.log(JSON.stringify({ output, medians }));
} finally {
    unregisterPluginNodes("bench");
    if (!path.resolve(directory).startsWith(path.resolve(tempRoot) + path.sep)) throw new Error("Invalid benchmark cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
}
