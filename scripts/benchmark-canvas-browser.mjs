import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { chromium } from "playwright";

const backend = process.env.CANVAS_TEST_BACKEND;
const web = process.env.CANVAS_TEST_WEB;
const output = process.env.CANVAS_TEST_ARTIFACTS;
if (!backend || !web || !output || !process.env.INFINITE_CANVAS_DATA_DIR) throw new Error("Use the isolated browser test launcher");
const { token } = JSON.parse(fs.readFileSync(path.join(process.env.INFINITE_CANVAS_DATA_DIR, "backend.json"), "utf8"));
const label = process.argv[2] || "measurement";
const rebuildControl = process.argv.includes("--rebuild-control");
const counts = process.env.CANVAS_BENCH_COUNTS ? process.env.CANVAS_BENCH_COUNTS.split(",").map(Number) : [200, 500, 1000];
const repetitions = 3;
const samples = [];
const api = async (method, route, body) => {
    const response = await fetch(backend + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
};
const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#32648c"/></svg>')}`;
const percentile = (values, ratio) => values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * ratio))] || 0;
const browser = await chromium.launch({ headless: true });
try {
    for (const count of counts) for (let run = 0; run < repetitions; run++) {
        const id = `benchmark-${crypto.randomUUID()}`;
        const nodes = Array.from({ length: count }, (_, i) => ({
            id: `n${i}`, type: i === 0 ? "minimax-h3:video" : i % 3 === 0 ? "text" : "image", title: `Fixture ${i}`,
            position: i === 0 ? { x: 40, y: 90 } : { x: 760 + ((i - 1) % 20) * 340, y: Math.floor((i - 1) / 20) * 260 },
            width: i === 0 ? 620 : 280, height: i === 0 ? 700 : 190,
            metadata: i === 0 ? { segments: [{ id: "clip", prompt: "Fixed benchmark clip", duration: 4, status: "idle", referenceBindings: [] }] } : { content: i % 3 === 0 ? `Benchmark text ${i}` : svg },
        }));
        const connections = Array.from({ length: Math.round(count * 1.5) }, (_, i) => ({ id: `c${i}`, fromNodeId: `n${1 + i % (count - 1)}`, toNodeId: `n${1 + (i * 17 + 7) % (count - 1)}` }));
        await api("POST", "/canvas/projects", { id, title: `Benchmark ${count}`, revision: 0, nodes, connections, updatedAt: new Date().toISOString() });
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        await context.addInitScript(({ backend, token }) => { localStorage.setItem("backend-url", backend); localStorage.setItem("backend-token", token); window.__canvasIndexMetrics = {}; }, { backend, token });
        const page = await context.newPage();
        if (rebuildControl) {
            // Diagnostic control: same app and fixture, but rebuild indexes on every changed input.
            // This changes only the test response, never the source file or the resident server.
            await page.route("**/src/pages/canvas/project.tsx*", async (route) => {
                const response = await route.fetch();
                const source = await response.text();
                const call = "selectGraphIndex(nodes, connections)";
                assert.ok(source.includes(call), "review rebuild control after source changes");
                await route.fulfill({ response, body: source.replace(call, "createCanvasGraphIndexSelector()(nodes, connections)") });
            });
        }
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        try {
            await page.goto(`${web}/canvas/${id}`);
            await page.locator('[data-node-id="n0"]').waitFor();
            await page.locator(".minimax-canvas-workbench").first().waitFor();
            await page.evaluate(async () => {
                window.__benchStore = (await import("/tests/canvas-command-harness.ts")).useCanvasStore;
                window.__canvasIndexMetrics = {};
                window.__benchFrames = []; window.__benchLongTasks = [];
                window.__benchRunning = true;
                let previous = performance.now();
                const tick = (now) => { if (!window.__benchRunning) return; window.__benchFrames.push(now - previous); previous = now; requestAnimationFrame(tick); };
                requestAnimationFrame(tick);
                window.__benchObserver = new PerformanceObserver((entries) => window.__benchLongTasks.push(...entries.getEntries().map((entry) => entry.duration)));
                window.__benchObserver.observe({ type: "longtask", buffered: false });
            });
            const opsMs = [];
            for (let edit = 0; edit < 24; edit++) {
                const title = `Updated ${edit}`;
                const start = performance.now();
                await api("POST", `/canvas/projects/${id}/ops`, { operationId: crypto.randomUUID(), operations: [{ type: "update_node", id: `n${edit + 1}`, patch: { title } }] });
                opsMs.push(performance.now() - start);
                await page.waitForFunction(({ id, nodeId, title }) => window.__benchStore.getState().projects.find((p) => p.id === id)?.nodes.find((n) => n.id === nodeId)?.title === title, { id, nodeId: `n${edit + 1}`, title });
            }
            const contentIndexBuilds = await page.evaluate(() => ({ ...window.__canvasIndexMetrics }));
            const slider = page.locator('input[type="range"][min="5"]');
            await slider.focus(); await page.keyboard.press("Home");
            await page.getByText("5%", { exact: true }).waitFor();
            await page.keyboard.press("Tab");
            for (let step = 0; step < 6; step++) {
                await page.keyboard.down("Space");
                await page.mouse.move(1000, 650); await page.mouse.down();
                await page.mouse.move(step % 2 ? 1150 : 850, 650, { steps: 20 });
                await page.mouse.up(); await page.keyboard.up("Space");
            }
            await page.mouse.move(1100, 650);
            for (let i = 0; i < 8; i++) await page.mouse.wheel(0, i % 2 ? 100 : -100);
            // Wait for the existing wheel commit point; this is a diagnostic wait, not a product change.
            await page.waitForTimeout(600);
            const metrics = await page.evaluate(() => {
                window.__benchRunning = false; window.__benchObserver.disconnect();
                return { frames: window.__benchFrames, longTasks: window.__benchLongTasks, indexBuilds: window.__canvasIndexMetrics, mountedNodes: document.querySelectorAll("[data-node-id]").length };
            });
            assert.ok(metrics.frames.length > 0 && metrics.mountedNodes > 0);
            assert.deepEqual(pageErrors, []);
            const sample = { count, run: run + 1, frameP95Ms: percentile(metrics.frames, .95), longTaskCount: metrics.longTasks.length, longTaskMs: metrics.longTasks.reduce((a, b) => a + b, 0), mountedNodes: metrics.mountedNodes, opsP95Ms: percentile(opsMs, .95), contentIndexBuilds, indexBuilds: metrics.indexBuilds };
            samples.push(sample); console.log(JSON.stringify(sample));
            if (run === 0) await page.screenshot({ path: path.join(output, `${count}-nodes.png`) });
        } catch (error) {
            await page.screenshot({ path: path.join(output, `failure-${count}-${run}.png`) }).catch(() => {});
            throw error;
        } finally { await context.close(); await api("DELETE", `/canvas/projects/${id}`); }
    }
} finally {
    await browser.close();
    const medians = counts.map((count) => {
        const rows = samples.filter((sample) => sample.count === count);
        return { count, completedRuns: rows.length, ...Object.fromEntries(["frameP95Ms", "longTaskCount", "longTaskMs", "mountedNodes", "opsP95Ms"].map((key) => [key, percentile(rows.map((row) => row[key]), .5)])) };
    });
    fs.writeFileSync(path.join(output, "performance.json"), JSON.stringify({ label, rebuildControl, environment: { platform: process.platform, node: process.version, cpu: os.cpus()[0]?.model, chromium: browser.version(), viewport: "1600x1000", mode: "Vite dev, real canvas" }, samples, medians }, null, 2));
}
