import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { convertImageNodeToProp } from "./prop-node-conversion";

const imageNode = (patch: Partial<CanvasNodeData> = {}): CanvasNodeData => ({
    id: "image-1",
    type: CanvasNodeType.Image,
    title: "铜钥匙",
    position: { x: 123, y: 456 },
    width: 512,
    height: 288,
    metadata: {
        status: "success",
        prompt: "一把有磨损痕迹的铜钥匙",
        images: [{ id: "result-1", status: "success", content: "", storageKey: "media/key.png", naturalWidth: 1920, naturalHeight: 1080, bytes: 500, mimeType: "image/png" }],
        primaryImageId: "result-1",
        smart: true,
        generationMode: "image",
    },
    ...patch,
});

test("image-to-prop conversion retains node geometry and the original storage-backed image", () => {
    const converted = convertImageNodeToProp(imageNode());
    assert.ok(converted);
    assert.equal(converted.type, CanvasNodeType.Prop);
    assert.deepEqual(converted.position, { x: 123, y: 456 });
    assert.equal(converted.width, 512);
    assert.equal(converted.height, 288);
    assert.equal(converted.title, "铜钥匙");
    assert.equal(converted.metadata?.propName, "铜钥匙");
    assert.equal(converted.metadata?.propDescription, "一把有磨损痕迹的铜钥匙");
    assert.equal(converted.metadata?.propImage?.storageKey, "media/key.png");
    assert.equal(converted.metadata?.propImage?.width, 1920);
    assert.equal(converted.metadata?.propImage?.height, 1080);
    assert.equal(converted.metadata?.smart, undefined);
    assert.equal(converted.metadata?.generationMode, undefined);
    assert.equal(converted.metadata?.images, undefined);
});

test("conversion rejects non-image nodes and images without a usable image handle", () => {
    assert.equal(convertImageNodeToProp(imageNode({ type: CanvasNodeType.Video })), null);
    assert.equal(convertImageNodeToProp(imageNode({ metadata: { status: "success" } })), null);
});

test("smart image nodes can be converted without losing storage identity", () => {
    const node = imageNode({
        type: CanvasNodeType.Config,
        metadata: {
            status: "success",
            smart: true,
            generationMode: "image",
            images: [{ id: "result-2", status: "success", content: "", storageKey: "media/smart.png", naturalWidth: 800, naturalHeight: 600, bytes: 300, mimeType: "image/png" }],
            primaryImageId: "result-2",
        },
    });
    assert.equal(convertImageNodeToProp(node)?.metadata?.propImage?.storageKey, "media/smart.png");
});
