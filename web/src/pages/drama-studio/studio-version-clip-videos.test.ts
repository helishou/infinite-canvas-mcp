import test from "node:test";
import assert from "node:assert/strict";
import { buildClipVideoRows, formatClipDuration, type ClipVideoRow } from "./studio-version-clip-videos";
import type { ClipVideoTruth, CompareClipVideoDiff } from "@/services/backend-api";

const clip = (clipId: string, storageKey: string, durationMs: number | null, title = clipId): ClipVideoTruth => ({
    clipId, segmentId: `seg-${clipId}`, title, storageKey, durationMs,
    source: "generation", generationLogId: `log-${clipId}`, status: "success",
});
const emptyDiff = (): CompareClipVideoDiff => ({ recordedFrom: false, recordedTo: false, fromCount: 0, toCount: 0, added: [], removed: [], changed: [] });

test("逐clip时长显示：真实毫秒换算秒；缺失如实标注，不推断", () => {
    assert.equal(formatClipDuration(3750), "3.75s");
    assert.equal(formatClipDuration(6583), "6.58s");
    assert.equal(formatClipDuration(null), "时长未归档");
});

test("逐clip行：旧版无记录时不按当前画布回填历史，标「仅新版有成片记录」", () => {
    const to = [clip("clip-a", "video:real-a", 3750, "入洞共度")];
    const rows = buildClipVideoRows([], to, { ...emptyDiff(), recordedTo: true, toCount: 1, added: ["clip-a"] }, to);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "仅新版有成片记录");
    assert.equal(rows[0].current?.storageKey, "video:real-a", "当前画布列仍显示实时真值");
    assert.equal(rows[0].from, undefined, "旧版本不伪造成片记录");
});

test("逐clip行：storageKey 更换与未更换分别标注", () => {
    const from = [clip("clip-a", "video:old", 3750), clip("clip-b", "video:same", 5875)];
    const to = [clip("clip-a", "video:new", 6583), clip("clip-b", "video:same", 5875)];
    const diff: CompareClipVideoDiff = {
        ...emptyDiff(), recordedFrom: true, recordedTo: true, fromCount: 2, toCount: 2,
        changed: [{ clipId: "clip-a", title: "clip-a", from: from[0], to: to[0], state: "storageKeyChanged", storageKeyChanged: true, durationChanged: true }],
    };
    const rows = buildClipVideoRows(from, to, diff, []);
    const byId = new Map(rows.map((row) => [row.clipId, row]));
    assert.equal(byId.get("clip-a")?.status, "成片更换");
    assert.equal(byId.get("clip-a")?.color, "orange");
    assert.equal(byId.get("clip-a")?.from?.storageKey, "video:old");
    assert.equal(byId.get("clip-a")?.to?.storageKey, "video:new");
    assert.equal(byId.get("clip-b")?.status, "未更换");
});

test("逐clip行：仅旧版有记录时如实标注，不拿当前画布顶替", () => {
    const from = [clip("clip-old", "video:old", 3750)];
    const rows: ClipVideoRow[] = buildClipVideoRows(from, [], { ...emptyDiff(), recordedFrom: true, fromCount: 1, removed: ["clip-old"] }, []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "仅旧版有成片记录");
    assert.equal(rows[0].to, undefined);
    assert.equal(rows[0].current, undefined);
});
