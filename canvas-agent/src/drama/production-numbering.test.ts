import test from "node:test";
import assert from "node:assert/strict";
import { productionNumbering, resolveProductionTarget } from "./production-numbering.js";
import { projectProductionRead } from "./production-read.js";
import { productionToolRequest } from "./production-tools.js";

const source = {
    fps_num: 24, fps_den: 1,
    shots: [{ id: "E2-S16", title: "停雨威胁", story_order: 1, duration_frames: 192 }, { id: "E2-S11", title: "病猪与卖粮的解释", story_order: 0, duration_frames: 132 }],
    segments: [{ id: "arbitrary-stable-id", shot_ids: ["E2-S11"] }, { id: "E2-CLIP-11", shot_ids: ["E2-S16"] }],
};

test("page ordinals resolve source order, never ID suffixes or raw Shot array positions", () => {
    const numbering = productionNumbering(source);
    assert.equal(numbering.clips[0].title, "病猪与卖粮的解释");
    assert.equal(numbering.clips[0].duration, 5.5);
    assert.deepEqual(numbering.clips[0].shots[0], { shotId: "E2-S11", shotNumber: 1, shotInClip: 1, title: "病猪与卖粮的解释", duration: 5.5 });
    assert.equal(resolveProductionTarget(source, "clip_workbench", { clipNumber: 1 }), "arbitrary-stable-id");
    assert.equal(resolveProductionTarget(source, "shot_workbench", { clipNumber: 1, shotInClip: 1 }), "E2-S11");
    assert.equal(resolveProductionTarget(source, "shot_workbench", { shotNumber: 2 }), "E2-S16");
    assert.equal(resolveProductionTarget(source, "clip_workbench", { targetId: "E2-CLIP-11" }), "E2-CLIP-11");
    for (const selector of [{ clipNumber: 0 }, { clipNumber: 99 }, { targetId: "E2-CLIP-11", clipNumber: 1 }, { clipNumber: 1, shotNumber: 1 }]) {
        assert.throws(() => resolveProductionTarget(source, "clip_workbench", selector), /TARGET_SELECTOR/);
    }
    assert.throws(() => resolveProductionTarget(source, "subject_workbench", { clipNumber: 1 }), /TARGET_SELECTOR/);
});

test("insertion renumbers display only and chunk headers identify Clip-local and whole-episode Shots", () => {
    const original = structuredClone(source);
    const inserted = { ...source, segments: [{ id: "new", shot_ids: [] }, ...source.segments] };
    assert.equal(resolveProductionTarget(inserted, "clip_workbench", { clipNumber: 2 }), "arbitrary-stable-id");
    assert.equal(resolveProductionTarget(inserted, "clip_workbench", { targetId: "arbitrary-stable-id" }), "arbitrary-stable-id");
    assert.deepEqual(source, original);
    const production = { episodeId: "ep", revision: 2, draft: { director: { source } }, shotWorkbench: { shot: source.shots[1] } };
    const read: any = projectProductionRead(production, { view: "shot_workbench", targetIds: ["E2-S11"] });
    assert.equal(read.numbering.shotNumber, 1);
    assert.deepEqual(read.numbering.memberships, [{ segmentId: "arbitrary-stable-id", clipNumber: 1, shotInClip: 1 }]);
});

test("existing tools expose paginated numbering and route ordinal selectors without fabricated IDs", () => {
    const request = productionToolRequest("production_get_workbench", { kind: "episode", id: "ep", view: "shot_workbench", clipNumber: 11, shotInClip: 1 });
    assert.match(request.path, /clipNumber=11&shotInClip=1/);
    assert.doesNotMatch(request.path, /targetIds/);
    assert.match(productionToolRequest("production_get", { kind: "episode", id: "ep", view: "numbering" }).path, /view=numbering&snapshot=draft&pageSize=20/);
    const production = { episodeId: "ep", revision: 2, draft: { director: { source } } };
    const first: any = projectProductionRead(production, { view: "numbering", pageSize: 1 });
    const second: any = projectProductionRead(production, { view: "numbering", pageSize: 1, cursor: first.numbering.nextCursor });
    assert.equal(first.numbering.items[0].segmentId, "arbitrary-stable-id");
    assert.equal(second.numbering.items[0].segmentId, "E2-CLIP-11");
    assert.equal(second.numbering.nextCursor, null);
    assert.throws(() => projectProductionRead({ ...production, revision: 3 }, { view: "numbering", pageSize: 1, cursor: first.numbering.nextCursor }), /READ_CURSOR_EXPIRED/);
});
