/**
 * draft segment 状态纯派生（只读，不写库、不改 draft_json）。
 *
 * 真值口径（全部来自真实存储字段，不造影策话术）：
 * - 段本身只有 id/shot_ids/mode；提示词与回执真值在 director.artifacts[]。
 * - stale 双真值：artifact.status === 'stale' 或 artifact.sourceHash !== director.sourceHash。
 * - failed：artifact.status === 'failed' 或 receipt.diagnostics.blockers 非空，原因取真实 blocker/error 文本。
 * - references：artifact.references[].storageKey 是真值；缺失时按段真实 mode / director.assets[].status 派生原因。
 * - waitReason / upstreamStage：仅从 drama_pipeline_jobs（前端 pipeline.jobs 同源）或 production runs 的
 *   真实 status / stage / error / wait 派生；本地 job 没有独立的「等待话术」字段，查不到就 undefined。
 *
 * 本模块不 import 任何 DB / service，输入输出都是普通对象；withSegmentState 只返回新副本。
 */

export type PromptStatus = "none" | "queued" | "running" | "ready" | "stale" | "failed";

export type SegmentReferenceState = { label: string; sent: boolean; missingReason?: string };

export type SegmentState = {
    promptStatus: PromptStatus;
    promptError?: string;
    waitReason?: string;
    upstreamStage?: string;
    references: SegmentReferenceState[];
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

function referenceMissingReason(reference: any, segment: any, director: any): string | undefined {
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

function deriveReferences(segment: any, artifact: any, director: any): SegmentReferenceState[] {
    const references = Array.isArray(artifact?.references) ? artifact.references : [];
    return references.map((reference: any) => {
        const label = str(reference?.label);
        const storageKey = str(reference?.storageKey).trim();
        if (storageKey) return { label, sent: true };
        const missingReason = referenceMissingReason(reference, segment, director);
        return missingReason ? { label, sent: false, missingReason } : { label, sent: false };
    });
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
export function deriveSegmentState(segment: any, draft: any, runtime?: SegmentStateRuntime, episodeId?: string): SegmentState {
    const director = draft?.director;
    const segments = Array.isArray(director?.source?.segments) ? director.source.segments : [];
    const artifacts = Array.isArray(director?.artifacts) ? director.artifacts : [];
    const segmentId = str(segment?.id);
    const artifact = artifacts.find((candidate: any) => str(candidate?.targetId) === segmentId && segmentId.length > 0);
    const references = deriveReferences(segment, artifact, director);
    const { upstreamStage, waitReason } = runtimeFacts(runtime, episodeId ?? str(draft?.episodeId));
    const base: SegmentState = { promptStatus: "none", references };
    if (upstreamStage) base.upstreamStage = upstreamStage;
    if (waitReason) base.waitReason = waitReason;
    // custom / videoReprocessable 是与提示词 artifact 无关的独立真值，任何状态下都按段 id 下发。
    const custom = segmentFlag(runtime?.customSegments, segmentId);
    if (custom !== undefined) base.custom = custom;
    const reprocessable = segmentFlag(runtime?.reprocessableSegments, segmentId);
    if (reprocessable !== undefined) base.videoReprocessable = reprocessable;
    if (!artifact || !str(artifact.prompt)) return base;

    const diagnostics = artifact.receipt?.diagnostics;
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
export function deriveSegmentStates(draft: any, runtime?: SegmentStateRuntime, episodeId?: string): Map<string, SegmentState> {
    const segments = draft?.director?.source?.segments;
    const result = new Map<string, SegmentState>();
    if (!Array.isArray(segments)) return result;
    for (const segment of segments) {
        const id = str(segment?.id);
        if (id) result.set(id, deriveSegmentState(segment, draft, runtime, episodeId));
    }
    return result;
}

/**
 * 在返回副本上挂 state：draft/published 的每段都是新对象，原 production / draft_json 不动。
 * unchanged 或分块读取等非制作稿响应原样返回。
 */
export function withSegmentState(production: any, runtime?: SegmentStateRuntime, episodeId?: string): any {
    if (!production || typeof production !== "object" || Array.isArray(production)) return production;
    let out: any = production;
    for (const key of ["draft", "published"] as const) {
        const snapshot = production[key];
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
        const director = snapshot.director;
        const segments = director?.source?.segments;
        if (!Array.isArray(segments)) continue;
        const states = deriveSegmentStates(snapshot, runtime, episodeId ?? str(production.episodeId));
        const nextSegments = segments.map((segment: any) => {
            const state = states.get(str(segment?.id)) ?? { promptStatus: "none" as const, references: [] as SegmentReferenceState[] };
            return { ...segment, state };
        });
        if (out === production) out = { ...production };
        out[key] = { ...snapshot, director: { ...director, source: { ...director.source, segments: nextSegments } } };
    }
    return out;
}
