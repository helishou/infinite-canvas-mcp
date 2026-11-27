/**
 * draft segment 状态纯派生（只读，不写库、不改 draft_json）。
 *
 * 真值口径（全部来自真实存储字段，不造影策话术）：
 * - 段本身只有 id/shot_ids/mode；提示词与回执真值在 director.artifacts[]。
 * - stale 双真值：artifact.status === 'stale' 或 artifact.sourceHash !== director.sourceHash。
 * - failed：artifact.status === 'failed' 或 receipt.diagnostics.blockers 非空，原因取真实 blocker/error 文本。
 * - references：优先取画布段 referenceBindings（新入参 bindings / runtime.bindingsBySegment），
 *   回退 artifact.references；storageKey 存在且未禁用即 sent。实测 artifact.references 大面积为空，不能再当唯一真值。
 *   缺 storageKey 时按段真实 mode / director.assets[].status 派生原因。
 * - videoStatus / videoError / request：来自画布 H3 段的真实字段（新入参 clipState / runtime.clipStates），
 *   status 映射为 ready/failed/running/queued/cancelled，inputOutdated 优先映射 stale；
 *   errorDetails 是真实失败原因；request 只从 tailFrameContinuation / taskMode / 参考图真值派生。
 * - waitReason / upstreamStage：段级 waitReason 取 tasks/generation_logs.params.waitReason（真值，
 *   由 route 挂在 clipStates 上），upstreamStage 与兜底 waitReason 取 drama_pipeline_jobs /
 *   episode_production_runs 的真实 status / stage / error / wait / waitReason（统一走 firstText）；查不到就 undefined。
 *
 * 本模块不 import 任何 DB / service，输入输出都是普通对象；withSegmentState 只返回新副本。
 */

export type PromptStatus = "none" | "queued" | "running" | "ready" | "stale" | "failed";

/** 画布段 status 的规范化态；空 / idle 等不可确证的出片态不下发（undefined）。 */
export type VideoStatus = "ready" | "failed" | "running" | "queued" | "cancelled" | "stale";

/** 提交请求的可观测真值；任何字段没有来源就缺省，不编造。 */
export type SegmentRequestState = {
    /** 本段承接上一段尾帧作首帧，而上一段视频尚未就绪。 */
    firstFramePending?: boolean;
    /** ref2va/r2v→reference_to_video，t2v/t2va→text_to_video，有承接首帧→image_to_video。 */
    operation?: string;
    /** 真有 storageKey（且未禁用）的参考图数量；H3 9 张硬上限内收窄。 */
    referencesSent?: number;
    /** 有参考图因缺媒体或超上限未发出。 */
    referenceLimited?: boolean;
};

/** 画布 H3 段的真实字段（只读拷贝）。 */
export type SegmentStateClip = {
    status?: string;
    /** 画布真实 errorDetails 可能是字符串或结构化对象；只有文本真值才会下发。 */
    errorDetails?: unknown;
    inputOutdated?: boolean;
    resultStorageKey?: string;
    /** 画布语义：本段尾帧交给下一段；deriveSegmentStates 会从上一 clip 派生本段的首帧承接。 */
    tailFrameContinuation?: boolean;
    taskMode?: string;
    /** 画布 referenceBindings（由 route 从画布段原样搬运），references 的真值源。 */
    referenceBindings?: SegmentStateBinding[];
    /** 画布段在 Clip 数组里的真实序位。 */
    segmentIndex?: number;
    /** tasks/generation_logs.params.waitReason：渠道排队真值，拿到槽位后会被清空。 */
    waitReason?: string;
};

/** 画布段 referenceBindings 的最小真值形状。 */
export type SegmentStateBinding = { storageKey?: string; label?: string; ordinal?: number; enabled?: boolean; assetId?: string };

/** 单个段的额外真值入口；不传则不派生对应字段。 */
export type SegmentStateInputs = {
    clipState?: SegmentStateClip;
    /** 画布 referenceBindings，优先于 artifact.references。 */
    bindings?: SegmentStateBinding[];
    /** 段序（0 起）；缺省时从 draft 段数组顺序派生。 */
    segmentIndex?: number;
    /** 上一段视频是否已有可用成片；无真值则 firstFramePending 缺省。 */
    previousVideoReady?: boolean;
    /** 上一段画布 clip 真值；用于 deriveSegmentState 单独调用时派生 readiness。 */
    previousClipState?: SegmentStateClip;
    /** 本段是否承接上一 clip 的尾帧；缺省时取 clipState.tailFrameContinuation。 */
    incomingTailFrameContinuation?: boolean;
};

/** 段 targetId → 该段额外真值；供 deriveSegmentStates / withSegmentState 按段下发。 */
export type SegmentStateInputsBySegment = Record<string, SegmentStateInputs>;

export type SegmentReferenceState = { label: string; sent: boolean; missingReason?: string };

export type SegmentState = {
    promptStatus: PromptStatus;
    promptError?: string;
    waitReason?: string;
    upstreamStage?: string;
    references: SegmentReferenceState[];
    /** 画布段 status 映射；inputOutdated=true 时为 stale。无 status 真值则 undefined。 */
    videoStatus?: VideoStatus;
    /** 画布段 errorDetails 里的真实失败原因。 */
    videoError?: string;
    request?: SegmentRequestState;
    /** 用户手动改写过提示词（画布 Clip.promptCustom=true）；前端据此在 stale 时不再显示「提示词已过期」。无真值则 undefined。 */
    custom?: boolean;
    /** 视频已生成但后处理回写失败，可只重跑后处理（findReprocessableVideo 命中且 !alreadyReady）。无真值则 undefined。 */
    videoReprocessable?: boolean;
};

/** 与 drama_pipeline_jobs / episode_production_runs 对齐的最小只读形状。 */
export type RuntimeJob = {
    id?: string;
    episodeId?: string;
    kind?: string;
    stage?: string;
    status?: string;
    error?: string | null;
    wait?: string;
    waitReason?: string;
    reason?: string;
    label?: string;
    payload?: Record<string, unknown>;
    attempts?: Array<Record<string, unknown>>;
};

export type RuntimeRun = {
    episodeId?: string;
    status?: string;
    stage?: string;
    error?: string | null;
    wait?: string;
    waitReason?: string;
    reason?: string;
};

export type SegmentStateRuntime = {
    jobs?: RuntimeJob[];
    runs?: RuntimeRun[];
    /** 段 id → 用户是否手动改写提示词；Set 表示「命中即为 true」，Record 直接给布尔真值。无真值则缺省。 */
    customSegments?: Set<string> | Record<string, boolean>;
    /** 段 id → 视频是否处于「已生成但后处理失败」可重跑态。无真值则缺省。 */
    reprocessableSegments?: Set<string> | Record<string, boolean>;
    /** 段 targetId → 画布 Clip 真值；让三段/unified 入口不改调用形状即可下发新字段。 */
    clipStates?: Record<string, SegmentStateClip>;
    /** 段 targetId → 画布 referenceBindings（references 的真值源）。 */
    bindingsBySegment?: Record<string, SegmentStateBinding[]>;
};

/** 从 Set/Record 读段级布尔真值；缺席即 undefined（不编造 false）。 */
function segmentFlag(flags: Set<string> | Record<string, boolean> | undefined, id: string): boolean | undefined {
    if (!flags || !id) return undefined;
    if (flags instanceof Set) return flags.has(id) ? true : undefined;
    const value = flags[id];
    return typeof value === "boolean" ? value : undefined;
}

const str = (value: unknown): string => (typeof value === "string" || typeof value === "number") ? String(value) : "";
const firstText = (...values: unknown[]): string | undefined => {
    for (const value of values) {
        const text = str(value).trim();
        if (text) return text;
    }
    return undefined;
};

/** T2VA / text_to_video 段按真实 mode 不收参考图；不用字符串猜别的模式。 */
function isTextOnlyMode(mode: unknown): boolean {
    const normalized = str(mode).toLowerCase().replace(/[\s_-]/g, "");
    return normalized === "t2va" || normalized === "t2v" || normalized === "text2video" || normalized === "texttovideo";
}

/** H3 参考图硬上限，与 segment-reference-bindings.ts 的 MAX_H3_REFERENCE_IMAGES 同口径。 */
const MAX_H3_REFERENCE_IMAGES = 9;

function referenceMissingReason(reference: any, segment: any, director: any): string | undefined {
    if (reference?.enabled === false) return "参考图已禁用";
    const mode = str(segment?.mode);
    if (isTextOnlyMode(mode)) return `按文生视频模式（${mode}）不收参考图`;
    const assetId = str(reference?.assetId);
    if (assetId) {
        const assetStatus = str(director?.assets?.[assetId]?.status);
        if (assetStatus === "planned") return "参考图未生成";
        if (assetStatus === "rejected") return "参考图未通过";
    }
    return undefined;
}

type ReferenceDerivation = {
    references: SegmentReferenceState[];
    sentCount?: number;
    limited?: boolean;
};

/** bindings（画布）优先，artifact.references 兜底；两者皆无才返回空数组。 */
function deriveReferences(bindings: SegmentStateBinding[] | undefined, segment: any, artifact: any, director: any): ReferenceDerivation {
    const truth = Array.isArray(bindings)
        ? bindings
        : Array.isArray(artifact?.references) ? artifact.references as SegmentStateBinding[] : undefined;
    if (!truth) return { references: [] };
    const references = truth.map((reference: any) => {
        const ordinal = Number(reference?.ordinal);
        const label = firstText(reference?.label)
            ?? (Number.isFinite(ordinal) && ordinal > 0 ? `<Picture ${ordinal}>` : "");
        const storageKey = str(reference?.storageKey).trim();
        if (storageKey && reference?.enabled !== false) return { label, sent: true };
        const missingReason = referenceMissingReason(reference, segment, director);
        return missingReason ? { label, sent: false, missingReason } : { label, sent: false };
    });
    const withMedia = truth.filter((reference: any) => str(reference?.storageKey).trim() && reference?.enabled !== false).length;
    return {
        references,
        sentCount: Math.min(withMedia, MAX_H3_REFERENCE_IMAGES),
        limited: truth.length > MAX_H3_REFERENCE_IMAGES || withMedia < truth.length,
    };
}

/** 画布段 status → 规范化视频态；空 / idle / 未列举的态不下发。 */
function deriveVideoStatus(clip: SegmentStateClip | undefined): VideoStatus | undefined {
    if (!clip) return undefined;
    if (clip.inputOutdated === true) return "stale";
    switch (str(clip.status).trim().toLowerCase()) {
        case "success":
        case "succeeded":
        case "ready":
            return "ready";
        case "error":
        case "failed":
            return "failed";
        case "loading":
        case "running":
            return "running";
        case "queued":
            return "queued";
        case "cancelled":
            return "cancelled";
        default:
            return undefined;
    }
}

/** 上一段视频是否已有可用成片；只在画布 clip 有真值时给布尔，否则 undefined。 */
function previousVideoReadyOf(clip: SegmentStateClip | undefined): boolean | undefined {
    if (!clip) return undefined;
    if (clip.inputOutdated === true) return false;
    const status = str(clip.status).trim().toLowerCase();
    if (status === "success" || status === "succeeded" || status === "ready") return true;
    if (!status && str(clip.resultStorageKey).trim()) return true;
    if (["error", "failed", "cancelled", "loading", "running", "queued", "idle"].includes(status)) return false;
    return undefined;
}

/** 提交操作类型只从 taskMode 真值与「是否有承接首帧」派生。 */
function deriveOperation(clip: SegmentStateClip | undefined, hasFirstFrame: boolean): string | undefined {
    if (hasFirstFrame) return "image_to_video";
    const mode = str(clip?.taskMode).toLowerCase().replace(/[\s_-]/g, "");
    if (mode === "ref2va" || mode === "r2v" || mode === "ref2video" || mode === "referencetovideo") return "reference_to_video";
    if (mode === "t2v" || mode === "t2va" || mode === "t2video" || mode === "texttovideo") return "text_to_video";
    return undefined;
}

/** 本地流水线 job 是「集级」真值：stage/error 来自 drama_pipeline_jobs，没有更细的段级等待文本。 */
function runtimeFacts(runtime: SegmentStateRuntime | undefined, episodeId?: string): { upstreamStage?: string; waitReason?: string } {
    const jobs = (Array.isArray(runtime?.jobs) ? runtime.jobs : [])
        .filter(job => !episodeId || !str(job?.episodeId) || str(job?.episodeId) === episodeId);
    const rank: Record<string, number> = { running: 4, queued: 3, blocked: 2, failed: 1 };
    jobs.sort((a, b) => (rank[str(b?.status).toLowerCase()] || 0) - (rank[str(a?.status).toLowerCase()] || 0));
    const job = jobs[0];
    if (job) {
        const attempts = Array.isArray(job.attempts) ? job.attempts : [];
        const lastAttempt = attempts[attempts.length - 1];
        const waitReason = firstText(
            job.wait, job.waitReason, job.reason,
            (job.payload as any)?.wait, (job.payload as any)?.waitReason, (job.payload as any)?.reason,
            lastAttempt?.wait, lastAttempt?.waitReason, lastAttempt?.reason,
        ) ?? (str(job.status).toLowerCase() === "blocked" ? firstText(job.error) : undefined);
        return { upstreamStage: firstText(job.stage), waitReason };
    }
    const runs = (Array.isArray(runtime?.runs) ? runtime.runs : [])
        .filter(run => !episodeId || !str(run?.episodeId) || str(run?.episodeId) === episodeId);
    const activeRank: Record<string, number> = { running: 3, queued: 2, pending: 2, awaiting_review: 2, blocked: 1 };
    runs.sort((a, b) => (activeRank[str(b?.status).toLowerCase()] || 0) - (activeRank[str(a?.status).toLowerCase()] || 0));
    const run = runs[0];
    if (!run) return {};
    const waitReason = firstText(run.wait, run.waitReason, run.reason)
        ?? (str(run.status).toLowerCase() === "blocked" ? firstText(run.error) : undefined);
    return { upstreamStage: firstText(run.stage), waitReason };
}

/** 计算单个段的真值状态。draft 是包含 artifacts 的制作稿快照，绝不在此写入。 */
export function deriveSegmentState(
    segment: any,
    draft: any,
    runtime?: SegmentStateRuntime,
    episodeId?: string,
    inputs?: SegmentStateInputs,
): SegmentState {
    const director = draft?.director;
    const segments = Array.isArray(director?.source?.segments) ? director.source.segments : [];
    const artifacts = Array.isArray(director?.artifacts) ? director.artifacts : [];
    const segmentId = str(segment?.id);
    const artifact = artifacts.find((candidate: any) => str(candidate?.targetId) === segmentId && segmentId.length > 0);
    const clip = inputs?.clipState ?? runtime?.clipStates?.[segmentId];
    const bindings = inputs?.bindings ?? clip?.referenceBindings ?? runtime?.bindingsBySegment?.[segmentId];
    const foundIndex = segmentId ? segments.findIndex((candidate: any) => str(candidate?.id) === segmentId) : -1;
    const segmentIndex = typeof inputs?.segmentIndex === "number" && Number.isInteger(inputs.segmentIndex)
        ? inputs.segmentIndex
        : typeof clip?.segmentIndex === "number" && Number.isInteger(clip.segmentIndex)
            ? clip.segmentIndex
            : foundIndex >= 0 ? foundIndex : undefined;
    const referenceTruth = deriveReferences(bindings, segment, artifact, director);
    const runtimeTruth = runtimeFacts(runtime, episodeId ?? str(draft?.episodeId));
    const { upstreamStage } = runtimeTruth;
    // 段级 waitReason（tasks/generation_logs.params.waitReason）是真值；集级 job/run 只作兜底。
    const waitReason = firstText(clip?.waitReason) ?? runtimeTruth.waitReason;
    const base: SegmentState = { promptStatus: "none", references: referenceTruth.references };
    if (upstreamStage) base.upstreamStage = upstreamStage;
    if (waitReason) base.waitReason = waitReason;

    // 视频态 / 请求真值与提示词 artifact 无关，任何状态下都按段真实 clip 字段下发。
    const videoStatus = deriveVideoStatus(clip);
    if (videoStatus) base.videoStatus = videoStatus;
    const videoError = firstText(clip?.errorDetails);
    if (videoError) base.videoError = videoError;

    const tail = inputs?.incomingTailFrameContinuation ?? clip?.tailFrameContinuation;
    const hasFirstFrame = tail === true && segmentIndex !== undefined && segmentIndex > 0;
    const previousReady = inputs?.previousVideoReady ?? previousVideoReadyOf(inputs?.previousClipState);
    const request: SegmentRequestState = {};
    if (tail === false) request.firstFramePending = false;
    else if (hasFirstFrame && typeof previousReady === "boolean") request.firstFramePending = !previousReady;
    const operation = deriveOperation(clip, hasFirstFrame);
    if (operation) request.operation = operation;
    if (referenceTruth.sentCount !== undefined) request.referencesSent = referenceTruth.sentCount;
    if (referenceTruth.limited !== undefined) request.referenceLimited = referenceTruth.limited;
    if (Object.keys(request).length) base.request = request;

    // custom / videoReprocessable 是与提示词 artifact 无关的独立真值，任何状态下都按段 id 下发。
    const custom = segmentFlag(runtime?.customSegments, segmentId);
    if (custom !== undefined) base.custom = custom;
    const reprocessable = segmentFlag(runtime?.reprocessableSegments, segmentId);
    if (reprocessable !== undefined) base.videoReprocessable = reprocessable;

    const diagnostics = artifact?.receipt?.diagnostics;
    // 显式错误字段是真值：即便不在 failed 分支，也不要把已记录的错误吞掉。
    const explicitError = firstText(artifact?.promptError, diagnostics?.error);
    if (explicitError) base.promptError = explicitError;
    if (!artifact || !str(artifact.prompt)) return base;

    const blockers = Array.isArray(diagnostics?.blockers)
        ? diagnostics.blockers.map((blocker: unknown) => str(blocker).trim()).filter(Boolean)
        : [];
    const artifactStatus = str(artifact.status).toLowerCase();
    const sourceHash = str(director?.sourceHash);
    const artifactSourceHash = str(artifact.sourceHash);
    const staleByHash = Boolean(sourceHash && artifactSourceHash && sourceHash !== artifactSourceHash);

    if (artifactStatus === "failed" || blockers.length > 0) {
        base.promptStatus = "failed";
        const reason = firstText(blockers.join("；"), diagnostics?.error, artifact.error, artifact.receipt?.error, (artifact as any).promptError);
        if (reason) base.promptError = reason;
        return base;
    }
    if (artifactStatus === "queued" || artifactStatus === "running") {
        base.promptStatus = artifactStatus;
        return base;
    }
    if (artifactStatus === "stale" || staleByHash) {
        base.promptStatus = "stale";
        return base;
    }
    if (diagnostics?.accepted === true || artifactStatus === "ready") {
        base.promptStatus = "ready";
        return base;
    }
    // 有 prompt 草稿但尚未被 receipt 接受：不能冒充 ready，按「待撰写」处理。
    return base;
}

/** 按段 id 返回状态表；段顺序与 director.source.segments 一致。 */
export function deriveSegmentStates(
    draft: any,
    runtime?: SegmentStateRuntime,
    episodeId?: string,
    inputsBySegment?: SegmentStateInputsBySegment,
): Map<string, SegmentState> {
    const segments = draft?.director?.source?.segments;
    const result = new Map<string, SegmentState>();
    if (!Array.isArray(segments)) return result;
    for (const [index, segment] of segments.entries()) {
        const id = str(segment?.id);
        if (!id) continue;
        const own = inputsBySegment?.[id];
        const previousId = index > 0 ? str(segments[index - 1]?.id) : "";
        const previousClip = (previousId ? inputsBySegment?.[previousId]?.clipState : undefined)
            ?? (previousId ? runtime?.clipStates?.[previousId] : undefined);
        const previousTail = typeof previousClip?.tailFrameContinuation === "boolean" ? previousClip.tailFrameContinuation : undefined;
        const inputs: SegmentStateInputs = {
            ...own,
            segmentIndex: own?.segmentIndex ?? index,
            // 画布语义：上一段 clip 的尾帧标记决定本段是否承接首帧；上一段无真值时才回退本段声明。
            incomingTailFrameContinuation: own?.incomingTailFrameContinuation ?? previousTail ?? own?.clipState?.tailFrameContinuation,
            previousVideoReady: own?.previousVideoReady ?? previousVideoReadyOf(previousClip),
            previousClipState: own?.previousClipState ?? previousClip,
        };
        result.set(id, deriveSegmentState(segment, draft, runtime, episodeId, inputs));
    }
    return result;
}

/**
 * 在返回副本上挂 state：draft/published 的每段都是新对象，原 production / draft_json 不动。
 * unchanged 或分块读取等非制作稿响应原样返回。
 */
export function withSegmentState(
    production: any,
    runtime?: SegmentStateRuntime,
    episodeId?: string,
    inputsBySegment?: SegmentStateInputsBySegment,
): any {
    if (!production || typeof production !== "object" || Array.isArray(production)) return production;
    let out: any = production;
    for (const key of ["draft", "published"] as const) {
        const snapshot = production[key];
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
        const director = snapshot.director;
        const segments = director?.source?.segments;
        if (!Array.isArray(segments)) continue;
        const states = deriveSegmentStates(snapshot, runtime, episodeId ?? str(production.episodeId), inputsBySegment);
        const nextSegments = segments.map((segment: any) => {
            const state = states.get(str(segment?.id)) ?? { promptStatus: "none" as const, references: [] as SegmentReferenceState[] };
            return { ...segment, state };
        });
        if (out === production) out = { ...production };
        out[key] = { ...snapshot, director: { ...director, source: { ...director.source, segments: nextSegments } } };
    }
    return out;
}
