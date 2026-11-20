import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isVideoMedia, JIANYING_ARCHIVE_MAX_BYTES, mediaReadable, planJianyingDraftPreview,
    type JianyingPreflightSegmentInput } from "./jianying-preflight.js";

const base = (): JianyingPreflightSegmentInput => ({
    id: "seg-1", title: "段一", shotIds: ["shot-1"], estimatedDurationMs: 5000,
    resultStorageKey: "media/out.mp4", stale: false,
    media: { storageKey: "media/out.mp4", filePath: "/never-read.mp4", mimeType: "video/mp4",
        bytes: 1024, durationMs: 5000, sha256: "abc" },
    readable: true,
});
const plan = (segments: JianyingPreflightSegmentInput[], extra: Record<string, unknown> = {}) =>
    planJianyingDraftPreview({ episodeId: "ep-1", sourceHash: "src", productionRevision: 3, segments, ...extra });

test("reason 决策树：每个 hard-stop 都得到影策同名 reason 且 included=false", () => {
    const cases: Array<[Partial<JianyingPreflightSegmentInput>, string]> = [
        [{ shotIds: [] }, "镜头信息缺失"],
        [{ resultStorageKey: "" }, "视频尚未就绪"],
        [{ ambiguousResult: true }, "视频尚未就绪"],
        [{ media: null }, "视频资源不可用"],
        [{ media: { ...base().media!, mimeType: "image/png" } }, "视频资源不可用"],
        [{ media: { ...base().media!, bytes: 0 } }, "视频资源不可用"],
        [{ media: { ...base().media!, durationMs: 0 }, estimatedDurationMs: 0 }, "视频时长未知或无效"],
        [{ media: { ...base().media!, durationMs: 25 * 60 * 60 * 1000 } }, "视频时长未知或无效"],
        [{ readable: false }, "视频文件暂不可读取，请检查存储或稍后重试"],
    ];
    for (const [patch, reason] of cases) {
        const preview = plan([{ ...base(), ...patch }]);
        assert.equal(preview.totalSegments, 1);
        assert.equal(preview.missingSegments, 1, reason);
        assert.equal(preview.availableSegments, 0, reason);
        assert.equal(preview.segments[0].included, false, reason);
        assert.equal(preview.segments[0].reason, reason);
        assert.equal(preview.durationMs, 0, reason);
        assert.equal(preview.mediaBytes, 0, reason);
    }
});

test("stale 是 available 的子集：可用且旧版本同时计入两栏，缺失段即使 stale 也不计入", () => {
    const good = base();
    const stale = { ...base(), id: "seg-2", stale: true };
    const missingStale = { ...base(), id: "seg-3", stale: true, resultStorageKey: "" };
    const preview = plan([good, stale, missingStale]);
    assert.equal(preview.availableSegments, 2);
    assert.equal(preview.missingSegments, 1);
    assert.equal(preview.staleSegments, 1);
    assert.equal(preview.totalSegments, 3);
    assert.equal(preview.segments[1].included, true);
    assert.equal(preview.segments[1].stale, true);
    assert.equal(preview.segments[2].included, false);
    assert.equal(preview.segments[2].stale, true);
    assert.equal(preview.durationMs, 10000);
    assert.equal(preview.mediaBytes, 2048);
    assert.ok(preview.warnings.some(w => w.includes("1 个剧情段使用修改前的视频")));
});

test("无实测时长回退到生成记录估时，并给出警告；库存时长优先", () => {
    const estimated = plan([{ ...base(), media: { ...base().media!, durationMs: null }, estimatedDurationMs: 7000 }]);
    assert.equal(estimated.segments[0].durationMs, 7000);
    assert.equal(estimated.segments[0].durationEstimated, true);
    assert.equal(estimated.availableSegments, 1);
    assert.ok(estimated.warnings.some(w => w.includes("未记录实测时长")));

    const measured = plan([{ ...base(), media: { ...base().media!, durationMs: 4200 }, estimatedDurationMs: 7000 }]);
    assert.equal(measured.segments[0].durationMs, 4200);
    assert.equal(measured.segments[0].durationEstimated, false);
});

test("revision 是交付内容指纹：同一输入稳定，媒体身份/分类变化即改变", () => {
    const a = plan([base()]);
    assert.equal(a.revision, plan([base()]).revision);
    assert.match(a.revision, /^[0-9a-f]{64}$/);
    const changedMedia = plan([{ ...base(), media: { ...base().media!, sha256: "different" } }]);
    assert.notEqual(a.revision, changedMedia.revision);
    const changedStale = plan([{ ...base(), stale: true }]);
    assert.notEqual(a.revision, changedStale.revision);
    const changedRoot = plan([base()], { draftRoot: "C:/ JianYing Draft" });
    assert.notEqual(a.revision, changedRoot.revision);
    const changedRevision = plan([base()], { productionRevision: 4 });
    assert.notEqual(a.revision, changedRevision.revision);
});

test("8GB 超限只记警告，不伪造可用段", () => {
    const preview = plan([{ ...base(), media: { ...base().media!, bytes: JIANYING_ARCHIVE_MAX_BYTES + 1 } }]);
    assert.equal(preview.availableSegments, 1);
    assert.ok(preview.warnings.some(w => w.includes("超过 8GB")));
});

test("isVideoMedia 不接受图片冒充视频，但允许通用 mime + 视频扩展名", () => {
    assert.equal(isVideoMedia({ mimeType: "video/mp4", storageKey: "x.bin" }), true);
    assert.equal(isVideoMedia({ mimeType: "image/png", storageKey: "x.mp4" }), false);
    assert.equal(isVideoMedia({ mimeType: "application/octet-stream", storageKey: "x.mp4?token=1" }), true);
    assert.equal(isVideoMedia({ mimeType: "", storageKey: "x.txt" }), false);
});

test("mediaReadable：stat 大小一致且首字节可读才算可读", t => {
    const dir = mkdtempSync(join(tmpdir(), "jianying-preflight-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "clip.mp4");
    writeFileSync(file, "video-bytes");
    assert.equal(mediaReadable(file, 11), true);
    assert.equal(mediaReadable(file, 12), false, "元数据大小与磁盘不符");
    assert.equal(mediaReadable(join(dir, "missing.mp4"), 11), false);
    writeFileSync(join(dir, "empty.mp4"), "");
    assert.equal(mediaReadable(join(dir, "empty.mp4"), 0), false, "空文件读不到首字节");
});

test("字幕条数只统计纳入段的台词 cue，且不带源稿时为 0", () => {
    const source = {
        version: 2, fps_num: 24, fps_den: 1, prompt_assembly: { version: 2 },
        ledger: { contract_version: 2, timelines: [{ id: "main", start_frame: 0 }] },
        utterances: [{ id: "u1", text: "你好", speakerName: "甲" }],
        shots: [
            { id: "shot-1", timeline_id: "main", duration_frames: 120,
                utterance_refs: [{ utteranceId: "u1", localStartFrame: 0, localEndFrame: 24 }] },
            { id: "shot-2", timeline_id: "main", duration_frames: 120,
                utterance_refs: [{ utteranceId: "u1", localStartFrame: 0, localEndFrame: 24 }] },
        ],
    };
    const withCaptions = plan([base()], { captions: true, source });
    assert.equal(withCaptions.captionCount, 1, "只有段一被纳入");
    const withoutCaptions = plan([base()], { source });
    assert.equal(withoutCaptions.captionCount, 0);
});
