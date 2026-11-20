/**
 * 待处理 inbox 的失败分类（真链路，不造假）。
 *
 * 影策真值（panels.tsx:608/624-643）把失败拆成 cast_failed（参考图）与 segment_failed（段视频），
 * 底层靠 drama_casts.image_status / drama_segments.video_status 两个专用状态字段。本地无这两张表，
 * 但 generation_logs 有两个写入时即落库的真实字段足以区分：
 *  - platform：图片走 image-dispatcher 写 "canvas-image"；段视频走 H3/comfyui/local 写
 *    "selected-video-model" / "comfyui" / "local" / "canvas-video"。
 *  - segment_id：段视频日志带真实 Clip 段 id（如 shot-01 / clip-xxx）；图片日志没有。
 *
 * 实测（~/.infinite-canvas/runtime.sqlite）：canvas-image 失败日志 node_id 指向 config-* /
 * production-asset-* / image-* 参考图节点、错误是「GPT Image 请求失败 / 上传参考图片到 ComfyUI失败」；
 * 段视频失败日志 platform=comfyui|local|selected-video-model 且 segment_id=shot-01 等、错误带 [h3-run]。
 * 因此按 platform+segment_id 分类是对真实写入字段的派生，不是编造的空分类。
 *
 * 不做的事：不引入 castId（本地日志无此字段）；不把 i2v/t2v 等执行模式当失败分类（taskMode 只是出图模式）；
 * 不把无法归类的失败（文本/音频/未知平台）伪装成 cast/segment，仍归 episode_error。
 */

export type StudioInboxItem = {
    id: string;
    kind: "episode_error" | "stage_gap" | "job_failed" | "cast_failed" | "segment_failed";
    severity: "error" | "warning";
    title: string;
    detail: string;
    episodeId?: string;
    episodeNo?: number;
    segmentId?: string;
    nodeId?: string;
    logId?: string;
};

export type InboxLog = {
    id: string;
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
    platform: string;
    status: string;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt?: string;
    createdAt?: string;
};

export type InboxEpisode = {
    id: string;
    no: number;
    title: string;
    canvasId?: string | null;
    error?: string | null;
    jobs: { failed: number; succeeded: number; running: number };
};

/** 图片生成（参考图）落库的 platform 值。 */
export const IMAGE_FAILURE_PLATFORMS = new Set(["canvas-image"]);
/** 段视频生成落库的 platform 值。必须同时带 segment_id 才算「剧情段」。 */
export const SEGMENT_VIDEO_PLATFORMS = new Set(["comfyui", "local", "selected-video-model", "canvas-video"]);

export type FailureKind = "cast_failed" | "segment_failed" | "episode_error";

/** 按真实日志字段归类失败；不认识的保持 episode_error，不伪造。 */
export function classifyFailureKind(log: InboxLog): FailureKind {
    const platform = String(log.platform || "").toLowerCase();
    const segment = String(log.segmentId || "").trim();
    if (segment && SEGMENT_VIDEO_PLATFORMS.has(platform)) return "segment_failed";
    if (IMAGE_FAILURE_PLATFORMS.has(platform)) return "cast_failed";
    return "episode_error";
}

function logTime(log: InboxLog): number {
    const t = Date.parse(String(log.finishedAt || log.startedAt || log.updatedAt || log.createdAt || ""));
    return Number.isFinite(t) ? t : 0;
}

/**
 * 从 episodes + generation_logs 派生待处理失败项。
 * 每条失败按「分类 + nodeId + segmentId」定位目标，只取该目标时间上最新的一条；
 * 最新一条已成功/运行中即视为已恢复，不再当失败（与 use-studio-data 的 lastError 口径一致）。
 */
export function deriveInboxFailureItems(episodes: InboxEpisode[], logs: InboxLog[]): StudioInboxItem[] {
    const items: StudioInboxItem[] = [];
    for (const ep of episodes) {
        const flagged = ep.jobs.failed > 0 || Boolean(String(ep.error || "").trim());
        if (!flagged) continue;
        const canvasId = String(ep.canvasId || "");
        const canvasLogs = canvasId ? logs.filter((log) => String(log.projectId || "") === canvasId) : [];

        const newestByTarget = new Map<string, InboxLog>();
        for (const log of canvasLogs) {
            const target = `${classifyFailureKind(log)}::${String(log.nodeId || "")}::${String(log.segmentId || "")}`;
            const prev = newestByTarget.get(target);
            if (!prev || logTime(log) >= logTime(prev)) newestByTarget.set(target, log);
        }

        let produced = 0;
        for (const log of newestByTarget.values()) {
            if (!["failed", "error"].includes(String(log.status || "").toLowerCase())) continue;
            const kind = classifyFailureKind(log);
            const detail = String(log.error || "").trim().slice(0, 160) || "生成失败";
            if (kind === "segment_failed") {
                const segmentId = String(log.segmentId || "");
                items.push({
                    id: `segment:${ep.id}:${segmentId || log.id}`,
                    kind: "segment_failed", severity: "error",
                    title: `第 ${ep.no} 集 · 剧情段 ${segmentId}`,
                    detail, episodeId: ep.id, episodeNo: ep.no,
                    segmentId, nodeId: String(log.nodeId || ""), logId: log.id,
                });
            } else if (kind === "cast_failed") {
                items.push({
                    id: `cast:${ep.id}:${String(log.nodeId || log.id)}`,
                    kind: "cast_failed", severity: "error",
                    title: `第 ${ep.no} 集 · 参考图生成失败`,
                    detail, episodeId: ep.id, episodeNo: ep.no,
                    nodeId: String(log.nodeId || ""), logId: log.id,
                });
            } else {
                items.push({
                    id: `episode:${ep.id}:${log.id}`,
                    kind: "episode_error", severity: "error",
                    title: `第 ${ep.no} 集：${ep.title}`,
                    detail, episodeId: ep.id, episodeNo: ep.no, logId: log.id,
                });
            }
            produced += 1;
        }
        // 兼容历史数据：本集被标失败但拿不到逐目标失败（如仅有 Aggregate 错误）时保留原归并卡片。
        if (produced === 0) {
            items.push({
                id: `episode:${ep.id}`, kind: "episode_error", severity: "error",
                title: `第 ${ep.no} 集：${ep.title}`,
                detail: String(ep.error || `${ep.jobs.failed} 个生成任务失败`),
                episodeId: ep.id, episodeNo: ep.no,
            });
        }
    }
    return items;
}
