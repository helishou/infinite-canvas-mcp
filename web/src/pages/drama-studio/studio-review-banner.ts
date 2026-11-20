/**
 * 制作台顶部审阅/放行横幅的纯派生（对齐影策 detail.tsx:374-409 / 679-729）。
 *
 * 只吃 backend /pipeline/status 的真实字段与 use-studio-data 派生的每集状态，不产生任何伪造状态：
 *  - review_mode / media_mode / status     ← status.pipeline（DB 行）
 *  - approvals / releasedMedia / sampleMode ← status() 从持久化表读回的后端闸门态（重启不丢）
 *  - jobs[].stage / status / episodeId      ← status.jobs（DB 队列表）
 *  - episodes[].status / no                 ← publishedVersion + shotCount 派生
 *
 * 没有运行中的流水线、或闸门没有真的卡住作业时，一律返回全 false（不显示横幅）。
 */
export type BannerPipelineStatus = {
    pipeline?: { status?: string; review_mode?: string; media_mode?: string } | null;
    approvals?: string[];
    releasedMedia?: string[];
    sampleMode?: boolean;
    jobs?: Array<Record<string, unknown>>;
};

export type BannerEpisode = { id: string; no: number; status: string };

export type ReviewBanners = {
    awaitingMedia: boolean;
    reviewing: boolean;
    /** reviewing 为样片确认时文案不同（确认样片，继续全剧）。 */
    sampleReview: boolean;
    sampleWaiting: boolean;
};

type Job = Record<string, unknown> | undefined;
const statusOf = (job: Job) => String(job?.status || "");

/** 与后端 mediaHeld() 同语义：auto 恒放行；非 auto 需已放行 all 或对应 target。 */
export function mediaHeld(mediaMode: string, released: string[], target: string): boolean {
    if (mediaMode === "auto") return false;
    return !released.includes("all") && !released.includes(target);
}

/** 与后端 needsReview() 同语义（SAMPLE_EVERY=3）；样片模式的第 1 集由调用方叠加。 */
export function reviewNeededFor(reviewMode: string, episodeNo: number): boolean {
    if (reviewMode === "every") return true;
    if (reviewMode === "auto") return false;
    if (reviewMode === "sample" && episodeNo > 0) return episodeNo % 3 === 0;
    return false;
}

/** current 为当前选中集；episodes 全集仅用于定位第 1 集样片。 */
export function deriveReviewBanners(
    status: BannerPipelineStatus | null | undefined,
    episodes: BannerEpisode[],
    current: BannerEpisode | undefined,
): ReviewBanners {
    const empty: ReviewBanners = { awaitingMedia: false, reviewing: false, sampleReview: false, sampleWaiting: false };
    if (!status?.pipeline || status.pipeline.status !== "running" || !current) return empty;

    const reviewMode = String(status.pipeline.review_mode || "auto");
    const mediaMode = String(status.pipeline.media_mode || "auto");
    const sampleMode = Boolean(status.sampleMode);
    const approvals = (status.approvals || []).map(String);
    const released = (status.releasedMedia || []).map(String);
    const jobs = status.jobs || [];
    const jobAt = (episodeId: string, stage: string) =>
        jobs.find((j) => String(j.episodeId) === episodeId && String(j.stage) === stage);
    const isApproved = (episodeId: string) => approvals.includes(episodeId);

    const firstEpisode = episodes.find((ep) => ep.no === 1);

    const scriptJob = jobAt(current.id, "script");
    const assetsJob = jobAt(current.id, "assets");
    const promptsJob = jobAt(current.id, "prompts");
    const videoJob = jobAt(current.id, "video");

    // 手动媒体闸门真的卡住本集 assets 作业：script 已成功、assets 仍 queued、未放行 assets/all。
    const awaitingMedia = current.status === "待生成"
        && statusOf(scriptJob) === "succeeded"
        && statusOf(assetsJob) === "queued"
        && mediaHeld(mediaMode, released, "assets");

    // 审批闸门真的卡住本集 video 作业：prompts 已成功、video 仍 queued、未 approve。
    const needsApproval = (sampleMode && current.no === 1) || reviewNeededFor(reviewMode, current.no);
    const reviewing = needsApproval && !isApproved(current.id)
        && statusOf(promptsJob) === "succeeded"
        && statusOf(videoJob) === "queued";
    const sampleReview = reviewing && current.no === 1 && (sampleMode || reviewMode === "sample") && !isApproved(current.id);

    // 非第 1 集、样片模式且第 1 集样片未确认、本集提示词已就绪但视频未出。
    const sampleWaiting = Boolean(
        firstEpisode && current.no !== 1 &&
        (sampleMode || reviewMode === "sample") && !isApproved(firstEpisode.id) &&
        statusOf(promptsJob) === "succeeded" && statusOf(videoJob) !== "succeeded",
    );

    return { awaitingMedia, reviewing, sampleReview, sampleWaiting };
}
