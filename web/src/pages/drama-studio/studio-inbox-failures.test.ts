import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailureKind, deriveInboxFailureItems, type InboxActiveRefMap, type InboxEpisode, type InboxLog } from "./studio-inbox-failures";

const episode = (over: Partial<InboxEpisode> = {}): InboxEpisode => ({
    id: "ep1", no: 1, title: "第一集", canvasId: "canvas1", error: null,
    jobs: { failed: 2, succeeded: 0, running: 0 }, ...over,
});

const log = (over: Partial<InboxLog>): InboxLog => ({
    id: "log", projectId: "canvas1", platform: "canvas-image", status: "failed", ...over,
});

test("classifyFailureKind：真实 platform + segment_id 区分参考图/段视频/其余", () => {
    assert.equal(classifyFailureKind(log({ platform: "canvas-image" })), "cast_failed");
    assert.equal(classifyFailureKind(log({ platform: "comfyui", segmentId: "shot-01" })), "segment_failed");
    assert.equal(classifyFailureKind(log({ platform: "local", segmentId: "clip-3" })), "segment_failed");
    assert.equal(classifyFailureKind(log({ platform: "selected-video-model", segmentId: "clip-1" })), "segment_failed");
    // 视频平台但没有段 id → 不是「剧情段」失败，不伪造 segment_failed
    assert.equal(classifyFailureKind(log({ platform: "comfyui", segmentId: "" })), "episode_error");
    // 图片平台的 i2v taskMode 不改变分类（taskMode 只是出图模式，不是失败分类）
    assert.equal(classifyFailureKind(log({ platform: "canvas-image", segmentId: "" })), "cast_failed");
    assert.equal(classifyFailureKind(log({ platform: "canvas-text", segmentId: "seg" })), "episode_error");
    assert.equal(classifyFailureKind(log({ platform: "workflow" })), "episode_error");
});

test("deriveInboxFailureItems：同集参考图失败 + 段视频失败拆成两类，带真实定位字段", () => {
    const logs: InboxLog[] = [
        log({ id: "img-1", platform: "canvas-image", nodeId: "config-smart-char", segmentId: "", error: "GPT Image 请求失败（HTTP 503）", finishedAt: "2026-11-19T10:00:00Z" }),
        log({ id: "seg-1", platform: "comfyui", nodeId: "video-abc", segmentId: "shot-01", error: "ComfyUI 未启动\n[h3-run] taskMode=r2v", finishedAt: "2026-11-19T10:01:00Z" }),
    ];
    const items = deriveInboxFailureItems([episode()], logs);
    assert.equal(items.length, 2);
    const cast = items.find((i) => i.kind === "cast_failed")!;
    const seg = items.find((i) => i.kind === "segment_failed")!;
    assert.ok(cast, "应有 cast_failed");
    assert.ok(seg, "应有 segment_failed");
    assert.equal(cast.nodeId, "config-smart-char");
    assert.equal(cast.episodeId, "ep1");
    assert.match(cast.detail, /GPT Image/);
    assert.equal(seg.segmentId, "shot-01");
    assert.equal(seg.nodeId, "video-abc");
    assert.match(seg.detail, /h3-run/);
});

test("已恢复的目标（后续同目标成功）不再当失败项", () => {
    const logs: InboxLog[] = [
        log({ id: "old-fail", platform: "canvas-image", nodeId: "config-char", error: "fetch failed", finishedAt: "2026-11-19T10:00:00Z" }),
        log({ id: "new-ok", platform: "canvas-image", nodeId: "config-char", status: "success", error: "", finishedAt: "2026-11-19T10:05:00Z" }),
    ];
    const items = deriveInboxFailureItems([episode({ jobs: { failed: 1, succeeded: 1, running: 0 } })], logs);
    // 逐目标最新一条是成功 → 没有 cast_failed；仅保留历史兼容的归并卡片
    assert.equal(items.filter((i) => i.kind === "cast_failed").length, 0);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "episode_error");
});

test("无法归类的失败（文本/未知平台）保持 episode_error，不伪造空分类", () => {
    const logs: InboxLog[] = [
        log({ id: "txt", platform: "canvas-text", nodeId: "n1", error: "分镜脚本解析失败", finishedAt: "2026-11-19T10:00:00Z" }),
    ];
    const items = deriveInboxFailureItems([episode()], logs);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "episode_error");
    assert.match(items[0].detail, /分镜脚本解析失败/);
});

test("真实库样本形态（取自 ~/.infinite-canvas/runtime.sqlite）落入正确分类", () => {
    const logs: InboxLog[] = [
        // canvas-image failed，node_id=image-…，segment_id 为空，错误 GPT Image
        log({ id: "real-img", platform: "canvas-image", nodeId: "image-eca653be-c5c4-43b0-a905-b3f54ec97634", segmentId: "", error: "GPT Image 请求失败（HTTP 405）：Method Not Allowed", finishedAt: "2026-11-18T09:22:00Z" }),
        // comfyui failed，node_id=video-…，segment_id=shot-01，错误带 [h3-run]
        log({ id: "real-seg", platform: "comfyui", nodeId: "video-73a6cac3-46de-41c2-86f5-ee361490b186", segmentId: "shot-01", error: "ComfyUI 未启动，请先启动 ComfyUI（http://127.0.0.1:8188）\n[h3-run] taskMode=r2v", finishedAt: "2026-11-18T09:25:00Z" }),
    ];
    const items = deriveInboxFailureItems([episode({ no: 3, title: "第三集" })], logs);
    assert.deepEqual(
        items.map((i) => i.kind).sort(),
        ["cast_failed", "segment_failed"],
    );
    const seg = items.find((i) => i.kind === "segment_failed")!;
    assert.equal(seg.segmentId, "shot-01");
    assert.match(seg.title, /第 3 集/);
});


test("孤儿失败节点：已被新资产体系取代、不再被引用的参考图失败被过滤", () => {
    const logs: InboxLog[] = [
        // 旧 image-canvas 节点失败，但该节点不在当前链路引用集合里
        log({ id: "old-img", platform: "canvas-image", nodeId: "image-canvas-OLD", error: "gpt-image-2.6-1k 不支持 0 张参考图", finishedAt: "2026-11-20T10:00:00Z" }),
        // 当前在用的资产节点失败，应保留
        log({ id: "cur-img", platform: "canvas-image", nodeId: "production-entity-NEW", error: "引擎不可用 fetch failed", finishedAt: "2026-11-23T10:00:00Z" }),
    ];
    const active: InboxActiveRefMap = new Map([
        ["ep1", { nodes: new Set(["production-entity-NEW"]), segments: new Set(["clip-1"]) }],
    ]);
    const items = deriveInboxFailureItems([episode()], logs, active);
    const casts = items.filter((i) => i.kind === "cast_failed");
    assert.equal(casts.length, 1, "只保留仍被引用的参考图失败");
    assert.equal(casts[0].nodeId, "production-entity-NEW");
});

test("孤儿段失败：不在当前段集合里的 segment_failed 被过滤", () => {
    const logs: InboxLog[] = [
        log({ id: "old-seg", platform: "comfyui", nodeId: "video-old", segmentId: "shot-OLD", error: "旧段失败", finishedAt: "2026-11-20T10:00:00Z" }),
        log({ id: "cur-seg", platform: "comfyui", nodeId: "video-new", segmentId: "clip-1", error: "当前段失败", finishedAt: "2026-11-23T10:00:00Z" }),
    ];
    const active: InboxActiveRefMap = new Map([
        ["ep1", { nodes: new Set(), segments: new Set(["clip-1"]) }],
    ]);
    const items = deriveInboxFailureItems([episode()], logs, active);
    const segs = items.filter((i) => i.kind === "segment_failed");
    assert.equal(segs.length, 1);
    assert.equal(segs[0].segmentId, "clip-1");
});

test("未提供引用集合时不改变原有行为（向后兼容）", () => {
    const logs: InboxLog[] = [
        log({ id: "img", platform: "canvas-image", nodeId: "any-node", error: "失败", finishedAt: "2026-11-20T10:00:00Z" }),
    ];
    const items = deriveInboxFailureItems([episode()], logs);
    assert.equal(items.filter((i) => i.kind === "cast_failed").length, 1);
});

test("某集无 production 数据（Map 无该 key）时不过滤，避免误杀未加载集的真实失败", () => {
    const logs: InboxLog[] = [
        log({ id: "img", platform: "canvas-image", nodeId: "node-x", error: "失败", finishedAt: "2026-11-20T10:00:00Z" }),
    ];
    const active: InboxActiveRefMap = new Map([["ep2", { nodes: new Set(), segments: new Set() }]]);
    const items = deriveInboxFailureItems([episode()], logs, active);
    assert.equal(items.filter((i) => i.kind === "cast_failed").length, 1, "ep1 不在 Map 中，不过滤");
});
