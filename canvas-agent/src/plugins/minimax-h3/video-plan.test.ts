import test from "node:test";
import assert from "node:assert/strict";

import { validateVideoPlan, type H3PlannedSegment } from "./video-plan.js";

const baseSegment: H3PlannedSegment = {
    id: "seg-1",
    sourceShotId: "shot-1",
    title: "test",
    duration: 1,
    taskMode: "r2v",
    subjects: [],
    openingState: "start",
    timeline: [{ start: 0, end: 1, action: "hold", camera: "static" }],
    endingState: "end",
    references: [],
};

test("视频计划不能直接携带角色组", () => {
    assert.throws(
        () => validateVideoPlan([{ ...baseSegment, h3CharacterGroups: {} } as H3PlannedSegment & { h3CharacterGroups: unknown }]),
        /不能直接携带角色组/,
    );
});

test("视频计划仍接受普通引用计划", () => {
    assert.doesNotThrow(() => validateVideoPlan([baseSegment]));
});

test("视频计划缺少稳定 id 或显式镜头 end 时指向具体字段", () => {
    assert.throws(() => validateVideoPlan([{ ...baseSegment, id: undefined, segmentId: "legacy" } as unknown as H3PlannedSegment]), /segments\[\]\.id.*segmentId/);
    assert.throws(() => validateVideoPlan([{ ...baseSegment, timeline: [{ start: 0, action: "hold", camera: "static" }] } as H3PlannedSegment]), /timeline\[0\]\.end/);
});
