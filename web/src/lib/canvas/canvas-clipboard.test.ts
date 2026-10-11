import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_CLIPBOARD_FORMAT, findClipboardMediaType, isLegacyCanvasClipboardText, parseCanvasClipboard, serializeCanvasClipboard } from "./canvas-clipboard";
import type { CanvasClipboard } from "./canvas-clipboard";

const node = (id: string) => ({ id, type: "text", title: id, width: 240, height: 160, position: { x: 10, y: 20 }, metadata: { content: id } });
const connection = (id: string, fromNodeId: string, toNodeId: string) => ({ id, fromNodeId, toNodeId, fromHandle: "right", toHandle: "left" });

function payload(nodes: unknown[], connections: unknown[] = []) {
    return JSON.stringify({ format: CANVAS_CLIPBOARD_FORMAT, version: 1, nodes, connections });
}

test("canvas clipboard serializes and parses the versioned payload without changing node data", () => {
    const clipboard = { nodes: [node("a"), node("b")], connections: [connection("ab", "a", "b")] } as unknown as CanvasClipboard;
    const serialized = serializeCanvasClipboard(clipboard);
    assert.deepEqual(JSON.parse(serialized), { format: CANVAS_CLIPBOARD_FORMAT, version: 1, ...clipboard });
    assert.deepEqual(parseCanvasClipboard(serialized), clipboard);
});

test("canvas clipboard rejects invalid JSON, unsupported envelopes and empty valid-node sets", () => {
    assert.equal(parseCanvasClipboard("{"), null);
    assert.equal(parseCanvasClipboard(JSON.stringify({ format: "other", version: 1, nodes: [node("a")], connections: [] })), null);
    assert.equal(parseCanvasClipboard(JSON.stringify({ format: CANVAS_CLIPBOARD_FORMAT, version: 2, nodes: [node("a")], connections: [] })), null);
    assert.equal(parseCanvasClipboard(payload([], [])), null);
    assert.equal(parseCanvasClipboard(payload([{ id: "bad", type: "text" }], [])), null);
});

test("canvas clipboard keeps connections touching copied nodes and filters malformed or unrelated connections", () => {
    const parsed = parseCanvasClipboard(payload(
        [node("a")],
        [connection("internal", "a", "a"), connection("cross-boundary", "a", "outside"), connection("unrelated", "outside", "elsewhere"), { id: "bad" }],
    ));
    assert.deepEqual(parsed?.connections.map(item => item.id), ["internal", "cross-boundary"]);
});

test("plain-text fallback recognizes legacy and current canvas clipboard format names", () => {
    assert.equal(isLegacyCanvasClipboardText(JSON.stringify({ format: "infinite-canvas-nodes" })), true);
    assert.equal(isLegacyCanvasClipboardText(JSON.stringify({ format: CANVAS_CLIPBOARD_FORMAT })), true);
    assert.equal(isLegacyCanvasClipboardText(JSON.stringify({ format: "other" })), false);
    assert.equal(isLegacyCanvasClipboardText("not json"), false);
});

test("clipboard media type lookup accepts native and web-prefixed MIME types", () => {
    const item = { types: ["text/plain", "web image/png", "video/mp4"] } as unknown as ClipboardItem;
    assert.equal(findClipboardMediaType(item, "image"), "web image/png");
    assert.equal(findClipboardMediaType(item, "video"), "video/mp4");
    assert.equal(findClipboardMediaType(item, "audio"), undefined);
});
