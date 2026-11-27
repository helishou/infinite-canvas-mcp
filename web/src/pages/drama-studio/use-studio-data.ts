import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    fetchBackendDramaEpisodes,
    fetchBackendDramaEpisode,
    fetchDramaStage,
    fetchEpisodeProduction,
    fetchProductionBatches,
    fetchBackendAssets,
    fetchBackendGenerationLogs,
    fetchClipVideosCurrent,
    fetchVersionCompareVersions,
    type ClipVideoTruth,
    createBackendDramaEpisode,
    updateBackendDramaEpisode,
    deleteBackendDramaEpisode,
    requestEpisodeScriptProposal,
    fetchDramaPlanningSource,
    fetchDramaSourceChapterMeta,
    ensureEpisodeCanvas,
    startCanvasGeneration,
    fetchBackendTask,
    fetchBackendProject,
    backendMediaUrl,
    applyBackendCanvasOperations,
    editEpisodeProduction,
    pauseProductionBatch,
    resumeProductionBatch,
    type DramaEpisode,
    type DramaSourceFormat,
    type DramaStageReport,
    type EpisodeProduction,
    type ProductionBatch,
    type BackendGenerationLog,
} from "@/services/backend-api";
import { deriveInboxFailureItems, SEGMENT_VIDEO_PLATFORMS, type InboxActiveRefMap, type StudioInboxItem } from "./studio-inbox-failures";
import { deriveSegmentVersionDuration, shotsDurationSecOf } from "./studio-version-duration";
export type { StudioInboxItem };
import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";
import {
    buildAssetExtractPrompt,
    parseAssetExtract,
    fallbackAssetExtract,
    type ExtractedAsset,
} from "@basketikun/canvas-agent/drama/asset-extract";
import {
    buildSegmentWriterPrompt,
    cleanWrittenPrompt,
    unknownReferenceTokens,
    type SegmentWriterInput,
    type SegmentWriterShot,
} from "@basketikun/canvas-agent/drama/segment-writer";
import { createManualDirectorAsset } from "@/pages/drama/manual-director-assets";
import { resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { useBackendStore } from "@/stores/use-backend-store";
import { splitSourceIntoEpisodes, groupSynopsis } from "@/lib/drama/adapt";

/**
 * 制作台内部逻辑层：把影策制作台的状态机语义，用本地真实数据派生出来。
 * 不新增第二份真值——所有字段都来自 stage-contract / 制作稿 / generation-logs / batches。
 *
 * 影策 → 本地映射：
 * - episode.stage(script/assets/shots/video) ← 制作稿 director.source / publishedVersion
 * - episode.error ← 该集 canvasId 下的 failed generation log
 * - jobCounts(inboxCounts) ← generation-logs 按 status 聚合（projectId = episode.canvasId）
 * - inbox(待处理) ← stage.gaps + 失败日志，按集归并
 * - production.status(stage/pauseReason) ← 前端本地运行状态（本地无全局 production 记录）
 * - planCursor/选章 ← stage.topic 规划集数 vs 实际分集数
 */

/**
 * useQueries 的结果数组每次渲染都是新引用（React Query v5 的 trackResult 每次 map 出新数组），
 * 直接进 useMemo deps 会让所有下游派生每帧失效。这里只在 query.data 真变时更新数组引用；
 * query 对象本身继续保留，供 refetch / isPending 使用。
 */
function useStableQueryData<T>(results: ReadonlyArray<{ data: T | undefined }>): ReadonlyArray<T | undefined> {
    const stable = useRef<ReadonlyArray<T | undefined>>([]);
    const next = results.map((result) => result.data);
    if (stable.current.length !== next.length || next.some((value, index) => value !== stable.current[index])) {
        stable.current = next;
    }
    return stable.current;
}

export type StudioStatus = "待生成" | "需要处理" | "制作中" | "已完成";

/** 影策的每集阶段语义 */
export type StudioStage = "draft" | "script" | "assets" | "shots" | "video";

/** 建集弹窗提交的原文真值：素材类型 + 原文，透传给后端 POST/PATCH 落库。 */
export type EpisodeSourcePayload = {
    sourceFormat: DramaSourceFormat;
    sourceText: string;
};

export type StudioEpisode = {
    id: string;
    no: number;
    title: string;
    synopsis: string;
    fullPlot: string;
    canvasId: string | null;
    status: StudioStatus;
    /** 0..4 */
    progress: number;
    stage: StudioStage;
    stageCurrent: string | null;
    doneStages: string[];
    hasScript: boolean;
    /** 该集镜头数（真实制作稿 shots） */
    shotCount: number;
    /** 该集剧情段数（真实制作稿 segments） */
    segmentCount: number;
    /** 已发布版本 */
    publishedVersion: number;
    /** 该集最近一条生成错误（来自 generation log） */
    error: string | null;
    /** 该集任务计数 */
    jobs: { failed: number; succeeded: number; running: number };
    /** 该集已产出真实视频的段数（画布段 resultStorageKey 以 video: 开头）；无数据源时缺省。 */
    videoReady?: number;
    /** 该集真实成片时长（毫秒）；无任何真值来源时为 null。 */
    durationMs?: number | null;
};

export type StudioAsset = {
    id: string;
    title: string;
    kind: string;
    coverUrl: string;
    storageKey: string;
    note: string;
    /** 共享资产在源画布里的实体节点 id（metadata.nodeId），段参考图绑定只有 sourceNodeId 时用它反查名称。 */
    sourceNodeId?: string;
    /** 资产卡 4 拼设定图真值：data.images[] + data.image + coverUrl 归一后的可显示 URL，去重保序；没有图就是空数组。 */
    images?: string[];
};

/** 成片页真实片段产物（来自分集画布 H3 视频节点 resultStorageKey）。 */
export type StudioClipMedia = {
    id: string;
    /** 画布 H3 段 productionClipProjection.targetId，即制作稿 draft 的段 id（segId）；段卡片靠它关联真实视频。 */
    targetId?: string;
    title: string;
    storageKey: string;
    duration: number;
    status: string;
    inputOutdated: boolean;
    /** 产生当前视频的 generation_log id（画布段 results[].generationLogId），用于回查产物时间。 */
    generationLogId?: string;
    /** 该日志的 finishedAt/startedAt；查不到日志时缺省，不猜时间。 */
    generatedAt?: string;
    /** 画布 H3 节点 metadata.errorDetails（节点级真实失败原因）。段卡片失败态据此显示原因，无则不编造。 */
    errorDetails?: string;
    /** 画布 H3 段的创作真值：提示词与参考图绑定。制作台段卡优先显示画布内容，artifact 只作 fallback。 */
    prompt?: string;
    referenceBindings?: ReadonlyArray<Record<string, unknown>>;
    /** 编译器按提交顺序给图片绑定分配的 Picture N；段卡编号与提示词引用统一读它，不再按 label/下标另算。 */
    submissionOrdinals?: Readonly<Record<string, number>>;
    /** 画布段的真实生成模式（t2v/i2v/fl2v/ref2va）。段卡模式标签以此为准，勿用过时 source.segment.mode。 */
    taskMode?: string;
    /** 画布段真值：本段开启「尾帧参考」时，运行时会把本段最后一帧截成图片交给下一段当首帧。 */
    tailFrameContinuation?: boolean;
    /** 画布段真值：已截取的本段尾帧图片 storageKey（tailFrameAnchor.storageKey），没有就为空。 */
    tailFrameAnchorKey?: string;
};

/** 段 targetId → 画布 H3 节点 errorDetails：失败段无成片、进不了 clipMedia，靠这张表也能显示失败原因。 */
export type ClipFailureByTarget = Record<string, string>;

/**
 * 后端派生、挂到 draft.director.source.segments[].state 上的段真值（对齐影策 promptStatus /
 * promptJob.wait / providerStage / references）。前端只读透传给段卡片，字段缺省即「无真值」，
 * 任何等待原因、上游阶段、未附图原因都不在前端编造。
 */
export type StudioSegmentState = {
    promptStatus?: "none" | "queued" | "running" | "ready" | "stale" | "failed";
    promptError?: string;
    waitReason?: string;
    upstreamStage?: string;
    references?: Array<{ label: string; sent: boolean; missingReason?: string }>;
    /** 提示词是否手写（影策 segment.custom）：手写段标脏也不显示「已过期」，由后端从画布 clip 派生。 */
    custom?: boolean;
    /** 视频是否仅后处理失败（影策 videoReprocessable）：成片已在库，重试只重处理后处理。 */
    videoReprocessable?: boolean;
    /** 后端派生的视频阶段（对齐影策 videoStatus：queued/loading/running/ready/stale/failed）。无真值缺省。 */
    videoStatus?: string;
    /** 后端派生的视频失败原因，失败态优先展示；无真值缺省，不编造。 */
    videoError?: string;
    /** 提交请求的可观测真值：首帧等待/提交操作/实际附图数/是否因上限少附图。字段缺席即未知。 */
    request?: {
        firstFramePending?: boolean;
        operation?: string;
        referencesSent?: number;
        referenceLimited?: boolean;
    };
};

/**
 * 成片是否过期（影策 finalStale 的本地真实派生）：
 * - 只有存在成片产物才谈「过期」；
 * - 画布 H3 段被后端按输入 hash 标成 inputOutdated（段视频早于当前提示词/引用），成片必然是旧版；
 * - 或当前段视频的生成日志时间晚于 finalResource.at（合成后段被重生成），成片没有包含它。
 * 注意 finalResource.stale 只在合成当时写 false，全仓没有翻 true 的链路，不能拿它当真值。
 */
export function deriveFinalStale(production: EpisodeProduction | undefined, clipMedia: readonly StudioClipMedia[]): boolean {
    const final = (((production?.draft as Record<string, any> | undefined)?.director as Record<string, any> | undefined)?.workflow as Record<string, any> | undefined)?.finalResource as { storageKey?: string; at?: string } | undefined;
    if (!final?.storageKey) return false;
    if (clipMedia.some((clip) => clip.inputOutdated)) return true;
    if (!final.at) return false;
    const composed = Date.parse(final.at);
    if (!Number.isFinite(composed)) return false;
    return clipMedia.some((clip) => {
        if (!clip.generatedAt) return false;
        const produced = Date.parse(clip.generatedAt);
        // 1s 容差：合成时间与视频回写可能落在同一秒，避免误报。
        return Number.isFinite(produced) && produced > composed + 1000;
    });
}

/**
 * 版本来源真值（对齐影策 DramaTakeSource + 本地 restore 切版本）：
 * pipeline 流水线生成 / upload 制作台上传 / canvas 从精修画布采用 / restore 切版本设为当前。
 */
export type StudioVersionSource = "pipeline" | "upload" | "canvas" | "restore";

/**
 * 段版本来源派生：优先读 generation_logs.source（生成回写真实写入）；
 * 历史库缺值时缺省 pipeline —— 日志表里的记录本来就是真实生成回写产生的，不臆造别的来源。
 */
export function deriveGenerationSource(log: { source?: string }): StudioVersionSource {
    const value = String(log.source || "");
    return value === "pipeline" || value === "upload" || value === "canvas" || value === "restore"
        ? value
        : "pipeline";
}

/** 版本来源展示文案（对齐影策 take-list.tsx SOURCE_LABEL + 本地 restore 切版本）。 */
export const SOURCE_LABEL: Record<StudioVersionSource, string> = {
    pipeline: "生成",
    upload: "上传",
    canvas: "来自画布",
    restore: "切版本",
};

/**
 * 段视频版本（来自 generation_logs，按 segment 的真实画布 Clip id 过滤）。
 * version = 本段第几次「成功且有视频产物」的生成，按 startedAt 升序编号；失败/运行中不计号。
 */
export type StudioSegmentVersion = {
    /** generation_logs.id —— restore_h3_output 写回的凭证 */
    id: string;
    version: number | null;
    startedAt: string;
    model: string;
    taskMode: string;
    status: string;
    error: string;
    /** 来源：真实生成回写写入 generation_logs.source；当前项被 restore 回切时标记 restore。 */
    source: StudioVersionSource;
    /** 视频产物的 storageKey（无视频产物时为空） */
    storageKey: string;
    /** backendMediaUrl(storageKey)，供 <video> 预览 */
    url: string;
    /** 是否等于画布 H3 Clip 当前 resultStorageKey */
    current: boolean;
    /** 版本视频真实时长（秒）：优先成片 media_files.duration_ms，回退分场镜头帧数/fps；无真值为 null。 */
    durationSec: number | null;
    /** durationSec 的来源；null = 无真值。 */
    durationSource: "media-file" | "shots-frames" | null;
    /** true = 只在画布 Clip 的 results[] 里留存、generation_logs 已无对应记录（日志被裁剪或画布内直接生成）。 */
    canvasKept?: boolean;
};

/** 影策 production 状态机 */
export type StudioProductionState = {
    status: "running" | "paused";
    stage: "plan" | "script" | "produce" | "done";
    pauseReason: string;
    planCursor: number;
    plannedCount: number;
    chapterCount: number;
    doneCount: number;
};

const CURRENT_TO_PROGRESS: Record<string, number> = {
    script: 1, assets: 2, spatial: 2, shots: 3, keyframes: 3, clips: 4,
};

const SOURCE_PREFIX = "【章】";

/** 从制作稿真实结构派生每集阶段（对齐影策 stage 语义）。 */
function deriveStageFromProduction(production: EpisodeProduction | undefined, hasScript: boolean): { stage: StudioStage; shotCount: number; segmentCount: number; publishedVersion: number } {
    const publishedVersion = production?.publishedVersion || 0;
    const draft = (production?.draft || {}) as Record<string, unknown>;
    const source = (draft.director as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined;
    const scenes = Array.isArray(draft.scenes) ? draft.scenes : Array.isArray(source?.script_scenes) ? source!.script_scenes : [];
    const shots = Array.isArray(draft.shots) ? draft.shots : Array.isArray(source?.shots) ? source!.shots : [];
    const segments = Array.isArray(draft.clipGroups) ? draft.clipGroups : Array.isArray(source?.segments) ? source!.segments : [];
    const shotCount = shots.length;
    const segmentCount = segments.length;
    const sceneCount = (Array.isArray(source?.scene_registry) ? source!.scene_registry : []).length;
    const registryCount = (Array.isArray(source?.character_registry) ? source!.character_registry : []).length
        + (Array.isArray(source?.asset_plan) ? source!.asset_plan : []).length;

    let stage: StudioStage = "draft";
    // 对齐影策顺序：有分镜段只到 shots，不等于 video。video 必须有真实发布信号（publishedVersion>0）。
    // 绝不能只凭 segmentCount 就判 video——那会让资产/prompts/review 段被整体跳过。
    if (publishedVersion > 0 && shotCount > 0) stage = "video";
    else if (shotCount > 0 || segmentCount > 0) stage = "shots";
    else if (sceneCount > 0 || registryCount > 0) stage = "assets";
    else if (hasScript) stage = "script";
    return { stage, shotCount, segmentCount, publishedVersion };
}

type LogStat = { failed: number; succeeded: number; running: number; lastError: string | null };

/**
 * 从生成日志派生集级统计与「当前错误」。
 * 关键：lastError 只取【时间上最新】的一条失败，且若之后有更新的 success/运行日志则视为已恢复，
 * 不显示过时错误（例如 ComfyUI 曾 ECONNREFUSED、后来已成功出片，红条不该一直挂着）。
 * failed 计数仍累计用于徽标，与影策 stats.failed 语义一致。
 */
function deriveLogStat(logs: BackendGenerationLog[]): LogStat {
    let failed = 0, succeeded = 0, running = 0;
    const timeOf = (l: BackendGenerationLog): number => {
        const t = Date.parse(String(l.finishedAt || l.startedAt || l.updatedAt || l.createdAt || ""));
        return Number.isFinite(t) ? t : 0;
    };
    let newestFailedTime = -1;
    let newestFailedError: string | null = null;
    let newestOtherTime = -1;
    for (const log of logs) {
        const status = String(log.status || "").toLowerCase();
        const t = timeOf(log);
        if (status === "success" || status === "succeeded") {
            succeeded += 1;
            if (t > newestOtherTime) newestOtherTime = t;
        } else if (status === "failed" || status === "error") {
            failed += 1;
            if (t > newestFailedTime) { newestFailedTime = t; newestFailedError = String(log.error || "生成失败").slice(0, 160); }
        } else if (["running", "pending", "queued"].includes(status)) {
            running += 1;
            if (t > newestOtherTime) newestOtherTime = t;
        }
    }
    // 只有最新失败严格晚于任何后续成功/运行日志时才当作当前错误。
    const lastError = newestFailedError && newestFailedTime > newestOtherTime ? newestFailedError : null;
    return { failed, succeeded, running, lastError };
}

/** 集级新字段的真值输入：全部来自本模块已有查询，缺源时留 undefined/null，不编造。 */
type EpisodeTruthInput = {
    /** 当前画布逐 clip 真值：storageKey 直接来自 metadata.segments[].resultStorageKey。 */
    clips?: readonly { storageKey: string }[];
    /** 已发布快照派生出的成片时长（毫秒，后端从 media_files.duration_ms 取真值）。 */
    versionDurationMs?: number | null;
    versionDurationSource?: string | null;
    /** 当前制作稿 director.workflow.finalResource（durationSec 为落库真值）。 */
    finalResource?: { storageKey?: string; durationSec?: unknown } | null;
    /** 当前制作稿 director.source，用于 shots.duration_frames/fps 兜底。 */
    source?: unknown;
};

/** 逐集视频就绪数：只数 resultStorageKey 带 video: 前缀的真实产物段，分母沿用 segmentCount。 */
function deriveVideoReady(input: EpisodeTruthInput): number | undefined {
    if (!input.clips) return undefined;
    let count = 0;
    for (const clip of input.clips) {
        if (String(clip.storageKey || "").startsWith("video:")) count += 1;
    }
    return count;
}

/** 逐集成片时长（毫秒）：快照成片文件时长 → finalResource.durationSec → shots 帧数/fps；全缺为 null。 */
function deriveEpisodeDurationMs(input: EpisodeTruthInput): number | null {
    const versionMs = Number(input.versionDurationMs);
    if (input.versionDurationSource === "media-file" && Number.isFinite(versionMs) && versionMs > 0) return versionMs;
    const finalSec = Number(input.finalResource?.durationSec);
    if (Number.isFinite(finalSec) && finalSec > 0) return finalSec * 1000;
    const src = input.source;
    if (src && typeof src === "object") {
        const source = src as Record<string, unknown>;
        const shots = Array.isArray(source.shots) ? source.shots : [];
        const shotIds = shots.map((shot) => String((shot as Record<string, unknown>)?.id || "")).filter(Boolean);
        const sec = shotsDurationSecOf(source, shotIds);
        if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) return sec * 1000;
    }
    // 快照只有镜头帧数兜底时也是真值（与后端 summarizeVersionSnapshot 同口径），最后才采用。
    if (Number.isFinite(versionMs) && versionMs > 0) return versionMs;
    return null;
}

function deriveEpisode(
    ep: DramaEpisode,
    stageEp: { episodeNumber: number; stage: string | null; done: string[] } | undefined,
    logStat: LogStat,
    prodDerive: ReturnType<typeof deriveStageFromProduction>,
    truth: EpisodeTruthInput = {},
): StudioEpisode {
    const done = stageEp?.done ?? [];
    const current = stageEp?.stage ?? null;
    const reached = (key: string) => done.includes(key) || current === key;
    const synopsis = String(ep.synopsis || "").trim();
    const hasScript = Boolean(String(ep.fullPlot || "").trim()) || (synopsis.length >= 40 && !synopsis.startsWith(SOURCE_PREFIX));

    // 阶段取两者更靠后的：stage-contract 游标 vs 制作稿真实内容
    const stageOrder: Record<StudioStage, number> = { draft: 0, script: 1, assets: 2, shots: 3, video: 4 };
    let stage: StudioStage = prodDerive.stage;
    if (reached("clips") && stageOrder[stage] < 4) stage = "video";
    else if ((reached("shots") || reached("keyframes")) && stageOrder[stage] < 3) stage = "shots";
    else if ((reached("assets") || reached("spatial")) && stageOrder[stage] < 2) stage = "assets";
    else if ((reached("script") || hasScript) && stageOrder[stage] < 1) stage = "script";

    const progress = stageOrder[stage];
    // 对齐影策 episodeTone：已发布成片=done；已拆镜头但没发布=待生成(awaitingMedia)；其余按游标。
    // publishedVersion 是真实发布信号，比 stage=video（仅表示有提示词）更准。
    // 对齐影策 episodeTone：error（当前仍有未恢复失败）优先于 stage；已发布成片=done。
    // 关键修正：只有 lastError（最新失败晚于任何后续成功/运行）才算「需要处理」。
    // 单看 failed>0 会把「历史失败早已成功重出覆盖」的集永久误标需要处理——
    // 例如蟒妻 ep1/ep2/ep4 的失败都是旧 gpt-image-2.6 残留，后来已用 2.1 重出并出成片，
    // 不该再挂红条（与 deriveLogStat 的「latest failure recovered by later success」语义一致）。
    // 视频就绪段数取画布真实产物（video: 前缀），用于状态与阶段进度，避免「publish 标记在、视频没有」冒充已完成。
    const readyCount = deriveVideoReady(truth) ?? 0;
    const status: StudioStatus = logStat.lastError
        ? "需要处理"
        : prodDerive.publishedVersion > 0 && (prodDerive.segmentCount === 0 || readyCount >= prodDerive.segmentCount)
            ? "已完成"
            : prodDerive.shotCount > 0
                ? "待生成"
                : progress > 0 || current || logStat.running > 0 ? "制作中" : "需要处理";

    return {
        id: ep.id,
        no: ep.episodeNumber,
        title: ep.title || `第 ${ep.episodeNumber} 集`,
        synopsis: ep.synopsis || "",
        fullPlot: ep.fullPlot || "",
        canvasId: ep.canvasId,
        status,
        progress,
        stage,
        stageCurrent: current ?? (CURRENT_TO_PROGRESS[done[done.length - 1] || ""] ? (done[done.length - 1] || null) : null),
        doneStages: done,
        hasScript,
        shotCount: prodDerive.shotCount,
        segmentCount: prodDerive.segmentCount,
        publishedVersion: prodDerive.publishedVersion,
        error: logStat.lastError,
        jobs: { failed: logStat.failed, succeeded: logStat.succeeded, running: logStat.running },
        videoReady: readyCount,
        durationMs: deriveEpisodeDurationMs(truth),
    };
}

/** 资产图字段里可能是 storageKey（首选，带 token 的媒体地址）或已拼好的 url；旧记录也允许裸 URL 字符串。 */
function assetImageUrlOf(image: unknown): string {
    if (typeof image === "string") return assetImageUrlOf({ url: image });
    const item = (image && typeof image === "object" ? image : {}) as Record<string, unknown>;
    const storageKey = typeof item.storageKey === "string" ? item.storageKey.trim() : "";
    if (storageKey) return backendMediaUrl(storageKey);
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url) return "";
    // 后端记录的 coverUrl / image.url 常是 /media/:key，缺 token 会 401；能还原 key 就换成带 token 的地址。
    const match = /\/media\/([^?#]+)/.exec(url);
    if (!match) return url;
    try { return backendMediaUrl(decodeURIComponent(match[1])); } catch { return url; }
}

/**
 * 卡片 4 拼设定图真值（角色 data.images[] / 场景道具 data.image / 资产记录 coverUrl）：
 * coverUrl 是后端主图（角色取 primaryIndex 那张），优先作首图；按数组原序追加，去重、只留非空。
 * 绝不补齐、不重复同一张图；不足 4 张由渲染处补空占位。
 */
function assetImagesOf(data: Record<string, unknown>, coverUrl: string): string[] {
    const out: string[] = [];
    const push = (url: string) => {
        const value = url.trim();
        if (!value || out.includes(value)) return;
        out.push(value);
    };
    push(assetImageUrlOf({ url: coverUrl }));
    for (const image of Array.isArray(data.images) ? data.images : []) push(assetImageUrlOf(image));
    push(assetImageUrlOf(data.image));
    return out;
}

function toAsset(raw: unknown): StudioAsset | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return null;
    const data = (item.data && typeof item.data === "object" ? item.data : {}) as Record<string, unknown>;
    const metadata = (item.metadata && typeof item.metadata === "object" ? item.metadata : {}) as Record<string, unknown>;
    const note = typeof item.note === "string" ? item.note : typeof metadata.note === "string" ? metadata.note : "";
    const coverUrl = typeof item.coverUrl === "string" ? item.coverUrl : "";
    return {
        id,
        title: typeof item.title === "string" ? item.title : id,
        kind: typeof item.kind === "string" ? item.kind : "image",
        coverUrl,
        storageKey: typeof data.storageKey === "string" ? data.storageKey : "",
        note,
        images: assetImagesOf(data, coverUrl),
        /** 共享资产在源画布里的实体节点 id：段参考图绑定只带 sourceNodeId 时用它反查资产真名。 */
        sourceNodeId: typeof metadata.nodeId === "string" ? metadata.nodeId : "",
    };
}

const emptyLogStat: LogStat = { failed: 0, succeeded: 0, running: 0, lastError: null };
const emptyProdDerive: ReturnType<typeof deriveStageFromProduction> = { stage: "draft", shotCount: 0, segmentCount: 0, publishedVersion: 0 };

/**
 * 成片页总时长真值补齐（只读派生，不改后端、不伪造）：
 * 老制作稿的 director.source.segments[] 只有 id/mode/shot_ids，没有 duration_frames，
 * 而成片页按 seg.duration_frames 汇总总时长，于是明明 24 镜 84 秒却显示「0秒」。
 * 这里按每段真实 shot_ids 对应的 shots[].duration_frames 汇总回填到 production 的副本；
 * 已有真值的段保持原样，查不到镜头帧数的段也不编造。
 */
function withSegmentDurations(production: EpisodeProduction | undefined): EpisodeProduction | undefined {
    if (!production?.draft) return production;
    const draft = production.draft as Record<string, any>;
    const source = (draft.director as Record<string, any> | undefined)?.source as Record<string, any> | undefined;
    const segments = Array.isArray(source?.segments) ? source!.segments : null;
    if (!segments?.length || segments.every((seg: any) => Number(seg?.duration_frames) > 0)) return production;
    const framesById = new Map<string, number>();
    for (const shot of (Array.isArray(source?.shots) ? source!.shots : []) as any[]) {
        const frames = Number(shot?.duration_frames);
        if (shot?.id && Number.isFinite(frames) && frames > 0) framesById.set(String(shot.id), frames);
    }
    if (!framesById.size) return production;
    const enriched = segments.map((seg: any) => {
        if (Number(seg?.duration_frames) > 0) return seg;
        let frames = 0;
        let found = false;
        for (const shotId of (Array.isArray(seg?.shot_ids) ? seg.shot_ids : []) as any[]) {
            const value = framesById.get(String(shotId));
            if (value !== undefined) { frames += value; found = true; }
        }
        // 段 state 是后端派生真值，补时长时必须原样透传，不能在这层丢掉。
        return found ? { ...seg, duration_frames: frames, ...(seg?.state ? { state: seg.state } : {}) } : seg;
    });
    if (enriched.every((seg: any, i: number) => seg === segments[i])) return production;
    const nextSource = { ...source!, segments: enriched };
    const nextDirector = { ...(draft.director as Record<string, any>), source: nextSource };
    // draft 是 Zod 严格类型；此处只是给派生副本补一个真值字段，读侧容忍即可。
    const nextDraft = { ...(draft as Record<string, any>), director: nextDirector } as unknown as EpisodeProduction["draft"];
    return { ...production, draft: nextDraft };
}

export function useStudioData(dramaId: string | null, episodeId: string | null, options?: { pollActive?: boolean }) {
    const queryClient = useQueryClient();
    const backendUrl = useBackendStore((state) => state.url);
    const connected = useBackendStore((state) => state.connected);
    const config = useConfigStore((state) => state.config);
    const enabled = Boolean(dramaId) && connected;

    const episodesQuery = useQuery({
        queryKey: ["drama-studio-episodes", backendUrl, dramaId],
        enabled,
        queryFn: async () => (await fetchBackendDramaEpisodes(dramaId!)).episodes || [],
    });

    const stageQuery = useQuery({
        queryKey: ["drama-studio-stage", backendUrl, dramaId],
        enabled,
        queryFn: () => fetchDramaStage(dramaId!),
    });

    /** 章节元信息真值（source_chapters.chars）：制作台开场「N章N字」。只要元信息，不拉大正文。 */
    const sourceChaptersQuery = useQuery({
        queryKey: ["drama-studio-source-chapters", backendUrl, dramaId],
        enabled,
        queryFn: async () => (await fetchDramaSourceChapterMeta(dramaId!)).chapters || [],
    });

    const assetsQuery = useQuery({
        queryKey: ["drama-studio-assets", backendUrl, dramaId],
        enabled,
        queryFn: async () => (await fetchBackendAssets({ dramaId: dramaId! })).assets || [],
    });

    // 全剧任务日志（summary 裁掉大列），用于 jobCounts / inbox / episode.error 派生。
    // 首屏只取最近 200 条（约 160KB → 比 500 条省一半以上）；更老的历史在队列详情里按需翻页。
    const logsQuery = useQuery({
        queryKey: ["drama-studio-logs", backendUrl, dramaId],
        enabled,
        queryFn: async () => (await fetchBackendGenerationLogs({ dramaId: dramaId!, limit: 200, summary: true })).logs || [],
    });

    // 每集制作稿：派生真实 stage / shotCount / segmentCount
    const rawEpisodes = episodesQuery.data || [];
    /**
     * 每集制作稿的拉取开关。
     * 曾经尝试「首屏只拉当前集」：hook 里拿不到页面真实的选中集（URL 常不带 episodeId，
     * 选中态在页面层），按第一集猜会把首屏内容推迟到 6s 后才出来（实测 剧本 2.1s → 8.3s）。
     * 所以保留全量并发，「只拉当前集」需要后端轻量投影才安全（见 report 的未做项）。
     */
    const episodeProductionEnabled = () => connected;
    const productionQueries = useQueries({
        queries: rawEpisodes.map((ep) => ({
            queryKey: ["drama-studio-production", backendUrl, ep.id],
            enabled: episodeProductionEnabled() && Boolean(ep.canvasId),
            queryFn: async () => (await fetchEpisodeProduction(ep.id)).production,
        })),
    });

    const productionQuery = useQuery({
        queryKey: ["drama-studio-production", backendUrl, episodeId],
        enabled: Boolean(episodeId) && connected,
        queryFn: async () => (await fetchEpisodeProduction(episodeId!)).production,
    });

    const batchesQuery = useQuery({
        queryKey: ["drama-studio-batches", backendUrl, episodeId],
        enabled: Boolean(episodeId) && connected,
        queryFn: async () => (await fetchProductionBatches(episodeId!)).runs || [],
    });

    /** 成片页：从分集画布的 H3 视频节点提取真实片段产物（resultStorageKey），对齐影策成片播放器/胶片条。
     *  同时收集节点级 errorDetails → 段 targetId 映射，供段卡片失败态显示真实原因（失败段无成片，进不了 clips）。 */
    const clipMediaQuery = useQuery({
        queryKey: ["drama-studio-clip-media", backendUrl, episodeId],
        enabled: Boolean(episodeId) && connected,
        queryFn: async (): Promise<{ clips: StudioClipMedia[]; errorsByTarget: ClipFailureByTarget }> => {
            const detail = await fetchBackendDramaEpisode(episodeId!);
            const nodes = (detail.canvas?.nodes || []) as Array<Record<string, unknown>>;
            const out: StudioClipMedia[] = [];
            const errorsByTarget: ClipFailureByTarget = {};
            for (const node of nodes) {
                const type = String(node.type || "");
                if (!type.includes("h3") || type.includes("image")) continue;
                const meta = (node.metadata || {}) as Record<string, unknown>;
                const nodeError = String(meta.errorDetails || "").trim();
                const segs = Array.isArray(meta.segments) ? meta.segments : [];
                for (const seg of segs) {
                    const s = seg as Record<string, unknown>;
                    const projection = (s.productionClipProjection || {}) as Record<string, unknown>;
                    const targetId = String(projection.targetId || "");
                    // 节点级失败原因按段 targetId 归集（只记录有真实原因的；[object Object] 等非文本忽略）。
                    if (targetId && nodeError && nodeError !== "[object Object]") errorsByTarget[targetId] = nodeError;
                    const key = String(s.resultStorageKey || "");
                    const results = Array.isArray(s.results) ? s.results : [];
                    // 与 resultStorageKey 对齐地取结果条目：restore_h3_output 回切旧版本时，末尾条目未必是当前视频。
                    const chosen = results.find((item) => String((item as Record<string, unknown>).storageKey || "") === key)
                        ?? (results.length ? results[results.length - 1] : s);
                    const r = chosen as Record<string, unknown>;
                    // 画布段的提示词/参考图绑定是创作真值，即使该段还没有成片也要带出（段卡据此显示，不再只依赖过时 artifact）。
                    const canvasPrompt = String(s.prompt || "");
                    const canvasRefs = Array.isArray(s.referenceBindings) ? s.referenceBindings as Array<Record<string, unknown>> : [];
                    // Picture N 与 @引用编号统一取编译器产出，不按 label/数组下标另算，
                    // 否则 disabled、音轨插入或分镜重排时段卡编号会与实际提交槽位分叉。
                    let submissionOrdinals: Record<string, number> | undefined;
                    try {
                        const compiled = compileReferenceSubmission((detail.canvas || {}) as Record<string, unknown>, s);
                        submissionOrdinals = Object.fromEntries(
                            compiled.references.filter((ref) => ref.mediaType === "image").map((ref) => [String(ref.id), ref.ordinal]),
                        );
                    } catch { /* 编译视图不可用时退回 label/下标编号，不阻断段卡展示 */ }
                    out.push({
                        id: String(s.id || String(node.id)),
                        // 段卡片的 segId 就是 productionClipProjection.targetId；没有投影就不猜关联。
                        targetId: targetId || undefined,
                        title: String(s.title || node.title || "剧情段"),
                        storageKey: String(r.storageKey || key),
                        duration: Number(s.duration || 0),
                        status: String(s.status || ""),
                        inputOutdated: Boolean(s.inputOutdated),
                        generationLogId: String(r.generationLogId || s.generationLogId || "") || undefined,
                        errorDetails: nodeError && nodeError !== "[object Object]" ? nodeError : undefined,
                        prompt: canvasPrompt,
                        referenceBindings: canvasRefs,
                        submissionOrdinals,
                        taskMode: String(s.taskMode || ""),
                        // 尾帧参考与尾帧截图都是画布段真值：制作台只读透传，不改写。
                        tailFrameContinuation: s.tailFrameContinuation === true,
                        tailFrameAnchorKey: String((s.tailFrameAnchor as Record<string, unknown> | undefined)?.storageKey || ""),
                    });
                }
            }
            return { clips: out, errorsByTarget };
        },
    });

    // 用真实 generation_logs 给当前片段补产出时间；日志缺省时不编造时间戳。
    const clipMedia = useMemo<StudioClipMedia[]>(() => {
        const logs = logsQuery.data || [];
        const byId = new Map(logs.filter((log) => Boolean(log.id)).map((log) => [String(log.id), log]));
        const byKey = new Map<string, BackendGenerationLog>();
        for (const log of logs) {
            for (const output of Array.isArray(log.outputs) ? log.outputs : []) {
                const key = String((output as Record<string, unknown>).storageKey || "");
                if (key && !byKey.has(key)) byKey.set(key, log);
            }
        }
        return (clipMediaQuery.data?.clips || []).map((clip) => {
            const log = (clip.generationLogId && byId.get(clip.generationLogId)) || byKey.get(clip.storageKey);
            const generatedAt = log ? String(log.finishedAt || log.startedAt || "") : "";
            return generatedAt ? { ...clip, generatedAt } : clip;
        });
    }, [clipMediaQuery.data, logsQuery.data]);

    /** 画布 H3 节点级失败原因，按段 targetId 关联（失败段可能无成片，不在 clipMedia 里）。 */
    const clipFailureByTarget: ClipFailureByTarget = useMemo(() => clipMediaQuery.data?.errorsByTarget || {}, [clipMediaQuery.data]);

    /** 逐集画布成片真值：storageKey 由后端直接读 canvas_nodes.metadata.segments[].resultStorageKey（按 clipId 去重）。 */
    const currentClipVideosQueries = useQueries({
        queries: rawEpisodes.map((ep) => ({
            queryKey: ["drama-studio-clip-videos-current", backendUrl, ep.id],
            enabled: episodeProductionEnabled() && Boolean(ep.canvasId),
            queryFn: async (): Promise<ClipVideoTruth[]> => (await fetchClipVideosCurrent(ep.id)).clipVideos || [],
        })),
    });

    /** 逐集已发布快照的成片时长真值：后端从 snapshot 的 finalResource.storageKey → media_files.duration_ms 派生。 */
    const versionDurationQueries = useQueries({
        queries: rawEpisodes.map((ep) => ({
            queryKey: ["drama-studio-version-duration", backendUrl, ep.id],
            enabled: episodeProductionEnabled() && Boolean(ep.canvasId),
            queryFn: async (): Promise<{ version: number; durationMs: number | null; durationSource: string | null } | null> => {
                const versions = (await fetchVersionCompareVersions(ep.id)).versions || [];
                if (!versions.length) return null;
                const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
                // 前端 VersionCompareSummary 类型尚未同步后端新增的 durationSec/durationSource，读侧容忍。
                const summary = latest.summary as unknown as Record<string, unknown> | undefined;
                const sec = Number(summary?.durationSec);
                const source = typeof summary?.durationSource === "string" ? summary.durationSource : null;
                return { version: latest.version, durationMs: Number.isFinite(sec) && sec > 0 ? sec * 1000 : null, durationSource: source };
            },
        })),
    });

    const clipVideosData = useStableQueryData(currentClipVideosQueries);
    const versionDurationData = useStableQueryData(versionDurationQueries);
    const productionData = useStableQueryData(productionQueries);

    const clipVideosByEpisodeId = useMemo(() => {
        const map = new Map<string, ClipVideoTruth[]>();
        rawEpisodes.forEach((ep, i) => {
            const data = clipVideosData[i];
            if (data !== undefined) map.set(ep.id, data);
        });
        return map;
    }, [rawEpisodes, clipVideosData]);

    const versionDurationByEpisodeId = useMemo(() => {
        const map = new Map<string, { durationMs: number | null; durationSource: string | null }>();
        rawEpisodes.forEach((ep, i) => {
            const data = versionDurationData[i];
            if (data !== undefined) map.set(ep.id, data || { durationMs: null, durationSource: null });
        });
        return map;
    }, [rawEpisodes, versionDurationData]);

    // production 查询结果按索引对应 rawEpisodes
    const prodByEpisodeId = useMemo(() => {
        const map = new Map<string, EpisodeProduction | undefined>();
        rawEpisodes.forEach((ep, i) => map.set(ep.id, productionData[i]));
        return map;
    }, [rawEpisodes, productionData]);

    // 只统计本剧分集画布的日志（generation-log.projectId === episode.canvasId），
    // 避免把全局日志算进本剧；同时过滤 [object Object] 这类无意义错误串。
    const logStatByCanvas = useMemo(() => {
        const canvasIds = new Set(rawEpisodes.map((ep) => ep.canvasId).filter(Boolean) as string[]);
        // 每集当前资产节点集合（canvas-image 失败是否仍算数，看目标节点是否还在制作链路）。
        const activeNodesByCanvas = new Map<string, Set<string>>();
        const activeSegmentsByCanvas = new Map<string, Set<string>>();
        for (const ep of rawEpisodes) {
            if (!ep.canvasId) continue;
            const prod = prodByEpisodeId.get(ep.id);
            const nodes = new Set<string>();
            const segments = new Set<string>();
            if (prod?.draft) {
                const draft = prod.draft as unknown as Record<string, any>;
                const director = (draft.director || {}) as Record<string, any>;
                const source = (director.source || {}) as Record<string, any>;
                for (const asset of Object.values(director.assets || {})) {
                    const a = asset as Record<string, any>;
                    if (a?.nodeId) nodes.add(String(a.nodeId));
                    if (a?.sourceNodeId) nodes.add(String(a.sourceNodeId));
                }
                for (const seg of (source.segments || []) as Array<Record<string, any>>) {
                    if (seg?.id) segments.add(String(seg.id));
                    for (const binding of (seg?.referenceBindings || []) as Array<Record<string, any>>) {
                        if (binding?.sourceNodeId) nodes.add(String(binding.sourceNodeId));
                        if (binding?.nodeId) nodes.add(String(binding.nodeId));
                    }
                }
            }
            activeNodesByCanvas.set(String(ep.canvasId), nodes);
            activeSegmentsByCanvas.set(String(ep.canvasId), segments);
        }
        const map = new Map<string, LogStat>();
        for (const log of logsQuery.data || []) {
            const key = String(log.projectId || "");
            if (!key || !canvasIds.has(key)) continue;
            const status = String(log.status || "").toLowerCase();
            const platform = String(log.platform || "").toLowerCase();
            // 已被新资产体系取代的旧 image-canvas 节点失败日志，是历史残留：
            // 不计入 failed（与 inbox 口径一致），避免底部「待重试」红色数字虚高。
            if (status === "failed" || status === "error") {
                if (platform === "canvas-image") {
                    const active = activeNodesByCanvas.get(key);
                    if (active && !active.has(String(log.nodeId || ""))) continue;
                } else if (SEGMENT_VIDEO_PLATFORMS.has(platform) && String(log.segmentId || "").trim()) {
                    const segs = activeSegmentsByCanvas.get(key);
                    if (segs && !segs.has(String(log.segmentId))) continue;
                }
            }
            const stat = map.get(key) || { failed: 0, succeeded: 0, running: 0, lastError: null };
            if (status === "success" || status === "succeeded") stat.succeeded += 1;
            else if (status === "failed" || status === "error") {
                stat.failed += 1;
                const msg = String(log.error || "").trim();
                if (!stat.lastError && msg && msg !== "[object Object]") stat.lastError = msg.slice(0, 160);
            } else if (["running", "pending", "queued"].includes(status)) stat.running += 1;
            map.set(key, stat);
        }
        return map;
    }, [logsQuery.data, rawEpisodes, prodByEpisodeId]);

    const episodes: StudioEpisode[] = useMemo(() => {
        const stageByNo = new Map<number, { episodeNumber: number; stage: string | null; done: string[] }>();
        for (const item of stageQuery.data?.episodes || []) stageByNo.set(item.episodeNumber, item);
        return rawEpisodes.slice().sort((a, b) => a.episodeNumber - b.episodeNumber).map((ep) => {
            const synopsis = String(ep.synopsis || "").trim();
            const hasScript = Boolean(String(ep.fullPlot || "").trim()) || (synopsis.length >= 40 && !synopsis.startsWith(SOURCE_PREFIX));
            const derive = deriveStageFromProduction(prodByEpisodeId.get(ep.id), hasScript);
            const stat = (ep.canvasId && logStatByCanvas.get(ep.canvasId)) || emptyLogStat;
            // 新字段真值：当前集优先用已成形的 clipMedia，其余集用后端逐集 canvas 段结果；
            // 时长回退链走「版本快照成片 → 当前 finalResource.durationSec → shots 帧数/fps」。
            const production = prodByEpisodeId.get(ep.id);
            const draft = (production?.draft || {}) as Record<string, any>;
            const director = (draft.director || {}) as Record<string, any>;
            const source = (director.source || draft.source || {}) as Record<string, unknown>;
            const versionDuration = versionDurationByEpisodeId.get(ep.id);
            const truth: EpisodeTruthInput = {
                clips: (ep.id === episodeId && clipMediaQuery.data ? clipMedia : clipVideosByEpisodeId.get(ep.id)),
                versionDurationMs: versionDuration?.durationMs,
                versionDurationSource: versionDuration?.durationSource,
                finalResource: (director.workflow as Record<string, any> | undefined)?.finalResource as { storageKey?: string; durationSec?: unknown } | undefined,
                source,
            };
            return deriveEpisode(ep, stageByNo.get(ep.episodeNumber), stat, derive, truth);
        });
    }, [rawEpisodes, stageQuery.data, prodByEpisodeId, logStatByCanvas, episodeId, clipMediaQuery.data, clipMedia, clipVideosByEpisodeId, versionDurationByEpisodeId]);

    const assets: StudioAsset[] = useMemo(() => (assetsQuery.data || []).map(toAsset).filter((item): item is StudioAsset => Boolean(item)), [assetsQuery.data]);

    /**
     * 运行期自动刷新：只复用现有 query 的 refetch，不新增请求类型。
     * 有排队/运行中的作业（流水线、日志、段视频、资产出图、批次）时每 4s 轮询一次；
     * 全部空闲（含失败/成功终态）立即停表，避免空闲时无谓请求与重渲染。
     * 不使用 setState 驱动，数据身份不变时 react-query 结构共享会让卡片 props 保持原引用。
     */
    const busyNow = useMemo(() => {
        const BUSY = new Set(["queued", "running", "loading", "pending", "generating", "checking", "compiling", "applying", "awaiting_confirmation"]);
        const clipsBusy = (clipMediaQuery.data?.clips || []).some((clip) => BUSY.has(String(clip.status || "").toLowerCase()));
        const assetsBusy = (assetsQuery.data || []).some((raw) => {
            const item = (raw || {}) as Record<string, unknown>;
            const data = (item.data && typeof item.data === "object" ? item.data : {}) as Record<string, unknown>;
            const meta = (item.metadata && typeof item.metadata === "object" ? item.metadata : {}) as Record<string, unknown>;
            return BUSY.has(String(data.status || "").toLowerCase()) || BUSY.has(String(meta.generation_status || "").toLowerCase());
        });
        const batchesBusy = (batchesQuery.data || []).some((batch) => BUSY.has(String(batch.status || "").toLowerCase()));
        return {
            any: Boolean(options?.pollActive) || clipsBusy || batchesBusy,
            assets: assetsBusy,
        };
    }, [clipMediaQuery.data, assetsQuery.data, batchesQuery.data, options?.pollActive]);
    // refetch 句柄单独存 ref：query 对象每次渲染都是新引用，直接进 deps 会让 interval 每帧重建（等于轮询风暴）。
    const pollerRef = useRef({
        episodes: episodesQuery.refetch, stage: stageQuery.refetch, logs: logsQuery.refetch,
        production: productionQuery.refetch, clipMedia: clipMediaQuery.refetch,
        batches: batchesQuery.refetch, assets: assetsQuery.refetch,
    });
    pollerRef.current = {
        episodes: episodesQuery.refetch, stage: stageQuery.refetch, logs: logsQuery.refetch,
        production: productionQuery.refetch, clipMedia: clipMediaQuery.refetch,
        batches: batchesQuery.refetch, assets: assetsQuery.refetch,
    };
    useEffect(() => {
        if (!connected || !dramaId || !busyNow.any) return;
        const timer = window.setInterval(() => {
            // 后台标签页不发轮询请求：恢复可见后下一个 tick 会补上，不丢状态。
            if (document.hidden) return;
            const poller = pollerRef.current;
            void poller.episodes();
            void poller.stage();
            void poller.logs();
            if (episodeId) {
                void poller.production();
                void poller.clipMedia();
                void poller.batches();
            }
            if (busyNow.assets) void poller.assets();
        }, 4000);
        return () => window.clearInterval(timer);
    }, [connected, dramaId, episodeId, busyNow.any, busyNow.assets]);

    /** 制作台开场四步卡真值：章节字数来自 source_chapters.chars（正文真实字符数），无章节则不编造字数。 */
    const sourceChapterTruth = useMemo<{ count: number; wordCount: number } | null>(() => {
        const chapters = sourceChaptersQuery.data;
        if (!chapters?.length) return null;
        return {
            count: chapters.length,
            wordCount: chapters.reduce((sum, chapter) => sum + (Number(chapter.chars) || 0), 0),
        };
    }, [sourceChaptersQuery.data]);

    /** 作品圣经完成：共享资产画布确有角色/场景/道具资产（按真实 kind 判定，不看文案）。 */
    const bibleReady = useMemo(
        () => assets.some((asset) => ["character", "scene", "prop"].includes(asset.kind)),
        [assets],
    );

    /** 第 1 集样片完成：第 1 集制作稿持有真实 finalResource.storageKey（成片地址），无成片不标 done。 */
    const firstSampleReady = useMemo(() => {
        const first = episodes.find((ep) => ep.no === 1) || episodes[0];
        if (!first) return false;
        const firstProduction = prodByEpisodeId.get(first.id);
        const final = (((firstProduction?.draft as Record<string, any> | undefined)?.director as Record<string, any> | undefined)?.workflow as Record<string, any> | undefined)?.finalResource as { storageKey?: string } | undefined;
        return Boolean(final?.storageKey);
    }, [episodes, prodByEpisodeId]);

    const stage: DramaStageReport | undefined = stageQuery.data;
    const production: EpisodeProduction | undefined = useMemo(
        () => withSegmentDurations(productionQuery.data),
        [productionQuery.data],
    );
    const batches: ProductionBatch[] = batchesQuery.data || [];

    const counts = useMemo(() => {
        const byStatus: Record<StudioStatus, number> = { 待生成: 0, 需要处理: 0, 制作中: 0, 已完成: 0 };
        for (const ep of episodes) byStatus[ep.status] += 1;
        return byStatus;
    }, [episodes]);

    /** 影策 jobCounts：全剧任务成功/失败计数 */
    const jobCounts = useMemo(() => {
        let succeeded = 0, failed = 0, running = 0;
        for (const stat of logStatByCanvas.values()) {
            succeeded += stat.succeeded; failed += stat.failed; running += stat.running;
        }
        return { succeeded, failed, running };
    }, [logStatByCanvas]);

    /** 每集当前仍在制作链路的引用集合（来自 production 快照，真值非编造）。
     *  用于过滤已被新资产体系取代的旧 image-canvas 失败日志；只为已加载 production 的集建 key，
     *  未加载的集不建 key，避免 production 尚未到达时误杀真实失败。 */
    const inboxActiveRefs: InboxActiveRefMap = useMemo(() => {
        const map: InboxActiveRefMap = new Map();
        for (const ep of rawEpisodes) {
            const prod = prodByEpisodeId.get(ep.id);
            if (!prod?.draft) continue;
            const draft = prod.draft as unknown as Record<string, any>;
            const director = (draft.director || {}) as Record<string, any>;
            const source = (director.source || {}) as Record<string, any>;
            const nodes = new Set<string>();
            const segments = new Set<string>();
            for (const asset of Object.values(director.assets || {})) {
                const a = asset as Record<string, any>;
                if (a?.nodeId) nodes.add(String(a.nodeId));
                if (a?.sourceNodeId) nodes.add(String(a.sourceNodeId));
            }
            for (const seg of (source.segments || []) as Array<Record<string, any>>) {
                if (seg?.id) segments.add(String(seg.id));
                for (const binding of (seg?.referenceBindings || []) as Array<Record<string, any>>) {
                    if (binding?.sourceNodeId) nodes.add(String(binding.sourceNodeId));
                    if (binding?.nodeId) nodes.add(String(binding.nodeId));
                }
            }
            map.set(ep.id, { nodes, segments });
        }
        return map;
    }, [rawEpisodes, prodByEpisodeId]);

    /** 影策 inbox 失败分类（cast_failed 参考图 / segment_failed 段视频 / episode_error 其余）。
     *  分类来自 generation_logs 写入时即落库的真实字段 platform + segment_id，见 studio-inbox-failures.ts。
     *  只按每集真实错误/失败任务派生，不把规划台 stage gaps 当待处理。
     *  传入 inboxActiveRefs 过滤已被新资产体系取代的孤儿失败日志。 */
    const inbox: StudioInboxItem[] = useMemo(
        () => deriveInboxFailureItems(episodes, logsQuery.data || [], inboxActiveRefs),
        [episodes, logsQuery.data, inboxActiveRefs],
    );

    /** 影策 production 状态机（本地派生） */
    const productionState: StudioProductionState = useMemo(() => {
        const plannedCount = Number((stage?.context || "").match(/共\s*(\d+)\s*集/)?.[1]) || 0;
        const chapterCount = plannedCount || episodes.length;
        const doneCount = counts["已完成"];
        let phase: StudioProductionState["stage"] = "plan";
        if (episodes.length > 0 && doneCount < episodes.length) phase = doneCount === 0 ? "script" : "produce";
        else if (episodes.length > 0 && doneCount === episodes.length) phase = "done";
        return {
            status: "running", // 本地无全局 production 记录；暂停是前端本地态
            stage: phase,
            pauseReason: "",
            planCursor: episodes.length,
            plannedCount,
            chapterCount,
            doneCount,
        };
    }, [stage, episodes.length, counts]);

    const queue = useMemo(() => {
        let running = 0, queued = 0, done = 0, retry = 0;
        for (const batch of batches) {
            const status = (batch.status || "").toLowerCase();
            if (["running", "checking", "compiling", "applying"].includes(status)) running += 1;
            else if (["queued", "pending", "paused"].includes(status)) queued += 1;
            else if (["succeeded", "completed", "done"].includes(status)) done += 1;
            else if (["failed", "blocked", "interrupted"].includes(status)) retry += 1;
        }
        return { running, queued, done, retry };
    }, [batches]);

    const refreshAll = async () => {
        await Promise.all([
            episodesQuery.refetch(), stageQuery.refetch(), assetsQuery.refetch(),
            logsQuery.refetch(), productionQuery.refetch(), batchesQuery.refetch(), clipMediaQuery.refetch(), sourceChaptersQuery.refetch(),
            ...productionQueries.map((q) => q.refetch()),
        ]);
    };

    const addEpisode = async (title?: string, source?: EpisodeSourcePayload) => {
        if (!dramaId) throw new Error("尚未选择剧目");
        const nextNo = episodes.reduce((max, ep) => Math.max(max, ep.no), 0) + 1;
        const result = await createBackendDramaEpisode(dramaId, {
            episodeNumber: nextNo,
            title: title || `第 ${nextNo} 集`,
            ...(source ? { sourceFormat: source.sourceFormat, sourceText: source.sourceText } : {}),
        });
        await Promise.all([episodesQuery.refetch(), stageQuery.refetch()]);
        return result.episode || null;
    };

    /** 影策「批量建集」：读剧目原文真值 → 同一份拆章口径 → 循环建集并建画布。返回新建集数。 */
    const batchCreateEpisodes = async () => {
        if (!dramaId) throw new Error("尚未选择剧目");
        const planning = await fetchDramaPlanningSource(dramaId);
        const source = String(planning.sourceScript || "");
        if (!source.trim()) throw new Error("剧目还没有原文，请先在新建页导入小说原文");
        const { rows, groups } = splitSourceIntoEpisodes(source, {});
        const existing = new Set(episodes.map((ep) => ep.no));
        const pending = groups.filter((g) => !existing.has(g.episodeNumber));
        if (!pending.length) return 0;
        let created = 0;
        for (const group of pending) {
            try {
                const result = await createBackendDramaEpisode(dramaId, {
                    episodeNumber: group.episodeNumber,
                    title: String(group.title || "").slice(0, 60),
                    synopsis: groupSynopsis(rows, group),
                });
                if (result.episode && !result.episode.canvasId) await ensureEpisodeCanvas(result.episode.id).catch(() => undefined);
                created += 1;
            } catch { break; }
        }
        await Promise.all([episodesQuery.refetch(), stageQuery.refetch()]);
        return created;
    };

    /** 影策：在指定集前/后插入，后面集号顺延（逐个 PATCH episodeNumber） */
    const insertEpisode = async (atNo: number, position: "before" | "after", title?: string, synopsis?: string, source?: EpisodeSourcePayload) => {
        if (!dramaId) throw new Error("尚未选择剧目");
        const targetNo = position === "before" ? atNo : atNo + 1;
        const toShift = episodes.filter((ep) => ep.no >= targetNo).sort((a, b) => b.no - a.no);
        // 从后往前腾出集号，避免唯一约束冲突（若有）
        for (const ep of toShift) await updateBackendDramaEpisode(ep.id, { episodeNumber: ep.no + 1 });
        const result = await createBackendDramaEpisode(dramaId, {
            episodeNumber: targetNo,
            title: title || `第 ${targetNo} 集`,
            ...(synopsis ? { synopsis } : {}),
            ...(source ? { sourceFormat: source.sourceFormat, sourceText: source.sourceText } : {}),
        });
        await Promise.all([episodesQuery.refetch(), stageQuery.refetch()]);
        return result.episode || null;
    };

    /** 影策：删除本集，后面集号前移。typedText 是服务端 409 要求的「第 N 集」确认文字。 */
    const removeEpisode = async (episodeId: string, typedText?: string) => {
        // 未带/错带确认文字时后端回 409 EPISODE_CONFIRM_REQUIRED，原样抛给 UI 动态切弹窗。
        await deleteBackendDramaEpisode(episodeId, typedText);
        const removed = episodes.find((ep) => ep.id === episodeId);
        if (removed) {
            const toShift = episodes.filter((ep) => ep.no > removed.no).sort((a, b) => a.no - b.no);
            for (const ep of toShift) await updateBackendDramaEpisode(ep.id, { episodeNumber: ep.no - 1 });
        }
        await Promise.all([episodesQuery.refetch(), stageQuery.refetch(), logsQuery.refetch()]);
    };

    const adaptEpisode = async (targetId: string, instruction?: string, model?: string) => {
        const proposal = await requestEpisodeScriptProposal(targetId, {
            ...(instruction ? { instruction } : {}),
            ...(model ? { model } : {}),
        });
        const text = String(proposal.text || "").trim();
        if (!text) throw new Error(proposal.error || "改编没有返回内容");
        await updateBackendDramaEpisode(targetId, { synopsis: text });
        await refreshAll();
        return text;
    };

    /**
     * 影策资产段：从本集分场剧本提取角色/道具/场景并即时建档（对应 applyScriptShots 的 resolve）。
     * 一次文本 LLM（同拆镜的 startCanvasGeneration）产出 {characters,props,scenes}，
     * 再映射为 create_manual_director_asset op 写入制作稿；已有同名设定跳过（只填空不覆盖）。
     * 返回新建档数量。model 用设置里的提取模型（assetExtractModel）或导演引擎，读不到退回文本模型。
     */
    const extractEpisodeAssets = async (targetId: string, instruction?: string, opts?: { model?: string; reasoningEffort?: string }) => {
        const ep = rawEpisodes.find((item) => item.id === targetId);
        const prod = (prodByEpisodeId.get(targetId) || (await fetchEpisodeProduction(targetId)).production);
        if (!ep || !prod) throw new Error("制作稿尚未就绪");
        const draft = (prod.draft || {}) as Record<string, any>;
        const source = (draft.director?.source || {}) as Record<string, any>;
        const synopsis = String(ep.synopsis || ep.fullPlot || "").trim();
        if (!synopsis) throw new Error("本集还没有分场剧本，请先改编");

        // 已建档名（避免重复）+ 草案线索（说话人/场景）。
        const existingNames = [
            ...(Array.isArray(source.character_registry) ? source.character_registry : []).map((c: any) => String(c.name || "")),
            ...(Array.isArray(source.scene_registry) ? source.scene_registry : []).map((s: any) => String(s.name || "")),
            ...(Array.isArray(source.asset_plan) ? source.asset_plan : []).map((a: any) => String(a.asset_name || "")),
        ].filter(Boolean);
        const shots = Array.isArray(source.shots) ? source.shots : [];
        const speakers = Array.from(new Set(shots.map((s: any) => String(s.speaker || "")).filter(Boolean))) as string[];
        const scenes = Array.from(new Set(shots.map((s: any) => String(s.scene || s.scene_id || "")).filter(Boolean))) as string[];

        const prompt = buildAssetExtractPrompt({ chapterTitle: ep.title || `第 ${ep.episodeNumber} 集`, synopsis, speakers, scenes, existingNames });
        // 设置页「提取设定」步骤选中的写作技能，取其 SKILL.md 方法要点注入 system，让选择真实影响提取。
        if (instruction && instruction.trim()) {
            prompt.system = `${prompt.system}\n\n【写作技能要求（须遵守）】\n${instruction.trim().slice(0, 2000)}`;
        }
        // 「提取设定」模型：优先用制作设置里选的 assetExtractModel（前端直传，真实生效）；
        // 未选时退回导演引擎/文本模型，不再从 /settings 读那个并不存在的 key。
        let model = resolveModelForCapability(config, config.textModel, "text");
        const chosen = String(opts?.model || "").trim();
        if (chosen && resolveModelForCapability(config, chosen, "text") === chosen) model = chosen;
        if (!model) throw new Error("没有可用的文本模型");

        let extracted: ExtractedAsset[];
        try {
            const started = await startCanvasGeneration({
                mode: "text", model,
                prompt: [prompt.system, "", prompt.user].join("\n"), count: 1,
                ...(opts?.reasoningEffort ? { params: { reasoningEffort: opts.reasoningEffort } } : {}),
            });
            const deadline = Date.now() + 180_000;
            let text = "";
            for (;;) {
                const { task } = await fetchBackendTask(started.taskId);
                if (!task) throw new Error("提取任务不存在");
                if (task.status === "succeeded") { text = ((task.result?.texts || []) as any[]).map((t: any) => String(t.content || "")).join("\n").trim(); break; }
                if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || "提取失败");
                if (Date.now() > deadline) throw new Error("提取超时");
                await new Promise((r) => setTimeout(r, 1500));
            }
            extracted = text ? parseAssetExtract(text) : fallbackAssetExtract({ chapterTitle: ep.title || "", synopsis, speakers, scenes, existingNames });
        } catch {
            extracted = fallbackAssetExtract({ chapterTitle: ep.title || "", synopsis, speakers, scenes, existingNames });
        }
        if (!extracted.length) return 0;

        // 映射为 create_manual_director_asset op：逐条建，每条重取 revision（乐观锁）。
        let created = 0;
        const nameSet = new Set(existingNames.map((n) => n.trim()));
        for (const item of extracted) {
            if (nameSet.has(item.name.trim())) continue;
            const stamp = `${Date.now().toString(36)}_${created}`;
            const assetId = `SCRIPT_${item.kind.toUpperCase()}_${stamp}`;
            const entityId = item.kind === "prop" ? undefined : `${item.kind === "character" ? "CHAR" : "SCENE"}_SCRIPT_${stamp}`;
            const fresh = (await fetchEpisodeProduction(targetId)).production;
            const s = ((fresh.draft as any)?.director?.source || {}) as Record<string, any>;
            const built = createManualDirectorAsset(s, {
                id: assetId, ...(entityId ? { entityId } : {}), kind: item.kind, name: item.name,
                description: item.appearance, prompt: item.appearance, purpose: "从剧本提取的设定参考图",
                ...(item.voice ? { voiceDescription: item.voice } : {}),
                registerSubject: false, ownerKind: "episode", ownerId: targetId,
            });
            const operation = {
                type: "create_manual_director_asset" as const,
                assetPlan: built.assetPlan, assetCard: built.assetCard,
                ...(built.registryKind && built.registryEntity ? { registryKind: built.registryKind, registryEntity: built.registryEntity } : {}),
            } as Extract<ProductionOperation, { type: "create_manual_director_asset" }>;
            await editEpisodeProduction(targetId, fresh.revision, [operation]);
            nameSet.add(item.name.trim());
            created += 1;
        }
        await refreshAll();
        return created;
    };

    /**
     * 把一段的完整视频提示词写回画布 H3 clip.prompt（视频生成真正读取的字段）。
     * 供「段编辑弹窗」手动保存与 writeSegmentPrompt 的 LLM 撰写共用同一条真实写回链路。
     */
    const saveSegmentPrompt = async (episodeId: string, segmentId: string, promptText: string, custom: boolean) => {
        const ep = rawEpisodes.find((item) => item.id === episodeId);
        if (!ep?.canvasId) throw new Error("本集画布尚未就绪，请先在画布中打开本集");
        const projectRes = await fetchBackendProject(ep.canvasId);
        const project = (projectRes as any).project || projectRes;
        const draft = (((await fetchEpisodeProduction(episodeId)).production?.draft || {}) as Record<string, any>);
        const groups = (Array.isArray(draft.clipGroups) ? draft.clipGroups : []) as any[];
        const group = groups.find((g) => String(g.id) === segmentId) || null;
        let nodeId = String(group?.nodeId || "");
        let canvasSegmentId = String(group?.segmentId || "");
        if (!nodeId || !canvasSegmentId) {
            outer: for (const n of (Array.isArray(project?.nodes) ? project.nodes : []) as any[]) {
                if (!String(n?.type || "").includes("minimax-h3")) continue;
                for (const cs of ((Array.isArray(n?.metadata?.segments) ? n.metadata.segments : []) as any[])) {
                    if (String(cs?.productionClipProjection?.targetId || "") === segmentId) {
                        nodeId = String(n.id);
                        canvasSegmentId = String(cs.id);
                        break outer;
                    }
                }
            }
        }
        if (!nodeId || !canvasSegmentId) throw new Error("该段尚未同步到画布 H3 节点，请先在画布中打开本集重新编译后再保存提示词");
        await applyBackendCanvasOperations(ep.canvasId, [{
            type: "update_h3_segment", nodeId, segmentId: canvasSegmentId,
            patch: { prompt: promptText, promptCustom: custom },
        }], Number(project.revision || 0));
        await refreshAll();
    };

    /**
     * 影策 prompts 阶段：为某段用一次文本 LLM 撰写完整视频提示词，写回画布 H3 clip.prompt
     * （视频生成真正读取的字段）。素材稿时间码/台词来自制作稿，参考图编号来自 h3 artifact。
     * 返回写入的提示词与校验告警。
     */
    const writeSegmentPrompt = async (
        episodeId: string,
        segmentId: string,
        options?: { artStyle?: string; skillContent?: string; skillName?: string; previousEnding?: string; performanceIntensity?: number; cameraDynamics?: number; independent?: boolean; model?: string; reasoningEffort?: string },
    ) => {
        const ep = rawEpisodes.find((item) => item.id === episodeId);
        if (!ep?.canvasId) throw new Error("本集画布尚未就绪，请先在画布中打开本集");
        const prod = (await fetchEpisodeProduction(episodeId)).production;
        const draft = (prod.draft || {}) as Record<string, any>;
        const dir = draft.director || {};
        const source = (dir.source || {}) as Record<string, any>;
        const scenes = (Array.isArray(source.scene_registry) ? source.scene_registry : []) as any[];
        const fps = (Number(source.fps_num || 24) / Number(source.fps_den || 1)) || 24;

        // 段与所属镜头
        const groups = (Array.isArray(draft.clipGroups) ? draft.clipGroups : []) as any[];
        const group = groups.find((g) => String(g.id) === segmentId) || null;
        const segs = (Array.isArray(source.segments) ? source.segments : []) as any[];
        const segIndex = segs.findIndex((s) => String(s.id) === segmentId);
        const seg = segs[segIndex] || null;
        if (!seg && !group) throw new Error("找不到该段制作数据");
        const shotIds: string[] = (Array.isArray(seg?.shot_ids) ? seg.shot_ids : Array.isArray(group?.shot_ids) ? group.shot_ids : [])
            .map(String).filter(Boolean);
        const shotById = new Map<string, any>(((Array.isArray(source.shots) ? source.shots : []) as any[]).map((s) => [String(s.id), s]));
        const segShots = shotIds.map((id) => shotById.get(id)).filter(Boolean) as any[];

        // 台词：utterances 按 start.shotId 关联；说话人 subject → character_registry 名
        const charBySubject = new Map<string, string>();
        for (const subject of (Array.isArray(source.subject_registry) ? source.subject_registry : []) as any[]) {
            const refId = String(subject?.entityRef?.id || "");
            const entity = ((Array.isArray(source.character_registry) ? source.character_registry : []) as any[])
                .find((c) => String(c.id) === refId || String(c.entity_id) === refId);
            if (refId && entity) charBySubject.set(refId, String(entity.name || ""));
        }
        const uttByShot = new Map<string, any[]>();
        for (const u of (Array.isArray(source.utterances) ? source.utterances : []) as any[]) {
            const sid = String(u?.start?.shotId || "");
            if (!sid) continue;
            const arr = uttByShot.get(sid) || [];
            arr.push(u);
            uttByShot.set(sid, arr);
        }

        // 参考图编号（h3 artifact.references 的 Picture N）
        const artifact = ((Array.isArray(dir.artifacts) ? dir.artifacts : []) as any[])
            .find((a) => a?.kind === "h3" && String(a.targetId) === segmentId);
        const refNums = ((Array.isArray(artifact?.references) ? artifact.references : []) as any[])
            .map((r) => Number(String(r?.label || "").match(/Picture\s*(\d+)/i)?.[1] || 0))
            .filter((n) => n > 0);
        const firstShot = segShots[0] || {};
        const scene = scenes.find((sc) => String(sc.id) === String(firstShot.scene_id));
        const title = String(seg?.summary || seg?.title || firstShot.title || scene?.name || `第 ${segIndex + 1} 段`);

        // 段内镜头时间码：按 duration_frames 累计（shot 无全局起始帧字段）。
        let cursorFrame = 0;
        const writerShots: SegmentWriterShot[] = segShots.map((sh) => {
            const frames = Math.max(1, Number(sh.duration_frames || 0));
            const startFrame = cursorFrame;
            cursorFrame += frames;
            const cam = sh.camera && typeof sh.camera === "object" ? sh.camera : {};
            const cameraText = [cam.framing && `景别 ${cam.framing}`, cam.movement && `运镜 ${cam.movement}`, cam.angle && `机位 ${cam.angle}`].filter(Boolean).join("，");
            const utts = uttByShot.get(String(sh.id)) || [];
            const dialogue = utts.map((u) => {
                const speaker = charBySubject.get(String(u.speakerSubjectId || "")) || String(u.speakerName || "");
                return `${speaker ? `${speaker}：` : ""}${String(u.text || "")}`;
            }).join(" ");
            return {
                startSec: startFrame / fps,
                endSec: (startFrame + frames) / fps,
                visual: String(sh.visual || "").trim() || title,
                camera: cameraText || undefined,
                dialogue: dialogue || undefined,
                references: refNums.length ? refNums : undefined,
            };
        });
        if (!writerShots.length) throw new Error("该段没有可用镜头，无法撰写提示词");
        const totalSec = writerShots.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);

        // 表演强度 / 运镜动感：设置页 1-10 档映射为 segment-writer 的表演/运镜风格文字（后端契约 style/cameraMotion 已支持，此前设置存了没人读）。
        const perf = Math.max(1, Math.min(10, Number(options?.performanceIntensity ?? 5)));
        const cam = Math.max(1, Math.min(10, Number(options?.cameraDynamics ?? 5)));
        const styleText = perf <= 2 ? "表演克制内敛，情绪只在眼神与细微表情变化"
            : perf <= 4 ? "表演自然收敛，情绪变化有分寸不夸张"
            : perf <= 6 ? "表演自然到位，情绪变化落在线条与呼吸上，像在演戏"
            : perf <= 8 ? "表演投入饱满，情绪外放但有层次，面部表情与肢体同步"
            : "表演强烈张力，情绪大幅起伏，表情与身体语言充分夸张";
        const cameraText = cam <= 2 ? "运镜以稳定静态机位为主，几乎不运动"
            : cam <= 4 ? "运镜克制，仅缓慢推拉，稳而有分寸"
            : cam <= 6 ? "运镜有明确动机，稳中带动感，跟随人物动作"
            : cam <= 8 ? "运镜灵活，推拉摇移配合节奏，增强画面动势"
            : "运镜强烈动感，跟拍环绕甩镜并用，节奏凌厉";

        const input: SegmentWriterInput = {
            index: Math.max(0, segIndex),
            count: segs.length || groups.length,
            title,
            totalSec,
            shots: writerShots,
            artStyle: options?.artStyle || "",
            style: styleText,
            cameraMotion: cameraText,
            skillContent: options?.skillContent,
            skillName: options?.skillName,
            previousEnding: options?.previousEnding,
            // 尾帧接续能力本地已有：非首段默认带上一镜尾帧作为首帧；并行出片(independent)时不带首帧。
            firstFrame: segIndex > 0 && !options?.independent,
            independent: Boolean(options?.independent),
            referenceCount: refNums.length,
        };
        const built = buildSegmentWriterPrompt(input);

        // 「视频提示词」模型：优先用制作设置里选的 videoPromptModel（前端直传，真实生效）。
        let model = resolveModelForCapability(config, config.textModel, "text");
        const chosen = String(options?.model || "").trim();
        if (chosen && resolveModelForCapability(config, chosen, "text") === chosen) model = chosen;
        if (!model) throw new Error("没有可用的文本模型");

        const started = await startCanvasGeneration({
            mode: "text", model,
            prompt: [built.system, "", built.user].join("\n"), count: 1,
            ...(options?.reasoningEffort ? { params: { reasoningEffort: options.reasoningEffort } } : {}),
        });
        const deadline = Date.now() + 180_000;
        let raw = "";
        for (;;) {
            const { task } = await fetchBackendTask(started.taskId);
            if (!task) throw new Error("撰写任务不存在");
            if (task.status === "succeeded") {
                raw = ((task.result?.texts || []) as any[]).map((t: any) => String(t.content || "")).join("\n").trim();
                break;
            }
            if (task.status === "failed" || task.status === "cancelled") throw new Error((task as any).error || "撰写失败");
            if (Date.now() > deadline) throw new Error("撰写超时");
            await new Promise((r) => setTimeout(r, 1500));
        }
        if (!raw) throw new Error("模型没有返回提示词");
        const promptText = cleanWrittenPrompt(raw);
        const warnings = unknownReferenceTokens(promptText, refNums.length);

        // 写回画布 H3 clip.prompt（与手动保存共用同一条真实链路）；LLM 撰写不是手写，custom=false。
        await saveSegmentPrompt(episodeId, segmentId, promptText, false);
        return { text: promptText, warnings };
    };

    /**
     * 影策 review 放行门：检查本集资产参考图是否全部就绪（asset_plan 中每个资产都要有
     * subject_registry.pictureBindings 绑定），全部就绪才写 episode 级放行状态到
     * director.workflow.reviewApproval（真实字段，set_director_workflow passthrough）。
     * 本地没有服务端 worker，放行后仍由画布按段生成——按钮文案如实说明，不伪装自动出片。
     */
    const approveEpisodeVideo = async (episodeId: string) => {
        const prod = (await fetchEpisodeProduction(episodeId)).production;
        const draft = (prod.draft || {}) as Record<string, any>;
        const dir = draft.director || {};
        const source = (dir.source || {}) as Record<string, any>;
        const assetPlan = (Array.isArray(source.asset_plan) ? source.asset_plan : []) as any[];
        const boundAssetIds = new Set<string>();
        for (const sub of (Array.isArray(source.subject_registry) ? source.subject_registry : []) as any[]) {
            const bindings = Array.isArray(sub?.pictureBindings) ? sub.pictureBindings : [];
            if (bindings.length) {
                const aid = String(sub?.entityRef?.id || sub?.id || "");
                if (aid) boundAssetIds.add(aid);
                // pictureBindings[].assetId 也是绑定来源
                for (const b of bindings) if (b?.assetId) boundAssetIds.add(String(b.assetId));
            }
        }
        const missing = assetPlan.filter((a) => {
            const ids = [String(a?.id || ""), String(a?.asset_id || ""), String(a?.entity_id || "")].filter(Boolean);
            return !ids.some((id) => boundAssetIds.has(id));
        }).map((a) => String(a?.asset_name || a?.id || ""));
        if (missing.length) return { ok: false as const, missing, assetCount: assetPlan.length };

        const segments = (Array.isArray(source.segments) ? source.segments : []).length;
        await editEpisodeProduction(episodeId, prod.revision, [{
            type: "set_director_workflow",
            patch: { reviewApproval: { approvedAt: new Date().toISOString(), assetCount: assetPlan.length, segmentCount: segments, by: "user" } },
        } as never]);
        await refreshAll();
        return { ok: true as const, missing: [] as string[], assetCount: assetPlan.length };
    };

    /** 影策 render：合成成功后把成片 storageKey 落库到 episode 级 workflow.finalResource。 */
    const saveFinalResource = async (episodeId: string, storageKey: string, durationSec?: number) => {
        const prod = (await fetchEpisodeProduction(episodeId)).production;
        await editEpisodeProduction(episodeId, prod.revision, [{
            type: "set_director_workflow",
            patch: { finalResource: { storageKey, at: new Date().toISOString(), stale: false, ...(durationSec ? { durationSec } : {}) } },
        } as never]);
        await refreshAll();
    };

    /** 影策：改本集标题（后端 PATCH /drama/episodes/:id 已支持 title，仅 UI 未接）。 */
    const renameEpisode = async (episodeId: string, title: string) => {
        const clean = String(title || "").trim();
        if (!clean) throw new Error("标题不能为空");
        await updateBackendDramaEpisode(episodeId, { title: clean });
        await episodesQuery.refetch();
    };

    /**
     * 段 → 画布 H3 目标解析。generation_logs.segmentId 用的是画布 Clip id（clip-xxx），
     * 而制作台 card.id 是制作稿 segment id（productionClipProjection.targetId）——两者不同，
     * 必须先解析再查日志/写回，否则查到 0 条（本地真实数据已核实）。
     */
    const resolveSegmentCanvasTarget = async (episodeId: string, segmentId: string) => {
        const ep = rawEpisodes.find((item) => item.id === episodeId);
        if (!ep?.canvasId) throw new Error("本集画布尚未就绪，请先在画布中打开本集");
        const projectRes = await fetchBackendProject(ep.canvasId);
        const project = ((projectRes as any).project || projectRes) as Record<string, any>;
        const draft = (((await fetchEpisodeProduction(episodeId)).production?.draft || {}) as Record<string, any>);
        const groups = (Array.isArray(draft.clipGroups) ? draft.clipGroups : []) as any[];
        const group = groups.find((g) => String(g?.id) === segmentId) || null;
        let nodeId = String(group?.nodeId || "");
        let canvasSegmentId = String(group?.segmentId || "");
        if (!nodeId || !canvasSegmentId) {
            outer: for (const n of (Array.isArray(project?.nodes) ? project.nodes : []) as any[]) {
                if (!String(n?.type || "").includes("minimax-h3")) continue;
                for (const cs of ((Array.isArray(n?.metadata?.segments) ? n.metadata.segments : []) as any[])) {
                    if (String(cs?.productionClipProjection?.targetId || "") === segmentId) {
                        nodeId = String(n.id);
                        canvasSegmentId = String(cs.id);
                        break outer;
                    }
                }
            }
        }
        if (!nodeId || !canvasSegmentId) throw new Error("该段尚未同步到画布 H3 节点，请先在画布中打开本集重新编译后再操作");
        return { canvasId: ep.canvasId, nodeId, canvasSegmentId, project, draft };
    };

    /** 段视频版本列表：真实 generation_logs + 画布当前 resultStorageKey，按 startedAt 倒序。 */
    const listSegmentVideoVersions = async (episodeId: string, segmentId: string): Promise<StudioSegmentVersion[]> => {
        const target = await resolveSegmentCanvasTarget(episodeId, segmentId);
        const node = ((Array.isArray(target.project.nodes) ? target.project.nodes : []) as any[])
            .find((n) => String(n?.id) === target.nodeId);
        const segments = (Array.isArray(node?.metadata?.segments) ? node.metadata.segments : []) as any[];
        const clip = segments.find((s) => String(s?.id) === target.canvasSegmentId);
        const currentKey = String(clip?.resultStorageKey || "");
        // restore_h3_output 真实写回时在当前 results 条目上落了 source=restore（见 db.restoreH3OutputOperation）。
        const currentResults = Array.isArray(clip?.results) ? clip.results as Record<string, unknown>[] : [];
        const currentResultSource = String((currentResults.find((r) => String(r?.storageKey || "") === currentKey) || {})?.source || "");
        const response = await fetchBackendGenerationLogs({ segmentId: target.canvasSegmentId, projectId: target.canvasId, limit: 200, mediaDuration: true });
        const logs = Array.isArray(response.logs) ? response.logs : [];
        // 无成片时长时的兜底真值：本段涉及镜头的 duration_frames / fps（只从真实制作稿派生，段未记录则 null）。
        const draftSource = (target.draft?.director as Record<string, unknown> | undefined)?.source ?? target.draft?.source;
        const draftGroups = Array.isArray(target.draft?.clipGroups) ? target.draft.clipGroups as Array<Record<string, unknown>> : [];
        const draftGroup = draftGroups.find((g) => String(g?.id) === segmentId);
        const sourceSegments = Array.isArray((draftSource as Record<string, unknown> | undefined)?.segments)
            ? ((draftSource as Record<string, unknown>).segments as Array<Record<string, unknown>>) : [];
        const shotIds = (Array.isArray(draftGroup?.shotIds) ? draftGroup.shotIds : Array.isArray(draftGroup?.shot_ids) ? draftGroup.shot_ids
            : Array.isArray(sourceSegments.find((s) => String(s?.id) === segmentId)?.shot_ids) ? sourceSegments.find((s) => String(s?.id) === segmentId)!.shot_ids : []) as string[];
        const shotsSec = shotsDurationSecOf(draftSource, shotIds.map(String));
        // Vn 编号按时间升序打在「成功且有视频产物」的日志上，再整体倒序展示（最新在前）。
        let successNo = 0;
        const rows = logs.slice().sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || ""))).map((log) => {
            const outputs = Array.isArray(log.outputs) ? log.outputs : [];
            const videoOutput = outputs.find((o) => String((o as any)?.mimeType || "").startsWith("video/")
                || String((o as any)?.storageKey || "").startsWith("video:")) as Record<string, unknown> | undefined;
            const status = String(log.status || "").toLowerCase();
            const success = (status === "success" || status === "succeeded") && Boolean(videoOutput);
            if (success) successNo += 1;
            const storageKey = String(videoOutput?.storageKey || "");
            // 顶层 log.durationMs 是生成耗时，不是视频时长；视频时长只取产物 durationMs（媒体真值）或镜头帧数兜底。
            const duration = deriveSegmentVersionDuration(videoOutput?.durationMs, shotsSec);
            return {
                id: String(log.id),
                version: success ? successNo : null,
                startedAt: String(log.startedAt || ""),
                model: String(log.model || ""),
                taskMode: String(log.taskMode || ""),
                status: String(log.status || ""),
                error: log.error ? String(log.error) : "",
                source: storageKey && storageKey === currentKey && currentResultSource === "restore"
                    ? "restore"
                    : deriveGenerationSource(log),
                storageKey,
                url: storageKey ? backendMediaUrl(storageKey) : "",
                current: Boolean(storageKey && storageKey === currentKey),
                durationSec: duration.durationSec,
                durationSource: duration.durationSource,
            } satisfies StudioSegmentVersion;
        });
        // 画布 Clip 自己留存的结果（H3 节点/插件写入 results[]）：生成日志被裁剪、或画布内直接出图时，
        // 这是唯一还留着的老版本真值；只补日志里没有的 storageKey，不重复、不编号、不改来源。
        const knownKeys = new Set(rows.map((r) => r.storageKey).filter(Boolean));
        const canvasKept = currentResults
            .map((r) => ({
                id: `canvas:${String(r.storageKey || "")}`,
                version: null,
                startedAt: "",
                model: "",
                taskMode: "",
                status: "success",
                error: "",
                source: (String(r.source || "canvas") || "canvas") as StudioVersionSource,
                storageKey: String(r.storageKey || ""),
                url: String(r.storageKey || "") ? backendMediaUrl(String(r.storageKey)) : "",
                current: Boolean(String(r.storageKey || "") && String(r.storageKey) === currentKey),
                durationSec: null,
                durationSource: null,
                canvasKept: true,
            } satisfies StudioSegmentVersion))
            .filter((r) => r.storageKey && !knownKeys.has(r.storageKey));
        return [...canvasKept, ...rows].reverse();
    };

    /**
     * 影策「设为当前」真实写回：restore_h3_output 是后端专用的历史结果还原 op，
     * 它会校验 generationLog 归属/视频产物/归档媒体，再把 resultStorageKey、results、result、
     * status、progress 等运行字段写到画布 H3 Clip（直接 patch resultStorageKey 会被
     * operation-authority 的 H3_RUNTIME_SEGMENT_FIELDS 拒绝）。settings 传空 = 保留当前
     * 提示词与 H3 参数，只切换视频版本，与 H3 插件 formal Clip 的语义一致。
     * 只有画布 Clip 留存、日志已无记录的版本（id 以 canvas: 开头）不带日志凭证，后端按 storageKey 校验留存。
     */
    const setSegmentCurrentVideo = async (episodeId: string, segmentId: string, version: StudioSegmentVersion) => {
        if (!version.storageKey) throw new Error("该版本没有可用的视频产物，不能设为当前");
        const target = await resolveSegmentCanvasTarget(episodeId, segmentId);
        const hasLog = !version.id.startsWith("canvas:");
        // 正式 Clip 且有日志凭证时走 select_director_result：它在同一事务写草稿选用回执（clipGroups[].selectedResult）
        // 并下发 restore_h3_output 切画布输出，制作台与画布历史选用才一致。无日志的画布留存版本仍只还原画布。
        if (hasLog && segmentId) {
            try {
                const prod = (await fetchEpisodeProduction(episodeId)).production;
                await editEpisodeProduction(episodeId, Number(prod?.revision || 0), [{
                    type: "select_director_result", targetKind: "segment", targetId: segmentId,
                    nodeId: target.nodeId, generationLogId: version.id, storageKey: version.storageKey,
                    canvasRevision: Number(target.project.revision || 0),
                }]);
                await refreshAll();
                return;
            } catch {
                // 归属/版本校验不通过时回落为画布还原，不阻断用户切版本；选用状态仍保留原值待核对。
            }
        }
        await applyBackendCanvasOperations(target.canvasId, [{
            type: "restore_h3_output",
            nodeId: target.nodeId,
            segmentId: target.canvasSegmentId,
            generationLogId: hasLog ? version.id : "",
            storageKey: version.storageKey,
            settings: {},
        }], Number(target.project.revision || 0));
        await refreshAll();
    };

    /**
     * 读本集每段 H3 Clip 当前自选的视频模型，按制作稿 segment id（productionClipProjection.targetId）索引。
     * 画布段的模型真值在 metadata.segments[].selectedVideoModel，制作稿 draft 里没有这份字段，
     * 所以必须定向 fetch 画布 project 再按 targetId 对齐（与写回、日志查询共用同一映射）。
     * 没选过模型的段不出现在结果里，界面回落显示全局默认（config.videoModel），全局也为空才用 H3 展开流。
     */
    const listSegmentVideoModels = async (episodeId: string): Promise<Record<string, string>> => {
        const ep = rawEpisodes.find((item) => item.id === episodeId);
        if (!ep?.canvasId) return {};
        const projectRes = await fetchBackendProject(ep.canvasId);
        const project = ((projectRes as any).project || projectRes) as Record<string, any>;
        const out: Record<string, string> = {};
        for (const n of (Array.isArray(project?.nodes) ? project.nodes : []) as any[]) {
            if (!String(n?.type || "").includes("minimax-h3")) continue;
            for (const cs of (Array.isArray(n?.metadata?.segments) ? n.metadata.segments : []) as any[]) {
                const targetId = String(cs?.productionClipProjection?.targetId || "");
                const model = String(cs?.selectedVideoModel || "").trim();
                if (targetId && model) out[targetId] = model;
            }
        }
        return out;
    };

    /**
     * 切换单段的出片视频模型：写画布 H3 Clip 的 selectedVideoModel（段级真值，影响出片）。
     * 同时写 selectedVideoModelEnabled:true —— 画布 H3 现在只保留「自选视频模型」一条链路，
     * 缺这个标志 resolveH3Runtime 会退回原生 H3，表现为「切了不生效」。
     */
    const setSegmentVideoModel = async (episodeId: string, segmentId: string, model: string) => {
        const target = await resolveSegmentCanvasTarget(episodeId, segmentId);
        await applyBackendCanvasOperations(target.canvasId, [{
            type: "update_h3_segment", nodeId: target.nodeId, segmentId: target.canvasSegmentId,
            patch: { selectedVideoModel: model, selectedVideoModelEnabled: true },
        }], Number(target.project.revision || 0));
        await refreshAll();
    };

    const toggleBatch = async (runId: string, action: "pause" | "resume") => {
        if (!episodeId) return;
        if (action === "pause") await pauseProductionBatch(episodeId, runId);
        else await resumeProductionBatch(episodeId, runId);
        await batchesQuery.refetch();
    };

    /** 首屏/详情加载门控：React Query v5 中 enabled=false（未连接/无 id）的 query 也处于 isPending，
     *  所以只有「真正启用」的 query 才算未就绪，避免断线时永久 loading。
     *  episodes[]/assets/inbox 等派生在数据未到时仍是空数组（保持调用方类型不变），
     *  调用方用下面的 loading/detailLoading 做门控，不要把空数组当成「确认无数据」。 */
    const pendingWhenEnabled = (query: { isPending: boolean }, queryEnabled: boolean): boolean =>
        queryEnabled && query.isPending;
    const detailReady = connected && Boolean(episodeId);
    const anyPendingProduction = productionQueries.some(
        (q, i) => connected && Boolean(rawEpisodes[i]?.canvasId) && q.isPending,
    );

    // 首屏并发查询全部扇入：任一尚未回包就保持 loading=true，消除「数据全空但 loading=false」窗口。
    const dataPending =
        pendingWhenEnabled(episodesQuery, enabled)
        || pendingWhenEnabled(stageQuery, enabled)
        || pendingWhenEnabled(sourceChaptersQuery, enabled)
        || pendingWhenEnabled(assetsQuery, enabled)
        || pendingWhenEnabled(logsQuery, enabled)
        || pendingWhenEnabled(clipMediaQuery, detailReady);
    // 详情查询同理；clipMedia 与逐集 production 也计入，避免详情骨架先于内容消失。
    const detailPending =
        pendingWhenEnabled(productionQuery, detailReady)
        || pendingWhenEnabled(batchesQuery, detailReady)
        || pendingWhenEnabled(clipMediaQuery, detailReady)
        || anyPendingProduction;

    return {
        dramaId, episodeId, episodes, rawEpisodes, assets, stage, production, batches, counts, queue,
        jobCounts, inbox, productionState, clipMedia, clipFailureByTarget,
        sourceChapterTruth, bibleReady, firstSampleReady,
        loading: dataPending,
        detailLoading: detailPending,
        error: episodesQuery.error || stageQuery.error || productionQuery.error || batchesQuery.error,
        connected,
        refreshAll, addEpisode, batchCreateEpisodes, insertEpisode, removeEpisode, adaptEpisode, extractEpisodeAssets, writeSegmentPrompt, saveSegmentPrompt, approveEpisodeVideo, saveFinalResource, renameEpisode, toggleBatch,
        listSegmentVideoVersions, setSegmentCurrentVideo, listSegmentVideoModels, setSegmentVideoModel,
    };
}
