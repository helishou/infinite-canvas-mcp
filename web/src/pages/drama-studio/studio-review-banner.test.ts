/**
 * 横幅派生单测：fixture 的字段形状取自真实 GET /drama/:id/pipeline/status 响应
 * （已在运行后端实测返回 approvals / releasedMedia / sampleMode / jobs[].stage|status|episodeId）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveReviewBanners, mediaHeld, reviewNeededFor } from "./studio-review-banner.js";

const EP1 = { id: "episode-1", no: 1, status: "待生成" };
const EP2 = { id: "episode-2", no: 2, status: "待生成" };
const episodes = [EP1, EP2];
const job = (episodeId: string, stage: string, status: string) => ({ id: `${episodeId}:${stage}`, stage, status, episodeId });
const baseStatus = () => ({
    pipeline: { status: "running", review_mode: "auto", media_mode: "auto", drama_id: "drama-test" },
    approvals: [] as string[],
    releasedMedia: [] as string[],
    sampleMode: false,
    jobs: [] as Array<Record<string, unknown>>,
});

test("闸门纯函数与后端语义一致", () => {
    assert.equal(mediaHeld("auto", [], "assets"), false);
    assert.equal(mediaHeld("manual", [], "assets"), true);
    assert.equal(mediaHeld("manual", ["assets"], "assets"), false);
    assert.equal(mediaHeld("manual", ["all"], "render"), false);
    assert.equal(reviewNeededFor("auto", 3), false);
    assert.equal(reviewNeededFor("every", 3), true);
    assert.equal(reviewNeededFor("sample", 2), false);
    assert.equal(reviewNeededFor("sample", 3), true); // SAMPLE_EVERY=3
});

test("没有运行中的流水线 / 没有当前集：三类横幅都不显示", () => {
    const s = baseStatus();
    assert.deepEqual(deriveReviewBanners(null, episodes, EP2), { awaitingMedia: false, reviewing: false, sampleReview: false, sampleWaiting: false });
    assert.deepEqual(deriveReviewBanners({ ...s, pipeline: { ...s.pipeline, status: "paused" } }, episodes, EP2), { awaitingMedia: false, reviewing: false, sampleReview: false, sampleWaiting: false });
    assert.deepEqual(deriveReviewBanners(s, episodes, undefined), { awaitingMedia: false, reviewing: false, sampleReview: false, sampleWaiting: false });
});

test("auto 模式即使作业排队也不显示审阅横幅（不是闸门卡住）", () => {
    const s = baseStatus();
    s.jobs = [job(EP2.id, "prompts", "succeeded"), job(EP2.id, "video", "queued")];
    const r = deriveReviewBanners(s, episodes, EP2);
    assert.equal(r.reviewing, false);
    assert.equal(r.awaitingMedia, false);
});

test("awaitingMedia：manual 媒体闸门真的卡住本集 assets 作业", () => {
    const s = baseStatus();
    s.pipeline.media_mode = "manual";
    s.jobs = [job(EP2.id, "script", "succeeded"), job(EP2.id, "assets", "queued")];
    assert.equal(deriveReviewBanners(s, episodes, EP2).awaitingMedia, true);
    // 真实 release 后闸门态变化 → 横幅消失
    s.releasedMedia = ["assets"];
    assert.equal(deriveReviewBanners(s, episodes, EP2).awaitingMedia, false);
});

test("reviewing：every 模式 prompts 成功但 video 被闸门卡在 queued；approve 后消失", () => {
    const s = baseStatus();
    s.pipeline.review_mode = "every";
    s.jobs = [job(EP2.id, "prompts", "succeeded"), job(EP2.id, "video", "queued")];
    const r = deriveReviewBanners(s, episodes, EP2);
    assert.equal(r.reviewing, true);
    assert.equal(r.sampleReview, false); // 非样片，按钮为「确认，生成视频」
    s.approvals = [EP2.id];
    // 真实 approve 后闸门态立即更新，横幅消失；作业调度由后端 tick 收敛，前端不臆测时序。
    assert.equal(deriveReviewBanners(s, episodes, EP2).reviewing, false);
});

test("样片模式第 1 集：reviewing + sampleReview，按钮为「确认样片，继续全剧」", () => {
    const s = baseStatus();
    s.sampleMode = true;
    s.jobs = [job(EP1.id, "prompts", "succeeded"), job(EP1.id, "video", "queued")];
    const r = deriveReviewBanners(s, episodes, EP1);
    assert.equal(r.reviewing, true);
    assert.equal(r.sampleReview, true);
});

test("sampleWaiting：非第 1 集提示词就绪但第 1 集样片未确认；确认后消失", () => {
    const s = baseStatus();
    s.sampleMode = true;
    s.jobs = [job(EP2.id, "prompts", "succeeded"), job(EP2.id, "video", "queued")];
    const r = deriveReviewBanners(s, episodes, EP2);
    assert.equal(r.sampleWaiting, true);
    assert.equal(r.reviewing, false); // 样片模式只挡第 1 集，本集不是审批对象
    s.approvals = [EP1.id];
    assert.equal(deriveReviewBanners(s, episodes, EP2).sampleWaiting, false);
});

test("重启后从持久化恢复的 approvals 喂给横幅派生：不误报 reviewing / sampleReview / sampleWaiting", () => {
    const s = baseStatus();
    s.pipeline.review_mode = "every";
    s.sampleMode = true;
    // status() 从持久化表读回：ep1/ep2 都已批准
    s.approvals = [EP1.id, EP2.id];
    s.jobs = [
        job(EP1.id, "prompts", "succeeded"), job(EP1.id, "video", "queued"),
        job(EP2.id, "prompts", "succeeded"), job(EP2.id, "video", "queued"),
    ];
    const r1 = deriveReviewBanners(s, episodes, EP1);
    const r2 = deriveReviewBanners(s, episodes, EP2);
    assert.equal(r1.reviewing, false);
    assert.equal(r1.sampleReview, false);
    assert.equal(r2.reviewing, false);
    assert.equal(r2.sampleWaiting, false);
});

test("没有真实作业信号时不凭 review_mode / media_mode 编造横幅", () => {
    const s = baseStatus();
    s.pipeline.review_mode = "every";
    s.pipeline.media_mode = "manual";
    s.jobs = [job(EP2.id, "script", "queued")]; // 尚无 prompts / 未卡在闸门
    const r = deriveReviewBanners(s, episodes, EP2);
    assert.deepEqual(r, { awaitingMedia: false, reviewing: false, sampleReview: false, sampleWaiting: false });
});
