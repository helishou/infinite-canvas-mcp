import type { DirectorSubagentInput, DirectorSubagentSummary, DirectorSubagentResult } from "@basketikun/canvas-agent/agent/delegation";
/** 总后台 API client（Web 端）。 */

import { getBackendTokenShared } from "@/lib/backend-token";
import { backendConnection } from "@/lib/backend-connection";
import { coalesceInFlightRequest } from "@/lib/in-flight-request";
import { nanoid } from "nanoid";
import type { CanvasGenerationCommand, CanvasGenerationStartResult, CanvasLoopPrepare } from "@basketikun/canvas-agent/generation-contract";
import { CANVAS_GENERATION_PATH, CANVAS_LOOP_PREPARE_PATH, CANVAS_TASKS_PATH, canvasTaskActionPath, canvasTaskPath, h3ConfirmationPath } from "@basketikun/canvas-agent/generation-api";
import { ensureCanvasDraftLease } from "@/lib/canvas/canvas-draft-session";
import { browserOperationName, watchSlowBrowserOperation } from "@/lib/slow-operation-monitor";
import type { EpisodeProductionData, ProductionOperation, DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

export type BackendMediaResult = {
    storageKey: string;
    url: string;
    mimeType: string;
    filename?: string;
    bytes: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    compression?: { originalBytes: number; originalStorageKey: string; thresholdBytes: number };
};

export type BackendDetectedSceneCut = { frame: number; time: number };

export function detectVideoSceneCuts(projectId: string, nodeId: string, signal?: AbortSignal) {
    return request<{ ok: boolean; cuts: BackendDetectedSceneCut[] }>(
        "GET",
        `/canvas/projects/${encodeURIComponent(projectId)}/video/${encodeURIComponent(nodeId)}/scene-cuts`,
        undefined,
        { signal },
    );
}

export type BackendTokenResponse = { ok: boolean; token: string; reloading?: boolean };

/** 稳定代理在 Backend 开发重载期回 503 + code=BACKEND_RELOADING：这是短暂状态，不是配置错误。 */
async function isBackendReloading(response: Response): Promise<boolean> {
    if (response.status !== 503) return false;
    try { return (await response.clone().json())?.code === "BACKEND_RELOADING"; } catch { return false; }
}

const DEFAULT_URL = "http://127.0.0.1:17370";
const canvasClientId = `browser:${nanoid()}`;
let backendWritesInFlight = 0;

export function hasBackendWriteInFlight() {
    return backendWritesInFlight > 0;
}

export { getCanvasDraftSessionId } from "@/lib/canvas/canvas-draft-session";

export function getCanvasCollaborationClient() {
    return { clientId: canvasClientId, kind: "browser" as const, label: "浏览器画布" };
}

export function getBackendUrl(): string {
    if (typeof window === "undefined") return DEFAULT_URL;
    return backendConnection().url;
}

export class BackendApiError extends Error {
    constructor(message: string, readonly status: number, readonly details: Record<string, unknown> = {}) { super(message); this.name = "BackendApiError"; }
}

/** Read-only backend availability failures are shown by the global connection banner. */
export function isBackendAvailabilityError(error: unknown): error is BackendApiError {
    return error instanceof BackendApiError
        && (error.status === 0 && String(error.details.method || "").toUpperCase() === "GET"
            || error.status === 503 && error.details.code === "BACKEND_RELOADING");
}

function reportBackendAvailabilityError(error: BackendApiError) {
    if (typeof window === "undefined" || !isBackendAvailabilityError(error)) return;
    window.dispatchEvent(new CustomEvent("backend-unavailable", {
        detail: { message: error.message, code: error.details.code || "", method: error.details.method || "", path: error.details.path || "" },
    }));
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    const finishSlowOperation = watchSlowBrowserOperation(browserOperationName(method, path));
    let outcome = "failed";
    try {
        if (method !== "GET" && (/^\/canvas\/projects(?:\/|$)/.test(path) || path === CANVAS_LOOP_PREPARE_PATH)) await ensureCanvasDraftLease();
        const token = getBackendTokenShared();
        const backendUrl = getBackendUrl().replace(/\/$/, "");
        const url = `${backendUrl}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
        const tracksWrite = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
        if (tracksWrite) backendWritesInFlight++;
        let res: Response;
        try {
            res = await fetch(url, {
                method,
                headers: body ? { "content-type": "application/json" } : {},
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: options?.signal,
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            const reason = error instanceof Error ? `${error.name ? `${error.name}: ` : ""}${error.message}` : String(error);
            const apiError = new BackendApiError(`无法连接 Backend：${method} ${path} → ${backendUrl}（${reason}）。请确认 Backend 已启动且端口可访问。`, 0, { method, path, backendUrl, cause: reason });
            reportBackendAvailabilityError(apiError);
            throw apiError;
        } finally {
            if (tracksWrite) backendWritesInFlight = Math.max(0, backendWritesInFlight - 1);
        }
        const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
        if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("backend-auth-failed"));
        if (!res.ok) {
            // 把后端返回的 error 字符串完整透传（之前 30 字符截断导致 500 错看不到）
            const errText = (data && typeof data === "object" && "error" in data && typeof data.error === "string") ? data.error : "";
            const extra = errText || (res.headers.get("content-type")?.includes("application/json") ? "" : (await res.text().catch(() => "")));
            outcome = `http-${res.status}`;
            const apiError = new BackendApiError(`Backend ${method} ${path} failed: HTTP ${res.status} ${extra}`.trim(), res.status, { ...(data && typeof data === "object" ? data as Record<string, unknown> : {}), method, path });
            reportBackendAvailabilityError(apiError);
            throw apiError;
        }
        outcome = `http-${res.status}`;
        return data;
    } finally {
        finishSlowOperation(outcome);
    }
}

function sharedGet<T>(path: string): Promise<T> {
    const key = `${getBackendUrl()}\u0000${getBackendTokenShared()}\u0000GET\u0000${path}`;
    return coalesceInFlightRequest(key, () => request<T>("GET", path));
}

export type BackendRuntimeTask = {
    id: string;
    kind?: string;
    parentTaskId?: string;
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
    executor?: string;
    model?: string;
    status: "queued" | "running" | "awaiting_confirmation" | "succeeded" | "failed" | "cancelled";
    progress: number;
    input?: Record<string, unknown>;
    params?: Record<string, unknown>;
    result?: { media?: BackendMediaResult[]; images?: BackendMediaResult[]; texts?: Array<{ index?: number; content: string }>; confirmation?: { revision: number; pending: Array<{ nodeId: string; segmentId: string; firstPassFingerprint: string; firstPassResult: string; firstPassStorageKey?: string }> } } | null;
    outputs?: Array<Record<string, unknown>>;
    error?: string | null;
    createdAt?: string;
    updatedAt?: string;
};

/** 任务详情里附带的生成态预览帧（H3 展开流与自定义工作流预览桥共用形状）。 */
export type BackendTaskLivePreview = {
    dataUrl: string;
    mime?: string;
    step?: number;
    total?: number;
    nodeId?: string;
    source?: "step" | "node";
    promptId?: string;
    updatedAt?: number;
};

/** 所有画布生成来源共用的任务提交客户端。 */
export async function startCanvasGeneration(input: CanvasGenerationCommand, signal?: AbortSignal) {
    const result = await request<{ ok: boolean } & CanvasGenerationStartResult>("POST", CANVAS_GENERATION_PATH, input, { signal });
    try {
        const [{ useProductionWorkspaceStore }, { useProductionFollowStore }] = await Promise.all([import("@/stores/use-production-workspace-store"), import("@/stores/use-production-follow-store")]);
        const context = useProductionWorkspaceStore.getState().context;
        if (context && context.canvasId === input.projectId && context.owner) {
            const owner = context.owner;
            const { readiness } = await fetchProductionReadiness(owner.kind === "canvas" ? { projectId: owner.id } : owner.id);
            if (readiness.presentation?.taskId === result.taskId) {
                useProductionFollowStore.getState().setTarget({ ...owner, workId: readiness.presentation.workId });
                useProductionFollowStore.getState().setPresentation(readiness.presentation);
                useProductionFollowStore.getState().resume();
            }
        }
    } catch { /* A presentation read cannot invalidate an already accepted task receipt. */ }
    return result;
}

export function previewH3Generation(input: CanvasGenerationCommand) {
    return request<import('@basketikun/canvas-agent/generation-contract').H3ExecutionPreview>('POST', '/canvas/generation/h3-preview', input);
}

export type CanvasLoopPrepareResult = { runId: string; outputGroupId: string; slotNodeIds: string[]; totalRounds: number };
export function prepareCanvasLoop(input: CanvasLoopPrepare) {
    return request<{ ok: boolean } & CanvasLoopPrepareResult>("POST", CANVAS_LOOP_PREPARE_PATH, input);
}

export function syncBackendAiConfig(config: unknown) {
    return request<{ ok: boolean }>("PUT", "/settings/ai-config", { config });
}

export function fetchBackendAiConfig(signal?: AbortSignal) {
    return request<{ ok: boolean; config: Record<string, unknown> | null }>("GET", "/settings/ai-config", undefined, { signal });
}


export async function backendHealth(): Promise<{ ok: boolean; protocolVersion?: number; node?: string; pid?: number }> {
    try {
        const res = await fetch(`${getBackendUrl().replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { ok: false };
        return await res.json();
    } catch {
        return { ok: false };
    }
}

/**
 * 业务接口探活：`/health` + `/config` 通过不代表这个地址就是总后台。
 * 旧版 canvas-agent 兼容代理（17371）两者都返回 200，却对 /canvas/* 全部 404，
 * 页面会因此显示「素材库是空的」。用一条最便宜的业务接口（kind=text，约 0.6KB）
 * 验证地址真能提供数据；404 一律视为「连错后台」。
 */
export async function probeBackendBusinessApi(): Promise<{ ok: boolean; detail: string }> {
    const base = getBackendUrl().replace(/\/$/, "");
    const token = getBackendTokenShared();
    try {
        const res = await fetch(`${base}/canvas/assets?kind=text&token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(5000) });
        if (res.status === 404) return { ok: false, detail: `${base} 不是总后台：该地址对 /canvas/assets 返回 404（可能是旧版 canvas-agent 兼容代理，或反代路径不对）` };
        if (res.status === 401) return { ok: false, detail: `${base} 拒绝了当前连接密钥（HTTP 401），请在连接设置里重新获取 Token` };
        if (!res.ok) return { ok: false, detail: `${base} 业务接口异常：HTTP ${res.status}` };
        return { ok: true, detail: "" };
    } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return { ok: false, detail: `${base} 业务接口不可达（${reason}）` };
    }
}

/** 自动发现 backend token（读 backend.json）。 */
export async function discoverBackendToken(): Promise<BackendTokenResponse> {
    try {
        const token = getBackendTokenShared();
        const res = await fetch(`${getBackendUrl().replace(/\/$/, "")}/config`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) return { ok: false, token: "", reloading: await isBackendReloading(res) };
        const data = await res.json();
        return { ok: Boolean(data.ok), token: data.token || "" };
    } catch {
        return { ok: false, token: "" };
    }
}

// ── Canvas projects ──────────────────────────────────────────────────────

export function fetchBackendProjects(summary = false) {
    return request<{ ok: boolean; projects?: Record<string, unknown>[] }>("GET", `/canvas/projects${summary ? "?summary=true" : ""}`);
}

export function fetchBackendProject(id: string, summary = false) {
    return request<{ ok: boolean; project: Record<string, unknown> }>("GET", `/canvas/projects/${encodeURIComponent(id)}${summary ? "?summary=true" : ""}`);
}

/** 分镜格派生轨（owner = 制作稿 shot.keyframes，服务端现算）。 */
export function fetchCanvasStoryboardTracks(id: string, nodeId?: string) {
    return request<{ ok: boolean; projectId: string; revision: number; tracks: Record<string, { storyboardShots?: Array<Record<string, unknown>>; referenceBindings?: Array<Record<string, unknown>>; duration?: number }> }>(
        "GET", `/canvas/projects/${encodeURIComponent(id)}/storyboard-track${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""}`);
}

export function syncBackendCanvasCharacterAssets(id: string) {
    return request<{ ok: boolean; projectId: string; revision: number; updatedAt: string; operations: Array<Record<string, unknown>>; updated: number }>("POST", `/canvas/projects/${encodeURIComponent(id)}/sync-character-assets`);
}

export function fetchBackendCanvasFolders() {
    return request<{ ok: boolean; folders?: Record<string, unknown>[] }>("GET", "/canvas/folders");
}

export function upsertBackendCanvasFolder(folder: Record<string, unknown>) {
    return request<{ ok: boolean; folder?: Record<string, unknown> }>("POST", "/canvas/folders", folder);
}

export function deleteBackendCanvasFolder(id: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/canvas/folders/${encodeURIComponent(id)}`);
}

export function deleteBackendDramaProject(id: string, freeCanvasIds: string[] = [], options: { deleteAssets?: boolean } = {}) {
    return request<{ ok: boolean; deleted?: number; deletedAssets?: number }>("DELETE", `/drama/projects/${encodeURIComponent(id)}`, { freeCanvasIds, ...(options.deleteAssets ? { deleteAssets: true } : {}) });
}

export type DramaEpisode = {
    id: string;
    dramaId: string;
    episodeNumber: number;
    title: string;
    synopsis: string;
    fullPlot: string;
    /** 素材类型：novel / script / storyboard；老数据可能缺省。 */
    sourceFormat?: string;
    /** 建集时导入的原文；老数据可能缺省。 */
    sourceText?: string;
    canvasId: string | null;
    createdAt: string;
    updatedAt: string;
    /** 强一致分集：本集覆盖的稳定章节 ID。 */
    chapterIds?: string[];
};

export function fetchBackendDramaEpisodes(dramaId: string) {
    return sharedGet<{ ok: boolean; dramaId: string; episodes?: DramaEpisode[] }>(`/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
}

export function fetchBackendDramaEpisode(episodeId: string) {
    return sharedGet<{ ok: boolean; episode?: DramaEpisode; canvas?: Record<string, unknown> | null }>(`/drama/episodes/${encodeURIComponent(episodeId)}`);
}

/** 单设定 restyle：只读预览「引用该角色的剧情段」影响集（对齐影策 getDramaCastImpact）。 */
export function fetchDramaCastImpact(dramaId: string, assetId: string, groupId?: string, signal?: AbortSignal) {
    const query = groupId ? `?groupId=${encodeURIComponent(groupId)}` : "";
    return request<{
        ok: boolean;
        episodes: number;
        segments: number;
        targets: Array<{ episodeId: string; segmentId: string; title: string; hasVideo: boolean; inputOutdated: boolean; hasActiveTask: boolean }>;
    }>("GET", `/drama/${encodeURIComponent(dramaId)}/cast/${encodeURIComponent(assetId)}/impact${query}`, undefined, { signal });
}

/** restyle=true 真把引用段的视频标脏；submitGeneration=true 同时真提交重生成（跳过在跑段）。 */
export function restyleDramaCast(dramaId: string, assetId: string, input: { restyleSegments: boolean; groupId?: string; submitGeneration?: boolean }) {
    return request<{
        ok: boolean;
        affectedSegments: number;
        submitted?: number;
        unchanged?: boolean;
        impact?: { episodes: number; segments: number };
        skipped?: { notGenerated: number; alreadyOutdated: number; activeTask: number };
    }>("POST", `/drama/${encodeURIComponent(dramaId)}/cast/${encodeURIComponent(assetId)}/restyle`, input);
}

export function fetchBackendCanvasDrama(projectId: string) {
    return sharedGet<{ ok: boolean; projectId: string; episode?: DramaEpisode | null; drama?: { id: string; name: string } | null }>(`/canvas/projects/${encodeURIComponent(projectId)}/drama`);
}

export type DramaSourceFormat = "novel" | "script" | "storyboard";

export function createBackendDramaEpisode(dramaId: string, input: { episodeNumber: number; title?: string; synopsis?: string; fullPlot?: string; sourceFormat?: DramaSourceFormat | string; sourceText?: string; canvasId?: string | null }) {
    return request<{ ok: boolean; episode?: DramaEpisode }>("POST", `/drama/projects/${encodeURIComponent(dramaId)}/episodes`, input);
}

/**
 * 模型自动分集：预览只读不落库，apply 才写快照并按显式章序号建集。
 * 与影策 submitPlan/ParsePlan 对齐的分组快照形状。
 */
export type DramaModelEpisodeGroup = {
    title: string;
    chapters: number[];
    synopsis: string;
    hook: string;
    cliffhanger: string;
    episodeNumber?: number;
};
export type DramaEpisodeGroupingPreview = {
    ok: boolean;
    dramaId: string;
    model: string;
    /** 全部分集已完成：groups/chapters 为空，不能再预览或建集。 */
    done?: boolean;
    batch?: { cursor: number; nextCursor: number; lastChapterIndex: number; chars: number; maxChapters: number; maxChars: number; remainingChapters: number };
    planCursor?: number;
    planDone?: boolean;
    lastChapterIndex?: number;
    message?: string;
    chapters: { index: number; id?: string; title: string; chars: number }[];
    groups: DramaModelEpisodeGroup[];
};
export function previewDramaEpisodeGrouping(dramaId: string, input: { model?: string; instruction?: string } = {}) {
    return request<DramaEpisodeGroupingPreview>("POST", `/drama/${encodeURIComponent(dramaId)}/planning/episode-grouping-preview`, input);
}
/** 服务端一次触发把所有批次规划完；中断后再次调用从当前游标续跑。 */
export function autoPlanDramaEpisodeGrouping(dramaId: string, input: { model?: string; instruction?: string } = {}) {
    return request<{
        ok: boolean; dramaId: string; done?: boolean; message?: string; error?: string;
        planCursor?: number; planDone?: boolean; lastChapterIndex?: number;
        batches: { index: number; model: string; cursor: number; nextCursor: number; episodeNumbers: number[] }[];
        episodes?: DramaEpisode[];
    }>("POST", `/drama/${encodeURIComponent(dramaId)}/planning/episode-grouping-auto`, input);
}
export function applyDramaEpisodeGrouping(dramaId: string, input: { groups: DramaModelEpisodeGroup[]; expectedUpdatedAt?: string }) {
    return request<{ ok: boolean; dramaId: string; episodes?: DramaEpisode[]; groups?: DramaModelEpisodeGroup[]; updatedAt?: string; replayed?: boolean; planCursor?: number; planDone?: boolean; lastChapterIndex?: number }>(
        "POST", `/drama/${encodeURIComponent(dramaId)}/planning/episode-grouping-apply`, input,
    );
}
/** 分集方式写入 folder.productionPlan（与剧目规划同源），不另存本地假开关。 */
export function patchDramaPlanningMode(dramaId: string, episodeMode: "auto" | "chapter", expectedUpdatedAt?: string) {
    return request<{ ok: boolean; updatedAt?: string }>("PATCH", `/drama/${encodeURIComponent(dramaId)}/planning`, {
        episodeMode, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
    });
}
/**
 * 画风写回：与选题卡共用剧目规划 PATCH（后端 planningPatchSchema 的 topic.artStyle），
 * 直接写进 drama_projects.production_plan_json.topic.artStyle，不新建字段/表。
 * 两轴组合派生的画风 prompt 与自由输入的字符串都走这一条真值链路。
 */
export function patchDramaTopicArtStyle(dramaId: string, artStyle: string) {
    return request<{ ok: boolean; updatedAt?: string; applied?: string[] }>("PATCH", `/drama/${encodeURIComponent(dramaId)}/planning`, {
        topic: { artStyle },
    });
}

/** 大纲单步生成：只拿候选文本，写入仍走剧目规划保存。 */
export type DramaTopicProposal = {
    title: string; themes: string[]; tones: string[]; gender: string; age: string; ending: string; language: string;
    artStyle: string; episodes: number; episodeMinutes: number; logline: string;
};

/** 粘贴剧本 → 自动填好选题（创建前就能调，不依赖 dramaId）。 */
export function requestDramaTopicProposal(input: { source: string; model?: string; instruction?: string }) {
    return request<{ ok: boolean; topic: DramaTopicProposal; model: string; raw?: string; error?: string }>("POST", "/drama/topic-proposal", input);
}

export function requestDramaOutlineProposal(dramaId: string, input: { step: string; model?: string; instruction?: string }) {
    return request<{ ok: boolean; step: string; text: string; model: string; error?: string }>("POST", `/drama/${encodeURIComponent(dramaId)}/planning/outline-proposal`, input);
}

/** 剧目级分集规划游标（不返回大正文），用于设置页完成锁定展示。 */
export function fetchDramaPlanningState(dramaId: string) {
    return sharedGet<{ ok: boolean; episodeMode?: string; planCursor?: number; planDone?: boolean; lastChapterIndex?: number; updatedAt?: string }>(`/drama/${encodeURIComponent(dramaId)}/planning`);
}

/** 剧目策划真值：原剧本正文（folder.productionPlan.sourceScript）。 */
export function fetchDramaPlanningSource(dramaId: string) {
    return sharedGet<{ ok: boolean; sourceScript?: string; updatedAt?: string; planDone?: boolean; planCursor?: number; lastChapterIndex?: number }>(`/drama/${encodeURIComponent(dramaId)}/planning?include=sourceScript`);
}

/**
 * 章节元信息（source_chapters.chars 真值，不含正文）：制作台开场「N章N字」的唯一字数来源。
 * 后端契约 backend/src/server/drama-source-chapter-routes.ts 的 GET /drama/:dramaId/planning/chapters?include=meta。
 */
export function fetchDramaSourceChapterMeta(dramaId: string) {
    return sharedGet<{
        ok: boolean;
        dramaId: string;
        planCursor?: number;
        planDone?: boolean;
        chapters: Array<Pick<DramaSourceChapter, "id" | "chapterIndex" | "title" | "chars">>;
    }>(`/drama/${encodeURIComponent(dramaId)}/planning/chapters?include=meta`);
}
export function patchDramaPlanningSource(dramaId: string, sourceScript: string, expectedUpdatedAt?: string) {
    return request<{ ok: boolean; updatedAt?: string; applied?: string[] }>("PATCH", `/drama/${encodeURIComponent(dramaId)}/planning`, { sourceScript, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });
}

/**
 * 章节级原文真值（source_chapters.body）。按章编辑用，真值优先于剧目级 planning.sourceScript：
 * 改编链 pipeline.runScript 已改为从「本集覆盖章节」组装 episodeSource，改章正文后重新改编即生效。
 * 后端契约见 backend/src/server/drama-source-chapter-routes.ts。
 */
export type DramaSourceChapter = {
    id: string;
    dramaId: string;
    chapterIndex: number;
    title: string;
    chars: number;
    bodyHash: string;
    sourceFormat: DramaSourceFormat | string;
    revision: number;
    updatedAt: string;
    body: string;
};

/** 本集覆盖的章节（含正文），供按章编辑替代改剧目全文。 */
export function getEpisodeChapters(episodeId: string) {
    return sharedGet<{
        ok: boolean;
        episodeId: string;
        dramaId: string;
        episodeNumber: number;
        episodeTitle: string;
        sourceFormat?: string;
        planDone: boolean;
        chapterIds: string[];
        chapters: DramaSourceChapter[];
    }>(`/drama/episodes/${encodeURIComponent(episodeId)}/chapters`);
}

/** 单章原文（含正文）；dramaId 可选，用于校验章节归属防串剧目。 */
export function getChapter(chapterId: string, dramaId?: string) {
    const query = dramaId ? `?dramaId=${encodeURIComponent(dramaId)}` : "";
    return sharedGet<{ ok: boolean; chapter: DramaSourceChapter; planDone: boolean }>(
        `/drama/chapters/${encodeURIComponent(chapterId)}${query}`,
    );
}

/** 按章保存原文；expectedRevision 乐观锁，409 冲突时前端回读重试。 */
export function patchChapter(chapterId: string, patch: {
    body?: string;
    title?: string;
    sourceFormat?: DramaSourceFormat;
    expectedRevision?: number;
    expectedUpdatedAt?: string;
}) {
    return request<{
        ok: boolean;
        chapter: DramaSourceChapter;
        changed: boolean;
        needsRescript: boolean;
        planDone: boolean;
        planCursor: number;
        affectedEpisodeIds?: string[];
        message?: string;
    }>("PATCH", `/drama/chapters/${encodeURIComponent(chapterId)}`, patch);
}

export type AssetSpecKind = "character" | "scene" | "prop";
export type AssetSpec = { kind: AssetSpecKind; character?: Record<string, unknown>; scene?: Record<string, unknown>; prop?: Record<string, unknown>; updatedAt?: string };
export type AssetSpecResponse = {
    ok: boolean;
    assetId: string;
    title: string;
    kind: AssetSpecKind;
    spec: AssetSpec | null;
    summary: string;
    missing: string[];
    readiness: { ready: boolean; missing: string[]; hint: string; skill: { skill: string; path: string; section: string; imageKind: string } };
    prompt: string;
};

/** 角色/场景/道具设定卡：真值在 asset.metadata.assetSpec。 */
export function fetchAssetSpec(assetId: string) {
    return request<AssetSpecResponse>("GET", `/assets/${encodeURIComponent(assetId)}/spec`);
}

export function updateAssetSpec(assetId: string, input: { kind: AssetSpecKind; spec: Record<string, unknown>; wantPrompt?: boolean }) {
    return request<AssetSpecResponse>("PATCH", `/assets/${encodeURIComponent(assetId)}/spec`, input);
}

export type DramaStageState = { key: "topic" | "outline" | "script" | "assets" | "shots" | "video"; done: boolean; gaps: string[]; doneCount: number; total: number };
export type DramaStageReport = {
    ok: boolean;
    dramaId: string;
    name: string;
    states: DramaStageState[];
    next: { stage: DramaStageState["key"] | null; action: string; skill: string; skillPath: string; gaps: string[]; line: string };
    context: string;
    activity: { stage: DramaStageState["key"]; label: string; tool: string; at: number } | null;
    episodes: Array<{ episodeNumber: number; stage: string | null; done: string[] }>;
};

/** 剧目阶段（选题→大纲→剧本→资产→分镜→视频）的派生状态，判定在 canvas-agent/drama/stage-contract。 */
export function fetchDramaStage(dramaId: string) {
    return request<DramaStageReport>("GET", `/drama/${encodeURIComponent(dramaId)}/stage`);
}

/** 单集剧本大纲（分场）生成：同样只回候选文本，写入走 updateBackendDramaEpisode。 */
export function requestEpisodeScriptProposal(episodeId: string, input: { model?: string; instruction?: string }) {
    return request<{ ok: boolean; episodeId: string; text: string; model: string; error?: string }>("POST", `/drama/episodes/${encodeURIComponent(episodeId)}/script-proposal`, input);
}

export function updateBackendDramaEpisode(episodeId: string, patch: Partial<Pick<DramaEpisode, "episodeNumber" | "title" | "synopsis" | "fullPlot" | "sourceFormat" | "sourceText" | "canvasId">>) {
    return request<{ ok: boolean; episode?: DramaEpisode; canvas?: Record<string, unknown> | null }>("PATCH", `/drama/episodes/${encodeURIComponent(episodeId)}`, patch);
}

/** DELETE 409 的结构化确认要求：前端据此把「确认一次」动态切成「输入第 N 集」。 */
export type EpisodeConfirmRequiredDetails = {
    confirmText: string;
    reasons?: string[];
    stats?: { videoJobs: number; finalResource: boolean; versions: number; publishedVersion: number; archived: boolean };
    episodeId?: string;
    episodeNumber?: number;
};

export function episodeConfirmRequired(error: unknown): EpisodeConfirmRequiredDetails | null {
    if (!(error instanceof BackendApiError) || error.status !== 409) return null;
    const details = error.details;
    if (details.code !== "EPISODE_CONFIRM_REQUIRED" && details.reason !== "episodeConfirmRequired") return null;
    if (typeof details.confirmText !== "string" || !details.confirmText) return null;
    return details as unknown as EpisodeConfirmRequiredDetails;
}

export function deleteBackendDramaEpisode(episodeId: string, confirmText?: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/drama/episodes/${encodeURIComponent(episodeId)}`, confirmText === undefined ? undefined : { confirmText });
}

export type ProductionClipRefreshReceipt = {
    sourceHash?: string;
    sourceSaved: true; operationId: string; status: "queued" | "checking" | "compiling" | "applying" | "succeeded" | "blocked" | "failed" | "superseded" | "interrupted";
    segmentId: string; savedRevision: number; compilationOperationId: string; selectedTargets: string[]; affectedTargets: string[];
    createdAt?: string; updatedAt?: string;
    translationOperationId?: string; translationError?: string;
    blockingDiagnostic?: { code: string; message: string; targetId?: string; path?: string };
    application?: { revision?: number; referenceSync?: Array<{ targetId: string; status: string; referenceCount?: number; diagnostics?: Array<{ code: string; message: string }> }> };
    mediaSubmitted: false;
};
export type EpisodeProductionSnapshot = Omit<EpisodeProductionData, "scenes" | "shots" | "clipGroups"> & Partial<Pick<EpisodeProductionData, "scenes" | "shots" | "clipGroups">>;
export type EpisodeProduction = { episodeId: string; revision: number; draft: EpisodeProductionSnapshot; published: EpisodeProductionSnapshot | null; publishedVersion: number; updatedAt: string; archivedAt?: string | null; storageFormat?: "v2-single-source" | "v2-projection-migration-required"; publishedFormatStatus?: "legacy-maintenance-required"; impact?: { changedSceneIds: string[]; affectedShotIds: string[]; imageShotIds: string[]; clipGroupIds: string[]; missingAssetNodeIds: string[]; assetIds?: string[] }; clipRefreshes?: ProductionClipRefreshReceipt[]; replayed?: boolean };
export type ProductionTarget = string | { projectId: string } | { sceneId: string };
export type ProductionCanvasContext = { role: "ordinary" | "episode" | "scene" | "shared-assets" | "standalone"; canvasId: string; dramaId?: string; episodeId?: string; sceneId?: string; owner?: { kind: "episode" | "canvas" | "scene"; id: string }; sharedAssetCanvasId?: string | null };
export function fetchProductionCanvasContext(id: string) { return sharedGet<{ ok: boolean; context: ProductionCanvasContext }>(`/canvas/projects/${encodeURIComponent(id)}/production-context`); }
export function ensureEpisodeCanvas(id: string) { return request<{ ok: boolean; project: Record<string, unknown>; context: ProductionCanvasContext }>("POST", `/drama/episodes/${encodeURIComponent(id)}/canvas/ensure`, {}); }
export function ensureSharedAssetCanvas(id: string) { return request<{ ok: boolean; project: Record<string, unknown>; context: ProductionCanvasContext }>("POST", `/drama/projects/${encodeURIComponent(id)}/asset-canvas/ensure`, {}); }
export function prepareProductionTargets(owner: ProductionTarget, expectedRevision: number, targets: string[], operationId: string) { return request<{ ok: boolean; production: EpisodeProduction; mediaSubmitted: false }>("POST", `${productionPath(owner)}/prepare-targets`, { expectedRevision, targets, operationId }); }
export function arrangeProductionScene(owner: ProductionTarget, expectedRevision: number, sceneId: string, operationId: string) { return request<{ ok: boolean; production: EpisodeProduction }>("POST", `${productionPath(owner)}/arrange-scene`, { expectedRevision, sceneId, operationId }); }
export type ApprovedSharedAsset = { id: string; assetId: string; dramaId: string; sourceProjectId: string; sourceNodeId: string; sourceVersion: number; storageKey: string; sha256: string; snapshot: { title: string; content?: string; metadata?: Record<string, any> }; evidence: string; reviewStatus: "unreviewed" | "approved"; createdAt: string };
export function fetchProductionSharedAssets(owner: ProductionTarget) { return request<{ ok: boolean; assets: ApprovedSharedAsset[]; versions: ApprovedSharedAsset[] }>("GET", `${productionPath(owner)}/shared-assets`); }
/** 单个设定的真实版本记录：drama_asset_versions 按 (dramaId, assetId) 只读查询，含 storage_key/来源/快照。 */
export function fetchDramaAssetVersions(dramaId: string, assetId: string) {
    return sharedGet<{ ok: boolean; assetId: string; versions: ApprovedSharedAsset[] }>(`/drama/projects/${encodeURIComponent(dramaId)}/asset-versions?assetId=${encodeURIComponent(assetId)}`);
}
export type SharedAssetPromotionPreview = { episodeId: string; episodeRevision: number; publishedVersion: number; sourceHash: string; sourceCanvasId: string; sourceCanvasRevision: number; sourceNodeId: string; assetId: string; assetName: string; storageKey: string; sha256: string; evidence: string; reviewStatus: "unreviewed" | "approved"; sourceGenerationTaskId: string; dramaId: string; sharedCanvasId: string | null; sharedCanvasRevision: number | null; targetNodeId: string; approvedId: string | null; eligible: true };
export function previewProductionSharedAssetPromotion(owner: ProductionTarget, assetId: string, expectedRevision: number) { return request<{ ok: boolean; preview: SharedAssetPromotionPreview; mediaSubmitted: false }>("POST", `${productionPath(owner)}/shared-assets/promotions/preview`, { assetId, expectedRevision }); }
export function promoteExistingProductionSharedAsset(owner: ProductionTarget, input: { assetId: string; expectedRevision: number; expectedSourceCanvasRevision: number; expectedSharedCanvasRevision: number | null; operationId: string }) { return request<{ ok: boolean; promotion: { approvedId: string; canvasId: string; nodeId: string; replayed: boolean }; mediaSubmitted: false }>("POST", `${productionPath(owner)}/shared-assets/promotions`, input); }
const productionPath = (target: ProductionTarget) => typeof target === "string"
    ? `/drama/episodes/${encodeURIComponent(target)}/production`
    : "sceneId" in target
        ? `/drama/scenes/${encodeURIComponent(target.sceneId)}/production`
        : `/canvas/projects/${encodeURIComponent(target.projectId)}/production`;
export function fetchEpisodeProduction(episodeId: ProductionTarget) { return sharedGet<{ ok: boolean; production: EpisodeProduction }>(productionPath(episodeId)); }
export function fetchProductionOperationReceipt(owner: ProductionTarget, operationId: string) { return request<{ ok: boolean; found: boolean; production?: EpisodeProduction }>("GET", `${productionPath(owner)}/operations/${encodeURIComponent(operationId)}/receipt`); }

// ── 制作稿版本对比：全部字段由后端从 episode_production_versions.snapshot_json 真派生，前端只渲染 ──
export type VersionCompareSummary = {
    format: "v2-director" | "legacy" | "empty";
    sceneCount: number;
    shotCount: number;
    segmentCount: number;
    keyframeCount: number;
    h3ClipCount: number;
    promptCount: number;
    promptsHash: string | null;
    sourceHash: string | null;
    finalStorageKey: string | null;
    /** 发布时记录进 clip_video_versions 的逐段成片条数（真计数，不是快照里的 clip 计划数）；版本列表显示「N段成片」。 */
    clipVideoCount: number;
    shotIds: string[];
    segmentIds: string[];
    promptIds: string[];
};
export type VersionCompareVersion = { version: number; stage: string; createdAt: string; summary: VersionCompareSummary; clipVideoCount: number };
export type CompareCountDimension = { key: string; label: string; from: number; to: number; delta: number; changed: boolean };
export type CompareStringDimension = { key: string; label: string; from: string | null; to: string | null; changed: boolean };
export type CompareFieldChange = { field: string; from: string; to: string };
export type CompareEntityChange = { id: string; fields: CompareFieldChange[] };
export type ComparePromptChange = { id: string; fromHash: string; toHash: string };
/** 逐clip成片真值：storageKey/durationMs 都来自 clip_video_versions（画布段结果 + media_files）。 */
export type ClipVideoTruth = {
    clipId: string; segmentId: string; title: string; storageKey: string; durationMs: number | null;
    source: string | null; generationLogId: string | null; status: string | null;
};
export type ClipVideoChange = {
    clipId: string; title: string; from: ClipVideoTruth | null; to: ClipVideoTruth | null;
    state: "added" | "removed" | "storageKeyChanged" | "durationChanged" | "regenMetadata";
    storageKeyChanged: boolean; durationChanged: boolean;
};
export type CompareClipVideoDiff = {
    recordedFrom: boolean; recordedTo: boolean; fromCount: number; toCount: number;
    added: string[]; removed: string[]; changed: ClipVideoChange[];
};
export type VersionCompareRef = { version: number; stage: string; createdAt: string };
export type VersionCompareDiff = {
    episodeId: string;
    from: VersionCompareRef;
    to: VersionCompareRef;
    changed: boolean;
    dimensions: {
        scenes: CompareCountDimension;
        shots: CompareCountDimension;
        segments: CompareCountDimension;
        keyframes: CompareCountDimension;
        h3Clips: CompareCountDimension;
        prompts: CompareCountDimension;
        finalStorageKey: CompareStringDimension;
        sourceHash: CompareStringDimension;
        promptsHash: CompareStringDimension;
    };
    shots: { added: string[]; removed: string[]; changed: CompareEntityChange[] };
    segments: { added: string[]; removed: string[]; changed: CompareEntityChange[] };
    prompts: { added: string[]; removed: string[]; changed: ComparePromptChange[] };
    clipVideos: CompareClipVideoDiff;
};
/** GET 版本列表（倒序），摘要含镜头/段/成片 clip 计数与成片 storageKey。 */
export function fetchVersionCompareVersions(episodeId: string) {
    return request<{ ok: boolean; versions: VersionCompareVersion[] }>("GET", `${productionPath(episodeId)}/version-compare/versions`);
}
/** GET 两版本结构化 diff；版本不存在时后端返回 404（BackendApiError.status === 404）。 */
export function fetchVersionCompare(episodeId: string, v1: number, v2: number) {
    return request<{ ok: boolean; comparison: VersionCompareDiff }>("GET", `${productionPath(episodeId)}/version-compare/${v1}/${v2}`);
}
/** 当前画布逐clip成片真值（实时段结果），可与版本记录做诚实对比。 */
export function fetchClipVideosCurrent(episodeId: string) {
    return request<{ ok: boolean; clipVideos: ClipVideoTruth[] }>("GET", `${productionPath(episodeId)}/clip-videos/current`);
}
/** 指定版本已记录的逐clip成片真值；旧版本为空数组。 */
export function fetchClipVideosAtVersion(episodeId: string, version: number) {
    return request<{ ok: boolean; clipVideos: ClipVideoTruth[] }>("GET", `${productionPath(episodeId)}/clip-videos/${version}`);
}
export function fetchProductionWorkbench(owner: ProductionTarget, view: "subject_workbench" | "shot_workbench" | "clip_workbench", targetId: string, snapshot: "draft" | "published" = "draft") {
    const query = new URLSearchParams({ view, targetIds: targetId, snapshot });
    return request<{ ok: boolean; production: Record<string, any> }>("GET", productionPath(owner) + "?" + query.toString());
}
export async function fetchProductionClipNumbers(owner: ProductionTarget) {
    const clipNumbers: Record<string, number> = {};
    let cursor: string | null = null;
    do {
        const query: URLSearchParams = new URLSearchParams({ view: "numbering", snapshot: "draft", pageSize: "50", ...(cursor ? { cursor } : {}) });
        const result: { production: { numbering: { items: Array<{ segmentId: string; clipNumber: number }>; nextCursor: string | null } } } = await request("GET", productionPath(owner) + "?" + query);
        for (const clip of result.production.numbering.items) clipNumbers[clip.segmentId] = clip.clipNumber;
        cursor = result.production.numbering.nextCursor;
    } while (cursor);
    return clipNumbers;
}
export function editEpisodeProduction(episodeId: ProductionTarget, expectedRevision: number, ops: ProductionOperation[], operationId = nanoid()) { return request<{ ok: boolean; production: EpisodeProduction }>("POST", `${productionPath(episodeId)}/ops`, { operationId, expectedRevision, ops }); }
// ── 段视频后处理重跑（对齐影策 ReprocessDramaSegmentVideo，本地不调模型不扣费）──────────
/** GET 只读预览：前端据此决定「重新处理视频」按钮是否可用；不产生任何写入。 */
export type SegmentVideoReprocessPreview = {
    ok: boolean;
    reprocessable: boolean;
    alreadyReady?: boolean;
    storageKey?: string;
    generationLogId?: string;
    status?: string;
    code?: string;
    reason?: string;
};
/** POST 结果码：REPROCESSED / ALREADY_READY / NO_GENERATED_VIDEO / MEDIA_MISSING / SPEC_STILL_MISMATCH / … */
export type SegmentVideoReprocessResult = {
    ok: boolean;
    reprocessed?: boolean;
    alreadyReady?: boolean;
    code: string;
    message?: string;
    storageKey?: string;
    generationLogId?: string;
    episodeId?: string;
    segmentId?: string;
    revision?: number;
    error?: string;
};
export function getSegmentVideoReprocessStatus(episodeId: string, segmentId: string, signal?: AbortSignal) {
    return request<SegmentVideoReprocessPreview>(
        "GET",
        `/drama/episodes/${encodeURIComponent(episodeId)}/segments/${encodeURIComponent(segmentId)}/reprocess-video`,
        undefined,
        { signal },
    );
}
export function reprocessSegmentVideo(episodeId: string, segmentId: string) {
    return request<SegmentVideoReprocessResult>(
        "POST",
        `/drama/episodes/${encodeURIComponent(episodeId)}/segments/${encodeURIComponent(segmentId)}/reprocess-video`,
        {},
    );
}

export function previewEpisodeProductionImpact(episodeId: ProductionTarget, stage: "script" | "shots" | "director") { return request<{ ok: boolean; impact: NonNullable<EpisodeProduction["impact"]> }>("GET", `${productionPath(episodeId)}/impact?stage=${stage}`); }
export function publishEpisodeProduction(episodeId: ProductionTarget, expectedRevision: number, stage: "script" | "shots" | "director", operationId = nanoid()) { return request<{ ok: boolean; production: EpisodeProduction }>("POST", `${productionPath(episodeId)}/publish`, { operationId, expectedRevision, stage }); }
export function fetchEpisodeProductionVersions(episodeId: ProductionTarget) { return sharedGet<{ ok: boolean; versions: Array<{ version: number; stage: "script" | "shots" | "director"; impact: NonNullable<EpisodeProduction["impact"]>; createdAt: string }> }>(`${productionPath(episodeId)}/versions`); }
export type ProductionSceneArchive = { archiveId: string; sceneId: string; sceneTitle: string; deletedAt: string; expiresAt: string; shotCount: number; clipCount: number };
export function fetchProductionSceneArchives(target: ProductionTarget) { return request<{ ok: boolean; archives: ProductionSceneArchive[] }>("GET", `${productionPath(target)}/scene-archives`); }
export function restoreEpisodeProduction(episodeId: ProductionTarget, expectedRevision: number, version: number, operationId = nanoid()) { return request<{ ok: boolean; production: EpisodeProduction }>("POST", `${productionPath(episodeId)}/restore`, { operationId, expectedRevision, version }); }
export function syncEpisodeProductionClips(episodeId: ProductionTarget) { return request<{ ok: boolean; production: EpisodeProduction }>("POST", `${productionPath(episodeId)}/sync-clips`); }
// 编译：提交后返回 operationId，沿同一 operationId 轮询状态；成功后用 preparedId 应用回执写回正式源稿。
export type ProductionCompilationStatus = {
    operationId: string; status: "queued" | "running" | "succeeded" | "blocked" | "interrupted" | "failed"; verdict: "passed" | "passed_with_warnings" | "blocked";
    expectedRevision: number; sourceHash: string; engineRuntimeId?: string; compilerHash?: string; preparedId?: string; diagnosticCount?: number; targetCount?: number; reused?: boolean;
    blockingDiagnostic?: { code: string; path?: string; targetId?: string; shotId?: string; message: string };
    /** 编译完成后的下一步提示；preparedId 实测藏在 nextAction.input 里（顶层字段可能不填）。 */
    nextAction?: { action: string; tool: string; input: Record<string, unknown>; message: string };
    application?: { revision?: number; sourceHash?: string; operationId?: string; replayed?: boolean; referenceSync?: Array<{ targetId: string; status: string; referenceCount?: number }> };
    mediaSubmitted: false;
};
export type ProductionCompilationDiagnostic = { code?: string; severity?: string; path?: string; targetId?: string; shotId?: string; affectedTargets?: string[]; message?: string; blockingActions?: string[]; blocksCompilation?: boolean; nextAction?: unknown };
export function compileProduction(target: ProductionTarget, expectedRevision: number, operationId: string, scope?: { sceneId?: string; targetIds?: string[] }) {
    return request<{ ok: boolean; compilation: ProductionCompilationStatus }>("POST", `${productionPath(target)}/compile`, { expectedRevision, operationId, ...(scope ? { scope } : {}) });
}
export function fetchProductionCompilation(target: ProductionTarget, operationId: string, view: "status" | "targets" | "diagnostics" = "status", extra?: { offset?: number; pageSize?: number }) {
    const query = new URLSearchParams({ view, ...(extra?.offset === undefined ? {} : { offset: String(extra.offset) }), ...(extra?.pageSize === undefined ? {} : { pageSize: String(extra.pageSize) }) });
    return request<{ ok: boolean; compilation: ProductionCompilationStatus & { items?: ProductionCompilationDiagnostic[]; total?: number; nextOffset?: number | null } }>("GET", `${productionPath(target)}/compilations/${encodeURIComponent(operationId)}?${query.toString()}`);
}
export function applyProductionCompilation(target: ProductionTarget, preparedId: string) {
    const path = `${productionPath(target)}/apply-compilation`;
    const apply = () => request<{ ok: boolean; receipt: { revision: number; sourceHash?: string; operationId: string; replayed?: boolean; publishedVersion?: number; referenceSync?: Array<{ targetId: string; status: string; referenceCount?: number }>; mediaSubmitted: false } }>("POST", path, { preparedId });
    return (async () => {
        // A stable dev proxy's BACKEND_RELOADING response is issued before the
        // write reaches Backend. Keep the same preparedId and retry briefly so
        // a watch reload between compile completion and apply does not surface
        // as a failed compilation. Other 503s (including unknown outcomes) are
        // never retried here.
        for (let retry = 0; ; retry++) {
            try { return await apply(); }
            catch (error) {
                if (!(error instanceof BackendApiError) || error.status !== 503
                    || error.details.code !== "BACKEND_RELOADING" || retry >= 3) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    })();
}
export function fetchEpisodeProductionRun(episodeId: ProductionTarget, version: number) { return request<{ ok: boolean; run: { status: string; submitted: Array<{ kind: "image" | "h3"; id: string; taskId: string }>; error: string | null } | null }>("GET", `${productionPath(episodeId)}/runs/${version}`); }
export type ProductionReadinessTarget = { id: string; targetId: string; kind: "asset" | "keyframe" | "segment"; title: string; status: "ready" | "blocked" | "needs_review" | "complete"; blockers: string[]; warnings?: string[]; artifactId?: string; executionTargets?: string[]; notice?: string };
export type ProductionPresentation = { key: string; workId: string; owner: { kind: "canvas" | "episode" | "scene"; id: string }; aliases?: string[]; workspace: "overview" | "story" | "assets" | "shots" | "continuity" | "production" | "advanced"; action: "author" | "compile" | "produce" | "review" | "deliver" | "blocked"; targetKind?: string; targetId?: string; canvasId?: string; nodeId?: string; segmentId?: string; runId?: string; taskId?: string; status: "ready" | "working" | "needs_review" | "blocked" | "complete"; reason?: string };
export type ProductionReadiness = { revision: number; publishedVersion: number; source: "draft" | "published"; canvasId?: string; canvasRevision?: number; targets: ProductionReadinessTarget[]; modules: Record<string, unknown>; unresolved: string[]; nextAction: string; stage?: { draftInitialized: boolean; scriptBlocks: number; explicitShotCues: number; structuredShots: number; assetCards: number; segments: number; compileGate: "not_started" | "blocked" | "preflight_required"; compileBlockers: string[]; authoringGaps: string[]; nextAction: string }; presentation?: ProductionPresentation; sceneWorks?: DirectorProduction["workflow"]["sceneWorks"] };
export type SceneWorkInspection = { revision: number; works: Array<NonNullable<DirectorProduction["workflow"]["sceneWorks"]>[string] & { reviewInputHash?: string; inputChanged?: boolean; reviewAssetIds?: string[]; source?: Record<string, unknown>; media?: Array<{ targetId: string; storageKey: string; sha256: string }> }>; shared: { continuation?: DirectorProduction["workflow"]["sharedReviewContinuation"]; inputHash?: string; reviewCurrent?: boolean; reviewAssetIds?: string[]; reviewWorks?: Array<NonNullable<DirectorProduction["workflow"]["sharedReviewWorks"]>[string]>; reviews?: NonNullable<DirectorProduction["workflow"]["sharedAssetReviews"]>; error?: string; review?: DirectorProduction["workflow"]["sharedReview"]; source?: Record<string, unknown>; media?: Array<{ targetId: string; storageKey: string; sha256: string }> } | null };
export function fetchProductionSceneWork(target: ProductionTarget) { return request<{ ok: boolean; state: SceneWorkInspection }>("GET", `${productionPath(target)}/scene-work`); }
export type ProductionSceneAction = { action: "shared-review"; model?: string; effort?: string } | { action: "start"; sceneIds: string[]; generateMedia: boolean; model?: string; effort?: string } | { action: "pause" | "resume"; workId: string } | { action: "review"; workId?: string; assetIds?: string[]; inputHash: string; verdict: "approved" | "rejected"; evidence: string };
export function submitProductionSceneAction(target: ProductionTarget, command: ProductionSceneAction, expectedRevision: number, operationId: string) {
    const { action, ...input } = command;
    return request<{ ok: boolean; production: EpisodeProduction; replayed?: boolean }>("POST", `${productionPath(target)}/scene-work/${action}`, { ...input, expectedRevision, operationId });
}
export function startProductionSceneWork(target: ProductionTarget, input: { expectedRevision: number; sceneIds: string[]; generateMedia: boolean; model?: string; effort?: string }, operationId = nanoid()) { const { expectedRevision, ...fields } = input; return submitProductionSceneAction(target, { action: "start", ...fields }, expectedRevision, operationId); }
export function actProductionSceneWork(target: ProductionTarget, action: "pause" | "resume", workId: string, expectedRevision: number, operationId = nanoid()) { return submitProductionSceneAction(target, { action, workId }, expectedRevision, operationId); }
export function reviewProductionSceneWork(target: ProductionTarget, input: { expectedRevision: number; workId?: string; assetIds?: string[]; inputHash: string; verdict: "approved" | "rejected"; evidence: string }, operationId = nanoid()) { const { expectedRevision, ...fields } = input; return submitProductionSceneAction(target, { action: "review", ...fields }, expectedRevision, operationId); }
export type ProductionBatch = { executionSnapshot?: { inputBasis: "canvas" | "published"; canvasRevision: number; planHash: string } | null; runId: string; episodeId: string; version: number; sourceRevision: number; idempotencyKey: string; status: string; targets: string[]; plan: NonNullable<EpisodeProduction["impact"]>; engine: Record<string, unknown> | null; settings: Record<string, unknown>; submitted: Array<{ kind: "image" | "h3"; id: string; taskId: string; projectId?: string; nodeId?: string; segmentId?: string; status?: "running" | "succeeded" | "failed" }>; error: string | null; pauseRequested: boolean; createdAt: string; updatedAt: string };
export function fetchProductionReadiness(target: ProductionTarget, options?: { runId?: string }) { return sharedGet<{ ok: boolean; readiness: ProductionReadiness }>(`${productionPath(target)}/readiness${options?.runId ? `?runId=${encodeURIComponent(options.runId)}` : ""}`); }

/** 与影策 DramaJianyingDraftPreview 同形状；stale 是 available 的子集，不是独立第三类。 */
export type DramaJianyingSegmentPreview = { index: number; title: string; included: boolean; stale: boolean; reason?: string; durationMs: number; durationEstimated: boolean };
export type DramaJianyingDraftPreview = {
    draftRoot: string; revision: string;
    totalSegments: number; availableSegments: number; missingSegments: number; staleSegments: number;
    durationMs: number; mediaBytes: number; captionCount: number;
    segments: DramaJianyingSegmentPreview[]; warnings: string[];
};
export function previewJianyingDraft(target: ProductionTarget, input: { draftRoot?: string; captions?: boolean } = {}) {
    return request<{ ok: boolean; preview: DramaJianyingDraftPreview }>("POST", `${productionPath(target)}/jianying/preflight`, input);
}
export type JianyingExportInput = {
    draftRoot?: string; captions?: boolean; revision?: string;
    allowIncomplete?: boolean; allowStale?: boolean; width?: number; height?: number;
};
/** 真导出：草稿在服务端构建并流式返回 ZIP；revision 由 preflight 返回，下载时后端现场复核（不一致 409）。 */
export async function exportJianyingDraft(target: ProductionTarget, input: JianyingExportInput = {}): Promise<Blob> {
    const path = `${productionPath(target)}/jianying/export`;
    const token = getBackendTokenShared();
    const backendUrl = getBackendUrl().replace(/\/$/, "");
    const url = `${backendUrl}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    let res: Response;
    try {
        res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new BackendApiError(`无法连接 Backend：${path} → ${backendUrl}（${reason}）`, 0, { method: "POST", path, backendUrl, cause: reason });
    }
    if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new BackendApiError(`剪映导出失败：${data?.error || `HTTP ${res.status}`}`, res.status,
            { ...(data && typeof data === "object" ? data as Record<string, unknown> : {}), method: "POST", path });
    }
    return await res.blob();
}
export type ProductionContinuity = { owner: { kind: "canvas" | "episode" | "scene"; id: string }; snapshot: "draft" | "published"; revision: number; publishedVersion: number; sourceHash?: string | null; runtime?: Record<string, unknown> | null; status: "missing" | "unchecked" | "diagnosticOnly" | "stale" | "blocked" | "unresolved" | "passed" | "partial"; coverageStatus: string; semanticDiscovery: "not_performed"; checkedAt: string | null; diagnostics: { total: number; blocked: number; unresolved: number }; items: unknown[]; total: number; nextCursor: string | null; report?: Record<string, any> };
export function fetchProductionContinuity(target: ProductionTarget, options?: { snapshot?: "draft" | "published"; view?: "summary" | "issues" | "timeline" | "shot"; targetId?: string; objectId?: string; pageSize?: number; cursor?: string }) {
    const query = new URLSearchParams(Object.fromEntries(Object.entries(options || {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])));
    return sharedGet<{ ok: boolean; continuity: ProductionContinuity }>(`${productionPath(target)}/continuity?${query}`);
}
export function checkProductionContinuity(target: ProductionTarget, input: { expectedRevision: number; operationId: string; snapshot?: "draft" | "published"; targetIds?: string[] }) {
    return request<{ ok: boolean; check: { status: "succeeded"; verdict: string; report: Record<string, any>; revision: number; replayed?: boolean; mediaSubmitted: false } }>("POST", `${productionPath(target)}/continuity/check`, input);
}
export function fetchProductionBatches(target: ProductionTarget) { return sharedGet<{ ok: boolean; runs: ProductionBatch[] }>(`${productionPath(target)}/batches`); }
export function startProductionRun(target: ProductionTarget, input: { inputBasis?: "canvas" | "published"; expectedCanvasRevision?: number; expectedPlanHash?: string; runId: string; idempotencyKey: string; workId?: string; expectedRevision: number; version: number; targets: string[]; scope?: "selected" | "all_ready" }) { return request<{ ok: boolean; run: ProductionBatch }>("POST", `${productionPath(target)}/runs`, input); }
export function fetchProductionBatch(target: ProductionTarget, runId: string) { return request<{ ok: boolean; run: ProductionBatch | null }>("GET", `${productionPath(target)}/batches/${encodeURIComponent(runId)}`); }
export function pauseProductionBatch(target: ProductionTarget, runId: string) { return request<{ ok: boolean; run: ProductionBatch }>("POST", `${productionPath(target)}/batches/${encodeURIComponent(runId)}/pause`, {}); }
export function resumeProductionBatch(target: ProductionTarget, runId: string) { return request<{ ok: boolean; run: ProductionBatch }>("POST", `${productionPath(target)}/batches/${encodeURIComponent(runId)}/resume`, {}); }
export function retireProductionBatch(target: ProductionTarget, runId: string, reason: string) { return request<{ ok: boolean; run: ProductionBatch; mediaSubmitted: false }>("POST", `${productionPath(target)}/batches/${encodeURIComponent(runId)}/retire`, { reason }); }
export function exportEpisodeProductionMarkdown(episodeId: ProductionTarget, stage: "script" | "shots" | "director", version?: number) { return request<{ ok: boolean; fileName: string; markdown: string }>("GET", `${productionPath(episodeId)}/export?stage=${stage}${version ? `&version=${version}` : ""}`); }

export function createBackendProject(project: Record<string, unknown>) {
    return request<{ ok: boolean; project: Record<string, unknown>; created: boolean }>("POST", "/canvas/projects", project);
}

export function applyBackendCanvasOperations(projectId: string, operations: Array<Record<string, unknown>>, baseRevision?: number, operationId = nanoid(), source = getCanvasCollaborationClient()) {
    return request<{ ok: boolean; project: Record<string, unknown>; revision: number; operationId: string; operationResults?: unknown[] }>(
        "POST", `/canvas/projects/${encodeURIComponent(projectId)}/ops`, { baseRevision, operations, operationId, source },
    );
}

export function fetchBackendCanvasOperationReceipt(projectId: string, operationId: string) {
    return request<{ ok: boolean; committed: boolean; revision?: number; snapshotAvailable?: boolean }>(
        "GET", `/canvas/projects/${encodeURIComponent(projectId)}/ops/${encodeURIComponent(operationId)}/receipt`,
    );
}

export function deleteBackendProject(id: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/canvas/projects/${encodeURIComponent(id)}`);
}

export function fetchProjectReferenceAssets(projectId: string) {
    return request<{ ok: boolean; assets: import("@/types/canvas-plugin").CanvasReferenceAsset[] }>("GET", `/canvas/projects/${encodeURIComponent(projectId)}/reference-assets`);
}

export function upsertProjectReferenceAsset(projectId: string, asset: Record<string, unknown>) {
    return request<{ ok: boolean; asset: import("@/types/canvas-plugin").CanvasReferenceAsset }>("POST", `/canvas/projects/${encodeURIComponent(projectId)}/reference-assets`, asset);
}

export function upsertProjectReferenceAssets(projectId: string, assets: Array<Record<string, unknown>>) {
    return request<{ ok: boolean; assets: import("@/types/canvas-plugin").CanvasReferenceAsset[] }>("POST", `/canvas/projects/${encodeURIComponent(projectId)}/reference-assets/batch`, { assets });
}

export function deleteProjectReferenceAsset(projectId: string, assetId: string) {
    return request<{ ok: boolean; deleted: number }>("DELETE", `/canvas/projects/${encodeURIComponent(projectId)}/reference-assets/${encodeURIComponent(assetId)}`);
}

export function validateProjectReferences(projectId: string, nodeId: string, segmentId: string) {
    return request<{ ok: boolean; validation: import("@/types/canvas-plugin").CanvasReferenceValidation }>("POST", `/canvas/projects/${encodeURIComponent(projectId)}/reference-validation`, { nodeId, segmentId });
}

export type DetectImageSplitLineInsetResult = {
    ok: boolean;
    lineInset: number;
    confidence: number;
    samples: { horizontal: number[]; vertical: number[] };
    width: number;
    height: number;
};

/**
 * 后端纯 CV 识别"格间分隔线宽度"。
 * 输入：dataUrl + 当前切分参数。
 * 返回：lineInset（整数 px，未识别为 0）、confidence（0-1）、samples（每条切分线单独测得的宽度）。
 * 仅供切分对话框初始化默认值用，与实际 `inset` 是否使用解耦。
 */
export function detectImageSplitLineInset(input: { dataUrl: string; rows: number; columns: number; horizontalLines?: number[]; verticalLines?: number[] }, signal?: AbortSignal) {
    return request<DetectImageSplitLineInsetResult>("POST", "/canvas/image-split/detect-line-inset", input, { signal });
}

// ── Assets ───────────────────────────────────────────────────────────────

export function fetchBackendAssets(options: { kind?: string; folderId?: string; dramaId?: string } = {}) {
    const params = new URLSearchParams();
    if (options.kind) params.set("kind", options.kind);
    if (options.folderId) params.set("folderId", options.folderId);
    if (options.dramaId) params.set("dramaId", options.dramaId);
    const qs = params.toString();
    return sharedGet<{ ok: boolean; assets?: unknown[]; folders?: unknown[] }>(`/canvas/assets${qs ? `?${qs}` : ""}`);
}

export function saveBackendAssets(assets: unknown[], folders: unknown[]) {
    return request<{ ok: boolean }>("PUT", "/canvas/assets", { assets, folders });
}

export function upsertBackendAsset(asset: Record<string, unknown>) {
    return request<{ ok: boolean; asset?: Record<string, unknown> }>("POST", "/canvas/assets", asset);
}

export type SharedAssetWrite = { operationId: string; canvasSource?: { projectId: string; nodeId: string }; discardLocal?: boolean; resolveConflicts?: "local" };
export function updateBackendAsset(id: string, patch: Record<string, unknown>, command?: SharedAssetWrite) {
    return request<{ ok: boolean; asset: Record<string, unknown>; replayed?: boolean }>("PATCH", `/canvas/assets/${encodeURIComponent(id)}`, { ...patch, ...command });
}

export function deleteBackendAsset(id: string, source?: { sourceProjectId: string; sourceNodeId: string }) {
    const query = source ? `?${new URLSearchParams({ sourceProjectId: source.sourceProjectId, sourceNodeId: source.sourceNodeId })}` : "";
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/canvas/assets/${encodeURIComponent(id)}${query}`);
}

export function upsertBackendAssetFolder(folder: Record<string, unknown>) {
    return request<{ ok: boolean; folder?: Record<string, unknown> }>("POST", "/canvas/assets/folders", folder);
}

export function deleteBackendAssetFolder(id: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/canvas/assets/folders/${encodeURIComponent(id)}`);
}

export type InstalledPluginRecord = {
    id: string; name: string; version: string; description?: string; url: string; source: string;
    enabled: boolean; local?: boolean; official?: boolean; installedAt: string; mcp?: { enabled: boolean; toolCount: number };
};

export function fetchBackendInstalledPlugins() {
    return request<{ ok: boolean; plugins?: InstalledPluginRecord[] }>("GET", "/plugins/installed");
}

export function saveBackendInstalledPlugins(plugins: InstalledPluginRecord[]) {
    return request<{ ok: boolean; plugins?: InstalledPluginRecord[] }>("PUT", "/plugins/installed", { plugins });
}

export function saveBackendPluginMcpDeclarations(declarations: Array<Record<string, unknown>>) {
    return request<{ ok: boolean; declarations?: Array<Record<string, unknown>> }>("PUT", "/plugins/mcp", { declarations });
}

export function getBackendPluginStorage<T = unknown>(pluginId: string, key: string) {
    return request<{ ok: boolean; value: T | null }>("GET", `/plugins/storage?pluginId=${encodeURIComponent(pluginId)}&key=${encodeURIComponent(key)}`);
}

export function setBackendPluginStorage(pluginId: string, key: string, value: unknown) {
    return request<{ ok: boolean }>("PUT", "/plugins/storage", { pluginId, key, value });
}

export function deleteBackendPluginStorage(pluginId: string, key: string) {
    return request<{ ok: boolean }>("DELETE", `/plugins/storage?pluginId=${encodeURIComponent(pluginId)}&key=${encodeURIComponent(key)}`);
}

export function fetchBackendPromptCache<T = unknown>(sourceId: string) {
    return request<{ ok: boolean; cache: T | null }>("GET", `/prompts/cache?sourceId=${encodeURIComponent(sourceId)}`);
}

export function saveBackendPromptCache(sourceId: string, cache: unknown) {
    return request<{ ok: boolean }>("PUT", "/prompts/cache", { sourceId, cache });
}

// ── Media ────────────────────────────────────────────────────────────────

type BackendMediaUploadOptions = {
    name: string;
    blob: Blob;
    storageKey?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    category?: "input" | "output" | "library";
};

export function uploadBackendMedia(options: BackendMediaUploadOptions): Promise<BackendMediaResult> {
    return postBackendMedia("/media/upload-binary", options);
}

export function uploadBackendCharacterVoice(options: BackendMediaUploadOptions): Promise<BackendMediaResult> {
    return postBackendMedia("/media/character-voice", options);
}

async function postBackendMedia(endpoint: string, options: BackendMediaUploadOptions): Promise<BackendMediaResult> {
    const { useBackendStore } = await import("@/stores/use-backend-store");
    const token = useBackendStore.getState().token || "";
    const headers: Record<string, string> = {
        "content-type": options.mimeType || options.blob.type || "application/octet-stream",
        "x-media-name": encodeURIComponent(options.name),
    };
    if (options.width !== undefined) headers["x-media-width"] = String(options.width);
    if (options.height !== undefined) headers["x-media-height"] = String(options.height);
    if (options.durationMs !== undefined) headers["x-media-duration-ms"] = String(options.durationMs);
    if (options.category) headers["x-media-category"] = options.category;
    if (options.storageKey) headers["x-media-storage-key"] = options.storageKey;
    const url = `${getBackendUrl().replace(/\/$/, "")}${endpoint}?token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { method: "POST", headers, body: options.blob });
    const data = (await res.json().catch(() => ({}))) as { media?: BackendMediaResult; error?: string };
    if (!res.ok || !data.media) {
        if (endpoint === "/media/character-voice" && res.status === 404) throw new Error("CHARACTER_VOICE_COMPRESSION_UNAVAILABLE");
        throw new Error(`Backend POST ${endpoint} failed: HTTP ${res.status} ${data.error || ""}`);
    }
    return data.media;
}

export async function uploadBackendMediaDataUrl(options: {
    name: string;
    dataUrl: string;
    storageKey?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    category?: "input" | "output" | "library";
}): Promise<BackendMediaResult> {
    const data = await request<{ ok: boolean; media: BackendMediaResult }>("POST", "/media/upload", options);
    return data.media;
}

// ── Voice ASR (Backend-owned local Whisper) ────────────────────────────

export const AUDIO_TRANSCRIBE_PATH = "/agent/audio-transcribe";

export type AudioTranscribeStatus = {
    ok: boolean;
    available: boolean;
    engine?: string;
    /** Actionable reason returned when the local ASR runtime is not available. */
    reason?: string;
    model?: string;
    maxBytes?: number;
    maxSeconds?: number;
};

export type AudioTranscribeOutcome = {
    ok: true;
    text: string;
    language: string;
    model: string;
    durationSeconds: number;
    noSpeechProbability: number;
};

/**
 * Capability probe decides whether the voice button records audio or falls back to Web Speech.
 * Uses a plain fetch so a transient reload/503 silently degrades instead of raising the global
 * "backend unavailable" banner for a purely optional feature.
 */
export function fetchAudioTranscribeStatus(signal?: AbortSignal): Promise<AudioTranscribeStatus> {
    const url = `${getBackendUrl().replace(/\/$/, "")}${AUDIO_TRANSCRIBE_PATH}/status?token=${encodeURIComponent(getBackendTokenShared())}`;
    return fetch(url, { signal }).then(async res => {
        const data = (await res.json().catch(() => ({}))) as AudioTranscribeStatus;
        if (!res.ok) throw new Error(data.reason || `HTTP ${res.status}`);
        return data;
    });
}

/** Raw binary upload; the clip is never persisted as a media asset or project node. */
export async function transcribeAudioClip(blob: Blob, options: { language?: string; signal?: AbortSignal } = {}): Promise<AudioTranscribeOutcome> {
    const url = `${getBackendUrl().replace(/\/$/, "")}${AUDIO_TRANSCRIBE_PATH}?token=${encodeURIComponent(getBackendTokenShared())}`;
    const headers: Record<string, string> = { "content-type": blob.type || "application/octet-stream" };
    if (options.language) headers["x-audio-language"] = options.language;
    const res = await fetch(url, { method: "POST", headers, body: blob, signal: options.signal });
    const data = (await res.json().catch(() => ({}))) as AudioTranscribeOutcome & { ok?: boolean; error?: string; code?: string };
    if (!res.ok || !data.ok) {
        throw new BackendApiError(`Backend POST ${AUDIO_TRANSCRIBE_PATH} failed: HTTP ${res.status} ${data.error || ""}`, res.status, {
            method: "POST", path: AUDIO_TRANSCRIBE_PATH, code: data.code || "", detail: data.error || "",
        });
    }
    return data;
}

export function backendMediaUrl(storageKey: string): string {
    const token = encodeURIComponent(getBackendTokenShared());
    const key = encodeURIComponent(storageKey);
    const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
    const base = getBackendUrl().replace(/\/$/, "");
    // 开发模式且指向本地总后台时，走 Vite 代理（同源相对路径），避免跨域 CORS。
    const isLocal = base === DEFAULT_URL || base === "http://localhost:17370" || base === "";
    if (isDev && isLocal) return `/media/${key}?token=${token}`;
    return `${base}/media/${key}?token=${token}`;
}

/** acheng-director skill 的 132 段运镜白模镜头库（只读，视频由 Backend 直接流式提供）。 */
export type CameraLibraryMove = {
    id: string; key: string; nameZh: string; nameEn: string; category: string;
    file: string; url: string; duration: number; fps: number; width: number;
    height: number; size: number; available: boolean;
};
export type CameraLibraryCategory = { key: string; from: string; to: string; count: number };
export type CameraLibraryIndex = {
    ok: boolean; available: boolean; source: string; mediaBase: string; count: number;
    categories: CameraLibraryCategory[]; moves: CameraLibraryMove[]; reason?: string;
};

export function fetchCameraLibrary(signal?: AbortSignal) {
    return request<CameraLibraryIndex>("GET", "/camera-library/moves", undefined, { signal });
}

/** 镜头库视频端点免 token；开发态走 Vite 同源代理，生产态跟随已配置的 Backend 前缀。 */
export function cameraLibraryMediaUrl(file: string): string {
    const key = encodeURIComponent(file);
    const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
    const base = getBackendUrl().replace(/\/$/, "");
    const isLocal = base === DEFAULT_URL || base === "http://localhost:17370" || base === "";
    if (isDev && isLocal) return `/camera-library/media/${key}`;
    return `${base}/camera-library/media/${key}`;
}

/**
 * 把历史 ComfyUI /view 地址改成总后台代理地址。
 * 画布数据可能来自旧版本，节点里只保存了 127.0.0.1:8188 的临时地址；
 * 直接交给浏览器加载会受运行环境影响，统一通过现有 /comfy/media 读取。
 */
export function resolveComfyMediaUrl(rawUrl: string): string {
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return rawUrl;
    try {
        const parsed = new URL(rawUrl, typeof window === "undefined" ? DEFAULT_URL : window.location.origin);
        if (parsed.pathname.endsWith("/comfy/media") || parsed.pathname.endsWith("/media")) return rawUrl;
        const isLocalComfy = parsed.pathname === "/view" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.port === "8188");
        if (!isLocalComfy || !parsed.searchParams.get("filename")) return rawUrl;
        const query = new URLSearchParams();
        for (const key of ["filename", "subfolder", "type"]) {
            const value = parsed.searchParams.get(key);
            if (value !== null) query.set(key, value);
        }
        query.set("token", getBackendTokenShared());
        const base = getBackendUrl().replace(/\/$/, "");
        const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
        const isLocalBackend = base === DEFAULT_URL || base === "http://localhost:17370" || base === "";
        const path = `/agent/comfy/media?${query.toString()}`;
        return isDev && isLocalBackend ? path : `${base}${path}`;
    } catch {
        return rawUrl;
    }
}

export function deleteBackendMedia(storageKey: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/media/${encodeURIComponent(storageKey)}`);
}

// ── Generation logs ──────────────────────────────────────────────────────

export type BackendGenerationLog = {
    id: string; projectId: string; nodeId?: string; segmentId?: string;
    status: "queued" | "running" | "success" | "failed" | "cancelled";
    platform: string; source?: "pipeline" | "upload" | "canvas" | "restore"; workflow?: string; model?: string; taskMode?: string; prompt?: string;
    references: Array<Record<string, unknown>>; inputCounts: Record<string, number>;
    runtimeTaskId?: string; promptId?: string;
    startedAt: string; finishedAt?: string; durationMs: number;
    outputs: Array<Record<string, unknown>>; error?: string;
    params: Record<string, unknown>; createdAt: string; updatedAt: string;
};

export function fetchBackendGenerationLogs(options: { projectId?: string; nodeId?: string; segmentId?: string; runtimeTaskId?: string; platform?: string; model?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number; summary?: boolean; mediaDuration?: boolean } = {}) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.nodeId) params.set("nodeId", options.nodeId);
    if (options.segmentId) params.set("segmentId", options.segmentId);
    if (options.runtimeTaskId) params.set("runtimeTaskId", options.runtimeTaskId);
    if (options.platform) params.set("platform", options.platform);
    if (options.model) params.set("model", options.model);
    if (options.status) params.set("status", options.status);
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    if (options.limit) params.set("limit", String(options.limit));
    if (typeof options.offset === "number" && options.offset > 0) params.set("offset", String(options.offset));
    // summary：纯展示列表裁掉 params/references/inputCounts 大列（类型上它们仍是必填，后端以空值填充）。
    if (options.summary) params.set("summary", "true");
    // mediaDuration：让后端从 media_files.duration_ms 给视频产物补真实时长（生成日志顶层 durationMs 是生成耗时，不是视频时长）。
    if (options.mediaDuration) params.set("mediaDuration", "true");
    const qs = params.toString();
    return request<{ ok: boolean; logs?: BackendGenerationLog[] }>("GET", `/generation-logs${qs ? `?${qs}` : ""}`);
}

export function createBackendGenerationLog(input: Record<string, unknown>) {
    return request<{ ok: boolean; log?: BackendGenerationLog }>("POST", "/generation-logs", input);
}

export function updateBackendGenerationLog(id: string, patch: Record<string, unknown>) {
    return request<{ ok: boolean; log?: BackendGenerationLog }>("PATCH", `/generation-logs/${encodeURIComponent(id)}`, patch);
}

export function deleteBackendGenerationLogs(options: { id?: string; projectId?: string; nodeId?: string }) {
    const params = new URLSearchParams(Object.entries(options).filter(([, v]) => v) as [string, string][]);
    const qs = params.toString();
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/generation-logs${qs ? `?${qs}` : ""}`);
}

// ── Data dir ───────────────────────────────────────────────────────────

export async function fetchDataDir(): Promise<{ dataDir: string; configuredDataDir: string | null }> {
    const data = await request<{ ok: boolean; dataDir: string; configuredDataDir: string | null }>("GET", "/data-dir");
    return { dataDir: data.dataDir, configuredDataDir: data.configuredDataDir };
}

export async function saveDataDir(dataDir: string): Promise<{ dataDir: string; configuredDataDir: string | null }> {
    const data = await request<{ ok: boolean; dataDir: string; configuredDataDir: string | null }>("POST", "/data-dir", { dataDir });
    return { dataDir: data.dataDir, configuredDataDir: data.configuredDataDir };
}

// ── Tasks ────────────────────────────────────────────────────────────────

export function fetchBackendTask(id: string, signal?: AbortSignal) {
    return request<{ ok: boolean; task?: BackendRuntimeTask; preview?: BackendTaskLivePreview | null; events?: unknown[] }>("GET", canvasTaskPath(id), undefined, { signal });
}

export function resolveBackendH3Confirmation(id: string, input: { action: "confirm" | "keep_first_pass" | "discard"; segmentId: string; expectedRevision: number; postpassParams?: Record<string, unknown> }) {
    return request<{ ok: boolean; task: BackendRuntimeTask }>("POST", h3ConfirmationPath(id), input);
}

export function fetchBackendTasks(options: { projectId?: string; nodeIds?: string[]; segmentIds?: string[]; scope?: "all" | "canvas" | "image" | "video"; status?: string; kind?: string; model?: string; taskId?: string; limit?: number; offset?: number; summary?: boolean } = {}) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.nodeIds?.length) params.set("nodeIds", options.nodeIds.join(","));
    if (options.segmentIds?.length) params.set("segmentIds", options.segmentIds.join(","));
    if (options.scope) params.set("scope", options.scope);
    if (options.status) params.set("status", options.status);
    if (options.kind) params.set("kind", options.kind);
    if (options.model) params.set("model", options.model);
    if (options.taskId) params.set("taskId", options.taskId);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    // summary：纯展示列表只回标量 + 输出媒体引用，裁掉多 MB 的提示词大列。
    if (options.summary) params.set("summary", "true");
    const qs = params.toString();
    const path = `${CANVAS_TASKS_PATH}${qs ? `?${qs}` : ""}`;
    return sharedGet<{ ok: boolean; tasks?: BackendRuntimeTask[] }>(path);
}

export function fetchCanvasModelUsage() {
    return sharedGet<{ ok: boolean; modelUsage?: Array<{ model: string; channelId: string; count: number }> }>(`${CANVAS_TASKS_PATH}?modelUsage=true`).then((result) => result.modelUsage || []);
}

export function createBackendTask(kind: string, input: Record<string, unknown> = {}, params: Record<string, unknown> = {}, clientTaskId?: string) {
    return request<{ ok: boolean; task?: Record<string, unknown> }>("POST", CANVAS_TASKS_PATH, { kind, input, params, ...(clientTaskId ? { clientTaskId } : {}) });
}

export function updateBackendTask(id: string, patch: { status?: "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress?: number; error?: string | null }) {
    return request<{ ok: boolean; task?: BackendRuntimeTask }>("PATCH", canvasTaskPath(id), patch);
}

export function cancelBackendTask(id: string) {
    return request<{ ok: boolean; task?: Record<string, unknown> }>("POST", canvasTaskActionPath(id, "cancel"));
}

export function retryBackendTask(id: string) {
    return request<{ ok: boolean; task?: BackendRuntimeTask; parentTaskId?: string }>("POST", canvasTaskActionPath(id, "retry"));
}

export function claimBackendBrowserTask(id: string, workerId: string) {
    return request<{ ok: boolean; task: BackendRuntimeTask; claimToken: string }>("POST", `/canvas/browser-tasks/${encodeURIComponent(id)}/claim`, { workerId });
}

export function checkpointBackendBrowserTask(id: string, workerId: string, claimToken: string, recovery: import("./api/browser-task-recovery").BrowserRecovery) {
    return request<{ ok: boolean; task: BackendRuntimeTask }>("POST", `/canvas/browser-tasks/${encodeURIComponent(id)}/checkpoint`, { workerId, claimToken, recovery });
}

export function completeBackendBrowserTask(id: string, workerId: string, result: Record<string, unknown>, claimToken?: string) {
    return request<{ ok: boolean; task: BackendRuntimeTask }>("POST", `/canvas/browser-tasks/${encodeURIComponent(id)}/complete`, { workerId, result, claimToken });
}

export function failBackendBrowserTask(id: string, workerId: string, error: string, claimToken?: string, terminalConfirmed = false, notSubmitted = false) {
    return request<{ ok: boolean; task: BackendRuntimeTask }>("POST", `/canvas/browser-tasks/${encodeURIComponent(id)}/fail`, { workerId, error, claimToken, terminalConfirmed, notSubmitted });
}

export function releaseBackendBrowserTask(id: string, workerId: string, claimToken?: string, error?: string) {
    return request<{ ok: boolean; task: BackendRuntimeTask }>("POST", `/canvas/browser-tasks/${encodeURIComponent(id)}/release`, { workerId, claimToken, error });
}

export function diagnoseBackendCanvasProject(projectId: string) {
    return request<{ ok: boolean; projectId: string; revision: number; issues: Array<Record<string, unknown>> }>("GET", `/canvas/projects/${encodeURIComponent(projectId)}/diagnostics`);
}

export function directorSubagentRequest(input: Omit<DirectorSubagentInput, "view"> & { view?: DirectorSubagentInput["view"] }) {
    return request<{ ok: boolean; task?: DirectorSubagentSummary; tasks?: DirectorSubagentSummary[]; result?: DirectorSubagentResult; chunk?: { text: string; resultHash: string; nextCursor: string | null }; nextOffset?: number | null }>("POST", "/director/subagents", input);
}

/** Defaults are acknowledged Backend values, never the submitted fallback. */
export async function fetchBackendH3Defaults() {
    const result = await request<{ defaults?: Record<string, unknown> | null }>("GET", "/plugins/minimax-h3/defaults");
    if (!Object.hasOwn(result, "defaults") || result.defaults !== null && (typeof result.defaults !== "object" || Array.isArray(result.defaults))) throw new Error("Backend 未返回有效的 H3 默认参数");
    return result.defaults || {};
}

export async function saveBackendH3Defaults(settings: Record<string, unknown>) {
    const result = await request<{ defaults?: Record<string, unknown> }>("PUT", "/plugins/minimax-h3/defaults", settings);
    if (!result.defaults || typeof result.defaults !== "object" || Array.isArray(result.defaults)) throw new Error("Backend 未确认 H3 默认参数保存值");
    return result.defaults;
}

export async function resetBackendH3Defaults() {
    const result = await request<{ defaults?: null }>("DELETE", "/plugins/minimax-h3/defaults");
    if (result.defaults !== null) throw new Error("Backend 未确认 H3 默认参数重置");
}

// ── 全自动流水线（对齐影策服务端自动编排） ──────────────────────────────

export type DramaPipelineStatus = {
    ok: boolean;
    pipeline?: {
        drama_id: string; status: string; review_mode: string; media_mode: string;
        pause_reason: string | null; last_tick_at: string | null; revision: number;
    };
    jobs?: Array<Record<string, unknown>>;
    byStage?: Record<string, number>;
    /** 闸门放行记录（backend 持久化表，重启后恢复）：已 approve 的 episodeId / 已 release 的 target。 */
    approvals?: string[];
    releasedMedia?: string[];
    /** 制作设置「样片模式」：第 1 集视频阶段也需人工 approve。 */
    sampleMode?: boolean;
    logs?: Array<Record<string, unknown>>;
};

export type DramaPipelineStartOptions = {
    storyboardModel?: string; assetExtractModel?: string; videoPromptModel?: string; planModel?: string;
    imageResolution?: "1k" | "2k" | "4k"; sampleMode?: boolean;
    textThinking?: { plan?: string; storyboard?: string; extract?: string; prompt?: string };
    videoModel?: string; referenceLimit?: number; independent?: boolean;
    /** 参考图模型按资产类型写入各集 production.settings.imageModelsByKind。 */
    imageModelsByKind?: { character?: string; scene?: string; prop?: string };
    storyboardRules?: {
        episodeSeconds?: number; segmentRange?: { min: number; max: number };
        dialogueDensity?: string; transitionMode?: string; transitionMs?: number; pacing?: string;
    };
    concurrency?: { text?: number; video?: number; render?: number };
};
export function startDramaPipeline(dramaId: string, opts?: { reviewMode?: string; mediaMode?: string; options?: DramaPipelineStartOptions }) {
    return request<{ ok: boolean; [k: string]: unknown }>("POST", `/drama/${encodeURIComponent(dramaId)}/pipeline/start`, {
        reviewMode: opts?.reviewMode ?? "auto", mediaMode: opts?.mediaMode ?? "auto",
        ...(opts?.options ? { options: opts.options } : {}),
    });
}
export function pauseDramaPipeline(dramaId: string) {
    return request<{ ok: boolean }>("POST", `/drama/${encodeURIComponent(dramaId)}/pipeline/pause`, {});
}
export function resumeDramaPipeline(dramaId: string) {
    return request<{ ok: boolean }>("POST", `/drama/${encodeURIComponent(dramaId)}/pipeline/resume`, {});
}
export function fetchDramaPipelineStatus(dramaId: string) {
    return request<DramaPipelineStatus>("GET", `/drama/${encodeURIComponent(dramaId)}/pipeline/status`);
}
export function approveDramaPipelineEpisode(dramaId: string, episodeId: string) {
    return request<{ ok: boolean }>("POST", `/drama/${encodeURIComponent(dramaId)}/pipeline/approve`, { episodeId });
}
export function releaseDramaPipelineMedia(dramaId: string, target: "assets" | "episodes" | "all" = "all") {
    return request<{ ok: boolean }>("POST", `/drama/${encodeURIComponent(dramaId)}/pipeline/release`, { target });
}
export function retryFailedDramaPipeline(dramaId: string) {
    return request<{ ok: boolean; requeued?: number }>("POST", `/drama/${encodeURIComponent(dramaId)}/pipeline/retry-failed`, {});
}
