import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectorClipStoryboardOperation, createProductionEditing, registerProductionPromptEditor, registerProductionStoryboardEditor, sourceSegmentForCanvasClip } from "./production-editing";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { CanvasNodeData } from "@/types/canvas";
const input = { nodeId: "H3", segmentId: "canvas-clip", prompt: "A changed action.", artifactId: "ART", sourceHash: "source", basePromptHash: "prompt" };
const node = (): CanvasNodeData => ({ id: "H3", type: "minimax-h3:video", title: "H3", position: { x: 0, y: 0 }, width: 500, height: 400,
    metadata: { segments: [{ id: "canvas-clip", productionClipProjection: { targetId: "SOURCE_C4", promptAssemblyVersion: 2, artifactId: "ART", sourceHash: "source", promptHash: "prompt" } }] } });
const formalDirector = (): DirectorProduction => ({
    source: {
        fps_num: 24, fps_den: 1, asset_plan: [{ asset_id: "FRAME", kind: "keyframe" }],
        segments: [{ id: "SOURCE_C4", start_frame: 0, end_frame: 24, shot_ids: ["s1", "s2"] }],
        shots: [
            { id: "s1", source_scene_id: "SC1", timeline_id: "TL1", story_order: 0, start_frame: 0, end_frame: 12, title: "One" },
            { id: "s2", source_scene_id: "SC1", timeline_id: "TL1", story_order: 1, start_frame: 12, end_frame: 24, title: "Two" },
        ],
    },
    assets: { FRAME: { nodeId: "FRAME_NODE", storageKey: "frame.png", version: "v1", status: "generated" } },
    shotInputs: { s1: { keyframePolicy: "none", assetIds: [] }, s2: { keyframePolicy: "none", assetIds: [] } },
} as unknown as DirectorProduction);
const formalV2Director = (): DirectorProduction => ({
    source: {
        prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, scene_registry: [], script_scenes: [], asset_plan: [],
        segments: [{ id: "SOURCE_V2", shot_ids: ["v2a", "v2b"], mode: "Ref2VA" }],
        shots: [
            { id: "v2a", timeline_id: "TL", story_order: 0, duration_frames: 24, subject_usages: [], keyframes: [], utterance_refs: [] },
            { id: "v2b", timeline_id: "TL", story_order: 1, duration_frames: 24, subject_usages: [], keyframes: [], utterance_refs: [] },
        ],
    }, assets: {}, shotInputs: { v2a: { keyframePolicy: "none", assetIds: [] }, v2b: { keyframePolicy: "none", assetIds: [] } },
} as unknown as DirectorProduction);
test("SDK reverse synchronization awaits canvas persistence and receives an explicit editor receipt", async () => {
    const order: string[] = [], current = node();
    const remove = registerProductionPromptEditor("canvas", async request => { order.push("edit"); assert.deepEqual(request, input); return { sourceSaved: true }; });
    try {
        const service = createProductionEditing("canvas", () => current, async () => { order.push("flush"); });
        assert.deepEqual(await service.reverseSyncPrompt(input), { sourceSaved: true });
        assert.deepEqual(order, ["flush", "edit"]);
    } finally { remove(); }
});
test("missing editors and changed compiled identities fail visibly without a source write", async () => {
    const current = node(), service = createProductionEditing("missing", () => current, async () => {});
    await assert.rejects(service.reverseSyncPrompt(input), /PRODUCTION_EDITOR_NOT_READY/);
    await assert.rejects(service.reverseSyncPrompt({ ...input, basePromptHash: "stale" }), /PROMPT_REVERSE_SYNC_BASELINE_MISMATCH/);
});
test("production storyboard writeback routes only a verified formal Clip and waits for the source editor", async () => {
    const order: string[] = [];
    // replaceStoryboardTrack 会用从 Backend 校验过的完整 projection 覆盖调用方携带的摘要。
    const request = { nodeId: "H3", segmentId: "canvas-clip", segment: { id: "canvas-clip", productionClipProjection: node().metadata!.segments![0].productionClipProjection }, storyboardShots: [{ id: "s1", duration: 1 }] };
    const remove = registerProductionStoryboardEditor("canvas", async input => { order.push("edit"); assert.deepEqual(input, request); return { sourceSaved: true }; });
    try {
        const service = createProductionEditing("canvas", () => node(), async () => { order.push("flush"); });
        assert.deepEqual(await service.replaceStoryboardTrack(request), { sourceSaved: true });
        assert.deepEqual(order, ["flush", "edit"]);
        await assert.rejects(service.replaceStoryboardTrack({ ...request, segment: { ...request.segment, productionClipProjection: { targetId: "OTHER" } } }), /PROJECTION_MISMATCH/);
    } finally { remove(); }
});

test("H3 storyboard reordering, timing, new slots, and adopted images compile into formal Shot edits", () => {
    const operation = buildDirectorClipStoryboardOperation(formalDirector(), "SOURCE_C4", {
        nodeId: "H3", segmentId: "canvas-clip", segment: {
            id: "canvas-clip", productionClipProjection: { targetId: "SOURCE_C4" },
            storyboardShots: [{ id: "s2", duration: 0.5, referenceBindingId: "frame-binding" }, { id: "s3", duration: 0.5 }],
            referenceBindings: [{ id: "frame-binding", mediaType: "image", role: "storyboard", storageKey: "frame.png", sourceNodeId: "FRAME_NODE" }],
        },
    });
    assert.equal(operation.type, "replace_director_clip_storyboard");
    if (operation.type !== "replace_director_clip_storyboard") return;
    assert.deepEqual(operation.segment.shot_ids, ["s2", "s3"]);
    assert.deepEqual(operation.shots.map(shot => [shot.id, shot.start_frame, shot.end_frame, shot.story_order]), [["s2", 0, 12, 0], ["s3", 12, 24, 1]]);
    assert.equal((operation.shotInputs.s2 as any).keyframeAssetId, "FRAME");
    assert.deepEqual(operation.shotInputs.s3, { keyframePolicy: "none", assetIds: [] });
});

test("H3 storyboard writeback preserves Prompt v2 duration_frames without inventing legacy frame windows", () => {
    const operation = buildDirectorClipStoryboardOperation(formalV2Director(), "SOURCE_V2", {
        nodeId: "H3", segmentId: "canvas-clip", segment: {
            id: "canvas-clip", productionClipProjection: { targetId: "SOURCE_V2" },
            storyboardShots: [{ id: "v2b", duration: 0.5 }, { id: "v2c", duration: 1.5 }], referenceBindings: [],
        },
    });
    if (operation.type !== "replace_director_clip_storyboard") throw new Error("wrong operation");
    assert.deepEqual(operation.shots.map(shot => [shot.id, shot.duration_frames, shot.story_order, shot.start_frame, shot.end_frame]), [["v2b", 12, 0, undefined, undefined], ["v2c", 36, 1, undefined, undefined]]);
    assert.deepEqual(operation.segment.shot_ids, ["v2b", "v2c"]);
});

test("H3 storyboard writeback rescales Subject appearance ranges when a rebuilt Shot changes duration", () => {
    // 画布拆分镜头后 SH-01-03 由 96 帧缩到 48 帧；克隆来的出现范围 (0,96) 必须缩放，否则
    // 「Subject 出现范围必须位于 Shot 时长内且起止递增」校验会让整个 Clip 的分镜/参考回写 400。
    const director = formalV2Director();
    (director.source as Record<string, any>).asset_plan = [{ asset_id: "FRAME", kind: "keyframe" }];
    (director as Record<string, any>).assets = { FRAME: { nodeId: "FRAME_NODE", storageKey: "k.png", version: "v1", status: "generated" } };
    (director.source as Record<string, any>).shots = [
        { id: "v2a", timeline_id: "TL", story_order: 0, duration_frames: 96, subject_usages: [{ subjectId: "SUB:1", localStartFrame: 0, localEndFrame: 96 }], keyframes: [{ id: "KF:v2a:1", localFrame: 48 }, { id: "KF:v2a:2", localFrame: 96 }], utterance_refs: [] },
        { id: "v2b", timeline_id: "TL", story_order: 1, duration_frames: 24, subject_usages: [{ subjectId: "SUB:1", localStartFrame: 12, localEndFrame: 20 }], keyframes: [], utterance_refs: [] },
    ];
    const operation = buildDirectorClipStoryboardOperation(director, "SOURCE_V2", {
        nodeId: "H3", segmentId: "canvas-clip", segment: {
            id: "canvas-clip", productionClipProjection: { targetId: "SOURCE_V2" },
            storyboardShots: [{ id: "v2a", duration: 3, referenceBindingId: "kb" }, { id: "v2b", duration: 2 }],
            referenceBindings: [{ id: "kb", mediaType: "image", role: "storyboard", storageKey: "k.png", sourceNodeId: "FRAME_NODE" }],
        },
    });
    if (operation.type !== "replace_director_clip_storyboard") throw new Error("wrong operation");
    const [shotA, shotB] = operation.shots;
    const typedShotA = shotA as any, typedShotB = shotB as any;
    assert.equal(shotA.duration_frames, 72);
    assert.deepEqual(typedShotA.subject_usages[0].localStartFrame, 0);
    assert.deepEqual(typedShotA.subject_usages[0].localEndFrame, 72);
    // 关键帧同步缩放且必须小于新时长（48→36，96→71 贴边收敛）
    assert.deepEqual(typedShotA.keyframes.map((keyframe: any) => keyframe.localFrame), [36, 71]);
    // v2b 时长 24→48 帧同样翻倍：出现范围按比例缩放 (12,20)→(24,40)
    assert.deepEqual(typedShotB.subject_usages[0], { subjectId: "SUB:1", localStartFrame: 24, localEndFrame: 40 });
});

test("a production Clip cannot lose its final formal Shot or silently claim an unadopted H3 image", () => {
    const base = { nodeId: "H3", segmentId: "canvas-clip", segment: { id: "canvas-clip", productionClipProjection: { targetId: "SOURCE_C4" }, referenceBindings: [] } };
    assert.throws(() => buildDirectorClipStoryboardOperation(formalDirector(), "SOURCE_C4", { ...base, segment: { ...base.segment, storyboardShots: [] } }), /SHOT_LAST_IN_CLIP/);
    assert.throws(() => buildDirectorClipStoryboardOperation(formalDirector(), "SOURCE_C4", { ...base, segment: {
        ...base.segment, storyboardShots: [{ id: "s1", duration: 1, referenceBindingId: "unadopted" }],
        referenceBindings: [{ id: "unadopted", mediaType: "image", role: "storyboard", storageKey: "unknown.png", sourceNodeId: "UNKNOWN" }],
    } }), /STORYBOARD_ASSET_NOT_ADOPTED/);
});

test("an old editor cleanup cannot unregister a newer owner binding", async () => {
    const older = registerProductionPromptEditor("replacement", async () => ({ sourceSaved: false }));
    const newer = registerProductionPromptEditor("replacement", async () => ({ sourceSaved: true }));
    older();
    try { assert.equal((await createProductionEditing("replacement", () => node(), async () => {}).reverseSyncPrompt(input)).sourceSaved, true); }
    finally { newer(); }
});
test("canvas node and physical Clip identity resolve to the authoritative source Segment ID", () => {
    const source = { segments: [{ id: "SOURCE_C4", shot_ids: ["S1"] }] };
    const node = { id: "H3", metadata: { segments: [{ id: "canvas-clip", productionClipProjection: { targetId: "SOURCE_C4" } }] } };
    assert.equal(sourceSegmentForCanvasClip([node], source, "H3", "canvas-clip"), "SOURCE_C4");
    assert.throws(() => sourceSegmentForCanvasClip([{ ...node, id: "OTHER" }], source, "H3", "canvas-clip"), /TARGET_MISMATCH/);
});
