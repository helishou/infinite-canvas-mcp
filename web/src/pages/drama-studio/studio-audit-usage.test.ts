import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditUsage, type AuditUsage } from "./studio-audit-usage";

const source = {
    asset_plan: [
        { id: "AST-CHAR-A", kind: "character", asset_name: "甲" },
        { id: "AST-SCENE-B", kind: "scene", asset_name: "乙景" },
        { id: "AST-PROP-MISSING", kind: "prop", asset_name: "丙道具" },
        { id: "KF-1", kind: "keyframe", name: "附加帧" },
    ],
    subject_registry: [
        { id: "SUB-A", pictureBindings: [{ assetId: "AST-CHAR-A" }] },
        { id: "SUB-B", pictureBindings: [{ assetId: "AST-SCENE-B" }] },
        { id: "SUB-MISS", pictureBindings: [{ assetId: "AST-PROP-MISSING" }] },
        { id: "SUB-KF", pictureBindings: [{ assetId: "KF-1" }] },
    ],
    shots: [
        { id: "S1", visual: "甲在乙景", duration_frames: 48, subject_usages: [{ subjectId: "SUB-A" }, { subjectId: "SUB-B" }] },
        { id: "S2", visual: "丙道具特写", duration_frames: 24, subject_usages: [{ subjectId: "SUB-MISS" }] },
        { id: "S3", visual: "未关联的附加帧", duration_frames: 24, subject_usages: [{ subjectId: "SUB-KF" }] },
    ],
    segments: [
        { id: "SEG1", summary: "第一段", shot_ids: ["S1", "S2", "NOT-EXIST"] },
    ],
};
const assets: Record<string, unknown> = {
    "AST-CHAR-A": { storageKey: "image:aaa" },
    "AST-SCENE-B": {}, // 真值里没有 storageKey：必须判缺少参考图、不渲染图
    "KF-1": { storageKey: "image:kf1" },
};
const artifacts = [{
    kind: "h3", targetId: "SEG1", references: [
        { label: "<Picture 1>", assetId: "AST-CHAR-A", storageKey: "image:aaa", sent: true },
        { label: "<Picture 2>", assetId: "AST-SCENE-B", sent: false },
        { label: "<Picture 3>", assetId: "AST-PROP-MISSING", storageKey: "image:prop" },
    ],
}];

test("buildAuditUsage：issue 由真值派生，storageKey 决定缩略图", () => {
    const usage: AuditUsage = buildAuditUsage(source, assets, artifacts);
    assert.equal(usage.segments.length, 1);
    const seg = usage.segments[0];
    assert.equal(seg.id, "SEG1");
    assert.equal(seg.title, "第一段");
    assert.equal(seg.shotCount, 2); // 不存在的镜头 id 不能混进真实镜头
    const byId = new Map(seg.assets.map((a) => [a.assetId, a]));
    assert.equal(byId.get("AST-CHAR-A")?.storageKey, "image:aaa");
    assert.equal(byId.get("AST-CHAR-A")?.issue, undefined, "随本次请求发送不算待核查");
    assert.equal(byId.get("AST-CHAR-A")?.status, "随当前请求发送");
    assert.equal(byId.get("AST-SCENE-B")?.issue, "missing-image", "没有 storageKey 优先于 not-sent");
    assert.equal(byId.get("AST-SCENE-B")?.storageKey, "", "无 storageKey 不渲染缩略图");
    assert.equal(byId.get("AST-PROP-MISSING")?.issue, undefined, "有图且已附图");
    assert.equal(byId.get("AST-PROP-MISSING")?.storageKey, "image:prop", "请求记录里的真 storageKey 可作缩略图来源");
    assert.equal(seg.pendingCount, 1);
    assert.deepEqual(usage.warnings, ["第 1 段有无法读取的镜头，请打开该段核查"]);
});

test("buildAuditUsage：not-sent / not-selected 与未关联镜头来自真实引用与段归属", () => {
    const usage = buildAuditUsage(source, { ...assets, "AST-PROP-MISSING": { storageKey: "image:prop" } }, [
        { kind: "h3", targetId: "SEG1", references: [{ assetId: "AST-CHAR-A", storageKey: "image:aaa", sent: false }] },
    ]);
    const byId = new Map(usage.segments[0].assets.map((a) => [a.assetId, a]));
    assert.equal(byId.get("AST-CHAR-A")?.issue, "not-sent", "显式 sent=false 才是本次请求不附图");
    assert.equal(byId.get("AST-PROP-MISSING")?.issue, "not-selected", "有图但本次请求没引用");
    assert.equal(usage.unassignedShots.length, 1);
    assert.equal(usage.unassignedShots[0].id, "S3");
    assert.equal(usage.unassignedShots[0].position, 2);
    assert.equal(usage.unassignedShots[0].chips[0]?.name, "附加帧", "未关联镜头保留其真实资产 chip");
    assert.equal(usage.unassignedShots[0].chips[0]?.kind, "image", "keyframe 归附加素材");
    assert.equal(usage.counts.image, 1);
});

test("buildAuditUsage：keyframe 归附加素材，无 source 时全部为空且无告警", () => {
    const usage = buildAuditUsage({ ...source, subject_registry: [{ id: "SUB-KF", pictureBindings: [{ assetId: "KF-1" }] }] }, assets, []);
    assert.equal(usage.segments[0].assets.some((a) => a.kind === "image"), false);
    const empty = buildAuditUsage(null, {}, []);
    assert.equal(empty.segments.length, 0);
    assert.equal(empty.unassignedShots.length, 0);
    assert.deepEqual(empty.warnings, []);
    assert.equal(empty.assetCount, 0);
});
