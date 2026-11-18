import { useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    fetchBackendDramaEpisodes,
    fetchBackendDramaEpisode,
    fetchDramaStage,
    fetchEpisodeProduction,
    fetchProductionBatches,
    fetchBackendAssets,
    fetchBackendGenerationLogs,
    createBackendDramaEpisode,
    updateBackendDramaEpisode,
    deleteBackendDramaEpisode,
    requestEpisodeScriptProposal,
    fetchDramaPlanningSource,
    ensureEpisodeCanvas,
    startCanvasGeneration,
    fetchBackendTask,
    fetchBackendProject,
    applyBackendCanvasOperations,
    editEpisodeProduction,
    pauseProductionBatch,
    resumeProductionBatch,
    type DramaEpisode,
    type DramaStageReport,
    type EpisodeProduction,
    type ProductionBatch,
    type BackendGenerationLog,
} from "@/services/backend-api";
import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
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

export type StudioStatus = "待生成" | "需要处理" | "制作中" | "已完成";

/** 影策的每集阶段语义 */
export type StudioStage = "draft" | "script" | "assets" | "shots" | "video";

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
};

export type StudioAsset = {
    id: string;
    title: string;
    kind: string;
    coverUrl: string;
    storageKey: string;
    note: string;
};

/** 成片页真实片段产物（来自分集画布 H3 视频节点 resultStorageKey）。 */
export type StudioClipMedia = {
    id: string;
    title: string;
    storageKey: string;
    duration: number;
    status: string;
    inputOutdated: boolean;
};

/** 影策 inbox 待处理项 */
export type StudioInboxItem = {
    id: string;
    kind: "episode_error" | "stage_gap" | "job_failed";
    severity: "error" | "warning";
    title: string;
    detail: string;
    episodeId?: string;
    episodeNo?: number;
    segmentId?: string;
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

function deriveLogStat(logs: BackendGenerationLog[]): LogStat {
    let failed = 0, succeeded = 0, running = 0, lastError: string | null = null;
    for (const log of logs) {
        const status = String(log.status || "").toLowerCase();
        if (status === "success" || status === "succeeded") succeeded += 1;
        else if (status === "failed" || status === "error") {
            failed += 1;
            if (!lastError) lastError = String(log.error || "生成失败").slice(0, 160);
        } else if (["running", "pending", "queued"].includes(status)) running += 1;
    }
    return { failed, succeeded, running, lastError };
}

function deriveEpisode(
    ep: DramaEpisode,
    stageEp: { episodeNumber: number; stage: string | null; done: string[] } | undefined,
    logStat: LogStat,
    prodDerive: ReturnType<typeof deriveStageFromProduction>,
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
    const status: StudioStatus = prodDerive.publishedVersion > 0
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
    };
}

function toAsset(raw: unknown): StudioAsset | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return null;
    const data = (item.data && typeof item.data === "object" ? item.data : {}) as Record<string, unknown>;
    const metadata = (item.metadata && typeof item.metadata === "object" ? item.metadata : {}) as Record<string, unknown>;
    const note = typeof item.note === "string" ? item.note : typeof metadata.note === "string" ? metadata.note : "";
    return {
        id,
        title: typeof item.title === "string" ? item.title : id,
        kind: typeof item.kind === "string" ? item.kind : "image",
        coverUrl: typeof item.coverUrl === "string" ? item.coverUrl : "",
        storageKey: typeof data.storageKey === "string" ? data.storageKey : "",
        note,
    };
}

const emptyLogStat: LogStat = { failed: 0, succeeded: 0, running: 0, lastError: null };
const emptyProdDerive: ReturnType<typeof deriveStageFromProduction> = { stage: "draft", shotCount: 0, segmentCount: 0, publishedVersion: 0 };

export function useStudioData(dramaId: string | null, episodeId: string | null) {
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

    const assetsQuery = useQuery({
        queryKey: ["drama-studio-assets", backendUrl, dramaId],
        enabled,
        queryFn: async () => (await fetchBackendAssets({ dramaId: dramaId! })).assets || [],
    });

    // 全剧任务日志（summary 裁掉大列），用于 jobCounts / inbox / episode.error 派生
    const logsQuery = useQuery({
        queryKey: ["drama-studio-logs", backendUrl, dramaId],
        enabled,
        queryFn: async () => (await fetchBackendGenerationLogs({ limit: 500, summary: true })).logs || [],
    });

    // 每集制作稿：派生真实 stage / shotCount / segmentCount
    const rawEpisodes = episodesQuery.data || [];
    const productionQueries = useQueries({
        queries: rawEpisodes.map((ep) => ({
            queryKey: ["drama-studio-production", backendUrl, ep.id],
            enabled: connected && Boolean(ep.canvasId),
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

    /** 成片页：从分集画布的 H3 视频节点提取真实片段产物（resultStorageKey），对齐影策成片播放器/胶片条。 */
    const clipMediaQuery = useQuery({
        queryKey: ["drama-studio-clip-media", backendUrl, episodeId],
        enabled: Boolean(episodeId) && connected,
        queryFn: async (): Promise<StudioClipMedia[]> => {
            const detail = await fetchBackendDramaEpisode(episodeId!);
            const nodes = (detail.canvas?.nodes || []) as Array<Record<string, unknown>>;
            const out: StudioClipMedia[] = [];
            for (const node of nodes) {
                const type = String(node.type || "");
                if (!type.includes("h3") || type.includes("image")) continue;
                const meta = (node.metadata || {}) as Record<string, unknown>;
                const segs = Array.isArray(meta.segments) ? meta.segments : [];
                for (const seg of segs) {
                    const s = seg as Record<string, unknown>;
                    const key = String(s.resultStorageKey || "");
                    if (!key.startsWith("video:")) continue;
                    const results = Array.isArray(s.results) ? s.results : [];
                    const chosen = results.length ? results[results.length - 1] : s;
                    const r = chosen as Record<string, unknown>;
                    out.push({
                        id: String(s.id || String(node.id)),
                        title: String(s.title || node.title || "剧情段"),
                        storageKey: String(r.storageKey || key),
                        duration: Number(s.duration || 0),
                        status: String(s.status || ""),
                        inputOutdated: Boolean(s.inputOutdated),
                    });
                }
            }
            return out;
        },
    });

    // 只统计本剧分集画布的日志（generation-log.projectId === episode.canvasId），
    // 避免把全局日志算进本剧；同时过滤 [object Object] 这类无意义错误串。
    const logStatByCanvas = useMemo(() => {
        const canvasIds = new Set(rawEpisodes.map((ep) => ep.canvasId).filter(Boolean) as string[]);
        const map = new Map<string, LogStat>();
        for (const log of logsQuery.data || []) {
            const key = String(log.projectId || "");
            if (!key || !canvasIds.has(key)) continue;
            const stat = map.get(key) || { failed: 0, succeeded: 0, running: 0, lastError: null };
            const status = String(log.status || "").toLowerCase();
            if (status === "success" || status === "succeeded") stat.succeeded += 1;
            else if (status === "failed" || status === "error") {
                stat.failed += 1;
                const msg = String(log.error || "").trim();
                if (!stat.lastError && msg && msg !== "[object Object]") stat.lastError = msg.slice(0, 160);
            } else if (["running", "pending", "queued"].includes(status)) stat.running += 1;
            map.set(key, stat);
        }
        return map;
    }, [logsQuery.data, rawEpisodes]);

    // production 查询结果按索引对应 rawEpisodes
    const prodByEpisodeId = useMemo(() => {
        const map = new Map<string, EpisodeProduction | undefined>();
        rawEpisodes.forEach((ep, i) => map.set(ep.id, productionQueries[i]?.data as EpisodeProduction | undefined));
        return map;
    }, [rawEpisodes, productionQueries]);

    const episodes: StudioEpisode[] = useMemo(() => {
        const stageByNo = new Map<number, { episodeNumber: number; stage: string | null; done: string[] }>();
        for (const item of stageQuery.data?.episodes || []) stageByNo.set(item.episodeNumber, item);
        return rawEpisodes.slice().sort((a, b) => a.episodeNumber - b.episodeNumber).map((ep) => {
            const synopsis = String(ep.synopsis || "").trim();
            const hasScript = Boolean(String(ep.fullPlot || "").trim()) || (synopsis.length >= 40 && !synopsis.startsWith(SOURCE_PREFIX));
            const derive = deriveStageFromProduction(prodByEpisodeId.get(ep.id), hasScript);
            const stat = (ep.canvasId && logStatByCanvas.get(ep.canvasId)) || emptyLogStat;
            return deriveEpisode(ep, stageByNo.get(ep.episodeNumber), stat, derive);
        });
    }, [rawEpisodes, stageQuery.data, prodByEpisodeId, logStatByCanvas]);

    const assets: StudioAsset[] = useMemo(() => (assetsQuery.data || []).map(toAsset).filter((item): item is StudioAsset => Boolean(item)), [assetsQuery.data]);

    const stage: DramaStageReport | undefined = stageQuery.data;
    const production: EpisodeProduction | undefined = productionQuery.data;
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

    /** 影策 inbox：stage 缺口 + 每集生成错误，按集归并 */
    const inbox: StudioInboxItem[] = useMemo(() => {
        const items: StudioInboxItem[] = [];
        for (const ep of episodes) {
            if (ep.error) {
                items.push({
                    id: `episode:${ep.id}`,
                    kind: "episode_error",
                    severity: "error",
                    title: `第 ${ep.no} 集：${ep.title}`,
                    detail: ep.error,
                    episodeId: ep.id,
                    episodeNo: ep.no,
                });
            }
        }
        for (const state of stage?.states || []) {
            for (const gap of state.gaps || []) {
                items.push({
                    id: `gap:${state.key}:${gap}`,
                    kind: "stage_gap",
                    severity: state.key === "script" ? "warning" : "error",
                    title: `阶段缺口 · ${state.key}`,
                    detail: gap,
                });
            }
        }
        return items;
    }, [episodes, stage]);

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
            logsQuery.refetch(), productionQuery.refetch(), batchesQuery.refetch(), clipMediaQuery.refetch(),
            ...productionQueries.map((q) => q.refetch()),
        ]);
    };

    const addEpisode = async (title?: string) => {
        if (!dramaId) throw new Error("尚未选择剧目");
        const nextNo = episodes.reduce((max, ep) => Math.max(max, ep.no), 0) + 1;
        const result = await createBackendDramaEpisode(dramaId, { episodeNumber: nextNo, title: title || `第 ${nextNo} 集` });
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
    const insertEpisode = async (atNo: number, position: "before" | "after", title?: string, synopsis?: string) => {
        if (!dramaId) throw new Error("尚未选择剧目");
        const targetNo = position === "before" ? atNo : atNo + 1;
        const toShift = episodes.filter((ep) => ep.no >= targetNo).sort((a, b) => b.no - a.no);
        // 从后往前腾出集号，避免唯一约束冲突（若有）
        for (const ep of toShift) await updateBackendDramaEpisode(ep.id, { episodeNumber: ep.no + 1 });
        const result = await createBackendDramaEpisode(dramaId, {
            episodeNumber: targetNo,
            title: title || `第 ${targetNo} 集`,
            ...(synopsis ? { synopsis } : {}),
        });
        await Promise.all([episodesQuery.refetch(), stageQuery.refetch()]);
        return result.episode || null;
    };

    /** 影策：删除本集，后面集号前移 */
    const removeEpisode = async (episodeId: string) => {
        await deleteBackendDramaEpisode(episodeId);
        const removed = episodes.find((ep) => ep.id === episodeId);
        if (removed) {
            const toShift = episodes.filter((ep) => ep.no > removed.no).sort((a, b) => a.no - b.no);
            for (const ep of toShift) await updateBackendDramaEpisode(ep.id, { episodeNumber: ep.no - 1 });
        }
        await Promise.all([episodesQuery.refetch(), stageQuery.refetch(), logsQuery.refetch()]);
    };

    const adaptEpisode = async (targetId: string, instruction?: string) => {
        const proposal = await requestEpisodeScriptProposal(targetId, instruction ? { instruction } : {});
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
    const saveSegmentPrompt = async (episodeId: string, segmentId: string, promptText: string) => {
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
            patch: { prompt: promptText },
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

        // 写回画布 H3 clip.prompt（与手动保存共用同一条真实链路）
        await saveSegmentPrompt(episodeId, segmentId, promptText);
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

    const toggleBatch = async (runId: string, action: "pause" | "resume") => {
        if (!episodeId) return;
        if (action === "pause") await pauseProductionBatch(episodeId, runId);
        else await resumeProductionBatch(episodeId, runId);
        await batchesQuery.refetch();
    };

    return {
        dramaId, episodeId, episodes, rawEpisodes, assets, stage, production, batches, counts, queue,
        jobCounts, inbox, productionState, clipMedia: clipMediaQuery.data || [],
        loading: episodesQuery.isLoading || stageQuery.isLoading,
        detailLoading: productionQuery.isLoading || batchesQuery.isLoading,
        error: episodesQuery.error || stageQuery.error || productionQuery.error || batchesQuery.error,
        connected,
        refreshAll, addEpisode, batchCreateEpisodes, insertEpisode, removeEpisode, adaptEpisode, extractEpisodeAssets, writeSegmentPrompt, saveSegmentPrompt, approveEpisodeVideo, saveFinalResource, renameEpisode, toggleBatch,
    };
}
