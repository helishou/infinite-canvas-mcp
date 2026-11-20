import crypto from "node:crypto";
import { inspectH3Result } from "@basketikun/media-engine/canvas/h3-execution-contract";
import type { BackendDatabase, CanvasProject } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { GenerationLog } from "../engine-contract/contracts.js";
import type { Stores } from "../stores/types.js";

/**
 * 影策 `ReprocessDramaSegmentVideo` 的本地对应：视频已由模型生成并归档，
 * 但结果回写（规格核验后写回 Clip）失败时，只重放这段本地后处理。
 *
 * 全程不提交生成模型、不新建任务、不产生扣费：仅重新核验已归档媒体，
 * 核验通过后由 Backend 以 runtimeWrite 权威写回同一 storageKey（保留历史 results 与缓存身份）。
 */

export type VideoReprocessDeps = {
    db: BackendDatabase;
    stores: Stores;
    events?: BackendEventBus;
};

export class VideoReprocessFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly status = 400,
        readonly details: Record<string, unknown> = {},
    ) { super(message); }
}

export type VideoReprocessCandidate = {
    projectId: string;
    nodeId: string;
    segmentId: string;
    log: GenerationLog;
    output: Record<string, unknown>;
    storageKey: string;
    alreadyReady: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function videoOutput(log: GenerationLog): Record<string, unknown> | null {
    return log.outputs.find((item) =>
        String(item.mimeType || "video/mp4").startsWith("video/") && String(item.storageKey || "").trim()
    ) || null;
}

function segmentOf(project: CanvasProject, nodeId: string, segmentId: string) {
    const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String(item.id) === nodeId);
    if (!node) return null;
    const segments = record(node.metadata).segments;
    const list = Array.isArray(segments) ? segments : [];
    return list.find((item) => String(record(item).id || "") === segmentId) as Record<string, unknown> | undefined;
}

/** 只读定位「已生成但后处理失败」的 Clip；没有该失败态就明确拒绝，不造端点结果。 */
export function findReprocessableVideo(deps: VideoReprocessDeps, episodeId: string, segmentId: string): VideoReprocessCandidate {
    const { db } = deps;
    const episode = db.getDramaEpisode(episodeId);
    if (!episode) throw new VideoReprocessFailure("EPISODE_NOT_FOUND", "剧集不存在", 404);
    const projectId = String(episode.canvasId || "");
    if (!projectId) throw new VideoReprocessFailure("EPISODE_CANVAS_MISSING", "剧集尚未绑定画布，没有可重处理的视频", 409);
    const project = db.getCanvasProject(projectId);
    if (!project) throw new VideoReprocessFailure("CANVAS_MISSING", "剧集画布不存在", 404);

    // 只认有已归档视频输出的日志；没有输出说明模型就没产出视频，重处理无从谈起。
    const logs = db.listGenerationLogs({ projectId, segmentId, limit: 50 });
    const log = logs.find((item) => Boolean(item.nodeId && videoOutput(item)));
    if (!log) throw new VideoReprocessFailure(
        "NO_GENERATED_VIDEO",
        "本段没有已生成并归档的视频，请重新生成",
        409,
        { segmentId },
    );
    if (["queued", "running"].includes(log.status)) throw new VideoReprocessFailure(
        "GENERATION_IN_FLIGHT",
        "本段视频任务仍在运行，请等待终态后再处理",
        409,
        { taskId: log.runtimeTaskId },
    );

    const output = videoOutput(log)!;
    const storageKey = String(output.storageKey || "");
    const nodeId = String(log.nodeId || "");
    const segment = segmentOf(project, nodeId, segmentId);
    if (!segment) throw new VideoReprocessFailure("SEGMENT_NOT_FOUND", "Clip 已不存在，无法重处理", 409);

    const alreadyReady = log.status === "success"
        && String(segment.resultStorageKey || "") === storageKey
        && String(segment.status || "") === "success";
    if (alreadyReady) return { projectId, nodeId, segmentId, log, output, storageKey, alreadyReady: true };
    if (!["failed", "cancelled"].includes(log.status)) throw new VideoReprocessFailure(
        "NOT_POSTPROCESS_FAILURE",
        `本段视频状态为 ${log.status}，不是「已生成但后处理失败」，无需重处理`,
        409,
    );

    return { projectId, nodeId, segmentId, log, output, storageKey, alreadyReady: false };
}

/**
 * 重跑本地后处理：重新核验已归档媒体（ffprobe + 规格对比，纯本地、不调模型），
 * 通过才把同一 storageKey 重新写成 Clip 的当前结果，并把日志从 failed 收口为 success。
 */
export async function reprocessSegmentVideo(deps: VideoReprocessDeps, episodeId: string, segmentId: string) {
    const { db, stores, events } = deps;
    const candidate = findReprocessableVideo(deps, episodeId, segmentId);
    const { projectId, nodeId, log, output, storageKey } = candidate;

    if (candidate.alreadyReady) {
        return { ok: true as const, reprocessed: false, alreadyReady: true as const, code: "ALREADY_READY", message: "视频已经是当前结果，无需重处理", storageKey, revision: Number(db.getCanvasProject(projectId)?.revision || 0) };
    }

    const media = stores.media.meta(storageKey);
    if (!media) throw new VideoReprocessFailure("MEDIA_MISSING", "已生成的视频媒体已丢失，无法只重跑后处理，请重新生成", 409, { storageKey });

    // 用生成时冻结的参数重新核验。没有 h3ExecutionContract 的日志本就没有规格门槛，
    // inspectH3Result 直接原样返回，等于只重放结果回写。
    const task = log.runtimeTaskId ? stores.tasks.get(log.runtimeTaskId) : null;
    const params = task?.params && Object.keys(record(task.params)).length ? task.params : log.params;
    const checked = await inspectH3Result({ media: [output] }, params, stores.media);
    const specification = record(record(checked).specification);
    if (specification.status === "mismatch") throw new VideoReprocessFailure(
        "SPEC_STILL_MISMATCH",
        `重新核验后规格仍不符：${String(specification.issues || [])}；需要按规格修正输入后重新生成，重跑后处理不会改变媒体尺寸`,
        409,
        { storageKey, specification: { measured: specification.measured, expected: specification.expected, issues: specification.issues } },
    );
    if (specification.status === "unverified") throw new VideoReprocessFailure(
        "MEDIA_UNVERIFIABLE",
        `重新核验未能读取媒体：${String(specification.issues || [])}；修好 ffprobe/媒体路径后再重试`,
        409,
        { storageKey, issues: specification.issues },
    );

    const project = db.getCanvasProject(projectId)!;
    const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String(item.id) === nodeId);
    const segments = record(node && (node as Record<string, unknown>).metadata).segments;
    const allSegments = Array.isArray(segments) ? segments : [];
    const index = allSegments.findIndex((item) => String(record(item).id || "") === segmentId);
    const previousResults = Array.isArray(record(allSegments[index]).results) ? record(allSegments[index]).results as Array<Record<string, unknown>> : [];
    const results = [
        ...previousResults.filter((item) => String(item.storageKey || "") !== storageKey),
        { ...output, name: `Clip ${index + 1}`, ...(log.runtimeTaskId ? { taskId: log.runtimeTaskId } : {}), generationLogId: log.id },
    ];
    // Backend 权威写：runtimeWrite 允许改 status/result 等运行字段；保留历史 results 与 fingerprint，
    // 不让一次「只重跑后处理」抹掉该 Clip 过往产物和缓存身份。
    const committed = db.applyCanvasProjectOperations(projectId, Number(project.revision || 0), [{
        type: "update_h3_segment",
        nodeId,
        segmentId,
        patch: {
            result: `/media/${encodeURIComponent(storageKey)}`,
            resultStorageKey: storageKey,
            results,
            status: "success",
            progress: 1,
            runtimeTaskId: "",
            parentTaskId: "",
            errorDetails: "",
            firstPassReady: false,
        },
    }], {
        runtimeWrite: true,
        operationId: `reprocess-video:${crypto.randomUUID()}`,
        source: { kind: "system", label: "video-reprocess", episodeId, segmentId },
    });

    db.updateGenerationLog(log.id, {
        status: "success",
        error: "",
        outputs: [{ ...output, ...(Object.keys(specification).length ? { specification } : {}) }],
        finishedAt: new Date().toISOString(),
    });
    const updatedLog = db.getGenerationLog(log.id);
    if (updatedLog && events) events.publish({ type: "generation-log.updated", entityId: updatedLog.id, payload: updatedLog });

    return {
        ok: true as const,
        reprocessed: true as const,
        alreadyReady: false as const,
        code: "REPROCESSED",
        message: "已重新核验并回写已生成的视频，未重新生成、未扣费",
        episodeId, segmentId, projectId, nodeId,
        storageKey,
        generationLogId: log.id,
        revision: Number(committed?.revision ?? db.getCanvasProject(projectId)?.revision ?? 0),
        ...(Object.keys(specification).length ? { specification } : {}),
    };
}
