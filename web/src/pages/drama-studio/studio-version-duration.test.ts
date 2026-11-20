import test from "node:test";
import assert from "node:assert/strict";
import { deriveSegmentVersionDuration, shotsDurationSecOf } from "./studio-version-duration";

test("段视频版本时长：成片媒体时长优先 8000ms -> 8.0 秒", () => {
    assert.deepEqual(deriveSegmentVersionDuration(8000, 8), { durationSec: 8, durationSource: "media-file" });
});

test("段视频版本时长：无成片时回退镜头帧数汇总", () => {
    assert.deepEqual(deriveSegmentVersionDuration(undefined, 4), { durationSec: 4, durationSource: "shots-frames" });
});

test("段视频版本时长：两种真值都缺失时为 null，绝不编造", () => {
    assert.deepEqual(deriveSegmentVersionDuration(0, null), { durationSec: null, durationSource: null });
    assert.deepEqual(deriveSegmentVersionDuration("不是时长", -1), { durationSec: null, durationSource: null });
});

test("片段镜头帧数按 fps_num/fps_den 汇总，只算指定段", () => {
    const source = {
        fps_num: 24, fps_den: 1,
        shots: [
            { id: "a", duration_frames: 72 },
            { id: "b", duration_frames: 96 },
            { id: "c", duration_frames: 24 },
        ],
    };
    assert.equal(shotsDurationSecOf(source, ["a", "b"]), 7);
    assert.equal(shotsDurationSecOf(source, ["c"]), 1);
    assert.equal(shotsDurationSecOf(source, []), null);
    assert.equal(shotsDurationSecOf(null, ["a"]), null);
});
