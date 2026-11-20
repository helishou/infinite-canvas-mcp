/**
 * 剪影/剪映草稿导出的真预检（纯算法层）。
 *
 * 与影策 `planDramaJianyingDraft` 对齐：段全集、逐段 reason 决策树、三分类、
 * stale 是 available 的子集、revision 只覆盖交付相关字段。
 * 本文件不碰数据库/文件系统；媒体元数据与可读性由 service 层注入，便于单测穷举分支。
 */
import crypto from "node:crypto";
import fs from "node:fs";

import { isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";
import type { MediaFile } from "../engine-contract/contracts.js";

export type DramaJianyingSegmentPreview = {
    index: number;
    title: string;
    included: boolean;
    stale: boolean;
    reason?: string;
    durationMs: number;
    durationEstimated: boolean;
};

export type DramaJianyingDraftPreview = {
    draftRoot: string;
    revision: string;
    totalSegments: number;
    availableSegments: number;
    missingSegments: number;
    staleSegments: number;
    durationMs: number;
    mediaBytes: number;
    captionCount: number;
    segments: DramaJianyingSegmentPreview[];
    warnings: string[];
};

/** 影策 dramaArchiveMaxBytes：8GB。超限影策直接拒绝导出，这里记警告不伪造可导出状态。 */
export const JIANYING_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const rows = (value: unknown): Record<string, any>[] => Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Record<string, any>[]
    : [];
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** 影策的可读性判定：stat 为普通文件/大小与元数据一致，且能读到首字节。 */
export function mediaReadable(filePath: string, expectedBytes: number): boolean {
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, "r");
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== expectedBytes) return false;
        const buffer = Buffer.allocUnsafe(1);
        return fs.readSync(fd, buffer, 0, 1, 0) === 1;
    } catch {
        return false;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 已随进程回收 */ }
    }
}

/** 无 kind 字段时，用 mime 或 storageKey 扩展名确认这是视频，不用“有 URL”冒充视频。 */
export function isVideoMedia(media: Pick<MediaFile, "mimeType" | "storageKey">): boolean {
    if (String(media.mimeType || "").toLowerCase().startsWith("video/")) return true;
    const generic = !media.mimeType || /^(application\/octet-stream|binary\/octet-stream)$/i.test(media.mimeType);
    return generic && /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg)$/i.test(String(media.storageKey || "").split(/[?#]/, 1)[0]);
}

/** 复刻前端 productionSubtitleTracks 的 cue 计数口径，只统计被纳入段的镜头。 */
export function countSubtitleCues(source: unknown, includedShotIds: Set<string>): number {
    if (!includedShotIds.size || !isSubjectPromptAssembly(record(source))) return 0;
    try {
        const src = record(source);
        const utterances = new Map(rows(src.utterances).map(item => [String(item.id), item]));
        const windows = subjectShotWindows(src);
        let count = 0;
        for (const shot of rows(src.shots)) {
            const window = windows.get(String(shot.id));
            if (!window || !includedShotIds.has(String(shot.id))) continue;
            for (const ref of rows(shot.utterance_refs)) {
                const utterance = utterances.get(String(ref.utteranceId));
                if (!utterance) continue;
                const characters = Array.from(String(utterance.text ?? ""));
                const textStart = Math.max(0, Math.min(characters.length, Number(ref.textStart ?? 0)));
                const textEnd = Math.max(textStart, Math.min(characters.length, Number(ref.textEnd ?? characters.length)));
                if (!characters.slice(textStart, textEnd).join("").trim()) continue;
                const startFrame = window.startFrame + Math.max(0, Number(ref.localStartFrame ?? 0));
                const endFrame = Math.min(window.endFrame, window.startFrame + Number(ref.localEndFrame ?? 0));
                if (endFrame > startFrame) count++;
            }
        }
        return count;
    } catch {
        return 0;
    }
}

export type JianyingPreflightSegmentInput = {
    /** 制作稿里的段 ID，仅用于指纹，不进返回体（影策返回数字 index）。 */
    id: string;
    title: string;
    shotIds: string[];
    /** 由生成记录/源稿帧数推导的兜底时长（毫秒），媒体无实测时长时使用。 */
    estimatedDurationMs: number;
    /** 从画布 H3 段 metadata 解析出的当前结果 storageKey；空串即未就绪。 */
    resultStorageKey: string;
    /** 结构化 inputOutdated（H3 段或 Clip 组），不是 notice 正则。 */
    stale: boolean;
    /** 同一段在画布上匹配到多个 H3 Clip，身份不唯一，按未就绪处理。 */
    ambiguousResult?: boolean;
    media: Pick<MediaFile, "storageKey" | "filePath" | "mimeType" | "bytes" | "durationMs" | "sha256"> | null;
    readable: boolean;
};

export type JianyingPreflightPlanInput = {
    episodeId: string;
    sourceHash: string;
    productionRevision: number;
    draftRoot?: string;
    captions?: boolean;
    segments: JianyingPreflightSegmentInput[];
    /** 源稿，用于统计纳入段的台词字幕条数；不传则 captionCount=0。 */
    source?: unknown;
};

/**
 * 影策同款逐段决策树 + 三分类。stale 只在 available 分支计数，是 available 的子集；
 * missing 段带 reason 且 included=false，不参与时长/体积累计。
 */
export function planJianyingDraftPreview(input: JianyingPreflightPlanInput): DramaJianyingDraftPreview {
    const preview: DramaJianyingDraftPreview = {
        draftRoot: String(input.draftRoot || ""),
        revision: "",
        totalSegments: input.segments.length,
        availableSegments: 0,
        missingSegments: 0,
        staleSegments: 0,
        durationMs: 0,
        mediaBytes: 0,
        captionCount: 0,
        segments: [],
        warnings: [],
    };
    const includedShotIds = new Set<string>();
    const fingerprints: unknown[] = [];
    let overArchiveLimit = false;
    let anyEstimated = false;

    for (const [index, seg] of input.segments.entries()) {
        const item: DramaJianyingSegmentPreview = {
            index,
            title: String(seg.title || `第 ${index + 1} 段`),
            included: false,
            stale: seg.stale === true,
            durationMs: 0,
            durationEstimated: false,
        };
        let reason = "";
        const media = seg.media;
        if (!seg.shotIds?.length) {
            reason = "镜头信息缺失";
        } else if (seg.ambiguousResult) {
            reason = "视频尚未就绪";
        } else if (!seg.resultStorageKey) {
            reason = "视频尚未就绪";
        } else {
            if (!media || !isVideoMedia(media) || !(media.bytes > 0)) {
                reason = "视频资源不可用";
            } else {
                const measured = Number(media.durationMs || 0);
                if (measured > 0) {
                    item.durationMs = Math.round(measured);
                } else {
                    item.durationMs = Math.max(0, Math.round(Number(seg.estimatedDurationMs) || 0));
                    item.durationEstimated = true;
                }
                if (item.durationMs <= 0 || item.durationMs > MAX_DURATION_MS) {
                    reason = "视频时长未知或无效";
                } else if (!seg.readable) {
                    reason = "视频文件暂不可读取，请检查存储或稍后重试";
                }
            }
        }

        if (reason) {
            item.reason = reason;
            preview.missingSegments++;
            preview.segments.push(item);
            fingerprints.push({ item, resultStorageKey: seg.resultStorageKey || "", stale: item.stale });
            continue;
        }

        if (media && media.bytes > JIANYING_ARCHIVE_MAX_BYTES - preview.mediaBytes) overArchiveLimit = true;
        item.included = true;
        preview.availableSegments++;
        if (item.stale) preview.staleSegments++;
        if (item.durationEstimated) anyEstimated = true;
        preview.durationMs += item.durationMs;
        preview.mediaBytes += media?.bytes || 0;
        for (const shotId of seg.shotIds) includedShotIds.add(String(shotId));
        preview.segments.push(item);
        fingerprints.push({ item, id: seg.id, resultStorageKey: seg.resultStorageKey,
            sha256: media?.sha256 || "", bytes: media?.bytes || 0, title: item.title });
    }

    if (input.captions) preview.captionCount = countSubtitleCues(input.source, includedShotIds);

    if (preview.missingSegments > 0) preview.warnings.push(`${preview.missingSegments} 个剧情段将被跳过；剩余视频按原顺序相接，导出不完整`);
    if (preview.staleSegments > 0) preview.warnings.push(`${preview.staleSegments} 个剧情段使用修改前的视频，不代表当前分镜已重新生成`);
    if (anyEstimated) preview.warnings.push("部分视频未记录实测时长，草稿采用生成记录时长，请在剪映核对片段末尾");
    if (preview.captionCount > 0) preview.warnings.push("台词字幕按分镜时长估算，不是语音识别；导入后请核对字幕时间");
    if (overArchiveLimit) preview.warnings.push("可用媒体总量超过 8GB，导出会被拒绝（JIANYING_ARCHIVE_TOO_LARGE）；请先分批下载视频");

    // 指纹只覆盖交付相关字段：制作稿修订/源稿哈希/段结果身份与元数据/分类结论。
    // 不含任务日志、轮询时间、草稿目录之外的临时状态；草稿目录与字幕开关由请求携带，参与指纹。
    const payload = [input.episodeId, input.productionRevision, input.sourceHash,
        String(input.draftRoot || ""), input.captions === true, fingerprints, preview.captionCount];
    preview.revision = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return preview;
}
