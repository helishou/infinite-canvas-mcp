import assert from "node:assert/strict";
import test from "node:test";

import { collectH3RefLinks, h3RefLinkPath } from "./canvas-h3-ref-links";
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

test("当前 Clip 的权威绑定从分镜图指向 H3，禁用绑定和旧引用不产生多余连线", () => {
    const storyboard = node({ id: "storyboard", type: "image", metadata: { storageKey: "shot.png" } });
    const duplicateMedia = node({ id: "duplicate", type: "image", metadata: { storageKey: "shot.png" } });
    const disabled = node({ id: "disabled", type: "image", metadata: { storageKey: "disabled.png" } });
    const h3 = node({
        id: "h3", type: "minimax-h3:video",
        metadata: { segments: [
            {
                id: "clip", referenceBindings: [
                    { sourceNodeId: "storyboard", storageKey: "shot.png", role: "storyboard", enabled: true },
                    { sourceNodeId: "disabled", storageKey: "disabled.png", role: "storyboard", enabled: false },
                ],
                refItems: [{ nodeId: "duplicate", storageKey: "shot.png", role: "storyboard" }],
            },
            { id: "clip-2", referenceBindings: [{ sourceNodeId: "duplicate", storageKey: "shot.png", role: "storyboard", enabled: true }] },
        ] } as unknown as CanvasNodeData["metadata"],
    });

    const nodes = [duplicateMedia, storyboard, disabled, h3];
    assert.deepEqual(collectH3RefLinks(nodes, () => "clip").map((link) => [link.from.id, link.to.id]), [["storyboard", "h3"]]);
    assert.deepEqual(collectH3RefLinks(nodes, () => "clip-2").map((link) => [link.from.id, link.to.id]), [["duplicate", "h3"]]);
});

test("分镜图位于 H3 下方时，引用线从图片顶部进入 H3 底部", () => {
    const storyboard = node({ id: "storyboard", type: "image", position: { x: 50, y: 300 }, width: 100, height: 100 });
    const h3 = node({ id: "h3", type: "minimax-h3:video", position: { x: 0, y: 0 }, width: 200, height: 200 });
    assert.equal(h3RefLinkPath(storyboard, h3), "M 100 300 C 100 250, 100 250, 100 200");
});
