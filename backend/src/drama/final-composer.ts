/**
 * 成片自动重合成（影策 finalStale 真链路）。
 *
 * 影策真值：段视频产物更新后，后端自动重新合成成片；finalResource 是成片真值。
 * 本模块复用既有后端合成能力 VideoConcatBackend（与 pipeline.runRender /
 * POST /agent/video-concat/tasks 同一个 ffmpeg 拼接引擎），不另造合成逻辑。
 *
 * 触发：canvas-h3-run 父任务 task.completed（段视频已全部回写）→ index.ts 订阅 →
 * recomposeIfStale(episodeId)。只有「成片已存在且确实过期」才动手。
 */
import { createHash } from "node:crypto";
import type { RuntimeTask, TaskStore } from "../engine-contract/contracts.js";

export type FinalResource = { storageKey?: string; at?: string; stale?: boolean; durationSec?: number };

/** 段视频产物事实（与 web deriveFinalStale 同口径）。 */
export type SegmentVideoArtifact = {
    storageKey?: string;
    inputOutdated?: boolean;
    /** 产出该视频的 generation_log.finishedAt（缺失则不参与时间对账，不猜时间）。 */
    generatedAt?: string;
};

const STALE_TOLERANCE_MS = 1000;

function productionFinal(draft: unknown): FinalResource | undefined {
    const workflow = (draft as Record<string, any> | undefined)?.director?.workflow;
    return workflow?.finalResource as FinalResource | undefined;
}

/**
 * 成片是否过期（与 web/src/pages/drama-studio/use-studio-data.ts deriveFinalStale 完全一致）：
 * - 没有成片产物就不谈过期；
 * - 任一段被按输入 hash 标成 inputOutdated → 旧版；
 * - 任一段视频的产生时刻晚于 finalResource.at（+1s 容差）→ 旧版。
 * finalResource.stale 只在合成当时写 false，全仓没有翻 true 的链路，不作为真值。
 */
export function isFinalStale(final: FinalResource | undefined, segments: readonly SegmentVideoArtifact[]): boolean {
    if (!final?.storageKey) return false;
    if (segments.some((segment) => segment.inputOutdated === true)) return true;
    if (!final.at) return false;
    const composed = Date.parse(final.at);
    if (!Number.isFinite(composed)) return false;
    return segments.some((segment) => {
        if (!segment.generatedAt) return false;
        const produced = Date.parse(segment.generatedAt);
        return Number.isFinite(produced) && produced > composed + STALE_TOLERANCE_MS;
    });
}

/** 与 pipeline.runRender 完全一致的段视频收集顺序：H3 段 resultStorageKey + results[].storageKey，去重保序。 */
export function collectFinalVideos(canvas: Record<string, any> | null | undefined): string[] {
    const nodes = Array.isArray(canvas?.nodes) ? canvas!.nodes as Array<Record<string, any>> : [];
    const videos: string[] = [];
    for (const node of nodes) {
        const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments as Array<Record<string, any>> : [];
        for (const segment of segments) {
            const key = String(segment?.resultStorageKey || "");
            if (key) videos.push(key);
            for (const result of (Array.isArray(segment?.results) ? segment.results : [])) {
                const rk = String((result as Record<string, any>)?.storageKey || "");
                if (rk) videos.push(rk);
            }
        }
    }
    return [...new Set(videos)].filter(Boolean);
}

export type DbLike = {
    getDramaEpisode(id: string): { id: string; canvasId?: string | null } | null;
    getCanvasProject(id: string): Record<string, any> | null;
    getGenerationLog(id: string): { finishedAt?: string; startedAt?: string } | null;
};

export type ProductionLike = {
    get(id: string): { revision: number; draft?: unknown };
    edit(id: string, raw: unknown): unknown | Promise<unknown>;
};

export type VideoConcatLike = {
    run(videos: string[], output?: string, longEdge?: number | "auto", clientTaskId?: string, parentTaskId?: string, layout?: unknown): Promise<RuntimeTask>;
};

export type RecomposeDeps = {
    db: DbLike;
    production: ProductionLike;
    videoConcat: VideoConcatLike;
    tasks: Pick<TaskStore, "get">;
    events?: { publish(event: Record<string, unknown>): unknown };
    now?: () => string;
    pollMs?: number;
    timeoutMs?: number;
};

export type RecomposeResult =
    | { status: "composed"; episodeId: string; storageKey: string; at: string; videos: number }
    | { status: "skipped"; episodeId: string; reason: "no-episode" | "no-final" | "no-videos" | "not-stale" }
    | { status: "busy"; episodeId: string }
    | { status: "failed"; episodeId: string; error: string };

/**
 * 从画布真实产物派生「段时间」并判断成片是否过期。
 * 时间只取 generation_logs 的 finishedAt/startedAt，查不到就不参与（不猜）。
 */
export function segmentArtifacts(canvas: Record<string, any> | null | undefined, db: DbLike): SegmentVideoArtifact[] {
    const nodes = Array.isArray(canvas?.nodes) ? canvas!.nodes as Array<Record<string, any>> : [];
    const artifacts: SegmentVideoArtifact[] = [];
    for (const node of nodes) {
        const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments as Array<Record<string, any>> : [];
        for (const segment of segments) {
            const key = String(segment?.resultStorageKey || "");
            let generatedAt = "";
            for (const result of (Array.isArray(segment?.results) ? segment.results : [])) {
                const logId = String((result as Record<string, any>)?.generationLogId || "");
                if (!logId) continue;
                const log = db.getGenerationLog(logId);
                generatedAt = String(log?.finishedAt || log?.startedAt || "");
                if (generatedAt) break;
            }
            artifacts.push({
                ...(key ? { storageKey: key } : {}),
                inputOutdated: segment?.inputOutdated === true,
                ...(generatedAt ? { generatedAt } : {}),
            });
        }
    }
    return artifacts;
}

function concatStorageKey(result: Record<string, unknown> | null | undefined): string {
    const media = result?.media as Record<string, unknown> | undefined;
    return String(media?.storageKey || result?.storageKey || media?.url || "");
}

function videosFingerprint(videos: readonly string[]): string {
    return createHash("sha256").update(videos.join("\n")).digest("hex").slice(0, 16);
}

export class FinalComposer {
    private readonly composing = new Set<string>();
    private readonly now: () => string;
    private readonly pollMs: number;
    private readonly timeoutMs: number;

    constructor(private readonly deps: RecomposeDeps) {
        this.now = deps.now || (() => new Date().toISOString());
        this.pollMs = deps.pollMs ?? 300;
        this.timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000;
    }

    /** 当前是否正在为某集合成（供触发层去重/观测）。 */
    isComposing(episodeId: string): boolean { return this.composing.has(episodeId); }

    private async waitTerminal(taskId: string): Promise<RuntimeTask> {
        const deadline = Date.now() + this.timeoutMs;
        for (;;) {
            const task = this.deps.tasks.get(taskId);
            if (!task) throw new Error(`RECOMPOSE_TASK_MISSING: ${taskId}`);
            if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return task;
            if (Date.now() >= deadline) throw new Error(`RECOMPOSE_TIMEOUT: ${taskId}`);
            await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        }
    }

    /**
     * 当成片已存在且相关段视频更新/inputOutdated 时自动重新合成。
     * 幂等：按 (episodeId, 视频集合) 复用视频拼接任务；合成中（composing）重复触发直接跳过；
     * 合成后 finalResource.at 刷新，后续重复触发因不再 stale 而跳过。
     */
    async recomposeIfStale(episodeId: string, opts?: { force?: boolean }): Promise<RecomposeResult> {
        if (this.composing.has(episodeId)) return { status: "busy", episodeId };
        const episode = this.deps.db.getDramaEpisode(episodeId);
        if (!episode?.canvasId) return { status: "skipped", episodeId, reason: "no-episode" };

        const production = this.deps.production.get(episodeId);
        const final = productionFinal(production?.draft);
        // 关键口径：只在「成片已存在」时自动重合成；从没合成过的集不擅自合成。
        if (!final?.storageKey) return { status: "skipped", episodeId, reason: "no-final" };

        const canvas = this.deps.db.getCanvasProject(episode.canvasId);
        const videos = collectFinalVideos(canvas);
        if (!videos.length) return { status: "skipped", episodeId, reason: "no-videos" };

        if (!opts?.force && !isFinalStale(final, segmentArtifacts(canvas, this.deps.db))) {
            return { status: "skipped", episodeId, reason: "not-stale" };
        }

        this.composing.add(episodeId);
        try {
            const clientTaskId = `final-recompose-${episodeId}-${videosFingerprint(videos)}`;
            const started = await this.deps.videoConcat.run(videos, "", "auto", clientTaskId, undefined, "sequence");
            const task = await this.waitTerminal(started.id);
            if (task.status !== "succeeded") throw new Error(task.error || `RECOMPOSE_${task.status.toUpperCase()}`);
            const storageKey = concatStorageKey(task.result);
            if (!storageKey) throw new Error("RECOMPOSE_NO_RESULT: 合成任务没有产出 storageKey");

            const at = this.now();
            const current = this.deps.production.get(episodeId);
            await this.deps.production.edit(episodeId, {
                operationId: `final-recompose-${episodeId}-${at}`,
                expectedRevision: Number(current?.revision || 0),
                ops: [{ type: "set_director_workflow", patch: { finalResource: { storageKey, at, stale: false } } }],
            });
            this.deps.events?.publish({
                type: "final-recomposed",
                entityId: episodeId,
                payload: { episodeId, storageKey, at, videos: videos.length },
            });
            return { status: "composed", episodeId, storageKey, at, videos: videos.length };
        } catch (error) {
            return { status: "failed", episodeId, error: error instanceof Error ? error.message : String(error) };
        } finally {
            this.composing.delete(episodeId);
        }
    }
}
