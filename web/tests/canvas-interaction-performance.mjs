import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

// Run against Vite dev: node web/tests/canvas-interaction-performance.mjs
// Exercise the real page with an ephemeral canvas. No test writes reach Backend.
const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root.dataDir || path.join(os.homedir(), ".infinite-canvas"), "backend.json"), "utf8"));
const projectId = "canvas-interaction-performance";
const nodes = Array.from({ length: 120 }, (_, index) => ({
    id: `perf-${index}`, type: "text", title: `Performance ${index}`,
    position: { x: (index % 12) * 300, y: Math.floor(index / 12) * 220 }, width: 260, height: 180,
    metadata: { content: `## Node ${index}\n\nCanvas interaction performance.\n\n- Stable content\n- **Markdown rendering**`, status: "success" },
}));
let project = { id: projectId, title: "Performance fixture", revision: 1, nodes, connections: [], viewport: { x: 80, y: 100, k: 1 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", chatSessions: [], activeChatId: null };
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    await page.addInitScript(({ url, token }) => {
        localStorage.setItem("backend-url", url); localStorage.setItem("backend-token", token);
        window.canvasPerf = { commits: 0, renders: {}, contentRenders: {}, changedProps: {}, durations: [] };
        const lastFibers = new Map();
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true, renderers: new Map(),
            inject(renderer) { this.renderers.set(1, renderer); return 1; },
            onCommitFiberUnmount() {},
            onCommitFiberRoot(_id, root) {
                const stats = window.canvasPerf;
                stats.commits++;
                const visit = fiber => {
                    if (!fiber) return;
                    const name = fiber.type?.displayName || fiber.type?.name || fiber.type?.type?.name || fiber.elementType?.type?.name;
                    const key = `${name}:${fiber.memoizedProps?.data?.id || fiber.memoizedProps?.node?.id || ""}`;
                    const changed = lastFibers.get(key) !== fiber;
                    if (name === "CanvasSurface" && changed && (fiber.flags & 1)) stats.durations.push(fiber.actualDuration);
                    if (/^CanvasNodeViewportItem\d*$/.test(name) && changed && (fiber.flags & 1)) {
                        const id = fiber.memoizedProps.data.id;
                        stats.renders[id] = (stats.renders[id] || 0) + 1;
                        if (fiber.alternate) for (const key of Object.keys(fiber.memoizedProps)) {
                            if (!Object.is(fiber.memoizedProps[key], fiber.alternate.memoizedProps[key])) stats.changedProps[key] = (stats.changedProps[key] || 0) + 1;
                        }
                    }
                    if (/^NodeContent\d*$/.test(name) && changed && (fiber.flags & 1)) {
                        const id = fiber.memoizedProps.node.id;
                        stats.contentRenders[id] = (stats.contentRenders[id] || 0) + 1;
                    }
                    if (name === "CanvasSurface" || /^(CanvasNodeViewportItem|NodeContent)\d*$/.test(name)) lastFibers.set(key, fiber);
                    visit(fiber.child); visit(fiber.sibling);
                };
                visit(root.current);
            },
        };
    }, config);
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
            const body = request.postDataJSON();
            writes.push(url.pathname);
            if (url.pathname.endsWith(`/canvas/projects/${projectId}/ops`)) {
                for (const operation of body.operations) {
                    if (operation.type === "update_node") project = { ...project, nodes: project.nodes.map(node => node.id === operation.id ? { ...node, ...operation.patch, metadata: { ...node.metadata, ...operation.patch.metadata } } : node) };
                    else if (operation.type === "update_project") project = { ...project, ...operation.patch };
                    else throw new Error(`Unexpected fixture operation: ${operation.type}`);
                }
                project = { ...project, revision: project.revision + 1 };
                await route.fulfill({ json: { ok: true, project, revision: project.revision, operationId: body.operationId } }); return;
            }
            await route.fulfill({ json: { ok: true, revision: 2 } }); return;
        }
        if (url.pathname.includes(`/canvas/projects/${projectId}`)) {
            if (url.pathname.endsWith("/production-context")) await route.fulfill({ json: { ok: true, context: { role: "ordinary", canvasId: projectId } } });
            else await route.fulfill({ json: { ok: true, project } });
            return;
        }
        await route.continue();
    });
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/canvas/${projectId}`);
    await page.locator('[data-node-id="perf-0"]').waitFor().catch(async error => {
        console.log(JSON.stringify({ errors, url: page.url(), body: (await page.locator("body").innerText()).slice(0, 1800) }));
        throw error;
    });
    await page.waitForTimeout(1500);
    const reset = () => page.evaluate(() => { window.canvasPerf = { commits: 0, renders: {}, contentRenders: {}, changedProps: {}, durations: [] }; });
    const read = () => page.evaluate(() => structuredClone(window.canvasPerf));
    await page.mouse.move(1400, 850);
    await reset();
    const target = page.locator('[data-node-id="perf-0"]');
    const rect = await target.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 20);
    await page.waitForTimeout(200);
    await page.mouse.move(1400, 850);
    await page.waitForTimeout(300);
    const hover = await read();
    const unrelated = Object.entries(hover.renders).filter(([id]) => id !== "perf-0");
    await page.mouse.move(rect.x + 40, rect.y + 20);
    await page.mouse.down();
    await page.mouse.move(rect.x + 50, rect.y + 25);
    await reset();
    await page.mouse.move(rect.x + 130, rect.y + 80, { steps: 20 });
    const drag = await read();
    await page.mouse.up();
    await page.waitForFunction(rect => {
        const moved = document.querySelector('[data-node-id="perf-0"]').getBoundingClientRect();
        return Math.abs(moved.x - rect.x - 90) < 2 && Math.abs(moved.y - rect.y - 60) < 2;
    }, rect, { timeout: 5000 });
    // Update the ephemeral project through the normal store action.
    const updatedReceipt = page.waitForResponse(response => response.url().includes(`/canvas/projects/${projectId}/ops`) && response.request().postData()?.includes("Updated content after drag"));
    await page.evaluate(async projectId => {
        // Reuse Vite's loaded URL, including its HMR timestamp, to avoid a second store instance.
        const moduleUrl = performance.getEntriesByType("resource").find(entry => /\/src\/stores\/canvas\/use-canvas-store\.ts(?:\?|$)/.test(entry.name)).name;
        const { useCanvasStore } = await import(moduleUrl);
        const store = useCanvasStore.getState(), project = store.projects.find(project => project.id === projectId);
        store.updateProject(projectId, { nodes: project.nodes.map(node => node.id !== "perf-0" ? node : { ...node, metadata: { ...node.metadata, content: "Updated content after drag" } }) });
    }, projectId);
    await target.getByText("Updated content after drag", { exact: true }).waitFor({ timeout: 5000 }).catch(async error => {
        console.log(JSON.stringify({ nodeText: await target.innerText(), state: await page.evaluate(async projectId => {
            const moduleUrl = performance.getEntriesByType("resource").find(entry => /\/src\/stores\/canvas\/use-canvas-store\.ts(?:\?|$)/.test(entry.name)).name;
            const { useCanvasStore } = await import(moduleUrl);
            return useCanvasStore.getState().projects.find(project => project.id === projectId)?.nodes.find(node => node.id === "perf-0");
        }, projectId), errors }));
        throw error;
    });
    await updatedReceipt;
    await page.waitForTimeout(300);
    await reset();
    await page.mouse.move(1100, 800);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(500, 700, { steps: 30 });
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(700);
    const pan = await read();
    const viewport = () => page.locator("[data-canvas-viewport-transform]").evaluate(element => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        const rect = element.parentElement.getBoundingClientRect();
        return { x: matrix.e, y: matrix.f, k: matrix.a, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    const checkCoverage = async () => {
        const view = await viewport();
        const mounted = new Set(await page.locator("[data-node-id]").evaluateAll(elements => elements.map(element => element.dataset.nodeId)));
        for (const node of nodes) {
            const position = node.id === "perf-0" ? { x: node.position.x + 90, y: node.position.y + 60 } : node.position;
            const x = view.x + position.x * view.k, y = view.y + position.y * view.k;
            if (x < view.width && y < view.height && x + node.width * view.k > 0 && y + node.height * view.k > 0) assert.ok(mounted.has(node.id), `visible node ${node.id} is mounted`);
        }
    };
    await checkCoverage();
    const beforeZoom = await viewport();
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(700);
    const afterZoom = await viewport();
    for (const [axis, pointer, offset] of [["x", 700, "left"], ["y", 450, "top"]]) {
        assert.ok(Math.abs((pointer - beforeZoom[offset] - beforeZoom[axis]) / beforeZoom.k - (pointer - afterZoom[offset] - afterZoom[axis]) / afterZoom.k) < 0.01, `zoom preserves the ${axis} pointer anchor`);
    }
    const visibleAfterZoom = await page.locator("[data-node-id]").count();
    await checkCoverage();
    await page.mouse.wheel(0, 6000);
    await page.waitForTimeout(700);
    assert.equal((await viewport()).k, 0.05, "zoom reaches 5%");
    await checkCoverage();
    for (const x of [1250, 200]) {
        await page.mouse.move(700, 450);
        await page.mouse.down({ button: "middle" });
        await page.mouse.move(x, 500, { steps: 8 });
        await page.mouse.up({ button: "middle" });
        await page.waitForTimeout(200);
        await checkCoverage();
    }
    console.log(JSON.stringify({ hover, unrelatedHoverRenders: unrelated.length, drag, pan, visibleAfterZoom, minimumZoom: 0.05, pointerAnchor: true, cullCoverage: true, contentUpdates: true, errors, interceptedWrites: writes.length }));
    assert.deepEqual(errors, []);
    assert.ok(visibleAfterZoom > 0, "zoom keeps canvas nodes mounted");
    if (!process.env.CANVAS_PERF_BASELINE) {
        assert.ok(hover.renders["perf-0"] > 0, "the probe observes hover renders");
        assert.equal(unrelated.length, 0, "hover must not rerender unrelated nodes");
        assert.ok(drag.renders["perf-0"] >= 10, "the probe observes actual drag preview renders");
        assert.equal(drag.contentRenders["perf-0"] || 0, 0, "moving a node must reuse unchanged content");
        assert.equal(Object.keys(pan.changedProps).length, 0, "panning keeps existing node props stable");
    }
} finally { await browser.close(); }
