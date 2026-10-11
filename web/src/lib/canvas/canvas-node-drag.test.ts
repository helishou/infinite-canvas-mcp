import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasNodeDragSelection, buildCanvasReferenceDragPayload, canvasNodeDragOffset, canvasNodeDragPreviewPositions, hasCanvasNodeDragMoved } from "./canvas-node-drag";

test("canvas drag offset converts screen movement into world movement at current zoom", () => {
    assert.deepEqual(canvasNodeDragOffset({ x: 100, y: 50 }, { x: 130, y: 80 }, 2), { x: 15, y: 15 });
});

test("canvas drag movement threshold is measured in screen pixels and remains strict", () => {
    assert.equal(hasCanvasNodeDragMoved({ x: 10, y: 10 }, { x: 13, y: 13 }), false);
    assert.equal(hasCanvasNodeDragMoved({ x: 10, y: 10 }, { x: 13.01, y: 10 }), true);
    assert.equal(hasCanvasNodeDragMoved({ x: 10, y: 10 }, { x: 10, y: 14 }), true);
});

test("canvas drag preview positions preserve initial positions and apply the same offset", () => {
    const initial = new Map([[
        "a", { x: 5, y: 7 },
    ], ["b", { x: -2, y: 4 }]]);

    assert.deepEqual(canvasNodeDragPreviewPositions(initial, { x: 12, y: -3 }), new Map([
        ["a", { x: 17, y: 4 }],
        ["b", { x: 10, y: 1 }],
    ]));
    assert.deepEqual(initial, new Map([["a", { x: 5, y: 7 }], ["b", { x: -2, y: 4 }]]));
});

const dragNode = (id: string, type: string, metadata: Record<string, unknown> = {}) => ({
    id,
    type,
    title: id,
    position: { x: 10, y: 20 },
    width: 100,
    height: 80,
    metadata,
}) as unknown as CanvasNodeData;

test("canvas drag selection expands ordinary group children and excludes locked drop targets", () => {
    const nodes = [
        dragNode("group", CanvasNodeType.Group),
        dragNode("member", CanvasNodeType.Text, { groupId: "group" }),
        dragNode("open-target", CanvasNodeType.Group),
        dragNode("locked-target", CanvasNodeType.Group, { groupLocked: true }),
    ];
    const selection = buildCanvasNodeDragSelection(nodes, new Set(["group"]));

    assert.deepEqual([...selection.movedIds], ["group", "member"]);
    assert.deepEqual([...selection.initialSelectedNodes.keys()], ["group", "member"]);
    assert.equal(selection.hasMovedGroup, true);
    assert.deepEqual(selection.movingNodes.map((node) => node.id), ["member"]);
    assert.deepEqual(selection.groupDropCandidates.map((node) => node.id), ["open-target"]);
});

test("canvas drag selection uses explicit ordered slots instead of legacy groupId membership", () => {
    const nodes = [
        dragNode("ordered", CanvasNodeType.Group, { orderedGroup: true, groupSlots: ["listed"] }),
        dragNode("listed", CanvasNodeType.Text, { groupId: "another-group" }),
        dragNode("legacy-child", CanvasNodeType.Text, { groupId: "ordered" }),
    ];
    const selection = buildCanvasNodeDragSelection(nodes, new Set(["ordered"]));

    assert.deepEqual([...selection.movedIds], ["ordered", "listed"]);
    assert.deepEqual([...selection.initialSelectedNodes.keys()], ["ordered", "listed"]);
});

test("canvas image reference drag payload keeps image-only and turnaround role semantics", () => {
    const turnaround = dragNode("四视图人物", CanvasNodeType.Image, {
        content: "  https://media.test/turnaround.png  ",
        storageKey: "turnaround-key",
        mimeType: "image/png",
    });
    assert.deepEqual(buildCanvasReferenceDragPayload(turnaround), {
        nodeId: "四视图人物",
        url: "https://media.test/turnaround.png",
        type: "image",
        name: "四视图人物",
        storageKey: "turnaround-key",
        mimeType: "image/png",
        role: "character_turnaround",
        subjectId: "四视图人物",
    });
    assert.equal(buildCanvasReferenceDragPayload(dragNode("storage-only", CanvasNodeType.Image, { storageKey: "only-key" })), undefined);
});

test("canvas character reference drag payload filters empty outfits and retains voice metadata", () => {
    const payload = buildCanvasReferenceDragPayload(dragNode("猫角色", CanvasNodeType.Character, {
        characterImages: [
            { url: "https://media.test/red.png", outfit: "红衣", storageKey: "red-key" },
            { url: "", name: "empty" },
            { url: "https://media.test/blue.png", name: "蓝衣" },
        ],
        characterPrimaryIndex: 1,
        characterVoiceUrl: "https://media.test/voice.wav",
        characterVoiceName: "小猫声线",
        characterVoiceDescription: "清亮",
        characterVoiceStorageKey: "voice-key",
        characterVoiceAssetId: "voice-asset",
    }));

    assert.equal(payload?.type, "character");
    if (payload?.type !== "character") assert.fail("expected a character drag payload");
    assert.deepEqual(payload.characterImages, [
        { url: "https://media.test/red.png", name: "红衣", storageKey: "red-key", mimeType: undefined },
        { url: "https://media.test/blue.png", name: "蓝衣", storageKey: undefined, mimeType: undefined },
    ]);
    assert.equal(payload.characterPrimaryIndex, 1);
    assert.equal(payload.characterVoiceStorageKey, "voice-key");
    assert.equal(payload.characterVoiceAssetId, "voice-asset");
});

test("canvas scene reference drag payload only exists when a scene image URL is present", () => {
    assert.deepEqual(buildCanvasReferenceDragPayload(dragNode("卧室场景", CanvasNodeType.Scene, {
        sceneImage: { url: "https://media.test/room.png", storageKey: "room-key", mimeType: "image/jpeg" },
    })), {
        nodeId: "卧室场景",
        url: "https://media.test/room.png",
        type: "image",
        name: "卧室场景",
        storageKey: "room-key",
        mimeType: "image/jpeg",
        role: "scene",
    });
    assert.equal(buildCanvasReferenceDragPayload(dragNode("empty-scene", CanvasNodeType.Scene, { sceneImage: { storageKey: "only-key" } })), undefined);
    assert.equal(buildCanvasReferenceDragPayload(dragNode("text", CanvasNodeType.Text)), undefined);
});
