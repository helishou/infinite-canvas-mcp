import assert from "node:assert/strict";
import test from "node:test";
import { canvasNodeSearchText, canvasRenamePreview, viewportForCanvasNodes } from "./canvas-navigation";
import type { CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number): CanvasNodeData => ({ id, title: `Title ${id}`, type: "text", position: { x, y }, width: 240, height: 160, metadata: { content: "original" } });
test("finder searches IDs, text and Clip prompts without indexing media bytes", () => {
    const text = node("Node-A", 0, 0);
    assert.ok(canvasNodeSearchText(text, "文本").includes("node-a"));
    assert.ok(canvasNodeSearchText(text).includes("original"));
    const image = { ...text, type: "image", metadata: { content: "data:image/png;base64,private-pixels", prompt: "The CAT" } };
    assert.ok(canvasNodeSearchText(image).includes("the cat"));
    assert.equal(canvasNodeSearchText(image).includes("private-pixels"), false);
    const clip = { ...text, type: "minimax-h3:video", metadata: { segments: [{ prompt: "夜晚追逐" }] } } as CanvasNodeData;
    assert.ok(canvasNodeSearchText(clip).includes("夜晚追逐"));
});
test("focus fits selected bounds and preserves the existing single-node zoom and margin", () => {
    const nodes = [node("a", -1000, -400), node("b", 3000, 800)];
    const size = { width: 1200, height: 800 };
    const fit = viewportForCanvasNodes(nodes, size)!;
    for (const node of nodes) {
        assert.ok(fit.x + node.position.x * fit.k >= 0);
        assert.ok(fit.x + (node.position.x + node.width) * fit.k <= size.width);
        assert.ok(fit.y + node.position.y * fit.k >= 0);
        assert.ok(fit.y + (node.position.y + node.height) * fit.k <= size.height);
    }
    const one = node("one", 0, 0);
    assert.deepEqual(viewportForCanvasNodes([one], size), { x: 480, y: 320, k: 1 });
    assert.equal(viewportForCanvasNodes([], size), null);
    assert.equal(viewportForCanvasNodes([one], { width: 0, height: 0 }), null);
    assert.equal(viewportForCanvasNodes([{ ...one, width: NaN }], size), null);
});
test("batch preview uses stable IDs and order, supports empty prefixes and rejects invalid start numbers", () => {
    const nodes = [node("b", 0, 0), node("a", 300, 0)];
    const saved = structuredClone(nodes);
    assert.deepEqual(canvasRenamePreview(nodes, " 分镜 ", 9), [{ id: "b", before: "Title b", title: "分镜 09" }, { id: "a", before: "Title a", title: "分镜 10" }]);
    assert.deepEqual(canvasRenamePreview(nodes, "", 99).map((item) => item.title), ["99", "100"]);
    for (const value of [null, 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) assert.deepEqual(canvasRenamePreview(nodes, "", value), []);
    assert.deepEqual(nodes, saved);
});
