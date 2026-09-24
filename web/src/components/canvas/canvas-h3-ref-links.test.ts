import assert from "node:assert/strict";
import test from "node:test";

import { collectH3RefLinks } from "./canvas-h3-ref-links";
import type { CanvasNodeData } from "@/types/canvas";

const node = (value: Partial<CanvasNodeData> & Pick<CanvasNodeData, "id" | "type">) => ({
    position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {}, ...value,
}) as CanvasNodeData;

test("H3 参考虚线跟随当前窗口选择的 Clip，不读取另一窗口的共享选择", () => {
    const first = node({ id: "first", type: "image", metadata: { storageKey: "first.png" } });
    const second = node({ id: "second", type: "image", metadata: { storageKey: "second.png" } });
    const h3 = node({
        id: "h3", type: "minimax-h3:video",
        metadata: {
            selectedSegmentId: "S02",
            segments: [
                { id: "S01", refItems: [{ type: "image", storageKey: "first.png" }] },
                { id: "S02", refItems: [{ type: "image", storageKey: "second.png" }] },
            ],
        } as unknown as CanvasNodeData["metadata"],
    });

    assert.deepEqual(collectH3RefLinks([first, second, h3], () => "S02").map((link) => link.from.id), ["second"]);
    assert.deepEqual(collectH3RefLinks([first, second, h3], () => undefined).map((link) => link.from.id), ["first"]);
});
