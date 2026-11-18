import assert from "node:assert/strict";
import test from "node:test";

import { packClipsFromProject } from "./director-pack-canvas";

const imageNode = (id: string, storageKey: string) => ({ id, type: "image", metadata: { storageKey } });
const binding = (id: string, order: number, extra: Record<string, unknown> = {}) => ({
    id: `binding-${id}`, assetId: `asset-${id}`, role: "character_identity", enabled: true, usage: "reference",
    mediaType: "image", storageKey: `image:${id}`, sourceNodeId: `n-${id}`, order, ...extra,
});

const clipSegment = (input: { id: string; targetId: string; prompt: string; bindings: Array<Record<string, unknown>>; referenceOrder?: string[] }) => ({
    id: input.id,
    prompt: input.prompt,
    taskMode: "ref2va",
    referenceBindings: input.bindings,
    ...(input.referenceOrder ? { referenceOrder: input.referenceOrder } : {}),
    productionClipProjection: { targetId: input.targetId },
});

test("画布 H3 段 → 制作稿 Clip 的视频提示词，参考图按提交顺序排 <Picture N>", () => {
    const project = {
        nodes: [
            imageNode("n-a", "image:a"),
            imageNode("n-b", "image:b"),
            { id: "h3", type: "minimax-h3:video", metadata: { segments: [clipSegment({
                id: "seg-1", targetId: "CLIP-1", prompt: "  subject_definitions: <Picture 1> 是场景；<Picture 2> 是主角  ",
                bindings: [binding("a", 0), binding("b", 1)],
                // 提交顺序由 referenceOrder 决定：b 在 a 前，图片就按 b、a 编号。
                referenceOrder: ["binding-b", "binding-a"],
            })] } },
        ],
        connections: [],
        referenceCatalog: [],
    };
    const clip = packClipsFromProject(project as unknown as Record<string, unknown>).get("CLIP-1");
    assert.ok(clip);
    assert.equal(clip.prompt, "subject_definitions: <Picture 1> 是场景；<Picture 2> 是主角");
    assert.deepEqual(clip.images.map((image) => image.storageKey), ["image:b", "image:a"]);
    assert.deepEqual(clip.images.map((image) => image.ordinal), [1, 2]);
});

test("同一 Clip 的多个投影：空稿不覆盖有提示词的那一份", () => {
    const project = {
        nodes: [
            imageNode("n-a", "image:a"),
            { id: "h3-a", type: "minimax-h3:video", metadata: { segments: [clipSegment({ id: "seg-a", targetId: "CLIP-1", prompt: "真实视频提示词", bindings: [binding("a", 0)] })] } },
            { id: "h3-b", type: "minimax-h3:video", metadata: { segments: [clipSegment({ id: "seg-b", targetId: "CLIP-1", prompt: "   ", bindings: [binding("a", 0)] })] } },
        ],
        connections: [],
        referenceCatalog: [],
    };
    const clip = packClipsFromProject(project as unknown as Record<string, unknown>).get("CLIP-1");
    assert.equal(clip?.prompt, "真实视频提示词");
    assert.equal(clip?.segmentId, "seg-a");
});

test("没有正式制作投影的 H3 段不进包", () => {
    const project = {
        nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "loose", prompt: "自由创作", referenceBindings: [] }] } }],
        connections: [],
        referenceCatalog: [],
    };
    assert.equal(packClipsFromProject(project as unknown as Record<string, unknown>).size, 0);
});

test("段上的图片保留重复（同一个文件占多个 <Picture N>），不擅自合并", () => {
    const project = {
        nodes: [
            imageNode("n-a", "image:a"),
            { id: "h3", type: "minimax-h3:video", metadata: { segments: [clipSegment({
                id: "seg-1", targetId: "CLIP-1", prompt: "两处都提到同一张图",
                bindings: [binding("a", 0, { subjectId: "SUB-1" }), binding("a2", 1, { subjectId: "SUB-2" })],
                referenceOrder: ["binding-a", "binding-a2"],
            })] } },
        ],
        connections: [],
        referenceCatalog: [],
    };
    // 两个绑定共用一个 sourceNodeId/图片文件，但编号必须各占一格。
    const clip = packClipsFromProject(project as unknown as Record<string, unknown>).get("CLIP-1");
    assert.equal(clip?.images.length, 2);
    assert.deepEqual(clip?.images.map((image) => image.ordinal), [1, 2]);
});
