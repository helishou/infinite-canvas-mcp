import assert from "node:assert/strict";
import test from "node:test";
import { applyStoryboardTracks, deriveStoryboardTrack, derivedStoryboardTracks } from "./storyboard-track.js";

const production = (keyframes: Record<string, unknown[]>, assets: Record<string, unknown>) => ({
    director: {
        assets, shotInputs: {},
        source: {
            version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 }, fps_num: 24, fps_den: 1,
            shots: [{ id: "S1", duration_frames: 48, keyframes: keyframes.S1 || [] },
                { id: "S2", duration_frames: 24, keyframes: keyframes.S2 || [] }],
            segments: [{ id: "CLIP", shot_ids: ["S1", "S2"] }],
        },
    },
    clipGroups: [{ id: "CLIP", shotIds: ["S1", "S2"], nodeId: "H3", segmentId: "clip-1" }],
}) as any;

const opening = (assetId: string, nodeId: string) =>
    ({ id: `KF:${nodeId}`, assetId, anchor: "opening", requiredForSubmission: true, sourceNode: { nodeId } });

test("the storyboard track is derived from the authored Shot keyframes, not from the canvas copy", () => {
    const data = production({ S1: [opening("FRAME", "NEW-NODE")] }, { FRAME: { storageKey: "image:new", nodeId: "NEW-NODE" } });
    // 画布上还停在旧图、甚至引用了不存在的 binding：读取时必须被 owner 覆盖。
    const stale = { id: "clip-1", productionClipProjection: { targetId: "CLIP" }, storyboardModeEnabled: true,
        storyboardShots: [{ id: "S1", duration: 2, referenceBindingId: "old-slot" }, { id: "S2", duration: 1 }],
        referenceBindings: [{ id: "old-slot", role: "storyboard", mediaType: "image", storageKey: "image:old", sourceNodeId: "OLD-NODE" },
            { id: "scene", role: "scene", mediaType: "image", storageKey: "image:scene" }] };
    const track = deriveStoryboardTrack(data, { shotIds: ["S1", "S2"] }, stale)!;
    assert.deepEqual(track.storyboardShots, [{ id: "S1", duration: 2, referenceBindingId: "old-slot" }, { id: "S2", duration: 1 }]);
    assert.equal(track.duration, 3);
    const slot = track.referenceBindings.find(binding => binding.id === "old-slot")!;
    assert.equal(slot.storageKey, "image:new");
    assert.equal(slot.sourceNodeId, "NEW-NODE");
    assert.equal(slot.role, "storyboard");
    assert.deepEqual(track.referenceBindings.find(binding => binding.id === "scene")?.storageKey, "image:scene",
        "non-storyboard references survive the derivation");
    assert.equal(track.referenceBindings.filter(binding => binding.role === "storyboard").length, 1,
        "the replaced slot must not leave the old storyboard image behind");
});

test("a brand-new keyframe reaches the slot without ever being registered in the canvas catalog", () => {
    const data = production({ S1: [opening("FRAME-NEW", "NODE-A")] }, { "FRAME-NEW": { storageKey: "image:fresh", nodeId: "NODE-A" } });
    const track = deriveStoryboardTrack(data, { shotIds: ["S1", "S2"] }, { storyboardShots: [{ id: "S1", duration: 2 }, { id: "S2", duration: 1 }] })!;
    assert.equal(track.storyboardShots[0].referenceBindingId, "storyboard:FRAME-NEW");
    assert.equal(track.referenceBindings[0].storageKey, "image:fresh");
});

test("clearing the Shot keyframe empties the slot and drops its storyboard reference", () => {
    const data = production({}, {});
    const track = deriveStoryboardTrack(data, { shotIds: ["S1", "S2"] },
        { storyboardShots: [{ id: "S1", duration: 2, referenceBindingId: "slot" }, { id: "S2", duration: 1 }],
            referenceBindings: [{ id: "slot", role: "storyboard", mediaType: "image", storageKey: "image:old" }] })!;
    assert.equal(track.storyboardShots[0].referenceBindingId, undefined);
    assert.deepEqual(track.referenceBindings, []);
});

test("legacy shotInputs keyframes stay projectable and manual segments are left alone", () => {
    const data = {
        director: { assets: { OLD: { storageKey: "image:legacy", nodeId: "N" } },
            shotInputs: { S1: { keyframePolicy: "reuse", keyframeAssetId: "OLD" } },
            source: { fps_num: 24, fps_den: 1, shots: [{ id: "S1", start_frame: 0, end_frame: 48 }], segments: [{ id: "CLIP", shot_ids: ["S1"] }] } },
        clipGroups: [{ id: "CLIP", shotIds: ["S1"], nodeId: "H3", segmentId: "clip-1" }],
    } as any;
    const track = deriveStoryboardTrack(data, { shotIds: ["S1"] }, { storyboardShots: [{ id: "S1", duration: 2, referenceBindingId: "slot" }] })!;
    assert.equal(track.storyboardShots[0].duration, 2);
    assert.equal(track.storyboardShots[0].referenceBindingId, "slot");
    assert.equal(track.referenceBindings[0].storageKey, "image:legacy");

    const project = { nodes: [{ id: "H3", metadata: { segments: [
        { id: "clip-1", productionClipProjection: { targetId: "CLIP" }, storyboardShots: [] },
        { id: "manual", storyboardShots: [{ id: "X", duration: 3 }] },
    ] } }] };
    const tracks = derivedStoryboardTracks(data, project.nodes[0].metadata!.segments as any);
    assert.deepEqual(Object.keys(tracks), ["clip-1"]);
    const changed = applyStoryboardTracks(project as any, tracks);
    assert.deepEqual(changed, ["clip-1"]);
    // 画布该段没存过绑定 → 派生用 assetId 生成稳定 id
    assert.equal(project.nodes[0].metadata.segments[0].storyboardShots[0].referenceBindingId, "storyboard:OLD");
    assert.deepEqual(project.nodes[0].metadata.segments[1].storyboardShots, [{ id: "X", duration: 3 }]);
});

test("a Clip whose shots or assets cannot be resolved keeps whatever the canvas already has", () => {
    const data = production({}, {});
    assert.equal(deriveStoryboardTrack(data, { shotIds: ["S1", "MISSING"] }, {}), undefined);
});

test("a draft row without clipGroups still derives from the Segment's own shot membership", () => {
    // 生产草稿行不存 clipGroups（读取时由画布反推），派生不能因此失效。
    const data = production({ S1: [opening("FRAME", "N")] }, { FRAME: { storageKey: "image:new", nodeId: "N" } });
    delete (data as any).clipGroups;
    const segments = [{ id: "clip-1", sourceShotId: "S1~S2", productionClipProjection: { targetId: "CLIP" }, storyboardShots: [], referenceBindings: [] }];
    const tracks = derivedStoryboardTracks(data, segments as any);
    assert.deepEqual(Object.keys(tracks), ["clip-1"]);
    assert.equal(tracks["clip-1"].storyboardShots.length, 2);
    assert.equal(tracks["clip-1"].referenceBindings[0].storageKey, "image:new");
    assert.equal(derivedStoryboardTracks(data, [{ id: "manual", storyboardShots: [] }] as any)["manual"], undefined);
});
