import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compareVersionSnapshots, stableStringify, summarizeVersionSnapshot, type VersionSnapshotInput } from "./production-version-compare.js";

type FixtureVersion = { version: number; stage: string; createdAt: string; snapshotJson: string };
const fixture = JSON.parse(readFileSync(new URL("../server/fixtures/version-compare-real.json", import.meta.url), "utf8")) as {
    episodeId: string;
    versions: FixtureVersion[];
};
const real = new Map<number, FixtureVersion>(fixture.versions.map((item) => [item.version, item]));
const input = (version: number): VersionSnapshotInput => {
    const item = real.get(version)!;
    return { version: item.version, stage: item.stage, createdAt: item.createdAt, snapshot: JSON.parse(item.snapshotJson) };
};

test("真实快照摘要：镜头/段/提示词/成片 storageKey 均从 snapshot_json 派生", () => {
    const v1 = summarizeVersionSnapshot(input(1).snapshot);
    const v2 = summarizeVersionSnapshot(input(2).snapshot);
    const v3 = summarizeVersionSnapshot(input(3).snapshot);
    assert.deepEqual(
        [v1.format, v1.shotCount, v1.segmentCount, v1.h3ClipCount, v1.promptCount, v1.finalStorageKey],
        ["v2-director", 9, 4, 0, 0, null],
    );
    assert.deepEqual([v2.h3ClipCount, v2.promptCount, v2.finalStorageKey], [4, 4, null]);
    assert.deepEqual([v3.segmentCount, v3.h3ClipCount, v3.promptCount], [3, 4, 4]);
    assert.equal(v3.finalStorageKey, "video:721ddc9f-0ee0-487c-ace6-a62540119a65");
    assert.ok(v1.shotIds.includes("shot-13kvir9ypa6y"));
    assert.ok(v3.segmentIds.includes("clip-13py4o7f6f2s"));
});

test("真实快照对比 v1→v2：成片 clip 与提示词新增，精确数值来自快照", () => {
    const diff = compareVersionSnapshots(fixture.episodeId, input(1), input(2));
    assert.equal(diff.changed, true);
    assert.deepEqual(
        [diff.dimensions.h3Clips.from, diff.dimensions.h3Clips.to, diff.dimensions.h3Clips.delta],
        [0, 4, 4],
    );
    assert.deepEqual([diff.dimensions.prompts.from, diff.dimensions.prompts.to], [0, 4]);
    assert.equal(diff.prompts.added.length, 4);
    assert.equal(diff.prompts.changed.length, 0);
    assert.equal(diff.shots.added.length, 0);
    assert.equal(diff.shots.removed.length, 0);
    assert.equal(diff.segments.changed.length, 4);
    assert.equal(diff.dimensions.finalStorageKey.changed, false);
});

test("真实快照对比 v2→v3：段数减少、段 ID 增删、成片 storageKey 变化", () => {
    const diff = compareVersionSnapshots(fixture.episodeId, input(2), input(3));
    assert.equal(diff.changed, true);
    assert.deepEqual(
        [diff.dimensions.segments.from, diff.dimensions.segments.to, diff.dimensions.segments.delta],
        [4, 3, -1],
    );
    assert.deepEqual(diff.segments.added, ["clip-13py4o7f6f2s", "clip-1c02blfa11th", "clip-1sud71iaowbj"]);
    assert.equal(diff.segments.removed.length, 4);
    assert.equal(diff.dimensions.promptsHash.changed, false, "两版提示词集合完全相同，指纹不应变化");
    assert.deepEqual(
        [diff.dimensions.finalStorageKey.from, diff.dimensions.finalStorageKey.to, diff.dimensions.finalStorageKey.changed],
        [null, "video:721ddc9f-0ee0-487c-ace6-a62540119a65", true],
    );
});

test("相同版本：空 diff", () => {
    for (const version of [1, 2, 3]) {
        const diff = compareVersionSnapshots(fixture.episodeId, input(version), input(version));
        assert.equal(diff.changed, false);
        for (const dimension of Object.values(diff.dimensions)) assert.equal(dimension.changed, false);
        assert.deepEqual(diff.shots, { added: [], removed: [], changed: [] });
        assert.deepEqual(diff.segments, { added: [], removed: [], changed: [] });
        assert.deepEqual(diff.prompts, { added: [], removed: [], changed: [] });
    }
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test("合成边界：旧版顶层数组回退、镜头增删、提示词改动、关键帧计数", () => {
    const base = {
        scenes: [{ id: "SC1" }],
        shots: [{ id: "SH1", visual: "old" }, { id: "SH2", visual: "keep" }],
        keyframes: { SH1: { nodeId: "n1", storageKey: "image:1", sourceVersion: 1 } },
        director: { artifacts: [{ id: "img-1", kind: "image", prompt: "prompt-a" }] },
    };
    const next = {
        scenes: [{ id: "SC1" }],
        shots: [{ id: "SH1", visual: "new" }, { id: "SH3", visual: "added" }],
        keyframes: { SH1: { nodeId: "n1", storageKey: "image:2", sourceVersion: 2 } },
        director: { artifacts: [{ id: "img-1", kind: "image", prompt: "prompt-b" }] },
    };
    const from: VersionSnapshotInput = { version: 1, stage: "shots", createdAt: "t1", snapshot: base };
    const to: VersionSnapshotInput = { version: 2, stage: "shots", createdAt: "t2", snapshot: next };
    const summary = summarizeVersionSnapshot(base);
    assert.equal(summary.format, "legacy");
    assert.deepEqual([summary.shotCount, summary.sceneCount, summary.keyframeCount], [2, 1, 1]);
    assert.equal(summary.finalStorageKey, null, "快照没写 finalResource 时必须是 null，不能编造");
    const diff = compareVersionSnapshots("ep-test", from, to);
    assert.deepEqual(diff.shots.added, ["SH3"]);
    assert.deepEqual(diff.shots.removed, ["SH2"]);
    assert.equal(diff.shots.changed.length, 1);
    assert.ok(diff.shots.changed[0].fields.some((field) => field.field === "visual"));
    assert.equal(diff.prompts.changed.length, 1);
    assert.ok(diff.prompts.changed[0].fromHash !== diff.prompts.changed[0].toHash);
    assert.equal(diff.dimensions.keyframes.changed, false, "数量未变即为不变，storageKey 变化不属于计数维度");
});

test("时长真值口径：无成片时按 shots duration_frames / fps 汇总", () => {
    const v1 = summarizeVersionSnapshot(input(1).snapshot);
    const v2 = summarizeVersionSnapshot(input(2).snapshot);
    // 真数据：9 镜头 × 72 帧，fps_num=24/fps_den=1 → 27 秒；两版都没有 finalResource.storageKey。
    assert.deepEqual([v1.durationSec, v1.durationSource, v1.shotsDurationSec], [27, "shots-frames", 27]);
    assert.deepEqual([v2.durationSec, v2.durationSource], [27, "shots-frames"]);
});

test("时长真值口径：有成片时优先 media_files.duration_ms，并保留 shots 汇总供对照", () => {
    const FINAL_KEY = "video:721ddc9f-0ee0-487c-ace6-a62540119a65";
    // 真库实测该 storageKey 对应 duration_ms=26375（成片 26.375 秒），而镜头汇总 27 秒。
    const lookup = (key: string) => key === FINAL_KEY ? 26375 : null;
    const v3 = summarizeVersionSnapshot(input(3).snapshot, lookup);
    assert.deepEqual([v3.durationSec, v3.durationSource, v3.shotsDurationSec], [26.375, "media-file", 27]);
    // 查不到媒体真值时诚实地回退到镜头汇总，不编造成片时长。
    assert.deepEqual(
        [summarizeVersionSnapshot(input(3).snapshot, () => null).durationSource],
        ["shots-frames"],
    );
    const diff = compareVersionSnapshots(fixture.episodeId,
        { ...input(2), lookupMediaDurationMs: lookup },
        { ...input(3), lookupMediaDurationMs: lookup });
    assert.deepEqual(
        [diff.dimensions.durationSec.from, diff.dimensions.durationSec.to, diff.dimensions.durationSec.delta, diff.dimensions.durationSec.changed],
        [27, 26.375, -0.625, true],
    );
});

test("合成边界：无帧数、无成片 linkage 时时长为 null，不猜测", () => {
    const summary = summarizeVersionSnapshot({ shots: [{ id: "s1" }], director: { workflow: { finalResource: { storageKey: "video:missing" } } } }, () => null);
    assert.deepEqual([summary.durationSec, summary.durationSource, summary.shotsDurationSec], [null, null, null]);
});
